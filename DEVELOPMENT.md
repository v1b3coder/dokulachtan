# Vývoj

Vstupní bod pro vývojáře. Uživatelský přehled je v [README.md](README.md), závazný koncept
v [DESIGN.md](DESIGN.md), detailní specifikace v [SPEC.md](SPEC.md) a plán v [PLAN.md](PLAN.md).
Pravidla pro práci v repu a aktuální stav jsou v [AGENTS.md](AGENTS.md).

## Co je v repu

| Cesta | Co to je |
|---|---|
| `mobile/app` | Expo appka (Android first, iOS připravený) |
| `vendor/docuseal` | lokální klon forku, gitignored; pin = `vendor/docuseal.rev` |
| `scripts/` | testovací a e2e skripty |
| `test/` | fixtures, certifikáty, QES test image |
| `deploy/` | Fly.io konfigurace a stránka s APK |
| `docs/` | průzkum, audity a runbooky (mapa níže) |

Fork obsahuje **jen kód patche**. Dokumentace, appka, skripty ani deploy konfigurace ve forku nejsou.

## Rychlý start

```bash
make venv              # .venv s pyHanko a podman-compose
make fork-setup        # klon forku + větev dokulachtan (pin z vendor/docuseal.rev)
make qes-test-images  # test image pro RSpec
make qes-test-qes      # QES specy na SQLite (rychlá smyčka)
```

Volitelně `cp .env.example .env.local` pro lokální hodnoty (interní Gitea místo GitHubu,
`TEST_PKI_DIR`). `.env.local` je gitignored.

Pro `spec/system` navíc `make qes-test-assets` (kopie assetů z produkčního image).

## Testovací smyčka

Testy jsou rozdělené do tierů podle ceny a rizika (měření a zdůvodnění:
[docs/21-audit-testu.md](docs/21-audit-testu.md)). Výchozí smyčka při vývoji QES je **T0**,
plná sada patří k PR/release, ne k každému commitu.

| Tier | Příkaz | Co dělá | Kdy | Naměřeno |
|---|---|---|---|---|
| **T0** | `make qes-test-qes` | QES specy na SQLite + JS testy kroku | po každé změně QES vrstvy (nejrychlejší signál) | 404/0 za 43 s |
| **T0** | `make qes-test-parallel` | totéž paralelně (4 workery) | když potřebuješ T0 rychleji | 404/0 za **25 s** |
| **T1** | `make qes-test-fast` | celá sada bez `spec/system` (bez Chromia) | před commitem forku | 511/0 za 81 s |
| **T1** | `make qes-test-parallel-fast` | totéž paralelně | před commitem, když spěcháš | 511/0 za 43 s |
| **T2** | `make qes-test` | celá RSpec sada na SQLite kromě dashboard specu | před PR / po rebase | 647/0 za 3 min 20 s |
| **T2** | `make qes-test-parallel-full` | totéž paralelně (potřebuje system image) | před PR, když spěcháš | 647/0 za **90 s** |
| **T3** | `make qes-test-postgres` | celá RSpec sada na Postgresu 18 | před vydáním, parita s upstream CI | 651/0 za 3 min 37 s |
| — | `make qes-js-test` | node testy logiky QES kroku | po změně `qes_step_logic.mjs` | 33/0 za 0,2 s |
| — | `make qes-app-test` | Jest testy appky (vault, P12, signer, API) | po změně appky | 212/0 za 13 s |
| — | `make qes-app-typecheck` | TypeScript kontrola appky | před commitem appky | — |
| — | `make qes-test-timings` | přeměří časy spec souborů pro paralelní runner | po velké změně skladby speců | — |

Pro `spec/system` navíc `make qes-test-assets` (kopie assetů z produkčního image).

`make qes-test-parallel*` = N kontejnerů (`QES_PARALLEL_WORKERS`, default 4), každý
s vlastní SQLite DB. Dělení podle naměřených časů v `test/qes/timings.txt`, soubory nad
45 s se dělí po examplech (`file:řádek`), aby jeden soubor nedržel podlahu. Detaily:
[test/qes/README.md](test/qes/README.md).

`make qes-test` a spol. mají `pipefail`, takže červený RSpec už neprojde jako úspěch
(dřív `rspec … | tee` maskoval exit kód).

## E2E

