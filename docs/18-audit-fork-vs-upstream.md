# 18 — Audit forku `dokulachtan` proti upstreamu

Datum: 2026-10-23
Metoda: `git diff`/`numstat`/`blame` forku (`vendor/docuseal`, větev `dokulachtan`, base
`3c65b0e4`) proti `upstream/master` (`8f8f69f0`), **simulovaný rebase** 52 commitů v
jednorázovém klonu (bez dopadu na pracovní strom), **čtyři probe testy** spuštěné v test image
(PROBE 1–4), e2e běh `make qes-verify-e2e`, spuštěná QES sada (`make qes-test-qes`: 125/0)
a čtení `spec/**`.
Nic v repu se nemodifikovalo (probe spec smazán, `git status` čistý); v `vendor/docuseal`
zůstaly nedotčené cizí necommitnuté změny (web UI ověření PDF).

> **Poznámka (2026-10-23, po auditu):** historie forku byla squaschnutá na **10 logických
> bloků** (`bf67e497`–`224a885b`). Metriky níže popisují stav **před** squashem
> (52 commitů, `65358818`–`a92fc2a3`); čísla o souborech, dotecích a řádcích se nezměnila,
> z historie jen zmizel zrušený prototyp `QesPdfSession` s drop migrací, Fly konfigurace
> (`fly.toml`, `fly.staging.toml`) a `FORK.md` — Fly konfigurace se přesunuly do parent repa
> (`deploy/docuseal/`) a dokumentace do `docs/08`.

**Verdikt ve zkratce**

| Otázka | Odpověď |
|---|---|
| Je patch strukturálně rebasovatelný? | **Ano, velmi dobře.** 6 180 z 6 674 řádků je v nových souborech; z 21 dotčených upstream souborů má jen 8 jakýkoli deletion a celkem je smazáno **27 řádků**. Rebase 52 commitů na dnešní upstream prošel **bez konfliktu**. |
| Jak drahý je rebase? | **Strojově levný, sémanticky drahý.** ~8–20 textových konfliktů/rok, každý 5–20 min; ale 3–4 soubory nesou *sémantické* riziko (signatury metod, `VerifyPdfSignature`, `TimestampHandler`), které testy pokrývají jen částečně. Odhad: **~15 min týdně** (fetch + rebase + QES sada) a **~2–4 h/měsíc** na verifikaci vydání (plná sada + staging e2e). |
| Je kód kvalitní? | **Nekonzistentní.** Kryptografické jádro (`CmsBuilder`, `TbsDocument`, `CertificateInfo`, `Validator`) je nadprůměrné a otestované. Okolí (LTV, TSA, DSS, ověření, joby) obsahuje **4 kritické chyby** a **~215 řádků mrtvého kódu**. |
| Duplicity a overengineering? | **Ano, měřitelné.** ~100 řádků duplikuje `VerifyPdfSignature`, ~45 řádků duplicitních helperů v controllerech, `Qes::Provider` je 35 řádků ceremoniálu bez funkce, mrtvá CMS-LTV vrstva ~95 řádků. |
| Sedí dokumentace na realitu? | **Ne.** SPEC § 14 uvádí 13 doteků a limit 10 řádků; realita je **21 doteků** a 4 soubory limit překračují (nejvíc `generate_result_attachments.rb`: 29+/13−). `FORK.md` a `docs/08` jsou zastaralé. |

Legenda: ❌ kritické · ⚠️ střední · ℹ️ nízké/dokumentační

---

## 1. Metriky patche

| Metrika | Hodnota |
|---|---|
| Commity od base | 52 (lineární, 0 merge commitů) |
| Soubory celkem | 88 |
| Řádků celkem | 6 674 insertions / 27 deletions |
| **Nové soubory** | 67 souborů, **6 180 řádků** (92,6 %) |
| **Doteky upstreamu** | **21 souborů, 494 řádků** (7,4 %), z toho **27 deletions** |
| Doteky s deletion (invazivní) | 8 souborů: `generate_result_attachments` (29/13), `verify_pdf_signature` (14/6), `field_type.vue` (6/3), `area.vue` (13/1), `submitter.rb` (2/1), `submit_form_controller` (1/1), `test.rb` (1/1), `api_path_consider_json_middleware` (6/1) |
| Doteky čistě aditivní | 13 souborů (i18n.yml 270+, i18n.js 52+, routes 22+, template.rb 22+, form.vue 16+, submissions/show 11+, submission.rb 11+, _value.html.erb 7+, templates/show 3+, ostatní 2–3) |
| Kód QES vrstvy (Ruby) | 2 904 řádků (`app/lib/qes/**`, `app/controllers/qes/**`, `app/jobs/qes/**`, `app/models/qes_session.rb`) |
| Kód QES vrstvy (Vue + ERB) | 635 řádků |
| Testy QES | 2 047 řádků (19 souborů QES speců), **125/0** (`make qes-test-qes`) |
| Testy celkem | 371/1 SQLite (známý upstream flake), 372/0 Postgres |

**Závěr k metrikám:** patch je z 92,6 % *přírůstkový*. To je nejlepší vlastnost forku — nové
soubory nekolidují, dokud upstream nezavede stejný název (`Qes::*`, `qes_*`, `qes` typ pole).
Riziko je soustředěné do 8 souborů s deletion a do 3 souborů s nejvyšší upstream churn.

---

## 2. Doteky: kde a jak hluboko

### 2.1 Doteky podle typu

| Typ doteku | Soubory | Hodnocení |
|---|---|---|
| **Nový typ pole + krok ve formuláři** | `form.vue`, `area.vue`, `field_type.vue`, `i18n.js` | ⚠️ Aditivní, ale ve 3 nejrychleji rostoucích frontend souborech (38/16/13 commitů/rok). Konflikt při každé změně seznamu komponent nebo `v-else-if` řetězu. |
| **Hooky do generování PDF** | `generate_result_attachments.rb`, `generate_combined_attachment.rb`, `generate_audit_trail.rb` | ❌ Nejhorší dotek: změna **signatur** `generate_pdfs` a `fill_submitter_fields` v souboru s 35 commity/rok. |
| **Ověření PDF** | `verify_pdf_signature.rb` | ❌ Změna `Struct` + signatury `build_signature` v souboru, který měl **10 commitů za 90 dní** — nejvyšší churn z celého patche. |
| **Routing / middleware** | `routes.rb`, `api_path_consider_json_middleware.rb` | ⚠️ routes 39 commitů/rok; middleware je whitelist cest, která se rozrůstá. |
| **Modely a validace** | `template.rb`, `submission.rb`, `submitter.rb`, `submit_values.rb` | ℹ️ Malé, dobře izolované, otestované (`template_spec`, `submission_spec`). |
| **Views** | `submissions/show.html.erb`, `_value.html.erb`, `templates/show.html.erb` | ⚠️ `show.html.erb` 50 commitů/rok; `_value.html.erb` používá `return output_buffer` hack. |
| **Konfigurace** | `i18n.yml`, `test.rb`, `tailwind.form.config.js`, `fly.toml` | ℹ️ i18n 81 commitů/rok (nejvyšší), ale konflikt je mechanický. |

### 2.2 Které řádky upstream skutečně mění

Pro každý hunk forku jsem změřil, kolik upstream commitů za posledních 90/365 dní změnilo
**přesně ty řádky** (kontext, na který fork nasedá):

