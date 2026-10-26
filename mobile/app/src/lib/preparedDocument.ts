// Svážeme podepisované CMS atributy s přesnými bajty prohlíženého PDF.
import forge from 'node-forge';

import { binaryToUint8, uint8ToBinary } from './crypto/p12';
import type { HashAlgorithm } from './crypto/softwareSigner';
import type { QesCertificatePayload } from './types';

const HASH_OIDS: Record<HashAlgorithm, string> = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
};

export function verifyPreparedDocument(
  pdf: Uint8Array,
  prepared: QesCertificatePayload,
  hashAlgorithm: string,
): Uint8Array {
  const algorithm = hashAlgorithm as HashAlgorithm;
  if (!Object.hasOwn(HASH_OIDS, algorithm) || prepared.hash_algorithm !== algorithm
    || prepared.digest_algorithm_oid !== HASH_OIDS[algorithm]) throw new Error('hash algorithm');

  const range = prepared.byte_range;
  if (!Array.isArray(range) || range.length !== 4 || !range.every(Number.isSafeInteger)) {
    throw new Error('byte range');
  }
  const [start, firstLength, secondStart, secondLength] = range;
  if (start !== 0 || firstLength <= 0 || secondStart <= firstLength || secondLength <= 0
    || secondStart + secondLength !== pdf.length) throw new Error('byte range');

  const binary = uint8ToBinary(pdf);
  const prefix = binary.slice(0, firstLength);
  const gap = binary.slice(firstLength, secondStart);
  if (!binary.startsWith('%PDF-') || !/%%EOF\s*$/.test(binary)
    || !/^<[\da-fA-F\s]+>$/.test(gap)) {
    throw new Error('contents gap');
  }
  // Šifrované PDF by se otevřelo s dotazem na heslo, takže by ho uživatel
  // nemusel vidět; podepsat ho nesmíme.
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(binary)) {
    throw new Error('encrypted');
  }
  // `/ByteRange` musí být zapsaný hned před mezerou `/Contents`, ne kdekoliv
  // v souboru — jinak by šlo podstrčit rozsah z jiného (i podepsaného) objektu.
  const embedded = prefix.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]\s*\/Contents\s*$/);
  if (!embedded || !range.every((value, index) => value === Number(embedded[index + 1]))) {
    throw new Error('embedded byte range');
  }

  const signedBytes = prefix + binary.slice(secondStart);
  const digest = forge.md[algorithm].create().update(signedBytes).digest().getBytes();
  const sha256 = forge.md.sha256.create().update(signedBytes).digest().toHex();
  if (typeof prepared.document_digest !== 'string'
    || sha256 !== prepared.document_digest.toLowerCase()) throw new Error('document digest');

  const der = forge.util.decode64(prepared.data_to_sign);
  const attrs = forge.asn1.fromDer(der, true);
  if (forge.asn1.toDer(attrs).getBytes() !== der) throw new Error('non-DER attributes');
  const values = children(attrs, forge.asn1.Type.SET);
  const attributes = new Map<string, forge.asn1.Asn1[]>();
  for (const attr of values) {
    const fields = children(attr, forge.asn1.Type.SEQUENCE);
    if (fields.length !== 2) throw new Error('attribute');
    const oid = forge.asn1.derToOid(primitive(fields[0], forge.asn1.Type.OID));
    if (attributes.has(oid)) throw new Error('duplicate attribute');
    attributes.set(oid, children(fields[1], forge.asn1.Type.SET));
  }
  const md = attributes.get('1.2.840.113549.1.9.4');
  const ct = attributes.get('1.2.840.113549.1.9.3');
  if (md?.length !== 1 || primitive(md[0], forge.asn1.Type.OCTETSTRING) !== digest
    || ct?.length !== 1 || forge.asn1.derToOid(primitive(ct[0], forge.asn1.Type.OID)) !== '1.2.840.113549.1.7.1') {
    throw new Error('signed attributes mismatch');
  }

  return binaryToUint8(der);
}

function children(node: forge.asn1.Asn1, type: number): forge.asn1.Asn1[] {
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL || node.type !== type
    || !node.constructed || !Array.isArray(node.value)) throw new Error('ASN.1 structure');
  return node.value as forge.asn1.Asn1[];
}

function primitive(node: forge.asn1.Asn1, type: number): string {
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL || node.type !== type
    || node.constructed || typeof node.value !== 'string') throw new Error('ASN.1 value');
  return node.value;
}
