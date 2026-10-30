# 24 — Triage GitHub issues (R3/R4, 28. 10. 2026)

Triage 16 otevřených issues z 22 z `v1b3coder/dokulachtan` (nálezy „třetí a čtvrté kontroly“, R3-*/R4-*).
Každý nález byl ověřen **proti aktuálnímu kódu**: fork `cfd36b2c` + `f1c28c2b`, parent `53cbf39` + `2d1088b`
(nálezy byly hlášeny staticky na `cfd36b2c` / `53cbf39`, testy se nespouštěly).

Zaměření: **funkční a bezpečnostní rizika**. UI/UX, testovací nástroje a dokumentační politika
jsou označené jako mimo rozsah.

## 1. Souhrn

| # | Titulek (zkráceně) | Verdikt | Priorita |
|---|---|---|---|
| 4 | API `required: false` se přepíše na `true` | potvrzeno | P1 |
| 5 | `rescue_from RecordInvalid` chytá vše | potvrzeno (nízký dopad) | P2 |
| 8 | Prázdná ENV vypne default bez varování | rejected (jen tichý skip souboru; precedence zůstává) | P3 |
| 9 | Důvěra na úrovni kořene širší než TSL | opraveno (anchory = vydávající CA) | P2 |
| 10 | `QES_ENABLED=false` není úplný vypínač | opraveno (feature gate ve všech hoocích) | P2 |
| 11 | PdfiumTrust: jen razítko → změny se nekontrolují | opraveno (hranice i pro DocTS) | P2 |
| 12 | Account fallback důvěřuje klíči, ne certu | opraveno (přesná shoda certu) | P2 |
| 14 | Dokončení přes token nehlídá archivaci/expiraci | opraveno (guard v `create`, `complete`, `complete_submission`) | P0 |
| 15 | Dvě připravené revize nad jedním PDF | opraveno (aktivní revize pod zámkem + unikátní index) | **P0** |
| 16 | Úroveň QES pole jde snížit; chybí snapshot | opraveno (snapshot při vzniku, `level` ze submissionu) | P1 |
| 17 | Podepisující nemusí dokument vidět | potvrzeno | P1 |
| 18 | Ladicí otisk v assetlinks + rozbité CI | 18.1 vyřešeno (App Links zrušeny), 18.2 opraveno | P2 |
| 19 | LTV bez revokace mezilehlé CA | opraveno (CRL pro každý ne-kořenový cert; DSS z ověřeného řetězu) | P1 |
| 21 | „Ověření finálního PDF“ neověřuje podpis | potvrzeno (část), zbytek works as designed | P3 |
| 22 | URL finálního PDF se neověřuje | neplatí (stahování jen v přímém podpisu) | — |
| 23 | Drobnosti R3-10/11/13 | 1–2 mimo rozsah, 3–5 opraveno | P2 |

**Wontfix v kódu:** #22, #23.1.

## 2. P0 — bezpečnost a ztráta dat

### #18.2 CI extrahuje prázdný otisk — **opraveno**

`.github/workflows/android-release.yml:111` parsoval `apksigner verify --print-certs` jako `awk -F': ' '{print $3}'`.
Ověřeno lokálně: build-tools **35/36** tisknou `Signer #1 certificate SHA-256 digest: <hex>` → `$3` je prázdné
→ správně podepsaný APK je odmítnut. Build-tools **37** tiskne `V2 Signer: certificate SHA-256 digest: <hex>` → `$3` funguje.
**Korekce triage (2026-10-29):** run `40491396716` (v1.3.9, 2026-10-27) prošel s `APK SHA-256: 80dc86ef…c3e0`
a publikovaný APK je podepsaný release klíčem — runner tedy vybírá build-tools 37+, ne 36. Nález je
**latentní** (parser je špatný pro ≤36, ale dnes release neblokuje), ne „dnes rozbitý“.

