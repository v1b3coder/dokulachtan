package cz.dokulachtan.signer.share

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class SharePdfFileProvider : FileProvider()

/**
 * Systémový share sheet a uložení finálního PDF do telefonu (docs/15 § 7.1).
 *
 * `expo-sharing` startuje chooser z vlákna na pozadí a na Androidu 15+ občas
 * rejectuje NPE v `dispatchCancelPendingInputEvents` (expo/expo#51164); jindy
 * promise po zavření sheetu zůstane viset. Tady chooser startuje na hlavním
 * vlákně a promise se resolve hned po otevření sheetu — appka na výsledek nečeká.
 */
class SharePdfModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DokulachtanShare")

    AsyncFunction("sharePdf") { uri: String, mimeType: String, title: String ->
      val context = appContext.reactContext ?: throw ShareFailedException("no react context")
      val contentUri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.DokulachtanShareFileProvider",
        existingFile(uri)
      )
      val send = Intent(Intent.ACTION_SEND).apply {
        putExtra(Intent.EXTRA_STREAM, contentUri)
        setTypeAndNormalize(mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      appContext.throwingActivity.startActivity(Intent.createChooser(send, title))
    }.runOnQueue(Queues.MAIN)

    // Otevření PDF v systémovém prohlížeči (ACTION_VIEW). Jediná cesta pro
    // náhled před podpisem i otevření po podpisu: chooser nechává na systému,
    // takže nabídka aplikací je v obou případech stejná (docs/16 S12).
    AsyncFunction("openPdf") { uri: String, mimeType: String ->
      val context = appContext.reactContext ?: throw ShareFailedException("no react context")
      val parsed = Uri.parse(uri)
      // `file://` nesmí ven z appky (Android 7+); FileProvider je nad celým cache.
      val target = if (parsed.scheme == "file") {
        FileProvider.getUriForFile(
          context,
          "${context.packageName}.DokulachtanShareFileProvider",
          existingFile(uri)
        )
      } else {
        parsed
      }
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(target, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      try {
        appContext.throwingActivity.startActivity(intent)
      } catch (e: ActivityNotFoundException) {
        throw NoPdfViewerException()
      }
    }.runOnQueue(Queues.MAIN)

    // Android 10+ ukládá do veřejného Downloads přes MediaStore — bez výběru
    // složky (root Downloadu nejde v SAF vybrat, Android 11+ ho zakazuje).
    AsyncFunction("saveToDownloads") { uri: String, fileName: String, mimeType: String ->
      val context = appContext.reactContext ?: throw ShareFailedException("no react context")
      val source = existingFile(uri)

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw ShareFailedException("saveToDownloads requires Android 10")
      }

      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Dokulachtan")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw ShareFailedException("insert failed")

      try {
        resolver.openOutputStream(target)?.use { output ->
          source.inputStream().use { input -> input.copyTo(output) }
        } ?: throw ShareFailedException("open failed")

        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(target, values, null, null)
      } catch (e: Exception) {
        resolver.delete(target, null, null)
        throw ShareFailedException("write failed: ${e.message}")
      }

      mapOf(
        "label" to "${Environment.DIRECTORY_DOWNLOADS}/Dokulachtan/$fileName",
        "uri" to target.toString()
      )
    }.runOnQueue(Queues.MAIN)
  }

  private fun existingFile(uri: String): File {
    val file = File(Uri.parse(uri).path ?: throw ShareFailedException("invalid uri"))

    if (!file.exists()) {
      throw ShareFailedException("file does not exist")
    }

    return file
  }

  private class ShareFailedException(message: String) : CodedException(message)
  private class NoPdfViewerException : CodedException("V telefonu není aplikace pro zobrazení PDF.")
}
