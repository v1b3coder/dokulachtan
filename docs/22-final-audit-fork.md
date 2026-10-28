# Finální audit forku DocuSeal — doteky na nesouvisející funkcionalitu

**Datum:** 2026-10-28
**Rozsah:** `8f8f69f0` (upstream) → `1551de78` (HEAD forku, `dokulachtan`)
**Otázky:** (1) nerozbili jsme nesouvisející funkcionalitu DocuSealu? (2) lze kombinovat
QES a non-QES podpisy v jednom dokumentu u více signerů?

**Verdikt:**

1. **Upstream funkcionalita v testech nespadla.** Celá sada prošla: **647/0** na SQLite
   (`make qes-test`) a **655/0** na Postgresu 18 (`make qes-test-postgres`). Žádný
   upstream spec neselhal, včetně `spec/system` (generování výsledných PDF, auditní
   stránka, combined/merged attachment).
2. **Ale dvě reálné regrese mimo pokrytí upstream sadou jsme našli v ověřování PDF**
   (`/api/tools/verify`, webové ověření i ověření v appce) — jedna z nich je
   bezpečnostní (tamper po nedůvěryhodném podpisu se už nehlásí) a jedna funkční
   (CAdES podpisy přestaly být důvěryhodné přes certy z účtu). Podrobnosti R1 a R2.