| Soubor | Hunků | Upstream commitů/90 d | /365 d |
|---|---:|---:|---:|
| `lib/verify_pdf_signature.rb` | 6 | **10** | 10 |
| `lib/submissions/generate_result_attachments.rb` | 8 | 0 | **7** |
| `app/views/submissions/show.html.erb` | 2 | 1 | **5** |
| `app/javascript/template_builder/field_type.vue` | 3 | 0 | 4 |
| `app/views/templates/show.html.erb` | 1 | 1 | 2 |
| `config/routes.rb` | 4 | 0 | 1 |
| `app/models/submitter.rb` | 2 | 0 | 1 |
| `lib/submissions/generate_combined_attachment.rb` | 1 | 0 | 1 |
| ostatních 12 souborů | 16 | 0 | 0 |
| **Celkem** | **43** | **12** | **31** |

To je klíčové číslo: **31 upstream commitů za rok** se dotkne řádků, které fork upravuje.
Za 90 dní 12. Při týdenním rebase (upstream vydává tag každý týden: 3.3.2 = 12. 10.,
3.3.1 = 5. 10., 3.3.0 = 28. 9. …) to je ~0,6 zásahu do řádků na jeden rebase.

### 2.3 Simulovaný rebase

```
$ git clone --shared . /tmp/rebase-sim
$ git rebase upstream/master          # 52 fork commitů na 8f8f69f0
Successfully rebased and updated refs/heads/dokulachtan.
exit=0, 0 konfliktů
```

Dnešní drift (14 upstream commitů, 22 souborů, 95 insertions) se rebasuje **bez konfliktu**.
To je ale dáno tím, že upstream v tomto okně změnil jen 3 z 21 dotčených souborů
(`submissions/show.html.erb`, `generate_audit_trail.rb`, `generate_result_attachments.rb`)
a ani jeden zásah nešel do stejné metody.

---

## 3. Cena rebase: měření a odhad

### 3.1 Co rebase skutečně stojí

| Činnost | Čas | Frekvence |
|---|---|---|
| fetch + rebase (bez konfliktu) | 2 min | týdně |
| vyřešení textového konfliktu (i18n, routes, importy) | 5–10 min | ~2–6×/rok |
| vyřešení konfliktu v `generate_result_attachments.rb` (signatury) | 20–40 min | ~1–2×/rok |
| vyřešení konfliktu ve `verify_pdf_signature.rb` (Struct + signatura) | 10–20 min | ~2–4×/rok |
| `make qes-test-qes` (125 speců) | 1 min | po každém rebase |
| `make qes-test` (371 speců) | ~8 min | při vydání |
| `make qes-test-postgres` (372 speců) | ~10 min | při vydání |
| staging e2e (`make qes-staging-e2e`, `…-pdf`) | 5–15 min | při vydání |
| **Celkem rutinní rebase** | **~15 min** | týdně |
| **Celkem rebase s konfliktem** | **~30–60 min** | ~6–12×/rok |

### 3.2 Sémantické riziko (dražší než konflikty)

Textový konflikt je vidět. Horší je změna, která **nekoliduje, ale rozbije fork**:

| Upstream změna | Co rozbije | Krytí testy |
|---|---|---|
| refaktor `generate_pdfs` / `fill_submitter_fields` | `Qes::TbsDocument.build` (volá `generate_pdfs(base:)` a spoléhá na mutaci `base`) | ✅ `pipeline_spec`, `chain_spec` |
| refaktor `VerifyPdfSignature::SignatureStruct` | `Qes::Verifier` (čte `verified/trusted/modified`) | ✅ `verifier_spec`, `validator_spec` |
| změna `Submissions::TimestampHandler` | `Qes::Seal` i `Qes::DocTimestamp` (dědi `Handler`) | ⚠️ jen `lta_spec` se stubem |
| přestavba `submissions/show.html.erb` | QES přehled v kartě podepisujícího | ❌ **žádný test** |
| přestavba `submissions/_value.html.erb` | `return output_buffer` hack | ❌ **žádný test** |
| změna `GenerateAuditTrail` | `Qes::AuditPage.append` | ❌ **žádný test** |
| změna `SubmitValues#validate_values!` | hook `Qes::ValueValidator` | ❌ žádný test (testuje se jen validátor) |
| změna `form.vue` / `area.vue` | krok QES v podpisovém formuláři | ❌ **žádné JS testy** (upstream je nemá) |

To je jádro odpovědi na „jak drahé bude udržovat funkcionalitu": **textově levné, ale 5 doteků
nemá test, který by je zachytil.** U těchto pěti se chyba projeví až na stagingu nebo v produkci.

### 3.3 Co rebase zlevní

1. **Zrušit `submit_form_controller.rb` dotek** (`submitters_order_preserved?` místo inline
   podmínky) — nemá s QES nic společného, je to refaktor, který upstream stejně zavede sám.
   Ušetří 1 dotek a 11 commitů/rok churn.
2. **Přesunout `single_sign_reason` fix** (`completed_at || Time.current`) do samostatného
   commitu s odůvodněním, nebo upstream PR — je to bug fix, ne QES. Ušetří 1 hunk v nejhorším souboru.
3. **Neměnit `config/environments/test.rb` globálně** — `memory_store` pro všechny testy kvůli
   rate limiteru. Jde nastavit jen pro QES spec (`Rails.cache` stub), nebo použít `:null_store`
   s `allow(Rails).to receive(:cache)`. Ušetří 1 dotek.
4. **Nesahat na `lib/verify_pdf_signature.rb` víc, než je nutné** — ideálně DigiCert fix
   (`pkcs7.data == nil`) přesunout do upstream PR a ve forku jen použít.

---

## 4. Kritické nálezy

### K1 ❌ DocTS rozbíjí `modified` a verdikt u vlastních LTA PDF

**Soubory:** `lib/verify_pdf_signature.rb:120` (`verify_timestamp`), `:196` (`unsigned_changes?`),
`app/lib/qes/verifier.rb:42` (`compute_verdict`)

`VerifyPdfSignature#verify_timestamp` čte `pkcs7.data`:

```ruby
token_info = OpenSSL::Timestamp::TokenInfo.new(pkcs7.data)
```

DigiCert token má `pkcs7.data == nil` (PROBE 3: `PKCS7_DATA_NIL=true`), takže
`verify_timestamp` vrátí **false** (PROBE 3: `UPSTREAM_VERIFY_TIMESTAMP=false`) — ne exception,
jen false. `verified_signature?` proto DocTS označí jako neověřený.

`unsigned_changes?` povoluje jen DSS-only změny (`only_dss_changes?`), ale DocTS je nová
**signaturní** revize, ne DSS. Důsledek:

1. `last_signature` = poslední ověřený podpis (pečeť nebo podpis appky),
2. `has_unsigned_changes = unsigned_changes?(…, last_signature.signed_end)` = **true**,
3. `modified: true` u posledního ověřeného podpisu,
4. `Qes::Verifier#compute_verdict` → `return 'invalid' if signatures.any? { !intact } || modified`
   → **`invalid`**.

**Důkaz 1 (PROBE 2, LTA PDF: podpis appky + DSS + DocTS):**

```
VERIFIER_VERDICT=invalid MODIFIED=true INTACT=false TRUSTED=true SEAL={present: false, trusted: false, count: 0}
SIGNATURE_KINDS=[["qes", true, "partial"], ["timestamp", false, "full"]]
PLAIN_VERDICT=valid MODIFIED=false
```

(`INTACT=false` u timestampu je artefakt probe — token z fixture je pro jiný dokument;
`MODIFIED=true` a `invalid` jsou důsledek výše popsané cesty.)

