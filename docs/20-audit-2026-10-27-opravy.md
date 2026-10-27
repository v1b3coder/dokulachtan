# Audit druhého kola — opravy (2026-10-27)

Navazuje na nálezy N1–N8 a S1–S7 z druhé kontroly (26. 10. 2026).
Kontrolované větve: fork `dokulachtan`, parent `main`; stav před opravami
`b2150a10` / `b56b354` (v repu o testovací CRL dál).

## Co bylo opraveno

| ID | Oprava | Commit (fork / parent) |
|---|---|---|
| N1 | Povinné QES pole ze snapshotu `submission.template_fields`; API `required: false` je nesmí vypnout; deep_dup při sloučení rolí | `0a44224a` |
| N2 | `issuingDistributionPoint`: `[1]` = user certs, `[2]` = CA certs; explicitní FALSE se dekóduje | `e215852b` |
| N3 | `redirect: 'error'` v transportu (`expo/fetch`), prázdné `response.url` odmítnuto | `68029c0` |
| N4 | `EXTRA_EXCLUDE_COMPONENTS` pro vlastní appku; `reviewOpened` až po návratu z prohlížeče | `f243708` |
| N5 | Web i API verifikace používají `Qes::PdfiumTrust.report` při zapnutém QES | `25659689` |
| N6 | `form_sessions#show` vrací zmrazené `values` | `d7bf9664` |
| N7 | Dokončený token expiruje 24 h po `completed_at`; payload bez `values` | `101a6118` |
| N8 | Heuristika `/Encrypt` jen v traileru/xref streamu, `#xx` normalizace | `8cdbf0a` |
| S1 | Dokončení přes `POST /qes/sessions/:token/complete_submission`, ne plný API token | `fb278280` / `5ea98d9` |
| S2 | Revokace nad řetězem z `store.verify` (`context.chain`), ne jen od klienta | `9bd73128` |
| S3 | Atomické přechody, jedna připravená revize, kontrola základu při dokončení | `b77b6db4`, `39232c15` |
| S5 | CAdES s `level: none` → `valid_unqualified` | `90142701` |
| S6 | Dokumentace už netvrdí úplné PAdES-LTA; DSS kryje podepisujícího | `eef3108c` / `53a2383` |
| audit | DNS chyby → `FetchError`; QES hooky jen při `QES_ENABLED=true`; atomické plánování `ExpireSessionsJob` | `040f5998`, `d007c8ed`, `2b69686e` |

## Ověření

- `make qes-test-qes` → 401/0.
- `make qes-test` (SQLite) → 646/1; jediné selhání je známý upstream flake
  `signing_form_spec.rb:1253` (2FA e-mail).
- `make qes-test-postgres` → 650/0.
- `make qes-app-test` → 203/0.
- `make qes-app-typecheck` → čisté.
- `make qes-js-test` → 33/0.

## Poznámky

- N1: bypass je dvoukrokový — create merged submission s `completed: false`,
  pak `PUT /api/submitters/:id` s `completed: true`. Jednokrokový test
  s `completed: true` na původním kódu vrací 422, takže chybu neodhalí.
- S6: DSS obsahuje CRL a certy podepisujícího, ne TSA revokaci ani certy
  TSA/pečeti/DocTS; offline ověření proto neslibuje úplné LTA.
- S7: README už správně říká AdES; fake card je test-only.
