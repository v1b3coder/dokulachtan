# AGENTS.md — dokulachtan

Hlavní rozcestník projektu. Detaily jsou v `docs/`; tento soubor drží cíl, rozhodnutí a provoz.

## Co je cílem

Přidat do [DocuSeal](https://github.com/docusealco/docuseal) podporu podpisu **certifikátem**
(AdES/QES) tak, aby klíč zůstal u člověka (v telefonu nebo v čipu občanky) a nikdy se nenahrál
na server. Výsledkem je upravený DocuSeal (fork) + mobilní appka.

- **Závazný koncept (co a proč): [DESIGN.md](DESIGN.md)** — aplikační design celého workflow a appky.
- **Detailní specifikace (jak přesně): [SPEC.md](SPEC.md)** — datový model, API, protokol,
  obrazovky, testy; odvozená z DESIGN.md. **Implementační plán: [PLAN.md](PLAN.md)** — fáze P0–P7.
  Když si dokumenty odporují, je to chyba: opraví se DESIGN.md (historie oprav v SPEC § 16).
  Řetěz je: **DESIGN → SPEC → implementace**.
- Fork: [docusealco/docuseal](https://github.com/docusealco/docuseal), naše větev **`dokulachtan`**,
  pravidla v [docs/08-fork-workflow.md](docs/08-fork-workflow.md).
- Uživatel: **zaměstnanci firmy**, podepisuje se **hlavně z mobilu**.

## High-level design rozhodnutí

1. **Jen self-custody, žádný remote QTSP.** Klíč je v čipu občanky (varianta **A**) nebo v telefonu
   (varianta **B**). Žádné OAuth, CSC ani poplatky za podpis, žádná důvěra v poskytovatele.
2. **Varianta B (telefon) je hlavní cesta** — většina dokumentů potřebuje AdES, ne QES.
   **Varianta A (občanka) je doplňková** pro QES. Detail: [docs/04-architektura-fork.md](docs/04-architektura-fork.md).
3. **Vše v DocuSealu (fork), žádný sidecar.** Jedna aplikace, jedna evidence, jeden audit.
   Podepsaný dokument zůstává v DocuSealu.
4. **Mobilní appka: Expo** (React Native). Import PKCS#12, bezpečné úložiště + biometrie, deep link,
   podpis podepsaných atributů CMS (ne digestu dokumentu). Detail: [docs/07-pred-implementaci.md](docs/07-pred-implementaci.md).
5. **Varianta A musí být client-side** (čtečka je u uživatele, ne v cloudu) — v cloudu ji řeší appka /
   lokální agent, ne server.
6. **Ověřeno, že to jde:** e2e toolchain, DocuSeal API baseline, negativní/LTV scénáře, mobile PoC
   (telefon podepsal, server vložil PAdES, validováno). Detail: [docs/05-e2e-testovani.md](docs/05-e2e-testovani.md).

## Rozhodnutí ze SPEC.md (potvrzeno 2026-10-15)

7. **Dvoukrokový protokol server ↔ appka.** Server nezná certifikát podepisujícího předem, proto:
   `GET /qes/sessions/:token` (metadata) → `POST …/certificate` (cert → `data_to_sign`) → `POST …/complete`
   (raw signatura). Detail: SPEC § 5.
8. **LTV jde do DSS** (`/DSS` s `/CRLs`, `/Certs` a `/VRI`), ne do CMS — HexaPDF 1.7 LTV neumí
   (ověřeno ve zdrojích 1.7–1.11) a pyHanko unsigned CMS atributy nečte. Detail: SPEC § 7.4 a § 16.
9. **Varianta A = oficiální MOI Podpisové SDK** v appce (AAR, zdarma, bez modifikace, s attribution),
   ne vlastní PKCS#11 na serveru. Čtečky: ACR 3901 U-S1, bR301 BLE (černá), CT 1100, AirID 2 (+ USB OTG).
   Detail: SPEC § 9.4.
10. **Pečeť DocuSealu** se přidává **inkrementálně až po** podpisu appky; podpis appky zůstává INTACT.
    Vzhled podpisu je neviditelný. Detail: SPEC § 7.6.
11. **Firemní podpisy: více stakeholderů, všichni podepisují certifikátem** (rozhodnutí uživatele 2026-10-17).
    Každý signer má vlastní pole `qes` a vlastní `QesSession`; podpisy jdou striktně po sobě a řetězí se
    inkrementálně (PAdES multi-signature): TBS dalšího = finální PDF předchozího, každá předchozí revize
    zůstává INTACT. Pečeť DocuSealu se aplikuje po každé session. Detail: SPEC § 4.6 a § 7.1,
    návrh `docs/13-navrh-vicenasobnych-podpisu.md`.
12. **Dev/test na SQLite** (stejná DB jako staging — dev/prod parita a tlak na DB-agnostický kód).
    `make qes-test` = SQLite (`PRIMARY_DATABASE_URL=sqlite3:db/qes-test.sqlite3`, `SCHEMA=tmp/qes-test-schema.rb`,
    test image `test/qes/Dockerfile` + `test/qes/Dockerfile.system`, celá sada kromě `spec/system/dashboard_spec.rb`),
    `make qes-test-postgres` = Postgres 18 (parita s upstream CI, celá sada), `make qes-test-qes` = jen QES vrstva.
    Změřeno 2026-10-16: SQLite 243/1 (upstream flake `signing_form_spec.rb:1253`), Postgres 247/0.
    Detail: SPEC § 15.1 a § 22, PLAN 0.2, runbook `test/qes/README.md`.
13. **Při podpisu se nikdy nezadává heslo** (rozhodnutí uživatele 2026-10-16): heslo k PKCS#12 se používá
    výhradně při importu; klíčový materiál se ihned přešifruje AES-256-GCM klíčem z vaultu a při podpisu
    se odemyká jen biometrií. Detail: SPEC § 9.5.
14. **Volba podepisujícího je automatická** (rozhodnutí uživatele 2026-10-16): dle `level_required` — pro QES čtečka,
    pro AdES klíč → čtečka → konfigurační wizard S10 (import klíče / nastavení čtečky); appka se neptá.
    Server cert podepisujícího předem nezná. Detail: SPEC § 9.8, DESIGN § 5.2.
15. **Přímý podpis PDF nativním tokem DocuSealu** (rozhodnutí uživatele 2026-10-18): přímý podpis = **šablona**
    s polem `qes` + **submission** + dnešní obřad; fork přidává jediný endpoint `POST /api/qes/documents`
    (upload PDF → šablona ve složce „Direct signing“) a API token pro spuštění obřadu. Dokument je v účtu vidět
    (Documents), lze ho stáhnout, sdílet i smazat; DocuSeal generuje auditní stránku. Předchozí vlastní vrstva
    (`QesPdfSession` a spol.) byla revertnuta — maximum vlastního kódu, minimum užitku.
    Detail: `docs/15-primy-podpis-pdf.md`, SPEC § 4.8/§ 5.8/§ 9.9.
16. **Defaulty pro český deployment jsou ve forku** (rozhodnutí uživatele 2026-10-28): `QES_ENABLED=true`,
    PostSignum CRL hosty, PostSignum trust roots, DigiCert TSA a `QES_REQUIRE_LTV=true` jsou
    výchozí v `Qes::Config::DEFAULTS`; ENV je jen override. Produkce tak v secrets drží jen
    `QES_PUBLIC_BASE_URL` a `QES_ANDROID_CERT_SHA256`; staging přepisuje trust roots,
    `QES_REQUIRE_LTV=false`, test CRL a allowlist. Detail: SPEC § 7.4 a § 11, `docs/10-qes.md`.

## Deployment

**Dvě prostředí, varianta A — 1 Fly app + volume + SQLite** (bez Postgresu), region `fra`.
Konfigurace v parent repu: `deploy/docuseal/fly.toml` = produkce, `fly.staging.toml` = staging;
do forku se předávají přes `--config` (`make deploy-prod` / `make deploy-staging`).

### Android podpisy vs. certifikáty — nepřekrývat

V projektu jsou **dvě nezávislé věci**; v textech se nesmí plést:

| Co | K čemu | Debug/test build | Produkce |
|---|---|---|---|
| **Android signing key** (podpis APK) | integrita APK, App Links, aktualizace | `debug.keystore`, fingerprint `FA:C6:17:45:…:3B:9C` | release keystore `deploy/android-release/dokulachtan-release.jks`, fingerprint `80:DC:86:EF:…:C3:E0`; jen CI/distribuce |
| **Certifikát pro podpis dokumentů** (AdES/QES) | podpis PDF, trust roots na serveru | testovací cert v APK pro E2E; uživatel jinak importuje vlastní `.p12` | uživatel importuje **PostSignum** `.p12` nebo použije čtečku; signing trust store má jen PostSignum, verification trust store české CA |

- **Testovací APK** na `dokulachtan-download.fly.dev` = Gradle `release` varianta **s debug Android podpisem** (standalone JS bundle, `arm64-v8a`, testovací dokumentový cert + stub čtečky). Není to produkční APK.
- **Produkční APK** = `assembleRelease` s `ANDROID_KEYSTORE_PATH` + `deploy/android-release/release.properties`, podepsaný release keystorem; jen CI/distribuce, nikdy testovací APK.
- **Gradle `release` varianta ≠ produkční podpis.** Rozhoduje `ANDROID_KEYSTORE_PATH`, ne název varianty.
- **PostSignum certy** s Android podpisem APK nesouvisí: signing `QES_TRUST_ROOTS` má jen PostSignum, verification `QES_VERIFICATION_TRUST_ROOTS` české CA (`czech.pem`), staging navíc test root; appka používá cert, který uživatel importuje (`.p12`), případně čtečku. Testovací cert v APK je jen pro E2E, ne pro produkční podpis dokumentů.
- `QES_ANDROID_CERT_SHA256` na Fly = fingerprint **Android podpisu testovacího APK** (nyní debug `FA:C6:…:9C`), ne cert dokumentu. Při nasazení produkčního APK z CI se přepne na `80:DC:…:E0`.
- Testovací telefon s debug-signed APK **nejde** aktualizovat produkčním APK přes `adb install -r` (jiný podpis); vyžaduje uninstall a nový import `.p12`.

**Pravidlo pro texty:** vždy piš „Android podpis APK“ nebo „certifikát pro podpis dokumentů“; samotné „certifikát“ nebo „produkční certifikát“ je zakázané, protože oba významy se pletou.

| Prostředí | App / URL | Volume | Trust roots | LTV |
|---|---|---|---|---|
| **Produkce** | `dokulachtan` / <https://dokulachtan.fly.dev/> | `dokulachtan_prod_data` | jen PostSignum CA | `true` |
| **Staging** | `dokulachtan-staging` / <https://dokulachtan-staging.fly.dev/> | `dokulachtan_stg_restore` | test root + PostSignum CA | `false` |

**Produkce `dokulachtan`** (rozděleno 2026-10-18):

- machine `811d97df9d6e08`, volume `dokulachtan_prod_data` (1 GB, `fra`, snapshoty) → `/data/docuseal`;
  starý volume `dokulachtan_data` (testovací data, tabulka `qes_pdf_sessions`) byl **smazán 2026-10-18**
  (`fly volumes destroy`); tabulka `qes_pdf_sessions` po zrušené vlastní vrstvě zůstala jen v DB, kde
  vznikla — migrace byla při squashi historie odstraněna (2026-10-23), v nových DB už nevznikne.
- Defaulty forku pokrývají `QES_ENABLED=true`, `QES_TRUST_ROOTS=/app/config/qes/postsignum.pem`
  (signing: jen reálné PostSignum CA), `QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/czech.pem`
  (verification: PostSignum, I.CA, eIdentity, NCA, KB), `QES_REQUIRE_LTV=true`,
  `QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu`,
  `QES_TSA_URL=http://timestamp.digicert.com`, `QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem`,
  `QES_TSA_REQUIRED=true` (DigiCert free, AATL; kvalifikované TSA zatím nekupujeme);
  v secrets zůstává jen `QES_PUBLIC_BASE_URL` a `QES_ANDROID_CERT_SHA256`.
- healthcheck `/up` = 200, `/` → `/setup` (čeká na první účet); migrace automaticky,
  `SECRET_KEY_BASE` + `docuseal.env` + SQLite na volume.
- **Fly `QES_ANDROID_CERT_SHA256`** je fingerprint Android podpisu testovacího APK (nyní debug
  `FA:C6:…:9C`), ne certifikátu dokumentu; při nasazení produkčního APK z CI se přepne na
  `80:DC:…:E0`. Podrobnosti a důsledky pro App Links/reinstalaci viz tabulka
  „Android podpisy vs. certifikáty“ výše.
- Ověřeno 2026-10-18: `trusted_roots` = 6× PostSignum, test cert `trusted=false`, `require_ltv=true`,
  reálný CRL fetch z produkce OK (`PostSignum Qualified CA 4`, 22 510 revoked).
- Ověřeno 2026-10-28 po zjednodušení (release **v51**, `deployment-01M61NDWNT8R8VA1HH9GEHBMG1`,
  fork `b2396604`): v secrets jen `QES_PUBLIC_BASE_URL` + `QES_ANDROID_CERT_SHA256` (+ SMTP);
  `Qes::Config` na stroji `enabled=true`, `require_ltv=true`, `ltv_allowed_hosts` = 3 PostSignum hosty,
  trust roots 6× PostSignum, `tsa_url=http://timestamp.digicert.com`, TSA roots 1, `tsa_required=true`;
  CRL fetch OK (`PostSignum Qualified CA 4`, 21 988 revoked), `/up` 200,
  `POST /api/qes/verify` a `/api/qes/documents` → 401, `/qes/sessions/unknown/document` → 404,
  `/qes-test/root.crl` → 404.
- První účet (setup) vytváří uživatel v prohlížeči; SMTP nastaveno (Brevo, `SMTP_FROM=<SMTP_FROM>`,
  `deploy/smtp.prod.env` — reálné hodnoty jsou v gitignored souboru).

**Staging `dokulachtan-staging`** (vytvořeno 2026-10-18):

- machine `78111546b1dd68`, volume `dokulachtan_stg_restore` (1 GB, `fra`) → `/data/docuseal`;
  obnovený ze snapshotu starého staging volume (`dokulachtan_data`), takže má účet
  `<SMTP_FROM>` a šablonu „QES E2E (staging)“ (starý volume zůstává odpojený).
- Defaulty forku + override: `QES_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/postsignum.pem`
  (testovací klíč i reálné PostSignum certy pro podpis),
  `QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/czech.pem`
  (testovací i reálné české CA pro ověření), `QES_REQUIRE_LTV=false`,
  `QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,dokulachtan-staging.fly.dev`,
  `QES_TEST_CRL_PATH=/app/config/qes/test-root.crl`, `QES_PUBLIC_BASE_URL=https://dokulachtan-staging.fly.dev`,
  `QES_ANDROID_CERT_SHA256=FA:C6:…:9C`.
- Ověřeno 2026-10-18: `make qes-staging-e2e` → 4 signatury INTACT, `trusted: true`,
  `trusted_roots` = test root + 6× PostSignum; report `test/out/qes-staging-e2e-report.txt`.
  `make qes-staging-e2e-pdf` → 2 signatury INTACT, `trusted: true`, report
  `test/out/qes-pdf-staging-report.txt`.
- Testovací data: šablona **„QES E2E (staging)“** s polem `qes` (obnovená ze starého volume).
- **SMTP nasazeno 2026-10-18:** Brevo free (300 e-mailů/den), `SMTP_FROM=<SMTP_FROM>`
  (stejné creds jako produkce, `deploy/smtp.env`); ověřeno `make smtp-check` a `make smtp-test`
  → STARTTLS + auth OK, `MAIL FROM` 250, `RCPT TO` 250 a doručení do schránky (Brevo doménu
  přepíše na `<id>.brevosend.com`).
- **Staging, vícenásobné podpisy (P7) nasazeny 2026-10-17:** release **v13**; ověřeno `make qes-staging-e2e`
  (2 signeři → 4 signatury INTACT) i `make qes-staging-same-signer`; LTV na stagingu chybí
  (CRL DP test certů je `127.0.0.1:8765`).
- **Ověření PDF nasazeno 2026-10-22:** produkce release **v35**, staging **v9**;
  `POST /api/qes/verify` (stateless) a `POST /api/qes/verified_documents` (ukládá do
  „Verified documents“) jsou na obou prostředích; staging ověřeno test certem → `valid`, `origin=docuseal`,
  2 signatury, store → template 30, tampered → `invalid`, unsigned → `unsigned`; produkce test certem
  → `valid_untrusted` (trust fix: root jen z `QES_VERIFICATION_TRUST_ROOTS`, ne z PDF chain), unsigned → `unsigned`;
  `/up` 200 na obou.
- **Staging, přímý podpis PDF (P8) nasazen 2026-10-18:** `make qes-staging-e2e-pdf` (upload tokenem →
  náhled stránky → `PATCH` oblast → submission → spuštění obřadu → podpis kódem appky →
  `PUT …/completed` → download → validace: 2 signatury INTACT, pokrytí `full`, pečeť v místě klepnutí
  `stamp_ink` 1.0; bez LTV je řetěz `UNTRUSTED` jako dřív). Navíc ověřeno **na emulátoru** (APK 1.0.4,
  Pixel Imprint): výběr PDF → upload → náhled → klepnutí → podpis → „Podepsáno (ADES), PDF je podepsané
  a uložené v DocuSealu ve složce Direct signing“ → share sheet `smlouva-signed.pdf`; na serveru submission
  completed, pole `qes:64`, dokument `qes-final-64.pdf` + audit, pečeť v místě klepnutí (inkoust 1.0),
  validace intact/trusted/coverage full.
  Detail: `docs/15-primy-podpis-pdf.md` § 8.
- **Testovací APK:** <https://dokulachtan-download.fly.dev/dokulachtan-signer.apk> (Fly app
  `dokulachtan-download`, `deploy/apk/`). Je to **debug-signed** Android build (`fac61745…3b9c`)
  s **testovacím certifikátem pro podpis dokumentů** (E2E) a stub čtečky; **produkční PostSignum cert
  se do APK nepeče** — uživatel ho importuje jako `.p12`, nebo použije čtečku.
  Verze v repu **1.3.9** (versionCode 10309; na Fly **1.3.8**) — **přímý podpis PDF
  nativním tokem DocuSealu** („Podepsat PDF“ → náhled → klepnutí → podpis → dokument ve složce
  „Direct signing“, „Stáhnout“ (uložit do telefonu, volitelně jinam) / „Otevřít“ / „Sdílet“),
  **sdílení PDF do appky** (Android share sheet „Podepsat PDF“)
  a **open intent** („Ověřit PDF“ z file manageru / e-mailu) → obojí S14 s volbou
  „Podepsat PDF“ / „Ověřit PDF“; **ověření PDF** (S14/S15, uložení do „Verified documents“),
  **externí ověření přes EU DSS** (jen appka, PDF se posílá na servery EK).
  Ikona i splash = oficiální logo DocuSealu (oranžový kruh s bílým lachtanem), nasazeno 2026-10-23.
  Na emulátoru ověřeno: produkce + test cert → `valid_untrusted`, soubor/podpisy/pečeť viditelné;
  open intent z MediaStore otevře S14 s původním souborem (bez re-exportu).
  Výchozí server URL v buildu je **produkce**; na staging se přepíná v appce
  *Nastavení → Server URL* a odkaz se otevírá custom scheme `dokulachtan://sign?token=…` (funguje vždy).
  App Links (HTTPS) jsou vázané na host zapečený v buildu (`dokulachtan.fly.dev`), proto by staging
  vyžadoval rebuild APK s hostem `dokulachtan-staging.fly.dev`. APK se nasazuje
  `cd deploy/apk && fly deploy -a dokulachtan-download` (soubor `deploy/apk/*.apk` je gitignored).
- Konfigurace: `deploy/docuseal/fly.toml` a `fly.staging.toml` v parent repu (`make deploy-prod` /
  `make deploy-staging`; Dockerfile upstream, port 3000, healthcheck `/up`, volume na
  `/data/docuseal`, auto-stop); migrace automaticky při startu; `SECRET_KEY_BASE` +
  `docuseal.env` + SQLite na volume (každé prostředí vlastní).
- SMTP: **Brevo free** (300 e-mailů/den) nasazeno na obou prostředích 2026-10-18 — `SMTP_FROM=<SMTP_FROM>`
  (registrační adresa účtu = ověřený sender; doménu Brevo přepíše na `@<id>.brevosend.com`, protože
  `example.com` autentizované není), stejné přihlašovací údaje (`deploy/smtp.env` / `deploy/smtp.prod.env`, oba gitignored) →
  `make smtp-setup APP=…` (`SMTP_FILE=deploy/smtp.prod.env` pro produkci), `make smtp-check APP=…`,
  `make smtp-test APP=… TO=adresa@example.com`.
- Detail a varianty (Postgres/S3/produkce): [docs/09-deployment-flyio.md](docs/09-deployment-flyio.md),
  QES runbook [docs/10-qes.md](docs/10-qes.md).

```bash
# z parent repa (config v deploy/docuseal/, fork v vendor/docuseal)
fly apps create dokulachtan-staging --org personal
fly volumes create dokulachtan_staging_data --region fra --size 1 -a dokulachtan-staging
make deploy-staging                    # staging (deploy/docuseal/fly.staging.toml)
make deploy-prod                       # produkce (deploy/docuseal/fly.toml)
```

## Mapa repa

```
docs/           průzkum, návrh, e2e testy, fork workflow, deployment
 01-pruzkum.md           landscape QES v ČR
 02-navrh.md              širší návrh (překonáno rozhodnutím 04)
 03-architektura-sidecar.md  sidecar varianta (překonáno 04)
 04-architektura-fork.md  rozhodnutí: fork, varianty A/B, Qes::Providers
 05-e2e-testovani.md     certifikáty, CLI validátory, matice, důkazy (historické)
 06-design-lidsky.md      design bez odborných termínů
 07-pred-implementaci.md  checklist rozhodnutí (Expo, fork, provoz)
 08-fork-workflow.md      větev dokulachtan, rebase pravidla
 09-deployment-flyio.md   Fly.io analýza a zvolená varianta A
 10-qes.md                runbook QES (ENV, TSA, trust roots, troubleshooting)
 11-audit-design-spec.md   audit DESIGN/SPEC: nálezy B1–B6 + oprava (2026-10-16)
 12-audit-mobilni-appka.md audit mobilní appky: nálezy G1–G10 + rozhodnutí (2026-10-16)
 13-navrh-vicenasobnych-podpisu.md  návrh vícenásobných digitálních podpisů (firemní podpisy)
 14-audit-bezpecnost-kvalita.md  audit bezpečnosti, kompletnosti a kvality kódu (2026-10-17)
 15-primy-podpis-pdf.md   přímý podpis PDF bez DocuSeal submission (návrh, P8)
 16-overeni-pdf.md       ověření PDF: server endpoint, appka S14/S15, share intent
 17-ui-hierarchie-akci.md  hierarchie akcí v appce (audit a návrh tlačítek)
 18-audit-fork-vs-upstream.md  audit forku: kvalita, dead code, duplicity, doteky, cena rebase
 19-overeni-pdf-externi.md  externí ověření PDF přes EU DSS (jen appka, volba providera)
 20-audit-2026-10-27-opravy.md  audit druhého kola: nálezy N1–N8, S1–S7 + opravy
 21-audit-testu.md       audit testů: naměřené časy, zastaralé testy, sleep/wait, paralelizace
 22-final-audit-fork.md  finální audit: doteky na nesouvisející funkcionalitu, kombinace QES/non-QES
 23-refaktor-touch-surface.md  refaktor touch surface: před/po statistiky, duplikace, hooky
DESIGN.md       aplikační design (co a proč)
SPEC.md         detailní specifikace odvozená z DESIGN (model, API, obrazovky, testy)
PLAN.md         implementační plán (fáze P0–P8 s verifikací)
scripts/        nástroje a testy (viz `make help`)
mobile/         Expo appka (Android first, iOS připravený)
test/           fixtures, certy, reporty
vendor/docuseal  lokální klon forku (gitignored, pin = HEAD forku v vendor/docuseal.rev); fork repo
                 https://github.com/v1b3coder/docuseal (větev dokulachtan)
```

## Příkazy

```bash
make venv        # .venv (pyHanko + podman-compose)
make verify      # fixtures + validace + negativní/LTV scénáře
make fork-setup  # klon + větev dokulachtan + skeleton
make qes-test-qes  # T0: QES vrstva + JS testy (rychlá smyčka)
make qes-test-fast  # T1: celá sada bez spec/system (bez Chromia)
make qes-test     # T2: RSpec forku na SQLite (celá sada kromě dashboard specu)
make qes-test-postgres  # T3: paritní běh celé sady na Postgresu 18
make qes-test-parallel  # T0 paralelně (4 kontejnery, vlastní SQLite)
make qes-test-parallel-fast  # T1 paralelně
make qes-test-parallel-full  # T2 paralelně (potřebuje system image)
make qes-test-timings  # přeměří časy spec souborů pro paralelní runner
make qes-e2e      # fork + podpis KÓDEM APPKY (B) → validované PDF
make qes-e2e-two  # fork + 2 signeři → 4 signatury (2× appka + 2× pečeť), validované PDF
make qes-e2e-pdf  # přímý podpis PDF (docs/15): upload + náhled + place + podpis kódem appky
make qes-eu-dss-verify  # volitelné: compliance PDF přes EU DSS API (PDF opouští stroj)
make qes-negative # negativní scénáře N1–N17 proti forku
make qes-staging-e2e  # staging + 2 signeři přes fly ssh → 4 signatury, validované PDF
make qes-staging-same-signer  # staging: stejný podepisující 2× (2 pole) → 4 signatury INTACT
make qes-staging-e2e-pdf  # staging: přímý podpis PDF (docs/15) → upload, place, podpis kódem appky
make qes-e2e-card # fork + podpis fake čipem (A, test QSCD cert) → validované PDF
make smtp-setup   # SMTP (Brevo) → fly secrets; APP=dokulachtan-staging|dokulachtan (viz docs/09)
make smtp-check   # ověří, že app vidí SMTP konfiguraci
make smtp-test    # pošle testovací e-mail přes SMTP na adresu TO=
make qes-app-test # Jest testy appky (vault, P12, signer, API)
make qes-app-typecheck # TypeScript kontrola appky
```

### Testy: kdy co pouštět

Testy jsou rozdelené do **tierů** podle ceny a rizika (měření a zdůvodnění:
[docs/21-audit-testu.md](docs/21-audit-testu.md), runbook: [test/qes/README.md](test/qes/README.md)).
Nepouštěj celou sadu na každý commit — 69 % jejího času jde na upstream specy, které fork
nemodifikuje.

| Tier | Cíl | Rozsah | Kdy | Naměřeno |
|---|---|---|---|---|
| **T0** | `make qes-test-qes` | QES vrstva + JS testy kroku | **po každé změně** QES vrstvy (výchozí smyčka) | 404 ex, 43 s |
| **T0** | `make qes-test-parallel` | totéž, 4 workery | když potřebuješ T0 rychleji | 404 ex, **25 s** |
| **T1** | `make qes-test-fast` | celá sada bez `spec/system` | **před commitem** forku | 511 ex, 81 s |
| **T1** | `make qes-test-parallel-fast` | totéž, 4 workery | před commitem, když spěcháš | 511 ex, 43 s |
| **T2** | `make qes-test` | celá sada kromě `dashboard_spec` | **před PR / po rebase** | 647 ex, 3 min 20 s |
| **T2** | `make qes-test-parallel-full` | totéž, 4 workery | před PR, když spěcháš | 647 ex, **90 s** |
| **T3** | `make qes-test-postgres` | celá sada na Postgresu 18 | **před vydáním** (parita s upstream CI) | 651 ex, 3 min 37 s |
| — | `make qes-js-test` | node testy logiky QES kroku | po změně `qes_step_logic.mjs` (jinak v T0) | 33 ex, 0,2 s |
| — | `make qes-app-test` | Jest testy appky | po změně appky | 212 ex, 13 s |
| — | `make qes-app-typecheck` | TypeScript kontrola appky | před commitem appky | — |
| — | `make qes-e2e` / `qes-e2e-two` / `qes-e2e-pdf` / `qes-verify-e2e` | E2E s reálným podpisem | před PR, když se mění signing flow | — |
| — | `make qes-staging-e2e*` | E2E proti stagingu | po nasazení na staging | — |

Pravidla:

- **T0** je výchozí smyčka; běží i JS testy. Když je T0 zelené, QES vrstva je v pořádku.
- **T1** přidává upstream specy, které fork nemodifikuje — chytí regresi v dotecích
  (`template`, `submission`, `submitter`, `submit_values`, `routes`).
- **T2** přidává `spec/system` — jediná obrana proti regresi `generate_result_attachments`,
  `generate_combined_attachment` a `generate_audit_trail` při rebase. Proto zůstává v T2.
- **T3** je parita s upstream CI (Postgres 18). Jen před vydáním.
- `make qes-test*` mají `pipefail` — červený RSpec už neprojde jako úspěch.

Plný seznam cílů včetně e2e, stagingu a deploye: [DEVELOPMENT.md](DEVELOPMENT.md).

## Stav

- [x] Discovery (landscape, rozhodnutí A/B/Expo, fork `dokulachtan`)
- [x] Verifikace (toolchain, DocuSeal baseline, negativní/LTV, mobile PoC) — baseline e2e a PoC
      byly 2026-10-25 odstraněny, nahradily je `make qes-e2e*` a `make qes-test-qes`
- [x] **Detailní specifikace a plán implementace** — [SPEC.md](SPEC.md), [PLAN.md](PLAN.md)
- [x] Staging deployment na Fly.io (varianta A): <https://dokulachtan.fly.dev/>
- [x] **Audit DESIGN/SPEC** — nálezy B1–B6 opravené v DESIGN/SPEC/PLAN + `docs/11-audit-design-spec.md`
- [x] **P0.2 QES test harness** — `make qes-test` (SQLite) / `make qes-test-postgres` (Postgres 18) běží;
      `test/qes/README.md` (změřeno: SQLite 243/1 upstream flake, Postgres 247/0)
- [x] **Rozhodnutí k appce** (2026-10-16): podpis jen s biometrií (bez hesla) + volba podepisujícího
      lokálně (klíč → čtečka → wizard S10) — AGENTS #13, #14, SPEC § 9.5 a § 9.8,
      `docs/12-audit-mobilni-appka.md`
- [x] **P0** příprava (RSpec harness, QES fixtures, `make qes-test`) — P0.3–P0.6 hotové
- [x] **P1** model + stavový automat (`QesSession`) — 44 QES speců zelených
- [x] **P2** kryptografie (TBS, CMS, embed, TSA, LTV, validace, pečeť) — `spec/lib/qes/pipeline_spec.rb`
- [x] **P3** API + integrace do DocuSealu (hlavní důkaz řetězu) — `make qes-e2e` zelené
- [x] **P4** Expo appka B (telefon/AdES) — `mobile/app` (vault, podpis, deep link, obrazovky);
      `make qes-app-test` + `make qes-e2e` podepisuje KÓDEM APPKY
- [x] **P5 (stub + fake card)** Expo appka A (eObčanka/QES, MOI SDK) — `StubCardSigner`
      vrací `reader_not_found`, `FakeCardSigner` (test QSCD cert) umí celý A tok
      (`make qes-e2e-card`); reálná čtečka je mimo rozsah fáze
- [x] **P6** negativní testy N1–N9 (`make qes-negative`) a staging e2e se dvěma signery
      (`make qes-staging-e2e`); zbývá jen provozní dokumentace
- [x] **P7** vícenásobné digitální podpisy (firemní podpisy): pořadí, řetězení PAdES revizí,
      validace všech signatur — `make qes-test-qes` (59/0) + `make qes-e2e-two` (4 signatury)
- [x] **Opravy 2026-10-17:** stejná osoba může podepsat víc polí téhož dokumentu (druhý podpis
      se řetězí na její první finální PDF, test v `chain_spec.rb`) a pole s `qes:<id>` zobrazuje
      přehled podpisu místo interního tokenu (`submissions/_value.html.erb`, `qes_summary.vue`)
- [x] **Staging ověření oprav 2026-10-17 (release v15/v16):** `make qes-staging-e2e` (2 signeři, 4 signatury
      INTACT) i `make qes-staging-same-signer` (1 signer, 2 pole, 4 signatury INTACT) prošly;
      `GET /s/:slug/qes_sessions/:id` s `Accept: application/json` vrací 200 + `summary_html`
      (LTV/trust na stagingu chybí jako dřív, CRL DP = `127.0.0.1:8765`)
- [x] **Oprava zobrazení 2026-10-17 (release v16):** přehled v poli dokumentu byl neformátovaný
      (třídy nebyly v CSS balíčku `form`) a krok hlásil `{{level}}` (kořenový `t` neinterpoluje).
      Přehled má `compact` variantu s podbarvením, `qes_step.vue` skládá texty sám; ověřeno
      v prohlížeči na stagingu (1 submitter, 2 pole: oba přehledy formátované, žádné `{{level}}`)

- [x] **Audit bezpečnosti, kompletnosti a kvality (2026-10-17):** `docs/14-audit-bezpecnost-kvalita.md` —
      nálezy K1–K15, M1–M9; **K1–K6 opraveny** (trust řetěz certifikátu včetně intermediate CA,
      `422 not_trusted` u self-signed certu, SSRF allowlist `QES_LTV_ALLOWED_HOSTS`, LTV čitelné
      pyHanko (ETSI `crlVals [1]` + Adobe atribut + DSS slovník), synchronní `complete!`
      s `LockEvent` a `with_lock`, `409 wrong_state` u jiné signatury); `make qes-test-qes` 75/0

- [x] **iOS připravenost 2026-10-17:** appka je cross-platform (`Platform.OS` se používá jen pro volbu
      platformy v metadatech obřadu, skrytí čtečky — Android-only MOI SDK — a skrytí volby QES
      u přímého podpisu PDF), `eas.json` + iOS `app.json` (associatedDomains, Face ID, exportní
      compliance), deep link App Link `/qes/sign` → `/sign` opraven `+native-intent.tsx` (dřív
      „Unmatched Route“), čtečka na iOS skrytá (MOI SDK je Android AAR); EAS projekt
      `@slush0/dokulachtan-signer` založen, build čeká na Apple Developer účet — postup
      v `docs/10-qes.md`
- [x] **Přímý podpis PDF (docs/15, schváleno 2026-10-18, hotovo 2026-10-18, přepsáno na nativní tok):**
      appka nahraje PDF přes `POST /api/qes/documents` (šablona ve složce „Direct signing“ s polem `qes`),
      klepnutím umístí pečeť, podepíše a dokument zůstane v účtu (Documents) ke stažení, sdílení i smazání;
      ověřeno `make qes-test-qes` (88/0), `make qes-e2e-pdf` (2 signatury, pečeť v místě klepnutí, inkoust 1.0,
      auditní stránka), `make qes-negative` (N1–N17), `make qes-e2e`/`make qes-e2e-two` beze změny a na emulátoru.
      Implementační fáze P8 v PLAN.md (offline core mimo v1).
- [x] **Sdílení PDF do appky (2026-10-22):** Android share sheet „Podepsat PDF“ (`activity-alias`
      v `plugins/withSharePdfTarget.js`) → `expo-share-intent` → S11 s vybraným PDF → rovnou upload → S12;
      ověřeno na emulátoru cold start i za běhu appky (`make qes-app-test` 48/0, `make qes-app-typecheck`).
- [x] **Hierarchie akcí v appce (2026-10-22):** audit a nové uspořádání tlačítek dle
      `docs/17-ui-hierarchie-akci.md` — jedna primární akce na stav (Home: „Podepsat PDF“, bez klíče
      „Importovat klíč“), alternativy za oddělovačem (testovací certifikát v importu i S10), navigace
      a „Zrušit“ jako textové odkazy, mazání jen v detailu certifikátu s potvrzením; sdílené
      komponenty `mobile/app/src/ui/buttons.tsx`; `make qes-app-test` 60/60, typecheck zelený
- [x] **Rozdělení prostředí 2026-10-18:** produkce `dokulachtan` běží na novém prázdném volume
      `dokulachtan_prod_data` (jen PostSignum CA, `QES_REQUIRE_LTV=true`,
      `QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu`, bez test rootu
      a bez testovacího APK fingerprintu) a staging `dokulachtan-staging` na `dokulachtan_staging_data`
      (test root + PostSignum CA, `QES_REQUIRE_LTV=false`); konfigurace `deploy/docuseal/fly*.toml`;
      starý volume `dokulachtan_data` odpojený (nesmazaný); `make qes-staging-e2e` proti novému stagingu
      prošel (4 signatury INTACT, `trusted: true`)
- [x] **Oprava rezervy `/Contents` (2026-10-22):** reálný certifikát končil `signature_size_exceeded` —
      CRL PostSignum Qualified CA 4 má 812 863 B a do CMS šel 2× (ETSI + Adobe), tj. ~1,63 MB, ale rezerva
      byla pevně 20 000 B. TBS se teď staví až po přijetí certifikátu a rezerva je
      `Qes::CmsBuilder.estimate_size` + `QES_SIGNATURE_SIZE_MARGIN` (default 16 384 B);
      `document_digest` se počítá tamtéž a v `GET /qes/sessions/:token` už není
      (SPEC § 7.1, § 11, § 16 #22). **Od 2026-10-27** je to nahrazeno pevnou rezervou
      `QES_SIGNATURE_RESERVE` (64 KB), TBS se staví **před** certifikátem (`GET /document`)
      a `estimate_size`/`SIGNATURE_SIZE_MARGIN` byly odstraněny; viz audit 21.
- [x] **DocTS + DSS VRI, CMS LTV pryč (2026-10-22):** pyHanko unsigned CMS atributy nečte (čte DSS
      a signed Adobe revinfo), CMS LTV jen zvětšoval PDF. Revokační data jdou do DSS s VRI (SHA-1
      `/Contents` podpisu) a po pečeti se přidá **DocTS** (DigiCert TSA, `ETSI.RFC3161`), který DSS kryje;
      `Qes::DocTimestamp`, `QesSession#doc_timestamp_state`, migrace; validátor zvládne DigiCert token
      (TSTInfo v eContent). `make qes-test-qes` 121/0, `make qes-test` 364/1 (známý upstream flake
      `signing_form_spec.rb:1253`). **Nasazeno 2026-10-22:** produkce **v37**, staging **v11**;
      `make qes-staging-e2e` (2 signeři → 6 signatur: 2× appka + 2× pečeť + 2× DocTS, INTACT) i
      `make qes-staging-e2e-pdf` (3 signatury, DocTS `EXTENDED_WITH_LTA_UPDATES`) prošly; DigiCert TSA
      (`http://timestamp.digicert.com`, free/AATL) na obou, e2e vidí `TIMESTAMP_TOKEN<INTACT:UNTRUSTED>`
      (test trust list nemá DigiCert root — v Adobe je DigiCert trusted).
- [x] **Opravy nálezů z auditu `docs/18` (2026-10-23):** K1–K4 (DocTS `modified`, `QES_TSA_REQUIRED`,
      malformed cert → 422, VRI z raw `/Contents`) + M1–M20 (mrtvá CMS-LTV vrstva, `Qes::Provider`,
      `Qes::ControllerConcern`/`PdfUpload`/`Link`, `EmbedSignatureJob` pryč, `reschedule` v `ensure`,
      limity certu/řetězu, `skip_before_action` u `.well-known`, `failure_code` z appky, krátké transakce,
      fallback CRL URL, `db/schema.rb`, mrtvé i18n, `Seal`/`merged_document` přes upstream helpery);
      navíc `ApplicationRecord#strip_attributes` mazal whitespace i z binárních sloupců (`signature`,
      `signed_attrs_der`) → `QesSession` je po validaci vrací. **Testy doteků:**
      `spec/lib/qes/upstream_contract_spec.rb`, `spec/requests/qes_views_spec.rb`,
      `spec/javascript/qes_step_logic.test.mjs` (`make qes-js-test`), `qes_well_known_spec.rb`,
      `spec/jobs/qes/expire_sessions_job_spec.rb`; `make qes-test` 392/1 (známý upstream flake),
      `make qes-test-postgres` 396/0, `make qes-test-qes` 149/0, `make qes-js-test` 9/0,
      `make qes-e2e`/`qes-e2e-two`/`qes-verify-e2e` zelené,
      `make qes-negative` N1–N17 OK. Commity forku `65358818`–`a92fc2a3` (po squashi 2026-10-23
      `9e713ebe`–`32f3c0f2`); SPEC § 14 srovnáno s realitou
      (20 doteků), `docs/08` opravený
- [x] **Nasazení oprav z auditu `docs/18` na produkci a staging (2026-10-23):** produkce **v39**,
      staging **v13**; oba běží kód `32f3c0f2` (ověřeno `signature_min_size` v `tbs_document.rb`
      a `DocTimestamp`), `/up` 200, QES ENV beze změny (produkce jen PostSignum CA +
      `QES_REQUIRE_LTV=true`, staging test root + `QES_REQUIRE_LTV=false`), `POST /api/qes/verify`
      i `/api/qes/documents` → 401 (endpointy žijí); `make qes-staging-e2e-pdf` zelené
      (3 signatury: podpis appky INTACT + pečeť + DocTS, pokrytí `full`, pečeť v místě klepnutí,
      inkoust 1.0; UNTRUSTED kvůli chybějícímu LTV na stagingu jako dřív)
- [x] **Squash historie forku do logických bloků (2026-10-23):** 60 commitů → **10 commitů**
      (trust roots, model + stavový automat, kryptografie, LTV/DSS/DocTS, validace + provideři,
      protokol, napojení na DocuSeal, krok ve formuláři, přímý podpis PDF, ověření PDF).
      Zmizelo 8 commitů zrušeného prototypu `QesPdfSession` (4 feat + 4 revert, čistá nula),
      jeho drop migrace, `fly.toml`/`fly.staging.toml` a `FORK.md` — Fly konfigurace i dokumentace
      se přesunuly do parent repa (`deploy/docuseal/`, `docs/08`), takže ve forku zůstává jen kód
      patche. `git diff` starý vs. nový HEAD = drop migrace + Fly configy + FORK.md.
      Obsah kódu je bit-identický, `make qes-test-qes` 149/0, `make qes-js-test` 9/0.
      Záloha staré historie: `backup/dokulachtan-pre-squash` a `/tmp/fork-pre-squash.bundle`.
- [x] **Oprava autora commitů (2026-10-24):** globální `user.email` byl
      starý osobní e-mail (redacted), který není na GitHub účtu ověřený → GitHub commity
      nepřiřadil (bez avatara, API vracelo `author: null`). Nově
      `264291321+v1b3coder@users.noreply.github.com` (noreply adresa vázaná na ID účtu).
      Historie forku přepsána jen pro našich 10 commitů (upstream SHA zůstaly bit-identické,
      obsah stromu stejný), force-push na GitHub i gitea; pin `vendor/docuseal.rev` = `ebab4ea0`
      (mapování `bfc97fe7`→`f3bf4a2d` … `b8e7f00f`→`ebab4ea0`), GitHub API už vrací
      `author: v1b3coder`. Zálohy: `/tmp/fork-pre-authorfix-20261024.bundle` a `/tmp/fork-old.git`.
- [ ] **Zbývá:** první reálný podpis na produkci (reálný PostSignum cert) a kvalifikované TSA
      (nyní DigiCert free, non-qualified)
- [x] **Ověření PDF (2026-10-22):** `docs/16-overeni-pdf.md` — server `POST /api/qes/verify`
      (stateless) a `POST /api/qes/verified_documents` (ukládá do složky „Verified documents“ + JSON report),
      appka S14/S15, share intent „Dokulachtan“ → „Podepsat PDF“ / „Ověřit PDF“; `make qes-test-qes` 124/0,
      `make qes-test-postgres` 371/1 (známý upstream flake `signing_form_spec.rb:1253`), `make qes-verify-e2e` zelené (valid/docuseal, store,
      tampered invalid, unsigned), `make qes-app-test` 60/0, `make qes-app-typecheck` zelené
- [x] **Web UI ověření PDF (2026-10-23):** template show page zobrazuje panel „Ověření PDF“
      (verdikt, podpisy, issuer, časy, pečeť, origin, SHA-256), náhled PDF v Turbo modalu a stažení PDF;
      `TemplatesQesVerificationsController`, `templates/_qes_verification.html.erb`,
      `templates_qes_verifications/show.html.erb`; normální template panel nezobrazí;
      `make qes-test-qes` 125/0, `make qes-test` 368/1 a `make qes-test-postgres` 372/0
      (SQLite má jen známý upstream flake `signing_form_spec.rb:1253`); **nasazeno 2026-10-23:**
      staging **v12**, produkce **v38**; `/up` 200 na obou, panel se renderuje na stagingu (template 30)
      i produkci (template 6)
- [x] **Externí ověření PDF jen v appce (2026-10-23):** `docs/19-overeni-pdf-externi.md` —
      S14 radio group „DocuSeal / EU DSS“ + varování + povinný checkbox, S15 badge providera
      a externí texty; appka volá EU DSS přímo, DocuSeal se nemění; externí report se neukládá,
      `origin`/`seal.trusted`/`modified` zůstávají jen u lokálního ověření; `make qes-app-test` 77/77,
      `make qes-app-typecheck` zelené
- [x] **Audit forku proti upstreamu (2026-10-23):** `docs/18-audit-fork-vs-upstream.md` —
      84 souborů / 6 352+ / 27−, z toho 20 doteků upstreamu (426 řádků, 27 deletions); rebase 50
      commitů na `8f8f69f0` bez konfliktu, ale 31 upstream commitů/rok zasáhne přesně řádky forku;
      4 kritické nálezy (K1 DocTS `modified`, K2 mrtvý `QES_TSA_REQUIRED`, K3 500 u malformed cert,
      K4 VRI klíč), ~215 řádků mrtvého kódu, ~200 řádků duplicit; `make qes-test-qes` 125/0,
      `make qes-verify-e2e` **červené** (vlastní LTA PDF → `verdict: invalid`, `modified: true`)
- [x] **Stáhnout / Sdílet u přímého podpisu PDF (2026-10-25):** `docs/15` § 6 a `docs/17` § 9 —
      finální PDF se stahuje nativně (`File.downloadFileAsync`), „Stáhnout“ ukládá do telefonu
      (`MediaStore` → `Download/Dokulachtan/` na Androidu 10+, SAF na starším, Soubory na iOS) a „Sdílet“
      otevírá share sheet; nový lokální modul `modules/dokulachtan-share` startuje chooser na hlavním
      vlákně a promise resolve hned (bez visícího promise a bez NPE, expo/expo#51164), po návratu ze
      sheetu se stav tlačítek resetuje (`AppState`), takže jde akci spustit znovu; chyby akcí mají vlastní
      kódy (`download_failed`, `save_failed`, `share_failed`, `sharing_unavailable`);
      po uložení jde PDF **otevřít** v systémovém prohlížeči (`ACTION_VIEW`) a **„Uložit jinam…“**
      otevře SAF picker, vybranou složku si appka zapamatuje (SecureStore) a příště ukládá přímo tam
      (výchozí zůstává `Download/Dokulachtan/`); `make qes-app-test` 99/99,
      `make qes-app-typecheck` zelené, ručně na emulátoru (uložení do `Download/Dokulachtan/` i do
      Documents se zapamatováním, otevření v Drive PDF Viewer, share sheet, druhé sdílení i uložení po back)
- [x] **Zobrazit heslo při importu klíče (2026-10-25):** pole hesla v S2 má uvnitř inputu ikonu oka
      (kreslená Views, appka nemá knihovnu ikon) — klepnutím se heslo odmaskuje pro kontrolu překlepů,
      dalším klepnutím zase skryje; ikona i `accessibilityLabel` se přepínají („Zobrazit/Skrýt heslo“),
      pole má vypnutý autocorrect/autoCapitalize, aby přepnutí masky nezahodilo text; obrazovka má
      `keyboardShouldPersistTaps="handled"`, aby oko zabralo na první klepnutí i s otevřenou
      klávesnicí (jinak ScrollView první klepnutí spolkne); `make qes-app-test`
      99/99, `make qes-app-typecheck` zelené, ručně na emulátoru (maskované → „Tajne123“ viditelné →
      znovu maskované, text zůstal) a na telefonu (S23, APK 1.3.6 nainstalováno přes adb):
      maskované → klepnutí na oko → „ahoj“ viditelné → klepnutí → maskované, text zůstal

- [x] **Refaktor QES orchestrace z upstream verifikátoru (2026-10-26):** `lib/verify_pdf_signature.rb` je
      **bit-identický s upstreamem** (nulový diff) — veřejné `/api/tools/verify` a webové ověření PDF už
      nedělají QES HexaPDF průchody navíc (dřív 3–4× parse na anonymním endpointu) ani nezávisí na QES
      vrstvě; celá orchestrace (TSA trust, hranice změn, `accepted`) je v `Qes::PdfiumTrust.report`
      s vlastním `Result` a upstream primitivy jen volá. CAdES `trusted` vyžaduje `signing_leaf?`
      (pečeť padá na `trusted_signature?`). **Opravena regrese API dokončení:** `PUT /api/submitters/:id`
      zase resolvuje defaulty, vzorce, razítko i datum (`Qes::SigningValues.finalize!`); bez toho vracelo
      `nil` místo `"Douglas Howell"` (nový spec na původním kódu selže). **DigiCert TSA root**
      `config/qes/digicert-tsa.pem` (Trusted Root G4) + `QES_TSA_TRUST_ROOTS` v runbooku. Touch surface
      upstreamu: 20 souborů +487/−41 → 21 souborů +629/−94 (nejvyšší churn `verify_pdf_signature.rb`
      zůstal na nule); `make qes-test` 624/1 (známý upstream flake), `make qes-test-qes` 365/0

- [x] **Audit druhého kola a opravy (2026-10-27):** nálezy N1–N8 a S1–S7
      z druhé kontroly (docs/20-audit-2026-10-27-opravy.md) — QES snapshot polí,
      CRL scope, transport redirecty, vyloučení vlastní appky z PDF chooseru,
      DocTS verifikace, values v prohlížeči, 24h TTL dokončeného tokenu,
      session-token dokončení, revokace nad store chain, atomické přechody,
      `valid_unqualified`, DNS chyby a QES hooky při vypnutém QES; S4 release
      keystore už hotový; `reviewOpened` po `startActivity` zůstal (AppState
      se ukázal nespolehlivý).
      Ověřeno: QES 401/0, SQLite 646/1 (známý upstream flake), Postgres 650/0,
      app 203/0, typecheck a JS testy zelené.

- [x] **Audit testů a plán zrychlení (2026-10-27):** `docs/21-audit-testu.md` — naměřeno
      (SQLite harness, JSON `run_time`): 69 % času full sady jde na **upstream specy, které fork
      nemodifikuje** (243 ex / 265,7 s z 384,1 s); `spec/system/signing_form_spec.rb` sám = **133 s
      (35 %)**, čistě upstream, drží podlahu plného paralelního běhu; `make qes-test-qes` je 98–144 s,
      z toho **~80 s je `build_qes_submission` (279× × 288 ms)** a **97 % ceny `create(:template)`
      je generování PNG náhledů** (218–644 ms → 16,9 ms bez nich; ověřeno 401 ex, 1 failure = spec,
      který náhledy testuje, 71 s). Explicitní `sleep` v specách jsou jen 2 (`0,1 s`, oba oprávněné),
      E2E skripty pollují s limitem (žádný fixed sleep); mrtvé testy nejsou (ověřeno proti `docs/18`
      a `docs/20`). Paralelizace 4 workerů = 4 kontejnery s vlastní SQLite = **2,0× QES / 2,5× system**
      (CRL port 8765 ani Capybara Puma nekolidují — jiný netns; round-robin dělení dá jen 1,15×).
      Doporučení: tiering (`qes-test-qes` per-commit, plná sada per-PR), `previews: false` v QES
      šablonách, paralelní shell runner bez `parallel_tests` gemu; kombinace = QES 98 s → ~30 s.

- [x] **Implementace zrychlení testů (2026-10-27):** všechny fáze z `docs/21` § 8 hotové.
      **Tiery:** T0 `qes-test-qes` (QES + JS), T1 `qes-test-fast` (bez `spec/system`), T2 `qes-test`,
      T3 `qes-test-postgres`; každý má paralelní variantu (`qes-test-parallel*`, N kontejnerů
      s vlastní SQLite, dělení podle `test/qes/timings.txt` + LPT, soubory nad 45 s po examplech).
      **Optimalizace:** `QesHelpers.without_page_previews` (PNG náhledy v `create(:template)` = 97 %
      ceny; `number_of_pages` zůstává) a cache RSA klíčů v `QesHelpers` (`TSA_KEYS`,
      `SELF_SIGNED_QC_SSCD`, cert jako kopie). **Opravy:** `pipefail` v Makefile (dřív
      `rspec | tee` maskoval červený exit kód); 2FA flake root cause = `RateLimit::STORE`
      je proces-globální `MemoryStore` a SQLite recykluje `submitter.id` → `RateLimit::STORE.clear`
      v `config.before` + `travel_to(+20 s)` u re-sendu (re-send je omezený na 15 s).
      Naměřeno: QES **100,3 → 42,2 s** sekvenčně a **25 s** se 4 workery (404/0); T1 157 → 81 s
      (511/0) a 43 s paralelně; T2 647/0 za 3 min 20 s, paralelně **90 s**; `qes-app-test` 212/0.
      Runbook: `test/qes/README.md`; tabulka „Testy: kdy co pouštět" v `AGENTS.md`.

- [x] **Expo SDK 54 → 58 (2026-10-26):** `mobile/app` na **SDK 58** (expo 58.0.19, React Native 0.88.0,
      React 19.3.0, expo-router 58, expo-share-intent 9.0.0, jest-expo 58, TypeScript 6). `app.json` bez
      zrušených polí (`newArchEnabled`, `android.minSdkVersion`, `splash` → plugin `expo-splash-screen`);
      `plugins/withSharePdfTarget.js` importuje `expo/config-plugins` (SDK 58 už `@expo/config-plugins`
      nehoistuje). **`File.write()` je v SDK 58 async** → `await` v `platform.ts` a `pdfShare.ts`
      (jinak by se PDF mohlo sdílet/otevřít před dokončením zápisu). Ověřeno: `make qes-app-test` 194/0,
      `make qes-app-typecheck` zelené, `npx expo-doctor` 20/20, `expo prebuild` + `gradlew assembleDebug`
      i `assembleRelease` zelené (R8 nově default), na emulátoru (Android 15) start, S14, dokument picker,
      share intent „Podepsat PDF“ i open intent „Ověřit PDF“. **Expo fetch v SDK 58 neumí**
      multipart s RN tvarem `{uri, name, type}` („Unsupported FormDataPart implementation“) →
      `PdfApi.toBlob` posílá objekt s `bytes()` (obsah z `File`) a jménem/MIME z `PdfUpload`;
      ověřeno na emulátoru proti stagingu (signed PDF → „Podpis je platný (AdES)“).
      Nový APK zatím **nenasazen** na Fly.

- [x] **Audit upgradu Expo SDK 54 → 58 (2026-10-26):** prošlé všechny dotčené cesty. Nálezy a opravy:
      **A1** Expo fetch v SDK 58 neumí multipart s RN tvarem `{uri, name, type}` → `PdfApi.toBlob`
      posílá objekt s `bytes()` (líný `require('expo-file-system')`, aby e2e harness v Node nepadal);
      **A2** `File.write()` je async → `await` v `platform.ts`/`pdfShare.ts`; **A3** `pdfApi` importoval
      `expo-file-system` i v e2e → líný import až ve `toBlob`; **A4** `QesApi` na HTML chybové stránce
      spadl na `JSON.parse` → `readErrorPayload`/`readJsonPayload` a `QesApiError`; **A5** lokální e2e
      `http://127.0.0.1:3030` neprošel `signingOrigin` → `127.0.0.1` v dev allowlistu; **A6** lokální
      e2e neměl `QES_TSA_TRUST_ROOTS` → doplněno do `scripts/qes_e2e.py`. Ověřeno: `make qes-app-test`
      198/0, `make qes-app-typecheck`, `make qes-e2e` (lokální fork, podpis i validace), na emulátoru
      ověření PDF proti stagingu (upload → `Podpis je platný (AdES)`, správný název souboru), import
      testovacího certifikátu (SecureStore + `File.write` + biometrie), share/open intent, custom scheme
      i App Link `/qes/sign`. **Nález bez opravy:** staging image (v15) nemá route
      `GET /qes/sessions/:token/document` (produkce v42 ji má) → `make qes-staging-e2e-pdf` končí
      `server_error`; chce to redeploy stagingu z aktuálního forku.

- [x] **Deploy SDK 58 + fork refactor na staging a produkci (2026-10-26):** staging **v17**
      (`dokulachtan-staging:deployment-01M5X6BGC92WVXZAVG1TXMKT5W`), produkce **v43**
      (`dokulachtan:deployment-01M5X6GXQ2W3A6C2Y6G2Y2HG59`), obě z forku `b2150a10`. Staging dostal
      chybějící `QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem`; `/up` 200, `document` route na
      obou, produkce má 6 PostSignum rootů + 1 TSA root a `QES_REQUIRE_LTV=true`, staging 7 rootů
      (test + PostSignum) + 1 TSA root a `QES_REQUIRE_LTV=false`; `POST /api/qes/verify` a
      `/api/qes/documents` na produkci vrací 401.

- [x] **Staging LTV: test CRL na staging hostu (2026-10-27, varianta B):** test certy mají dva CRL DP
      (`http://127.0.0.1:8765/root.crl` pro lokální e2e a `https://dokulachtan-staging.fly.dev/qes-test/root.crl`);
      fork `b56a5834` vystavuje `/qes-test/root.crl` z `config/qes/test-root.crl` jen když je
      `QES_TEST_CRL_PATH` nastavená (produkce bez env → 404). Staging secrets:
      `QES_TEST_CRL_PATH=/app/config/qes/test-root.crl`,
      `QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,dokulachtan-staging.fly.dev`.
      Staging **v20** (`deployment-01M5XDK3BEHXGM7QZFTW6AC319`), produkce **v45**
      (`dokulachtan:deployment-01M5XDPSMXX2QSEAQ4B2DJZNSS`, test CRL route 404); `make qes-staging-e2e` i `qes-staging-e2e-pdf`
      zelené (podpis appky TRUSTED, pečeť DocuSealu UNTRUSTED — test trust list). Test cert v appce
      přegenerován (`TEST_P12_BASE64`/`TEST_QSCD_P12_BASE64`), `make qes-app-test` 198/0,
      `make qes-test-qes` 383/0, `make qes-e2e` zelené; test CRL má platnost 10 let (do 2036). **Poznámka:** `SharePdfModule.openPdf` nabízí
      v chooseru i vlastní `Ověřit PDF` alias (pre-existing UX, ne B).

- [x] **Velikost APK: release jen arm64 + deflate (2026-10-27):** SDK 58 zvětšil APK z 66,0 na 91,7 MB — nativní knihovny
      +27,6 MiB ve 4 ABI (RN 0.88 nová architektura, reanimated 4 + worklets, `zstd-kmp`), dex naopak −4,2 MiB díky R8.
      Nový plugin `mobile/app/plugins/withApkSize.js` při prebuildu nastaví `expo.useLegacyPackaging=true` (deflate
      `.so`), `android.enableShrinkResourcesInReleaseBuilds=true` a výchozí ABI `x86_64` (emulátor a testy); release
      pro telefony se staví s `-PreactNativeArchitectures=arm64-v8a` (CI i `deploy/android-release/README.md`) a release
      build bez arm64 spadne, aby se nevydal APK, který na telefon nejde nainstalovat. Změřeno: univerzální build 91,65 MB,
      release arm64 + deflate + shrinkResources **14,06 MB**; ověřeno na emulátoru (debug x86_64, `extractNativeLibs=true`,
      nativní moduly z `/data/app/…/lib/x86_64/`, home screen s certem) i na telefonu (release arm64 z předchozího dne).

- [x] **Audit a opravy signing flow v appce (2026-10-27):** `docs/21-audit-signing-flow-app.md` — K1–K33;
      **kontrola je nyní před klíčem** (`GET /document` → review → biometrie → `POST /certificate`),
      TBS se staví **před** certifikátem s pevnou rezervou `QES_SIGNATURE_RESERVE` 64 KB, `POST /certificate`
      už TBS nepřestavuje a ověří `qes_values` snapshot; appka ověří `signingCertificateV2`, `signingTime`,
      `certificate_info`, `document_digest` a po stažení finálního PDF i `final_pdf_sha256` + reviewed prefix/suffix;
      dále `202 embedded` polling, `X-QES-Protocol`, mapování nových chyb, `needs_reader`/`needs_qes_key` do S10,
      místní kontrola PDF před uploadem, `source_sha256`, reuse submission a `reviewOpened` **zůstává** (rozhodnutí
      uživatele). Ověřeno: `make qes-app-test` 212/0, `make qes-app-typecheck`, `make qes-test-qes` 402/0,
      `make qes-e2e`, `make qes-e2e-two`, `make qes-e2e-pdf`; plná sada SQLite 646/2 a Postgres 650/1 mají
      jen upstream/system flaky (`signing_form_spec.rb:1253`, `:253` a `notifications_settings_spec.rb:73`), QES vrstva je zelená.

- [x] **Nasazení audit fixes na produkci (2026-10-27):** release **v47**, image
      `deployment-01M5YTS7HE1Z54VY5P1G6V6KTF`, fork `b1c672e7`; `/up` 200, `/qes/sessions/unknown/document`
      404 `unknown_token`, `Qes::SessionsController#document` v logu, `Qes::Config` ověřeno na stroji:
      `enabled=true`, `signature_reserve=65536`, `review_ttl=900`, `session_ttl=600`, trust roots 6,
      TSA roots 1, `require_ltv=true`, `tsa_url=http://timestamp.digicert.com`, `tsa_required=true`.

- [x] **Finální audit doteků forku (2026-10-28):** `docs/22-final-audit-fork.md` — upstream sada **647/0**
      (SQLite) a **655/0** (Postgres 18), `lib/verify_pdf_signature.rb` bit-identický s upstreamem; nálezy
      R1 (bezpečnostní: tamper po nedůvěryhodném podpisu se nehlásí, `modified: false`), R2 (CAdES podpisy
      přestaly být trusted přes certy účtu), R3 (`qes` pole v builderu vždy, i při `QES_ENABLED=false`),
      R4 (tiché neuložení QES šablony / 500), R5 (dotazy `qes_sessions` v non-QES cestách) + R6–R11.
      **Opravy 2026-10-28:** R1 hranice změn z `accepted.presence || verified`, R2 CAdES přes certy
      účtu s `signing_leaf?`, R3 `withQes` gate (`QES_ENABLED`) + volba AdES/QES v kontextovém menu pole,
      R4 422 s překladem v web/API šablonách i preferencích + `alert` v builderu, R5 jeden dotaz na
      submission v `submissions/show` a `generate_audit_trail`; regresní specy
      `spec/lib/qes/verify_parity_spec.rb` a `spec/requests/qes_template_errors_spec.rb`.
      Ověřeno: `make qes-test-qes` 413/0 + JS 33/0, `make qes-test` 655/0, `make qes-test-postgres` 660/0.
      Kombinace QES a non-QES u **různých** signerů je záměrně zakázaná (`qes_all_signers_required`);
      u **stejného** signera lze mít `qes` i `signature` pole (QES krok jde poslední a kryje i vykreslený podpis).

- [x] **Nasazení oprav finálního auditu (2026-10-28):** staging **v22**
      (`deployment-01M60WHPTS8KJXQ4AX0H0HN5YF`), produkce **v48**
      (`deployment-01M60WZEE84GAQED00DPZZJSW7`), obě z forku `1b3bb645` (pushnuto na GitHub i giteu).
      `/up` 200 na obou, produkce `Qes::Config`: `enabled=true`, `signature_reserve=65536`, `require_ltv=true`,
      trust roots 6 (PostSignum), TSA roots 1, `tsa_url=http://timestamp.digicert.com`; `/api/qes/verify`,
      `/api/qes/documents` i `/api/tools/verify` → 401 (endpointy žijí).
      Staging e2e: `make qes-staging-e2e` 2 signeři → 6 signatur INTACT (report
      `test/out/qes-staging-e2e-report.txt`), `make qes-staging-e2e-pdf` 3 signatury, podpis appky
      INTACT:TRUSTED (report `test/out/qes-pdf-staging-report.txt`); `ILLEGAL_MODIFICATIONS`
      v pyHanko výstupu je jen u mezikroků s DocTS (skript prošel, `make_exit=0`).

- [x] **Deploy refaktoru touch surface (2026-10-28):** staging **v23**
      (`deployment-01M61AV6F9WY08H56R0G8E8B60`), produkce **v49**
      (`deployment-01M61B1JFJR0W49WE6GG966128`), obě z forku `d845ba42` (pushnuto na GitHub i giteu).
      `/up` 200 na obou; produkce `Qes::Config`: `enabled=true`, `signature_reserve=65536`,
      `require_ltv=true`, trust roots 6 (PostSignum), TSA roots 1, `tsa_url=http://timestamp.digicert.com`,
      extensions `[true, true, true]`; `/api/qes/verify`, `/api/qes/documents` i `/api/tools/verify` → 401,
      `/qes/sessions/unknown/document` → 404 `unknown_token`, `/qes-test/root.crl` → 404.
      Staging e2e: `make qes-staging-e2e` 2 signeři → 6 signatur (report
      `test/out/qes-staging-e2e-report.txt`), `make qes-staging-e2e-pdf` 3 signatury, podpis appky
      INTACT:TRUSTED (report `test/out/qes-pdf-staging-report.txt`).

- [x] **Český verification trust store (2026-10-28):** fork `cfd36b2c` přidává `config/qes/czech.pem`
      (29 certů: PostSignum, I.CA, eIdentity, NCA, KB) a odděluje signing `QES_TRUST_ROOTS`
      (PostSignum) od verification `QES_VERIFICATION_TRUST_ROOTS` (české CA). Produkce **v52**
      (`deployment-01M61T89AGF8RJPMPQ5F1TSC0Y`), staging **v25**
      (`deployment-01M61RKSP8C594JRPAEKTR3VZT`); staging secret
      `QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/czech.pem`.
      Ověřeno: prod signing 6 / verification 29, staging signing 7 / verification 30, `/up` 200,
      `POST /api/qes/verify` a `/api/qes/documents` → 401, `/qes-test/root.crl` → 404,
      `make qes-staging-e2e` (6 signatur) a `make qes-staging-e2e-pdf` (3 signatury) zelené;
      `make qes-test-qes` 419/0, `make qes-test-fast` 526/0.

- [x] **Defaulty pro český deployment ve forku a zjednodušená produkce (2026-10-28):** fork `b2396604`
      má v `Qes::Config::DEFAULTS` `QES_ENABLED=true`, PostSignum CRL hosty, PostSignum trust roots,
      DigiCert TSA a `require_ltv=true`; produkce **v51** (`deployment-01M61NDWNT8R8VA1HH9GEHBMG1`)
      po `fly secrets unset` drží jen `QES_PUBLIC_BASE_URL` + `QES_ANDROID_CERT_SHA256` (+ SMTP).
      Ověřeno `Qes::Config` na stroji, CRL fetch, `/up` 200, `POST /api/qes/*` 401,
      `/qes/sessions/unknown/document` 404, `/qes-test/root.crl` 404. Testy: T0 416/0, T1 523/0, T2 659/0.
      Staging v23 běží ze staršího forku s explicitními defaulty; při dalším deployi může zjednodušit stejně.

- [x] **TOFU pro podpisové odkazy z více instancí (2026-10-29):** Nastavení drží jen
      `Server URL` + API token pro **přímý podpis PDF a ověření PDF**; podpisový odkaz
      nese origin serveru (HTTPS host, custom scheme `server`) a appka ho při prvním
      použití potvrdí (TOFU). Důvěryhodné servery jsou v `dataStorage`
      (`cz.dokulachtan.signer.trusted_servers`) a v *Nastavení → Důvěryhodné servery
      pro podpisové odkazy* je lze odvolat. `server_url` z payloadu musí odpovídat
      originu odkazu, jinak `foreign_server`; odkazy bez serveru skončí
      `missing_server` (žádný tichý fallback do Nastavení). Ověřeno: `make qes-test-qes` 422/0,
      `make qes-js-test` 33/0, `make qes-app-test` 223/0, `make qes-app-typecheck`.

## Pravidla modifikací forku

- Refaktor 2026-10-28: 36 → **21** upstream souborů, 783 → **233** řádků, **0** opsaného upstream kódu; detail [docs/23-refaktor-touch-surface.md](docs/23-refaktor-touch-surface.md).

- **Žádná duplikace upstream kódu** — hook jen volá náš kód (`nil` = pokračuj) nebo `super`.
- **Explicitní seam > prepend s kopií** — malý parametr/větev, výchozí cesta upstreamu beze změny.
- **`prepend`/`include` jen pro nové chování** — validace, callbacky, asociace, `rescue_from`.
- **Konfigurace mimo upstream soubory** — i18n, routes, testy, Tailwind, UI komponenty.
- **Obecné bugfixy do upstreamu**, nový dotek jen s odůvodněním, touch surface budgetem a contract testem; detail [docs/08-fork-workflow.md](docs/08-fork-workflow.md).

## Pravidla

- Fork zůstává **AGPL-3.0 + attribution**; patch minimální a rebasovatelný.
- Klíč nikdy neopustí telefon/čip; server vidí jen hash a podpis.
- AdES se nikdy nesmí vydávat za QES (kontrola QCStatements `QcSSCD`).
- Tajemství (SMTP, klíče) jen přes `fly secrets` / `.env`, nikdy do repa.