| Příkaz | Co dělá |
|---|---|
| `make qes-e2e` | fork + podpis **kódem appky** → validované PDF |
| `make qes-e2e-two` | dva signeři → 4 signatury (2× appka + 2× pečeť) |
| `make qes-e2e-pdf` | přímý podpis PDF: upload, náhled, umístění pečeti, podpis |
| `make qes-verify-e2e` | ověření PDF: valid, uložení, tampered, unsigned |
| `make qes-negative` | negativní scénáře N1–N17 |
| `make qes-e2e-card` | varianta A s fake čipem (test QSCD cert) |
| `make qes-eu-dss-verify` | volitelně: kontrola PDF přes EU DSS API (PDF opouští stroj) |

Reporty jdou do `test/out/`. E2E potřebuje `.venv` a klon forku z `make fork-setup`.

## Staging

| Příkaz | Co dělá |
|---|---|
| `make qes-staging-e2e` | 2 signeři na stagingu → 4 signatury |
| `make qes-staging-same-signer` | stejný podepisující podepíše 2 pole |
| `make qes-staging-e2e-pdf` | přímý podpis PDF na stagingu |

## Nasazení a provoz

| Příkaz | Co dělá |
|---|---|
| `make deploy-prod` | deploy podle `deploy/docuseal/fly.toml` |
| `make deploy-staging` | deploy podle `deploy/docuseal/fly.staging.toml` |
| `make smtp-setup` | nahraje `deploy/smtp.env` jako Fly secrets (`APP=` volí prostředí) |
| `make smtp-check` | ověří, že app vidí SMTP konfiguraci |
| `make smtp-test` | pošle testovací e-mail (`TO=`) |
| `make check-public` | ověří, že lokální tajemství nejsou v tracked souborech |

