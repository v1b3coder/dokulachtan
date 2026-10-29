# Test certificates

Tento adresář obsahuje testovací certifikáty, CRL a listové testovací klíče
a PKCS#12. Jsou to **jen testovací** materiály — neplatí pro produkční instanci a nesmí
se použít s reálnými daty.

- `ica/*.pem` — veřejné I.CA testovací root/qualified certy.
- `pki/*.crt`, `*.crl`, `revoked-serial.txt` — veřejné certy a CRL. Listové certy mají
  CRL DP na `http://127.0.0.1:8765/root.crl` (lokální e2e) i na
  `https://dokulachtan-staging.fly.dev/qes-test/root.crl` (staging); staging CRL
  vystavuje fork z `config/qes/test-root.crl`.
- `pki/*.key`, `pki/*.p12`, `signer.key.pem`, `signer.p12` — testovací
  listové klíče a identity (heslo `test`); potřebné pro `make fixtures`,
  `make negative` a fork specs.
- `signer.cert.pem` — veřejný self-signed cert pro `make validate`.

**Trust anchor stagingu** (`root.key`) je v `test/certs-private/` (gitignored),
protože jeho veřejný cert je trust root stagingu. Staging je testovací prostředí
a nesmí obsahovat reálná data; produkční instance důvěřuje pouze PostSignum CA.

Cestu k privátnímu root klíči lze přepsat přes `TEST_PKI_DIR` v `.env.local`.
