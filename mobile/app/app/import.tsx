// S2 Import certifikátu (SPEC § 9.1, docs/17): soubor → heslo → import.
// Testovací certifikát je alternativní cesta, proto je až za oddělovačem pod hlavním tokem.
import { useRef, useState } from 'react';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { importCertificate, VaultError, type StoredCertificateInfo } from '../src/lib/crypto/vault';
import { importTestCertificate } from '../src/lib/testCertificate';
import { P12Error } from '../src/lib/crypto/p12';
import { levelLabel } from '../src/lib/level';
import { platformVaultDeps } from '../src/lib/platform';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const ERROR_TEXT: Record<string, string> = {
  invalid_p12: 'Soubor není platný PKCS#12.',
  wrong_password: 'Nesprávné heslo.',
  no_signing_key: 'Soubor neobsahuje podpisový klíč.',
  qscd_certificate: 'Tento certifikát patří čipu, v telefonu ho použít nelze.',
  unsupported_key_type: 'Tento typ podpisového klíče není podporovaný. Použijte certifikát s klíčem RSA.',
  unsupported_certificate: 'Certifikát nepodporuje podepisování.',
  biometry_rejected: 'Biometrické ověření bylo zrušeno.',
  biometry_unavailable: 'V telefonu není dostupná biometrie.',
  vault_unavailable: 'Úložiště klíče není dostupné.',
  vault_encrypt_failed: 'Klíč se nepodařilo bezpečně uložit.',
};

function errorText(err: unknown): string {
  if (err instanceof P12Error || err instanceof VaultError) {
    return ERROR_TEXT[err.code] ?? err.code;
  }

  return 'Import se nepodařil. Zkuste to znovu.';
}

// Ikona oka je kreslená Views — appka nemá knihovnu ikon a tahat ji kvůli jedné
// ikoně by bylo víc závislostí než užitku.
function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <View style={styles.eye}>
      <View style={styles.eyeLens}>
        <View style={styles.eyePupil} />
      </View>
      {hidden ? <View style={styles.eyeSlash} /> : null}
    </View>
  );
}

// parseP12 je synchronní a blokuje JS thread; jeden frame navíc zajistí,
// že se loader stihne vykreslit ještě před ním.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

export default function ImportScreen() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<StoredCertificateInfo | null>(null);
  const [busy, setBusy] = useState<'key' | 'test' | null>(null);
  const busyRef = useRef<'key' | 'test' | null>(null);

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/x-pkcs12', '*/*'] });

    if (result.canceled || !result.assets[0]) {
      return;
    }

    const file = new File(result.assets[0].uri);

    setBytes(await file.bytes());
    setFileName(result.assets[0].name);
    setError(null);

    try {
      file.delete();
    } catch {
      // Soubor v cache se nepodařilo smazat; obsah už máme v paměti.
    }
  }

  async function importTest() {
    if (busyRef.current) {
      return;
    }

    busyRef.current = 'test';
    setBusy('test');
    await nextFrame();

    try {
      setInfo(await importTestCertificate(platformVaultDeps()));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  async function importKey() {
    if (!bytes || busyRef.current) {
      return;
    }

    busyRef.current = 'key';
    setBusy('key');
    await nextFrame();

    try {
      const stored = await importCertificate(platformVaultDeps(), bytes, password);

      setInfo(stored);
      setPassword('');
      setBytes(null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  if (info) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Certifikát importován</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Předmět</Text>
          <Text style={styles.value}>{info.subject}</Text>
          <Text style={styles.muted}>{info.issuer}</Text>
          <Text style={styles.muted}>
            {levelLabel(info.level)} · {info.keyType.toUpperCase()} {info.keySize} ·{' '}
            {info.qcStatements.join(', ') || 'bez QCStatements'}
          </Text>
        </View>

        <PrimaryButton title="Hotovo" onPress={() => router.replace('/')} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Import certifikátu</Text>
      <Text style={styles.muted}>
        Aplikace si sama vytvoří náhodný 256bitový klíč, kterým klíč ihned přešifruje. Při podpisu ho
        odemkne otiskem; heslo k souboru se používá jen jednou a nikdy se neukládá.
      </Text>

      <Text style={styles.label}>Soubor PKCS#12</Text>
      <SecondaryButton
        title={fileName ?? 'Vybrat soubor'}
        onPress={pickFile}
        disabled={busy !== null}
      />

      <Text style={styles.label}>Heslo</Text>
      <View style={styles.passwordRow}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Heslo k souboru"
          // autoCorrect/autoCapitalize vypnuté i kvůli iOS: při přepnutí
          // secureTextEntry by jinak pole mohlo zahodit napsaný text.
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
          editable={busy === null}
        />
        <TouchableOpacity
          style={styles.passwordToggle}
          onPress={() => setShowPassword((visible) => !visible)}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? 'Skrýt heslo' : 'Zobrazit heslo'}
          hitSlop={8}
        >
          <EyeIcon hidden={!showPassword} />
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <PrimaryButton
        title={busy === 'key' ? 'Importuji…' : 'Importovat'}
        onPress={importKey}
        disabled={!bytes || busy !== null}
        loading={busy === 'key'}
      />

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerLabel}>Nebo</Text>
        <View style={styles.dividerLine} />
      </View>

      <Text style={styles.muted}>
        Testovací certifikát je jen pro staging — nemá důvěryhodný kořen a podpis na produkci
        neprojde.
      </Text>
      <TextButton
        title={busy === 'test' ? 'Importuji…' : 'Použít testovací certifikát'}
        onPress={importTest}
        disabled={busy !== null}
        loading={busy === 'test'}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  label: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  muted: { fontSize: 14, color: '#6b7280' },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingRight: 8,
  },
  passwordInput: { flex: 1, padding: 16, fontSize: 16 },
  passwordToggle: { padding: 8 },
  eye: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  eyeLens: {
    width: 22,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: '#6b7280',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyePupil: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#6b7280' },
  eyeSlash: {
    position: 'absolute',
    width: 26,
    height: 1.5,
    backgroundColor: '#6b7280',
    transform: [{ rotate: '-45deg' }],
  },
  error: { color: '#991b1b', fontSize: 14 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 6, marginBottom: 4 },
  value: { fontSize: 16, fontWeight: '600' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerLabel: { fontSize: 13, color: '#6b7280' },
});