3. **Kombinovat QES a non-QES u různých signerů nelze** — validace šablony to
   odmítne (`qes_all_signers_required`). Je to záměrné rozhodnutí (AGENTS #11), ale
   uživatel to dnes pozná jen jako neúspěšné uložení šablony. Detail § 5.

---

## 1. Metoda

- `git diff 8f8f69f0 HEAD` — celý patch (131 souborů, +12 045/−66).
- Rozdělení na **nové soubory** (107, celé v namespace `Qes::*` a specy) a **modifikované
  upstream soubory** (24, +594/−66). Pouze modifikované soubory mohou změnit chování
  nesouvisejících cest; prošel jsem je všechny.
- Ověření chování: `make qes-test` (T2, SQLite), `make qes-test-postgres` (T3, Postgres 18)
  a cílené sondy (`rails runner`-style RSpec) pro ověření parity `VerifyPdfSignature`
  vs. `Qes::PdfiumTrust` a pro validaci smíšené šablony.
- `lib/verify_pdf_signature.rb` je **bit-identický s upstreamem** (nulový diff) — potvrzeno.

## 2. Doteky na upstream (24 souborů, +594/−66)

| Soubor | Změna | Riziko pro non-QES |
|---|---|---|
| `lib/submitters/submit_values.rb` | `with_lock`, `Qes::SigningValues.finalize!`, `Qes::ValueValidator.call`, nové kwargs | **všechny formuláře** (R5) |
| `app/controllers/api/submitters_controller.rb` | `lock!` v transakci, `finalize!`, Boolean cast | **API submitteři** (R6) |
| `lib/submissions/generate_result_attachments.rb` | QES větev, `base:`/`page_offsets:`, `next if type == 'qes'` | výsledná PDF (R7) |
| `lib/submissions/generate_combined_attachment.rb` | QES větev, fallback `template_schema` | combined PDF (R7) |
| `lib/submissions/create_from_submitters.rb` | `deep_dup` polí, `required` u qes | API submissions (R8) |
| `app/controllers/api/tools_controller.rb` | `Qes::PdfiumTrust` místo `VerifyPdfSignature` | **veřejné ověření PDF** (R1, R2) |
| `app/controllers/verify_pdf_signature_controller.rb` | totéž | **webové ověření PDF** (R1, R2) |
| `app/models/template.rb` | `validate :qes_signing_order` | jen šablony s `qes` polem (R4) |
| `app/models/submission.rb` | `before_validation :maybe_preserve_qes_order` | jen šablony s `qes` polem |
| `app/models/submitter.rb` | 2 hooky, `qes` v `with_signature_fields?`, asociace | všechny submittery (R5) |
| `app/views/submissions/_value.html.erb` | `return output_buffer` pro `qes` | jen `qes` pole |
| `app/views/submissions/show.html.erb` | QES přehledy | dotaz navíc na submittera (R5) |
| `app/views/templates/show.html.erb` | panel ověření PDF | jen šablony s reportem |
| `app/javascript/submission_form/{form,area}.vue` | QES krok, `qesFieldsLast` | jen `qes` pole |
| `app/javascript/template_builder/field_type.vue` | `qes` v nabídce | **vždy** (R3) |
| `app/javascript/submission_form/i18n.js` | 44 klíčů × 3 jazyky | jen QES texty |
| `config/locales/i18n.yml` | 225 klíčů, 0 deletions | jen QES texty |
| `config/routes.rb` | 25 řádků nových rout | `.well-known`, `qes-test` (R9) |
| `db/schema.rb` | tabulka `qes_sessions` + verze | nic (R10) |
| `lib/api_path_consider_json_middleware.rb` | multipart výjimky pro QES cesty | nic |
| `lib/submissions/generate_audit_trail.rb` | QES auditní stránka | dotaz navíc (R5) |
| `tailwind.form.config.js` | content pro form bundle | nic |
| `spec/system/signing_form_spec.rb` | flake fix (2FA re-send) | test only (R11) |

## 3. Nálezy

### R1 — Vysoká (bezpečnost): tamper po nedůvěryhodném podpisu se už nehlásí

`app/lib/qes/pdfium_trust.rb:29-36`. Hranice změn (`modified`) se počítá jen
z **přijatých** podpisů:

```ruby
accepted = verified.select { |s| accepted?(...) }
last_signature = accepted.reject { |s| s.sub_filter == 'ETSI.RFC3161' }.max_by(&:signed_end)
modified = last_signature && unsigned_changes?(...)
```

Upstream (`lib/verify_pdf_signature.rb:23`) padá zpět na **ověřené** podpisy:

```ruby
last_signature = (trusted_signatures.presence || verified_signatures).max_by(&:signed_end)
```

Když PDF nemá žádný důvěryhodný podpis (cizí CA, cert není v `QES_TRUST_ROOTS`),
`accepted` je prázdné → `last_signature = nil` → `modified = false`. Připojená
data za podpisem se tak neoznačí jako neoprávněná změna.

Naměřeno (sonda, `QesHelpers.signed_pdf` + `"\n% injected\n"`, prázdné trusted certy):

```
upstream: Signature valid / Signed with external certificate / Contains unsigned changes after the last signature
fork:     Signature valid / Signed with external certificate
```

Dopad: `POST /api/tools/verify` ani webové ověření PDF už nevrátí zprávu
„Contains unsigned changes after the last signature“; `Qes::Verifier.compute_verdict`
(`app/lib/qes/verifier.rb:62`) proto u externího PDF s přidaným obsahem vrátí
**`valid_untrusted`** místo **`invalid`**. Týká se to i ověření v appce (docs/16)
pro PDF, jehož podpis neřetězí na `QES_TRUST_ROOTS`.

Oprava: hranici změn brát z `(accepted.presence || verified)` (stejně jako upstream),
`trusted_ranges` použít jen pro QES scope, ne pro `modified`.

### R2 — Střední (funkční): CAdES podpisy už nejsou trusted přes certy z účtu

`app/lib/qes/pdfium_trust.rb:82-88`. `trusted?` vrací `true` jen pro `adbe.pkcs7.detached`
přes `VerifyPdfSignature.trusted_signature?` (certy účtu). Pro `ETSI.CAdES.detached`
je trusted jen když řetěz projde `Qes.trust_roots` (globální PostSignum roots).

Naměřeno (sonda, CAdES podpis testovacím certem, cert předán jako trusted cert účtu):

```
upstream: Signature valid / Signed with trusted certificate
fork:     Signature valid / Signed with external certificate
```

Dopad: na nasazení s `QES_ENABLED=true` (produkce i staging) ověření PDF hlásí
„Signed with external certificate“ u každého CAdES PDF, jehož podepisující cert
uživatel přidal mezi důvěryhodné certy účtu — přitom `adbe.pkcs7.detached`
(DocuSeal vlastní podpisy) se chová stejně jako upstream (ověřeno sondou).
Netýká se to QES podpisů (ty jdou přes `QES_TRUST_ROOTS`), ale běžných uživatelů
forku, kteří ověřují cizí (Adobe/bankovní) PDF.

Oprava: u CAdES přijmout `trusted_qes` **nebo** (`signing_leaf?` && `trusted_signature?`
proti `trusted_certs`), aby se K1 hardening (CA cert / `keyEncipherment`) nevztahoval
na cestu certů účtu.

### R3 — Střední (feature exposure): `qes` pole je v builderu vždy, i při `QES_ENABLED=false`

`app/javascript/template_builder/field_type.vue:118,140,165` přidává `qes` do
`fieldIcons`/`fieldNames` bez gate; `fields.vue:254` a `dynamic_insert_menu.vue:185`
mají gate jen pro `phone/payment/verification/kba`. `app/javascript/application.js:237`
žádný `withQes` nezná (na rozdíl od `withKba`), `templates/edit.html.erb` ani
`templates_preview/show.html.erb` `data-field-types` neposílají.

Důsledek na nasazení bez QES (default upstream i náš fork bez `QES_ENABLED`):
uživatel může přidat `qes` pole, ale krok ve formuláři dostane z
`Qes::ControllerConcern#ensure_enabled` 404 (`disabled`); `qes_step_logic.mjs`
nezná kód `disabled` → `ERROR_KEYS` fallback `qes_error_network` → podepisující
vidí „Connection error. Try again.“ a formulář nelze dokončit. Pole je přitom
defaultně `required: true`.

Navíc v UI nejde nastavit `preferences.level` (`ades`/`qes`) — `field_context_submenu.vue`
žádnou QES volbu nemá, takže z UI vznikne vždy AdES; QES jen přes API
(`POST /api/qes/documents` s `level_required=qes`).

Oprava: `withQes` flag (jako `withKba`) v `application.js` + `edit.html.erb`
(`QES_ENABLED`), gate v `field_type.vue`/`fields.vue`/`dynamic_insert_menu.vue`;
volitelně volba levelu v `field_context_submenu.vue`.

### R4 — Nízká (QES šablony): neúspěšné uložení šablony je tiché / 500

`app/models/template.rb:98-116` validuje při každém uložení šablony s `qes` polem.
`TemplatesController#update` (`app/controllers/templates_controller.rb:63`) volá
`@template.save!` bez rescue → `ActiveRecord::RecordInvalid` = 500;
`builder.vue:4048` `baseFetch` nekontroluje `response.ok`, takže builder
předstírá úspěch a uživatel přijde o změny. Stejně
`TemplatesPreferencesController#create` (`:27`) při přepnutí signing order na
`random`.

Důsledek: z QES šablony nejde přidat dalšího signera (chybí mu `qes` pole),
odebrat `qes` pole ani přepnout pořadí na paralelní — a uživatel se to nedozví.
Netýká se šablon bez `qes` pole (validace hned returnuje).

Oprava: rescue `RecordInvalid` → 422 s kódem a překladem; v `baseFetch`
kontrolovat `response.ok`.

### R5 — Nízká (výkon): dotazy `qes_sessions` v nesouvisejících cestách

- `app/views/submissions/show.html.erb:292` — 1 dotaz na submittera při každém zobrazení submissionu.
- `lib/submissions/generate_audit_trail.rb:541` — 1 dotaz na submittera při každém sestavení auditní stránky.
- `lib/submissions/generate_result_attachments.rb:88`, `generate_combined_attachment.rb:8` — 1 dotaz na submittera při dokončení.
- `app/models/submitter.rb:76-77` — 2 hooky při každém uložení submittera, pokud je QES zapnuté.

Bez `qes` pole se sice nic nevykoná, ale dotazy proběhnou. Oprava: preload nebo
gate `Qes.enabled?`.

### R6 — Nízká: `completed` v `PUT /api/submitters/:id` se nově castuje

`app/controllers/api/submitters_controller.rb:160` — `ActiveModel::Type::Boolean.new.cast`.
Upstream bral jakoukoli truthy hodnotu; nově `"false"`/`"0"` znamená „nedokončeno“.
Je to spíš oprava, ale je to změna chování pro API klienty, kteří posílali string.

### R7 — Informační: QES submission má jeden merged dokument a combined bez auditní stránky

`app/lib/qes/result_attachments.rb:12-25` přiloží finální PDF jako **jeden**
`documents` záznam (u víc dokumentové šablony místo N dokumentů);
`combined_document` ignoruje `with_audit:` a přiloží finální PDF bez auditní
stránky (přidání stránky by podpis nezneplatnilo). Je to záměr (podpis kryje
merged PDF), ale mění to tvar `documents` u QES šablon.

### R8 — Informační: `deep_dup` v `create_from_submitters.rb:38`

`merge_submitters_and_fields` dostává `deep_dup` polí; dřív mutoval
`submission.template.fields` in-place. Je to oprava (šablona se nemutuje), ale je
to změna chování i pro non-QES merge rolí. Pokryto upstream sadou.

### R9 — Informační: routy a middleware

- `get '.well-known/apple-app-site-association'` a `assetlinks.json` — `public/.well-known`
  je prázdný, nestíní statiku.
- `get 'qes-test/root.crl'` — bez `QES_TEST_CRL_PATH` vrací 404 (produkce).
- `filter_parameters += %i[token signature ...]` — filtruje i non-QES parametry
  jménem `token`/`signature`; neškodí, naopak dobré.

### R10 — Informační: `db/schema.rb`

Jen nová tabulka `qes_sessions` + verze `2026_10_26_000001`; migrace v
`db/migrate` odpovídají. Žádná změna existujících tabulek.

### R11 — Informační: upravený upstream spec

`spec/system/signing_form_spec.rb:1253` — fork posouvá čas u 2FA re-sendu
(`travel_to(+20 s)`), aby nepadal na upstream flake. Test-only, ale při rebase
bude konflikt.

## 4. Co je v pořádku (ověřeno)

- **Upstream sada**: 647/0 (SQLite, bez `dashboard_spec`), 655/0 (Postgres 18).
  To zahrnuje `spec/system` (včetně `signing_form_spec`), `spec/lib/submissions/*`,
  API specy a všechny QES specy.
- **`lib/verify_pdf_signature.rb`** je bit-identický s upstreamem (nulový diff);
  `Qes::PdfiumTrust` ho jen volá.
- **DocuSeal vlastní podpisy** (`adbe.pkcs7.detached`) mají stejný verdikt jako
  upstream — ověřeno sondou (trusted přes cert účtu).
- **DocTS**: fork správně nehlásí „unsigned changes“ u DocTS, který upstream
  považuje za změnu po podpisu (zlepšení, týká se i non-QES PDF s DocTS).
- **Auditní stránka** se přidává jen když existuje dokončená QES session
  (`generate_audit_trail.rb:541`); non-QES audit beze změny.
- **`with_lock`** v `SubmitValues.call` (řádek 32) je pro všechny submittery, ale
  zamyká se až po načtení submittera a všechny mutace jsou uvnitř zámku; upstream
  sada prošla.
- **`Qes::ValueValidator`** je no-op bez `qes` pole (`Qes.active_for?`), takže
  non-QES hodnoty nevaliduje.
- **`Qes::SigningValues.finalize!`** pro non-QES šablony dělá přesně upstream
  sekvenci (merge defaultů → conditions → formulas → datum); API spec
  `qes_signing_values_spec.rb` to hlídá.
- **`single_sign_reason`** je nil-safe (`completed_at || Time.current`) — dřív
  mohl spadnout na `nil` u nedokončeného submittera.
- **`Template#qes_signing_order`** se spouští jen když šablona má `qes` pole;
  non-QES šablony validace nezpomalí ani nezmění.
- **`Submission#maybe_preserve_qes_order`** se aplikuje jen na šablony s `qes`
  polem; non-QES submission zůstává `random`.

## 5. Kombinace QES a non-QES podpisů

**U různých signerů: nelze.** `Template#qes_signing_order`
(`app/models/template.rb:98-116`) vyžaduje, aby **každý** non-viewer signer měl
`qes` pole (`qes_all_signers_required`). Ověřeno sondou:

```
MIXED valid=false errors=["Fields qes_all_signers_required"]
```

a existujícím specem `spec/models/template_spec.rb` („requires a qes field for
every signer“). Důvod je v AGENTS #11: všichni stakeholderi podepisují
certifikátem, podpisy jdou striktně po sobě a řetězí se (`Submission#maybe_preserve_qes_order`
nutí `submitters_order=preserved`).

**U stejného signera: lze.** Signer může mít v jednom dokumentu `qes` pole
i běžné `signature` pole. `qesFieldsLast` (`qes_step_logic.mjs`) pošle `qes`
krok nakonec, takže se nejdřív vykreslí podpis a QES podpis pak kryje i jeho
bajty. Validace to nezakazuje (každý signer má `qes` pole).

**Technicky (kdyby se validace uvolnila):**

- Jednodokumentová šablona: non-QES signer by dostal výsledné PDF postavené
  na finálním QES PDF předchozího signera (`build_pdfs_index` →
  `EnsureResultGenerated.call(latest_submitter)`), podepsal by ho inkrementální
  revizí (`adbe.pkcs7.detached`). QES podpis zůstává INTACT, ale poslední
  podpis dokumentu by nebyl certifikátový.
- Víc dokumentová šablona: **rozbité.** `build_pdfs_index` namapuje jen
  `original_uuid` QES přílohy na merged PDF; ostatní `attachment_uuid` spadnou
  na původní nepodepsané PDF (`generate_result_attachments.rb:880`). Výsledná
  sada by měla duplicitní stránky a část bez QES podpisu.
- `Qes::ResultAttachments.call` navíc přiloží jen jeden merged dokument,
  takže by non-QES signer dostal kombinaci merged + originál.

**Kdyby se mělo povolit:** relaxovat `qes_signing_order` (jen pořadí), v
`generate_pdfs` použít `base:`+`page_offsets:` i pro non-QES signera po QES
signerovi (aby všechny `attachment_uuid` mapovaly na merged PDF), a rozhodnout,
zda poslední podpis smí být non-QES (dnes je pečeť/QES vždy poslední, což je
pro „všichni certifikátem“ klíčové).

## 6. Doporučení (priorita)

1. **R1 opravit před nasazením** — vrací bezpečnostní díru do sdíleného
   ověření PDF. Jednořádkovka: `accepted.presence || verified` pro hranici změn.
2. **R2 opravit** — CAdES trusted přes certy účtu (zachovat `signing_leaf?`).
3. **R3 vyřešit** — `withQes` gate (QES_ENABLED) a volba levelu, nebo `qes`
   pole z builderu úplně skrýt a nechat jen API.
4. **R4 vyřešit** — 422 + překlad chyb, `response.ok` v `baseFetch`.
5. **R5** — preload/gate, ať non-QES cesty neplatí dotazy navíc.

## 7. Reprodukce

```bash
make qes-test             # T2: 647/0 (SQLite)
make qes-test-postgres     # T3: 655/0 (Postgres 18)
```

Sonda (dočasný spec v `spec/lib/qes/`, po auditu smazán):

```ruby
pdf = QesHelpers.signed_pdf
trusted = [QesHelpers.pkcs12.certificate]
VerifyPdfSignature.call(StringIO.new(pdf), trusted).first          # trusted
Qes::Config[:trust_roots] = nil
Qes::PdfiumTrust.report(StringIO.new(pdf), trusted).first          # untrusted
VerifyPdfSignature.call(StringIO.new(pdf + "\n% injected\n"), []).first  # modified
Qes::PdfiumTrust.report(StringIO.new(pdf + "\n% injected\n"), []).first # nemodified
```

Smíšená šablona: `Template#save` s `qes` polem jen u prvního ze dvou
signerů → `errors[:fields] == ['qes_all_signers_required']`.
