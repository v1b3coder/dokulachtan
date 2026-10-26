import { createVerify } from 'node:crypto';
import { runSigningCeremony, type CeremonyDeps } from '../src/lib/ceremony';
import { unlockCertificate, type VaultDeps } from '../src/lib/crypto/vault';
import { parseP12 } from '../src/lib/crypto/p12';
import { TEST_P12_BASE64, TEST_P12_PASSWORD } from '../src/lib/testCertificate';
import { preparedPdf, signedAttrs } from './helpers/preparedPdf';

jest.mock('../src/lib/crypto/vault', () => ({ unlockCertificate: jest.fn() }));
const unlock = jest.mocked(unlockCertificate);
const material = parseP12(Uint8Array.from(atob(TEST_P12_BASE64), (c) => c.charCodeAt(0)), TEST_P12_PASSWORD);

function setup(algorithm = 'sha256') {
  const fixture = preparedPdf(algorithm);
  const api = {
    getSession: jest.fn().mockResolvedValue({ state: 'app_opened', level_required: 'ades', hash_algorithm: algorithm }),
    postCertificate: jest.fn().mockResolvedValue(fixture.prepared),
    getDocument: jest.fn().mockResolvedValue(fixture.bytes),
    postAbort: jest.fn().mockResolvedValue({ state: 'failed' }),
    postComplete: jest.fn().mockResolvedValue({ state: 'completed', level: 'ades', document_digest: fixture.prepared.document_digest }),
  };
  const confirmDocument = jest.fn().mockResolvedValue(true);
  const deps: CeremonyDeps = { api, vault: {} as VaultDeps, confirmDocument };
  return { ...fixture, api, deps, confirmDocument };
}

beforeEach(() => {
  jest.clearAllMocks();
  unlock.mockResolvedValue({ ...material, info: material });
});

it.each(['sha256', 'sha384', 'sha512'])('signs verified PDF attributes with %s after consent and one unlock', async (algorithm) => {
  const { deps, api, prepared, bytes, confirmDocument } = setup(algorithm);
  await runSigningCeremony(deps, 'ades');
  expect(confirmDocument).toHaveBeenCalledWith(new Uint8Array(bytes));
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(api.postAbort).not.toHaveBeenCalled();
  const signature = Buffer.from(api.postComplete.mock.calls[0][0], 'base64');
  expect(createVerify(algorithm).update(Buffer.from(prepared.data_to_sign, 'base64'))
    .verify(material.certificatePem, signature)).toBe(true);
});

it('waits for explicit confirmation before releasing a signature', async () => {
  const { deps, api, confirmDocument } = setup();
  let confirm!: (value: boolean) => void;
  let reviewing!: () => void;
  const ready = new Promise<void>((resolve) => { reviewing = resolve; });
  confirmDocument.mockImplementation(() => { reviewing(); return new Promise((resolve) => { confirm = resolve; }); });
  const result = runSigningCeremony(deps, 'ades');
  await ready;
  expect(api.postComplete).not.toHaveBeenCalled();
  confirm(true);
  await result;
  expect(api.postComplete).toHaveBeenCalledTimes(1);
});

it('does not sign when review is cancelled', async () => {
  const { deps, api, confirmDocument } = setup();
  confirmDocument.mockResolvedValue(false);
  await expect(runSigningCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'user_cancelled' });
  expect(api.postComplete).not.toHaveBeenCalled();
});

it.each([
  'changed PDF', 'wrong digest', 'wrong messageDigest', 'wrong contentType', 'duplicate digest',
  'trailing DER', 'invalid DER', 'nonzero start', 'overlap', 'uncovered tail', 'fraction',
  'wrong gap', 'wrong embedded range', 'wrong algorithm', 'wrong OID',
])('aborts without signing: %s', async (problem) => {
  const { deps, api, prepared, bytes, digest, confirmDocument } = setup();
  switch (problem) {
    case 'changed PDF': bytes[bytes.indexOf('100 CZK')] = 0x39; break;
    case 'wrong digest': prepared.document_digest = '00'.repeat(32); break;
    case 'wrong messageDigest': prepared.data_to_sign = signedAttrs('x'.repeat(32)); break;
    case 'wrong contentType': prepared.data_to_sign = signedAttrs(digest, '1.2.840.113549.1.7.2'); break;
    case 'duplicate digest': prepared.data_to_sign = signedAttrs(digest, undefined, true); break;
    case 'trailing DER': prepared.data_to_sign = Buffer.concat([Buffer.from(prepared.data_to_sign, 'base64'), Buffer.from([0])]).toString('base64'); break;
    case 'invalid DER': prepared.data_to_sign = 'AAAA'; break;
    case 'nonzero start': prepared.byte_range[0] = 1; break;
    case 'overlap': prepared.byte_range[2] = prepared.byte_range[1] - 1; break;
    case 'uncovered tail': prepared.byte_range[3] -= 1; break;
    case 'fraction': prepared.byte_range[1] += 0.5; break;
    case 'wrong gap': bytes[prepared.byte_range[1]] = 0x20; break;
    case 'wrong embedded range': bytes[bytes.indexOf('/ByteRange')] = 0x20; break;
    case 'wrong algorithm': prepared.hash_algorithm = 'sha1'; break;
    case 'wrong OID': prepared.digest_algorithm_oid = '1.2.3'; break;
  }
  await expect(runSigningCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'document_mismatch' });
  expect(api.postAbort).toHaveBeenCalledWith('document_mismatch');
  expect(api.postComplete).not.toHaveBeenCalled();
  expect(confirmDocument).not.toHaveBeenCalled();
});

it('preserves mismatch error even if abort cannot reach the server', async () => {
  const { deps, api, prepared } = setup();
  prepared.document_digest = '';
  api.postAbort.mockRejectedValue(new Error('offline'));
  await expect(runSigningCeremony(deps, 'ades')).rejects.toMatchObject({ code: 'document_mismatch' });
});

it('resumes a completed session without touching the key, certificate or review', async () => {
  const { deps, api, confirmDocument } = setup();
  const completed = { state: 'completed', level: 'ades', document_digest: 'digest', session_id: 1, signed_pdf_sha256: 'hash' };
  api.getSession.mockResolvedValue(completed);
  deps.configuration = { hasKey: false, hasReader: false, readerReady: false };
  await expect(runSigningCeremony(deps, 'ades')).resolves.toMatchObject({
    completed, level: 'ades', biometricPrompts: 0, keyLocation: null,
  });
  expect(unlock).not.toHaveBeenCalled();
  expect(api.postCertificate).not.toHaveBeenCalled();
  expect(api.getDocument).not.toHaveBeenCalled();
  expect(confirmDocument).not.toHaveBeenCalled();
  expect(api.postComplete).not.toHaveBeenCalled();
});

it('recovers a lost completion response with no second signature or unlock', async () => {
  const { deps, api } = setup();
  api.postComplete.mockImplementationOnce(async () => {
    api.getSession.mockResolvedValue({ state: 'completed', level: 'ades', document_digest: 'digest', session_id: 1, signed_pdf_sha256: 'hash' });
    throw new Error('lost response');
  });
  await expect(runSigningCeremony(deps, 'ades')).rejects.toThrow('lost response');
  await expect(runSigningCeremony(deps, 'ades')).resolves.toMatchObject({ biometricPrompts: 0 });
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(api.postCertificate).toHaveBeenCalledTimes(1);
  expect(api.postComplete).toHaveBeenCalledTimes(1);
});
