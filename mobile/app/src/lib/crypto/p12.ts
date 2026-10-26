// Načtení PKCS#12 v aplikaci (SPEC § 9.5): soubor se dešifruje heslem,
// klíčový materiál se ihned přešifruje klíčem z vaultu a heslo se zahodí.
// Při podpisu se heslo NIKDY nevyžaduje — jen biometrie.
import forge from 'node-forge';

import { levelFromQcStatements, QC_COMPLIANCE, QC_SSCD } from '../level';
import type { QesLevel } from '../types';

const QC_STATEMENTS_OID = '1.3.6.1.5.5.7.1.3';

export class P12Error extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface ParsedP12 {
  privateKeyPem: string;
  certificatePem: string;
  chainPems: string[];
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  qcStatements: string[];
  level: QesLevel;
  keyType: 'rsa';
  keySize: number;
  canSign: boolean;
}

export interface ParseP12Options {
  // Fake card mód simuluje čip (QSCD) — jinak se QcSSCD certifikát odmítá.
  allowQscd?: boolean;
}

export function parseP12(bytes: Uint8Array, password: string, options: ParseP12Options = {}): ParsedP12 {
  let p12: forge.pkcs12.Pkcs12Pfx;

  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(uint8ToBinary(bytes)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new P12Error(/password|mac|invalid/i.test(message) ? 'wrong_password' : 'invalid_p12', message);
  }

  const shroudedKeyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
  const keyBag = (shroudedKeyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0]
    ?? (keyBags[forge.pki.oids.keyBag] ?? [])[0];

  if (!keyBag) throw new P12Error('no_signing_key');
  // Forge u EC klíče vrací jen ASN.1. Odmítneme ho už při importu.
  const privateKey = keyBag.key;
  if (!privateKey?.n || !privateKey.e || !privateKey.d) {
    throw new P12Error('unsupported_key_type');
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificates = (certBags[forge.pki.oids.certBag] ?? []).map((bag) => {
    const asn1 = bag.asn1 ?? (bag.cert ? forge.pki.certificateToAsn1(bag.cert) : null);
    if (!asn1) throw new P12Error('invalid_p12');
    // DER uchováme i pro CA, jejíž veřejný klíč forge neumí načíst.
    return { cert: bag.cert, pem: forge.pem.encode({ type: 'CERTIFICATE', body: forge.asn1.toDer(asn1).getBytes() }) };
  });
  const signer = certificates.find(({ cert }) => {
    const key = cert?.publicKey as forge.pki.rsa.PublicKey | undefined;
    return key?.n?.equals(privateKey.n) && key.e.equals(privateKey.e);
  });
  if (!signer?.cert) throw new P12Error('no_signing_key');

  const certificate = signer.cert;
  const chain = certificates.filter((item) => item !== signer);
  const qcStatements = readQcStatements(certificate);
  const level = levelFromQcStatements(qcStatements);

  if (!options.allowQscd && (level === 'qes' || qcStatements.includes('QcSSCD'))) {
    // Telefon není QSCD — server by certifikát odmítl (422 level_mismatch, SPEC § 9.5).
    throw new P12Error('qscd_certificate');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certificatePem: signer.pem,
    chainPems: chain.map((item) => item.pem),
    subject: certificate.subject.getField('CN')?.value ?? certificate.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    issuer: certificate.issuer.getField('CN')?.value ?? certificate.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    serial: `0x${certificate.serialNumber.toUpperCase()}`,
    notBefore: new Date(certificate.validity.notBefore).toISOString(),
    notAfter: new Date(certificate.validity.notAfter).toISOString(),
    qcStatements,
    level,
    keyType: 'rsa',
    keySize: privateKey.n.bitLength(),
    canSign: canSign(certificate),
  };
}

export function readQcStatements(certificate: forge.pki.Certificate): string[] {
  const extension = certificate.extensions.find(
    (item) => item.id === QC_STATEMENTS_OID || item.name === 'qcStatements',
  );

  if (!extension) {
    return [];
  }

  try {
    const raw = typeof extension.value === 'string'
      ? extension.value
      : uint8ToBinary(extension.value as Uint8Array);
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(raw));
    const names: string[] = [];

    for (const statement of asn1.value as forge.asn1.Asn1[]) {
      const encoded = (statement.value as forge.asn1.Asn1[])[0]?.value as string | undefined;
      const oid = encoded === undefined ? undefined : forge.asn1.derToOid(encoded);

      if (oid === QC_COMPLIANCE) {
        names.push('QcCompliance');
      } else if (oid === QC_SSCD) {
        names.push('QcSSCD');
      }
    }

    return names;
  } catch {
    return [];
  }
}

function canSign(certificate: forge.pki.Certificate): boolean {
  const keyUsage = certificate.getExtension('keyUsage') as { digitalSignature?: boolean; nonRepudiation?: boolean } | undefined;

  return !keyUsage || keyUsage.digitalSignature === true || keyUsage.nonRepudiation === true;
}

export function uint8ToBinary(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return binary;
}

export function binaryToUint8(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
