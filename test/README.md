# Testy — fáze a entrypointy

Jediný rozcestník. Detaily harnessu (image, SQLite, paralelní runner): [qes/README.md](qes/README.md).
CI: [`.github/workflows/qes.yml`](../.github/workflows/qes.yml); release gate:
[`android-release.yml`](../.github/workflows/android-release.yml).

## Kdy pustit co

| Co měníš | Fáze | Příkaz |
|---|---|---|
| QES/server (fork) před commitem | **F1** | `make test` |
| appku (`mobile/app`) | **F1** | `make test` |
| před PR | **F2** | `make test-ci` |
| po bumpu pinu / před release | **F3** | `make test-full` |
| staging E2E, EU DSS | **F4** | `ALLOW_EXTERNAL=1 make test-manual` |
| APK / emulátor | **F4** | `ALLOW_EMULATOR=1 make test-android` |
| harness, legacy fixtures | **F5** | `make test-tools` |
| po klonu / po změně Dockerfilu | **F0** | `make test-prepare` |

Hook `.githooks/pre-push` pustí **F1** (T0 + app + typecheck) s čerstvou DB.
Přeskočení: `SKIP_QES_HOOK=1 git push`.

## Fáze

| Fáze | Cíl | Co pouští | Potřebuje | Čas | Kdy |
|---|---|---|---|---|---|
| **F0** | `make test-prepare` | venv, fork, image, assety, `npm ci`, `yarn install`, hooky | síť | 2–5 min cold | po klonu, po změně Dockerfilu |
| **F1** | `make test` | T0 + JS + app Jest + typecheck | fork, node_modules, test image | ~1,5 min | před každým pushem (hook) |
| **F2** | `make test-ci` | F1 + T1 | + test image | ~3 min | před PR; stejné jako CI na push/PR |
| **F3** | `make test-full` | F2 + T2 + T3 + negativní + E2E | + system image, assety, venv, síť DigiCert | ~13 min | před release; stejné jako CI full |
| **F4a** | `make test-staging` | staging E2E ×3 | **živý staging**, Fly, síť | ~5 min | po `make deploy-staging`, nikdy v CI |
| **F4b** | `make test-android` | APK + emulátor/instrumentace | SDK, KVM | ~15–30 min | po buildu APK, lokálně |
| **F4c** | `make test-eu-dss` | EU DSS | externí API, PDF opouští stroj | ~1,5 min | ručně, nikdy v CI |
| **F4d** | `make test-card` | reálná čtečka: průzkum čipu (bez PINu) | hardware | — | čip ověřen 2026-11-05, podpis `make qes-e2e-card-real` (docs/26 § 7) |
| **F5** | `make test-tools` | fixtures, validate, staré negative, APK fingerprint, parallel selftest | lokální nástroje | ~1,5 min | při změně harnessu/legacy |

`make test-manual` = F4a + F4c, vyžaduje `ALLOW_EXTERNAL=1`.
`make test-help` vypíše mapování fází na interní targety.

## Interní tiery (CI a debug)

Počty při pinu `c09a2891` (T0/T1 actual, T2/T3 actual):

| Tier | Cíl | Co to je | Examples | Čas |
|---|---|---|---|---|
| **T0** | `make test-t0` | QES vrstva + JS testy | 496 (484 QES + 12 upstream) + 37 JS | ~1,5 min |
| **T1** | `make test-t1` | celá sada bez `spec/system` | 603 (484 QES + 119 upstream) | ~2 min |
| **T2** | `make test-t2` | celá sada se system na SQLite (bez dashboardu) | 739 (484 QES + 255 upstream) | ~3,5 min |
| **T3** | `make test-t3` | celá sada na Postgresu 18 (včetně dashboardu) | 743 (484 QES + 259 upstream) | ~4 min |
| **app** | `make test-app` | Jest + typecheck | 268 + tsc | ~20 s |
| **negativní** | `make test-negative` | N1–N17 | 17 scénářů | ~1,5 min |
| **E2E** | `make test-e2e` | 4 běhy + fake card | — | ~2,5 min |

T2/T3 běží se system image (Chromium) a `make qes-test-assets`; T0/T1 bez Chromia.
T1/T2/T3 pouští **upstream DocuSeal specy**, ne jen QES. T0 je QES-only (+ 2 upstream model specy).

## Co se netestuje

| Vrstva | Stav |
|---|---|
| APK runtime, Android native (SecureStore, biometrie, deep links) | **ne** — E2E běží app TS v Node, ne v Androidu |
| APK artefakt po buildu | jen `apksigner verify` + fingerprint, žádný emulátor |
| Server deploy artefakt (`fly deploy`, Docker image, `assets:precompile`) | **ne** — testy jedou v produkčním image + dev/test gemy |
| Linters (Rubocop, Erlblint, ESLint, Brakeman) | **ne** — nejsou v `qes.yml` |
| Staging/live, EU DSS, reálná čtečka | **ne** — F4, mimo CI |
| Fork JS bundle v browseru | **ne** — system specy používají `public/packs` z `docuseal:latest`; fork JS kryje T0 `node --test` + compile test |

## CI mapping

| Job v `qes.yml` | Target |
|---|---|
| `t0` | `make test-t0` |
| `t1` | `make test-t1` |
| `app` | `make test-app` |
| `t2` | `make test-t2` |
| `postgres` | `make test-t3` |
| `negative` | `make test-negative` |
| `e2e` | `make test-e2e` |

Triggery: push `main`/PR → `t0`+`t1`+`app`; PR label `ci/full` → navíc `t2`;
schedule 03:00 UTC / `workflow_dispatch` / `workflow_call full: true` (release) → všech 7.
Release tag `v*` → `android-release.yml` zavolá `qes.yml` s `full: true`, `build` má `needs: qes`.

## Přidání nového testu

- QES unit/request → `spec/lib/qes` / `spec/requests/qes_*` → T0 (a T1/T2/T3).
- Upstream regrese → `spec/models`, `spec/lib`, `spec/requests`, `spec/jobs` → T1; `spec/system` → T2/T3.
- App unit → `mobile/app/__tests__/*.test.ts` → F1 `test-app`.
- Integrační tok appka↔server → `scripts/qes_*_e2e.py` → F3 `test-e2e`.
- Proti živému serveru → `scripts/qes_staging_*` → F4a `test-staging`, nikdy do F1/F2/F3.
- Emulátor/instrumentace → F4b `test-android`, nikdy do F1/F2/F3.

## Legacy a nástroje

`make test-tools` = `make verify` (fixtures + validate + staré negative), `make apk-fingerprint-test`,
`make qes-test-parallel-selftest`. Historická interop vrstva, ne součást QES CI.

`make qes-test-parallel*` jsou lokální optimalizace (ne fáze), `make qes-test-timings` je generátor
časů, `make qes-test-image*`/`qes-test-assets` jsou příprava (F0).