**Oprava (2026-10-29):** `scripts/apk_fingerprint.sh` vytáhne první 64hex pole (ne sloupec), takže funguje
na obou formátech; workflow ho volá místo `awk`, před buildem běží `make apk-fingerprint-test`
(`scripts/apk_fingerprint_test.sh` — oba formáty, ignorování SHA-1, chybějící otisk = nenulový exit).
Ověřeno lokálně na reálném `apksigner` 34/35/36/37 a na release APK v1.3.9.

### #14 Dokončení přes token relace nehlídá stav submissionu — **opraveno**

`qes/sessions_controller.rb:136-146` (`complete_submission`) volal `Submitters::SubmitValues.call` bez kontrol,
které má `submit_form_controller.rb:62-70`: `template.archived_at`, `submission.archived_at`, `submission.expired?`,
`submitter.declined_at`. `SubmitValues` je nekontroluje. Token platí 24 h (`N7`).
Stejná mezera v `form_sessions_controller.rb:24` — chybělo `submission.expired?` a `template.archived_at`.
Navíc `sessions#complete` vkládal podpis do PDF i po archivaci (mrtvá revize, kterou už nikdo nedokončí).

Dopad: odesílatel smlouvu po podpisu zruší (archivuje / nechá vypršet), podepisující ji do 24 h z aplikace dokončí.

Oprava: `Qes::ControllerConcern#inactive_submission?` (stejné podmínky jako upstream) +
`reject_inactive_submission` (`410 form_not_active`), volané v `form_sessions#create` i v `sessions#complete`
a `#complete_submission`. Guard v `complete` je před modifikací PDF, takže archivace během obřadu
nevyrobí podepsanou revizi. Appka i prohlížeč mají `form_not_active` v `ERROR_TEXT`/`ERROR_KEYS`.

Test: `qes_session_completion_spec.rb` (archivace a expirace po `complete`), `qes_sessions_spec.rb`
(archivovaná šablona, expirovaná submission, archivace během obřadu), `qes_step_logic.test.mjs`,
`signScreen.test.ts` (bez retry tlačítka).

### #15 Dvě připravené revize nad jedním PDF

`form_sessions_controller.rb:44-74`: kontrola „jedna připravená session“ je jen v Ruby, před `with_lock`,
a jen pro `state: 'awaiting_signature'`. Souběh: B projde kontrolou, když A je `app_opened`; A přejde do
`awaiting_signature` (bere jen zámek řádku session, ne submission); B dostane zámek submission, A v `awaiting_signature`
nezruší a vytvoří druhou session nad stejným předchůdcem. Obě dokončí, ale výsledné PDF obsahuje jen jednu revizi.
V DB není žádné omezení (`db/migrate/20261017000001_create_qes_sessions.rb:41-45`).

Dopad: druhý podpis se tiše ztratí.

Oprava: částečný unikátní index
`qes_sessions (submission_id) WHERE state IN ('prepared','awaiting_app','app_opened','awaiting_signature')`
(Postgres i SQLite umí částečný index) + kontrola základu i pro první revizi (digest vstupního PDF).
Navíc `QesSession.active` (`qes_session.rb:68`) nezahrnuje `expires_at > now` — prošlá `awaiting_signature`
blokuje `create` odpovědí `409 signature_in_progress`, dokud ji nezavře job. Brát jen `expires_at > now`.

Test: dvě session vytvořené paralelně → druhá dostane `conflict`; prošlá session neblokuje novou.

**Opraveno (2026-10-29, fork `3268334b`):** `form_sessions#create` kontroluje aktivní session celé submission
pod zámkem (jiné pole v `awaiting_signature` → 409, ne nová revize), prošlou session pod zámkem ukončí
(`QesSession.live` ji vylučuje z předkontroly) a `RecordNotUnique` z indexu překládá na stejný 409.
`MobileApp#complete!` porovnává `qes_base_digest` i nil, takže první revize selže, když mezitím dokončila jiná.
Migrace `20261029000001` přidává částečný unikátní index na `qes_sessions (submission_id)` pro aktivní stavy
a před ním uklidí existující duplicity (ponechá nejnovější). Testy: `spec/lib/qes/session_concurrency_spec.rb`
(souběh před zámkem, prošlá session, první revize), `spec/models/qes_session_spec.rb` (index) a
`spec/requests/qes_form_sessions_spec.rb` (`show` pro expired i failed). Ověřeno T0 469/0, T1 577/0, T2 712/0, T3 716/0.

