# Fork workflow a struktura patche

Datum: 2026-10-15, aktualizováno 2026-10-23 (squash historie, Fly konfigurace a dokumentace
přesunuty do parent repa)

Rozhodnutí: **fork DocuSealu žije ve větvi `dokulachtan`**. Cílem je čistý, rebasovatelný
fork bez zbytečných komplikací: **minimum zásahů do upstream souborů**, veškerá logika v nových
souborech, každý zásah do upstreamu malý a zdůvodněný. Žádné merge commity z upstreamu — jen rebase.

## Repozitáře a pin

- Upstream: `docusealco/docuseal`, remote `upstream`; base commit není pevně daný —
  je to `git merge-base HEAD upstream/master` (naposledy `8f8f69f0`).
- Vlastní fork: <https://github.com/v1b3coder/docuseal>
  (`https://github.com/v1b3coder/docuseal.git`) — veřejné repo (AGPL-3.0 + attribution),
  větev `dokulachtan`, pushnuto 2026-10-17 (`git push -u origin dokulachtan`).
- Veřejné zrcadlo (GitHub): <https://github.com/v1b3coder/docuseal>, remote `github`,
  **skutečný fork** `docusealco/docuseal` (`isFork=true`, parent i source), default branch
  `dokulachtan`. Push: `git push github dokulachtan`. Pozor: tlačítko *Sync fork* porovnává
  default branch forku s `master` upstreamu, takže nabídne merge upstream masteru do našeho squashe —
  nesyncovat, rebase dělat jen ručně (viz níže). Tracking zůstává na `origin`.
- Lokální klon je `vendor/docuseal/` (gitignored v parent repu); inicializaci dělá
  `scripts/fork-setup.sh`, pin = **HEAD forku** v `vendor/docuseal.rev` (ne upstream base).
- Pro push do Gitea musí být klon **úplný** (`git fetch --unshallow upstream`), jinak server
  odmítne shallow update. Pro další rebase: `git push --force-with-lease origin dokulachtan`.

**Ve forku není dokumentace ani konfigurace prostředí** — jen kód patche. Všechno ostatní
(docs, mobilní appka, skripty, testy, Fly konfigurace) žije v parent repu `dokulachtan`.
Kdo otevře fork repo, najde jen DocuSeal + QES vrstvu; kontext je v tomto repu.

## Historie: logické bloky, ne doteky

Historie je rozdělená na **logické bloky (feature commity)**, ne na jednotlivé doteky: každý blok
drží jednu featuru včetně jejích doteků upstreamu a testů. Po squashi (2026-10-23) je to
**10 commitů** na base commitu.

| # | Commit | Co přináší |
|---|---|---|
| 1 | `chore(qes): trust roots pro PostSignum a testovací CA` | `config/qes/postsignum.pem`, `config/qes/root.crt` |
| 2 | `feat(qes): model QesSession, stavový automat a konfigurace` | model, `Qes::SessionManager`, `Qes::Config`, migrace, expirační job |
| 3 | `feat(qes): kryptografie PAdES (TBS, CMS, pečeť, audit)` | TBS s rezervou `/Contents`, CMS, pečeť, auditní stránka |
| 4 | `feat(qes): LTV, DSS a DocTS (PAdES-LTA)` | DSS s VRI, DocTS, validace řetězu |
| 5 | `feat(qes): validace podpisu, provideři a rate limiting` | `Qes::Validator`, tokeny, rate limiting, provideři |
| 6 | `feat(qes): dvoukrokový protokol pro podpis z appky` | sessions API, web fallback, App Links |
| 7 | `feat(qes): napojení podpisu na DocuSeal` | modely, generování PDF, audit, views |
| 8 | `feat(qes): krok podpisu certifikátem v podpisovém formuláři` | `QesStep`, typ pole `qes`, přehled podpisu |
| 9 | `feat(qes): přímý podpis nahraného PDF` | `POST /api/qes/documents` |
| 10 | `feat(qes): ověření PDF a panel v šabloně` | `POST /api/qes/verify`, panel v template |

