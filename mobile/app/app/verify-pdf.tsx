// S14/S15 Ověření PDF (docs/16, docs/19): výběr nebo share PDF → lokální
// ověření v DocuSealu, nebo nezávislé ověření přes veřejné API EU DSS.
// Externí volba je vždy opt-in se souhlasem: PDF se odešle na servery
// Evropské komise a externí report se do DocuSealu neukládá.
import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { EuDssApi, EuDssError } from '../src/lib/euDssApi';
import { levelLabel } from '../src/lib/level';
import { platformVaultDeps } from '../src/lib/platform';
import { signingOrigin, SigningOriginError } from '../src/lib/signingOrigin';
import {
  PdfApi,
  PdfApiError,
  loadPdfApiSettings,
  type PdfApiSettings,
  type PdfProvider,
  type PdfUpload,
  type PdfVerification,
} from '../src/lib/pdfApi';
import {
  canStore,
  coverageLabel,
  formatBytes,
  formatDate,
  originLabel,
  revocationLabel,
  signatureKindLabel,
  signatureTitle,
  verdictBackground,
  verdictColor,
  verdictIcon,
  verdictView,
} from '../src/lib/verifyPdf';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const ERROR_TEXT: Record<string, string> = {
  invalid_server: 'V Nastavení zadejte HTTPS adresu serveru bez cesty, parametrů a fragmentu.',
  invalid_pdf: 'Soubor není platné PDF.',
  encrypted_pdf: 'Šifrovaná PDF nelze ověřit.',
  file_too_large: 'PDF je příliš velké (max 25 MB).',
  not_verifiable: 'Toto PDF nelze uložit (podpis není v pořádku).',
  storage_failed: 'Uložení se nepodařilo. Zkuste to znovu.',
  not_authenticated: 'Chybí API token. Nastavte ho v Nastavení.',
  rate_limited: 'Příliš mnoho požadavků. Zkuste to později.',
  server_error: 'Chyba serveru. Zkuste to znovu.',
  eu_dss_unavailable: 'Externí ověření není dostupné. Zkuste to později nebo ověřte v DocuSealu.',
  eu_dss_error: 'Externí služba odmítla PDF. Zkuste ověřit v DocuSealu.',
  network: 'Chyba připojení. Zkuste to znovu.',
};