## 3. P1 — reálné, opravit v dalším bloku

### #16 Úroveň QES pole jde přes API snížit; chybí snapshot

`lib/submissions/create_from_submitters.rb:402` merguje `attrs['preferences']` do pole šablony, takže API klíč
může přepsat `preferences.level` z `qes` na `ades`; dokončení pak kontroluje upravený snapshot.
Navíc `template_fields` se naplní jen při `completed` nebo při přepisu polí (`:110`), takže bez přepisu se pozdější
úprava šablony propíše do požadavků existující submission.

**Opraveno (2026-10-30, fork `25d82cad`):** `level` i `required` se čtou ze snapshotu submissionu, ne ze šablony.
`Qes::Extensions::Models::Submission#maybe_preserve_qes_order` naplní `template_fields` při vzniku QES submissionu
(`template_fields ||= template.fields.deep_dup`), takže `Qes.template_fields` už nesahá na živou šablonu;
`Qes::Extensions::Lib::CreateFromSubmitters#assign_field_attrs` u QES pole ignoruje `preferences.level`
i `required` z API a vrátí hodnotu ze snapshotu (vytvoření i update). Backfill `FreezeQesFieldRequirements`
zmrazí starší submissions bez snapshotu (jinak by se do nich úprava šablony pořád propisovala).

Důsledek: API nemůže změnit úroveň podpisu rozběhnuté submission ani při vytvoření, ani při update;
úprava šablony se do ní nepropíše. Vytvoření s `level: ades` u `qes` šablony skončí `qes`.

Testy: `spec/requests/qes_requirements_spec.rb` (4 nové — změna levelu u rozběhnuté submission včetně
dokončení s AdES session, snapshot při vytvoření, `level` z API při vytvoření, změna šablony po vytvoření).
Ovřeno T0 469/0 (SQLite); bez opravy 3 ze 4 testů červené.

### #4 API `required: false` u QES pole se přepíše na `true` (regrese `d845ba42`)

`create_from_submitters.rb:13`: `field['required'] = true if field['type'] == 'qes' && attrs.key?('required')`
nastaví `true` bez ohledu na hodnotu. Oprava N1 (`0a44224a`) zahodila hodnotu z API úplně, ale jen ve směru
required → optional. Dnes je rozbitý i opačný směr. Hook běží i při `QES_ENABLED=false`.

Oprava: zapamatovat hodnotu před `super` a vrátit ji:

```ruby
def assign_field_attrs(field, attrs)
  template_required = field['required']
  result = super
  field['required'] = template_required if field['type'] == 'qes' && attrs.key?('required')
  result
end
```

Test: šablona `required: false`, API `required: false` → `false`.

### #11 PdfiumTrust: při přijatém jen razítku se změny nekontrolují

`pdfium_trust.rb:38`: `boundary = accepted.presence || (trusted_ranges.blank? ? verified : [])`;
`last_signature = boundary.reject { RFC3161 }...`. Když je v PDF nedůvěryhodný podpis a důvěryhodné DocTS,
`boundary` obsahuje jen razítko → `last_signature` je `nil` → `modified` se nepočítá.
Druhý případ: `trusted_ranges` neprázdné a žádný podpis přijatý → `boundary = []` → totéž.

**Opraveno (2026-10-29, fork `987707b9`):** po odfiltrování razítek se bere poslední přijatý
záznam (`boundary.max_by`), jinak poslední ověřený podpis (`verified.max_by`, drží R1). Tím se `modified`
počítá i pro PDF, kde je přijaté jen DocTS. Testy: `spec/lib/qes/verify_parity_spec.rb` (3 nové —
nedůvěryhodný podpis + DocTS + revize, nedůvěryhodný podpis za DocTS, jen DocTS + revize; kontrola
bez revize zůstává `modified: false`). Ověřeno T0 454/0 (SQLite).

