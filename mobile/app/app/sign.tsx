// S4 Žádost o podpis (SPEC § 9.1): deep link → metadata → kontrola dokumentu
// → biometrie → podpis. Kontrola je před odemčením klíče a před POST /certificate.
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { resolveSigningOrigin, signingOrigin, SigningOriginError } from '../src/lib/signingOrigin';
import { resolveWorkflowOrigin, trustServer, type WorkflowOrigin } from '../src/lib/trustedServers';
import { QesApi, QesApiError } from '../src/lib/api';
import { runSigningCeremony, CeremonyError } from '../src/lib/ceremony';
import { certificateSummary, VaultError, type StoredCertificateInfo } from '../src/lib/crypto/vault';
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
  verifyFinalPdf,
  type SaveFolder,
  type SavedPdf,
} from '../src/lib/pdfShare';
import { documentDigest } from '../src/lib/preparedDocument';
import { appVersion, platformVaultDeps } from '../src/lib/platform';
import type { QesSessionPayload, QesValidationReport } from '../src/lib/types';
import { PrimaryButton, SecondaryButton, TextButton } from '../src/ui/buttons';

const ERROR_TEXT: Record<string, string> = {
  invalid_submission: 'Chybí údaj pro dokončení uložení dokumentu. Otevřete původní odkaz.',
  document_mismatch: 'Server připravil jiný dokument, než jste viděli. Podpis byl odmítnut. Vyžádejte nový odkaz.',
  verification_failed: 'Stažené PDF nelze potvrdit jako dokument, který server označil za podepsaný. Nestahujte ho a ověřte přes Domů → Ověřit PDF.',
  user_cancelled: 'Podpis byl zrušen.',
  pdf_viewer_unavailable: 'PDF se nepodařilo otevřít. Nainstalujte prohlížeč PDF a zkuste to znovu.',
  foreign_server: 'Odkaz vede na jiný server, než se očekávalo. Podpis byl odmítnut.',
  invalid_server: 'Odkaz obsahuje neplatnou adresu serveru.',
  missing_server: 'Odkaz neobsahuje adresu serveru. Vyžádejte nový odkaz.',
  expired_token: 'Platnost odkazu vypršela. Vyžádejte nový.',
  used_token: 'Odkaz už byl použit nebo podpis zrušen. Vyžádejte nový.',
  form_not_active: 'Dokument už není aktivní. Požádejte odesílatele o nový.',
  unknown_token: 'Neplatný odkaz. Vyžádejte nový.',
  network: 'Chyba připojení. Zkuste to znovu.',
  certificate_missing: 'Certifikát chybí nebo vypršel. Importujte nový.',
  certificate_expired: 'Platnost certifikátu vypršela. Importujte nový.',
  biometry_rejected: 'Podpis se neprovede bez biometrie.',
  biometry_unavailable: 'V telefonu není nastavená biometrie (otisk/obličej).',
  key_invalidated: 'Klíč byl zneplatněn změnou biometrie. Importujte klíč znovu.',
  vault_unavailable: 'Úložiště klíče není dostupné.',
  vault_decrypt_failed: 'Klíč se nepodařilo odemknout.',
  qes_required_qscd: 'Vyžaduje se kvalifikovaný certifikát (QES).',
  no_signer: 'Nejdřív nastavte podepisování (klíč nebo čtečku).',
  needs_qes_key: 'Pro QES je potřeba čtečka s eObčankou.',
  needs_reader: 'Připojte čtečku a zkuste to znovu.',
  reader_not_found: 'Čtečka nenalezena. Připojte ji a zkuste to znovu.',
  reader_disconnected: 'Čtečka se odpojila. Připojte ji a zkuste to znovu.',
  reader_error: 'Chyba čtečky. Zkuste to znovu.',
  pin_blocked: 'Kód je zablokovaný. Odblokujte ho v aplikaci eObčanka.',
  applet_blocked: 'Čip je zablokovaný. Odblokujte ho v aplikaci eObčanka.',
  no_qualified_certificate: 'Na čipu není kvalifikovaný certifikát.',
  level_mismatch: 'Vybraný certifikát neodpovídá typu podpisu.',
  not_qualified: 'Certifikát není kvalifikovaný.',
  not_trusted: 'Certifikát není pro tento server důvěryhodný. Obraťte se na správce.',
  revoked: 'Certifikát byl revokován.',
  unsupported_certificate: 'Certifikát nepodporuje podepisování.',
  unsupported_key: 'Nepodporovaný typ nebo velikost klíče.',
  invalid_certificate: 'Certifikát se nepodařilo načíst.',
  signature_invalid: 'Podpis se nepodařilo ověřit. Zkuste to znovu.',
  signature_size_exceeded: 'Podpis se nevešel do připraveného místa. Zkuste to znovu.',
  tsa_unavailable: 'Časové razítko není dostupné. Zkuste to znovu.',
  ltv_unavailable: 'Revokační data certifikátu nejsou dostupná. Obraťte se na správce.',
  validation_failed: 'Podpis se nepodařilo ověřit. Zkuste to znovu.',
  incomplete_coverage: 'Podpis nepokrývá celý dokument. Zkuste to znovu.',
  seal_failed: 'Pečeť dokumentu se nepodařilo vytvořit. Zkuste to znovu.',
  tsa_trust_not_configured: 'Server nemá nastavené důvěryhodné časové razítko. Kontaktujte podporu.',
  document_set_changed: 'Sada dokumentů se změnila. Začněte znovu.',
  values_changed: 'Pole dokumentu se změnila. Začněte znovu.',
  signing_context_mismatch: 'Podpisové atributy se změnily. Začněte znovu.',
  completion_failed: 'Dokončení dokumentu se nepodařilo. Zkuste to znovu.',
  server_pending: 'Server stále dokončuje podpis. Zkuste to znovu.',
  unsupported_protocol: 'Server používá novější verzi protokolu. Aktualizujte aplikaci.',
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
  expired: 'Platnost odkazu vypršela. Vyžádejte nový.',
  failed: 'Podpis se nepodařilo dokončit. Zkuste to znovu.',
  cancelled: 'Podpis byl zrušen.',
};

