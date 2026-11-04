package cz.dokulachtan.signer.cardreader

import com.acs.smartcardio.BluetoothTerminalManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import javax.smartcardio.Card
import javax.smartcardio.CardChannel
import javax.smartcardio.CardTerminal
import javax.smartcardio.CommandAPDU

/**
 * Expo obal nad ACS BLE EVK (`acssmcio`).
 *
 * Modul dělá jen transport: scan (LE-only), connect, device info, baterie a
 * transmit APDU. Framing i AES-128 řeší ACS knihovna, ne tenhle modul.
 *
 * Chyby se předávají jako `CodedException` s kódem, který UI zná
 * (`reader_not_found`, `reader_not_connected`, `reader_error`).
 */
class CardReaderModule : Module() {
  private var manager: BluetoothTerminalManager? = null
  private var terminal: CardTerminal? = null
  private var card: Card? = null
  private var channel: CardChannel? = null

  private fun fail(code: String, cause: Throwable? = null): Nothing {
    throw CodedException(code, code, cause)
  }

  private fun requireManager(): BluetoothTerminalManager {
    val context = appContext.reactContext ?: fail("reader_error")
    return manager ?: BluetoothTerminalManager(context).also { manager = it }
  }

  private fun requireChannel(): CardChannel {
    return channel ?: fail("reader_not_connected")
  }

  /** Skenuje jen ACR3901U-S1 (LE-only), vrací nalezené čtečky. */
  private fun scanFor(name: String?, timeoutMs: Int): CardTerminal? {
    val mgr = requireManager()
    var found: CardTerminal? = null

    try {
      mgr.startScan(BluetoothTerminalManager.TERMINAL_TYPE_ACR3901U_S1) { t ->
        if (found == null && (name == null || t.name == name)) {
          found = t
        }
      }
      Thread.sleep(timeoutMs.toLong())
    } finally {
      mgr.stopScan()
    }

    return found
  }

  override fun definition() = ModuleDefinition {
    Name("DokulachtanCardReader")

    AsyncFunction("scan") { timeoutMs: Int ->
      val mgr = requireManager()
      val found = mutableListOf<Map<String, String>>()

      try {
        mgr.startScan(BluetoothTerminalManager.TERMINAL_TYPE_ACR3901U_S1) { t ->
          synchronized(found) { found.add(mapOf("name" to t.name)) }
        }
        Thread.sleep(timeoutMs.toLong())
      } finally {
        mgr.stopScan()
      }

      synchronized(found) { found.toList() }
    }

    AsyncFunction("connect") { name: String ->
      val t = scanFor(name, 15000) ?: fail("reader_not_found")

      try {
        val c = t.connect("direct")
        val ch = c.basicChannel
        terminal = t
        card = c
        channel = ch
        mapOf("name" to t.name)
      } catch (e: Exception) {
        terminal = null
        card = null
        channel = null
        fail("reader_error", e)
      }
    }

    AsyncFunction("deviceInfo") {
      val t = terminal ?: fail("reader_not_connected")
      val mgr = requireManager()

      try {
        mapOf(
          "model" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_MODEL_NUMBER_STRING, 5000),
          "serial" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_SERIAL_NUMBER_STRING, 5000),
          "firmware" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_FIRMWARE_REVISION_STRING, 5000),
          "manufacturer" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_MANUFACTURER_NAME_STRING, 5000),
          "battery" to mgr.getBatteryLevel(t, 5000),
        )
      } catch (e: Exception) {
        fail("reader_error", e)
      }
    }

    AsyncFunction("transmit") { apduHex: String ->
      val ch = requireChannel()

      try {
        val apdu = apduHex.filter { !it.isWhitespace() }.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        ch.transmit(CommandAPDU(apdu)).bytes.joinToString("") { "%02X".format(it) }
      } catch (e: Exception) {
        fail("reader_error", e)
      }
    }

    AsyncFunction("disconnect") {
      val t = terminal

      if (t != null) {
        try {
          manager?.disconnect(t)
        } catch (_: Exception) {
          // Odpojení nesmí nechat modul ve stavu „připojeno“.
        }
      }

      channel = null
      card = null
      terminal = null
    }
  }
}