Druhá část nálezu přes `Qes::Validator` sestrojit nejde — `accepted?` přijme každý range, který je
v `trusted_ranges`; dosažitelná je jen varianta `trusted_ranges = [range DocTS]`, což je první případ.
Fallback `verified.max_by` pokrývá i doslovnou variantu.

**Závažnost snížena na P2:** verdikt se v praxi nepřeklopí na `valid` (přidaný obsah po posledním
podpisu udělá `coverage: partial` → `invalid`); dopad je (a) `modified: false` → appka ukáže „Podpis je
neplatný“ místo „PDF bylo po podpisu změněno“, (b) `VerifiedDocuments.store!` a `canStore`
(`intact && !modified`) uloží změněné PDF do „Verified documents“ (D14), (c) webové „Verify PDF“ nemá
varování o změnách. Týká se PDF bez přijatého podpisu — cizí CA mimo `czech.pem`, testovací cert,
pečeť z jiné instance; naše dokumenty s PostSignum/I.CA podpisem a pečetí vlastního účtu jsou přijaté.

### #12 Account fallback pro CAdES důvěřuje veřejnému klíči, ne certifikátu

`pdfium_trust.rb:94,98` volá upstream `trusted_signature?` (`lib/verify_pdf_signature.rb:106-109`), které porovnává
jen `public_key.to_der` s certy účtu. R2 tím rozšířil důvěru i na CAdES (`signing_leaf?` + `trusted_signature?`).
Držitel klíče k CA nebo `keyEncipherment` certu v účtu si vystaví nový list se stejným klíčem, `signing_leaf?` projde
a podpis je „důvěryhodný" — obchází validaci řetězce.

**Opraveno (2026-10-29, fork `31897fc5`):** `Qes::PdfiumTrust#account_leaf?` pro CAdES vyžaduje
přesnou shodu `cert.to_der == signer.to_der` s certem účtu a dál drží `signing_leaf?` (K1);
`lib/verify_pdf_signature.rb` zůstává beze změny. Test: `spec/lib/qes/verify_parity_spec.rb`
(nový list se stejným klíčem jako cert účtu → `trusted: false`; přesný cert zůstává `trusted: true`),
helper `QesHelpers#reissued_leaf`. Ověřeno: cílené lib specy 83/0, T0 460/0 (SQLite).

**Závažnost snížena na P2:** zasažena je jen webová/API verifikace PDF (`/verify`, `/api/tools/verify`),
ne podpisový tok (`Qes::Validator` ověřuje řetěz), ne appka (S14/S15 čte `Qes::Validator`) a ne uložený report
(`Qes::Verifier#messages` bere jen pečetě). Útočník potřebuje privátní klíč k certu v účtu; bez něj podpis nezkreslí.
`adbe.pkcs7.detached` (pečeť) zůstává na upstream sémantice — klíč pečeti je na serveru.

### #19 Přísné LTV projde bez revokace mezilehlé CA; DSS z certů od klienta — **opraveno**

`ltv.rb:48-62` (`check_revoked!`): `matching.empty?` hází `No matching CRL` jen když cert má CDP
(`crl_distribution_point?`, `:331`). Mezilehlý cert bez CDP projde. `collect_crls` (`:78-98`) iteruje `[certificate, *chain]`,
tedy řetěz od klienta, ne ověřený `context.chain`. DSS (`mobile_app.rb:230-233`) dostává `certificate_chain_der`
(`:348`) — mezilehlý cert, který server zná jen z trust bundlu, se do PDF nevloží.

Oprava (fork `4fd9390a`): `Qes::Ltv.check_revoked!`/`collect_crls` při `require_ltv` odmítnou i cert
bez CRL DP (`ltv_unavailable`); s `require_ltv=false` zůstává přeskočení. `Qes::Providers::MobileApp#ltv_values`
vrací certy ověřeného řetězu a DSS je bere odtud. `Qes::Validator.verify_chain!` vrací ověřený řetěz;
controller ho použije pro fetch CRL i `data_to_sign`, takže revokace, CMS i DSS jdou z ověřeného řetězu
už při přijetí certu.
Test: `ltv_spec.rb` (mezilehlý cert bez CDP + `require_ltv` → `ltv_unavailable`),
`chain_revocation_spec.rb` (DSS certy z ověřeného řetězu), `qes_sessions_spec.rb` (controller uloží ověřený řetěz).

