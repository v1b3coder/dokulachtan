// Svážeme podepisované CMS atributy s přesnými bajty prohlíženého PDF.
import forge from 'node-forge';

import { binaryToUint8, readQcStatements, uint8ToBinary } from './crypto/p12';
import type { HashAlgorithm } from './crypto/softwareSigner';
import { levelFromQcStatements } from './level';
import type { QesCertificatePayload } from './types';

const HASH_OIDS: Record<HashAlgorithm, string> = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
};

const HASH_BY_OID: Record<string, HashAlgorithm> = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4';
const CONTENT_TYPE_OID = '1.2.840.113549.1.9.3';
const SIGNING_TIME_OID = '1.2.840.113549.1.9.5';
const SIGNING_CERTIFICATE_V2_OID = '1.2.840.113549.1.9.16.2.47';
const DATA_OID = '1.2.840.113549.1.7.1';
const SIGNING_TIME_WINDOW_MS = 60 * 60 * 1000;

export interface PreparedDocument {
  dataToSign: Uint8Array;
  digest: string;
  byteRange: [number, number, number, number];
}

export interface CertificateIdentity {
  serial?: string;
  notBefore?: string;
  notAfter?: string;
  level?: string;
  qcStatements?: string[];
  keyType?: string;
  keySize?: number;
}

export function normalizePdfName(value: string): string {
  return value.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)));
}

