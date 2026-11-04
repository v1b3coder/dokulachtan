package cz.dokulachtan.signer.cardreader

import android.content.Context
import com.acs.smartcardio.BluetoothTerminalManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.smartcardio.Card
import javax.smartcardio.CardChannel
import javax.smartcardio.CardTerminal
import javax.smartcardio.CommandAPDU

/**
 * Expo obal nad ACS BLE EVK (`acssmcio`).
 *
 * Modul dělá jen transport: scan (LE-only), connect, device info, baterie a
 * transmit APDU. Framing i AES-128 řeší ACS knihovna, ne tenhle modul.
 */
class CardReaderModule : Module() {
  private var manager: BluetoothTerminalManager? = null
  private var terminal: CardTerminal? = null
  private var card: Card? = null
  private var channel: CardChannel? = null

  private fun requireManager(): BluetoothTerminalManager {
    return manager ?: BluetoothTerminalManager(appContext.reactContext ?: throw IllegalStateException("no context"))
      .also { manager = it }
  }

  private fun requireChannel(): CardChannel {
    return channel ?: throw IllegalStateException("reader_not_connected")
  }

  override fun definition() = ModuleDefinition {
    Name("DokulachtanCardReader")

    Function("scan") { timeoutMs: Int ->
      val mgr = requireManager()
      val found = mutableListOf<Map<String, String>>()
      val latch = CountDownLatch(1)

      mgr.startScan(BluetoothTerminalManager.TERMINAL_TYPE_ACR3901U_S1) { t ->
        synchronized(found) { found.add(mapOf("name" to t.name)) }
      }
      latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      mgr.stopScan()

      synchronized(found) { found.toList() }
    }

    Function("connect") { name: String ->
      val mgr = requireManager()
      var target: CardTerminal? = null
      val latch = CountDownLatch(1)

      mgr.startScan(BluetoothTerminalManager.TERMINAL_TYPE_ACR3901U_S1) { t ->
        if (t.name == name) {
          synchronized(this) { target = t }
          latch.countDown()
        }
      }
      latch.await(15, TimeUnit.SECONDS)
      mgr.stopScan()

      val t = target ?: throw IllegalStateException("reader_not_found")
      val c = t.connect("direct")
      val ch = c.basicChannel
      terminal = t
      card = c
      channel = ch
      mapOf("name" to t.name)
    }

    Function("deviceInfo") {
      val t = terminal ?: throw IllegalStateException("reader_not_connected")
      val mgr = requireManager()
      mapOf(
        "model" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_MODEL_NUMBER_STRING, 5000),
        "serial" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_SERIAL_NUMBER_STRING, 5000),
        "firmware" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_FIRMWARE_REVISION_STRING, 5000),
        "manufacturer" to mgr.getDeviceInfo(t, BluetoothTerminalManager.DEVICE_INFO_MANUFACTURER_NAME_STRING, 5000),
        "battery" to mgr.getBatteryLevel(t, 5000),
      )
    }

    Function("transmit") { apduHex: String ->
      val ch = requireChannel()
      val apdu = apduHex.filter { !it.isWhitespace() }.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
      val response = ch.transmit(CommandAPDU(apdu))
      response.bytes.joinToString("") { "%02X".format(it) }
    }

    Function("disconnect") {
      val t = terminal
      if (t != null) {
        manager?.disconnect(t)
      }
      channel = null
      card = null
      terminal = null
    }
  }
}