### #17 Podepisující nemusí dokument vidět; PDF se může otevřít v Dokulachtanu

`SharePdfModule.kt:70-90` staví `ACTION_VIEW` a `EXTRA_EXCLUDE_COMPONENTS` dává přímo na intent.
Android dokumentuje `EXTRA_EXCLUDE_COMPONENTS` jako podporované **jen pro `ACTION_CHOOSER`** — na přímém
`startActivity` ho systém ignoruje. Appka navíc registruje `OpenPdfAlias` pro `VIEW application/pdf`
(`withSharePdfTarget.js:54`), takže se PDF může otevřít v jejím importu/ověření.
`sign.tsx:360-373` odemyká „Podepsat" hned po `startActivity` (`setReviewOpened(true)`), takže zrušení výběru
nebo okamžitý návrat projde jako „zobrazeno".

Dopad: kvalifikovaný podpis bez zobrazení dokumentu. Pro cvičné dokumenty přijatelné, pro skutečné smlouvy ne.

Oprava: (a) vlastní VIEW alias z resolveru vyřadit přes `Intent.createChooser` s `EXTRA_EXCLUDE_COMPONENTS`
(tam to Android respektuje), (b) odemykat „Podepsat" až po potvrzení zobrazení — ideálně PDF uvnitř appky
(`react-native-pdf` / WebView s pdf.js) s odemčením po doscrollování na konec.

### #21 „Ověření finálního PDF" neověřuje podpis — **část opravena, zbytek works as designed**

`pdfShare.ts:145` (`verifyFinalPdf`) kontroluje jen `finalSha256` a reviewed prefix/suffix mimo `/Contents`;
CMS podpis neověřuje a přidané revize nehlídá. Reprodukce z třetí kontroly (přidaná revize „100 Kč" → „900 Kč")
prošla. Navíc obě kontroly jsou volitelné: když chybí `done.finalPdfSha256` a není `reviewPdf`, funkce projde
bez jediné kontroly (`sign.tsx:480-490`, test `pdfShare.test.ts:371-373`).
Chrání proti chybě přenosu, ne proti podvrženému serveru — název a UI slibují víc.

Oprava: buď ověřit, že finální PDF má přesně jednu revizi navíc a `/Contents` odpovídá podpisu, který appka vytvořila
(bajty podpisu má), nebo funkci i UI přejmenovat na „kontrola shody s připraveným dokumentem" a chybějící kontroly
udělat jako chybu, ne jako průchod.

**Vyřešeno (2026-10-29):** ověřování podpisu je podle designu vždy na serveru (docs/16 D15) — server finální PDF
validuje **před** `completed` (`mobile_app.rb:257-262`: `inspection == complete`, `!modified` přes `RevisionChanges`,
`intact`, `trusted`, DocTS) a servíruje přesně validované bajty (`final_document`, hash z téhož pole; `pipeline_spec.rb:168`,
`result_attachments_spec.rb:45`). Přidaná revize „900 Kč“ je tedy chyba serveru, ne appky; honest server ji odmítne
a uživatel ji má čím ověřit (`Ověřit PDF`, EU DSS, jiný software). Appka zůstává u konzistenční kontroly.

Skutečná vada byl jen tichý průchod: `finalSha256` byl optional. Opraveno — `FinalPdfCheck` má otisk povinný a volající
místo bez něj skončí `verification_failed` (`pdfShare.ts`, `sign.tsx`); texty a SPEC říkají „konzistence“, ne „ověření
podpisu“ (docs/16 D15). Testy: `pdfShare.test.ts` (chybějící otisk, přepsané bajty) a `signScreen.test.ts`
(dokončená session bez otisku).

## 4. P2 — nízké, provozní a dokumentační

