// S8 Připojení čtečky (SPEC § 9.1, § 9.4): ACS BLE EVK (`acssmcio`) přes
// standardní javax.smartcardio. Framing i AES-128 řeší knihovna, appka posílá APDU.
// Kartový info protokol je v `src/lib/eopCard.ts`; karta bez certu podpis neodemkne.
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AcsCardSigner, CardSignerError } from '../src/lib/cardSigner';
import { PrimaryButton, TextButton } from '../src/ui/buttons';

export default function ReaderScreen() {
  const [signer] = useState(() => new AcsCardSigner());
  const [status, setStatus] = useState<string | null>(null);
  const [info, setInfo] = useState<string[]>([]);
  const [documentNumber, setDocumentNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fakeCard = process.env.EXPO_PUBLIC_QES_FAKE_CARD === '1';

  async function connect() {
    setBusy(true);
    setStatus(null);
    setInfo([]);
    setDocumentNumber(null);

    try {
      await signer.initializeSession();

      const device = signer.deviceInfo;

      if (device) {
        setInfo([
          `Čtečka: ${device.model}`,
          `Sériové číslo: ${device.serial}`,
          `Firmware: ${device.firmware}`,
          `Baterie: ${signer.batteryLabel}`,
        ]);
      }

      setDocumentNumber(await signer.readDocumentNumber());
    } catch (err) {
      setStatus(err instanceof CardSignerError ? err.code : 'reader_error');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    try {
      await signer.finalizeSession();
    } catch {
      // Stav se vyčistí i když odpojení selže.
    }

    setInfo([]);
    setDocumentNumber(null);
    setStatus(null);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Připojení čtečky</Text>
      <Text style={styles.muted}>
        Podporované čtečky: ACR 3901 U-S1, bR301 BLE (černá), CT 1100, AirID 2 (+ USB OTG). Komunikace
        probíhá přes ACS BLE knihovnu v aplikaci, klíč zůstává v čipu.
      </Text>
      <Text style={styles.label}>
        Režim: {fakeCard ? 'fake card (testovací cert)' : 'reálná čtečka (ACS BLE EVK)'}
      </Text>

      {status ? <Text style={styles.error}>{MESSAGES[status] ?? status}</Text> : null}

      {info.length > 0 ? (
        <View style={styles.card}>
          {info.map((item) => (
            <Text key={item} style={styles.value}>
              {item}
            </Text>
          ))}
        </View>
      ) : null}

      {documentNumber ? (
        <View style={styles.card}>
          <Text style={styles.label}>Číslo dokladu</Text>
          <Text style={styles.value}>{documentNumber}</Text>
        </View>
      ) : null}

      {info.length > 0 ? (
        <PrimaryButton title="Odpojit čtečku" onPress={disconnect} />
      ) : (
        <PrimaryButton title="Připojit čtečku" onPress={connect} loading={busy} />
      )}
      <TextButton title="Zpět" onPress={() => undefined} />
    </ScrollView>
  );
}

const MESSAGES: Record<string, string> = {
  reader_not_found: 'Čtečka nenalezena. Přepněte ji do Bluetooth režimu a zkuste to znovu.',
  reader_not_connected: 'Čtečka není připojená. Připojte ji znovu.',
  reader_disconnected: 'Čtečka se odpojila. Připojte ji znovu.',
  reader_permission_denied: 'Aplikace nemá oprávnění k Bluetoothu. Povolte je v nastavení.',
  applet_not_found: 'Karta neodpovídá jako eObčanka. Zkontrolujte, že je vložená správná karta.',
  data_tag_failed: 'Kartu se nepodařilo přečíst. Zkuste to znovu.',
  no_qualified_certificate: 'Karta nemá nahraný kvalifikovaný certifikát. Podpis zatím není možný.',
  reader_error: 'Chyba čtečky. Zkuste to znovu.',
};

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 6 },
  value: { fontSize: 16, fontWeight: '600' },
  error: { color: '#991b1b', fontSize: 14 },
});
