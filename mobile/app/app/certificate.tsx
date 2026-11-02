// S3 Detail certifikátu (SPEC § 9.1, docs/17): údaje, nahrazení klíče a oddělené
// nebezpečné smazání s potvrzením.
import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';

import { certificateSummary, removeCertificate, VaultError, type StoredCertificateInfo } from '../src/lib/crypto/vault';
import { levelLabel } from '../src/lib/level';
import { platformVaultDeps } from '../src/lib/platform';
import { DangerButton, SecondaryButton } from '../src/ui/buttons';

export default function CertificateScreen() {
  const [info, setInfo] = useState<StoredCertificateInfo | null>(null);

  useFocusEffect(
    useCallback(() => {
      certificateSummary(platformVaultDeps()).then(setInfo);
    }, []),
  );

  async function remove() {
    try {
      await removeCertificate(platformVaultDeps());
      router.dismissTo('/');
    } catch (err) {
      Alert.alert(
        'Smazání zrušeno',
        err instanceof VaultError && err.code === 'biometry_rejected'
          ? 'Certifikát zůstal uložený.'
          : 'Klíč se nepodařilo smazat.',
      );
    }
  }

  function confirmRemove() {
    Alert.alert(
      'Smazat certifikát?',
      'Klíč i certifikát se z telefonu nevratně odstraní. Podepisovat půjde až po novém importu.',
      [
        { text: 'Zrušit', style: 'cancel' },
        { text: 'Smazat', style: 'destructive', onPress: remove },
      ],
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Certifikát</Text>
      {info ? (
        <>
          <Text style={styles.label}>Předmět</Text>
          <Text style={styles.value}>{info.subject}</Text>
          <Text style={styles.label}>Vydavatel</Text>
          <Text style={styles.value}>{info.issuer}</Text>
          <Text style={styles.label}>Sériové číslo</Text>
          <Text style={styles.value}>{info.serial}</Text>
          <Text style={styles.label}>Platnost</Text>
          <Text style={styles.value}>
            {new Date(info.notBefore).toLocaleDateString('cs-CZ')} –{' '}
            {new Date(info.notAfter).toLocaleDateString('cs-CZ')}
          </Text>
          <Text style={styles.label}>Úroveň</Text>
          <Text style={styles.value}>
            {levelLabel(info.level)} · {info.qcStatements.join(', ') || 'bez QCStatements'}
          </Text>
        </>
      ) : (
        <Text style={styles.value}>Žádný certifikát</Text>
      )}

      <SecondaryButton
        title="Importovat jiný klíč"
        onPress={() => router.push('/import')}
        style={styles.replace}
      />

      <Text style={styles.dangerZone}>Nebezpečná zóna</Text>
      <DangerButton title="Smazat certifikát a klíč" onPress={confirmRemove} disabled={!info} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 4, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 13, color: '#6b7280', marginTop: 8 },
  value: { fontSize: 16, fontWeight: '600' },
  replace: { marginTop: 16 },
  dangerZone: { fontSize: 13, color: '#991b1b', fontWeight: '600', marginTop: 32, marginBottom: 8 },
});