- **#8** `qes.rb:87-100` — `cast` vrací `raw.presence`, takže `QES_TRUST_ROOTS=` dá `nil` (prázdný signing store).
  **Rejected (2026-10-29):** existující proměnná znamená nastavenou hodnotu — prázdný seznam nemá jinou syntaxi
  a `from_env` s `blank?` → default by rozbil `QES_TSA_URL=` (`docs/10-qes.md:45`) i `QES_LTV_ALLOWED_HOSTS=`.
  **Opraveno jen tichý skip:** `load_roots` zaloguje `trust root file not found: <cesta>` (jednou za cestu
  a proces), initializer vypíše počet certů v každém store a `error` při prázdném signing store (fork `056ecc43`).
  Fail-fast záměrně ne — shodil by celou instanci. Test: `spec/lib/qes/config_spec.rb`.
- **#9** `config/qes/czech.pem`, `validator.rb` — `store.verify` s kořeny jako trust anchors důvěřoval celému podstromu;
  kvalifikovanost se brala jen z QCStatements listu. **Opraveno (2026-10-29):** bundle obsahuje jen
  15 vydávajících CA z TSL (žádný root) a `verified_chain` nastavuje `X509_V_FLAG_PARTIAL_CHAIN`, takže
  řetěz končí na vydávající CA. Testy: `trust_roots_spec` (žádný self-signed, 15) a `validator_spec`
  (list pod CA mimo anchory není trusted). Detail: `docs/10-qes.md`, SPEC § 7.5.
- **#10** `extensions.rb:9-25`, `initializers/qes_routes.rb`, `create_from_submitters.rb:13`, `expire_sessions_job.rb` —
  při `QES_ENABLED=false` zůstávaly routy i prepend extensions; `required` rewrite běžel dál; už naplánovaný job
  se plánoval dál. **Opraveno (2026-10-29):** `QES_ENABLED` je feature gate forku ve všech hoocích —
  `template.rb` (validace pořadí), `submission.rb` (vynucení `preserved`), `create_from_submitters.rb`
  (`required` ze snapshotu), `submit_values.rb` (zámek řádku), `expire_sessions_job.rb` (`perform` i `reschedule!`)
  a čtyři endpointy bez guardu (`/qes/sign`, `.well-known/*`, `/qes-test/root.crl`,
  `templates/:id/qes_verification`) přes `Qes::ControllerConcern` → 404.
  Záměrně **není** gate v `Extensions.install!`: prependy zůstávají (jinak by zmizel
  `has_many :qes_sessions, dependent: :destroy` a smazání submittera by spadlo na FK) a jsou inertní.
  Důsledek feature gate je destruktivní a je popsaný v `docs/10-qes.md`: s vypnutým QES se použije
  upstream generátor, takže regenerované PDF u dokončeného podpisu ztratí QES revizi (uložený
  `final_document` zůstává). Testy: `template_spec`, `submission_spec`, `expire_sessions_job_spec`,
  `qes_disabled_spec` (4×), `qes_template_errors_spec`; bez guardů 8/8 červených, s guardy T0 447/1
  (1 flaky `qes_session_documents_spec` na hranici sekundy v `expires_at`).
- **#23.3** `ceremony.ts:115` — `unlockCertificate` před `POST certificate`; podpis až po validaci, takže dopad je jen
  zbytečně dlouhá doba s odemčeným klíčem. **Částečně opraveno (2026-10-29):** `POST certificate` má strop
  60 s (`CERTIFICATE_TIMEOUT_MS` v `api.ts`), takže okno neřídí server, a po podpisu se `privateKeyPem` zahodí
  (`ceremony.ts`, SPEC § 9.3 bod 8). Pořadí zůstává podle SPEC § 9.3 (biometrie → `POST certificate`); čtení certu
  bez odemčení by vyžadovalo jiný formát vaultu a změnu SPEC/DESIGN, proto se nedělá. Testy: `api.test.ts`
  (timeout → `408 timeout`), `ceremony.test.ts` (klíč je po podpisu prázdný).
