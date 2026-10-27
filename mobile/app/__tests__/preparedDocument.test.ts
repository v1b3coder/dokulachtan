import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { isEncryptedPdf, verifyPreparedDocument } from '../src/lib/preparedDocument';
import { preparedPdf, signedAttrs } from './helpers/preparedPdf';

function verify(
  bytes: Uint8Array,
  prepared: ReturnType<typeof preparedPdf>['prepared'],
  algorithm: string,
  certificateDer = preparedPdf(algorithm).certificateDer,
  identity = preparedPdf(algorithm).identity,
) {
  return verifyPreparedDocument(bytes, prepared, algorithm, certificateDer, identity);
}

it('rejects an encrypted PDF with the marker in the trailer', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');
  const text = Buffer.from(bytes).toString('binary')
    .replace('trailer\n<< /Size 8 /Root 1 0 R >>', 'trailer\n<< /Size 8 /Root 1 0 R /Encrypt 7 0 R >>');
  const encrypted = new Uint8Array(Buffer.from(text, 'binary'));

  expect(() => verify(encrypted, prepared, 'sha256', certificateDer, identity)).toThrow('encrypted');
});

it('detects an escaped /Encrypt name and a direct dictionary', () => {
  expect(isEncryptedPdf('%PDF-1.7\ntrailer\n<< /Encr#79pt 7 0 R >>\n%%EOF')).toBe(true);
  expect(isEncryptedPdf('%PDF-1.7\ntrailer\n<< /Encrypt << /Filter /Standard >> >>\n%%EOF')).toBe(true);
});

it('does not reject unencrypted content that merely mentions /Encrypt', () => {
  expect(isEncryptedPdf('%PDF-1.7\n1 0 obj\n<< /Length 24 >>\nstream\n/Encrypt 7 0 R here!\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'))
    .toBe(false);
});

it('rejects a /ByteRange that is not the one in front of /Contents', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');
  const pad = (n: number) => String(n).padStart(10, '0');
  const real = `/ByteRange [${prepared.byte_range.map(pad).join(' ')}]`;
  // jiný (třeba starší podepsaný) rozsah v PDF nesmí projít místo skutečného
  const decoy = `/ByteRange [${[1, 2, 3, 4].map(pad).join(' ')}]`;
  const forged = Buffer.from(bytes.toString('binary').replace(real, decoy), 'binary');
  const [, length, secondStart] = prepared.byte_range;
  const covered = Buffer.concat([forged.subarray(0, length), forged.subarray(secondStart)]);

  expect(() => verify(forged, {
    ...prepared, document_digest: createHash('sha256').update(covered).digest('hex'),
  }, 'sha256', certificateDer, identity)).toThrow('byte range');
});

it('rejects a pre-filled /Contents placeholder', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');
  const marker = Buffer.from('/Contents <');
  const start = bytes.indexOf(marker) + marker.length;
  bytes[start] = 0x41;

  expect(() => verify(bytes, prepared, 'sha256', certificateDer, identity)).toThrow('contents not empty');
});

it.each(['sha256', 'sha384', 'sha512'])('cross-checks both payload digests independently for %s', (algorithm) => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf(algorithm);
  const [start, length, secondStart, secondLength] = prepared.byte_range;
  const covered = Buffer.concat([bytes.subarray(start, start + length), bytes.subarray(secondStart, secondStart + secondLength)]);
  const attrs = forge.asn1.fromDer(forge.util.decode64(prepared.data_to_sign));
  const messageDigest = (attrs.value as forge.asn1.Asn1[]).find((attr) => {
    const fields = attr.value as forge.asn1.Asn1[];
    return forge.asn1.derToOid(fields[0].value as string) === '1.2.840.113549.1.9.4';
  })!;
  const values = (messageDigest.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[];

  expect(values[0].value).toBe(createHash(algorithm).update(covered).digest('binary'));
  expect(prepared.document_digest).toBe(createHash('sha256').update(covered).digest('hex'));
  expect(verify(bytes, prepared, algorithm, certificateDer, identity).dataToSign)
    .toEqual(new Uint8Array(Buffer.from(prepared.data_to_sign, 'base64')));

  if (algorithm === 'sha384') {
    // SHA-384 pro CMS nesmí změnit pevný SHA-256 kontrakt document_digest.
    expect(() => verify(bytes, {
      ...prepared, document_digest: createHash('sha384').update(covered).digest('hex'),
    }, algorithm, certificateDer, identity)).toThrow('document digest');
    // Ani platný document_digest nesmí zakrýt použití SHA-256 v CMS messageDigest.
    expect(() => verify(bytes, {
      ...prepared, data_to_sign: signedAttrs(createHash('sha256').update(covered).digest('binary'), undefined, false, certificateDer),
    }, algorithm, certificateDer, identity)).toThrow('signed attributes mismatch');
  }
});

it('rejects attributes signed for a different certificate', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');
  const otherCertificate = new Uint8Array([1, 2, 3]);

  expect(() => verify(bytes, {
    ...prepared, data_to_sign: signedAttrs(
      createHash('sha256').update(
        Buffer.concat([bytes.subarray(0, prepared.byte_range[1]), bytes.subarray(prepared.byte_range[2])]),
      ).digest('binary'),
      undefined,
      false,
      otherCertificate,
    ),
  }, 'sha256', certificateDer, identity)).toThrow('signing certificate mismatch');
});

it('rejects a signingTime outside the window', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');
  const [start, length, secondStart] = prepared.byte_range;
  const covered = Buffer.concat([bytes.subarray(start, start + length), bytes.subarray(secondStart)]);
  const digest = createHash('sha256').update(covered).digest('binary');

  expect(() => verify(bytes, {
    ...prepared,
    data_to_sign: signedAttrs(digest, undefined, false, certificateDer, new Date(Date.now() - 2 * 60 * 60 * 1000)),
  }, 'sha256', certificateDer, identity)).toThrow('signing time');
});

it('rejects certificate_info that does not match the local certificate', () => {
  const { bytes, prepared, certificateDer, identity } = preparedPdf('sha256');

  expect(() => verify(bytes, {
    ...prepared,
    certificate_info: { ...prepared.certificate_info, serial: '0xDEADBEEF' },
  }, 'sha256', certificateDer, identity)).toThrow('certificate info');
});
