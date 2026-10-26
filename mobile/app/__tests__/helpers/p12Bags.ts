import forge from 'node-forge';

// Reálná struktura PFX v paměti, včetně bagů, které forge neumí dekódovat.
export function p12WithBags(key: forge.asn1.Asn1, certificates: string[], encrypted = false): Uint8Array {
  const { create, Class: C, Type: T } = forge.asn1;
  const sequence = (children: forge.asn1.Asn1[]) => create(C.UNIVERSAL, T.SEQUENCE, true, children);
  const oid = (value: string) => create(C.UNIVERSAL, T.OID, false, forge.asn1.oidToDer(value).getBytes());
  const tagged = (value: forge.asn1.Asn1) => create(C.CONTEXT_SPECIFIC, 0, true, [value]);
  const octet = (value: string) => create(C.UNIVERSAL, T.OCTETSTRING, false, value);
  const data = (value: forge.asn1.Asn1) => sequence([oid(forge.pki.oids.data), tagged(octet(forge.asn1.toDer(value).getBytes()))]);
  const keyBag = sequence([
    oid(encrypted ? forge.pki.oids.pkcs8ShroudedKeyBag : forge.pki.oids.keyBag),
    tagged(encrypted ? forge.pki.encryptPrivateKeyInfo(key, 'test', { algorithm: 'aes256' }) : key),
  ]);
  const bags = certificates.map((pem) => sequence([
    oid(forge.pki.oids.certBag),
    tagged(sequence([oid(forge.pki.oids.x509Certificate), tagged(octet(forge.pem.decode(pem)[0].body))])),
  ]));
  const pfx = sequence([
    create(C.UNIVERSAL, T.INTEGER, false, '\x03'),
    data(sequence([data(sequence([keyBag, ...bags]))])),
  ]);
  return Uint8Array.from(forge.asn1.toDer(pfx).getBytes(), (c) => c.charCodeAt(0));
}
