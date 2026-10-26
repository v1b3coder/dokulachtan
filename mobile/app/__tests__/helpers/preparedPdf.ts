import { createHash } from 'node:crypto';
import forge from 'node-forge';
import type { QesCertificatePayload } from '../../src/lib/types';

// Platné jednostránkové PDF s xref, viditelným textem a prázdným podpisem.
export function preparedPdf(algorithm = 'sha256') {
  const rangePlaceholder = '0000000000 0000000000 0000000000 0000000000';
  const stream = 'BT /F1 12 Tf 20 100 Td (Contract: 100 CZK) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /V 7 0 R /P 3 0 R >>',
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [${rangePlaceholder}] /Contents <${'0'.repeat(512)}> >>`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const start = pdf.indexOf('<' + '0'.repeat(512));
  const end = start + 514;
  const range: [number, number, number, number] = [0, start, end, pdf.length - end];
  pdf = pdf.replace(rangePlaceholder, range.map((n) => String(n).padStart(10, '0')).join(' '));
  const bytes = Buffer.from(pdf, 'binary');
  const covered = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
  // CMS messageDigest používá algoritmus session; document_digest je vždy SHA-256.
  const digest = createHash(algorithm).update(covered).digest('binary');
  const prepared: QesCertificatePayload = {
    data_to_sign: signedAttrs(digest),
    byte_range: range,
    document_digest: createHash('sha256').update(covered).digest('hex'),
    hash_algorithm: algorithm,
    digest_algorithm_oid: { sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3' }[algorithm]!,
    signature_algorithm: 'rsa_pkcs1v15', expires_at: null,
    certificate_info: { subject: 'Test', issuer: 'Test', serial: '1', not_before: '', not_after: '', level: 'ades', qc_statements: [], key_type: 'rsa', key_size: 2048 },
  };
  return { bytes, prepared, digest };
}

export function signedAttrs(digest: string, contentType = '1.2.840.113549.1.7.1', duplicate = false) {
  const { create, Class: C, Type: T } = forge.asn1;
  const attribute = (oid: string, type: number, value: string) => create(C.UNIVERSAL, T.SEQUENCE, true, [
    create(C.UNIVERSAL, T.OID, false, forge.asn1.oidToDer(oid).getBytes()),
    create(C.UNIVERSAL, T.SET, true, [create(C.UNIVERSAL, type, false, value)]),
  ]);
  const md = attribute('1.2.840.113549.1.9.4', T.OCTETSTRING, digest);
  const attrs = [attribute('1.2.840.113549.1.9.3', T.OID, forge.asn1.oidToDer(contentType).getBytes()), md];
  if (duplicate) attrs.push(md);
  return forge.util.encode64(forge.asn1.toDer(create(C.UNIVERSAL, T.SET, true, attrs)).getBytes());
}
