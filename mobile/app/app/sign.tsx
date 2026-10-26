// S4 Žádost o podpis (SPEC § 9.1): deep link → metadata → biometrie → podpis.
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { resolveSigningOrigin, SigningOriginError } from '../src/lib/signingOrigin';
import { QesApi, QesApiError } from '../src/lib/api';
import { runSigningCeremony, CeremonyError } from '../src/lib/ceremony';
import { VaultError } from '../src/lib/crypto/vault';
import { levelLabel } from '../src/lib/level';
import { PdfApi, PdfApiError, loadPdfApiSettings } from '../src/lib/pdfApi';
import {
  PdfActionError,
  downloadPdf,
  isPickerCancelled,
  loadSaveFolder,
  openPdf,
  previewPdf,
  rememberSaveFolder,
  savePdf,
  sharePdf,
  type SaveFolder,
  type SavedPdf,
} from '../src/lib/pdfShare';
import { platformVaultDeps } from '../src/lib/platform';
import type { QesSessionPayload } from '../src/lib/types';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const ERROR_TEXT: Record<string, string> = {
  invalid_submission: 'Chybí údaj pro dokončení uložení dokumentu. Otevřete původní odkaz.',
  document_mismatch: 'Dokument neodpovídá údajům k podpisu. Podpis byl odmítnut. Vyžádejte nový odkaz.',
  user_cancelled: 'Podpis byl zrušen.',
  pdf_viewer_unavailable: 'PDF se nepodařilo otevřít. Nainstalujte prohlížeč PDF a zkuste to znovu.',
  foreign_server: 'Odkaz patří jinému serveru než tomu v Nastavení. Podpis byl odmítnut.',
  invalid_server: 'V Nastavení zadejte platnou HTTPS adresu serveru.',
  expired_token: 'Platnost odkazu vypršela. Vyžádejte nový.',
  used_token: 'Podpis už byl dokončen.',
  unknown_token: 'Neplatný odkaz. Vyžádejte nový.',
  network: 'Chyba připojení. Zkuste to znovu.',
  certificate_missing: 'Certifikát chybí nebo vypršel. Importujte nový.',
  biometry_rejected: 'Podpis se neprovede bez biometrie.',
  biometry_unavailable: 'V telefonu není nastavená biometrie (otisk/obličej).',
  key_invalidated: 'Klíč byl zneplatněn změnou biometrie. Importujte klíč znovu.',
  vault_unavailable: 'Úložiště klíče není dostupné.',
  vault_decrypt_failed: 'Klíč se nepodařilo odemknout.',
  qes_required_qscd: 'Vyžaduje se kvalifikovaný certifikát (QES).',
  no_signer: 'Nejdřív nastavte podepisování (klíč nebo čtečku).',
  needs_qes_key: 'Pro QES je potřeba čtečka s eObčankou.',
  needs_reader: 'Připojte čtečku a zkuste to znovu.',
  level_mismatch: 'Vybraný certifikát neodpovídá typu podpisu.',
  not_qualified: 'Certifikát není kvalifikovaný.',
  not_trusted: 'Certifikát není důvěryhodný. Použijte certifikát od důvěryhodné CA (I.CA/PostSignum).',
  revoked: 'Certifikát byl revokován.',
  signature_invalid: 'Podpis se nepodařilo ověřit. Zkuste to znovu.',
  wrong_state: 'Požadavek už není platný. Vyžádejte nový odkaz.',
  invalid_pdf: 'Soubor není platné PDF.',
  encrypted_pdf: 'Šifrovaná PDF nejsou podporovaná.',
  already_signed: 'Už podepsaná PDF nejsou podporovaná.',
  file_too_large: 'PDF je příliš velké (max 25 MB).',
  not_authenticated: 'Chybí API token. Nastavte ho v Nastavení.',
  rate_limited: 'Příliš mnoho požadavků. Zkuste to později.',
  document_missing: 'Dokument v DocuSealu chybí. Zkuste to znovu.',
  download_failed: 'Stažení PDF se nepodařilo. Zkuste to znovu.',
  save_failed: 'Uložení PDF se nepodařilo. Zkuste to znovu.',
  share_failed: 'Sdílení PDF se nepodařilo. Zkuste to znovu.',
  sharing_unavailable: 'Sdílení není v tomto zařízení dostupné.',
  open_failed: 'Otevření PDF se nepodařilo. Zkuste to znovu.',
  no_pdf_viewer: 'V telefonu není aplikace pro zobrazení PDF.',
};

