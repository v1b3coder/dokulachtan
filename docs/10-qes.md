# 10 — QES runbook (ENV, TSA, trust roots, troubleshooting)

Provozní příručka QES vrstvy forku. Vzniká v P0.6, doplňuje SPEC § 11 a § 15.
Vše níže je **ověřené** (poslední kontrola 2026-10-28), ne odhad.

## Co je hotové

| Vrstva | Stav |
|---|---|
| `QesSession` + stavový automat + token | hotové (SPEC § 4, `spec/models/qes_session_spec.rb`) |
| Kryptografie: TBS → CMS → embed → LTV → validace → pečeť | hotové (SPEC § 7, `spec/lib/qes/pipeline_spec.rb`) |
| API pro appku (`/qes/sessions/:token`) | hotové (SPEC § 5, `spec/requests/qes_sessions_spec.rb`) |
| API pro prohlížeč (`/s/:slug/qes_sessions`) | hotové (SPEC § 6); krok `QesStep.vue` po kliknutí rovnou vykreslí QR kód + „Open the app“ (žádná mezistránka) |
| Hooky do DocuSealu (documents, combined, audit, hodnota pole) | hotové (SPEC § 7.7) |
| Appka (Expo): vault, podpis, automatická volba podepisujícího | hotové (SPEC § 9, `mobile/app`) |
| Čtečka (MOI SDK) | **stub** (`StubCardSigner` → `reader_not_found`); `FakeCardSigner` (test QSCD cert) umí celý A tok |
| TSA | DigiCert free (`http://timestamp.digicert.com`, AATL) na stagingu i produkční instanci; v CI/testech prázdné |

## Konfigurace (ENV)

