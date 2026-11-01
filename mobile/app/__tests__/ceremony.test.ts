import { createVerify } from 'node:crypto';
import {
  prepareCeremony,
  signCeremony,
  type CeremonyDeps,
  type PreparedCeremony,
} from '../src/lib/ceremony';
import { certificateSummary, unlockCertificate, type VaultDeps } from '../src/lib/crypto/vault';
import { QesApiError } from '../src/lib/api';
import { parseP12 } from '../src/lib/crypto/p12';
import { TEST_P12_BASE64, TEST_P12_PASSWORD } from '../src/lib/testCertificate';
import { preparedPdf, signedAttrs } from './helpers/preparedPdf';

jest.mock('../src/lib/crypto/vault', () => ({
  certificateSummary: jest.fn(),
  unlockCertificate: jest.fn(),
}));
const summary = jest.mocked(certificateSummary);
const unlock = jest.mocked(unlockCertificate);
const material = parseP12(Uint8Array.from(atob(TEST_P12_BASE64), (c) => c.charCodeAt(0)), TEST_P12_PASSWORD);
const publicInfo = { ...material, certificatePem: material.certificatePem, chainPems: material.chainPems };

function setup(algorithm = 'sha256') {
  const fixture = preparedPdf(algorithm);
  const api = {
    getSession: jest.fn().mockResolvedValue({ state: 'app_opened', level_required: 'ades', hash_algorithm: algorithm }),
    postCertificate: jest.fn().mockResolvedValue(fixture.prepared),
    getDocument: jest.fn().mockResolvedValue(fixture.bytes),
    postAbort: jest.fn().mockResolvedValue({ state: 'failed' }),
    postComplete: jest.fn().mockResolvedValue({
      state: 'completed', level: 'ades', document_digest: fixture.prepared.document_digest, submitter_id: 42,
    }),
    completeSubmission: jest.fn().mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true }),
  };
  const deps: CeremonyDeps = {
    api,
    vault: {} as VaultDeps,
    configuration: { hasKey: true, hasReader: false, readerReady: false },
  };
  return { ...fixture, api, deps };
}

async function prepared(deps: CeremonyDeps): Promise<PreparedCeremony> {
  const preparation = await prepareCeremony(deps, 'ades');
  if (preparation.kind !== 'prepared') throw new Error('expected a prepared ceremony');

  return preparation.ceremony;
}

beforeEach(() => {
  jest.clearAllMocks();
  summary.mockResolvedValue(publicInfo);
  unlock.mockResolvedValue({ privateKeyPem: material.privateKeyPem, info: publicInfo });
});

it('does not pretend a key exists when configuration says there is none', async () => {
  const { deps } = setup();
  deps.configuration = { hasKey: false, hasReader: false, readerReady: false };

  await expect(prepareCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'no_signer' });
  expect(summary).not.toHaveBeenCalled();
});

it('does not try the vault for qes without a reader', async () => {
  const { deps, api } = setup();
  deps.configuration = { hasKey: true, hasReader: false, readerReady: false };
  api.getSession.mockResolvedValueOnce({
    state: 'app_opened', level_required: 'qes', hash_algorithm: 'sha256',
  });

  await expect(prepareCeremony(deps, 'qes')).rejects.toMatchObject({ code: 'needs_qes_key' });
  expect(summary).not.toHaveBeenCalled();
});

it.each(['sha256', 'sha384', 'sha512'])('signs verified PDF attributes with %s after one unlock', async (algorithm) => {
  const { deps, api, prepared: payload } = setup(algorithm);
  const ceremony = await prepared(deps);
  const result = await signCeremony(api, ceremony);

  expect(unlock).toHaveBeenCalledTimes(1);
  expect(api.postAbort).not.toHaveBeenCalled();
  expect(api.getDocument).toHaveBeenCalledTimes(1);
  expect(result.documentDigest).toBe(payload.document_digest);
  const signature = Buffer.from(api.postComplete.mock.calls[0][0], 'base64');
  expect(createVerify(algorithm).update(Buffer.from(payload.data_to_sign, 'base64'))
    .verify(material.certificatePem, signature)).toBe(true);
});

