// S8 Připojení čtečky (SPEC § 9.1): v této fázi je MOI SDK stub —
// fyzická čtečka je mimo rozsah, fake card mód umí celý tok s testovacím certem.
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { createCardSigner, CardSignerError } from '../src/lib/cardSigner';
import { PrimaryButton } from '../src/ui/buttons';

export default function ReaderScreen() {
  const [status, setStatus] = useState<string | null>(null);
  const [containers, setContainers] = useState<string[]>([]);

  const fakeCard = process.env.EXPO_PUBLIC_QES_FAKE_CARD === '1';

  async function connect() {
    const signer = createCardSigner(fakeCard);

    try {
      await signer.initializeSession();

      const list = await signer.listContainers();

      setContainers(list.map((item) => `${item.label} (${item.level.toUpperCase()})`));
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof CardSignerError ? err.code : 'reader_error');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Připojení čtečky</Text>
      <Text style={styles.muted}>
        Podporované čtečky: ACR 3901 U-S1, bR301 BLE (černá), CT 1100, AirID 2 (+ USB OTG). Komunikace
        probíhá přes MOI Podpisové SDK v aplikaci, klíč zůstává v čipu.
      </Text>
      <Text style={styles.label}>
        Režim: {fakeCard ? 'fake card (testovací cert)' : 'reálná čtečka (v této verzi nepodporovaná)'}
      </Text>

      {status ? (
        <Text style={styles.error}>
          {status === 'reader_not_found'
            ? fakeCard
              ? 'Čtečka nenalezena. Spárujte ji v aplikaci eObčanka.'
              : 'Tato verze aplikace čtečku nepodporuje. Reálné zapojení přijde s hardwarem.'
            : status}
        </Text>
      ) : null}

      {containers.length > 0 ? (
        <View style={styles.card}>
          {containers.map((item) => (
            <Text key={item} style={styles.value}>
              {item}
            </Text>
          ))}
        </View>
      ) : null}

      <PrimaryButton title="Vyhledat čtečku" onPress={connect} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 6 },
  value: { fontSize: 16, fontWeight: '600' },
  error: { color: '#991b1b', fontSize: 14 },
});