| ENV | Default | Význam |
|---|---|---|
| `QES_ENABLED` | `true` | feature gate forku: `false` = chování upstream DocuSealu (viz níže) |
| `QES_SESSION_TTL` | `600` | platnost session pro podpis [s] |
| `QES_REVIEW_TTL` | `900` | platnost session pro kontrolu dokumentu [s] (`GET /document` ji prodlouží) |
| `QES_SIGNATURE_SIZE` | `20000` | placeholder signatury v CMS [B] |
| `QES_SIGNATURE_MIN_SIZE` | `20000` | minimální rezerva `/Contents` (fallback) [B] |
| `QES_SIGNATURE_RESERVE` | `65536` | pevná rezerva `/Contents` v TBS; staví se před certifikátem (SPEC § 5.1a) [B] |
| `QES_DEEP_LINK_BASE` | `dokulachtan://sign` | custom scheme |
| `QES_PUBLIC_BASE_URL` | `APP_URL` | host pro universal links |
| `QES_TRUST_ROOTS` | `config/qes/postsignum.pem` | signing trust store: které certy smí podepsat v tomto DocuSealu (PEM, čárkou oddělené; soubor může obsahovat víc certů) |
| `QES_VERIFICATION_TRUST_ROOTS` | `config/qes/czech.pem` | verification trust store: vydávající CA českých kvalifikovaných certů pro ověření cizích PDF (PEM, čárkou oddělené; anchory, ne rooty) |
| `QES_TSA_URL` | `http://timestamp.digicert.com` | RFC 3161 TSA (DigiCert free, AATL); kvalifikované I.CA/PostSignum přepište |
| `QES_TSA_TRUST_ROOTS` | `config/qes/digicert-tsa.pem` | cesty k rootům TSA (PEM, čárkou oddělené); **povinné** když je `QES_TSA_URL` nastavené |
| `QES_TSA_REQUIRED` | `true` | vyžadovat TSA token |
| `QES_REQUIRE_LTV` | `true` | vyžadovat revokační data pro certy bez CRL DP; staging/testy `false` |
| `QES_LTV_ALLOWED_HOSTS` | `crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,qcrldp1.ica.cz,qcrldp2.ica.cz,crldp1.ica.cz,crldp2.ica.cz` | allowlist hostů pro CRL (SSRF ochrana; čárkou oddělené). I.CA hosty jsou tu proto, že její CRL DP jsou jen **http** (https na `qcrldp1.ica.cz` neodpovídá), takže prázdná hodnota („bez allowlistu" = jen https a veřejná adresa) pro I.CA nestačí. Explicitní ENV default **plně nahradí** — kdo podepisuje certem mimo PostSignum/I.CA, musí svoje hosty vypsat taky. Podpis certem I.CA navíc potřebuje její roots v `QES_TRUST_ROOTS` (výchozí `postsignum.pem` I.CA nezná). |
| `QES_TEST_CRL_PATH` | — | cesta k testovacímu CRL, které fork vystaví na `/qes-test/root.crl` (jen staging) |
| `QES_ANDROID_CERT_SHA256` | — | fingerprint pro `assetlinks.json` |
| `QES_IOS_TEAM_ID` | — | pro AASA |
| `QES_EXPIRY_JOB_INTERVAL` | `60` | perioda expiračního jobu [s]; `0` = vypnuto |
| `QES_SEAL_PKCS_PATH` + `QES_SEAL_PKCS_PASSWORD` | — | jen pro testy (PKCS#12 pečeti); jinak `Accounts.load_signing_pkcs` |

Defaulty jsou pro český deployment (PostSignum CRL hosty a signing roots, české kvalifikační CA pro ověření, DigiCert TSA). ENV je override:
staging přepisuje verification trust roots, `QES_REQUIRE_LTV`, test CRL a allowlist; jiná CA přepíše signing trust roots.
Kdo nechce TSA, dá `QES_TSA_URL=` a `QES_TSA_REQUIRED=false`. `QES_ENABLED=false` vypne QES
na upstream/ne-QES instanci.

`QES_ENABLED` je **feature gate forku**, ne jen vypínač podpisu: s `false` se nespustí žádný náš kód,
který mění chování DocuSealu (nález #10):

- QES endpointy vrací `404 {"error":"disabled"}` — `/qes/sessions/*`, `/s/:slug/qes_sessions`,
  `/api/qes/*`, `/qes/sign`, `/qes/app`, `.well-known/assetlinks.json`,
  `.well-known/apple-app-site-association`, `/qes-test/root.crl`
  i `templates/:id/qes_verification`. Podepsat obřad tedy nejde spustit ani dokončit.
- Nespouští se QES validace šablony (`qes_signing_order`), vynucení `submitters_order: preserved`,
  přepis `required` u QES polí z API, zámek řádku při submit a `ExpireSessionsJob`.
- Použije se upstream generátor PDF. **Důsledek: regenerované PDF u už dokončeného QES podpisu
  ztratí QES revizi.** Uložený `final_document` v QES session zůstává, ale `submission.documents`
  se přepne na nepodepsané PDF. Vypínej QES až po dokončení otevřených oběhů a neotvírej jím
  podepsané dokumenty znovu (regenerace).
- Změna se čte při každém volání (`Qes::Config` nemá memoizaci), takže `fly secrets set QES_ENABLED=false`
  (restart machine, ne redeploy image) stačí a platí pro všechny nové requesty.
- Vypnutý QES nerevaliduje existující šablony: QES šablonu jde s vypnutým QES upravit i od-QESovat,
  ale po opětovném zapnutí se validace vztáhne i na ni.

Trust roots: `Qes::Validator` staví OpenSSL store z předaných trust anchorů **a z intermediate
certifikátů z CMS** (SPEC § 7.5). Anchory jsou **vydávající CA** (service digital identity z TSL),
ne rooty: root jako anchor by důvěřoval celému podstromu, tj. i CA, které v TSL nejsou nebo z něj byly
staženy. Store proto nastavuje `X509_V_FLAG_PARTIAL_CHAIN`, aby řetěz skončil na vydávající CA, i když
není self-signed. Self-signed cert je anchor jen tehdy, když ho do seznamu dáte explicitně (testovací root
na stagingu); self-signed cert podepisujícího projde jen když je sám sobě anchorem, a pak `422 not_trusted`
(SPEC § 5.2).

`QES_TRUST_ROOTS` je **signing** trust store: které certy smí podepsat v tomto DocuSealu.
Výchozí je PostSignum (`config/qes/postsignum.pem`: Root QCA 4 + Qualified CA 4/5 + Root QCA ECC R1
+ Qualified ECC R1 CA1/CA3). Rooty tu zůstávají i jako zdroj issuer certů pro CRL (`Qes::Ltv.issuer_for`).

`QES_VERIFICATION_TRUST_ROOTS` je **verification** trust store: vydávající CA českých kvalifikovaných
certifikátů pro ověření cizích PDF (`config/qes/czech.pem`: PostSignum, I.CA, eIdentity, NCA, KB).
Ověření tak nevnucuje všechny české QTSP jako podepisující autority a nedůvěřuje podstromům rootů.

### Český verification bundle (`config/qes/czech.pem`)

Stav 2026-10-29, 15 certů — jen **vydávající CA** (trust anchory), žádný root:

- **PostSignum** (4): Qualified CA 4/5, Qualified ECC R1 CA1/CA3.
- **I.CA** (5): EU Qualified CA2/RSA a ECC 06/2022, Qualified 2 CA/RSA 02/2016,
  Qualified 2 CA/ECC 06/2019, Qualified CA/RSA 07/2015 (expirovaná).
- **eIdentity** (3): ACAeID3.1 (expirovaná), ACAeID3.2 a 3.3 Issuing.
- **NCA** (2): SubCA1/RSA a ECC 10/2023.
- **Komerční banka** (1): Komerční banka Qualified CA/RSA.

Zdroj a pravidlo výběru: TSL ČR (`tsl.gov.cz/publ/TSL_CZ.xtsl`), služby typu CA/QC se statusem
`granted`; anchor je jejich service digital identity (certifikát vydávající CA). Rooty, TLS/TSA CA a CA
mimo TSL se do bundlu nedávají — bundle proto **není** totéž co celý TSL a při změně TSL se porovnává ručně.

Expired intermediates (I.CA 2015/2016, eIdentity 3.1) jsou v bundle záměrně: podpis
s časovým razítkem se validuje k času razítka, ne k aktuálnímu datu. Signing trust store
`config/qes/postsignum.pem` zůstává bez nich.

Známé mezery (vědomé, ne bug): starší PostSignum Qualified CA 1/2/3 a self-signed I.CA qualified rooty
jsou v TSL `granted`, ale v bundlu nejsou — podpis certem z nich vyjde `valid_untrusted`. Nová I.CA
hierarchie (`I.CA QCA1/RSA v2 10/2026`) v TSL ze 2026-09-14 ještě není; přidá se přes
`QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/czech.pem,/cesta/qca1.pem`, až bude v TSL.

Regenerace: stáhnout PEM z webů CA (I.CA `ica.cz/en/root-certificates`, eIdentity
`eidentity.cz/certifikaty-certifikacnich-autorit`, NCA `narodni-ca.gov.cz/Dokumenty.aspx`,
KB `kb.cz/cs/certifikacni-sluzby-kb/kvalifikovane-certifikaty`), ponechat jen vydávající CA
z TSL a ověřit počet:

```bash
openssl crl2pkcs7 -nocrl -certfile config/qes/czech.pem \
  | openssl pkcs7 -print_certs -noout | grep -c '^subject'   # 15
make qes-test-qes
```

Testovací trust root: `QES_TRUST_ROOTS=test/certs/pki/root.crt` a
`QES_VERIFICATION_TRUST_ROOTS=test/certs/pki/root.crt` (AdES/QES fixtures). V CI `QES_TSA_URL` prázdné
(testy bez TSA); staging i produkční instance DigiCert free, I.CA test TSA jen lokálně. Tajemství jen přes
`fly secrets` / `.env`, nikdy do repa.

TSA trust roots: `QES_TSA_TRUST_ROOTS` je **povinné**, kdykoli je `QES_TSA_URL` nastavené —
bez něj dokončení skončí na `tsa_trust_not_configured`, protože razítko od nedůvěryhodné TSA
nesmí posunout hranici změn ani dát historický čas (SPEC § 7.6). Pro DigiCert stačí root
`config/qes/digicert-tsa.pem` (DigiCert Trusted Root G4, self-signed, platný do 2038).

```bash
QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem   # DigiCert free (AATL), obě prostředí
```

## Jak spustit harness

```bash
make qes-test           # RSpec na SQLite (jako staging), celá sada → test/out/qes-test-report.txt
make qes-test-qes        # jen QES vrstva (rychlá smyčka)
make qes-test-postgres   # paritní běh celé sady na Postgresu 18
make qes-e2e             # fork + podpis KÓDEM APPKY (varianta B) → validované PDF
make qes-e2e-two         # fork + 2 signeři jednoho dokumentu → 6 signatur (2× appka + 2× pečeť + 2× DocTS)
make qes-negative        # negativní scénáře N1–N17 (SPEC § 15.2)
make qes-staging-e2e     # staging + 2 signeři přes `fly ssh console` (QES_STAGING_SIGNERS=2)
make qes-staging-same-signer  # staging: stejný podepisující 2 pole → 6 signatur INTACT
make qes-e2e-card        # fork + podpis fake čipem (varianta A, test QSCD cert) → validované PDF
make qes-app-test        # Jest testy appky (vault, P12, signer, API)
make qes-app-typecheck   # TypeScript kontrola appky
```

`make qes-test-images` postaví test image (`test/qes/Dockerfile`, `Dockerfile.system`), runbook
harnessu je v `test/qes/README.md`.

## Jak ověřit podpis nezávislým validátorem

```bash
# podepsané PDF před pečetí (kritérium hotovo: INTACT:TRUSTED,UNTOUCHED)
.venv/bin/pyhanko sign validate --trust-replace --trust test/certs/pki/root.crt \
  "test/out/qes-signed.pdf"

# finální PDF (3 signatury: appka + pečeť + DocTS)
.venv/bin/pyhanko sign validate --trust-replace --trust test/certs/pki/root.crt \
  "test/out/qes-final.pdf"

pdfsig "test/out/qes-signed.pdf"     # "Signature is Valid." + "Total document signed"
qpdf --check "test/out/qes-final.pdf" # bez chyb
```

Očekávané výsledky (`make qes-e2e`, `make qes-e2e-card`, `make qes-e2e-pdf`):

- `qes-signed.pdf` → `Signature1:…:INTACT:TRUSTED,UNTOUCHED` (pokrývá celý dokument),
- `qes-final.pdf` → tři signatury; podpis appky `INTACT:TRUSTED,EXTENDED_WITH_FORM_FILLING,ACCEPTABLE_MODIFICATIONS`,
  pečeť `INTACT:UNTRUSTED,UNTOUCHED` (self-signed cert DocuSealu; na produkční instanci s I.CA rootem trusted),
  DocTS `TIMESTAMP_TOKEN<INTACT:UNTRUSTED>` (test trust list nemá DigiCert root; v Adobe je trusted),
- `documents` i `combined_document` v DocuSealu = kopie téhož finálního PDF (žádný další podpis),
- audit trail obsahuje stránku QES s cert/čas/hash/úrovní/výsledkem validace.

## Jak dohledat session

```bash
# stav, certifikát, hashe a validace
bin/rails runner 's = QesSession.order(:id).last
puts({ id: s.id, state: s.state, level: s.level, seal: s.seal_state,
       digest: s.document_digest, signed: s.signed_pdf_sha256,
       final: s.final_pdf_sha256, value: s.submitter.values[s.field_uuid] }.inspect)'
```

Logy: `fly logs` + filtr `[qes]` (strukturovaně: `session=… submission=… submitter=… state=… level=… code=…`).
Nikdy se nelogují tokeny, `data_to_sign`, raw signatury, PIN/QPIN ani obsah certifikátu (SPEC § 7.9).

## Troubleshooting

| Příznak | Příčina | Řešení |
|---|---|---|
| `422 not_qualified` | cert bez `QcCompliance` | použijte kvalifikovaný cert (I.CA/PostSignum) |
| `422 qes_required_qscd` | pole `preferences.level=qes`, cert bez `QcSSCD` | cert z čipu, nebo pole přepněte na `ades` |
| `422 level_mismatch` | `QcSSCD` cert poslaný jako `phone_keystore` | telefon není QSCD; použijte čtečku |
| `422 signature_size_exceeded` | finální CMS se nevešel do rezervy `/Contents` | zvyšte `QES_SIGNATURE_RESERVE` (TBS se staví před certifikátem, SPEC § 5.1a) |
| `ltv_unavailable` | cert má CRL DP a CRL nelze stáhnout (chybí allowlist / egress / DNS) | přidejte hosty do `QES_LTV_ALLOWED_HOSTS` (I.CA: `qcrldp1.ica.cz`, `qcrldp2.ica.cz`, `crldp1.ica.cz`, `crldp2.ica.cz`) a ověřte egress; hláška nově obsahuje odmítnutý host; `QES_REQUIRE_LTV=false` u certu s CRL DP nepomůže |
| `tsa_unavailable` | nedostupné TSA a `QES_TSA_REQUIRED=true` | nastavte `QES_TSA_URL`, nebo `QES_TSA_REQUIRED=false` |
| `pyhanko` → `UNTRUSTED` | chybí root v signing/verification trust store (podle toho, co se ověřuje), nebo v DSS/atributu nejsou revokační data | přidejte root (PEM) a CRL/OCSP do DSS |
| `pyhanko` → `EXTENDED_WITH_FORM_FILLING` | po podpisu appky přibyla pečeť | očekávané; podpis appky zůstává INTACT |
| `429 rate_limited` | příliš pokusů (60/5 min/IP, 10 selhaných tokenů) | počkejte, nebo zvyšte limity v `Qes::RateLimiter` |
| Pečeť se nepřidala (`seal_state=failed`) | chybí PKCS DocuSealu | nastavte `ESIGN_CERTS_KEY`, nebo `QES_SEAL_PKCS_PATH` (testy) |
| `InvalidConfigurationError` na SQLite | `DATABASE_URL=sqlite3:…` | použijte `PRIMARY_DATABASE_URL` (viz `test/qes/README.md`) |

## Limity v1.5

- Vícenásobní signeři na šablonu s polem `qes` (SPEC § 4.6): každý má vlastní pole `qes`,
  podepisuje se **striktně po sobě** a podpisy se řetězí inkrementálně (TBS dalšího = finální PDF
  předchozího); každá předchozí revize zůstává INTACT. Všechny strany musí podepisovat certifikátem
  (žádné kreslené podpisy v QES šabloně).
- Pečeť DocuSealu se aplikuje po každé QES session (N podpisů + N pečetí).
- Varianta A (čip) je client-side přes MOI Podpisové SDK; v této fázi je `StubCardSigner`
  (vrací `reader_not_found`), fake card mód `EXPO_PUBLIC_QES_FAKE_CARD=1` umí celý A tok
  s testovacím QSCD certem (`signer-qscd.p12`, server vyžaduje `key_location=card` → QcSSCD).
- ECDSA/RSA-PSS mimo v1 (HexaPDF 1.7 CMS umí jen RSA, SPEC § 4.2).
- Desktop varianta A, push notifikace a hromadné podepisování více dokumentů mimo v1 (SPEC § 17).

## Prostředí (Fly.io)

Od 2026-10-18 jsou nad stejným forkem dvě prostředí. Obě jsou **privátní instance uživatele**
(self-hosted software), ne centrální služba; uvedené URL jsou adresy těchto instancí a v jiném nasazení
se mění. „Produkce“ = instance s produkčním kódem, ne veřejná služba ani konkrétní URL.

| Prostředí | Instance / adresa | Volume | Trust roots | LTV |
|---|---|---|---|---|
| **Produkce** (privátní instance uživatele) | `dokulachtan` / <https://dokulachtan.fly.dev/> | `dokulachtan_prod_data` | jen PostSignum CA (`config/qes/postsignum.pem`) | `QES_REQUIRE_LTV=true` |
| **Staging** (privátní instance uživatele) | `dokulachtan-staging` / <https://dokulachtan-staging.fly.dev/> | `dokulachtan_stg_restore` | test root + PostSignum CA | `QES_REQUIRE_LTV=false` |

Konfigurace pro deploy: `deploy/docuseal/fly.toml` = produkční instance, `fly.staging.toml` = staging
(oba v parent repu, do forku se předávají přes `--config`).
Starý volume `dokulachtan_data` (testovací data prvotního stagingu) zůstává odpojený;
staging od 2026-10-18 běží na volume `dokulachtan_stg_restore` obnoveném ze snapshotu starého
staging volume (účet `<SMTP_FROM>` i šablona „QES E2E (staging)“ jsou k dispozici), produkční instance
na novém prázdném volume `dokulachtan_prod_data` (první účet přes `/setup`).

**Stejný podepisující 2 pole (2026-10-17):** `make qes-staging-same-signer` projde na stagingu —
druhý TBS se řetězí na první finální PDF téhož podepisujícího, finální PDF má 6 signatur
(2× appka + 2× pečeť + 2× DocTS) a všechny jsou INTACT; report v `test/out/qes-staging-same-signer-report.txt`.

**Zobrazení přehledu v poli (2026-10-17, release v16):** přehled podpisu se v poli dokumentu
vykresluje ve zkrácené variantě (`compact` — podbarvení, ikona, úroveň, podepisující, certifikát)
a nesmí přetékat; plná varianta zůstává v kartě podepisujícího. Krok už nehlásí `{{level}}`
(`qes_step.vue` skládá texty sám, kořenový `t` neinterpoluje). Třídy přehledu jsou v CSS balíčku
`form` (`tailwind.form.config.js` zahrnuje `app/views/submissions`). Ověřeno v prohlížeči na stagingu.

**Dva signeři (2026-10-17):** `make qes-staging-e2e` (`QES_STAGING_SIGNERS=2`) projde na stagingu —
finální PDF má 6 signatur (2× appka + 2× pečeť + 2× DocTS), všechny INTACT a `openssl verify`
potvrdí řetěz test certu vůči test trust rootu. **LTV (2026-10-22):** revokační data (CRL) jdou jen
do **DSS** (`/DSS` s `/CRLs`, `/Certs` a `/VRI` s SHA-1 `/Contents` podpisu appky); CMS LTV
(ETSI `RevocationValues` + Adobe `adbe-revocationInfoArchival`) se nepoužívá — pyHanko unsigned
atributy nečte a jen zvětšovaly PDF. Po pečeti se přidá **DocTS** (DigiCert TSA, `ETSI.RFC3161`),
který DSS kryje; offline `pyhanko ades_lta_validation` s `allow_fetching=False` je kritérium.
Na stagingu mají test certy CRL DP i na staging hostu (`QES_TEST_CRL_PATH`) a `QES_REQUIRE_LTV=false`,
takže CRL je dostupné; `127.0.0.1:8765` se ignoruje. Reálné PostSignum certy CRL dostanou (jejich CRL DP jsou veřejné
a musí být v `QES_LTV_ALLOWED_HOSTS`). Na produkční instanci jsou CRL hosty PostSignum (`crl.postsignum.cz`,
`crl2.postsignum.cz`, `crl.postsignum.eu`) i I.CA (`qcrldp1.ica.cz`, `qcrldp2.ica.cz`, `crldp1.ica.cz`,
`crldp2.ica.cz`) **http**, proto musí být v `QES_LTV_ALLOWED_HOSTS` —
bez allowlistu kód vyžaduje https a reálný podpis s `QES_REQUIRE_LTV=true` by skončil na
`ltv_unavailable` (ověřeno na produkční instanci 2026-10-18). Podpis certem I.CA navíc potřebuje její roots
v `QES_TRUST_ROOTS`; bez nich selže dřív, na `not_trusted`. Reálný CRL PostSignum Qualified CA 4 má
812 863 B a je v PDF jen jednou (DSS) → finální PDF ~0,9 MB; rezerva `/Contents` je pevná
`QES_SIGNATURE_RESERVE` (default 64 KB), protože TBS se staví před certifikátem (SPEC § 5.1a, § 7.1, § 7.4, § 7.6).

**Negativní scénáře:** `make qes-negative` (N1–N17) proti lokálnímu forku → `test/out/qes-negative-report.txt`.

```bash
# staging (deploy/docuseal/fly.staging.toml, APP=dokulachtan-staging)
# Defaulty: QES_ENABLED=true, PostSignum CRL hosty a signing roots, české CA pro ověření,
# DigiCert TSA, require_ltv=true. Staging přepisuje test root, require_ltv, test CRL a allowlist.
QES_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/postsignum.pem
QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/czech.pem
#   root.crt = testovací root (testovací APK); postsignum.pem = reálné PostSignum certy pro podpis;
#   czech.pem = vydávající CA pro ověření (anchory; PostSignum, I.CA, eIdentity, NCA, KB), ne rooty
QES_PUBLIC_BASE_URL=https://dokulachtan-staging.fly.dev
QES_ANDROID_CERT_SHA256=FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C  # debug keystore; lokální bleeding-edge build
QES_REQUIRE_LTV=false
QES_TEST_CRL_PATH=/app/config/qes/test-root.crl
QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,dokulachtan-staging.fly.dev
#   test cert má CRL DP na staging host → staging CRL je dostupné; 127.0.0.1 se ignoruje
#   explicitní hodnota nahrazuje default → kdo na stagingu podepisuje certem I.CA,
#   musí sem doplnit i její hosty (qcrldp1/qcrldp2/crldp1/crldp2.ica.cz)

# produkce = privátní instance uživatele (deploy/docuseal/fly.toml, APP=dokulachtan)
# Defaulty pokrývají QES_ENABLED, signing trust roots (PostSignum),
# verification trust roots (české CA), LTV hosty, TSA i require_ltv.
# Explicitně zůstává jen veřejná URL a fingerprint Android podpisu APK.
QES_PUBLIC_BASE_URL=https://dokulachtan.fly.dev
QES_ANDROID_CERT_SHA256=FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C  # debug keystore; při produkčním APK 80:DC:...:E0
```

**Český verification trust store (2026-10-28):** produkční instance **v52**
(`deployment-01M61T89AGF8RJPMPQ5F1TSC0Y`), staging **v25**
(`deployment-01M61RKSP8C594JRPAEKTR3VZT`), obě z forku `cfd36b2c`. Signing
`QES_TRUST_ROOTS` zůstává PostSignum (prod 6; staging test root + 6 PostSignum = 7),
verification `QES_VERIFICATION_TRUST_ROOTS` je `czech.pem` (prod 15; staging test root + 15 = 16).
`/up` 200, `POST /api/qes/verify` a `/api/qes/documents` → 401, `/qes-test/root.crl` → 404;
`make qes-staging-e2e` (6 signatur) a `qes-staging-e2e-pdf` (3 signatury) zelené.

Testovací data na stagingu: šablona **„QES E2E (staging)"** s polem `qes` (úroveň AdES) —
slouží k vyzkoušení toku z appky (nebo ji smažte).

### APK pro testování

Testovací build appky (debug podpis, testovací certifikát v appce) je ke stažení na:

**<https://dokulachtan-download.fly.dev/dokulachtan-signer.apk>**

- `deploy/apk/` obsahuje nginx image s APK (build se negituje, `deploy/apk/*.apk` je v `.gitignore`).
- Build pro telefon: `cd mobile/app && npx expo prebuild --platform android && cd android &&
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` (bez `ANDROID_KEYSTORE_PATH` = debug keystore
  pro lokální build; release v CI viz `deploy/android-release/README.md`).
  `mobile/app/plugins/withApkSize.js` při prebuildu nastaví komprimované `.so` (`expo.useLegacyPackaging`),
  `shrinkResources` a výchozí ABI `x86_64` pro emulátor; release build bez `arm64-v8a` spadne
  s chybou, aby se nevydal APK, který na telefon nejde nainstalovat.
- Velikost APK: univerzální build se 4 ABI a nekomprimovanými `.so` má ~92 MB; release jen arm64
  s deflate a `shrinkResources` ~14 MB (emulátor/testy jedou na x86_64 debug buildu).
- GitHub Actions: `.github/workflows/android-release.yml` — push tagu `v*` sestaví APK a vytvoří release
  s přiloženým APK (verze z tagu se zapíše do `app.json`); podpis ověří proti
  `ANDROID_RELEASE_CERT_SHA256` a když nesedí, release nevytvoří.
- `QES_ANDROID_CERT_SHA256` na stagingu odpovídá **debug** podpisu (lokální bleeding-edge build);
  release APK z CI by vyžadoval release fingerprint (`deploy/android-release/`).
  Testovací APK na `dokulachtan-download.fly.dev` je debug, takže App Links na produkční instanci teď sedí.
- Deep link ověřen na emulátoru: `adb shell am start -a android.intent.action.VIEW -d "dokulachtan://sign?token=…&server=https%3A%2F%2Fdokulachtan-staging.fly.dev"`
  → appka otevře S4 s názvem dokumentu, podepisujícím, úrovní a otiskem z reálného stagingu.
- **TOFU (trust on first use):** podpisový odkaz nese origin serveru (HTTPS host nebo `server`
  u custom scheme). Při prvním odkazu z neznámého serveru appka token neodešle a zobrazí
  „Neznámý server“ s originem; po potvrzení se origin uloží do `dataStorage` a další odkazy
  z něj jdou bez potvrzení. V *Nastavení → Důvěryhodné servery pro podpisové odkazy* je seznam
  s tlačítkem „Odvolat“; odvolání znamená, že se příští odkaz z toho serveru znovu potvrdí.
  *Nastavení → Server URL + API token* se používá **jen** pro přímý podpis PDF a ověření PDF;
  podpisové odkazy ho nepoužívají. Server shodný s Nastavením je pro podpisové odkazy
  důvěryhodný bez TOFU (v seznamu je označený „Server z Nastavení“). Odkaz bez serveru skončí `missing_server` (žádný tichý
  fallback do Nastavení); `server_url` z payloadu musí odpovídat originu odkazu, jinak appka
  vrátí `foreign_server`. Serverová část TOFU je ve forku `f1c28c2b`; na produkčních instancích
  (v52/v25, fork `cfd36b2c`) zatím není nasazená — před použitím TOFU odkazu nasadit.

### iOS build a instalace na iPhone

Appka je cross-platform (Expo moduly, krypto v JS), takže se iOS build dělá přes **EAS Build**
(cloud, bez Macu). Placený **Apple Developer Program** (99 USD/rok) je potřeba pro build
nainstalovatelný na fyzický iPhone (ad hoc) i pro TestFlight; free Apple ID EAS nepodporuje.

Předpoklady (jednorázově):

- Expo účet přihlášený v `eas-cli` (`npx eas whoami`) a projekt na EAS — hotovo:
  `@slush0/dokulachtan-signer` (ID `743b363a-4513-4346-9fbd-d8879dca3fb3`, v `app.json`).
- Apple Developer Program + Apple ID; distribuční certifikát a provisioning profile si EAS vytvoří sám
  (v Apple portálu není potřeba nic dělat).

Ad hoc (interní distribuce, nejrychlejší cesta na iPhone):

1. `npx eas device:create` → vyber iPhone → pošli testerovi odkaz; ten ho otevře **v Safari**,
   nainstaluje profil (zaregistruje UDID) a profil zase smaže. Zařízení: `npx eas device:list`.
2. `npx eas build -p ios --profile preview` — **interaktivně** (v `--non-interactive` EAS
   credentials nevytvoří): přihlas se Apple ID + 2FA, na dotazy „Generate a new Apple Distribution
   Certificate?“ / „Generate a new Apple Provisioning Profile?“ odpověz **Yes**. Build běží v cloudu ~15 min.
3. EAS vypíše instalační URL stránky buildu; tester ji otevře **v Safari na iPhonu** → „Install“.
4. Při prvním spuštění iOS odmítne neznámého vývojáře: **Nastavení → Obecné → VPN a správa
   zařízení → profil vývojáře → Důvěřovat**.
5. Nové zařízení = nový `eas device:create` + **nový build** (profil se musí přegenerovat);
   u nového členství může Apple registraci zařízení zpozdit až 24–72 h a první build selhat.

TestFlight (pro širší testování, build vyprší za 90 dní):

1. `npx eas build -p ios --profile production`
2. `npx eas submit -p ios --profile production` → nahraje build do App Store Connect.
3. App Store Connect → TestFlight → interní testeři (až 100, bez review); pozvánka e-mailem,
   tester si nainstaluje TestFlight z App Store.

Na co nezapomenout:

- `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` v `app.json` (jinak se exportní compliance
  musí ručně vyřešit v App Store Connect před testováním).
- `QES_IOS_TEAM_ID` na stagingu = Apple Team ID (jinak je v AASA placeholder `TEAMID`
  a Universal Links se neověří); zjistíš ho v Apple Developer portálu (Membership).
- Universal Links vyžadují `ios.associatedDomains` v `app.json` + placený účet; custom scheme
  `dokulachtan://sign?token=…&server=<origin>` funguje vždy (i v ad hoc buildu).
- Varianta A (čtečka) na iOS nefunguje — MOI Podpisové SDK je Android AAR; odkaz „Připojit čtečku“
  se v appce na iOS nezobrazuje (varianta B je plně přenositelná).

## Jak ověřit podpis v DocuSealu

1. **Pole `qes` v detailu submission** — místo interního tokenu `qes:<id>` se zobrazuje metadata:
   zelený/červený check + „Podpis je platný/neplatný", badge úrovně (ADES/QES), kdo podepsal,
   certifikát (subject/issuer/serial), umístění klíče, čas podpisu, validace
   (valid · trusted · coverage), stav pečeti DocuSealu a odkaz na audit log.
   V kartě podepisujícího je navíc řádek „Podepsáno certifikátem (ADES/QES)".
2. **Audit trail PDF** (tlačítko *Audit Log*) — stránka QES s plnými metadaty a výsledkem validace.
3. **Vestavěná verifikace PDF** — *Nastavení → eSignature* (`/settings/esign`), nahraj finální PDF;
   DocuSeal ho ověří Pdfiem (nezávisle na naší DB): ukáže common name podepisujícího, platnost
   a důvěryhodnost vůči trusted certům účtu.
4. **Nezávislý validátor (CLI)**:
   `pyhanko sign validate --trust-replace --trust test/certs/pki/root.crt <pdf>`
   (`INTACT:TRUSTED,UNTOUCHED`) a `pdfsig <pdf>` („Signature is Valid" / „Total document signed").