it('drops the unlocked private key right after signing', async () => {
  const { deps, api } = setup();
  const unlocked = { privateKeyPem: material.privateKeyPem, info: publicInfo };
  unlock.mockResolvedValue(unlocked);

  const ceremony = await prepared(deps);
  expect(unlock).not.toHaveBeenCalled();
  await signCeremony(api, ceremony);

  expect(unlocked.privateKeyPem).toBe('');
});

it('does not sign when the server document differs from the signed attributes', async () => {
  const { deps, api } = setup();
  const tampered = new Uint8Array(await api.getDocument());
  const marker = Buffer.from(tampered).indexOf('100 CZK');
  tampered[marker] = 0x39;
  api.getDocument.mockResolvedValueOnce(tampered);

  await expect(prepareCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'document_mismatch' });
  expect(api.postAbort).toHaveBeenCalledWith('document_mismatch');
  expect(api.postComplete).not.toHaveBeenCalled();
});

it.each([
  'changed PDF', 'wrong digest', 'wrong messageDigest', 'wrong contentType', 'duplicate digest',
  'trailing DER', 'invalid DER', 'nonzero start', 'overlap', 'uncovered tail', 'fraction',
  'wrong gap', 'wrong embedded range', 'wrong algorithm', 'wrong OID',
])('aborts without signing: %s', async (problem) => {
  const { deps, api, prepared: payload, bytes, digest, certificateDer } = setup();
  switch (problem) {
    case 'changed PDF': bytes[bytes.indexOf('100 CZK')] = 0x39; break;
    case 'wrong digest': payload.document_digest = '00'.repeat(32); break;
    case 'wrong messageDigest': payload.data_to_sign = signedAttrs('x'.repeat(32), undefined, false, certificateDer); break;
    case 'wrong contentType': payload.data_to_sign = signedAttrs(digest, '1.2.840.113549.1.7.2', false, certificateDer); break;
    case 'duplicate digest': payload.data_to_sign = signedAttrs(digest, undefined, true, certificateDer); break;
    case 'trailing DER': payload.data_to_sign = Buffer.concat([Buffer.from(payload.data_to_sign, 'base64'), Buffer.from([0])]).toString('base64'); break;
    case 'invalid DER': payload.data_to_sign = 'AAAA'; break;
    case 'nonzero start': payload.byte_range[0] = 1; break;
    case 'overlap': payload.byte_range[2] = payload.byte_range[1] - 1; break;
    case 'uncovered tail': payload.byte_range[3] -= 1; break;
    case 'fraction': payload.byte_range[1] += 0.5; break;
    case 'wrong gap': bytes[payload.byte_range[1]] = 0x20; break;
    case 'wrong embedded range': bytes[bytes.indexOf('/ByteRange')] = 0x20; break;
    case 'wrong algorithm': payload.hash_algorithm = 'sha1'; break;
    case 'wrong OID': payload.digest_algorithm_oid = '1.2.3'; break;
  }
  await expect(prepareCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'document_mismatch' });
  expect(api.postAbort).toHaveBeenCalledWith('document_mismatch');
  expect(api.postComplete).not.toHaveBeenCalled();
});

it('preserves mismatch error even if abort cannot reach the server', async () => {
  const { deps, api, prepared: payload } = setup();
  payload.document_digest = '';
  api.postAbort.mockRejectedValue(new Error('offline'));

  await expect(prepareCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'document_mismatch' });
});

it('resumes a completed session without touching the key or certificate', async () => {
  const { deps, api } = setup();
  const completed = { state: 'completed', level: 'ades', document_digest: 'digest', session_id: 1, submitter_id: 42, signed_pdf_sha256: 'hash' };
  api.getSession.mockResolvedValue(completed);
  deps.configuration = { hasKey: false, hasReader: false, readerReady: false };

  await expect(prepareCeremony(deps, 'ades')).resolves.toMatchObject({ kind: 'completed', completed });
  expect(unlock).not.toHaveBeenCalled();
  expect(api.postCertificate).not.toHaveBeenCalled();
  expect(api.getDocument).not.toHaveBeenCalled();
  expect(api.postComplete).not.toHaveBeenCalled();
});