- **#23.4** `sessions_controller.rb:47,69,89` — každý `GET document` / `POST certificate` posune `expires_at` bez stropu;
  klient s platným tokenem drží session naživu libovolně dlouho. **Opraveno (2026-10-29):** `QES_SESSION_MAX_TTL`
  (default 3600 s) je absolutní strop od `created_at` — `QesSession#expired?` ho vynutí i při `expires_at`
  v budoucnosti a `extend_expiry!` v controlleru na něj `expires_at` zarazí. Testy: `qes_session_spec.rb`
  (strop i výjimka pro `completed`), `qes_session_documents_spec.rb` (clamp i `410`).
- **#23.5** `sign.tsx:778` — „Zrušit" před načtením dokumentu volá `leaveSignScreen`, ne `cancelReview`,
  takže server nedostane `postAbort('user_cancelled')`. **Opraveno (2026-10-29):** tlačítko volá `cancelReview`;
  web mapuje `user_cancelled` na `qes_error_user_cancelled` (`qes_step_logic.mjs`, `qes_i18n.js`). Testy:
  `signScreen.test.ts` (abort před načtením dokumentu), `qes_step_logic.test.mjs` (mapování kódu).

## 5. Mimo rozsah (wontfix)

Sem patří **#22** (neplatí, viz níže) a **#18.1** — první verze triage ho měla jako P0, druhá jako wontfix; rozhodnutí 2026-10-29 je **zrušit App Links** (viz níže).

### #18.1 Ladicí otisk v App Links — **vyřešeno zrušením App Links** (rozhodnutí 2026-10-29)

