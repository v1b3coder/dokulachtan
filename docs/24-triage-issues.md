# 24 — Triage GitHub issues (R3/R4, 28. 10. 2026)

Triage 17 otevřených issues z 22 z `v1b3coder/dokulachtan` (nálezy „třetí a čtvrté kontroly“, R3-*/R4-*).
Každý nález byl ověřen **proti aktuálnímu kódu**: fork `cfd36b2c` + `f1c28c2b`, parent `53cbf39` + `2d1088b`
(nálezy byly hlášeny staticky na `cfd36b2c` / `53cbf39`, testy se nespouštěly).

Zaměření: **funkční a bezpečnostní rizika**. UI/UX, testovací nástroje a dokumentační politika
jsou označené jako mimo rozsah.

## 1. Souhrn

| # | Titulek (zkráceně) | Verdikt | Priorita |
|---|---|---|---|
| 4 | API `required: false` se přepíše na `true` | potvrzeno | P1 |
| 5 | `rescue_from RecordInvalid` chytá vše | potvrzeno (nízký dopad) | P2 |
| 8 | Prázdná ENV vypne default bez varování | potvrzeno | P2 |
| 9 | Důvěra na úrovni kořene širší než TSL | potvrzeno (policy) | P2 |
| 10 | `QES_ENABLED=false` není úplný vypínač | potvrzeno (úzké) | P2 |
| 11 | PdfiumTrust: jen razítko → změny se nekontrolují | potvrzeno | P1 |
| 12 | Account fallback důvěřuje klíči, ne certu | potvrzeno | P1 |
| 14 | Dokončení přes token nehlídá archivaci/expiraci | potvrzeno | **P0** |
| 15 | Dvě připravené revize nad jedním PDF | potvrzeno | **P0** |
| 16 | Úroveň QES pole jde snížit; chybí snapshot | potvrzeno | P1 |
| 17 | Podepisující nemusí dokument vidět | potvrzeno | P1 |
| 18 | Ladicí otisk v assetlinks + rozbité CI | 18.1 mimo rozsah (config), 18.2 potvrzeno | P1 |
| 19 | LTV bez revokace mezilehlé CA | potvrzeno | P1 |
| 21 | „Ověření finálního PDF“ neověřuje podpis | potvrzeno | P1 |
| 22 | URL finálního PDF se neověřuje | potvrzeno (nízký) | P2 |
| 23 | Drobnosti R3-10/11/13 | 1–2 mimo rozsah, 3–5 potvrzeno | P2 |

**Wontfix v kódu:** #18.1 (konfigurace distributora appky), #23.1, #23.2.

## 2. P0 — bezpečnost a ztráta dat

### #18.2 CI extrahuje prázdný otisk

`.github/workflows/android-release.yml:111` parsuje `apksigner verify --print-certs` jako `awk -F': ' '{print $3}'`.
Ověřeno lokálně: build-tools **35/36** tisknou `Signer #1 certificate SHA-256 digest: <hex>` → `$3` je prázdné
→ správně podepsaný APK je odmítnut. Build-tools **37** tiskne `V2 Signer: certificate SHA-256 digest: <hex>` → `$3` funguje.
`find … | sort -V | tail -1` na runneru dnes vybere 36 → release cesta je rozbitá (selhává bezpečně, ale nefunguje).

Oprava: `grep -oE '[0-9a-fA-F]{64}' | head -1` místo `awk`, plus test formátu v CI (obě varianty výstupu).

### #14 Dokončení přes token relace nehlídá stav submissionu

`qes/sessions_controller.rb:136-146` (`complete_submission`) volá `Submitters::SubmitValues.call` bez kontrol,
které má `submit_form_controller.rb:62-70`: `template.archived_at`, `submission.archived_at`, `submission.expired?`,
`submitter.declined_at`. `SubmitValues` je nekontroluje. Token platí 24 h (`N7`).
Stejná mezera v `form_sessions_controller.rb:24` — chybí `submission.expired?` a `template.archived_at`.

Dopad: odesílatel smlouvu po podpisu zruší (archivuje / nechá vypršet), podepisující ji do 24 h z aplikace dokončí.