it('polls an embedded completion until the session is completed', async () => {
  const { deps, api, prepared: payload } = setup();
  const ceremony = await prepared(deps);
  api.postComplete.mockResolvedValueOnce({ state: 'embedded', poll_after_ms: 1 });
  api.getSession
    .mockResolvedValueOnce({ state: 'app_opened', level_required: 'ades', hash_algorithm: 'sha256' })
    .mockResolvedValueOnce({
      state: 'completed', level: 'ades', document_digest: payload.document_digest, session_id: 1, submitter_id: 42,
      signed_pdf_sha256: 'hash',
    });

  const result = await signCeremony(api, ceremony);

  expect(result.completed.state).toBe('completed');
  expect(api.getSession).toHaveBeenCalledTimes(3);
});

it('keeps polling through a network blip instead of failing the ceremony', async () => {
  const { deps, api, prepared: payload } = setup();
  const ceremony = await prepared(deps);
  api.postComplete.mockResolvedValueOnce({ state: 'embedded', poll_after_ms: 1 });
  api.getSession
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      state: 'completed', level: 'ades', document_digest: payload.document_digest, session_id: 1, submitter_id: 42,
      signed_pdf_sha256: 'hash',
    });

  const result = await signCeremony(api, ceremony);

  expect(result.completed.state).toBe('completed');
  // 1× prepare + 1× výpadek + 1× úspěch
  expect(api.getSession).toHaveBeenCalledTimes(3);
});

it('stops polling on a definitive 4xx instead of retrying', async () => {
  const { deps, api } = setup();
  const ceremony = await prepared(deps);
  api.postComplete.mockResolvedValueOnce({ state: 'embedded', poll_after_ms: 1 });
  api.getSession.mockRejectedValueOnce(new QesApiError(410, 'expired_token'));

  await expect(signCeremony(api, ceremony)).rejects.toMatchObject({ code: 'expired_token' });
  // 1× prepare + 1× poll, žádné další opakování
  expect(api.getSession).toHaveBeenCalledTimes(2);
});

it('returns the reviewed digest even when the server reports another one', async () => {
  const { deps, api, prepared: payload } = setup();
  const ceremony = await prepared(deps);
  api.postComplete.mockResolvedValue({
    state: 'completed', level: 'ades', document_digest: 'other', submitter_id: 42,
  });

  const result = await signCeremony(api, ceremony);

  expect(result.documentDigest).toBe(payload.document_digest);
  expect(result.completed.document_digest).toBe('other');
});

it('recovers a lost completion response with no second signature or unlock', async () => {
  const { deps, api } = setup();
  const ceremony = await prepared(deps);
  api.postComplete.mockImplementationOnce(async () => {
    api.getSession.mockResolvedValue({ state: 'completed', level: 'ades', document_digest: 'digest', session_id: 1, submitter_id: 42, signed_pdf_sha256: 'hash' });
    throw new Error('lost response');
  });
  await expect(signCeremony(api, ceremony)).rejects.toThrow('lost response');
  await expect(prepareCeremony(deps, 'ades')).resolves.toMatchObject({ kind: 'completed' });
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(api.postCertificate).toHaveBeenCalledTimes(1);
  expect(api.postComplete).toHaveBeenCalledTimes(1);
});

it('reports the real application version and platform without reader details', async () => {
  const { deps, api } = setup();
  deps.appVersion = '1.3.9';
  await prepareCeremony(deps, 'ades');

  const body = api.postCertificate.mock.calls[0][0];
  expect(body.key_location).toBe('phone_keystore');
  expect(body.app).toEqual({ platform: expect.any(String), version: '1.3.9' });
  expect(body.app).not.toHaveProperty('reader');
  expect(body.app).not.toHaveProperty('container_ref');
});

it('omits the version when the build cannot read it', async () => {
  const { deps, api } = setup();
  await prepareCeremony(deps, 'ades');

  const body = api.postCertificate.mock.calls[0][0];
  expect(body.app).toEqual({ platform: expect.any(String) });
});
