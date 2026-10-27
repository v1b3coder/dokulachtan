// Obřad podpisu v appce (SPEC § 9.3): GET metadata → odemčení vaultu biometrií
// → POST certificate → podepsané atributy → POST complete. Klíč zůstává v zařízení.
//
// Kontrola dokumentu je už hotová v `sign.tsx` (GET /document před certifikátem);
// tady se ověřuje, že `data_to_sign` kryje přesně reviewed dokument, a teprve
// potom se odemyká klíč a podepisuje.
import {
  certificateIdentityFromPem,
  verifyPreparedDocument,
  type CertificateIdentity,
  type PreparedDocument,
} from './preparedDocument';
import { Platform } from 'react-native';

import { certificateMatchesLevel, selectSigner, type SignerConfiguration } from './signer';
import { signSignedAttrs, toBase64, type HashAlgorithm } from './crypto/softwareSigner';
import { unlockCertificate, type VaultDeps } from './crypto/vault';
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
  reviewedDocument: Uint8Array;
  reviewedDigest?: string;
  cardSigner?: CardSigner;
  configuration?: SignerConfiguration;
  app?: QesAppMetadata;
}

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

export async function runSigningCeremony(
  deps: CeremonyDeps,
  levelRequired: QesLevel,
): Promise<CeremonyResult> {
  const session = await deps.api.getSession();
  if (session.state === 'completed') {
    return {
      completed: session,
      level: session.level,
      keyLocation: null,
      biometricPrompts: 0,
      documentDigest: session.document_digest,
    };
  }
  const required = session.level_required ?? levelRequired;
  const configuration = deps.configuration ?? { hasKey: true, hasReader: false, readerReady: false };
  const selection = selectSigner(required, configuration);

  if (selection.kind === 'wizard') {
    throw new CeremonyError(selection.reason ?? 'no_signer');
  }

  const app: QesAppMetadata = deps.app ?? {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    version: '1.0.0',
    reader: null,
    container_ref: null,
  };

  if (selection.kind === 'card') {
    const cardSigner = deps.cardSigner ?? createCardSigner(false);

    await cardSigner.initializeSession();

    try {
      const card = await cardSigner.getCertificate('');
      const containers = await cardSigner.listContainers();
      const chain = card.chainPems.map((pem) => toBase64(pemCertificateToDer(pem)));
      const identity = certificateIdentityFromPem(card.certificatePem);

      if (!certificateMatchesLevel(required, (identity.level ?? 'none') as QesLevel)) {
        throw new CeremonyError(required === 'qes' ? 'qes_required_qscd' : 'level_mismatch');
      }

      return await completeWithCertificate(deps, card.certificatePem, chain, {
        ...app,
        reader: 'moi-sdk',
        container_ref: containers[0]?.id ?? null,
      }, session.hash_algorithm, identity, (dataToSign) => cardSigner.signData('', dataToSign));
    } catch (error) {
      if (error instanceof CardSignerError) throw new CeremonyError(error.code);
      throw error;
    } finally {
      await cardSigner.finalizeSession();
    }
  }

  const material = await unlockCertificate(deps.vault, 'sign');

  if (!certificateMatchesLevel(required, material.info.level)) {
    throw new CeremonyError('qes_required_qscd');
  }

  const chain = material.chainPems.map((pem) => toBase64(pemCertificateToDer(pem)));
  const identity: CertificateIdentity = {
    serial: material.info.serial,
    notBefore: material.info.notBefore,
    notAfter: material.info.notAfter,
    level: material.info.level,
    qcStatements: material.info.qcStatements,
    keyType: material.info.keyType,
    keySize: material.info.keySize,
  };

  return completeWithCertificate(deps, material.certificatePem, chain, app, session.hash_algorithm, identity, (dataToSign) =>
    Promise.resolve(signSignedAttrs(material.privateKeyPem, dataToSign, session.hash_algorithm as HashAlgorithm)),
  );
}

async function completeWithCertificate(
  deps: CeremonyDeps,
  certificatePem: string,
  chain: string[],
  app: QesAppMetadata,
  hashAlgorithm: string,
  identity: CertificateIdentity,
  sign: (dataToSign: Uint8Array) => Promise<Uint8Array>,
): Promise<CeremonyResult> {
  const certificateDer = pemCertificateToDer(certificatePem);
  const prepared = await deps.api.postCertificate({
    certificate: toBase64(certificateDer),
    chain,
    key_location: app.reader ? 'card' : 'phone_keystore',
    app,
  });

  let verified: PreparedDocument;
  try {
    verified = verifyPreparedDocument(
      deps.reviewedDocument, prepared, hashAlgorithm, certificateDer, identity,
    );
    if (deps.reviewedDigest && verified.digest !== deps.reviewedDigest) {
      throw new Error('reviewed digest');
    }
  } catch {
    await deps.api.postAbort('document_mismatch').catch(() => {});
    throw new CeremonyError('document_mismatch');
  }

  const signature = await sign(verified.dataToSign);

  const response: QesCompleteResponse = await deps.api.postComplete(toBase64(signature));
  const completed = response.state === 'embedded'
    ? await pollCompletion(deps.api, response)
    : response;

  return {
    completed,
    level: completed.level,
    keyLocation: app.reader ? 'card' : 'phone_keystore',
    biometricPrompts: 1,
    documentDigest: verified.digest,
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
