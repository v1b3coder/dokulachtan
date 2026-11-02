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
| `deploy/` | Fly.io konfigurace DocuSealu a release keystore (gitignored) |
| `docs/` | průzkum, runbooky a triage (mapa níže) |

Fork obsahuje **jen kód patche**. Dokumentace, appka, skripty ani deploy konfigurace ve forku nejsou.

## Rychlý start

```bash
make test-prepare      # venv, fork, image, assety, deps, hooky
make test              # F1: T0 + app + typecheck (rychlá smyčka)
```

Volitelně `cp .env.example .env.local` pro lokální hodnoty (interní Gitea místo GitHubu,
`TEST_PKI_DIR`). `.env.local` je gitignored.

Assety pro `spec/system` řeší `make test-t2` (F3); F0 je připraví přes `make test-prepare`.

## Testy

Fáze, rozhodovací strom a mapování na interní targety: [test/README.md](test/README.md).
Veřejné entrypointy:

| Fáze | Příkaz | Kdy |
|---|---|---|
| **F0** | `make test-prepare` | po klonu / po změně Dockerfilu |
| **F1** | `make test` | před každým pushem (hook): T0 + JS + app + typecheck |
| **F2** | `make test-ci` | před PR: F1 + T1 (stejné jako CI na push/PR) |
| **F3** | `make test-full` | před release / po bumpu pinu: F2 + T2 + T3 + negativní + E2E |
| **F4** | `ALLOW_EXTERNAL=1 make test-manual` | staging E2E + EU DSS; po deployi, nikdy v CI |
| **F4** | `ALLOW_EMULATOR=1 make test-android` | emulátor + instrumentace; lokálně |
| **F4** | `make debug-phone` | debug APK na telefon (arm64) |
| **F4** | `make emulator` | debug APK pro emulátor (x86_64) |
| **F4** | `make release TAG=v1.3.10` | release APK v CI na tag |
| **F5** | `make test-tools` | fixtures, validate, legacy |

Interní tiery T0–T3 a počty: [test/README.md](test/README.md).
Hook pustí F1 s čerstvou DB; přeskočení `SKIP_QES_HOOK=1`.

## Push

Repo má dva remotes: `origin` (interní Gitea) a `github` (veřejné zrcadlo). Pre-push hook běží
pro každou push URL zvlášť, takže dva samostatné pushe znamenají dva běhy F1. Proto:

```bash
make push               # oba remotes, testy jednou
make push ARGS=main     # konkrétní refspec (i tag: ARGS=v1.3.10)
```

`scripts/push.sh` pushne nejdřív do `origin` (tam hook pustí testy) a pak do `github` s `--no-verify`.
Pro jeden remote použij `git push origin` / `git push github` přímo.

## CI

- `.github/workflows/qes.yml` — push `main`/PR: F2; schedule/dispatch: F3;
  `workflow_call full: true` (release): F3.
- `.github/workflows/android-release.yml` — tag `v*`; `qes` job pouští F3, `build` na něm závisí.
- Reporty se ukládají jako artefakty (14 dní), ne do gitu.
- Fork se checkoutuje na pin, ne na head větve.

## E2E a manuální testy

- `make test-e2e` — F3: fork + podpis kódem appky, dva signeři, přímý podpis PDF, verify, fake čip.
- `make test-manual` — F4: staging E2E a EU DSS; vyžaduje živý staging a `ALLOW_EXTERNAL=1`.
- `make test-android` — F4: emulátor + instrumentace; dnes TODO.
- `make debug-phone` — F4: debug APK na telefon (arm64).
- `make emulator` — F4: debug APK pro emulátor (x86_64).
- `make release TAG=v1.3.10` — F4: release APK se staví v CI na tag.
- `make test-card` — F4: reálná čtečka; dnes stub.

Podrobnosti a co se netestuje: [test/README.md](test/README.md).

## Staging (F4a)

| Příkaz | Co dělá |
|---|---|
| `make qes-staging-e2e` | 2 signeři na stagingu → 6 signatur |
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