Konfigurace prostředí je v `deploy/docuseal/`: `fly.toml` = produkce, `fly.staging.toml` = staging.
Pro vlastní instanci uprav `app` a `primary_region` v těchto souborech. Stránka s APK je
v `deploy/apk/`; hotový APK najdeš v [Releases](https://github.com/v1b3coder/dokulachtan/releases/latest).
Detail nasazení: [docs/09-deployment-flyio.md](docs/09-deployment-flyio.md).

## Konfigurace

Konfigurace se čte z ENV s prefixem `QES_` (`Qes::Config`), hodnoty a troubleshooting jsou
v [docs/10-qes.md](docs/10-qes.md). Nejdůležitější:

| Proměnná | Default | Význam |
|---|---|---|
| `QES_ENABLED` | `true` | zapne QES vrstvu (`false` pro upstream/ne-QES) |
| `QES_TRUST_ROOTS` | `config/qes/postsignum.pem` | signing trust store: které certy smí podepsat (čárkou oddělené cesty) |
| `QES_VERIFICATION_TRUST_ROOTS` | `config/qes/czech.pem` | verification trust store: české kvalifikované CA pro ověření cizích PDF |
| `QES_REQUIRE_LTV` | `true` | vyžaduje LTV data pro certy bez CRL DP |
| `QES_LTV_ALLOWED_HOSTS` | PostSignum hosty | allowlist hostů pro CRL (SSRF ochrana) |
| `QES_TSA_URL`, `QES_TSA_TRUST_ROOTS`, `QES_TSA_REQUIRED` | DigiCert / `config/qes/digicert-tsa.pem` / `true` | časové razítko (RFC 3161) |
| `QES_PUBLIC_BASE_URL`, `QES_DEEP_LINK_BASE` | veřejná URL a deep link pro appku |
| `QES_PDF_MAX_BYTES`, `QES_SESSION_TTL` | limity uploadu a session |
| `QES_ANDROID_CERT_SHA256`, `QES_IOS_TEAM_ID` | App Links pro konkrétní build |

Výchozí signing trust store je PostSignum (`config/qes/postsignum.pem`), verification trust store je
český bundle (`config/qes/czech.pem`). Staging přidává testovací root do obou přes `QES_TRUST_ROOTS` a
`QES_VERIFICATION_TRUST_ROOTS`. Pro iSignum/I.CA přidej její root do `QES_VERIFICATION_TRUST_ROOTS`
(signing trust store měň jen když má daná CA podepisovat).
Defaulty jsou pro český deployment; ENV je override (`QES_REQUIRE_LTV=false` na stagingu/testech).

## Fork

Fork je větev `dokulachtan` v <https://github.com/v1b3coder/docuseal>, rebase na upstream
`docusealco/docuseal`. Pravidla, struktura patche a historie: [docs/08-fork-workflow.md](docs/08-fork-workflow.md).
`make fork-setup` klonuje pin z `vendor/docuseal.rev`; `make docuseal-up` spustí lokální DocuSeal
přes podman-compose.

## Dokumentace

| # | Dokument | Co řeší |
|---|---|---|
| 01 | [Průzkum](docs/01-pruzkum.md) | landscape QES v ČR, standardy, komerční služby |
| 02 | [Návrh](docs/02-navrh.md) | širší návrh — **překonáno dokumentem 04** |
| 03 | [Sidecar](docs/03-architektura-sidecar.md) | varianta bez forku — **překonáno dokumentem 04** |
| 04 | [Architektura forku](docs/04-architektura-fork.md) | rozhodnutí: fork, varianty A/B |
| 05 | [E2E testování](docs/05-e2e-testovani.md) | certifikáty, validátory, testovací matice (historické) |
| 06 | [Design lidsky](docs/06-design-lidsky.md) | co projekt dělá, bez odborných termínů |
| 07 | [Před implementací](docs/07-pred-implementaci.md) | checklist rozhodnutí (Expo, fork, provoz) |
| 08 | [Fork workflow](docs/08-fork-workflow.md) | větev, pravidla patche a rebase |
| 09 | [Deployment](docs/09-deployment-flyio.md) | Fly.io, prostředí, varianty |
| 10 | [QES runbook](docs/10-qes.md) | ENV, TSA, trust roots, troubleshooting |
| 11 | [Audit DESIGN/SPEC](docs/11-audit-design-spec.md) | nálezy B1–B6 a jejich oprava |
| 12 | [Audit appky](docs/12-audit-mobilni-appka.md) | nálezy G1–G10, rozhodnutí k appce |
| 13 | [Vícenásobné podpisy](docs/13-navrh-vicenasobnych-podpisu.md) | řetězení PAdES revizí |
| 14 | [Audit bezpečnosti](docs/14-audit-bezpecnost-kvalita.md) | nálezy K1–K15, M1–M9 |
| 15 | [Přímý podpis PDF](docs/15-primy-podpis-pdf.md) | nativní tok DocuSealu, rozhodnutí D1–D13 |
| 16 | [Ověření PDF](docs/16-overeni-pdf.md) | server endpoint, appka, webový panel |
| 17 | [UI hierarchie akcí](docs/17-ui-hierarchie-akci.md) | uspořádání tlačítek v appce |
| 18 | [Audit forku vs upstream](docs/18-audit-fork-vs-upstream.md) | doteky upstreamu, cena rebase |
| 19 | [Externí ověření PDF](docs/19-overeni-pdf-externi.md) | EU DSS jen v appce |

## Historické nástroje

Tyto cíle pocházejí z discovery fáze a dnes nejsou hlavní smyčka:

- `make fixtures`, `make validate`, `make negative`, `make verify` — nezávislý interop test
  PAdES bez forku (certifikáty, `pdfsig`, pyHanko, OpenSSL). Stále funkční, detail v
  [docs/05](docs/05-e2e-testovani.md).
- `make docuseal-up`, `make docuseal-down` — lokální DocuSeal z `vendor/docuseal` pro ruční
  prohlížení v browseru.

Baseline e2e proti nezměněnému upstream image a Android PoC byly odstraněny 2026-10-25;
jejich místo zaujaly `make qes-e2e*` (podpis kódem appky) a `make qes-test-qes`. Historie
zůstává v gitu a v [docs/05](docs/05-e2e-testovani.md).

## Známé problémy

- **SQLite flake** `spec/system/signing_form_spec.rb:1253` (2FA resend) — upstream flake závislý
  na pořadí; izolovaně projde. V `make qes-test` je to jediný failure.
- **LTV v testovacím prostředí** — CRL Distribution Point testovacích certů je `127.0.0.1:8765`,
  takže testovací prostředí hlásí `UNTRUSTED` (stejně jako dřív).
- **APK z Releases** neotevře App Links, dokud v DocuSealu nenastavíš `QES_ANDROID_CERT_SHA256`
  na jeho podpisový cert; podpis certem, který není v trust roots, skončí na `ltv_unavailable`.
- **iOS build** čeká na Apple Developer účet; appka je cross-platform připravená.