## Struktura patche

Nové soubory (nic z upstreamu):

- `app/lib/qes/providers/mobile_app.rb` — varianta B i A (klíč zůstává v zařízení)
- `app/lib/qes/providers/mock.rb` — testy (PKCS#12 z fixtures)
- `app/lib/qes/value_validator.rb` — kontrola formátu hodnoty `qes` pole (SPEC § 4.4)
- `app/lib/qes/session_manager.rb` — stavový automat (SPEC § 4.3)
- `app/lib/qes/token.rb`, `tbs_document.rb`, `cms_builder.rb`,
  `placeholder_signed_data_creator.rb`, `certificate_info.rb`, `ltv.rb`, `dss.rb`,
  `doc_timestamp.rb`, `timestamp_token.rb`, `validator.rb`, `verifier.rb`,
  `verified_documents.rb`, `pdf_source.rb`, `embed.rb`, `seal.rb`, `result_attachments.rb`,
  `audit_page.rb`
- `app/lib/qes/controller_concern.rb`, `pdf_upload.rb`, `link.rb` — společné chování controllerů
- `app/models/qes_session.rb`
- `app/controllers/qes/sessions_controller.rb` — app-facing (token)
- `app/controllers/qes/form_sessions_controller.rb` — browser-facing
- `app/controllers/qes/app_controller.rb` — web fallback
- `app/controllers/qes/well_known_controller.rb` — AASA s `Content-Type: application/json`
- `app/controllers/api/qes_documents_controller.rb` — upload PDF (přímý podpis)
- `app/controllers/api/qes_verifications_controller.rb` — ověření PDF
- `app/controllers/templates_qes_verifications_controller.rb` — panel ověření v template
- `app/jobs/qes/expire_sessions_job.rb`
- `app/views/qes/*`, `app/views/templates/_qes_verification.html.erb`
- `db/migrate/*_create_qes_sessions.rb`, `*_add_doc_timestamp_state_to_qes_sessions.rb`
- `config/initializers/qes.rb`

> **Pozor:** varianta A je **client-side** (MOI Podpisové SDK v appce) — provider
> `Qes::Providers::Pkcs11` na serveru **neexistuje** a nikdy nebyl součástí plánu
> (SPEC § 16 #1, `docs/04`). Provideři jsou jen `mobile_app` + `mock`.

Zásahy do upstream souborů (součást logického bloku, do kterého patří; cílem je
< 10 řádků, výjimky jsou zdůvodněné v [SPEC.md](../SPEC.md) § 14):

- `config/routes.rb` — routes pro QES session (+ AASA, upload/ověření PDF)
- `app/models/template.rb` — validace `qes_signing_order`
- `app/models/submission.rb` — `submitters_order: preserved` pro QES šablonu
- `app/models/submitter.rb` — `has_many :qes_sessions`, `with_signature_fields?`
- `lib/submitters/submit_values.rb` — validace hodnoty `qes` pole
- `lib/submissions/generate_result_attachments.rb` — podepsané PDF + přeskočit `qes` pole
- `lib/submissions/generate_combined_attachment.rb` — kombinovaný dokument = kopie bez dalšího podpisu
- `lib/submissions/generate_audit_trail.rb` — QES stránka v auditu
- `lib/verify_pdf_signature.rb` — `verified/trusted/modified` + TSTInfo v `eContent` (DigiCert)
- `app/views/submissions/_value.html.erb` — přeskočit `qes` pole (`return`, ne `next`)
- `app/views/submissions/show.html.erb` — přehled podpisu v kartě
- `app/views/templates/show.html.erb` — panel ověření PDF
- `app/javascript/submission_form/form.vue`, `area.vue` — krok v podpisovém formuláři
- `app/javascript/template_builder/field_type.vue` — typ pole `qes`
- `app/javascript/submission_form/i18n.js` — texty kroku
- `config/locales/i18n.yml` — názvy `qes`
- `db/schema.rb` — regenerovaný (obsahuje `qes_sessions`)
- `lib/api_path_consider_json_middleware.rb` — multipart pro upload/ověření PDF
- `tailwind.form.config.js` — CSS pro panel ověření

Přesný seznam a počty řádků: [SPEC.md](../SPEC.md) § 14.

**Co ve forku záměrně není:** dokumentace (tento soubor, DESIGN/SPEC/PLAN, audity), Fly
konfigurace (`deploy/docuseal/fly*.toml` v parent repu, do forku se předávají `--config`),
mobilní appka (`mobile/`), skripty a fixtures (`scripts/`, `test/`) — to všechno je v parent repu
`dokulachtan`, aby patch nad DocuSealem zůstal jen kód.

## Pravidla modifikací upstreamu (2026-10-28)

- **Žádná duplikace upstream kódu ve forku.** Hook smí jen přidat naše chování, ne opsat tělo upstream metody.
- **Hook = `nil` / `super`.** Early-return hook vrací `nil` (pokračuj upstreamem); wrapper volá `super` a přidá jen naše chování.
- **Explicitní seam > prepend s kopií.** Když je potřeba změnit upstream metodu, přidej malý parametr/větev s výchozí cestou beze změny; nekopíruj tělo do prependu.
- **`prepend`/`include` jen pro nové chování.** Validace, callbacky, asociace, `rescue_from`; nikdy ne pro náhradu těla metody.
- **Konfigurace do vlastních souborů.** i18n (`config/locales/qes.yml`), routes (`routes.prepend` v initializeru), testy (`spec/support`), Tailwind (partial v už skenovaném adresáři).
- **Obecné bugfixy do upstreamu.** `deep_dup`, `single_sign_reason`, `template_schema` fallback, 2FA flake; ve forku jen do merge.
- **Žádné kopie celých views** (`prepend_view_path`) a žádné globální Vue/fetch monkey patche bez schválení.
- **Touch surface budget + contract testy.** Nový modifikovaný upstream soubor jen s odůvodněním; touch surface budget (allowlist + max řádků) musí projít a každý hook kryje `upstream_contract_spec.rb` / `qes_views_spec.rb` / JS testy.
- **Aktuální nález:** `Qes::ResultAttachments.attach_pdf` v `generate_combined_attachment.rb` je jediná skutečná duplikace — revertovat.

## Workflow

```bash
# rebase na upstream
git fetch upstream
git rebase upstream/master        # nebo konkrétní tag

# historie musí zůstat lineární; žádné merge commity z upstreamu
# historie je rozdělená na logické bloky (feature commity), ne na doteky;
# každý blok drží jednu featuru včetně jejích doteků upstreamu a testů
# force-push větve dokulachtan (je to náš fork)
git push --force-with-lease origin dokulachtan
```

Konflikty očekáváme jen v zásazích do upstreamu (malé hunky).

## Testy doteků

Kromě běžných testů hlídá `spec/lib/qes/upstream_contract_spec.rb` **kontrakty upstream
souborů**, na které fork nasedá (signatury, metody, struct, sloupce) — rebase, který je
tiše změní, spadne tady, ne až na stagingu. Doteky ve views hlídá
`spec/requests/qes_views_spec.rb`, JS logiku `spec/javascript/qes_step_logic.test.mjs`.

```bash
make qes-test-qes    # QES sada (SQLite)
make qes-js-test     # node --test pro JS logiku kroku
```

## Pravidla

- Licence zůstává **AGPL-3.0 + attribution** (`LICENSE_ADDITIONAL_TERMS`).
- Žádné změny v `Gemfile`/`Gemfile.lock`, pokud to není nutné; nové závislosti jen když
  to nejde bez nich.
- UI změny držet v nových partials/controllers; existující soubory jen minimálně.
- Patch má být připravený k upstream PR (obecné rozhraní providera).
- Testy: `make qes-test` a `make qes-e2e` v parent repu; harness viz
  [PLAN.md](../PLAN.md) P0.2 (Ruby 4.0.5, Postgres 18, `libpdfium.so`, `yarn`).
