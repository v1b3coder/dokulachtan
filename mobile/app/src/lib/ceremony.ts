// Obřad podpisu v appce (SPEC § 9.3): cert → POST certificate → GET /document
// → kontrola → biometrie → podpis → POST complete. Klíč zůstává v zařízení.
//
// Certifikát je veřejný, takže se posílá před kontrolou: server podle něj
// postaví TBS s pečetí (CN + e-mail z certu). Kontrola i odemčení klíče
// zůstávají až po sobě.
import {
  certificateIdentityFromPem,
  verifyPreparedDocument,
  type CertificateIdentity,
  type PreparedDocument,
} from './preparedDocument';
import { Platform } from 'react-native';

import { certificateMatchesLevel, selectSigner, type SignerConfiguration } from './signer';
import { signSignedAttrs, toBase64, type HashAlgorithm } from './crypto/softwareSigner';
import { certificateSummary, unlockCertificate, type VaultDeps } from './crypto/vault';
import { CardSignerError, createCardSigner, type CardSigner } from './cardSigner';
import type {
  QesAppMetadata,
  QesCompletedPayload,
  QesCompleteResponse,
  QesEmbeddedPayload,
  QesLevel,
  SessionSource,
} from './types';

export interface CeremonyDeps {
  api: SessionSource;
  vault: VaultDeps;
  cardSigner?: CardSigner;
  configuration: SignerConfiguration;
  // Reálná verze appky z `app.json` (`expo-constants`); e2e harness ji neposílá.
  appVersion?: string;
  app?: QesAppMetadata;
}

export interface PreparedCeremony {
  document: Uint8Array;
  prepared: PreparedDocument;
  identity: CertificateIdentity;
  keyLocation: 'phone_keystore' | 'card';
  sign: () => Promise<Uint8Array>;
  finalize: () => Promise<void>;
}

export type CeremonyPreparation =
  | { kind: 'prepared'; ceremony: PreparedCeremony }
  | { kind: 'completed'; completed: QesCompletedPayload };

export interface CeremonyResult {
  completed: QesCompletedPayload;
  level: QesLevel;
  keyLocation: 'phone_keystore' | 'card' | null;
  biometricPrompts: number;
  documentDigest: string;
}

export class CeremonyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

