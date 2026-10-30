// S11 Výběr PDF + S12 umístění pečeti (docs/15 § 7.1): vybrat PDF, nahrát ho
// do DocuSealu (šablona ve složce „Direct signing“), klepnutím umístit pečeť a
// spustit běžný obřad S4. Klíč zůstává v zařízení, server vidí jen PDF.
import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import {
  ActivityIndicator,
  Image,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { certificateSummary } from '../src/lib/crypto/vault';
import { levelLabel } from '../src/lib/level';
import { platformVaultDeps } from '../src/lib/platform';
import { signingOrigin, SigningOriginError } from '../src/lib/signingOrigin';
import {
  PdfApi,
  PdfApiError,
  loadPdfApiSettings,
  stampArea,
  stampOutline,
  tapToPosition,
  type PdfApiSettings,
  type PdfDocument,
  type PdfSession,
  type PdfSubmitter,
  type PdfUpload,
} from '../src/lib/pdfApi';
import { previewPdf, readFileBytes, sha256File } from '../src/lib/pdfShare';
import type { QesLevel } from '../src/lib/types';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const ERROR_TEXT: Record<string, string> = {
  invalid_server: 'V Nastavení zadejte HTTPS adresu serveru bez cesty, parametrů a fragmentu.',
  file_too_large: 'PDF je příliš velké (max 25 MB).',
  invalid_pdf: 'Soubor není platné PDF.',
  encrypted_pdf: 'Šifrovaná PDF nejsou podporovaná.',
  already_signed: 'Už podepsaná PDF nejsou podporovaná.',
  invalid_level: 'Nepodporovaná úroveň podpisu.',
  submitter_missing: 'Dokument se nepodařilo založit. Zkuste to znovu.',
  wrong_state: 'Požadavek už není platný. Začněte znovu.',
  expired_token: 'Platnost vypršela. Začněte znovu.',
  unknown_token: 'Podpisová session nenalezena. Začněte znovu.',
  not_authenticated: 'Chybí API token. Nastavte ho v Nastavení.',
  page_out_of_range: 'Stránka neexistuje.',
  rate_limited: 'Příliš mnoho požadavků. Zkuste to později.',
  server_error: 'Chyba serveru. Zkuste to znovu.',
  network: 'Chyba připojení. Zkuste to znovu.',
  source_mismatch: 'Server přijal jiný soubor, než jste vybrali. Zkuste to znovu.',
  already_completed: 'Dokument už je podepsaný. Otevřete ho v DocuSealu.',
  signature_in_progress: 'Podpis už probíhá v jiném okně. Dokončete ho, nebo zkuste znovu.',
  form_not_active: 'Dokument už není aktivní. Požádejte odesílatele o nový.',
  pdf_viewer_unavailable: 'PDF se nepodařilo otevřít. Nainstalujte prohlížeč PDF a zkuste to znovu.',
};

interface Rect {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

// Varianta A (čtečka eObčanky) je Android-only — MOI SDK je Android AAR (SPEC § 9.4),
// takže iOS nabízí jen AdES klíčem z telefonu.
const LEVELS: QesLevel[] = Platform.OS === 'android' ? ['ades', 'qes'] : ['ades'];

// Zobrazený obdélník obrázku (`resizeMode: contain`) v kontejneru.
function containBox(container: { width: number; height: number }, page: { width: number; height: number }): Rect {
  const scale = Math.min(container.width / page.width, container.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;

  return { x0: (container.width - width) / 2, y0: (container.height - height) / 2, width, height };
}

export default function SignPdfScreen() {
  const [settings, setSettings] = useState<PdfApiSettings | null>(null);
  const [file, setFile] = useState<PdfUpload | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [level, setLevel] = useState<QesLevel>('ades');
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [localSha256, setLocalSha256] = useState<string | null>(null);
  const [submitter, setSubmitter] = useState<PdfSubmitter | null>(null);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [submittedArea, setSubmittedArea] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [container, setContainer] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // PDF ze share sheetu (docs/15 § 6): soubor předává layout jako parametr
  // routy, obrazovka ho po načtení nastavení a jména do pečeti rovnou nahraje.
  const params = useLocalSearchParams<{ share?: string; name?: string }>();
  const shared =
    typeof params.share === 'string' && params.share.length > 0
      ? { uri: params.share, name: params.name || 'document.pdf', type: 'application/pdf' }
      : null;

  useEffect(() => {
    (async () => {
      const deps = platformVaultDeps();
      const stored = await loadPdfApiSettings(deps.storage);
      const summary = await certificateSummary(deps);

      setSettings(stored);

      if (summary?.subject) {
        setDisplayName(summary.subject);
      }

      setReady(true);
    })();
  }, []);

  const fail = useCallback((err: unknown) => {
    if (err instanceof PdfApiError || err instanceof SigningOriginError) {
      setError(err.code);
      setErrorDetail(err.message);
    } else {
      setError('network');
      setErrorDetail(err instanceof Error ? err.message : null);
    }
  }, []);

  const api = useCallback(
    () => (settings ? new PdfApi(signingOrigin(settings.serverUrl), settings.apiToken) : null),
    [settings],
  );

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'] });

    if (result.canceled || !result.assets[0]) {
      return;
    }

    const asset = result.assets[0];

    setFile({ uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/pdf' });
    setDocument(null);
    setLocalSha256(null);
    setSubmitter(null);
    setSession(null);
    setSubmittedArea(null);
    setPosition(null);
    setError(null);
    setErrorDetail(null);
  }

  // Kontrola místního souboru ještě před uploadem: co uživatel vybral,
  // to si může otevřít a zkontrolovat bez serveru a bez klíče.
  async function reviewLocalFile() {
    if (!file) {
      return;
    }

    try {
      await previewPdf(await readFileBytes(file));
    } catch {
      setError('pdf_viewer_unavailable');
    }
  }

  async function uploadFile(upload: PdfUpload): Promise<boolean> {
    setBusy(true);
    setError(null);
    setErrorDetail(null);

    try {
      const client = api();
      if (!client) {
        setError('not_authenticated');
        return false;
      }
      const expected = localSha256 ?? await sha256File(upload).catch(() => null);
      const created = await client.createDocument(upload, { displayName, levelRequired: level });

      if (created.source_sha256 && expected && created.source_sha256.toLowerCase() !== expected) {
        setError('source_mismatch');
        setErrorDetail('Server přijal jiný soubor, než jste vybrali.');
        setDocument(null);
        return false;
      }

      setLocalSha256(expected);
      setFile(upload);
      setDocument(created);
      setPage(0);
      setPosition(null);

      if (created.normalized) {
        setErrorDetail('PDF bylo normalizováno (rotace stránek).');
      }

      return true;
    } catch (err) {
      fail(err);

      return false;
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file) {
      setError('invalid_pdf');

      return;
    }

    await uploadFile(file);
  }

  // Sdílené PDF: po načtení nastavení a jména do pečeti ho rovnou nahrajeme
  // a parametr routy vyčistíme, aby se upload neopakoval při obnově obrazovky.
  useEffect(() => {
    if (!ready || !shared) {
      return;
    }

    setFile(shared);
    setDocument(null);
    setLocalSha256(null);
    setSubmitter(null);
    setSession(null);
    setSubmittedArea(null);
    setPosition(null);
    void uploadFile(shared).then((ok) => {
      if (ok) {
        router.setParams({ share: '', name: '' });
      }
    });
  }, [ready, shared?.uri]);

  async function place() {
    if (!document || !position) {
      return;
    }

    const pageSize = document.document.pages[page];

    if (!pageSize) {
      return;
    }

    setBusy(true);
    setError(null);
    setErrorDetail(null);

    try {
      const client = api();
      if (!client) {
        setError('not_authenticated');
        return;
      }
      const area = stampArea(position, pageSize, document.stamp);
      const areaKey = JSON.stringify({ ...area, page });

      await client.setStampArea(document, { ...area, page });

      let currentSubmitter = submitter;

      if (!currentSubmitter || submittedArea !== areaKey) {
        if (currentSubmitter && session) {
          await client.cancelSession(currentSubmitter.slug, session.id).catch(() => {});
        }

        const user = await client.user();
        currentSubmitter = await client.createSubmission(document, {
          name: displayName || user.email,
          email: user.email,
        });

        setSubmitter(currentSubmitter);
        setSubmittedArea(areaKey);
      }

      const next = await client.startSession(currentSubmitter.slug, document.field.uuid);

      if (!next.token) {
        setError(next.completed ? 'already_completed' : 'signature_in_progress');
        return;
      }

      setSession(next);

      router.push({
        pathname: '/sign',
        params: {
          token: next.token,
          server: settings?.serverUrl ?? '',
          flow: 'pdf',
        },
      });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function onContainerLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;

    setContainer({ width, height });
  }

  const pageSize = document?.document.pages[page];
  const box = container && pageSize ? containBox(container, pageSize) : null;
  const outline =
    position && box && pageSize && document
      ? stampOutline(position, box, pageSize, document.stamp)
      : null;

  // Chyba patří k akci, kterou opravuje (docs/17) — ne nad celou obrazovku.
  const errorBlock = (
    <>
      {error ? <Text style={styles.error}>{ERROR_TEXT[error] ?? error}</Text> : null}
      {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}
    </>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Podepsat PDF</Text>
      <Text style={styles.muted}>
        PDF se nahraje na server (do DocuSealu), klíč zůstává ve vašem zařízení. Klepnutím na
        náhled umístíte pečeť. Podepsané PDF najdete po podpisu ve složce „Direct signing“.
      </Text>

      {!document ? (
        <>
          <Text style={styles.label}>Soubor PDF</Text>
          <SecondaryButton title="Vybrat PDF" onPress={pickFile} />
          {file ? (
            <>
              <TouchableOpacity
                style={styles.fileOpen}
                onPress={reviewLocalFile}
                accessibilityRole="link"
                accessibilityLabel={`Otevřít místní PDF: ${file.name}`}
              >
                <Text style={styles.fileOpenLabel}>Otevřít</Text>
                <Text style={styles.fileOpenName} numberOfLines={1} ellipsizeMode="middle">
                  {file.name}
                </Text>
                <Text style={styles.fileOpenChevron}>›</Text>
              </TouchableOpacity>
              <Text style={styles.fileOpenCaption}>
                Místní soubor před nahráním. Podepisuje se verze s pečetí.
              </Text>
            </>
          ) : null}

          <Text style={styles.label}>Jméno do pečeti</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Jan Novák"
          />

          <Text style={styles.label}>Úroveň: {levelLabel(level)}</Text>
          <View style={styles.row}>
            {LEVELS.map((item) => (
              <TouchableOpacity
                key={item}
                style={[styles.chip, level === item && styles.chipActive]}
                onPress={() => setLevel(item)}
              >
                <Text style={level === item ? styles.chipActiveText : styles.chipText}>
                  {levelLabel(item)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {Platform.OS === 'android' && level === 'qes' ? (
            <Text style={styles.muted}>QES vyžaduje čtečku s eObčankou.</Text>
          ) : null}
          {Platform.OS !== 'android' ? (
            <Text style={styles.muted}>
              Na iOS je dostupný jen AdES (čtečka eObčanky je podporovaná jen na Androidu).
            </Text>
          ) : null}

          {!settings ? (
            <Text style={styles.muted}>
              Server URL a API token nastavte v Nastavení (Nastavení → Server a API token).
            </Text>
          ) : null}

          {errorBlock}

          <PrimaryButton
            title={busy ? 'Nahrávám…' : 'Pokračovat'}
            onPress={upload}
            disabled={busy || !file}
          />
          <TextButton title="Zrušit" onPress={() => router.replace('/')} />
        </>
      ) : (
        <>
          <View style={styles.rowBetween}>
            <TouchableOpacity
              style={styles.chip}
              disabled={page === 0}
              onPress={() => {
                setPage(page - 1);
                setPosition(null);
              }}
            >
              <Text style={styles.chipText}>‹ Předchozí</Text>
            </TouchableOpacity>
            <Text style={styles.muted}>
              Strana {page + 1} / {document.document.pages.length}
            </Text>
            <TouchableOpacity
              style={styles.chip}
              disabled={page >= document.document.pages.length - 1}
              onPress={() => {
                setPage(page + 1);
                setPosition(null);
              }}
            >
              <Text style={styles.chipText}>Další ›</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.preview} onLayout={onContainerLayout}>
            {pageSize ? (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={(event) => {
                  if (!box) {
                    return;
                  }

                  const { locationX, locationY } = event.nativeEvent;

                  setPosition(tapToPosition({ x: locationX, y: locationY }, box));
                }}
              >
                <Image
                  style={styles.image}
                  resizeMode="contain"
                  source={{
                    uri: pageSize.preview_url,
                    headers: settings ? { 'X-Auth-Token': settings.apiToken } : undefined,
                  }}
                  onError={() => {
                    setError('network');
                    setErrorDetail('Náhled stránky se nepodařilo načíst.');
                  }}
                />
              </Pressable>
            ) : (
              <ActivityIndicator />
            )}

            {outline ? (
              <View
                pointerEvents="none"
                style={[
                  styles.stamp,
                  { left: outline.left, top: outline.top, width: outline.width, height: outline.height },
                ]}
              />
            ) : null}
          </View>

          <Text style={styles.muted}>
            {position
              ? 'Pečeť je umístěná. Klepnutím ji přesunete.'
              : 'Klepněte na místo, kam se má pečeť umístit.'}
          </Text>

          {errorBlock}

          <PrimaryButton
            title={busy ? 'Připravuji…' : 'Pokračovat'}
            onPress={place}
            disabled={busy || !position}
          />
          <TextButton
            title="Vybrat jiné PDF"
            onPress={() => {
              setDocument(null);
              setLocalSha256(null);
              setSubmitter(null);
              setSession(null);
              setSubmittedArea(null);
              setPosition(null);
            }}
          />
          <TextButton title="Zrušit" onPress={() => router.replace('/')} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  input: { backgroundColor: '#fff', borderRadius: 12, padding: 16, fontSize: 16, color: '#111827' },
  error: { color: '#991b1b', fontSize: 14 },
  detail: { color: '#b45309', fontSize: 12 },
  row: { flexDirection: 'row', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fileOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  fileOpenLabel: { color: '#6b7280', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  fileOpenName: { flex: 1, color: '#6b7280', fontSize: 12 },
  fileOpenChevron: { color: '#9ca3af', fontSize: 14 },
  fileOpenCaption: { color: '#6b7280', fontSize: 10.5, lineHeight: 14, marginTop: -2, marginBottom: 2 },
  chip: { borderColor: '#291334', borderWidth: 1, borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: '#291334' },
  chipText: { color: '#291334', fontWeight: '600' },
  chipActiveText: { color: '#fff', fontWeight: '600' },
  preview: {
    height: 420,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  stamp: {
    position: 'absolute',
    borderColor: '#291334',
    borderWidth: 2,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(246, 241, 249, 0.6)',
  },
});