První verze tohoto triage to měla jako P0 a navrhovala denylist debug otisku v `well_known_controller`.
Druhá verze to označila za wontfix s argumentem, že jde o konfiguraci distributora appky.
**Výsledek:** `assetlinks.json` je z forku **úplně odstraněn** — Android jde přes custom scheme
`dokulachtan://sign` a systémový chooser; ve které aplikaci se signing flow otevře, rozhoduje uživatel.
Chooser je rozliší podle jména: produkce „Dokulachtan“, debug „Dokulachtan (debug)“, testovací
APK „Dokulachtan (test)“ (applicationId `.debug` / `.test`, viz [docs/10](10-qes.md#apk-pro-testování)).

Proč to není jen konfigurace:

1. **Self-hosted produkt nemá centrální server.** `assetlinks.json` váže odkaz na podpis konkrétního APK
   **a na host zapečený v buildu** (`app.json`). Pro instanci na `example.com` by si operátor musel postavit
   vlastní APK — mechanismus je per-instance, ne per-produkt.
2. **Debug otisk je veřejný klíč.** `mobile/app/android/app/debug.keystore` (z React Native šablony) má
   soukromý klíč veřejně na GitHubu. Cizí APK se stejným `package_name` a tímto podpisem Android považuje
   za ověřeného zpracovatele odkazů a **nainstaluje se jako update** (stejný podpis → stejné UID, data i Keystore).
3. **Denylist v kódu by nic neřešila** — pořád by zbývala konfigurace per instance a údržba cizí konstanty.

Co to znamená pro bezpečnost: token v odkazu je jediná autorizace a server cert podepisujícího předem nezná
(ověří jen úroveň a trust), takže kdo token dostane, může session dokončit **svým** certem. Bez App Links
token dostane ta aplikace, kterou uživatel v chooseru vybere — to je vědomé rozhodnutí (SPEC § 6.6).

Co zůstává: iOS Universal Links (AASA, `QES_IOS_TEAM_ID`) — na iOS chooser pro custom scheme není.

**Návrh:** hotovo — `assetlinks.json` odstraněn z forku (#18.1), včetně routy, controlleru,
`QES_ANDROID_CERT_SHA256`, `intentFilters` v `app.json` a testů; E2E ověřuje 404.

**Navazující (2026-10-30):** veřejná download stránka `dokulachtan-download` servírovala APK
s produkčním `applicationId` a veřejným debug podpisem (šablona `debug.keystore`), takže kdokoli mohl
dodat update. Stránka i Fly app byly zrušeny; testovací APK se staví lokálně a předává přímo.

- **#23.1 Lexikální detekce šifrovaného PDF v appce** (`preparedDocument.ts:49-65`) — jen UX, server kontroluje parserem
  (`pdf_source.rb`). Nebudeme parsovat xref v JS.
- **#23.2 Paralelní spouštěč testů** — **opraveno (2026-10-29):** `scripts/qes-test-parallel.sh` kontroluje
  návratový kód plánovače a počet skupin, takže prázdný plán neprojde jako úspěch; migrace v kontejneru jdou
  přes `&&` a při chybě vypíšou log. Test: `scripts/qes_test_parallel_test.sh` (`make qes-test-parallel-selftest`).

### #22 URL finálního PDF se neověřuje — **neplatí** (rozhodnutí 2026-10-29)

`pdfShare.ts:106` (`downloadPdf`) opravdu předá URL z těla odpovědi rovnou `File.downloadFileAsync` bez kontroly
schématu a originu a `documentUrl` (`pdfApi.ts:295-307`) ji nevaliduje. Nález ale popisuje scénář, který v kódu není:

1. **Stahování je jen v přímém podpisu PDF.** Tlačítka „Stáhnout“/„Sdílet“ se renderují pod `isPdfFlow`
   (`sign.tsx:689`) a `pdfApi()` dnes navíc hází `invalid_server`, když `!isPdfFlow` (`sign.tsx:194`); `downloadPdf`
   i `documentUrl` mají jediné volání (`sign.tsx:480-482`). Ve signing workflow appka po podpisu jen napíše
   „Dokument byl podepsán. Můžete se vrátit do prohlížeče.“ — nic nestahuje.
2. **Vazba na server z Nastavení existuje.** `pdfApi()` volá `resolveSigningOrigin` (`signingOrigin.ts:52-60`);
   když se origin odkazu liší od Nastavení, padá `foreign_server` ještě před requestem.
3. **Kontrola URL by nepřidala bezpečnost, jen konfigurační závislost.** V přímém podpisu je server z Nastavení ten
   server, kterému uživatel nahrál PDF a který vyrobil finální PDF (pečeť + DocTS); podvržené PDF může vrátit
   z vlastního originu stejně snadno. Zavázání na `APP_URL` by naopak rozbilo nasazení, kde se host liší
   (custom doména, CDN, `HOST` v multitenant režimu) — u self-hosted software reálný scénář.

Co zůstává platné: kdyby někdy přibylo stahování finálního PDF ve workflow flow, URL se musí vázat na **origin
session** (server z odkazu), ne na Nastavení — pravidlo do `docs/17`/SPEC, ne kód dnes. Integritu finálního PDF
řeší #21, podmínku důvěry v orchestraci #17.

## 7. Návrh pořadí oprav

| Blok | Issues | Proč první |
|---|---|---|
| F3 | #14, #15 | stav submissionu a souběh revizí; potřebuje migraci (částečný index) |
| F4 | #16, #4 | snapshot polí a `required`; jeden hook, dva testy |
| F5 | #18.2 | hotovo: `scripts/apk_fingerprint.sh` + test v CI |
| F6 | #11, #12 | hranice změn a account fallback; dva testy v `verify_parity_spec.rb` |
| F7 | #19 | LTV řetěz a DSS; pozor na LTV scénáře v `lts_spec.rb`/`crl_scope_spec.rb` |
| F8 | #17, #21 | appka: review, ověření finálního PDF; E2E na emulátoru |
| F9 | #8, #9, #10, #23.3–5 | hotovo: drobnosti a dokumentace; bez migrací |

Po každém bloku: `make qes-test-qes` (T0) + `make qes-app-test`/`make qes-app-typecheck` u appky,
před PR `make qes-test` a `make qes-e2e*`; SPEC § 16 doplnit u #14, #16.

## 8. Poznámky

- Nálezy R3-*/R4-* jsou zapsané jen tady; tento dokument je jejich záznam.
  R1/R2 jsou opravené a kryté `spec/lib/qes/verify_parity_spec.rb` (pravidla v SPEC § 16).
- Ověření bylo statické (čtení kódu + `apksigner` na build-tools 35/36/37 pro #18.2); testy se nespouštěly.
