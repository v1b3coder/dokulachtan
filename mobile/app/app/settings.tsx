// S7 Nastavení (SPEC § 9.1, docs/17): server a token, podepisování (certifikát,
// čtečka), o aplikaci a testovací cesty až na konci. Mazání klíče patří do S3.
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { certificateSummary } from '../src/lib/crypto/vault';
import { loadPdfApiSettings, savePdfApiSettings } from '../src/lib/pdfApi';
import { platformVaultDeps } from '../src/lib/platform';
import { DEFAULT_SERVER_URL, signingOrigin, SigningOriginError } from '../src/lib/signingOrigin';
import { importTestCertificate } from '../src/lib/testCertificate';
import { PrimaryButton, TextButton } from '../src/ui/buttons';

export default function SettingsScreen() {
  const router = useRouter();
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [apiToken, setApiToken] = useState('');
  const [loaded, setLoaded] = useState<{ serverUrl: string; apiToken: string } | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [testCert, setTestCert] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const stored = await loadPdfApiSettings(platformVaultDeps().storage);

      if (stored) {
        setServerUrl(stored.serverUrl);
        setApiToken(stored.apiToken);
        setLoaded(stored);
      }
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      certificateSummary(platformVaultDeps()).then((summary) => setSubject(summary?.subject ?? null));
    }, []),
  );

  const dirty = !loaded || loaded.serverUrl !== serverUrl || loaded.apiToken !== apiToken;

  async function saveApi() {
    setSaveError(null);
    try {
      const settings = { serverUrl: signingOrigin(serverUrl), apiToken };
      await savePdfApiSettings(platformVaultDeps().storage, settings);
      setServerUrl(settings.serverUrl);
      setLoaded(settings);
    } catch (err) {
      setSaveError(err instanceof SigningOriginError
        ? 'Zadejte platnou HTTPS adresu serveru bez cesty, parametrů, fragmentu a přihlašovacích údajů.'
        : 'Nastavení se nepodařilo uložit. Zkuste to znovu.');
    }
  }

  async function importTestCert() {
    try {
      const info = await importTestCertificate(platformVaultDeps());

      setTestCert(info.subject);
      setSubject(info.subject);
    } catch (err) {
      setTestCert(`chyba: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Nastavení</Text>

      <Text style={styles.section}>Server</Text>
      <Text style={styles.label}>Server URL</Text>
      <TextInput style={styles.input} value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" />

      <Text style={styles.label}>API token (podpis a ověření PDF)</Text>
      <Text style={styles.muted}>
        Token z DocuSealu (Nastavení → API) pro nahrání a ověření PDF. Ukládá se do úložiště zařízení.
      </Text>
      <TextInput
        style={styles.input}
        value={apiToken}
        onChangeText={setApiToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="X-Auth-Token"
      />
      <PrimaryButton title={dirty ? 'Uložit' : 'Uloženo'} onPress={saveApi} disabled={!dirty} />
      {saveError ? <Text style={styles.error} accessibilityRole="alert">{saveError}</Text> : null}

      <Text style={styles.section}>Podepisování</Text>
      <TouchableOpacity
        style={styles.row}
        onPress={() => router.push('/certificate')}
        accessibilityRole="button"
      >
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Certifikát</Text>
          <Text style={styles.muted}>{subject ?? 'Žádný certifikát'}</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
      {Platform.OS === 'android' ? (
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/reader')}
          accessibilityRole="button"
        >
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Čtečka</Text>
            <Text style={styles.muted}>Připojit čtečku eObčanky</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.section}>Diagnostika</Text>
      <Text style={styles.muted}>Poslední session a log bez citlivých dat najdete v prohlížeči.</Text>

      <Text style={styles.section}>O aplikaci</Text>
      <Text style={styles.muted}>
        Podpisové SDK: Tato aplikace využívá softwarový produkt Podpisové SDK, který pro Ministerstvo vnitra
        ČR, v rámci projektu CDBP, realizovaného STÁTNÍ TISKÁRNOU CENIN, státním podnikem, vyvinula společnost
        MONET+, a.s. Softwarový produkt Podpisové SDK může být užíván pouze v souladu s licenčními podmínkami,
        pod kterými je šířen.
      </Text>

      <Text style={styles.section}>Pokročilé</Text>
      <Text style={styles.muted}>
        Testovací certifikát je jen pro staging — nemá důvěryhodný kořen a podpis na produkci neprojde.
      </Text>
      <TextButton title="Importovat testovací certifikát" onPress={importTestCert} />
      {testCert ? <Text style={styles.muted}>Uloženo: {testCert}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 8, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  section: { fontSize: 13, fontWeight: '600', color: '#6b7280', marginTop: 16 },
  label: { fontSize: 13, color: '#6b7280', marginTop: 8 },
  muted: { fontSize: 14, color: '#6b7280' },
  error: { fontSize: 14, color: '#991b1b' },
  input: { backgroundColor: '#fff', borderRadius: 12, padding: 16, fontSize: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  rowText: { gap: 2 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  chevron: { fontSize: 20, color: '#6b7280' },
});