function dictionaryEnd(value: string, start: number): number {
  let depth = 0;
  for (let index = start; index < value.length - 1; index += 1) {
    if (value.startsWith('<<', index)) {
      depth += 1;
      index += 1;
    } else if (value.startsWith('>>', index)) {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

export function isEncryptedPdf(binary: string): boolean {
  const tail = normalizePdfName(binary.slice(-65_536));
  const dictionaries: string[] = [];
  let offset = 0;

  while ((offset = tail.indexOf('<<', offset)) >= 0) {
    const end = dictionaryEnd(tail, offset);

    if (end < 0) break;
    const dictionary = tail.slice(offset, end);
    const before = tail.slice(Math.max(0, offset - 20), offset);

    if (before.includes('trailer') || /\/Type\s*\/XRef/.test(dictionary)) {
      dictionaries.push(dictionary);
    }
    offset = end;
  }

  return dictionaries.some((dictionary) => /\/Encrypt\b/.test(dictionary));
}

interface SignedRange {
  range: [number, number, number, number];
  prefix: string;
  suffix: string;
  contents: string;
}

// `/ByteRange` musí být zapsaný hned před mezerou `/Contents`, ne kdekoliv
// v souboru — jinak by šlo podstrčit rozsah z jiného (i podepsaného) objektu.
// U vícenásobných podpisů je v PDF víc `/ByteRange`; nový podpis je poslední.
function parseSignedRange(
  binary: string,
  expected?: [number, number, number, number],
): SignedRange {
  if (expected) {
    const [start, firstLength, secondStart, secondLength] = expected;
    if (start !== 0 || firstLength <= 0 || secondStart <= firstLength || secondLength <= 0
      || secondStart + secondLength !== binary.length) throw new Error('byte range');

    const prefix = binary.slice(0, firstLength);
    const gap = binary.slice(firstLength, secondStart);
    const embedded = prefix.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]\s*\/Contents\s*$/);
    if (!embedded || !expected.every((value, index) => value === Number(embedded[index + 1]))) {
      throw new Error('embedded byte range');
    }
    if (!/^<[\da-fA-F\s]*>$/.test(gap)) throw new Error('contents gap');

    return {
      range: expected,
      prefix,
      suffix: binary.slice(secondStart),
      contents: gap.slice(1, -1).replace(/\s/g, ''),
    };
  }

  const matches = [...binary.matchAll(
    /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]\s*\/Contents\s*<([\da-fA-F\s]*)>/g,
  )];
  const match = matches[matches.length - 1];
  if (!match) throw new Error('contents gap');

  const range: [number, number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
  const [start, firstLength, secondStart, secondLength] = range;

  if (start !== 0 || firstLength <= 0 || secondStart <= firstLength || secondLength <= 0
    || secondStart + secondLength !== binary.length) throw new Error('byte range');

  return {
    range,
    prefix: binary.slice(0, firstLength),
    suffix: binary.slice(secondStart),
    contents: match[5].replace(/\s/g, ''),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return forge.md.sha256.create().update(uint8ToBinary(bytes)).digest().toHex();
}

// Otisk podepsaných bajtů TBS pro zobrazení v kontrole a porovnání s
// `completed.document_digest`. Celý soubor se nehashuje, jen to, co podpis kryje.
export function documentDigest(pdf: Uint8Array): { digest: string; byteRange: [number, number, number, number] } {
  const binary = uint8ToBinary(pdf);
  if (!binary.startsWith('%PDF-') || !/%%EOF\s*$/.test(binary)) throw new Error('pdf');
  if (isEncryptedPdf(binary)) throw new Error('encrypted');

  const { range, prefix, suffix } = parseSignedRange(binary);
  const digest = forge.md.sha256.create().update(prefix + suffix).digest().toHex();

  return { digest, byteRange: range };
}

export function verifyPreparedDocument(
  pdf: Uint8Array,
  prepared: QesCertificatePayload,
  hashAlgorithm: string,
  certificateDer: Uint8Array,
  certificateIdentity?: CertificateIdentity,
): PreparedDocument {
  const algorithm = hashAlgorithm as HashAlgorithm;
  if (!Object.hasOwn(HASH_OIDS, algorithm) || prepared.hash_algorithm !== algorithm
    || prepared.digest_algorithm_oid !== HASH_OIDS[algorithm]) throw new Error('hash algorithm');

  const binary = uint8ToBinary(pdf);
  if (!binary.startsWith('%PDF-') || !/%%EOF\s*$/.test(binary)) throw new Error('pdf');
  // Šifrované PDF by se otevřelo s dotazem na heslo, takže by ho uživatel
  // nemusel vidět; podepsat ho nesmíme. Autoritativní kontrola je na serveru.
  if (isEncryptedPdf(binary)) throw new Error('encrypted');

  const range = prepared.byte_range;
  if (!Array.isArray(range) || range.length !== 4 || !range.every(Number.isSafeInteger)) {
    throw new Error('byte range');
  }

  const signed = parseSignedRange(binary, range);

  // Rezerva `/Contents` musí být před podpisem prázdná (samé nuly), jinak by
  // appka podepsala dokument, který už nějakou signaturu obsahuje.
  if (!/^0*$/.test(signed.contents)) throw new Error('contents not empty');

  const digest = forge.md[algorithm].create().update(signed.prefix + signed.suffix).digest().getBytes();
  const sha256 = forge.md.sha256.create().update(signed.prefix + signed.suffix).digest().toHex();
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

  const md = attributes.get(MESSAGE_DIGEST_OID);
  const ct = attributes.get(CONTENT_TYPE_OID);
  if (md?.length !== 1 || primitive(md[0], forge.asn1.Type.OCTETSTRING) !== digest
    || ct?.length !== 1 || forge.asn1.derToOid(primitive(ct[0], forge.asn1.Type.OID)) !== DATA_OID) {
    throw new Error('signed attributes mismatch');
  }

  if (!['rsa_pkcs1v15', 'ecdsa'].includes(prepared.signature_algorithm)) {
    throw new Error('signature algorithm');
  }

  verifySigningCertificate(attributes, certificateDer);
  verifySigningTime(attributes);
  verifyCertificateInfo(prepared, certificateIdentity);

  return { dataToSign: binaryToUint8(der), digest: sha256, byteRange: signed.range };
}

// `signingCertificateV2` (RFC 5035) musí obsahovat hash certifikátu, který
// appka poslala; jinak by šlo podepsat atributy s cizí identitou.
function verifySigningCertificate(
  attributes: Map<string, forge.asn1.Asn1[]>,
  certificateDer: Uint8Array,
): void {
  const attr = attributes.get(SIGNING_CERTIFICATE_V2_OID);
  if (attr?.length !== 1) throw new Error('signing certificate');

  const signingCertificate = children(attr[0], forge.asn1.Type.SEQUENCE);
  const certs = signingCertificate[0] ? children(signingCertificate[0], forge.asn1.Type.SEQUENCE) : [];
  const certId = certs[0] ? children(certs[0], forge.asn1.Type.SEQUENCE) : [];
  if (certId.length === 0) throw new Error('signing certificate');

  let hashAlgorithm: HashAlgorithm = 'sha256';
  let hashNode = certId[0];
  if (hashNode.tagClass === forge.asn1.Class.UNIVERSAL && hashNode.type === forge.asn1.Type.SEQUENCE) {
    const algorithm = children(hashNode, forge.asn1.Type.SEQUENCE);
    const oid = algorithm[0] ? forge.asn1.derToOid(primitive(algorithm[0], forge.asn1.Type.OID)) : '';
    const mapped = HASH_BY_OID[oid];
    if (!mapped) throw new Error('signing certificate algorithm');
    hashAlgorithm = mapped;
    hashNode = certId[1];
  }
  if (!hashNode) throw new Error('signing certificate');

  const certHash = primitive(hashNode, forge.asn1.Type.OCTETSTRING);
  const expected = forge.md[hashAlgorithm].create().update(uint8ToBinary(certificateDer)).digest().getBytes();
  if (certHash !== expected) throw new Error('signing certificate mismatch');
}

// `signingTime` je atribut serveru; nesmí být v minulosti ani budoucnosti
// (ochrana proti podpisu se starým/posunutým časem).
function verifySigningTime(attributes: Map<string, forge.asn1.Asn1[]>): void {
  const attr = attributes.get(SIGNING_TIME_OID);
  if (attr?.length !== 1) throw new Error('signing time');

  const node = attr[0];
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL
    || (node.type !== forge.asn1.Type.UTCTIME && node.type !== forge.asn1.Type.GENERALIZEDTIME)
    || node.constructed || typeof node.value !== 'string') throw new Error('signing time');

  const date = parseAsn1Time(node.value);
  if (!date || Math.abs(Date.now() - date.getTime()) > SIGNING_TIME_WINDOW_MS) {
    throw new Error('signing time');
  }
}

function parseAsn1Time(value: string): Date | null {
  const match = value.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;

  let year = Number(match[1]);
  if (match[1].length === 2) year += year >= 50 ? 1900 : 2000;

  const date = new Date(Date.UTC(
    year,
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ));

  return Number.isNaN(date.getTime()) ? null : date;
}

// `certificate_info` vrací server; musí odpovídat místnímu certifikátu, jinak
// by appka zobrazila (a podepsala) jinou identitu, než má v telefonu.
function verifyCertificateInfo(prepared: QesCertificatePayload, identity?: CertificateIdentity): void {
  if (!identity) return;

  const info = prepared.certificate_info;
  if (identity.serial && info.serial !== identity.serial) throw new Error('certificate info');
  if (identity.notBefore && Date.parse(info.not_before) !== Date.parse(identity.notBefore)) {
    throw new Error('certificate info');
  }
  if (identity.notAfter && Date.parse(info.not_after) !== Date.parse(identity.notAfter)) {
    throw new Error('certificate info');
  }
  if (identity.level && info.level !== identity.level) throw new Error('certificate info');
  if (identity.qcStatements
    && JSON.stringify(info.qc_statements) !== JSON.stringify(identity.qcStatements)) {
    throw new Error('certificate info');
  }
  if (identity.keyType && info.key_type !== identity.keyType) throw new Error('certificate info');
  if (identity.keySize && info.key_size !== identity.keySize) throw new Error('certificate info');
}

export function certificateIdentityFromPem(pem: string): CertificateIdentity {
  const certificate = forge.pki.certificateFromPem(pem);
  const qcStatements = readQcStatements(certificate);
  const publicKey = certificate.publicKey as { n?: { bitLength(): number } };

  return {
    serial: `0x${certificate.serialNumber.toUpperCase()}`,
    notBefore: new Date(certificate.validity.notBefore).toISOString(),
    notAfter: new Date(certificate.validity.notAfter).toISOString(),
    level: levelFromQcStatements(qcStatements),
    qcStatements,
    keyType: publicKey?.n ? 'rsa' : 'ecdsa',
    keySize: publicKey?.n?.bitLength?.() ?? 0,
  };
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
