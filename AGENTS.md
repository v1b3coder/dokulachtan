# AGENTS.md — dokulachtan

Hlavní rozcestník projektu. Detaily jsou v `docs/`; tento soubor drží cíl, rozhodnutí a provoz.

## Co je cílem

Přidat do [DocuSeal](https://github.com/docusealco/docuseal) podporu podpisu **certifikátem**
(AdES/QES) tak, aby klíč zůstal u člověka (v telefonu nebo v čipu občanky) a nikdy se nenahrál
na server. Výsledkem je upravený DocuSeal (fork) + mobilní appka.

- **Závazný koncept (co a proč): [DESIGN.md](DESIGN.md)** — aplikační design celého workflow a appky.
- **Detailní specifikace (jak přesně): [SPEC.md](SPEC.md)** — datový model, API, protokol,
  obrazovky, testy; odvozená z DESIGN.md. **Implementační plán: [PLAN.md](PLAN.md)** — fáze P0–P8.
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
6. **Ověřeno, že to jde:** e2e toolchain, DocuSeal API baseline, negativní/LTV scénáře a podpis
   kódem appky (`make qes-e2e*`). Detail: [DEVELOPMENT.md](DEVELOPMENT.md#e2e).

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
    Aktuální měření: T2 659/0 (SQLite), T3 660/0 (Postgres 18).
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
    výchozí v `Qes::Config::DEFAULTS`; ENV je jen override. Produkční instance tak v secrets drží jen
    `QES_PUBLIC_BASE_URL` a `QES_ANDROID_CERT_SHA256`; staging přepisuje trust roots,
    `QES_REQUIRE_LTV=false`, test CRL a allowlist. Detail: SPEC § 7.4 a § 11, `docs/10-qes.md`.

## Deployment

### Prostředí: co znamená „produkce“

Vyvíjíme **self-hosted software** (fork DocuSealu + appka), ne centrální službu. Neexistuje jedna
„naše produkce“, ke které by se připojovali cizí uživatelé — každý si instanci nasadí u sebe. Proto:

- **Produkce** = **privátní instance uživatele s produkčním kódem**. Dnes Fly app `dokulachtan`
  v osobním Fly účtu. `https://dokulachtan.fly.dev/` je jen adresa této konkrétní instance,
  **ne adresa produktu, centrální API ani „náš server“**.
- **Staging** = druhá privátní instance téhož uživatele (`dokulachtan-staging`) pro testování; není to veřejná beta
  ani demo pro uživatele.
- **Vývoj** = lokální běh a testy; žádná veřejná instance.
- **`RAILS_ENV=production`** / `production.rb` / `database.yml` → `production:` je jen prostředí Rails,
  ne „produkce“ v tomto smyslu.
- **Upstream DocuSeal SaaS** (<https://www.docuseal.com>) je cizí služba, ne naše produkce.

Pravidla pro agenty:

- Nepředpokládej centrální URL ani centrální backend. Když dokument potřebuje konkrétní adresu, označ ji
  jako „adresa konkrétní instance“ a připomeň, že se v každém nasazení mění (`QES_PUBLIC_BASE_URL`,
  server URL v appce, `app` ve `fly*.toml`).
- Proti produkční instanci nic netestuj a nic na ní nespouštěj, pokud to zadání výslovně nechce; výchozí je
  lokální běh a testy (`make qes-test`, `make qes-e2e`).
- `make deploy-prod` je nasazení na produkční instanci uživatele, ne release do centrální služby ani publikace
  pro všechny uživatele.
- Adresa uživatelovy instance nesmí být ve forku ani v serverovém kódu výchozí hodnotou pro cizí nasazení;
  v appce je výchozí server URL věcí konkrétního buildu (viz Testovací APK níže).

**Dvě prostředí, varianta A — 1 Fly app + volume + SQLite** (bez Postgresu), region `fra`.
Konfigurace v parent repu: `deploy/docuseal/fly.toml` = produkční instance, `fly.staging.toml` = staging;
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

| Prostředí | Instance / adresa (mění se podle nasazení) | Volume | Trust roots | LTV |
|---|---|---|---|---|
| **Produkce** (privátní instance uživatele) | `dokulachtan` / <https://dokulachtan.fly.dev/> | `dokulachtan_prod_data` | jen PostSignum CA | `true` |
| **Staging** (privátní instance uživatele) | `dokulachtan-staging` / <https://dokulachtan-staging.fly.dev/> | `dokulachtan_stg_restore` | test root + PostSignum CA | `false` |

Adresy platí jen pro tyto konkrétní instance; v jiném nasazení se mění (`app` ve `fly*.toml`,
`QES_PUBLIC_BASE_URL`, server URL v appce).

**Produkce — instance `dokulachtan`**:

- machine `811d97df9d6e08`, volume `dokulachtan_prod_data` (1 GB, `fra`, snapshoty) → `/data/docuseal`;
  starý volume `dokulachtan_data` byl smazán 2026-10-18.
- Release **v52** (`deployment-01M61T89AGF8RJPMPQ5F1TSC0Y`), fork `cfd36b2c`.
- `Qes::Config`: signing trust roots 6× PostSignum, verification trust roots 29 českých CA
  (`config/qes/czech.pem`), `require_ltv=true`, `tsa_url=http://timestamp.digicert.com`,
  TSA roots 1, `tsa_required=true`; CRL fetch z produkční instance OK.
- V secrets jen `QES_PUBLIC_BASE_URL`, `QES_ANDROID_CERT_SHA256` a SMTP; ostatní defaulty
  jsou ve forku (`QES_ENABLED=true`, PostSignum CRL hosty a trust roots, DigiCert TSA).
- healthcheck `/up` 200, `/` → `/setup` (čeká na první účet); migrace automaticky,
  `SECRET_KEY_BASE` + `docuseal.env` + SQLite na volume.
- `/api/qes/verify`, `/api/qes/documents` i `/api/tools/verify` → 401;
  `/qes/sessions/unknown/document` → 404; `/qes-test/root.crl` → 404.
- První účet (setup) vytváří uživatel v prohlížeči; SMTP Brevo, `SMTP_FROM=<SMTP_FROM>`,
  `deploy/smtp.prod.env` (gitignored).
- **Fly `QES_ANDROID_CERT_SHA256`** je fingerprint Android podpisu testovacího APK (nyní debug
  `FA:C6:…:9C`), ne certifikátu dokumentu; při nasazení produkčního APK z CI se přepne na
  `80:DC:…:E0`.

**Staging — instance `dokulachtan-staging`**:

- machine `78111546b1dd68`, volume `dokulachtan_stg_restore` (1 GB, `fra`) → `/data/docuseal`;
  obnovený ze snapshotu starého staging volume, má účet `<SMTP_FROM>` a šablonu
  „QES E2E (staging)“.
- Release **v25** (`deployment-01M61RKSP8C594JRPAEKTR3VZT`), fork `cfd36b2c`.
- Override: `QES_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/postsignum.pem`,
  `QES_VERIFICATION_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/czech.pem`,
  `QES_REQUIRE_LTV=false`,
  `QES_LTV_ALLOWED_HOSTS=crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,dokulachtan-staging.fly.dev`,
  `QES_TEST_CRL_PATH=/app/config/qes/test-root.crl`,
  `QES_PUBLIC_BASE_URL=https://dokulachtan-staging.fly.dev`,
  `QES_ANDROID_CERT_SHA256=FA:C6:…:9C`.
- Ověřeno: `make qes-staging-e2e` 2 signeři → 6 signatur INTACT (report
  `test/out/qes-staging-e2e-report.txt`), `make qes-staging-e2e-pdf` 3 signatury,
  podpis appky INTACT:TRUSTED (report `test/out/qes-pdf-staging-report.txt`).
- SMTP Brevo free (300 e-mailů/den), stejné creds jako produkční instance (`deploy/smtp.env`);
  ověřeno `make smtp-check` a `make smtp-test`.

**Testovací APK:** <https://dokulachtan-download.fly.dev/dokulachtan-signer.apk> (Fly app
`dokulachtan-download`, `deploy/apk/`). Je to **debug-signed** Android build (`fac61745…3b9c`)
s **testovacím certifikátem pro podpis dokumentů** (E2E) a stub čtečky; **produkční PostSignum
cert se do APK nepeče** — uživatel ho importuje jako `.p12`, nebo použije čtečku.
Verze v repu **1.3.9** (versionCode 10309; na Fly **1.3.8**). Výchozí server URL v buildu
je adresa **produkční instance uživatele** (ne centrální server); na staging se přepíná v appce *Nastavení → Server URL* a odkaz se otevírá
custom scheme `dokulachtan://sign?token=…` (funguje vždy). App Links (HTTPS) jsou vázané na host
zapečený v buildu (`dokulachtan.fly.dev`), proto by staging vyžadoval rebuild APK s hostem
`dokulachtan-staging.fly.dev`. APK se nasazuje `cd deploy/apk && fly deploy -a dokulachtan-download`
(soubor `deploy/apk/*.apk` je gitignored).
- Konfigurace: `deploy/docuseal/fly.toml` a `fly.staging.toml` v parent repu (`make deploy-prod` /
  `make deploy-staging`; Dockerfile upstream, port 3000, healthcheck `/up`, volume na
  `/data/docuseal`, auto-stop); migrace automaticky při startu; `SECRET_KEY_BASE` +
  `docuseal.env` + SQLite na volume (každé prostředí vlastní).
- SMTP: **Brevo free** (300 e-mailů/den) nasazeno na obou prostředích 2026-10-18 — `SMTP_FROM=<SMTP_FROM>`
  (registrační adresa účtu = ověřený sender; doménu Brevo přepíše na `@<id>.brevosend.com`, protože
  `example.com` autentizované není), stejné přihlašovací údaje (`deploy/smtp.env` / `deploy/smtp.prod.env`, oba gitignored) →
  `make smtp-setup APP=…` (`SMTP_FILE=deploy/smtp.prod.env` pro produkční instanci), `make smtp-check APP=…`,
  `make smtp-test APP=… TO=adresa@example.com`.
- Detail a varianty (Postgres/S3/větší nasazení): [docs/09-deployment-flyio.md](docs/09-deployment-flyio.md),
  QES runbook [docs/10-qes.md](docs/10-qes.md).

```bash
# z parent repa (config v deploy/docuseal/, fork v vendor/docuseal)
fly apps create dokulachtan-staging --org personal
fly volumes create dokulachtan_stg_restore --region fra --size 1 -a dokulachtan-staging
make deploy-staging                    # staging (deploy/docuseal/fly.staging.toml)
make deploy-prod                       # produkční instance (deploy/docuseal/fly.toml)
```

## Mapa repa

```
docs/           průzkum, runbooky, triage
 01-pruzkum.md           landscape QES v ČR (historický průzkum)
 04-architektura-fork.md  rozhodnutí: fork, varianty A/B
 06-design-lidsky.md      design bez odborných termínů
 07-pred-implementaci.md  checklist rozhodnutí (Expo, fork, provoz)
 08-fork-workflow.md      větev dokulachtan, rebase pravidla
 09-deployment-flyio.md   Fly.io analýza a zvolená varianta A
 10-qes.md                runbook QES (ENV, TSA, trust roots, troubleshooting)
 13-navrh-vicenasobnych-podpisu.md  návrh vícenásobných podpisů (implementováno)
 15-primy-podpis-pdf.md   přímý podpis PDF nativním tokem DocuSealu
 16-overeni-pdf.md        ověření PDF: server endpoint, appka S14/S15, web
 17-ui-hierarchie-akci.md  pravidla hierarchie akcí v appce
 19-overeni-pdf-externi.md  externí ověření PDF přes EU DSS (jen appka)
 24-triage-issues.md      triage otevřených GitHub issues (R3/R4)
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
make qes-e2e-two  # fork + 2 signeři → 6 signatur (2× appka + 2× pečeť + 2× DocTS), validované PDF
make qes-e2e-pdf  # přímý podpis PDF (docs/15): upload + náhled + place + podpis kódem appky
make qes-eu-dss-verify  # volitelné: compliance PDF přes EU DSS API (PDF opouští stroj)
make qes-negative # negativní scénáře N1–N17 proti forku
make qes-staging-e2e  # staging + 2 signeři přes fly ssh → 6 signatur, validované PDF
make qes-staging-same-signer  # staging: stejný podepisující 2× (2 pole) → 6 signatur INTACT
make qes-staging-e2e-pdf  # staging: přímý podpis PDF (docs/15) → upload, place, podpis kódem appky
make qes-e2e-card # fork + podpis fake čipem (A, test QSCD cert) → validované PDF
make smtp-setup   # SMTP (Brevo) → fly secrets; APP=dokulachtan-staging|dokulachtan (viz docs/09)
make smtp-check   # ověří, že app vidí SMTP konfiguraci
make smtp-test    # pošle testovací e-mail přes SMTP na adresu TO=
make qes-app-test # Jest testy appky (vault, P12, signer, API)
make qes-app-typecheck # TypeScript kontrola appky
```

### Testy: kdy co pouštět

Testy jsou rozdelené do **tierů** podle ceny a rizika; runbook a naměřené časy:
[test/qes/README.md](test/qes/README.md). Nepouštěj celou sadu na každý commit — většina
času jde na upstream specy, které fork nemodifikuje.

| Tier | Cíl | Rozsah | Kdy | Naměřeno |
|---|---|---|---|---|
| **T0** | `make qes-test-qes` | QES vrstva + JS testy kroku | **po každé změně** QES vrstvy (výchozí smyčka) | 422 ex, 43 s |
| **T0** | `make qes-test-parallel` | totéž, 4 workery | když potřebuješ T0 rychleji | 422 ex, **25 s** |
| **T1** | `make qes-test-fast` | celá sada bez `spec/system` | **před commitem** forku | 526 ex, 81 s |
| **T1** | `make qes-test-parallel-fast` | totéž, 4 workery | před commitem, když spěcháš | 526 ex, 43 s |
| **T2** | `make qes-test` | celá sada kromě `dashboard_spec` | **před PR / po rebase** | 659 ex, 3 min 20 s |
| **T2** | `make qes-test-parallel-full` | totéž, 4 workery | před PR, když spěcháš | 659 ex, **90 s** |
| **T3** | `make qes-test-postgres` | celá sada na Postgresu 18 | **před vydáním** (parita s upstream CI) | 660 ex, 3 min 37 s |
| — | `make qes-js-test` | node testy logiky QES kroku | po změně `qes_step_logic.mjs` (jinak v T0) | 33 ex, 0,2 s |
| — | `make qes-app-test` | Jest testy appky | po změně appky | 223 ex, 13 s |
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

Aktuální stav k 2026-10-29. Historie je v gitu; níže je jen to, co platí teď.

**Hotovo**

- P0–P8 hotové kromě reálné čtečky (P5 je stub + fake card): QES vrstva (model, stavový
  automat, token), kryptografie (TBS → CMS → embed → LTV/DSS → DocTS → validace → pečeť),
  API pro appku i prohlížeč, hooky do DocuSealu.
- Vícenásobné podpisy: každý signer má vlastní pole `qes` a session, podpisy se řetězí
  inkrementálně; finální PDF má N podpisů appky + N pečetí + N DocTS.
- Přímý podpis PDF nativním tokem DocuSealu (`POST /api/qes/documents`, šablona ve složce
  „Direct signing“), sdílení PDF do appky, stažení/uložení/sdílení finálního PDF.
- Ověření PDF: `POST /api/qes/verify`, `POST /api/qes/verified_documents`, appka S14/S15,
  webový panel na template show, externí ověření přes EU DSS jen v appce.
- Trust stores: signing PostSignum, verification české CA (`config/qes/czech.pem`), TSA DigiCert;
  defaulty pro český deployment jsou v `Qes::Config::DEFAULTS`.
- Appka: Expo SDK 58, vault s AES-256-GCM a biometrií, import PKCS#12, přímý podpis
  i ověření PDF, TOFU pro podpisové odkazy z více instancí.
- Testy: tiery T0–T3 a paralelní runner; QES 422/0, appka 223/0, JS 33/0,
  T2 659/0 a T3 660/0 (2026-10-28).
- Nasazeno: produkční instance **v52** (`dokulachtan`, fork `cfd36b2c`), staging **v25**
  (`dokulachtan-staging`, fork `cfd36b2c`); `/up` 200 na obou.

**Zbývá**

- Reálná čtečka eObčanky (P5 je stub/fake card; MOI SDK) — jinak je tok A hotový.
- Kvalifikované časové razítko (nyní DigiCert free, non-qualified).
- Produkční APK podepsaný release keystorem a přepnutí `QES_ANDROID_CERT_SHA256`
  na release fingerprint; testovací APK je debug-signed. Do té doby App Links na produkční instanci
  používají debug fingerprint (triage #18.1).
- První reálný podpis na produkční instanci s PostSignum certem.
- TOFU ve forku `f1c28c2b` (origin serveru v podpisovém odkazu) — na produkčních instancích
  zatím není nasazený; před použitím TOFU odkazu nasadit.
- Otevřené nálezy z triage: [docs/24-triage-issues.md](docs/24-triage-issues.md).

## Pravidla modifikací forku

- Refaktor 2026-10-28: 36 → **21** upstream souborů, 783 → **232** řádků, **0** opsaného upstream kódu.

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
- **„Produkce“ = privátní instance uživatele** s produkčním kódem (dnes Fly app `dokulachtan`), ne centrální
  služba ani konkrétní URL; `RAILS_ENV=production` je jen prostředí Rails. Adresa instance se v každém nasazení mění.