Oprava: jedna sdílená metoda `Qes::SubmissionState.active!(submission)` (stejné podmínky jako upstream),
volaná v `form_sessions#create` i `sessions#complete_submission`; chyba `gone`/`conflict` s QES kódem.

Test: archivace submission po `complete` → `complete_submission` musí selhat; expired submission → `create` musí selhat.

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

## 3. P1 — reálné, opravit v dalším bloku

### #16 Úroveň QES pole jde přes API snížit; chybí snapshot

`lib/submissions/create_from_submitters.rb:402` merguje `attrs['preferences']` do pole šablony, takže API klíč
může přepsat `preferences.level` z `qes` na `ades`; dokončení pak kontroluje upravený snapshot.
Navíc `template_fields` se naplní jen při `completed` nebo při přepisu polí (`:110`), takže bez přepisu se pozdější
úprava šablony propíše do požadavků existující submission.

Oprava: v `Qes::Extensions::Lib::CreateFromSubmitters#assign_field_attrs` u `qes` polí vždy vrátit
`preferences['level']` a `required` ze šablony (ignorovat `attrs`), a `submission.template_fields` naplnit vždy
(`submission.template_fields ||= submission.template.fields.deep_dup`).

Test: šablona `qes` + API `preferences: {level: 'ades'}` → session zůstane `qes`; template_fields je vyplněné.

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

Oprava: když po odfiltrování razítek nic nezbude, počítat `modified` vůči poslednímu přijatému razítku,
nebo vůči `verified`. Test: nedůvěryhodný podpis + důvěryhodné DocTS + přidaná revize → `modified: true`.

### #12 Account fallback pro CAdES důvěřuje veřejnému klíči, ne certifikátu

`pdfium_trust.rb:94,98` volá upstream `trusted_signature?` (`lib/verify_pdf_signature.rb:106-109`), které porovnává
jen `public_key.to_der` s certy účtu. R2 tím rozšířil důvěru i na CAdES (`signing_leaf?` + `trusted_signature?`).
Držitel klíče k CA nebo `keyEncipherment` certu v účtu si vystaví nový list se stejným klíčem, `signing_leaf?` projde
a podpis je „důvěryhodný" — obchází validaci řetězce.

Oprava: v account fallbacku pro CAdES porovnávat celý cert (`to_der`), ne klíč; nebo fallback omezit na certy,
které samy mají `signing_leaf?` (což je dnes jen částečné). Test: nový list se stejným klíčem jako CA cert v účtu → `trusted: false`.

### #19 Přísné LTV projde bez revokace mezilehlé CA; DSS z certů od klienta

`ltv.rb:48-62` (`check_revoked!`): `matching.empty?` hází `No matching CRL` jen když cert má CDP
(`crl_distribution_point?`, `:331`). Mezilehlý cert bez CDP projde. `collect_crls` (`:78-98`) iteruje `[certificate, *chain]`,
tedy řetěz od klienta, ne ověřený `context.chain`. DSS (`mobile_app.rb:230-233`) dostává `certificate_chain_der`
(`:348`) — mezilehlý cert, který server zná jen z trust bundlu, se do PDF nevloží.

Oprava: při `require_ltv` vyžadovat CRL/OCSP pro každý ne-kořenový cert ověřeného řetězce a do DSS vkládat tento řetězec.
Test: mezilehlý cert bez CDP + `require_ltv` → `ltv_unavailable`; DSS obsahuje všechny certy řetězce.

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

### #21 „Ověření finálního PDF" neověřuje podpis

`pdfShare.ts:145` (`verifyFinalPdf`) kontroluje jen `finalSha256` a reviewed prefix/suffix mimo `/Contents`;
CMS podpis neověřuje a přidané revize nehlídá. Reprodukce z třetí kontroly (přidaná revize „100 Kč" → „900 Kč")
prošla. Navíc obě kontroly jsou volitelné: když chybí `done.finalPdfSha256` a není `reviewPdf`, funkce projde
bez jediné kontroly (`sign.tsx:480-490`, test `pdfShare.test.ts:371-373`).
Chrání proti chybě přenosu, ne proti podvrženému serveru — název a UI slibují víc.

