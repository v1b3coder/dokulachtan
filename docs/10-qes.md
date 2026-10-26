# 10 — QES runbook (ENV, TSA, trust roots, troubleshooting)

Provozní příručka QES vrstvy forku. Vzniká v P0.6, doplňuje SPEC § 11 a § 15.
Vše níže je **změřené** (2026-10-16), ne odhad.

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
| TSA | DigiCert free (`http://timestamp.digicert.com`, AATL) na stagingu i produkci; v CI/testech prázdné |

## Konfigurace (ENV)

| ENV | Default | Význam |
|---|---|---|
| `QES_ENABLED` | `false` | vypínač QES (staging/produkce) |
| `QES_SESSION_TTL` | `600` | platnost session [s] |
| `QES_SIGNATURE_SIZE` | `20000` | placeholder signatury (rezerva `/Contents`) [B] |
| `QES_SIGNATURE_MIN_SIZE` | `20000` | minimální rezerva `/Contents` [B] |
| `QES_SIGNATURE_SIZE_MARGIN` | `16384` | marže nad odhad CMS (TSA token, změna CRL) [B] |
| `QES_DEEP_LINK_BASE` | `dokulachtan://sign` | custom scheme |
| `QES_PUBLIC_BASE_URL` | `APP_URL` | host pro universal links |
| `QES_TRUST_ROOTS` | — | cesty k CA certům (PEM, čárkou oddělené; soubor může obsahovat víc certů) |
| `QES_TSA_URL` | — | RFC 3161 TSA; produkce/staging `http://timestamp.digicert.com` (free, AATL), kvalifikované I.CA/PostSignum |
| `QES_TSA_TRUST_ROOTS` | — | cesty k rootům TSA (PEM, čárkou oddělené); **povinné** když je `QES_TSA_URL` nastavené |
| `QES_TSA_REQUIRED` | `true` | vyžadovat TSA token (produkce/staging `true`) |
| `QES_REQUIRE_LTV` | `false` (testy), `true` (produkce) | vyžadovat revokační data |
| `QES_LTV_ALLOWED_HOSTS` | — | allowlist hostů pro CRL/OCSP (SSRF ochrana; čárkou oddělené) |
| `QES_ANDROID_CERT_SHA256` | — | fingerprint pro `assetlinks.json` |
| `QES_IOS_TEAM_ID` | — | pro AASA |
| `QES_EXPIRY_JOB_INTERVAL` | `60` | perioda expiračního jobu [s]; `0` = vypnuto |
| `QES_SEAL_PKCS_PATH` + `QES_SEAL_PKCS_PASSWORD` | — | jen pro testy (PKCS#12 pečeti); jinak `Accounts.load_signing_pkcs` |

Trust roots: `Qes::Validator` staví OpenSSL store z `QES_TRUST_ROOTS` **a z intermediate certifikátů
z CMS** (SPEC § 7.5), takže v seznamu stačí root; leaf se ověřuje řetězem (self-signed certifikát
projde jen když je sám sobě rootem — a pak `422 not_trusted`, SPEC § 5.2).

Staging má v `QES_TRUST_ROOTS` vedle testovacího rootu i reálné PostSignum CA
(`config/qes/postsignum.pem`: Root QCA 4 + Qualified CA 4/5 + Root QCA ECC R1 + Qualified ECC R1 CA1/CA3),
takže testovací cert je trusted proti test rootu a reálné PostSignum certy proti PostSignum CA.

Testovací trust root: `QES_TRUST_ROOTS=test/certs/pki/root.crt`. V CI `QES_TSA_URL` prázdné
(testy bez TSA); staging/produkce DigiCert free, I.CA test TSA jen lokálně. Tajemství jen přes
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
make qes-e2e-two         # fork + 2 signeři jednoho dokumentu → 4 signatury (2× appka + 2× pečeť)
make qes-negative        # negativní scénáře N1–N9 (SPEC § 15.2)
make qes-staging-e2e     # staging + 2 signeři přes `fly ssh console` (QES_STAGING_SIGNERS=2)
make qes-staging-same-signer  # staging: stejný podepisující 2 pole → 4 signatury INTACT
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

# finální PDF (2 signatury: appka + pečeť)
.venv/bin/pyhanko sign validate --trust-replace --trust test/certs/pki/root.crt \
  "test/out/qes-final.pdf"

pdfsig "test/out/qes-signed.pdf"     # "Signature is Valid." + "Total document signed"
qpdf --check "test/out/qes-final.pdf" # bez chyb
```

Očekávané výsledky (`make qes-e2e` a `make qes-e2e-card`, 2026-10-16):

- `qes-signed.pdf` → `Signature1:…:INTACT:TRUSTED,UNTOUCHED` (pokrývá celý dokument),
- `qes-final.pdf` → dvě signatury; podpis appky `INTACT:TRUSTED,EXTENDED_WITH_FORM_FILLING,ACCEPTABLE_MODIFICATIONS`,
  pečeť `INTACT:UNTRUSTED,UNTOUCHED` (self-signed cert DocuSealu; v produkci s I.CA rootem trusted),
- `documents` i `combined_document` v DocuSealu = kopie téhož finálního PDF (žádný třetí podpis),
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
| `422 signature_size_exceeded` | finální CMS se nevešel do rezervy `/Contents` | zvyšte `QES_SIGNATURE_SIZE_MARGIN` (rezerva se počítá z odhadu CMS včetně CRL) |
| `ltv_unavailable` | nedostupné OCSP/CRL a `QES_REQUIRE_LTV=true` | spusťte CRL/OCSP endpoint, nebo `QES_REQUIRE_LTV=false` |
| `tsa_unavailable` | nedostupné TSA a `QES_TSA_REQUIRED=true` | nastavte `QES_TSA_URL`, nebo `QES_TSA_REQUIRED=false` |
| `pyhanko` → `UNTRUSTED` | chybí root v `QES_TRUST_ROOTS`, nebo v DSS/atributu nejsou revokační data | přidejte root (PEM) a CRL/OCSP do DSS |
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

Od 2026-10-18 jsou nad stejným forkem dvě prostředí:

| Prostředí | App / URL | Volume | Trust roots | LTV |
|---|---|---|---|---|
| **Produkce** | `dokulachtan` / <https://dokulachtan.fly.dev/> | `dokulachtan_prod_data` | jen PostSignum CA (`config/qes/postsignum.pem`) | `QES_REQUIRE_LTV=true` |
| **Staging** | `dokulachtan-staging` / <https://dokulachtan-staging.fly.dev/> | `dokulachtan_stg_restore` | test root + PostSignum CA | `QES_REQUIRE_LTV=false` |

Konfigurace pro deploy: `deploy/docuseal/fly.toml` = produkce, `fly.staging.toml` = staging
(oba v parent repu, do forku se předávají přes `--config`).
Starý volume `dokulachtan_data` (testovací data prvotního stagingu) zůstává odpojený;
staging od 2026-10-18 běží na volume `dokulachtan_stg_restore` obnoveném ze snapshotu starého
staging volume (účet `<SMTP_FROM>` i šablona „QES E2E (staging)“ jsou k dispozici), produkce
na novém prázdném volume `dokulachtan_prod_data` (první účet přes `/setup`).

Staging `https://dokulachtan-staging.fly.dev/` běží s QES vrstvou (`QES_ENABLED=true`). Ověřeno 2026-10-16
end-to-end: podpis **kódem appky** proti stagingu (`scripts/qes_staging_app_flow.py`),
finální PDF validované pyHanko (`INTACT:TRUSTED,UNTOUCHED`).

**Stejný podepisující 2 pole (2026-10-17):** `make qes-staging-same-signer` projde na stagingu —
druhý TBS se řetězí na první finální PDF téhož podepisujícího, finální PDF má 4 signatury
(2× appka + 2× pečeť) a všechny jsou INTACT; report v `test/out/qes-staging-same-signer-report.txt`.

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
Na stagingu CRL DP test certů (`127.0.0.1:8765`) dostupné není a `QES_REQUIRE_LTV=false`, proto
se do DSS vloží jen certy; reálné PostSignum certy naopak CRL dostanou (jejich CRL DP jsou veřejné
a musí být v `QES_LTV_ALLOWED_HOSTS`). Na produkci jsou CRL hosty PostSignum (`crl.postsignum.cz`,
`crl2.postsignum.cz`, `crl.postsignum.eu`) **http**, proto musí být v `QES_LTV_ALLOWED_HOSTS` —
bez allowlistu kód vyžaduje https a reálný podpis s `QES_REQUIRE_LTV=true` by skončil na
`ltv_unavailable` (ověřeno na produkci 2026-10-18). Reálný CRL PostSignum Qualified CA 4 má
812 863 B a je v PDF jen jednou (DSS) → finální PDF ~0,9 MB; rezerva `/Contents` je
`Qes::CmsBuilder.estimate_size` + `QES_SIGNATURE_SIZE_MARGIN` (SPEC § 7.1, § 7.4, § 7.6).

**Negativní scénáře:** `make qes-negative` (N1–N9) proti lokálnímu forku → `test/out/qes-negative-report.txt`.

```bash
# staging (deploy/docuseal/fly.staging.toml, APP=dokulachtan-staging)
QES_ENABLED=true
QES_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/postsignum.pem
#   root.crt = testovací root (testovací APK), postsignum.pem = reálné PostSignum CA
#   (Root QCA 4 + Qualified CA 4/5 + Root QCA ECC R1 + Qualified ECC R1 CA1/CA3)
QES_PUBLIC_BASE_URL=https://dokulachtan-staging.fly.dev
QES_ANDROID_CERT_SHA256=<sha256 debug keystore appky>  # pro /.well-known/assetlinks.json
QES_TSA_URL=http://timestamp.digicert.com   # DigiCert free (AATL), non-qualified
QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem
QES_TSA_REQUIRED=true
QES_REQUIRE_LTV=false   # testovací CRL DP (127.0.0.1:8765) není ze stagingu dostupné

# produkce (deploy/docuseal/fly.toml, APP=dokulachtan)
QES_ENABLED=true
QES_TRUST_ROOTS=/app/config/qes/postsignum.pem   # jen reálné PostSignum CA, bez test rootu
QES_PUBLIC_BASE_URL=https://dokulachtan.fly.dev
QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu
QES_TSA_URL=http://timestamp.digicert.com   # DigiCert free (AATL), non-qualified
QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem
QES_TSA_REQUIRED=true
QES_REQUIRE_LTV=true     # CRL se stahují a vkládají do CMS; ověřeno 2026-10-18
```

Ověřeno 2026-10-18 na novém stagingu: `make qes-staging-e2e` → 4 signatury INTACT, `trusted: true`,
`trusted_roots` = test root + 6× PostSignum (`test/out/qes-staging-e2e-report.txt`);
`make qes-staging-e2e-pdf` → 2 signatury INTACT, `trusted: true`
(`test/out/qes-pdf-staging-report.txt`).

Testovací data na stagingu: šablona **„QES E2E (staging)"** s polem `qes` (úroveň AdES) —
slouží k vyzkoušení toku z appky (nebo ji smažte).

### APK pro testování

Testovací build appky (debug podpis, testovací certifikát v appce) je ke stažení na:

**<https://dokulachtan-download.fly.dev/dokulachtan-signer.apk>**

- `deploy/apk/` obsahuje nginx image s APK (build se negituje, `deploy/apk/*.apk` je v `.gitignore`).
- Build: `cd mobile/app && npx expo prebuild --platform android && cd android && ./gradlew assembleRelease`.
- GitHub Actions: `.github/workflows/android-release.yml` — push tagu `v*` sestaví APK a vytvoří release
  s přiloženým APK (verze z tagu se zapíše do `app.json`); otisk podpisu vypíše do logu.
- `QES_ANDROID_CERT_SHA256` na stagingu odpovídá podpisu tohoto buildu, takže `assetlinks.json`
  na stagingu sedí; build APK ale deklaruje jen host `dokulachtan.fly.dev`, proto HTTPS App Links
  na stagingu appku neotevřou — použij tlačítko „Otevřít appku“ (custom scheme
  `dokulachtan://sign?token=…`, funguje vždy) a v appce přepni *Nastavení → Server URL* na staging.
- Deep link ověřen na emulátoru: `adb shell am start -a android.intent.action.VIEW -d "dokulachtan://sign?token=…"`
  → appka otevře S4 s názvem dokumentu, podepisujícím, úrovní a otiskem z reálného stagingu.

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
  `dokulachtan://sign?token=…` funguje vždy (i v ad hoc buildu).
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