**Důkaz 2 (`make qes-verify-e2e` na aktuálním kódu, 2026-10-23 01:03):**

```
## Server: POST /api/qes/verify (finální PDF)
-> HTTP 200 {"verdict": "invalid", "intact": true, "trusted": true, "modified": true,
   "level": "ades", "coverage": "full", "origin": "docuseal",
   "seal": {"present": true, "trusted": true, "count": 1},
   "signatures": [qes intact/trusted/partial, seal intact, timestamp intact]}
Ověření finálního PDF selhalo: 200 {...}
make: *** [Makefile:94: qes-verify-e2e] Error 1
```

Tedy **skutečný LTA dokument vyrobený forkem** (podpis appky + DSS + pečeť + DocTS,
`intact: true`, `trusted: true`) server sám označí jako `modified: true` → `invalid`.
To není artefakt probe: `intact: true` u všech podpisů, `trusted: true`, jediný problém
je `modified: true`.

**Důsledek:** server odmítne uložit vlastní LTA PDF do „Verified documents"
(`Qes::VerifiedDocuments.store!` vyžaduje `!report[:modified]`), a appka u PDF vytvořeného
stejným serverem zobrazí „PDF bylo po podpisu změněno". To je v přímém rozporu s
`docs/16` § D6 a § D14 („DSS/LTV aktualizace po podpisu je legitimní") a s e2e reportem
(„DSS/LTA rozšíření je přípustná modifikace").

**Proč to testy nezachytily:** `make qes-verify-e2e` se po zavedení DocTS **ještě nespustil** —
report `test/out/qes-verify-e2e-report.txt` byl z 2026-10-22 20:58, zatímco commit s DocTS je
z 2026-10-22 23:12; po DocTS se pustily jen `make qes-staging-e2e` a `make qes-staging-e2e-pdf`
(ty validují pyHanko, ne fork `Qes::Verifier`). `spec/lib/qes/verifier_spec.rb` má případ
„keeps a DSS/LTV update valid", ale **žádný případ s DocTS**. Po opravě K1 je potřeba
`make qes-verify-e2e` vrátit do zeleného.

**Oprava:** v `VerifyPdfSignature` považovat `ETSI.RFC3161` revizi za LTA update
(rozšířit `only_dss_changes?`/`unsigned_changes?` o DocTS), nebo `modified` počítat
v `Qes::Validator` stejnou logikou; doplnit spec s DocTS (fixture token).

### K2 ❌ `QES_TSA_REQUIRED` je mrtvý, TSA outage vyrobí falešný DocTS

**Soubory:** `lib/submissions/timestamp_handler.rb:41–60`, `app/lib/qes/doc_timestamp.rb:26`,
`app/lib/qes/providers/mobile_app.rb:147`

Upstream `Submissions::TimestampHandler#sign` má `rescue StandardError` a při chybě TSA vrátí
`OpenSSL::ASN1::GeneralizedTime.new(Time.now.utc).to_der` — **falešný token**. Fork dědí
`Qes::DocTimestamp::Handler < Submissions::TimestampHandler` a přepisuje jen `signature_size`,
takže `Qes::DocTimestamp.apply` **nikdy nedostane výjimku** a vrátí `applied`. Kontrola
`if doc_timestamp_state == 'failed' && Qes::Config[:tsa_required]` je proto **nedosažitelná**.

**Důkaz (PROBE 1, `Faraday.new` raise):**

```
DOC_TS_STATE=applied GROWTH=42594
DOC_TS_CONTENTS=180f3230323631303233     # 0x18 = ASN.1 GeneralizedTime
DOC_TS_PARSE_AS_CMS=OpenSSL::PKCS7::PKCS7Error
```

Tedy `QES_TSA_REQUIRED=true` nedá žádnou záruku, že PDF má platný DocTS; vznikne PDF
s revizí, jejíž `/Contents` není CMS token, a validátory ji označí jako neplatnou.

**Oprava:** v `Qes::DocTimestamp::Handler` přepsat `sign` tak, aby při chybě TSA
vyhodil výjimku (a `apply` vrátil `failed`), nebo po `pdf.sign` ověřit, že
`OpenSSL::PKCS7.new(contents)` je platný token s `Type == :DocTimeStamp`; jinak `failed`.
Doplnit spec na TSA outage.

### K3 ❌ Neplatný certifikát shodí request 500 místo 422

**Soubor:** `app/lib/qes/providers/mobile_app.rb:15`, `app/controllers/qes/sessions_controller.rb:22`

```ruby
certificate = OpenSSL::X509::Certificate.new(certificate_der)
```

`OpenSSL::X509::CertificateError` není `Qes::ClientError`, takže ho `SessionsController`
(`rescue_from Qes::ClientError` / `Qes::InvalidTransition`) nezachytí → **500**. Session
zůstane v `awaiting_app` bez `failure_code`.

**Důkaz (PROBE 1):**

```
MALFORMED_RAISED=OpenSSL::X509::CertificateError: PEM_read_bio_X509: no start line
STATE=awaiting_app FAILURE=nil
```

Přitom `Qes::CertificateInfo.parse` (`app/lib/qes/certificate_info.rb:25`) je **přesně ten
rescue, který chybí** — a je mrtvý (nikde se nevolá).

**Oprava:** `OpenSSL::X509::Certificate.new` nahradit `Qes::CertificateInfo.parse(certificate_der)`
a v `CertificateInfo.parse` nechat `ClientError.new(:invalid_certificate)`; doplnit request spec.

### K4 ❌ VRI klíč v DSS je SHA-1 hex řetězce, ne `/Contents` bajtů

**Soubory:** `app/lib/qes/dss.rb:27`, `app/lib/qes/providers/mobile_app.rb:215`

```ruby
key = Digest::SHA1.hexdigest(signature_contents).upcase.to_sym
```

`signature_contents` je **hex string** (`signature[:Contents].unpack1('H*')`). pyHanko počítá
`sha1(contents)` nad **raw bajty** (`pyhanko/sign/validation/dss.py:192`, volající
`pdf_signer.py:2580` předává raw CMS). ETSI/Adobe očekávají SHA-1 z `Contents` (bajtů).

**Důkaz (PROBE 4):**

```
VRI_KEYS=["4D2DF643B1760C5FE62C196F5F3E65A461A49843"]
SHA1_RAW=AB625C773C5A74AA5762024F227066F789A9528B
SHA1_HEXSTR=4D2DF643B1760C5FE62C196F5F3E65A461A49843
```

VRI entry tedy neodpovídá podpisu, takže Adobe/ETSI VRI lookup ji nenajde. pyHanko VRI
ignoruje (používá globální `/CRLs`), proto e2e projde; `spec/lib/qes/dss_spec.rb:44`
zakonzervoval špatné očekávání (`Digest::SHA1.hexdigest(contents)` s hex stringem).

**Oprava:** předávat do `Dss.apply` raw contents (`signature[:Contents]`) a hashovat je;
spec upravit na `Digest::SHA1.hexdigest(raw).upcase`.

---

## 5. Střední nálezy

### M1 ⚠️ Mrtvá CMS-LTV vrstva (~95 řádků)

Po rozhodnutí „CMS LTV pryč" (`feat(qes): DocTS + DSS VRI, CMS LTV pryč`) zůstaly:

| Soubor | Co je mrtvé |
|---|---|
| `app/lib/qes/ltv.rb:14–16` | `REVOCATION_VALUES_OID`, `OCSP_OID`, `CA_ISSUERS_OID` (nepoužité) |
| `app/lib/qes/ltv.rb:29–45` | `call` (volá jen `pipeline_spec`) |
| `app/lib/qes/ltv.rb:47–52` | `values` (volá jen `call`) |
| `app/lib/qes/ltv.rb:54–59` | `revocation_values_der` (volá jen `ltv_spec`) |
| `app/lib/qes/ltv.rb:61–67` | `adobe_revocation_info_der` (volá jen `values`/`ltv_spec`) |
| `app/lib/qes/ltv.rb:76–81` | `etsi_revocation_values_der` (volá jen `call`/`values`) |
| `app/lib/qes/ltv.rb:83–88` | `adobe_revocation_info` (volá jen `values`) |
| `app/lib/qes/cms_builder.rb:32,38–40` | `revocation_values:` v `complete` (nikdo nepředává) |
| `app/lib/qes/cms_builder.rb:58,63–65` | `revocation_values:` v `estimate_size` (nikdo nepředává) — **`estimate_size` odstraněn 2026-10-27** (pevná rezerva `QES_SIGNATURE_RESERVE`, viz audit 21) |
| `app/lib/qes/placeholder_signed_data_creator.rb:12–13,16–17,37–48` | `REVOCATION_VALUES_OID`, `ADOBE_REVOCATION_INFO_OID`, `revocation_values_der`, `adobe_revocation_info_der`, `create_unsigned_attrs`, `add_unsigned_attr` |

**Důkaz:** `grep -rn "Qes::Ltv\." app lib` najde jen `fetch_crls` a `check_revoked!`;
`revocation_values:` v `CmsBuilder` nemá v `app lib` žádného volajícího (jen `pipeline_spec`).
Kód ~95 řádků, který nikdy neběží v produkci, ale musí se udržovat při změnách HexaPDF.

**Oprava:** smazat `call`, `values`, `revocation_values_der`, `adobe_revocation_info_der`,
`etsi_revocation_values_der`, `adobe_revocation_info`, `revocation_values:` parametry a
`PlaceholderSignedDataCreator` unsigned attrs; specs upravit. Ušetří ~95 řádků a jeden
koncepční zmatek (dva LTV mechanismy, z nichž jeden je mrtvý).

### M2 ⚠️ `Qes::Provider` je 35 řádků ceremoniálu bez funkce

**Soubor:** `app/lib/qes/provider.rb:23–41`

Abstraktní třída s pěti `raise NotImplementedError` a `attr_reader :session`. Reálná
implementace je jen `MobileApp`; `Mock < MobileApp`, ne `< Provider`. Volající nikdy nevolají
`provider.build_cms/embed/validate` — ty volá jen `MobileApp#complete!` sám na sobě. Rozhraní
tedy neexistuje: `prepare` je v `MobileApp` **no-op** (`mobile_app.rb:11`) a volá se
`Qes::Providers::MobileApp.new(session).prepare(...)` (`form_sessions_controller.rb:45`)
jen proto, aby se nic nestalo. `provider_for(session)` (`sessions_controller.rb:154`) vrací
vždy `MobileApp`.

**Oprava:** smazat `Qes::Provider` a `prepare`; `MobileApp` ať je samostatná třída.
Ušetří 35 řádků a odstraní falešné rozhraní. (Pokud má být provider opravdu rozšiřitelný,
ať má `complete!` a `data_to_sign` v rozhraní, ne pět nepotřebných metod.)

### M3 ⚠️ Duplicitní helpery v QES controllerech (~45 řádků)

| Metoda | Výskyty | Řádky |
|---|---|---|
| `ensure_enabled` | 4× (`qes/sessions`, `qes/form_sessions`, `api/qes_documents`, `api/qes_verifications`) | 3–4 |
| `upload_data` | 2× identicky (`api/qes_documents:44`, `api/qes_verifications:46`) | 13 |
| `file_name` | 2× identicky | 3 |
| `render_error` | 2× identicky (`qes/sessions:230`, `qes/form_sessions:157`) | 3 |
| `render_client_error` | 3× (liší se jen statusem) | 5 |
| `uploaded_file` (Tempfile → UploadedFile) | 3× (`qes_documents:125`, `qes_verifications` používá `VerifiedDocuments`, `verified_documents:39`) | 8 |
| `universal_link`/`fallback_url` vs `build_link` | 2× stejná logika | 10 |

**Oprava:** `Qes::ControllerConcern` s `ensure_enabled`, `render_qes_error` a
`Qes::PdfUpload` s `upload_data`, `file_name`, `uploaded_file`. Ušetří ~45 řádků a
zajistí, že se validace PDF (velikost, `%PDF-`, content type) nezmění jen na jednom místě.

### M4 ⚠️ Dvě nezávislé implementace ověření CMS (~100 řádků)

`Qes::Validator` (`app/lib/qes/validator.rb`) znovu implementuje to, co už dělá
`VerifyPdfSignature` (`lib/verify_pdf_signature.rb`): `verify_cms` vs `verify_contents`,
`verify_timestamp` vs `verify_timestamp`, `signer_certificate`, `trusted_chain?` vs
`trusted_certificate?`, `coverage` vs `covers_signed_revision?`. Liší se jen sémantikou
(QES trust roots vs account certs, coverage, level, kind) — a to je legitimní důvod pro
vlastní vrstvu, ale ne pro vlastní **kryptografickou** implementaci.

Důsledek je vidět v K1: DigiCert fix (`tst_info_der`) je jen ve forku, takže
`VerifyPdfSignature` (upstream cesta, kterou fork používá pro pečeť a `modified`) zůstává
rozbitý. Kdyby fix byl v `VerifyPdfSignature`, opravil by obě cesty.

**Oprava:** `Qes::Validator` ať volá `VerifyPdfSignature` pro krypto a přidá jen
`kind`/`level`/`coverage`/`trust_roots`; nebo naopak `VerifyPdfSignature` rozšířit a
`Qes::Validator` z něj jen skládat report. Ušetří ~100 řádků a odstraní K1.

### M5 ⚠️ Duplicity vůči upstream hookům (~30 řádků)

| Fork | Upstream, který to už umí |
|---|---|
| `Qes::Seal.apply` `params = {…}` (`seal.rb:19–27`) | `Submissions::GenerateResultAttachments.build_signing_params` (`:846–859`) — identické (certificate, key, chain, timestamp_handler, signature_size 20_000) |
| `Qes::ResultAttachments.combined_document` (`:31–46`) | `Submissions::GenerateCombinedAttachment.call` (`:8–40`) — stejné vytvoření blobu/attachments |
| `Qes::TbsDocument.merged_document` (`:176–190`) | `Submissions::GenerateCombinedAttachment.build_combined_pdf` (`:64–86`) — stejné merge stránek |

**Oprava:** `Seal.apply` ať použije `build_signing_params(submitter, pkcs, tsa_url)` (jen přidá `reason`);
`ResultAttachments.combined_document` ať použije `build_combined_pdf(submitter, with_audit: false)`.

### M6 ⚠️ `EmbedSignatureJob` je Sidekiq job, který se nikdy nezařadí, a slepě opakuje deterministické chyby

**Soubor:** `app/jobs/qes/embed_signature_job.rb:14–29`, volaný `sessions_controller.rb:92`

`Qes::EmbedSignatureJob.new.perform(...)` — job se nikdy neposílá do Sidekiq, běží synchronně
v requestu. `rescue StandardError` opakuje **3×** i deterministické chyby (`signature_invalid`,
`signature_size_exceeded`, `validation_failed`), přičemž každý pokus dělá CRL fetch + TSA +
podpis PDF. Uživatel čeká 3× déle a dostane stejnou chybu.

**Oprava:** volat `provider.complete!` přímo (nebo job opravdu zařadit s `retry: 0`), opakovat
jen přechodné chyby (network/TSA), ne `ClientError`. Ušetří ~30 řádků a zrychlí chybovou cestu.

### M7 ⚠️ `ExpireSessionsJob` se po výjimce už nikdy nepřeplánuje

**Soubor:** `app/jobs/qes/expire_sessions_job.rb:12–29`

`reschedule!` je až na konci `perform`. Když `QesSession.stale.find_each` nebo
`SessionManager.transition!` vyhodí jinou výjimku než `InvalidTransition` (např. DB timeout),
`reschedule!` se neprovede a **smyčka expirace se zastaví** do dalšího restartu.
Navíc `LockEvent` guard (`:29`) dovolí naplánovat jen jednou za `interval/2`.

**Oprava:** `reschedule!` do `ensure`, ideálně s `retry_on`.

### M8 ⚠️ `db/schema.rb` je zastaralé (chybí `qes_sessions`)

`db/schema.rb` je trackovaný, verze `2026_09_30_061927`, ale **neobsahuje** `qes_sessions`
ani `doc_timestamp_state`. Fork tedy spoléhá jen na migrace; `db:schema:load` vytvoří schema bez
QES tabulek (a `db:test:prepare`/`db:prepare` na prázdné DB sice migrace dohoní, ale `db:schema:load`
bez migrací ne). Upstream CI používá `db:migrate` (`.github/workflows/ci.yml:167`), takže to
nepadne, ale lokální dev, který použije `db:schema:load`, dostane `no such table: qes_sessions`.
Navíc `db:migrate` v dev vygeneruje `db/schema.rb` špinavý (a ten se pak musí commitovat).

**Oprava:** po migracích regenerovat `db/schema.rb` a commitovat; nebo přidat kontrolu do
`make qes-test`, že schema odpovídá migracím.

### M9 ⚠️ Neomezený `chain` v `POST /certificate` (DoS amplifikace)

**Soubor:** `app/controllers/qes/sessions_controller.rb:37`

```ruby
chain = Array(params[:chain]).compact_blank.map { |der| decode(der, :invalid_certificate) }
```

Bez limitu počtu ani velikosti. `data_to_sign` pak pro **každý** certifikát v řetězu volá
`Qes::Ltv.fetch_crls` → HTTP fetch (10 s timeout) → držitel tokenu může jedním requestem
vyvolat N CRL fetchů a N parsování certifikátů, a uložit N certů do DB (`certificate_chain`).
Rate limiter je 60 requestů/5 min/IP, ale N je neomezené.

**Oprava:** omezit `chain` na ~5 certifikátů a velikost každého na ~8 KB; jinak
`422 invalid_certificate`.

### M10 ⚠️ Mrtvé překlady (~60 řádků v `i18n.yml`)

| Klíče | Počet | Proč jsou mrtvé |
|---|---|---|
| `qes.app.*` | 20 × 2 locale | Zbyly z návrhu, kdy app obrazovky renderoval server; appka má vlastní i18n. Použity jen `confirm_title`, `confirm_signer`, `confirm_document`. |
| `qes.step.*` | 11 × 2 locale | Duplikát `qes_step_*` v `app/javascript/submission_form/i18n.js`; Vue používá JS sadu, ERB jen `expires_in`/`open_app`. |
| `qes_step_replaced` | 2 | Nikde se nepoužívá (i18n.js). |
| `qes_error_unknown_token` | 2 | `ERROR_KEYS` mapuje `unknown_token` na `expired_token`. |

**Oprava:** smazat `qes.app.*` (kromě 3), `qes.step.*` (kromě 2), `qes_step_replaced`,
`qes_error_unknown_token`. Ušetří ~60 řádků a odstraní druhý zdroj pravdy pro texty kroku.

### M11 ⚠️ `signed_document` se ukládá, ale nikdo ho nečte

**Soubor:** `app/lib/qes/providers/mobile_app.rb:159`

`session.signed_document` (PDF s podpisem appky, bez DSS/pečeti/DocTS) se attachuje při
každém podpisu. V produkci ho **nikdo nečte** (čtou ho jen `pipeline_spec` a `qes_sessions_spec`);
`ResultAttachments`, `TbsDocument.chained_base`, `AuditPage` čtou jen `final_document`. Je to
~1× velikost PDF na každý podpis navíc (u 10 MB PDF 10 MB na podpis).

**Oprava:** buď `signed_document` neukládat (a v auditu odkázat na `final_document`), nebo
ho využít (např. pro `signed_pdf_sha256` už je v DB) a zdůvodnit v SPEC.

### M12 ⚠️ `TbsDocument.build` volá `generate_pdfs` kvůli side effectu

**Soubor:** `app/lib/qes/tbs_document.rb:29`

```ruby
Submissions::GenerateResultAttachments.generate_pdfs(submitter, base: base, page_offsets: offsets)
draw_stamp(base, submitter, field, offsets)
```

Návratová hodnota se zahazuje; metoda se volá kvůli tomu, že **mutuje** `base` (plní pole).
To je křehké: kdyby upstream `generate_pdfs` začal vracet nový dokument místo mutace
`base`, fork tiše přestane plnit pole a podepíše prázdný dokument. Navíc `generate_pdfs` má
`base: nil` větev, která je v produkci mrtvá (volá ji jen `TbsDocument` s `base:`).

**Oprava:** pojmenovat to podle chování (`fill_submitter_fields_into(base, …)`) a volat
`fill_submitter_fields` přímo; nebo ať `generate_pdfs` vrací dokument a `TbsDocument` ho použije.

### M13 ⚠️ `WellKnownController` nemá `skip_before_action :maybe_redirect_to_setup`

**Soubor:** `app/controllers/qes/well_known_controller.rb:8`

Ostatní QES controllery `maybe_redirect_to_setup` přeskakují (`sessions`, `form_sessions`,
`app`), `well_known` ne. Na čerstvé instalaci (žádný `User`) proto `.well-known/assetlinks.json`
a `apple-app-site-association` vrátí **302 na `/setup`**, takže Android App Links verifikace
selže. (Na produkci to nevadí, protože user existuje; na novém prostředí ano.)

**Oprava:** doplnit `skip_before_action :maybe_redirect_to_setup`.

### M14 ⚠️ `submit_form_controller.rb` je dotek bez QES funkce

**Soubor:** `app/controllers/submit_form_controller.rb:29`

Změna `submission.template&.preferences&.dig('submitters_order') == 'preserved'` →
`submission.submitters_order_preserved?` je čistý refaktor, který s QES nesouvisí (upstream helper
už existuje v `lib/submissions.rb:171`). Zvyšuje počet doteků o 1 a při rebase může kolidovat
s upstream změnou stejné podmínky.

**Oprava:** revertovat (nebo poslat upstream PR); ušetří 1 dotek.

### M15 ⚠️ `config/environments/test.rb` mění cache globálně

**Soubor:** `config/environments/test.rb:30`

`config.cache_store = :null_store` → `:memory_store` kvůli `Qes::RateLimiter` testům. Mění
chování **všech** testů (a je to jediný důvod, proč `Rails.cache` v testech funguje).
Alternativa: v QES spec použít `allow(Rails).to receive(:cache).and_return(ActiveSupport::Cache::MemoryStore.new)`
nebo `Rails.cache` stub; ušetří 1 dotek a globální změnu.

### M16 ⚠️ Mrtvé metody a scopes v modelu

| Soubor | Co |
|---|---|
| `app/models/qes_session.rb:68` | `scope :failed` (0 volajících) |
| `app/models/qes_session.rb:73` | `manager` (volá jen `terminal?`) |
| `app/models/qes_session.rb:97` | `signed_attrs` (0 volajících) |
| `app/lib/qes/token.rb:6` | `LENGTH` (jen spec) |
| `app/lib/qes/certificate_info.rb:25` | `parse` (0 volajících, měl by být v K3) |
| `app/lib/qes.rb:42` | `embed_inline` (0 volajících) |

### M17 ⚠️ `abort` míchá `state` a `failure_code`

**Soubor:** `app/controllers/qes/sessions_controller.rb:109–118`

```ruby
new_state = code == 'user_cancelled' ? 'cancelled' : 'failed'
failure = code == 'token_expired' ? 'expired' : 'cancelled'
```

Pro `code = 'token_expired'` je `state = failed`, `failure_code = expired`; pro jakýkoli
jiný kód (`network_error`, …) je `failure_code = cancelled`, i když uživatel nic nezrušil.
`failure_code` má být kód z appky, `state` stav automatu.

### M18 ⚠️ `Config::DEFAULTS` není úplný, `embed_inline` je mrtvý

**Soubor:** `app/lib/qes.rb:26–44`

`seal_pkcs_path` a `seal_pkcs_password` se čtou (`mobile_app.rb:188–191`), ale v `DEFAULTS`
nejsou — fungují jen díky `ENV.key?` a `cast(raw, nil)`. `embed_inline: true` je v `DEFAULTS`,
ale nikde se nečte. To mate při čtení konfigurace: není jasné, které klíče existují.

### M19 ⚠️ Netestované doteky (5 z 20)

| Dotek | Test |
|---|---|
| `app/views/submissions/show.html.erb` (QES přehled v kartě) | ❌ žádný |
| `app/views/submissions/_value.html.erb` (`return output_buffer`) | ❌ žádný |
| `lib/submissions/generate_audit_trail.rb` + `Qes::AuditPage` | ❌ žádný |
| `lib/submitters/submit_values.rb` (hook `ValueValidator`) | ❌ žádný (testuje se jen validátor) |
| `app/javascript/submission_form/*` (330 řádků) | ❌ žádné JS testy (upstream je nemá) |

**Oprava:** přidat request spec, který dokončí QES session a zkontroluje `audit_trail` (obsahuje
`qes.audit.title`) a `values[field_uuid] == "qes:<id>"`; pro `_value.html.erb` request spec na
`/submissions/:id` s QES submission; pro JS alespoň Vitest/Jest na `qes_step.vue` (polling,
`ERROR_KEYS`, `cancel`).

### M20 ⚠️ Drobná korektnost a výkon

| Místo | Problém |
|---|---|
| `app/lib/qes/validator.rb:184` | `byte_range[2] >= byte_range[1]` je vždy true; má být `byte_range[2] == byte_range[1]` (nebo jen `byte_range[0].zero? && byte_range[2] + byte_range[3] == size`) |
| `app/lib/qes/ltv.rb:108` | `crl_urls(cert).first` — když první URL nefunguje, nezkusí druhou (PostSignum má CRL DP víckrát) |
| `app/lib/qes/rate_limiter.rb:31` | `read` + `write` není atomické; souběh dvou requestů limit obejde. Pro rate limiting přijatelné, ale vědět o tom |
| `app/lib/qes/providers/mobile_app.rb:109`, `:37` | `with_lock` a `QesSession.transaction` drží DB transakci přes CRL fetch + TSA (až 10 s) + podpis PDF. Na SQLite to serializuje zápisy; na Postgresu drží řádek. |
| `app/lib/qes/result_attachments.rb:44` | `final_document.download` kvůli `sha256` metadatům, i když `session.final_pdf_sha256` už je v DB (jen hex → base64) |
| `app/lib/qes/result_attachments.rb:39` | `combined_document` vytváří **nový blob** (kopii PDF); `call` znovu použije blob. U 10 MB PDF to je 10 MB navíc na submission. |
| `app/lib/qes/providers/mobile_app.rb:155` | komentář „tady se kontroluje INTACT + trusted všech", ale `final_report[:trusted]` obsahuje jen QES podpisy (`validator.rb:21–27`), ne pečeť ani DocTS |

---

## 6. Dead code — souhrn

| # | Co | Řádků | Důkaz |
|---|---|---:|---|
| 1 | CMS-LTV v `Qes::Ltv` + `CmsBuilder` + `PlaceholderSignedDataCreator` | ~95 | `grep -rn "Qes::Ltv\." app lib` → jen `fetch_crls`/`check_revoked!` |
| 2 | `Qes::Provider` (rozhraní bez funkce) | 35 | `grep -rn "Qes::Provider" app lib` → jen `MobileApp < Qes::Provider` |
| 3 | `MobileApp#prepare` (no-op) | 1 | `mobile_app.rb:11` |
| 4 | `QesSession#signed_attrs` | 6 | `grep -rn "\.signed_attrs\b" app lib spec` → 0 |
| 5 | `QesSession.failed` scope | 1 | `grep -rn "QesSession.failed" app lib spec` → 0 |
| 6 | `Qes::Token::LENGTH` | 1 | jen `spec/requests/qes_documents_spec.rb:164` |
| 7 | `Qes::CertificateInfo.parse` | 5 | `grep -rn "CertificateInfo.parse" app lib spec` → 0 |
| 8 | `Qes::Config[:embed_inline]` | 1 | `grep -rn "embed_inline" app lib spec` → jen `qes.rb:42` |
| 9 | `qes.app.*` (20 klíčů × 2 locale) | ~40 | `grep -rn "qes\.app\." mobile/` → 0; v ERB jen 3 |
| 10 | `qes.step.*` (11 klíčů × 2 locale) | ~22 | duplikát `qes_step_*` v `i18n.js` |
| 11 | `qes_step_replaced`, `qes_error_unknown_token` | 4 | `grep -rn "qes_step_replaced"` → jen `i18n.js` |
| 12 | `signed_document` (attachment) | — | čte jen spec; v produkci nikdo |
| 13 | `Qes::Validator#coverage` redundantní podmínka | 1 | `validator.rb:184` |
| 14 | `Qes::Ltv` konstanty `OCSP_OID`, `CA_ISSUERS_OID` | 2 | `grep -rn "OCSP_OID"` → jen definice |
| **Celkem** | | **~215 řádků** |

---

## 7. Duplicity — souhrn

| # | Duplicita | Řádků | Kde |
|---|---|---:|---|
| 1 | `upload_data` (validace PDF) | 13 | `api/qes_documents:44`, `api/qes_verifications:46` |
| 2 | `file_name` | 3 | tamtéž |
| 3 | `ensure_enabled` | 3–4 | 4 controllery |
| 4 | `render_error` / `render_client_error` | 5 | `qes/sessions:230`, `qes/form_sessions:157`, `api/qes_*` |
| 5 | `uploaded_file` (Tempfile → UploadedFile) | 8 | `api/qes_documents:125`, `verified_documents:39` |
| 6 | `universal_link`/`fallback_url` vs `build_link` | 10 | `qes/form_sessions:145–155`, `qes/app:29` |
| 7 | `Qes::Validator` vs `VerifyPdfSignature` (kryptografie) | ~100 | `validator.rb` vs `lib/verify_pdf_signature.rb` |
| 8 | `Qes::Seal.apply` vs `build_signing_params` | ~10 | `seal.rb:19–27` vs `generate_result_attachments.rb:846` |
| 9 | `Qes::ResultAttachments.combined_document` vs `GenerateCombinedAttachment.call` | ~10 | `result_attachments.rb:31` vs `generate_combined_attachment.rb:8` |
| 10 | `Qes::TbsDocument.merged_document` vs `build_combined_pdf` | ~12 | `tbs_document.rb:176` vs `generate_combined_attachment.rb:64` |
| 11 | `qes.step.*` v YAML vs `qes_step_*` v i18n.js | 22 | `i18n.yml:1274`, `i18n.js:1` |
| 12 | `qes_session` lookup (`completed.find { field_uuid }`) | 2 | `submissions/show.html.erb:361`, `_value.html.erb:4` |
| 13 | `Qes::FormSessionsController#find_field` vs `QesSession#field` | 4 | `form_sessions:132`, `qes_session.rb:79` |
| **Celkem** | | **~200 řádků** |

---

## 8. Overengineering — kde je zbytečná vrstva

1. **`Qes::Provider`** (35 řádků) — abstrakce pro jednoho providera; `prepare` je no-op,
   `build_cms/embed/validate` nikdo nevolá zvenčí.
2. **`Qes::EmbedSignatureJob`** (42 řádků) — Sidekiq job, který se nikdy nezařadí; synchronní
   volání přes `.new.perform` s vlastním retry loopem. Buď job, nebo přímé volání — ne obojí.
3. **`Qes::Ltv` CMS LTV** (~95 řádků) — zůstalo po zrušeném rozhodnutí; mrtvé.
4. **Dvě ověřovací vrstvy** (`Qes::Validator` + `VerifyPdfSignature`) — jedna by měla být
   rozšířením druhé, ne paralelní implementace.
5. **`Qes::Config`** — `DEFAULTS` + `from_env` + `overrides` je přiměřené, ale `DEFAULTS`
   neobsahuje `seal_pkcs_*` a obsahuje mrtvý `embed_inline`; `signature_size` je zároveň
   „minimum" i „placeholder size" (matoucí).
6. **`Qes::TbsDocument`** (221 řádků) míchá 4 odpovědnosti: stavba TBS, merge stránek,
   kreslení pečeti, byte range/digest. Pečeť (`draw_stamp`, `stamp_lines`, `fit_text`,
   `text_width`, ~80 řádků) by měla být `Qes::Stamp`.
7. **`Qes::PdfSource`** (73 řádků) míchá validaci, rotaci a page sizes — tři věci, tři metody;
   je to OK, ale `validate!` + `normalize_rotation` + `page_sizes` by šly do tříd.

---

## 9. Doteky vs dokumentace

| Dokument | Co tvrdí | Realita |
|---|---|---|
| SPEC § 14 | 13 doteků, každý max. 10 řádků | **21 doteků**, 4 soubory nad limit (`generate_result_attachments` 29+/13−, `template.rb` 22+, `routes.rb` 22+, `verify_pdf_signature` 14+/6−) |
| SPEC § 14 | `public/.well-known/assetlinks.json` | soubor neexistuje; řeší `Qes::WellKnownController` |
| `FORK.md` | `qes_single_signer_only` | validace se jmenuje `qes_signing_order` |
| `FORK.md` | `Qes::Providers::Pkcs11` neexistuje | správně, ale v seznamu chybí `Qes::Dss`, `DocTimestamp`, `Verifier`, `VerifiedDocuments`, `PdfSource` |
| `FORK.md` | `docs/qes.md` | soubor neexistuje |
| `docs/08` | `app/lib/submissions/…` | cesta je `lib/submissions/…` |
| `docs/08` | `git rebase upstream/main` | upstream má `master` |
| `AGENTS.md` | „Zbývá: QesStep.vue a typ pole v builderu" | obojí existuje (`qes_step.vue`, `field_type.vue`); zbývá jen reálný podpis na produkci |

**Oprava:** srovnat SPEC § 14 s realitou (21 doteků, 4 nad limit), doplnit chybějící soubory,
opravit `FORK.md` a `docs/08`.

---

## 10. Co udělat (priorita)

**P0 — před dalším nasazením (kritické):**

1. K1: `modified`/verdict u DocTS PDF (opravit `unsigned_changes?` nebo `Qes::Validator`;
   doplnit spec s DocTS). `make qes-verify-e2e` je teď **červené** — po opravě musí být zelené.
2. K2: `QES_TSA_REQUIRED` (přepsat `Qes::DocTimestamp::Handler#sign`; doplnit spec na outage).
3. K3: malformed cert → `Qes::CertificateInfo.parse` (422 místo 500; doplnit spec).
4. K4: VRI klíč (raw contents; upravit `dss_spec`).

**P1 — příští sprint (střední, levné):**

5. M1: smazat mrtvou CMS-LTV (~95 řádků) + `revocation_values:` parametry.
6. M2: smazat `Qes::Provider` + `prepare` (35 řádků).
7. M3: `Qes::ControllerConcern` + `Qes::PdfUpload` (~45 řádků).
8. M6: `EmbedSignatureJob` → přímé volání (nebo skutečný job) + chytré retry.
9. M7: `reschedule!` do `ensure`.
10. M9: limit `chain` (5 certů / 8 KB).
11. M13: `skip_before_action :maybe_redirect_to_setup` v `WellKnownController`.
12. M19: 5 netestovaných doteků — doplnit request specs (`show.html.erb`, `_value.html.erb`,
    `audit_trail`, `submit_values`) a JS testy pro `qes_step.vue`.

**P2 — úklid (nízké):**

13. M5: `Seal.apply` použít `build_signing_params`; `combined_document` použít `build_combined_pdf`.
14. M8: regenerovat `db/schema.rb`.
15. M10: smazat mrtvé i18n klíče (~60 řádků).
16. M11: rozhodnout o `signed_document` (ukládat × neukládat).
17. M12: `TbsDocument` volat `fill_submitter_fields` přímo.
18. M16, M18: mrtvé metody/scopes, `Config::DEFAULTS`.
19. M20: `coverage` podmínka, `crl_urls.first`, atomický rate limiter, krátké transakce.
20. Srovnat SPEC § 14, `FORK.md`, `docs/08`.

**Nedělat:** nerefaktorovat `Qes::Validator` a `VerifyPdfSignature` nezávisle — konsolidovat
je (M4), jinak se duplicita jen přesune.

---

## 11. Odpověď na „jak drahé bude udržovat funkcionalitu při rebase"

| Úroveň | Odhad |
|---|---|
| **Textový rebase** | 52 commitů, 21 doteků, 27 smazaných řádků → **~15 min týdně** (fetch + rebase + `make qes-test-qes`), ~30–60 min při konfliktu, ~6–12 konfliktů/rok. |
| **Sémantická verifikace** | 5 doteků bez testů (`show.html.erb`, `_value.html.erb`, `audit_trail`, `submit_values`, JS) → **~2–4 h/měsíc** při vydání (plná sada + staging e2e + ruční kontrola UI). |
| **Kryptografická verifikace** | `Qes::Validator` a `VerifyPdfSignature` se musí udržovat společně; DigiCert fix je jen v jedné z nich → **~1–2 h/čtvrtletí** a riziko regrese (K1, K2). |
| **Provozní** | `db/schema.rb`, `fly.toml`, `QES_TSA_REQUIRED` → **~1 h/čtvrtletí**. |

**Souhrn:** textově je fork **velmi levný** (94 % nových souborů, 27 smazaných řádků, rebase
bez konfliktu). Drahé je **okolí**: 5 doteků bez testů, dvě ověřovací vrstvy, mrtvá LTV vrstva a
TSA, která „nefunguje, ale tváří se, že funguje". Doporučení: **P0 opravit hned** (4 kritické),
**P1 smazat mrtvý kód a doplnit testy** (5 netestovaných doteků), a teprve pak řešit kosmetiku.

---

## 12. Oprava nálezů (2026-10-23)

Všechny nálezy z § 4–§ 9 jsou opravené v commitech forku `65358818`–`a92fc2a3`
(`fix(qes): opravy nálezů z auditu forku (docs/18) + testy doteků`, `refactor(qes): Qes::Stamp mimo TbsDocument, úklid mrtvých metod`, `fix(qes): doplnit testy M9, JS cancel/komponentu a zbytek M20 + §7 duplicity`). Co se změnilo:

| Nález | Oprava | Důkaz |
|---|---|---|
| **K1** DocTS `modified` | `VerifyPdfSignature` počítá unsigned změny za **posledním ověřeným** podpisem (ne důvěryhodným) a TSTInfo čte i z `eContent` | `spec/lib/qes/verifier_spec.rb` „keeps a DSS and DocTS update valid“; `make qes-verify-e2e` → `verdict: valid`, `modified: false` |
| **K2** `QES_TSA_REQUIRED` | `Qes::DocTimestamp::Handler#sign` ověří RFC 3161 token (struktura + imprint); falešný `GeneralizedTime` z upstream `rescue` vyhodí `TimestampError` → `apply` vrátí `failed` | `spec/lib/qes/doc_timestamp_spec.rb` (TSA outage, falešný token, cizí dokument) |
| **K3** malformed cert → 500 | `Qes::CertificateInfo.parse` v `data_to_sign` | `spec/requests/qes_sessions_spec.rb` „rejects a malformed certificate with 422“ |
| **K4** VRI klíč | SHA-1 z raw `/Contents` | `spec/lib/qes/dss_spec.rb` (negativní assert na hex řetězec), `lta_spec` |
| **M1** mrtvá CMS-LTV | smazáno ~95 řádků (`Qes::Ltv#call/values/...`, `revocation_values:` v `CmsBuilder`, unsigned attrs v placeholderu) | `make qes-test-qes` 149/0 |
| **M2** `Qes::Provider` | smazáno (35 řádků) + no-op `prepare`; `MobileApp` je samostatná | tamtéž |
| **M3** duplicitní helpery | `Qes::ControllerConcern`, `Qes::PdfUpload`, `Qes::Link` | tamtéž |
| **M4** dvě ověřovací vrstvy | kryptografie v `VerifyPdfSignature` (`verify_contents`, `verify_timestamp`, `signer_certificate`), `Qes::Validator` z ní skládá report; `Qes::TimestampToken` | `spec/lib/qes/validator_spec.rb`, `verifier_spec.rb` |
| **M5** duplicity vůči upstream | `Seal.apply` → `build_signing_params`; `merged_document` → `build_combined_pdf` (s fallbackem `template.schema`); `combined_document` sdílí `attach_pdf`/`attach_blob` (reuse final_document blob) | `spec/lib/qes/upstream_contract_spec.rb` |
| **M6** `EmbedSignatureJob` | smazán; `complete!` se volá přímo | `spec/requests/qes_sessions_spec.rb` (idempotence, cizí signatura) |
| **M7** `reschedule!` | v `ensure` | `spec/jobs/qes/expire_sessions_job_spec.rb` |
| **M8** `db/schema.rb` | regenerován (Postgres, obsahuje `qes_sessions`) | `db/schema.rb` |
| **M9** chain limit | `MAX_CHAIN` 5, `MAX_CERTIFICATE_BYTES` 8 KB v `Qes::ControllerConcern` | `spec/requests/qes_sessions_spec.rb` (long chain, oversized cert) |
| **M10** mrtvé i18n | smazáno ~100 řádků (YAML i JS) | `config/locales/i18n.yml`, `i18n.js` |
| **M11** `signed_document` | rozhodnuto: zůstává pro audit (SPEC § 7.6 bod 3), komentář v `mobile_app.rb` | SPEC § 7.6 |
| **M12** `generate_pdfs` side effect | `TbsDocument.build` používá návratovou hodnotu | `spec/lib/qes/upstream_contract_spec.rb` |
| **M13** `.well-known` redirect | `skip_before_action :maybe_redirect_to_setup` | `spec/requests/qes_well_known_spec.rb` |
| **M14** `submit_form_controller` | revertováno (dotek pryč) | `git diff upstream/master` |
| **M15** test cache | revertováno; `stub_memory_cache!` v QES specách | `spec/support/qes_helpers.rb` |
| **M16** mrtvé metody | `scope :failed`, `manager`, `signed_attrs`, `Token::LENGTH`, `embed_inline` smazány | `make qes-test-qes` 149/0 |
| **M17** `abort` | `failure_code` = kód z appky, `state` = stav automatu | `spec/requests/qes_sessions_spec.rb` „keeps the failure code from the app on abort“ |
| **M18** `Config::DEFAULTS` | `seal_pkcs_path`, `seal_pkcs_password` doplněny; `embed_inline` smazán | `app/lib/qes.rb` |
| **M19** netestované doteky | `upstream_contract_spec.rb` (14 examples), `qes_views_spec.rb`, `qes_step_logic.test.mjs` (cancel, komponenta, `form.vue`/`area.vue`), `expire_sessions_job_spec.rb` | `make qes-test-qes`, `make qes-js-test` 9/0 |
| **M20** drobnosti | `coverage` přesná podmínka, fallback CRL URL, dokumentovaný rate limiter, krátké transakce (CRL/TSA/PDF mimo `with_lock`), `final_pdf_sha256` místo stahování PDF, `combined_document` znovu používá blob, opravený komentář „trusted všech“ | `spec/lib/qes/validator_spec.rb`, `lta_spec.rb`, `spec/requests/qes_sessions_spec.rb`, `qes-e2e`/`qes-e2e-two` |
| § 7 duplicity | `QesSession.completed_for`, `Qes.template_field` — společný lookup v `show`/`_value` a `find_field` | `spec/requests/qes_views_spec.rb` |
| § 9 dokumentace | SPEC § 14 = 20 doteků s výjimkami, `FORK.md`, `docs/08`, `AGENTS.md`, SPEC příloha (bez `Qes::Provider`/statického well-known) | tento dokument, SPEC § 14 |
| **§8** `Qes::Stamp` | pečeť (`draw`, `stamp_lines`, `fit_text`, `text_width`) mimo `TbsDocument`; `signature_min_size` odděleno od placeholder size | `app/lib/qes/stamp.rb`, `app/lib/qes.rb` |
| **navíc** `strip_attributes` | `ApplicationRecord#strip_attributes` mazal whitespace i z binárních sloupců → `QesSession` je po validaci vrací; ~5 % podpisů se ukládalo poškozených | `spec/models/qes_session_spec.rb` „keeps binary signature bytes intact through validation“ |

**Měření po opravě:** `make qes-test` 392/1 (známý upstream flake `signing_form_spec.rb:1253`),
`make qes-test-postgres` 396/0, `make qes-test-qes` 149/0, `make qes-js-test` 9/0,
`make qes-e2e` (2 signatury), `make qes-e2e-two` (6 signatur), `make qes-verify-e2e`
(`verdict: valid`, `modified: false`) a `make qes-negative` (N1–N17) zelené.
