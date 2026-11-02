import forge from 'node-forge';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { p12WithBags } from './helpers/p12Bags';
import { parseP12, P12Error } from '../src/lib/crypto/p12';
import { TEST_P12_BASE64, TEST_P12_PASSWORD } from '../src/lib/testCertificate';

function testP12(): Uint8Array {
  return Uint8Array.from(atob(TEST_P12_BASE64), (char) => char.charCodeAt(0));
}

// Cert s volitelným CN a SAN e-mailem pro identitu podepisujícího.
function identityP12(identity: { commonName?: string; email?: string }): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();

  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  certificate.setSubject(identity.commonName
    ? [{ name: 'commonName', value: identity.commonName }]
    : [{ name: 'organizationName', value: 'Dokulachtan Test' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, critical: true },
    ...(identity.email
      ? [{ name: 'subjectAltName', altNames: [{ type: 1, value: identity.email }] }]
      : []),
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  return p12WithBags(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey)),
    [forge.pem.encode({
      type: 'CERTIFICATE',
      body: forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    })],
  );
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

  it('reads the signer identity from the certificate CN and SAN e-mail', () => {
    const parsed = parseP12(identityP12({ commonName: 'Jan Novák', email: 'jan@example.com' }), 'test');

    expect(parsed.commonName).toBe('Jan Novák');
    expect(parsed.email).toBe('jan@example.com');
  });

  it('falls back to the SAN e-mail when the certificate has no CN', () => {
    const parsed = parseP12(identityP12({ email: 'jan@example.com' }), 'test');

    expect(parsed.commonName).toBeNull();
    expect(parsed.email).toBe('jan@example.com');
  });

  it('reports no identity e-mail for a certificate without SAN', () => {
    const parsed = parseP12(testP12(), TEST_P12_PASSWORD);

    expect(parsed.commonName).toBe('signer-ades');
    expect(parsed.email).toBeNull();
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