export async function prepareCeremony(
  deps: CeremonyDeps,
  levelRequired: QesLevel,
): Promise<CeremonyPreparation> {
  const session = await deps.api.getSession();
  if (session.state === 'completed') {
    return { kind: 'completed', completed: session };
  }
  const required = session.level_required ?? levelRequired;
  const selection = selectSigner(required, deps.configuration);

  if (selection.kind === 'wizard') {
    throw new CeremonyError(selection.reason ?? 'no_signer');
  }

  // Server ukládá jen platformu a reálnou verzi (SPEC § 5.4); čtečku už nese
  // `key_location` a id containeru je lokální záležitost zařízení.
  const app: QesAppMetadata = deps.app ?? {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    ...(deps.appVersion ? { version: deps.appVersion } : {}),
  };

  if (selection.kind === 'card') {
    const cardSigner = deps.cardSigner ?? createCardSigner(false);

    await cardSigner.initializeSession();

    try {
      const card = await cardSigner.getCertificate('');
      const chain = card.chainPems.map((pem) => toBase64(pemCertificateToDer(pem)));
      const identity = certificateIdentityFromPem(card.certificatePem);

      if (!certificateMatchesLevel(required, (identity.level ?? 'none') as QesLevel)) {
        throw new CeremonyError(required === 'qes' ? 'qes_required_qscd' : 'level_mismatch');
      }

      const prepared = await prepareWithCertificate(
        deps, card.certificatePem, chain, 'card', app, session.hash_algorithm, identity,
      );

      return {
        kind: 'prepared',
        ceremony: {
          ...prepared,
          identity,
          keyLocation: 'card',
          sign: () => cardSigner.signData('', prepared.prepared.dataToSign),
          finalize: () => cardSigner.finalizeSession(),
        },
      };
    } catch (error) {
      await cardSigner.finalizeSession();
      if (error instanceof CardSignerError) throw new CeremonyError(error.code);
      throw error;
    }
  }

  const info = await certificateSummary(deps.vault);

  // Starý trezor bez veřejného certu (před zavedením `certificatePem`) nejde
  // použít: cert se posílá před odemčením klíče. Řeší se re-importem.
  if (!info?.certificatePem) {
    throw new CeremonyError('certificate_missing');
  }

  if (!certificateMatchesLevel(required, info.level)) {
    throw new CeremonyError('qes_required_qscd');
  }

  const chain = info.chainPems.map((pem) => toBase64(pemCertificateToDer(pem)));
  const identity: CertificateIdentity = {
    serial: info.serial,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
    level: info.level,
    qcStatements: info.qcStatements,
    keyType: info.keyType,
    keySize: info.keySize,
  };
  const prepared = await prepareWithCertificate(
    deps, info.certificatePem, chain, 'phone_keystore', app, session.hash_algorithm, identity,
  );

  return {
    kind: 'prepared',
    ceremony: {
      ...prepared,
      identity,
      keyLocation: 'phone_keystore',
      sign: async () => {
        const material = await unlockCertificate(deps.vault, 'sign');
        try {
          return await signSignedAttrs(
            material.privateKeyPem, prepared.prepared.dataToSign, session.hash_algorithm as HashAlgorithm,
          );
        } finally {
          // SPEC § 9.3 bod 8: klíč se po podpisu zahodí. JS string nejde vymazat,
          // ale referenci pustíme hned, místo aby žila do konce obřadu (#23.3).
          material.privateKeyPem = '';
        }
      },
      finalize: async () => undefined,
    },
  };
}

async function prepareWithCertificate(
  deps: CeremonyDeps,
  certificatePem: string,
  chain: string[],
  keyLocation: 'card' | 'phone_keystore',
  app: QesAppMetadata,
  hashAlgorithm: string,
  identity: CertificateIdentity,
): Promise<{ document: Uint8Array; prepared: PreparedDocument }> {
  const certificateDer = pemCertificateToDer(certificatePem);
  const response = await deps.api.postCertificate({
    certificate: toBase64(certificateDer),
    chain,
    key_location: keyLocation,
    app,
  });
  const document = await deps.api.getDocument();

  try {
    return {
      document,
      prepared: verifyPreparedDocument(document, response, hashAlgorithm, certificateDer, identity),
    };
  } catch {
    await deps.api.postAbort('document_mismatch').catch(() => {});
    throw new CeremonyError('document_mismatch');
  }
}

export async function signCeremony(
  api: SessionSource,
  ceremony: PreparedCeremony,
): Promise<CeremonyResult> {
  const signature = await ceremony.sign();
  const response: QesCompleteResponse = await api.postComplete(toBase64(signature));
  const completed = response.state === 'embedded'
    ? await pollCompletion(api, response)
    : response;

  return {
    completed,
    level: completed.level,
    keyLocation: ceremony.keyLocation,
    biometricPrompts: 1,
    documentDigest: ceremony.prepared.digest,
  };
}

async function pollCompletion(
  api: SessionSource,
  first: QesEmbeddedPayload,
): Promise<QesCompletedPayload> {
  const started = Date.now();
  let response: QesCompleteResponse = first;

  while (response.state === 'embedded') {
    if (Date.now() - started > POLL_TIMEOUT_MS) throw new CeremonyError('server_pending');
    await sleep(response.poll_after_ms ?? POLL_INTERVAL_MS);
    const session = await api.getSession();
    if (session.state === 'completed') return session;
    if (session.state === 'failed' || session.state === 'expired') {
      throw new CeremonyError(session.state);
    }
  }

  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pemCertificateToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');

  return fromBase64(base64);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