Oprava: buď ověřit, že finální PDF má přesně jednu revizi navíc a `/Contents` odpovídá podpisu, který appka vytvořila
(bajty podpisu má), nebo funkci i UI přejmenovat na „kontrola shody s připraveným dokumentem" a chybějící kontroly
udělat jako chybu, ne jako průchod.

## 4. P2 — nízké, provozní a dokumentační

- **#5** `template_errors.rb:11,16,19` — `rescue_from` chytá každou `RecordInvalid` a staví zprávu z `@template.errors`,
  ne z `error.record.errors`. V praxi dnes `RecordInvalid` v těchto controllerech hází jen `@template.save!`,
  takže dopad je malý; oprava je ale levná: `raise error unless error.record.is_a?(Template) && error.record.errors.attribute_names.include?(:fields)`
  a stavět z `error.record.errors`. Test: RecordInvalid z jiného záznamu → upstream chování.
- **#8** `qes.rb:87-98` — `cast` vrací `raw.presence`, takže `QES_TRUST_ROOTS=` dá `nil` (prázdný signing store)
  a `QES_EXPIRY_JOB_INTERVAL=` dá `0` (expirace se nikdy nespustí). `load_roots` (`:133-142`) neexistující soubor tiše přeskočí.
  Oprava: `from_env` vrací default, když je `ENV[env_name].blank?`, kromě `ltv_allowed_hosts` (prázdná = vypnuto);
  initializer zaloguje počet kořenů v každém store a seznam nenalezených souborů; při `QES_ENABLED=true` a nule
  signing kořenů odmítnout start. Test: `QES_TRUST_ROOTS=` → default; `QES_EXPIRY_JOB_INTERVAL=` → 60.
- **#9** `config/qes/czech.pem`, `validator.rb` — `store.verify` s kořeny jako trust anchors důvěřuje celému podstromu;
  kvalifikovanost se bere jen z QCStatements listu. Rozhodnutí: buď README „důvěra v kořeny z TSL, ne validace podle TSL",
  nebo do verification store dávat přímo vydávající CA z TSL. Dnes dokumentace mluví o kořenech — doplnit větu a zavřít.
- **#10** `extensions.rb:9-25`, `initializers/qes_routes.rb`, `create_from_submitters.rb:13`, `expire_sessions_job.rb` —
  při `QES_ENABLED=false` zůstávají routy i prepend extensions; `required` rewrite běží dál; už naplánovaný job
  se plánuje dál. Oprava: hook začínat `return super unless Qes.enabled?` (hlavně `create_from_submitters`) a v README
  napsat, že změna vyžaduje restart.
- **#22** `pdfShare.ts:106` — `downloadPdf` předá URL z API rovnou `File.downloadFileAsync` bez kontroly schématu/origin.
  Dopad nízký (přesměrování podepsanou URL jinému hostu nepředá), ale chybí vazba na server z Nastavení.
  Oprava: před stažením ověřit `https` a host proti serveru z Nastavení (nebo nakonfigurovanému úložišti),
  chybu hlásit jako `foreign_server`.
- **#23.3** `ceremony.ts:115` — `unlockCertificate` před `POST certificate`; podpis až po validaci, takže dopad je jen
  zbytečně dlouhá doba s odemčeným klíčem. Oprava: veřejný cert a řetěz číst bez odemčení, klíč odemknout až před podpisem.
- **#23.4** `sessions_controller.rb:47,69,89` — každý `GET document` / `POST certificate` posune `expires_at` bez stropu;
  klient s platným tokenem drží session naživu libovolně dlouho. Oprava: absolutní strop `created_at + N`, prodlužovat jen do něj.
- **#23.5** `sign.tsx:772` — „Zrušit" před načtením dokumentu volá `leaveSignScreen`, ne `cancelReview`,
  takže server nedostane `postAbort('user_cancelled')`. Oprava: volat `cancelReview`.

## 5. Mimo rozsah (wontfix)

Sem patří i **#18.1** — první verze triage ho měla jako P0, což bylo špatně (viz níže).

### #18.1 Ladicí otisk v produkčních App Links — **mimo rozsah (wontfix v kódu)**

První verze tohoto triage to měla jako P0 a navrhovala denylist debug otisku v `well_known_controller`.
To bylo špatně a zde je oprava:

`QES_ANDROID_CERT_SHA256` se v celém kódu používá **na jednom místě** — `qes/well_known_controller.rb:27`,
kde se jen vypíše do `assetlinks.json`. Nikde se podle něj nic neautentizuje ani nevaliduje;
`app_metadata` z appky se jen uloží (`qes_session.rb:60`), nikdy se neporovnává. Servery tedy otisk
nijak nechrání — je to **veřejné tvrzení pro Android**, ne bezpečnostní kontrola na straně DocuSealu.

Co to reálně znamená: kdokoli umí postavit APK s `package_name=cz.dokulachtan.signer` podepsané veřejným
debug klíčem a Android ho bude považovat za ověřeného zpracovatele odkazů. Aby ale cizí appka dostala token,
musí být **nainstalovaná na zařízení oběti** — to už je kompromitace zařízení, ne serveru. Server nemá jak
poznat, kdo odkaz otevřel, a token je jediná autorizace.

Proč to neděláme v DocuSealu: rozhodnutí „která appka se smí distribuovat" patří distributorovi appky
(uživateli), ne DocuSealu. Hardcodovaná denylist cizích otisků ve forku je scope creep, který se musí udržovat
a který nic neřeší — když je otisk špatný, je špatná konfigurace, ne kód.

Co zůstává (config a docs, ne kód):
1. `deploy/android-release/README.md:69-77` už správně říká, že debug otisk je dočasný a že se „starý debug podpis
   už nikdy nesmí použít pro distribuci". `docs/09` a `docs/10-qes.md` uvádějí debug otisk
   jako **dočasný** stav s poznámkou, že release APK z CI vyžaduje `80:DC:…:E0`. Dokumentace je tedy v pořádku.
2. Až se z CI nasadí produkční APK, přepnout `QES_ANDROID_CERT_SHA256` na `80:DC:…:E0` (`fly secrets set`).
   Do té doby App Links na produkční instanci fungují jen pro debug-signed testovací APK — to je vědomá daň za to,
   že je testovací APK veřejně ke stažení. Odkaz jde vždy i přes custom scheme, takže podepsat se dá i bez App Links.

**Návrh:** zavřít #18.1 jako mimo rozsah, nechat jen jako položku v deployment checklistu (přepnutí secrets
při vydání produkčního APK). Žádná změna kódu.

- **#23.1 Lexikální detekce šifrovaného PDF v appce** (`preparedDocument.ts:49-65`) — jen UX, server kontroluje parserem
  (`pdf_source.rb`). Nebudeme parsovat xref v JS.
- **#23.2 Paralelní spouštěč testů** (`scripts/qes-test-parallel.sh:125,167`, `scripts/qes_test_groups.py:85`) —
  vývojový nástroj, ne produkt. Opraveno samostatně, až bude potřeba.

## 7. Návrh pořadí oprav

| Blok | Issues | Proč první |
|---|---|---|
| F3 | #14, #15 | stav submissionu a souběh revizí; potřebuje migraci (částečný index) |
| F4 | #16, #4 | snapshot polí a `required`; jeden hook, dva testy |
| F5 | #18.2 | CI `awk` — extrakce otisku z `apksigner` (workflow, ne kód forku) |
| F6 | #11, #12 | hranice změn a account fallback; dva testy v `verify_parity_spec.rb` |
| F7 | #19 | LTV řetěz a DSS; pozor na LTV scénáře v `lts_spec.rb`/`crl_scope_spec.rb` |
| F8 | #17, #21, #22 | appka: review, ověření finálního PDF, URL; E2E na emulátoru |
| F9 | #5, #8, #9, #10, #23.3–5 | drobnosti a dokumentace; bez migrací |

Po každém bloku: `make qes-test-qes` (T0) + `make qes-app-test`/`make qes-app-typecheck` u appky,
před PR `make qes-test` a `make qes-e2e*`; SPEC § 16 doplnit u #14, #16.

## 8. Poznámky

- Nálezy R3-*/R4-* jsou zapsané jen tady; tento dokument je jejich záznam.
  R1/R2 jsou opravené a kryté `spec/lib/qes/verify_parity_spec.rb` (pravidla v SPEC § 16).
- Ověření bylo statické (čtení kódu + `apksigner` na build-tools 35/36/37 pro #18.2); testy se nespouštěly.
