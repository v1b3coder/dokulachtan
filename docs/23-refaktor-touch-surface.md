# 23 — Refaktor touch surface forku (2026-10-28)

Cíl: zmenšit počet upstream souborů a řádků, které fork modifikuje, **bez opsání
upstream kódu**. Hook smí jen přidat naše chování (`nil` = pokračuj upstreamem,
`super` = přidej chování), ne nahradit tělo upstream metody.

## Před / po

Měřeno `git diff --numstat <merge-base> --` ve `vendor/docuseal`; base `8f8f69f0`.

| Metrika | Před | Po | Změna |
|---|---:|---:|---:|
| Modifikované upstream soubory | 36 | **21** | −15 (−42 %) |
| Řádky v upstream souborech (+/−) | +704/−79 = **783** | +199/−34 = **233** | −550 (−70 %) |
| Všechny soubory patche | 145 | 149 | +4 |
| Všechny insertions | 12 320 | 12 598 | +278 |

Celkový patch mírně vzrostl (+278 řádků): extensions a separátní i18n jsou nové
soubory ve forku, ne zásahy do upstreamu. Z 233 zbývajících upstream řádků je
**49 `db/schema.rb`** (nová tabulka), **40 PDF seam**
(`generate_result_attachments.rb`), **26 `builder.vue`** (save error) a **23 `form.vue`**
(QES krok). Zbytek jsou 1–14řádkové hooky, helpers a test.

## Co se přesunulo

| Oblast | Před | Po |
|---|---:|---:|
| `config/locales/i18n.yml` | 231 | **0** → `config/locales/qes.yml` |
| `app/javascript/submission_form/i18n.js` | 82 | **0** → `qes_i18n.js` |
| `app/javascript/template_builder/i18n.js` | 5 | **0** → `qes_i18n.js` |
| `config/routes.rb` | 25 | **0** → `config/initializers/qes_routes.rb` (`routes.prepend`) |
| `app/models/{template,submission,submitter}.rb` | 54 | **0** → `Qes::Extensions::Models::*` |
| `app/controllers/{templates,api/templates,templates_preferences}` | 27 | **0** → `Qes::Extensions::Controllers::TemplateErrors` |
| `app/controllers/{api/tools,verify_pdf_signature}` | 18 | **0** → `Qes::Extensions::Lib::VerifyPdfSignature` |
| `app/controllers/api/submitters_controller.rb` | 10 | **10** → lock + boolean + hook |
| `lib/submitters/submit_values.rb` | 26 | **8** → hooky + `prepend` |
| `lib/submissions/create_from_submitters.rb` | 6 | **0** → `Qes::Extensions::Lib::CreateFromSubmitters` |
| `lib/submissions/generate_combined_attachment.rb` | 17 | **4** → early-return hook + schema fallback |
| `app/views/submissions/{show,_value}.html.erb` | 20 | **8** → `QesHelper` |
| `app/views/templates/show.html.erb` | 3 | **1** → helper |
| `app/views/templates_preferences/show.html.erb` | 3 | **0** → flash v concernu |
| `tailwind.form.config.js` | 2 | **0** → partial v `submit_form/` |
| `lib/api_path_consider_json_middleware.rb` | 7 | **3** → `Qes.multipart_path?` |
| `app/javascript/template_builder/{fields,dynamic_insert_menu}.vue` | 4 | **4** → gate v `field_type.vue` |
| `app/javascript/template_builder/field_context_menu.vue` | 33 | **10** → `QesLevelSubmenu` |
| `app/javascript/template_builder/field_type.vue` | 13 | **12** → `qes_field_type.js` |
| `app/javascript/application.js` | 1 | **1** → `withQes` |
| `app/javascript/submission_form/form.vue` | 23 | **23** → QES krok (bez čistého hooku) |
| `app/javascript/submission_form/area.vue` | 14 | **14** → QES oblast (bez čistého hooku) |
| `app/javascript/template_builder/builder.vue` | 26 | **26** → save error + `withQes` |
| `db/schema.rb` | 49 | **49** → nová tabulka, nevyhnutelné |
| `spec/system/signing_form_spec.rb` | 14 | **14** → upstream flake, zatím test-only |

## Duplikace

**0 řádků opsaného upstream kódu.** Jediná skutečná duplikace
(`Qes::ResultAttachments.attach_pdf`, kopie `ActiveStorage::Attachment.create!`)
byla odstraněna; upstream `GenerateCombinedAttachment.call` používá svůj původní
`ActiveStorage::Attachment.create!`.

Hooky a extensions jen volají `super` nebo náš kód:

- `Qes::Hooks.result_attachments/combined_attachment/audit_page` — early return,
- `Qes::Hooks.pdf_signatures` — delegace na `super` nebo `Qes::PdfiumTrust`,
- `Qes::Extensions::Lib::VerifyPdfSignature#call` — `super` pro non-QES,
- `Qes::Extensions::Lib::SubmitValues#update_submitter!` — `submitter.with_lock { super }`,
- `Qes::Extensions::Lib::SubmitValues#validate_values!` — QES validátor + `super`,
- `Qes::Extensions::Models::*` — nové validace/callbacky/asociace,
- `Qes::Extensions::Controllers::TemplateErrors` — `rescue_from`,
- `Qes::Extensions::Lib::CreateFromSubmitters` — `super` + nové chování.

PDF seam v `generate_result_attachments.rb` zůstává explicitní: `base:` a
`page_offsets:` jsou nové parametry, výchozí cesta je upstream. Není to kopie
`generate_pdfs`; kopie by byla právě to, čemu se vyhýbáme.

## Testy

| Suite | Výsledek |
|---|---|
| `make qes-test-qes` | 413/0 |
| `make qes-js-test` | 33/0 |
| `make qes-test-fast` | 520/0 |
| `make qes-test` (SQLite, bez dashboard specu) | 656/0 |
| `make qes-test-postgres` | 660/0 |

## Reprodukce statistik

```bash
cd vendor/docuseal
base=$(git merge-base HEAD upstream/master)
git diff --numstat "$base" | awk 'BEGIN{a=0;d=0;n=0} {a+=$1;d+=$2;n++} END{print n, a, d}'
git diff --numstat "$base" | while read a d f; do
  git cat-file -e "$base:$f" 2>/dev/null && echo "$a $d $f"
done | sort -k1,1nr
```
