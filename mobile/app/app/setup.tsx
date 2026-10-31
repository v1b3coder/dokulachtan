// S10 Konfigurační wizard (SPEC § 9.8, docs/17): dvě skutečné cesty (klíč, čtečka)
// a testovací certifikát až jako alternativní cesta na konci.
import { useState } from 'react';
import { router } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { VaultError } from '../src/lib/crypto/vault';
import { platformVaultDeps } from '../src/lib/platform';
import { importTestCertificate } from '../src/lib/testCertificate';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const TEST_CERT_ERROR: Record<string, string> = {
  certificate_present:
    'Uložený klíč by testovací certifikát přepsal. Nejdřív ho smažte v Detailu certifikátu.',
  biometry_rejected: 'Biometrické ověření bylo zrušeno.',
  biometry_unavailable: 'V telefonu není dostupná biometrie.',
};

export default function SetupScreen() {
  const [testCert, setTestCert] = useState<string | null>(null);

  async function importTest() {
    try {
      const info = await importTestCertificate(platformVaultDeps());

      setTestCert(info.subject);
    } catch (err) {
      setTestCert(
        err instanceof VaultError
          ? (TEST_CERT_ERROR[err.code] ?? err.code)
          : 'Import se nepodařil.',
      );
    }
  }

  function back() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Nastavit podepisování</Text>
      <Text style={styles.muted}>
        Pro AdES stačí importovaný klíč (PKCS#12). Pro QES je potřeba čtečka s eObčankou;
        její zapojení v této verzi ještě není hotové, takže QES v aplikaci zatím podepsat nelze.
        Volba podepisujícího je jinak automatická dle požadované úrovně.
      </Text>

      <PrimaryButton title="Importovat klíč (PKCS#12)" onPress={() => router.push('/import')} />
      {Platform.OS === 'android' ? (
        <SecondaryButton title="Nastavit čtečku" onPress={() => router.push('/reader')} />
      ) : null}

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerLabel}>Nebo</Text>
        <View style={styles.dividerLine} />
      </View>

      <Text style={styles.muted}>
        Testovací certifikát je jen pro staging — nemá důvěryhodný kořen a podpis na produkci
        neprojde. Uloží se jen do prázdné aplikace; existující klíč by přepsal.
      </Text>
      <TextButton title="Použít testovací certifikát" onPress={importTest} />
      {testCert ? <Text style={styles.muted}>Uloženo: {testCert}</Text> : null}

      <TextButton title="Zpět" onPress={back} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerLabel: { fontSize: 13, color: '#6b7280' },
});