interface DoneState {
  level: string;
  digest: string;
  verified: boolean | null;
  validation?: QesValidationReport;
  sealState?: string;
  docTimestampState?: string;
  finalPdfSha256?: string;
}

function validationText(report: QesValidationReport): string {
  if (!report.ok || !report.intact) {
    return 'Ověření: podpis je neplatný.';
  }

  const parts = ['podpis je v pořádku'];
  parts.push(report.trusted ? 'certifikát je důvěryhodný' : 'certifikát není důvěryhodný');
  if (report.coverage === 'full') {
    parts.push('pokrývá celý dokument');
  }

  return `Ověření: ${parts.join(', ')}.`;
}

function leaveSignScreen(): void {
  if (typeof router.canGoBack === 'function' && router.canGoBack()) {
    router.back();

    return;
  }

  router.replace('/');
}

export default function SignScreen() {
  const { token, server, flow } = useLocalSearchParams<{
    token?: string;
    server?: string;
    flow?: string;
  }>();
  const [session, setSession] = useState<QesSessionPayload | null>(null);
  const [certificate, setCertificate] = useState<StoredCertificateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
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
  const [reviewDigest, setReviewDigest] = useState<string | null>(null);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [openingPdf, setOpeningPdf] = useState(false);
  const signingLock = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    setReviewPdf(null);
    setReviewDigest(null);
    setReviewOpened(false);

    return () => {
      generation.current += 1;
    };
  }, [token, server]);

  const isPdfFlow = flow === 'pdf';
  // Bez certifikátu nebo podepisujícího vede akce do wizardu S10 (docs/17).
  const needsSetup = error ? needsSetupError(error) : false;
  const terminal = error === 'document_mismatch' || error === 'used_token'
    || error === 'expired_token' || error === 'unknown_token'
    || error === 'missing_server' || error === 'failed' || error === 'cancelled'
    || error === 'values_changed' || error === 'document_set_changed'
    || error === 'signing_context_mismatch' || error === 'ltv_unavailable';
  const pending = error === 'server_pending';
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // Klient pro stažení finálního PDF (docs/15 § 5) — jen přímý podpis PDF.
  const pdfApi = useCallback(async () => {
    if (!isPdfFlow) throw new SigningOriginError('invalid_server');

    const settings = await loadPdfApiSettings(platformVaultDeps().storage);

    return new PdfApi(await resolveSigningOrigin(platformVaultDeps().storage, server), settings?.apiToken ?? '');
  }, [isPdfFlow, server]);

  const qesApi = useCallback((origin: string) => new QesApi(origin, token ?? ''), [token]);

  const finishSubmission = useCallback(async (origin: string, submitterId = session?.submitter_id) => {
    if (submissionLock.current) return;
    if (!submitterId) {
      setSubmissionError('invalid_submission');
      return;
    }
    const currentGeneration = generation.current;
    submissionLock.current = true;
    setSavingSubmission(true);
    setSubmissionError(null);
    try {
      await qesApi(origin).completeSubmission();
      if (currentGeneration === generation.current) setSubmissionCompleted(true);
    } catch (err) {
      if (currentGeneration === generation.current) {
        setSubmissionError(err instanceof QesApiError || err instanceof SigningOriginError ? err.code : 'network');
      }
    } finally {
      submissionLock.current = false;
      setSavingSubmission(false);
    }
  }, [session?.submitter_id, qesApi]);

  const finishSubmissionRef = useRef(finishSubmission);
  useEffect(() => {
    finishSubmissionRef.current = finishSubmission;
  }, [finishSubmission]);

  const loadSession = useCallback(async (origin: string) => {
    const currentGeneration = generation.current;
    const payload = await new QesApi(origin, token ?? '').getSession();

    if (currentGeneration !== generation.current) return;

    // Server v payloadu nesmí tvrdit jiný origin, než je ten z odkazu;
    // jinak by důvěryhodný server mohl token přesměrovat jinam.
    if (payload.server_url) {
      if (signingOrigin(payload.server_url) !== origin) {
        throw new SigningOriginError('foreign_server');
      }
    }

    setServerUrl(origin);
    setPendingOrigin(null);
    setSession(payload);
    if (payload.state === 'completed') {
      setDone({
        level: payload.level,
        digest: payload.document_digest,
        verified: null,
        validation: payload.validation,
        sealState: payload.seal_state,
        docTimestampState: payload.doc_timestamp_state,
        finalPdfSha256: payload.final_pdf_sha256,
      });
      if (isPdfFlow) void finishSubmissionRef.current(origin, payload.submitter_id);
    }
  }, [token, isPdfFlow]);

  useEffect(() => {
    if (!token) {
      setError('unknown_token');

      return;
    }

    const currentGeneration = generation.current;
    setDone(null);
    setSubmissionCompleted(false);
    setSubmissionError(null);
    setSession(null);
    setServerUrl(null);
    setPendingOrigin(null);
    setTrusting(false);
    setError(null);
    setReviewPdf(null);
    setReviewDigest(null);
    setReviewOpened(false);

    (async () => {
      try {
        const resolved: WorkflowOrigin = isPdfFlow
          ? { origin: await resolveSigningOrigin(platformVaultDeps().storage, server), trusted: true }
          : await resolveWorkflowOrigin(platformVaultDeps().storage, server);

        if (currentGeneration !== generation.current) return;

        if (!resolved.trusted) {
          setPendingOrigin(resolved.origin);

          return;
        }

        await loadSession(resolved.origin);
      } catch (err) {
        if (currentGeneration !== generation.current) return;
        setError(err instanceof QesApiError || err instanceof SigningOriginError ? err.code : 'network');
        setErrorDetail(err instanceof Error ? err.message : null);
      }
    })();

    return () => { generation.current += 1; };
  }, [token, server, isPdfFlow, loadSession]);

  const confirmTrust = useCallback(async () => {
    if (!pendingOrigin || trusting) return;

    const origin = pendingOrigin;
    setTrusting(true);
    setError(null);
    setErrorDetail(null);

    try {
      await trustServer(platformVaultDeps().dataStorage, origin);
      setPendingOrigin(null);
      await loadSession(origin);
    } catch (err) {
      setPendingOrigin(null);
      setError(err instanceof QesApiError || err instanceof SigningOriginError ? err.code : 'network');
      setErrorDetail(err instanceof Error ? err.message : null);
    } finally {
      setTrusting(false);
    }
  }, [pendingOrigin, trusting, loadSession]);

  // Certifikát zobrazíme už před odemčením klíče (info je v trezoru nešifrované).
  useEffect(() => {
    certificateSummary(platformVaultDeps())
      .then(setCertificate)
      .catch(() => setCertificate(null));
  }, []);

  // Po návratu z wizardu S10 je chyba „chybí certifikát“ vyřešená nebo zastaralá.
  useFocusEffect(
    useCallback(() => {
      setError((current) => current && needsSetupError(current) ? null : current);
      setErrorDetail(null);
    }, []),
  );

  // Po návratu ze share sheetu (back) musí být tlačítka zase použitelná.
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

  const openReview = useCallback(async (pdf = reviewPdf) => {
    if (!pdf || openingPdf) return;

    setOpeningPdf(true);
    try {
      await previewPdf(pdf);
      setReviewOpened(true);
      setError(null);
    } catch {
      setError('pdf_viewer_unavailable');
    } finally {
      setOpeningPdf(false);
    }
  }, [reviewPdf, openingPdf]);

  // Kontrola dokumentu: jen GET /document, žádný klíč, žádný POST /certificate.
  const startReview = useCallback(async () => {
    if (!token || !serverUrl || loadingDocument) return;

    setLoadingDocument(true);
    setError(null);
    setErrorDetail(null);
    setReviewOpened(false);

    try {
      const pdf = await qesApi(serverUrl).getDocument();
      let digest: string;

      try {
        ({ digest } = documentDigest(pdf));
      } catch {
        setError('document_mismatch');
        setErrorDetail('Server nevrátil platný nepodepsaný TBS.');
        return;
      }

      setReviewPdf(pdf);
      setReviewDigest(digest);
      await openReview(pdf);
    } catch (err) {
      if (err instanceof QesApiError || err instanceof SigningOriginError) {
        setError(err.code);
      } else {
        setError('network');
      }
      setErrorDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoadingDocument(false);
    }
  }, [token, serverUrl, loadingDocument, qesApi, openReview]);

  const cancelReview = useCallback(async () => {
    if (token && serverUrl) {
      await qesApi(serverUrl).postAbort('user_cancelled').catch(() => {});
    }
    setReviewPdf(null);
    setReviewDigest(null);
    setReviewOpened(false);
    leaveSignScreen();
  }, [token, serverUrl, qesApi]);

  const sign = useCallback(async () => {
    if (!token || !serverUrl || !reviewPdf || signingLock.current) {
      return;
    }

    const currentGeneration = generation.current;
    signingLock.current = true;
    setSigning(true);
    setError(null);
    setErrorDetail(null);

    try {
      const result = await runSigningCeremony(
        {
          api: qesApi(serverUrl),
          vault: platformVaultDeps(),
          reviewedDocument: reviewPdf,
          reviewedDigest: reviewDigest ?? undefined,
          appVersion: appVersion(),
        },
        session?.level_required ?? 'ades',
      );

      if (currentGeneration !== generation.current) return;

      const verified = result.documentDigest === result.completed.document_digest;
      setDone({
        level: result.level,
        digest: result.completed.document_digest,
        verified,
        validation: result.completed.validation,
        sealState: result.completed.seal_state,
        docTimestampState: result.completed.doc_timestamp_state,
        finalPdfSha256: result.completed.final_pdf_sha256,
      });

      // Přímý podpis: dokončit submission jen když server vrátil stejný digest.
      if (isPdfFlow && verified) await finishSubmission(serverUrl);
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
  }, [token, server, serverUrl, session, reviewPdf, reviewDigest, isPdfFlow, finishSubmission]);

  // Finální PDF stáhneme nativně do cache; obě akce (uložit / sdílet) jdou z něj.
  const finalPdf = useCallback(async () => {
    if (!session?.submitter_id) {
      throw new PdfActionError('download_failed');
    }

    const url = await (await pdfApi()).documentUrl(session.submitter_id);
    const name = `${(session?.document_name ?? 'document').replace(/\.pdf$/i, '')}-signed.pdf`;
    const file = await downloadPdf(url, name);

    // Konzistenční kontrola: otisk, který server označil za podepsaný, a reviewed
    // TBS beze změny. Podpis neověřujeme — to dělá server (`Ověřit PDF`).
    if (!done?.finalPdfSha256) {
      throw new PdfActionError('verification_failed');
    }

    await verifyFinalPdf(file, {
      finalSha256: done.finalPdfSha256,
      reviewedDocument: reviewPdf,
    });

    return { file, name };
  }, [session, pdfApi, done?.finalPdfSha256, reviewPdf]);

  // Po 202/embedded appka polluje session; podpis se už neopakuje.
  const checkCompletion = useCallback(async () => {
    if (!token || !serverUrl) return;

    setBusy(true);
    setError(null);
    setErrorDetail(null);

    try {
      const payload = await qesApi(serverUrl).getSession();

      if (payload.state === 'completed') {
        const verified = reviewDigest ? payload.document_digest === reviewDigest : null;

        setDone({
          level: payload.level,
          digest: payload.document_digest,
          verified,
          validation: payload.validation,
          sealState: payload.seal_state,
          docTimestampState: payload.doc_timestamp_state,
          finalPdfSha256: payload.final_pdf_sha256,
        });

        if (isPdfFlow && verified !== false) void finishSubmission(serverUrl, payload.submitter_id);
      } else {
        setError('server_pending');
      }
    } catch (err) {
      setError(err instanceof QesApiError || err instanceof SigningOriginError ? err.code : 'network');
      setErrorDetail(err instanceof Error ? err.message : null);
    } finally {
      setBusy(false);
    }
  }, [token, serverUrl, qesApi, reviewDigest, isPdfFlow, finishSubmission]);

  const failAction = useCallback((err: unknown) => {
    if (err instanceof PdfActionError || err instanceof PdfApiError || err instanceof SigningOriginError) {
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

  if (pendingOrigin) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Neznámý server</Text>
        <Text style={styles.muted}>Podpisový odkaz vede na server, který jste ještě nepoužili:</Text>
        <Text style={styles.origin}>{pendingOrigin}</Text>
        <Text style={styles.muted}>
          Token z odkazu se odešle až po potvrzení. Podepíše se jen dokument, který si zobrazíte a potvrdíte.
        </Text>
        <PrimaryButton
          title={trusting ? 'Ukládám…' : 'Důvěřovat a pokračovat'}
          onPress={confirmTrust}
          disabled={trusting}
        />
        <TextButton title="Zrušit" onPress={leaveSignScreen} />
      </ScrollView>
    );
  }

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
          <Text style={styles.title}>
            {done.verified === false ? 'Podpis je hotový, ale dokument nesouhlasí' : 'Podpis je hotový, zbývá dokončit uložení'}
          </Text>
          {done.verified === false ? <Text style={styles.error}>{ERROR_TEXT.document_mismatch}</Text> : null}
          <Text style={styles.muted}>
            {done.verified === false
              ? 'Server vrátil jiný dokument, než jste viděli. Nestahujte ho a kontaktujte podporu.'
              : 'Podpis se nebude opakovat. Dokončete uložení dokumentu do DocuSealu.'}
          </Text>
          {submissionError ? <Text style={styles.error}>{ERROR_TEXT[submissionError] ?? submissionError}</Text> : null}
          {done.verified !== false && submissionError !== 'form_not_active' ? (
            <PrimaryButton
              title={savingSubmission ? 'Dokončuji uložení…' : 'Dokončit uložení'}
              onPress={() => { if (serverUrl) void finishSubmission(serverUrl); }}
              disabled={savingSubmission}
            />
          ) : null}
          <TextButton title="Zavřít" onPress={leaveSignScreen} />
        </>
      ) : done ? (
        <>
          <Text style={styles.title}>Podepsáno ({done.level?.toUpperCase() ?? 'PDF'})</Text>
          <Text style={styles.muted}>
            {isPdfFlow
              ? 'PDF je podepsané a uložené v DocuSealu ve složce „Direct signing“. Stáhněte si ho nebo ho nasdílejte.'
              : 'Dokument byl podepsán. Můžete se vrátit do prohlížeče.'}
          </Text>
          {done.verified === false ? <Text style={styles.error}>{ERROR_TEXT.document_mismatch}</Text> : null}
          {done.verified === null ? (
            <Text style={styles.muted}>
              Dokument byl dokončen dříve. Ověřte ho přes Domů → Ověřit PDF.
            </Text>
          ) : null}
          {done.validation ? <Text style={styles.muted}>{validationText(done.validation)}</Text> : null}
          {done.sealState || done.docTimestampState ? (
            <Text style={styles.muted}>
              Pečeť: {done.sealState ?? '—'} · DocTS: {done.docTimestampState ?? '—'}
            </Text>
          ) : null}
          <Text style={styles.hash}>Otisk dokumentu: {done.digest}</Text>
          {done.finalPdfSha256 ? <Text style={styles.hash}>Finální PDF: {done.finalPdfSha256}</Text> : null}
          {isPdfFlow && done.verified !== false ? (
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
            </>
          ) : null}
          <TextButton title="Zavřít" onPress={leaveSignScreen} />
        </>
      ) : session ? (
        <>
          <Text style={styles.title}>{session.document_name ?? 'Dokument'}</Text>
          <Text style={styles.muted}>Podepisuje: {session.signer_name}</Text>
          {serverUrl ? <Text style={styles.label}>Server: {serverUrl}</Text> : null}

          <Text style={styles.label}>Úroveň: {levelLabel(session.level_required ?? 'ades')}</Text>
          {certificate ? (
            <>
              <Text style={styles.label}>Certifikát: {certificate.subject}</Text>
              <Text style={styles.muted}>{certificate.issuer}</Text>
              <Text style={styles.muted}>
                Platnost do {new Date(certificate.notAfter).toLocaleDateString('cs-CZ')}
              </Text>
            </>
          ) : null}
          {session.expires_at && !reviewPdf ? (
            <Text style={styles.muted}>
              Odkaz platí do {new Date(session.expires_at).toLocaleString('cs-CZ')}.
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{ERROR_TEXT[error] ?? error}</Text> : null}
          {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}
          {reviewPdf ? (
            <>
              <Text style={styles.muted}>Zkontrolujte dokument a potvrďte podpis.</Text>
              {reviewDigest ? <Text style={styles.hash}>Otisk dokumentu: {reviewDigest}</Text> : null}
              <SecondaryButton
                title={openingPdf ? 'Otevírám…' : 'Otevřít dokument'}
                onPress={() => openReview()}
                disabled={openingPdf}
              />
              {pending ? (
                <PrimaryButton
                  title={busy ? 'Zjišťuji…' : 'Zkontrolovat znovu'}
                  onPress={checkCompletion}
                  disabled={busy}
                />
              ) : terminal ? (
                <PrimaryButton title="Zavřít" onPress={leaveSignScreen} />
              ) : needsSetup ? (
                <PrimaryButton title="Nastavit podepisování" onPress={() => router.push('/setup')} />
              ) : (
                <PrimaryButton
                  title={signing ? 'Připravuji podpis…' : 'Podepsat dokument'}
                  onPress={sign}
                  disabled={!reviewOpened || signing}
                />
              )}
              {!terminal && !pending ? <TextButton title="Zrušit" onPress={cancelReview} /> : null}
            </>
          ) : terminal ? (
            <PrimaryButton title="Zavřít" onPress={leaveSignScreen} />
          ) : (
            <PrimaryButton
              title={loadingDocument ? 'Načítám dokument…' : 'Zobrazit dokument'}
              onPress={startReview}
              disabled={loadingDocument}
            />
          )}
          {!reviewPdf && !terminal ? <TextButton title="Zrušit" onPress={leaveSignScreen} /> : null}
        </>
      ) : (
        <>
          <Text style={styles.title}>Podpis</Text>
          <Text style={styles.error}>{ERROR_TEXT[error ?? 'unknown_token'] ?? error}</Text>
          {errorDetail ? <Text style={styles.detail}>{errorDetail}</Text> : null}
          <TextButton title="Zavřít" onPress={leaveSignScreen} />
        </>
      )}
    </ScrollView>
  );
}

function needsSetupError(code: string): boolean {
  return code === 'certificate_missing' || code === 'vault_decrypt_failed'
    || code === 'key_invalidated' || code === 'no_signer' || code === 'needs_reader'
    || code === 'needs_qes_key' || code === 'certificate_expired'
    || code === 'not_trusted' || code === 'revoked' || code === 'unsupported_certificate'
    || code === 'qes_required_qscd' || code === 'level_mismatch' || code === 'not_qualified'
    || code === 'unsupported_key' || code === 'invalid_certificate';
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 24, gap: 10, backgroundColor: '#faf7f5', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  muted: { fontSize: 14, color: '#6b7280' },
  label: { fontSize: 13, color: '#6b7280' },
  hash: { fontFamily: 'monospace', fontSize: 11, color: '#374151' },
  origin: { fontFamily: 'monospace', fontSize: 14, color: '#111', paddingVertical: 4 },
  error: { color: '#991b1b', fontSize: 14 },
  detail: { color: '#b45309', fontSize: 12 },
});