export default function SignScreen() {
  const { token, server, flow, submitter } = useLocalSearchParams<{
    token?: string;
    server?: string;
    flow?: string;
    submitter?: string;
  }>();
  const [session, setSession] = useState<QesSessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [done, setDone] = useState<{ level: string; digest: string } | null>(null);
  const [submissionCompleted, setSubmissionCompleted] = useState(false);
  const [savingSubmission, setSavingSubmission] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submissionLock = useRef(false);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDetail, setActionDetail] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedPdf | null>(null);
  const [folder, setFolder] = useState<SaveFolder | null>(null);

  const [reviewPdf, setReviewPdf] = useState<Uint8Array | null>(null);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [openingPdf, setOpeningPdf] = useState(false);
  const consent = useRef<((confirmed: boolean) => void) | null>(null);
  const signingLock = useRef(false);
  const generation = useRef(0);
  const reviewGeneration = useRef(0);

  const confirmDocument = useCallback((pdf: Uint8Array) => new Promise<boolean>((resolve) => {
    reviewGeneration.current += 1;
    setReviewOpened(false);
    setReviewPdf(pdf);
    consent.current = resolve;
  }), []);

  const finishReview = useCallback((confirmed: boolean) => {
    reviewGeneration.current += 1;
    const resolve = consent.current;
    consent.current = null;
    setReviewPdf(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    setReviewPdf(null);
    setReviewOpened(false);
    return () => {
      generation.current += 1;
      reviewGeneration.current += 1;
      consent.current?.(false);
      consent.current = null;
    };
  }, [token, server]);

  const openReview = async () => {
    if (!reviewPdf || openingPdf) return;
    const currentReview = reviewGeneration.current;
    setOpeningPdf(true);
    try {
      await previewPdf(reviewPdf);
      if (currentReview !== reviewGeneration.current) return;
      setReviewOpened(true);
      setError(null);
    } catch {
      if (currentReview === reviewGeneration.current) setError('pdf_viewer_unavailable');
    } finally {
      setOpeningPdf(false);
    }
  };

  const isPdfFlow = flow === 'pdf';
  // Bez certifikátu nebo podepisujícího vede primární akce do wizardu S10 (docs/17).
  const needsSetup = error === 'certificate_missing' || error === 'vault_decrypt_failed'
    || error === 'key_invalidated' || error === 'no_signer';
  const submitterId = typeof submitter === 'string' && submitter.length > 0 ? Number(submitter) : null;
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // Klient pro dokončení submissionu a stažení finálního PDF (docs/15 § 5).
  const pdfApi = useCallback(async () => {
    const settings = await loadPdfApiSettings(platformVaultDeps().storage);

    return new PdfApi(await resolveSigningOrigin(platformVaultDeps().storage, server), settings?.apiToken ?? '');
  }, [server]);

  const finishSubmission = useCallback(async () => {
    if (submissionLock.current) return;
    if (!submitterId || !Number.isSafeInteger(submitterId) || submitterId <= 0) {
      setSubmissionError('invalid_submission');
      return;
    }
    const currentGeneration = generation.current;
    submissionLock.current = true;
    setSavingSubmission(true);
    setSubmissionError(null);
    try {
      await (await pdfApi()).completeSubmission(submitterId);
      if (currentGeneration === generation.current) setSubmissionCompleted(true);
    } catch (err) {
      if (currentGeneration === generation.current) {
        setSubmissionError(err instanceof PdfApiError || err instanceof SigningOriginError ? err.code : 'network');
      }
    } finally {
      submissionLock.current = false;
      setSavingSubmission(false);
    }
  }, [submitterId, pdfApi]);

  useEffect(() => {
    if (!token) {
      setError('unknown_token');

      return;
    }

    let active = true;
    setDone(null);
    setSubmissionCompleted(false);
    setSubmissionError(null);
    setSession(null);
    setServerUrl(null);
    setError(null);

    resolveSigningOrigin(platformVaultDeps().storage, server)
      .then(async (origin) => ({ origin, payload: await new QesApi(origin, token).getSession() }))
      .then(({ origin, payload }) => {
        if (active) {
          setServerUrl(origin);
          setSession(payload);
          if (payload.state === 'completed') {
            setDone({ level: payload.level, digest: payload.document_digest });
            if (isPdfFlow) void finishSubmission();
          }
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof QesApiError || err instanceof SigningOriginError ? err.code : 'network');
        setErrorDetail(err instanceof Error ? err.message : null);
      });
    return () => { active = false; };
  }, [token, server, isPdfFlow, finishSubmission]);

  // Po návratu z wizardu S10 je chyba „chybí certifikát“ vyřešená nebo zastaralá —
  // obrazovka nabídne znovu „Podepsat“ (docs/17).
  useFocusEffect(
    useCallback(() => {
      setError((current) =>
        current === 'certificate_missing' || current === 'vault_decrypt_failed'
          || current === 'key_invalidated' || current === 'no_signer'
          ? null
          : current,
      );
      setErrorDetail(null);
    }, []),
  );

  // Po návratu ze share sheetu (back) musí být tlačítka zase použitelná, i kdyby
  // systémový chooser nedoručil výsledek (docs/17).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setBusy(false);
      }
    });

    return () => subscription.remove();
  }, []);

  // Zapamatovaná složka pro ukládání (Android SAF) — nabídne se příště.
  useEffect(() => {
    loadSaveFolder(platformVaultDeps().storage)
      .then(setFolder)
      .catch(() => setFolder(null));
  }, []);

  const sign = useCallback(async () => {
    if (!token || !serverUrl || signingLock.current) {
      return;
    }

    const currentGeneration = generation.current;
    signingLock.current = true;
    setSigning(true);
    setError(null);
    setErrorDetail(null);

    try {
      const result = await runSigningCeremony(
        { api: new QesApi(await resolveSigningOrigin(platformVaultDeps().storage, server), token), vault: platformVaultDeps(),
          confirmDocument: (pdf) => currentGeneration === generation.current
            ? confirmDocument(pdf) : Promise.resolve(false) },
        session?.level_required ?? 'ades',
      );

      if (currentGeneration !== generation.current) return;
      setDone({ level: result.level, digest: result.completed.document_digest });

      // Přímý podpis: dokončit submission v DocuSealu, aby vzniklo finální
      // PDF + auditní stránka ve složce „Direct signing“ (docs/15 § 5).
      if (isPdfFlow) await finishSubmission();
    } catch (err) {
      if (err instanceof SigningOriginError || err instanceof CeremonyError || err instanceof VaultError || err instanceof QesApiError) {
        setError(err.code);
      } else {
        setError('network');
      }

      setErrorDetail(err instanceof Error ? err.message : null);
    } finally {
      signingLock.current = false;
      setSigning(false);
    }
  }, [token, server, serverUrl, session, isPdfFlow, finishSubmission, confirmDocument]);

  // Finální PDF stáhneme nativně do cache; obě akce (uložit / sdílet) jdou z něj.
  const finalPdf = useCallback(async () => {
    if (!submitterId) {
      throw new PdfActionError('download_failed');
    }

    const url = await (await pdfApi()).documentUrl(submitterId);
    const name = `${(session?.document_name ?? 'document').replace(/\.pdf$/i, '')}-signed.pdf`;

    return { file: await downloadPdf(url, name), name };
  }, [submitterId, session, pdfApi]);

  const failAction = useCallback((err: unknown) => {
    if (err instanceof PdfActionError || err instanceof PdfApiError) {
      setActionError(ERROR_TEXT[err.code] ?? err.code);
    } else {
      setActionError(ERROR_TEXT.network);
    }

    setActionDetail(err instanceof Error ? err.message : null);
  }, []);

  // „Stáhnout“ = uložit do telefonu (výchozí Downloads, nebo zapamatovaná složka).
  const saveFinalPdf = useCallback(async (chooseFolder: boolean) => {
    if (busy) {
      return;
    }

    setBusy(true);
    setActionError(null);
    setActionDetail(null);
    setNotice(null);

    try {
      const { file, name } = await finalPdf();
      const result = await savePdf(file, name, { folder, chooseFolder });
      const storage = platformVaultDeps().storage;

      setSaved(result);
      setNotice(`Uloženo: ${result.label}`);

      if (result.folder) {
        if (result.folder.uri !== folder?.uri) {
          setFolder(result.folder);
          await rememberSaveFolder(storage, result.folder);
        }
      } else if (folder) {
        // Zapamatovaná složka přestala platit → zpět na výchozí Downloads.
        setFolder(null);
        await rememberSaveFolder(storage, null);
      }
    } catch (err) {
      if (!isPickerCancelled(err)) {
        failAction(err);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, finalPdf, failAction, folder]);

  // Otevření uloženého PDF v systémovém prohlížeči (Android).
  const openSavedPdf = useCallback(async () => {
    if (!saved) {
      return;
    }

    setActionError(null);
    setActionDetail(null);

    try {
      await openPdf(saved.uri);
    } catch (err) {
      failAction(err);
    }
  }, [saved, failAction]);

  // „Sdílet“ = systémový share sheet; tlačítko se během sheetu neblokuje.
  const shareFinalPdf = useCallback(async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setActionError(null);
    setActionDetail(null);
    setNotice(null);

    try {
      const { file } = await finalPdf();

      setBusy(false);
      await sharePdf(file);
    } catch (err) {
      failAction(err);
    } finally {
      setBusy(false);
    }
  }, [busy, finalPdf, failAction]);

  if (!session && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {done && isPdfFlow && !submissionCompleted ? (
        <>
          <Text style={styles.title}>Podpis je hotový, zbývá dokončit uložení</Text>
          <Text style={styles.muted}>Podpis se nebude opakovat. Dokončete uložení dokumentu do DocuSealu.</Text>
          {submissionError ? <Text style={styles.error}>{ERROR_TEXT[submissionError] ?? submissionError}</Text> : null}
          <PrimaryButton title={savingSubmission ? 'Dokončuji uložení…' : 'Dokončit uložení'} onPress={finishSubmission} disabled={savingSubmission} />
          <TextButton title="Zavřít" onPress={() => router.replace('/')} />
        </>
      ) : done ? (
        <>
          <Text style={styles.title}>Podepsáno ({done.level.toUpperCase()})</Text>
          <Text style={styles.muted}>
            {isPdfFlow
              ? 'PDF je podepsané a uložené v DocuSealu ve složce „Direct signing“. Stáhněte si ho nebo ho nasdílejte.'
              : 'Dokument byl podepsán. Můžete se vrátit do prohlížeče.'}
          </Text>
          <Text style={styles.hash}>{done.digest}</Text>
          {isPdfFlow ? (
            <>
              {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
              {actionDetail ? <Text style={styles.detail}>{actionDetail}</Text> : null}
              {notice ? <Text style={styles.detail}>{notice}</Text> : null}
              <PrimaryButton
                title={busy ? 'Stahuji…' : 'Stáhnout'}
                onPress={() => saveFinalPdf(false)}
                disabled={busy}
              />
              <SecondaryButton title="Sdílet" onPress={shareFinalPdf} disabled={busy} />
              {saved && Platform.OS === 'android' ? (
                <SecondaryButton title="Otevřít" onPress={openSavedPdf} />
              ) : null}
              {Platform.OS === 'android' ? (
                <TextButton
                  title="Uložit jinam…"
                  onPress={() => saveFinalPdf(true)}
                  disabled={busy}
                />
              ) : null}
              <TextButton title="Zavřít" onPress={() => router.replace('/')} />
            </>
          ) : (
            <PrimaryButton title="Zavřít" onPress={() => router.replace('/')} />
          )}
        </>
      ) : session ? (
        <>
          <Text style={styles.title}>{session.document_name ?? 'Dokument'}</Text>
          <Text style={styles.muted}>Podepisuje: {session.signer_name}</Text>
          <Text style={styles.label}>Úroveň: {levelLabel(session.level_required ?? 'ades')}</Text>
          {error ? <Text style={styles.error}>{ERROR_TEXT[error] ?? error}</Text> : null}
          {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}
          {reviewPdf ? (
            <>
              <Text style={styles.muted}>Otevřete PDF, zkontrolujte jeho obsah a potvrďte podpis.</Text>
              <SecondaryButton title={openingPdf ? 'Otevírám…' : 'Otevřít přesné PDF'} onPress={openReview} disabled={openingPdf} />
              <PrimaryButton title="Podepsat tento dokument" onPress={() => finishReview(true)} disabled={!reviewOpened || openingPdf} />
              <TextButton title="Zrušit podpis" onPress={() => finishReview(false)} />
            </>
          ) : needsSetup ? (
            <PrimaryButton title="Nastavit podepisování" onPress={() => router.push('/setup')} />
          ) : (
            <PrimaryButton
              title={signing ? 'Připravuji podpis…' : 'Zkontrolovat dokument'}
              onPress={sign}
              disabled={signing}
            />
          )}
          {!reviewPdf ? <TextButton title="Zrušit" onPress={() => router.replace('/')} /> : null}
        </>
      ) : (
        <>
          <Text style={styles.title}>Podpis</Text>
          <Text style={styles.error}>{ERROR_TEXT[error ?? 'unknown_token'] ?? error}</Text>
          {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}
          <TextButton title="Zavřít" onPress={() => router.replace('/')} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280' },
  hash: { fontFamily: 'monospace', fontSize: 11, color: '#374151' },
  error: { color: '#991b1b', fontSize: 14 },
  detail: { color: '#b45309', fontSize: 12 },
});