export default function VerifyPdfScreen() {
  const [settings, setSettings] = useState<PdfApiSettings | null>(null);
  const [file, setFile] = useState<PdfUpload | null>(null);
  const [report, setReport] = useState<PdfVerification | null>(null);
  const [provider, setProvider] = useState<PdfProvider>('local');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const params = useLocalSearchParams<{ share?: string; name?: string }>();
  const shared =
    typeof params.share === 'string' && params.share.length > 0
      ? { uri: params.share, name: params.name || 'document.pdf', type: 'application/pdf' }
      : null;

  useEffect(() => {
    (async () => {
      const stored = await loadPdfApiSettings(platformVaultDeps().storage);

      setSettings(stored);
      setFile(shared);
      setReady(true);
    })();
  }, [shared?.uri]);

  const api = useCallback(
    () => (settings ? new PdfApi(signingOrigin(settings.serverUrl), settings.apiToken) : null),
    [settings],
  );

  const fail = useCallback((err: unknown) => {
    if (err instanceof PdfApiError || err instanceof EuDssError || err instanceof SigningOriginError) {
      setError(err.code);
      setErrorDetail(err.message);
    } else {
      setError('network');
      setErrorDetail(err instanceof Error ? err.message : null);
    }
  }, []);

  const verify = useCallback(
    async (upload: PdfUpload) => {
      setBusy(true);
      setError(null);
      setErrorDetail(null);

      try {
        const result = provider === 'eu_dss'
          ? await new EuDssApi().verifyDocument(upload)
          : await api()?.verifyDocument(upload);

        if (!result) {
          setError('not_authenticated');

          return;
        }

        setFile(upload);
        setReport(result);
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [api, fail, provider],
  );

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'] });

    if (result.canceled || !result.assets[0]) {
      return;
    }

    const asset = result.assets[0];
    const upload = { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/pdf' };

    setFile(upload);
    await verify(upload);
  }

  function signShared() {
    if (!shared) {
      return;
    }

    router.push({ pathname: '/sign-pdf', params: { share: shared.uri ?? '', name: shared.name } });
    router.setParams({ share: '', name: '' });
  }

  async function store() {
    setSaving(true);
    setError(null);
    setErrorDetail(null);

    try {
      const client = api();
      if (!client || !file) {
        setError(client ? 'invalid_pdf' : 'not_authenticated');
        return;
      }
      setReport(await client.storeVerifiedDocument(file));
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setProvider('local');
    setConsent(false);
    setFile(null);
    setReport(null);
    setError(null);
    setErrorDetail(null);
    setShowDetails(false);
    router.setParams({ share: '', name: '' });
  }

  const view = report ? verdictView(report) : null;
  const signer = report?.signatures.find((signature) => signature.kind === 'qes');
  const external = provider === 'eu_dss';
  const canVerify = !external || consent;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Ověřit PDF</Text>
      <Text style={styles.muted}>
        PDF se nahraje kvůli ověření a neukládá se. U lokálního ověření zůstane
        na našem serveru, u EU DSS se odešle na servery Evropské komise.
      </Text>

      {error ? <Text style={styles.error}>{ERROR_TEXT[error] ?? error}</Text> : null}
      {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}

      {report && view ? (
        <>
          <View style={styles.badgeRow}>
            <Text style={styles.badge}>
              Ověřeno: {report.provider === 'eu_dss' ? 'EU DSS' : 'DocuSeal'}
            </Text>
          </View>

          <View style={[styles.verdict, { backgroundColor: verdictBackground(view.tone) }]}>
            <Text style={[styles.verdictIcon, { color: verdictColor(view.tone) }]}>
              {verdictIcon(view.tone)}
            </Text>
            <View style={styles.verdictText}>
              <Text style={[styles.verdictTitle, { color: verdictColor(view.tone) }]}>{view.title}</Text>
              <Text style={styles.verdictSubtitle}>{view.subtitle}</Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Soubor</Text>
            <Text style={styles.value}>{report.file.name}</Text>
            <Text style={styles.muted}>
              {formatBytes(report.file.size)} · ověřeno {formatDate(report.validated_at)}
            </Text>
            {report.origin !== 'unknown' ? (
              <Text style={styles.muted}>{originLabel(report.origin)}</Text>
            ) : null}
          </View>

          {signer ? (
            <View style={styles.card}>
              <Text style={styles.label}>Podepsal</Text>
              <Text style={styles.value}>{signatureTitle(signer)}</Text>
              <Text style={styles.muted}>{signer.issuer || 'Neznámý vydavatel'}</Text>
              <Text style={styles.muted}>
                {levelLabel(signer.level)} · {formatDate(signer.signing_time)} ·{' '}
                {coverageLabel(report.coverage)}
              </Text>
              <Text style={signer.trusted ? styles.ok : styles.warning}>
                {signer.trusted ? 'Důvěryhodný certifikát' : 'Nedůvěryhodný certifikát'}
              </Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.label}>Kontrola</Text>
            <Text style={report.intact ? styles.ok : styles.error}>
              {report.intact ? 'Podpisy jsou v pořádku' : 'Podpis je neplatný'}
            </Text>
            {report.provider === 'eu_dss' ? (
              <Text style={styles.muted}>Změny po podpisu: neověřeno (externí ověření)</Text>
            ) : (
              <Text style={report.modified ? styles.error : styles.muted}>
                {report.modified ? 'PDF bylo po podpisu změněno' : 'Bez změn po podpisu'}
              </Text>
            )}
            <Text style={styles.muted}>Pokrytí: {coverageLabel(report.coverage)}</Text>
            <Text style={styles.muted}>Revokace: {revocationLabel(report.revocation)}</Text>
            {report.seal.present ? (
              <Text style={report.provider === 'local' && report.seal.trusted ? styles.ok : styles.warning}>
                Pečeť DocuSealu:{' '}
                {report.provider === 'local' && report.seal.trusted
                  ? 'ověřena'
                  : 'neověřená (externí ověření)'}
              </Text>
            ) : null}
          </View>

          {report.provider === 'eu_dss' ? (
            <View style={styles.info}>
              <Text style={styles.infoTitle}>Externí ověření</Text>
              <Text style={styles.infoText}>
                PDF bylo odesláno na servery Evropské komise (EU DSS). Externí ověření
                nekontroluje změny po podpisu ani pečeť DocuSealu; pro kontrolu změn použijte
                ověření v DocuSealu.
              </Text>
            </View>
          ) : null}

          {report.signatures.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.label}>Podpisy ({report.signatures.length})</Text>
              {report.signatures.map((signature, index) => (
                <View key={`${signature.serial ?? signature.kind}-${index}`} style={styles.signature}>
                  <Text style={styles.value}>{signatureTitle(signature)}</Text>
                  <Text style={styles.muted}>
                    {signatureKindLabel(signature)} · {levelLabel(signature.level)} ·{' '}
                    {formatDate(signature.signing_time)}
                  </Text>
                  <Text style={styles.muted}>{signature.issuer || 'Neznámý vydavatel'}</Text>
                  <Text style={signature.intact ? styles.ok : styles.error}>
                    {signature.intact ? 'V pořádku' : 'Neplatný'}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <PrimaryButton title="Ověřit jiné PDF" onPress={reset} />

          {canStore(report) ? (
            <SecondaryButton
              title={saving ? 'Ukládám…' : 'Uložit do DocuSealu'}
              onPress={store}
              disabled={saving}
            />
          ) : report.stored ? (
            <Text style={styles.saved}>Uloženo do složky Verified documents.</Text>
          ) : report.provider === 'eu_dss' ? (
            <Text style={styles.warning}>
              Externí ověření se neukládá. Pro uložení ověřte PDF v DocuSealu.
            </Text>
          ) : (
            <Text style={styles.warning}>Toto PDF nelze uložit do DocuSealu.</Text>
          )}

          <TextButton
            title={showDetails ? 'Skrýt technické detaily' : 'Technické detaily'}
            onPress={() => setShowDetails(!showDetails)}
          />

          {showDetails ? (
            <View style={styles.card}>
              <Text style={styles.label}>Technické detaily</Text>
              <Text style={styles.mono}>SHA-256: {report.file.sha256}</Text>
              <Text style={styles.muted}>
                Důvěryhodné kořeny:{' '}
                {report.provider === 'eu_dss'
                  ? 'EU trusted list (EU DSS)'
                  : report.trusted_roots.join(', ') || '—'}
              </Text>
              {report.signatures.map((signature, index) => (
                <View key={`detail-${signature.serial ?? signature.kind}-${index}`} style={styles.signature}>
                  <Text style={styles.muted}>
                    {signatureKindLabel(signature)}: {signature.serial ?? '—'}
                  </Text>
                  <Text style={styles.muted}>
                    Platnost: {formatDate(signature.not_before)} – {formatDate(signature.not_after)}
                  </Text>
                  <Text style={styles.muted}>Řetěz: {signature.chain.join(' → ') || '—'}</Text>
                </View>
              ))}
              {report.messages.map((message, index) => (
                <Text key={`message-${index}`} style={styles.muted}>
                  {message.status}: {message.text}
                </Text>
              ))}
            </View>
          ) : null}

          <TextButton title="Zavřít" onPress={() => router.replace('/')} />
        </>
      ) : (
        <>
          {shared ? (
            <View style={styles.card}>
              <Text style={styles.label}>PDF z jiné aplikace</Text>
              <Text style={styles.value}>{shared.name}</Text>
            </View>
          ) : null}

          <View style={styles.group}>
            <Text style={styles.groupLabel}>Kde ověřit</Text>
            <ChoiceRow
              selected={provider === 'local'}
              title="V DocuSealu"
              subtitle="PDF zůstane na našem serveru. Ověření proti trust rootům DocuSealu."
              onPress={() => {
                setProvider('local');
                setConsent(false);
              }}
            />
            <ChoiceRow
              selected={provider === 'eu_dss'}
              title="Přes EU DSS"
              subtitle="PDF se odešle na servery Evropské komise. Ověření proti EU trusted listům."
              onPress={() => setProvider('eu_dss')}
            />
          </View>

          {external ? (
            <>
              <View style={styles.warningCard}>
                <Text style={styles.warningTitle}>PDF opustí DocuSeal</Text>
                <Text style={styles.warningText}>
                  Pro nezávislé ověření se PDF odešle na veřejnou demo službu EU DSS
                  (Evropská komise). Neposílejte důvěrné dokumenty. Služba je bez SLA
                  a může být přetížená. Certifikát musí být v EU trusted listu, jinak
                  ověření vyjde jako nedůvěryhodné.
                </Text>
              </View>

              <TouchableOpacity
                style={styles.consent}
                onPress={() => setConsent(!consent)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: consent }}
              >
                <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
                  {consent ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <Text style={styles.consentText}>
                  Rozumím, PDF se odešle na servery Evropské komise.
                </Text>
              </TouchableOpacity>
            </>
          ) : null}

          {shared ? (
            <PrimaryButton
              title={external ? 'Ověřit přes EU DSS' : 'Ověřit PDF'}
              onPress={() => verify(shared)}
              disabled={busy || !canVerify}
            />
          ) : (
            <PrimaryButton
              title={external ? 'Vybrat PDF (EU DSS)' : 'Vybrat PDF'}
              onPress={pickFile}
              disabled={busy || !ready || !canVerify}
            />
          )}

          {shared ? (
            <PrimaryButton title="Podepsat PDF" onPress={signShared} disabled={busy} />
          ) : null}

          {busy ? <ActivityIndicator /> : null}

          {!external && !settings ? (
            <Text style={styles.warning}>
              Server URL a API token nastavte v Nastavení (Nastavení → Server a API token).
            </Text>
          ) : null}

          <TextButton title="Zavřít" onPress={() => router.replace('/')} />
        </>
      )}
    </ScrollView>
  );
}

function ChoiceRow({
  selected,
  title,
  subtitle,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.choice, selected && styles.choiceSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={styles.choiceText}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceSubtitle}>{subtitle}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280' },
  value: { fontSize: 16, fontWeight: '600' },
  error: { color: '#991b1b', fontSize: 14 },
  detail: { color: '#b45309', fontSize: 12 },
  ok: { color: '#166534', fontSize: 14 },
  warning: { color: '#b45309', fontSize: 14 },
  saved: { color: '#166534', fontSize: 14 },
  mono: { fontFamily: 'monospace', fontSize: 11, color: '#374151' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 6 },
  signature: { borderTopColor: '#e5e7eb', borderTopWidth: 1, paddingTop: 8, marginTop: 4, gap: 2 },
  verdict: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 16, gap: 12 },
  verdictIcon: { fontSize: 32, fontWeight: '700' },
  verdictText: { flex: 1, gap: 4 },
  verdictTitle: { fontSize: 18, fontWeight: '700' },
  verdictSubtitle: { fontSize: 14, color: '#374151' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    borderColor: '#291334',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    color: '#291334',
    fontSize: 12,
    fontWeight: '600',
  },
  group: { backgroundColor: '#fff', borderRadius: 14, padding: 4 },
  groupLabel: { fontSize: 13, color: '#6b7280', paddingHorizontal: 10, paddingTop: 8 },
  choice: { flexDirection: 'row', gap: 10, padding: 10, borderRadius: 10, alignItems: 'flex-start' },
  choiceSelected: { backgroundColor: '#f5f3ff' },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#d1d5db',
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: '#291334', backgroundColor: '#291334' },
  radioDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  choiceText: { flex: 1, gap: 2 },
  choiceTitle: { fontSize: 14, fontWeight: '600' },
  choiceSubtitle: { fontSize: 12, color: '#6b7280', lineHeight: 17 },
  warningCard: {
    backgroundColor: '#fef3c7',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: '#92400e' },
  warningText: { fontSize: 12, color: '#92400e', lineHeight: 17 },
  consent: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 2 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#9ca3af',
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#291334', borderColor: '#291334' },
  checkmark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  consentText: { flex: 1, fontSize: 12, color: '#374151', lineHeight: 17 },
  info: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  infoTitle: { fontSize: 14, fontWeight: '700', color: '#1e40af' },
  infoText: { fontSize: 12, color: '#1e40af', lineHeight: 17 },
});