Konfigurace prostředí je v `deploy/docuseal/`: `fly.toml` = produkční instance, `fly.staging.toml` = staging.
Produkce = **privátní instance uživatele s produkčním kódem** (dnes Fly app `dokulachtan`), ne centrální
služba; adresa instance se v každém nasazení mění. Pro vlastní instanci uprav `app` a `primary_region` v těchto souborech. Hotový APK najdeš
v [Releases](https://github.com/v1b3coder/dokulachtan/releases/latest); debug-phone/emulator build se staví lokálně.
Detail nasazení: [docs/09-deployment-flyio.md](docs/09-deployment-flyio.md).

## Konfigurace

Konfigurace se čte z ENV s prefixem `QES_` (`Qes::Config`), hodnoty a troubleshooting jsou
v [docs/10-qes.md](docs/10-qes.md). Nejdůležitější:

| Proměnná | Default | Význam |
|---|---|---|
| `QES_ENABLED` | `true` | feature gate forku: `false` = upstream chování, QES endpointy 404, žádná QES validace; regenerované PDF ztratí QES revizi |
| `QES_TRUST_ROOTS` | `config/qes/postsignum.pem` | signing trust store: které certy smí podepsat (čárkou oddělené cesty) |
| `QES_VERIFICATION_TRUST_ROOTS` | `config/qes/czech.pem` | verification trust store: vydávající CA pro ověření cizích PDF (anchory, ne rooty) |
| `QES_REQUIRE_LTV` | `true` | CRL pro každý ne-kořenový cert; `false` = cert bez CRL DP se přeskočí |
| `QES_LTV_ALLOWED_HOSTS` | PostSignum a I.CA hosty | allowlist hostů pro CRL (SSRF ochrana); prázdná hodnota = jen https a veřejná adresa |
| `QES_TSA_URL`, `QES_TSA_TRUST_ROOTS`, `QES_TSA_REQUIRED` | DigiCert / `config/qes/digicert-tsa.pem` / `true` | časové razítko (RFC 3161) |
| `QES_PUBLIC_BASE_URL`, `QES_DEEP_LINK_BASE` | veřejná URL a deep link pro appku |
| `QES_PDF_MAX_BYTES`, `QES_SESSION_TTL` | limity uploadu a session |
| `QES_IOS_TEAM_ID` | iOS Universal Links (AASA) pro konkrétní build |

Výchozí signing trust store je PostSignum (`config/qes/postsignum.pem`), verification trust store je
český bundle (`config/qes/czech.pem`) s jen vydávajícími CA (žádné rooty). Staging přidává testovací root do obou přes `QES_TRUST_ROOTS` a
`QES_VERIFICATION_TRUST_ROOTS`. Pro iSignum/I.CA přidej její vydávající CA do `QES_VERIFICATION_TRUST_ROOTS`
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
| 01 | [Průzkum](docs/01-pruzkum.md) | landscape QES v ČR (historický průzkum) |
| 04 | [Architektura forku](docs/04-architektura-fork.md) | rozhodnutí: fork, varianty A/B |
| 06 | [Design lidsky](docs/06-design-lidsky.md) | co projekt dělá, bez odborných termínů |
| 07 | [Před implementací](docs/07-pred-implementaci.md) | checklist rozhodnutí (Expo, fork, provoz) |
| 08 | [Fork workflow](docs/08-fork-workflow.md) | větev, pravidla patche a rebase |
| 09 | [Deployment](docs/09-deployment-flyio.md) | Fly.io, prostředí, varianty |
| 10 | [QES runbook](docs/10-qes.md) | ENV, TSA, trust roots, troubleshooting |
| 13 | [Vícenásobné podpisy](docs/13-navrh-vicenasobnych-podpisu.md) | řetězení PAdES revizí |
| 15 | [Přímý podpis PDF](docs/15-primy-podpis-pdf.md) | nativní tok DocuSealu, rozhodnutí D1–D13 |
| 16 | [Ověření PDF](docs/16-overeni-pdf.md) | server endpoint, appka, webový panel |
| 17 | [UI hierarchie akcí](docs/17-ui-hierarchie-akci.md) | pravidla uspořádání tlačítek v appce |
| 19 | [Externí ověření PDF](docs/19-overeni-pdf-externi.md) | EU DSS jen v appce |
| 24 | [Triage issues](docs/24-triage-issues.md) | otevřené nálezy R3/R4 proti aktuálnímu kódu |


## Historické nástroje

Tyto cíle pocházejí z discovery fáze a dnes nejsou hlavní smyčka:

- `make fixtures`, `make validate`, `make negative`, `make verify` — nezávislý interop test
  PAdES bez forku (certifikáty, `pdfsig`, pyHanko, OpenSSL). Stále funkční, ale není
  součástí běžné smyčky.
- `make docuseal-up`, `make docuseal-down` — lokální DocuSeal z `vendor/docuseal` pro ruční
  prohlížení v browseru.

Baseline e2e proti nezměněnému upstream image a Android PoC byly odstraněny 2026-10-25;
jejich místo zaujaly `make qes-e2e*` (podpis kódem appky) a `make qes-test-qes`. Historie
zůstává v gitu.

## Známé problémy

- **LTV v testovacím prostředí** — CRL Distribution Point testovacích certů je `127.0.0.1:8765`,
  takže testovací prostředí hlásí `UNTRUSTED` (stejně jako dřív); staging to řeší test CRL na
  staging hostu.
- **APK z Releases** otevírá signing flow přes custom scheme `dokulachtan://` (systémový chooser);
  Android App Links byly zrušeny (#18.1). Produkce „Dokulachtan“, debug-phone „Dokulachtan (debug)“,
  emulator „Dokulachtan (emulator)“ — chooser je rozliší. Podpis certem, který není v trust roots, skončí na `ltv_unavailable`.
- **iOS build** čeká na Apple Developer účet; appka je cross-platform připravená.
- **Otevřené nálezy** ze třetí a čtvrté kontroly: [docs/24-triage-issues.md](docs/24-triage-issues.md).
