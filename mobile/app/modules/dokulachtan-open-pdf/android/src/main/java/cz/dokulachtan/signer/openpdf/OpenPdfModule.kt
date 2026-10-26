package cz.dokulachtan.signer.openpdf

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

/**
 * Přijme `ACTION_VIEW` s `application/pdf` (otevření PDF z jiné aplikace),
 * zkopíruje obsah do cache a předá ho JS. Na rozdíl od share sheetu
 * (`ACTION_SEND`) tady dostáváme původní soubor, ne re-export z editoru.
 */
class OpenPdfModule : Module() {
  companion object {
    // Strop pro PDF z cizí aplikace; větší soubor se odmítne, ne aby zaplnil cache.
    private const val MAX_PDF_BYTES = 50L * 1024 * 1024

    private var instance: OpenPdfModule? = null
    private var pending: Map<String, String?>? = null
  }

  override fun definition() = ModuleDefinition {
    Name("DokulachtanOpenPdf")

    Events("onOpenPdf")

    OnCreate {
      instance = this@OpenPdfModule
      pending = extract(appContext.currentActivity?.intent)
    }

    OnNewIntent { intent ->
      val value = extract(intent)

      if (value != null) {
        pending = value
        instance?.sendEvent("onOpenPdf", value)
      }
    }

    AsyncFunction("consumeOpenPdf") {
      // OnCreate může proběhnout dřív, než je activity dostupná; proto
      // fallback na aktuální intent i při prvním volání z JS.
      val value = pending ?: extract(appContext.currentActivity?.intent)

      pending = null
      value
    }

    // Share sheet (`expo-share-intent`) někdy předá prázdnou cache kopii;
    // `contentUri` je původní soubor od zdrojové aplikace. Zkopírujeme ho
    // stejnou cestou jako open intent a vrátíme `file://` URI pro JS.
    AsyncFunction("copyPdf") { uri: String, name: String ->
      val file = copyToCache(Uri.parse(uri), name) ?: return@AsyncFunction null

      mapOf(
        "uri" to Uri.fromFile(file).toString(),
        "name" to name,
        "type" to "application/pdf"
      )
    }

    OnDestroy {
      instance = null
    }
  }

  private fun extract(intent: Intent?): Map<String, String?>? {
    if (intent?.action != Intent.ACTION_VIEW) {
      return null
    }

    val uri = intent.data ?: return null
    val resolver = appContext.reactContext?.contentResolver ?: return null
    val mimeType = intent.type ?: resolver.getType(uri)
    val name = queryName(resolver, uri) ?: uri.lastPathSegment ?: "document.pdf"

    if (mimeType != "application/pdf" && !name.endsWith(".pdf", ignoreCase = true)) {
      return null
    }

    val file = copyToCache(uri, name) ?: return null

    return mapOf(
      "uri" to Uri.fromFile(file).toString(),
      "name" to name,
      "type" to "application/pdf"
    )
  }

  private fun queryName(resolver: ContentResolver, uri: Uri): String? {
    return try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun copyToCache(uri: Uri, name: String): File? {
    val context = appContext.reactContext ?: return null
    val directory = File(context.cacheDir, "opened-pdf").apply { mkdirs() }
    val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "document.pdf" }
    val target = File(directory, "${UUID.randomUUID()}-$safeName")

    return try {
      val input = if (uri.scheme == "file") {
        // Cizí aplikace nesmí předat `file://` mimo naši cache (četla by cizí soubory).
        val source = File(uri.path ?: return null).canonicalFile

        require(source.startsWith(context.cacheDir.canonicalFile)) { "invalid_pdf" }

        source.inputStream()
      } else {
        context.contentResolver.openInputStream(uri) ?: return null
      }

      input.use { source ->
        target.outputStream().use { sink ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          var total = 0L
          var read = source.read(buffer)

          while (read >= 0) {
            total += read
            require(total <= MAX_PDF_BYTES) { "pdf_too_large" }
            sink.write(buffer, 0, read)
            read = source.read(buffer)
          }
        }
      }

      target
    } catch (_: Exception) {
      target.delete()

      null
    }
  }
}
