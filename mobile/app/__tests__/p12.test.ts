import forge from 'node-forge';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { p12WithBags } from './helpers/p12Bags';
import { parseP12, P12Error } from '../src/lib/crypto/p12';
import { TEST_P12_BASE64, TEST_P12_PASSWORD } from '../src/lib/testCertificate';

function testP12(): Uint8Array {
  return Uint8Array.from(atob(TEST_P12_BASE64), (char) => char.charCodeAt(0));
}

describe('parseP12', () => {
  it('parses the embedded test certificate as AdES with a signing key', () => {
    const parsed = parseP12(testP12(), TEST_P12_PASSWORD);

    expect(parsed.level).toBe('ades');
    expect(parsed.qcStatements).toEqual(['QcCompliance']);
    expect(parsed.keyType).toBe('rsa');
    expect(parsed.keySize).toBe(2048);
    expect(parsed.canSign).toBe(true);
    expect(parsed.subject).toContain('signer-ades');
    expect(parsed.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('rejects a wrong password', () => {
    expect(() => parseP12(testP12(), 'wrong')).toThrow(P12Error);

    try {
      parseP12(testP12(), 'wrong');
    } catch (error) {
      expect((error as P12Error).code).toBe('wrong_password');
    }
  });

  it('rejects a QcSSCD certificate (phone is not a QSCD)', () => {
    const qscd = require('fs').readFileSync(
      `${__dirname}/../../../test/certs/pki/signer-qscd.p12`,
    );

    expect(() => parseP12(new Uint8Array(qscd), 'test')).toThrow(P12Error);

    try {
      parseP12(new Uint8Array(qscd), 'test');
    } catch (error) {
      expect((error as P12Error).code).toBe('qscd_certificate');
    }
  });
});

it('preserves every certificate DER, including an ECC CA before the RSA signer', () => {
  const rsa = parseP12(testP12(), TEST_P12_PASSWORD);
  const ecc = readFileSync(`${__dirname}/fixtures/ecc-ca.crt`, 'utf8');
  const key = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(forge.pki.privateKeyFromPem(rsa.privateKeyPem)));
  const certs = [ecc, rsa.certificatePem, ...rsa.chainPems];
  const result = parseP12(p12WithBags(key, certs), 'test');
  expect(result.subject).toBe(rsa.subject);
  expect(result.chainPems.map((pem) => forge.pem.decode(pem)[0].body))
    .toEqual([ecc, ...rsa.chainPems].map((pem) => forge.pem.decode(pem)[0].body));
  expect(forge.pem.decode(result.certificatePem)[0].body).toBe(forge.pem.decode(rsa.certificatePem)[0].body);
});

it.each([false, true])('rejects an EC signing key at import (encrypted=%s)', (encrypted) => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = forge.asn1.fromDer(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('binary'));
  const bytes = p12WithBags(key, [readFileSync(`${__dirname}/fixtures/ecc-ca.crt`, 'utf8')], encrypted);
  expect(() => parseP12(bytes, 'test')).toThrow(expect.objectContaining({ code: 'unsupported_key_type' }));
});


it.each([
  [true, false, true],
  [false, true, true],
  [true, true, true],
  [false, false, false],
])('accepts digitalSignature=%s / contentCommitment=%s: %s', (digitalSignature, nonRepudiation, expected) => {
  const rsa = parseP12(testP12(), TEST_P12_PASSWORD);
  const key = forge.pki.privateKeyFromPem(rsa.privateKeyPem);
  const cert = forge.pki.certificateFromPem(rsa.certificatePem);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature, nonRepudiation, keyEncipherment: true }]);
  cert.sign(key, forge.md.sha256.create());
  const bytes = p12WithBags(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)), [forge.pki.certificateToPem(cert)]);
  expect(parseP12(bytes, 'test').canSign).toBe(expected);
});

it('allows signing when the certificate does not restrict key usage', () => {
  const rsa = parseP12(testP12(), TEST_P12_PASSWORD);
  const key = forge.pki.privateKeyFromPem(rsa.privateKeyPem);
  const cert = forge.pki.certificateFromPem(rsa.certificatePem);
  cert.setExtensions([]);
  cert.sign(key, forge.md.sha256.create());
  const bytes = p12WithBags(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)), [forge.pki.certificateToPem(cert)]);
  expect(parseP12(bytes, 'test').canSign).toBe(true);
});
