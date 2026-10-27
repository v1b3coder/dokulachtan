# 21 — Audit signing flow v appce (2026-10-27)

**Stav:** realizováno 2026-10-27 (K1–K3, K5–K33; K4 zůstává dle rozhodnutí)
**Rozsah:** `mobile/app/app/sign.tsx`, `sign-pdf.tsx`, `src/lib/ceremony.ts`,
`src/lib/preparedDocument.ts`, `src/lib/api.ts`, `src/lib/pdfApi.ts`, `src/lib/pdfShare.ts`,
`src/lib/crypto/vault.ts`, `src/lib/signer.ts`, server `Qes::SessionsController`,
`Qes::Providers::MobileApp`, `Qes::TbsDocument`, `Qes::CmsBuilder`, `QesSession`,
testy a dokumentace.

**Metoda:** statická analýza kódu, průchod protokolu server ↔ appka, srovnání s DESIGN.md,
SPEC.md, docs/15, docs/17, kontrola testů a e2e harnessu. Reálná čtečka, reálné TSA/CRL
a systémový PDF prohlížeč nebyly testovány.

---

## 1. Shrnutí

1. **Uživatel má pravdu v tom, že „Zkontrolovat dokument“ není jen kontrola.** Tlačítko
   odemkne privátní klíč biometrií, pošle certifikát na server, nechá server postavit TBS
   a stáhne ho. Raw RSA/ECDSA signatura vzniká až po potvrzení, ale **příprava podpisu
   a přístup ke klíči proběhly před kontrolou**.
2. **Kontrola dnes probíhá nad TBS připraveným serverem**, ne nad nepodepsaným originálem.
   Appka sice ověří, že signatura bude přesně nad staženým TBS (`verifyPreparedDocument`),
   ale **neověří, že TBS je dokument, který uživatel zamýšlel podepsat** — ani v přímém PDF
   toku, kde appka místní soubor má.
3. **Finální PDF se v appce neověřuje.** Appka stáhne finální PDF a nabídne „Stáhnout“ /
   „Sdílet“, ale nekontroluje `final_pdf_sha256`, nepřítomnost reviewed TBS ani platnost
   vlastní signatury. Server tvrdí, že je platná; appka to nezávisle neověří.

**Co je dnes v pořádku a má se zachovat:** `verifyPreparedDocument` je silná kontrola.
Ověřuje `ByteRange`, mezeru `/Contents`, digest podepsaných bajtů, `messageDigest`
i `contentType` v `data_to_sign`. Tuhle část auditu nedoporučuji bourat, jen doplnit.

### 1.1 Priorita oprav

| Priorita | Co | Nálezy |
|---|---|---|
| **P0** | Kontrola před klíčem a před serverovou přípravou; TBS stavět před certifikátem | K1, K2 |
| **P0** | Ověřit finální PDF (hash + reviewed bytes) | K3 |
| **P1** | Cert atributy v `data_to_sign`, TTL během kontroly (gate K4 zůstává dle rozhodnutí) | K5, K6, K7 |
| **P1** | Chybové kódy, `202` polling, `X-QES-Protocol`, `needs_reader` | K10, K11, K12, K13 |
| **P2** | Přímý PDF: reuse submission, místní kontrola, `source_sha256`, UI texty | K8, K9, K14 |
| **P2** | Testy, e2e a dokumentace | K29–K33 |

---

## 2. Jak flow funguje dnes

### 2.1 Přímý podpis PDF (S11 → S12 → S4 → S13)

1. **S11** `sign-pdf.tsx:130-144` vybere PDF (`expo-document-picker`) nebo ho dostane
   ze share sheetu (`sign-pdf.tsx:91-99`). Místní soubor zůstává v `file.uri`.
2. `sign-pdf.tsx:146-168` nahraje PDF na `POST /api/qes/documents`; server založí šablonu
   ve složce „Direct signing“, vrátí `template_id`, pole `qes`, stránky a `stamp`.
3. **S12** `sign-pdf.tsx:194-230`:
   - `setStampArea` (`PATCH /api/templates/:id`) umístí pečeť,
   - `createSubmission` (`POST /api/templates/:id/submissions`) založí **novou submission**,
   - `startSession` (`POST /s/:slug/qes_sessions`) založí session a vrátí token,
   - router přejde na S4 s `flow=pdf`.
4. **S4** `sign.tsx:468` tlačítko **„Zkontrolovat dokument“** zavolá `sign()`
   (`sign.tsx:258-295`), který spustí `runSigningCeremony` (`ceremony.ts:43-139`):
   1. `getSession` (`ceremony.ts:47`) — metadata, žádný klíč.
   2. `selectSigner` (`ceremony.ts:49-57`) — volba klíče/čtečky.
   3. **odemčení klíče** (`ceremony.ts:86` `unlockCertificate`) — biometrie
      (`vault.ts:304-333`, `loadVaultKey` s `requireAuthentication`);
      u čtečky `initializeSession` + `getCertificate` + `listContainers`
      (`ceremony.ts:66-71`).
   4. **`POST /certificate`** (`ceremony.ts:108`) — server ověří certifikát a řetěz,
      stáhne CRL, **postaví TBS** (`mobile_app.rb:17-47`), uloží ho a vrátí
      `data_to_sign` + `byte_range` + `document_digest`.
   5. **`GET /document`** (`ceremony.ts:118`) — stáhne TBS. Server ho vydá jen ve stavu
      `awaiting_signature` (`sessions_controller.rb:30-38`).
   6. `verifyPreparedDocument` (`preparedDocument.ts:56-123`) — ověří, že `data_to_sign`
      kryje stažený TBS.
   7. **kontrola uživatele** (`ceremony.ts:131` `confirmDocument`) — appka zobrazí
      „Otevřít přesné PDF“ (`sign.tsx:460`) a „Podepsat tento dokument“
      (`sign.tsx:461`), tlačítko je povolené až po `reviewOpened`.
   8. **raw signatura** (`ceremony.ts:135`) — `sign(dataToSign)`.
   9. **`POST /complete`** (`ceremony.ts:137`) — server sestaví CMS, vloží PAdES, přidá
      DSS, pečeť a DocTS, validuje.
5. **S13** `sign.tsx:298-318` stáhne finální PDF přes `GET /api/submitters/:id`
   a nabídne „Stáhnout“ / „Sdílet“ / „Otevřít“.

### 2.2 DocuSeal formulář (deep link)

Stejné jako 2.1 kroky 4–5, jen bez S11/S12: dokument i submission vytvořil
odesílatel v DocuSealu, appka dostane jen token. Po `completed` appka dokončí
submission přes `POST /qes/sessions/:token/complete_submission` (`sign.tsx:162-183`),
prohlížeč si výsledek převezme sám.

### 2.3 Co dělá server

- `POST /certificate` (`sessions_controller.rb:41-84`) ověří certifikát, řetěz, CRL,
  `level_required`, `key_location`, **postaví TBS** (`mobile_app.rb:17-47`) a vrátí
  `data_to_sign`, `byte_range`, `document_digest`, `certificate_info`.
- `POST /complete` (`sessions_controller.rb:85-118`) ověří raw signaturu, sestaví CMS
  z **uloženého** `signed_attrs_der`, vloží ho do **uloženého** TBS, přidá DSS, pečeť,
  DocTS, validuje a nastaví `completed`.
- `GET /document` (`sessions_controller.rb:30-38`) vydá TBS jen ve stavu
  `awaiting_signature`.

---

## 3. Jaké garance dnes skutečně máme

| # | Garance | Dnes | Kde |
|---|---|---|---|
| G1 | Raw signatura je přesně nad `data_to_sign` | **ano** | `ceremony.ts:135`, `softwareSigner.ts:9` |
| G2 | `data_to_sign` obsahuje `messageDigest` staženého TBS | **ano** | `preparedDocument.ts:101-119` |
| G3 | TBS, který uživatel viděl, je přesně ten, který appka podepisuje | **ano, ale jen pro TBS** | `preparedDocument.ts:56-123`, `sign.tsx:460` |
| G4 | TBS je dokument, který uživatel zamýšlel podepsat | **ne** | TBS staví server (`mobile_app.rb:44-47`), appka nemá vazbu na originál |
| G5 | Finální PDF obsahuje reviewed TBS | **server ano, appka ne** | `mobile_app.rb:252-253`, `:271-272`, `sign.tsx:298-318` |
| G6 | Finální PDF má platnou signaturu | **server ano, appka ne** | `mobile_app.rb:195-203`, `sign.tsx:298-318` |
| G7 | Certifikát v `data_to_sign` je ten, který appka poslala | **ne** | `preparedDocument.ts` neověřuje `signingCertificateV2` |
| G8 | `signingTime` je rozumný | **ne** | `preparedDocument.ts` neověřuje `signingTime` |
| G9 | `certificate_info` odpovídá místnímu certifikátu | **ne** | `types.ts:37-43` se nepoužívá |
| G10 | Klíč se odemyká až po kontrole | **ne** | `ceremony.ts:86` před `:131` |
| G11 | Kontrola je vynutitelná | **slabě** | `sign.tsx:127-141`, `reviewOpened` po `startActivity` |
| G12 | Session během kontroly nevyprší | **ne** | `qes_session.rb:70`, `Qes::ExpireSessionsJob`, TTL 600 s |
| G13 | `completed.document_digest` je reviewed digest | **ne** | `sign.tsx:212`, `:278`, `:422` |

**Závěr:** kryptografická garance „signatura kryje reviewed TBS“ dnes **existuje**.
Garance „reviewed TBS je dokument, který uživatel chtěl podepsat“ **neexistuje**.
Garance „finální PDF je to, co uživatel viděl“ **v appce neexistuje**.

---

## 4. Nálezy

### 4.1 Kritické a vysoké

#### K1 — „Zkontrolovat dokument“ odemyká klíč a připravuje podpis

**Důkaz:** `sign.tsx:468` tlačítko „Zkontrolovat dokument“ → `sign.tsx:258-295`
→ `ceremony.ts:86` `unlockCertificate` (biometrie) → `ceremony.ts:108`
`postCertificate` (server staví TBS) → `ceremony.ts:118` `getDocument`
→ `ceremony.ts:131` `confirmDocument`.

**Dopad:** uživatel, který si chce dokument jen prohlédnout, je nucen k biometrii;
klíčový materiál je po celou dobu kontroly v paměti; server už má připravený
podpis; uživatel nemá možnost „jen se podívat“ bez autorizace klíče.

**Doporučení:** rozdělit na dvě akce. „Zobrazit dokument“ = jen `GET /document`
a náhled, žádný klíč, žádný `POST /certificate`. „Podepsat“ = biometrie +
`POST /certificate` + signatura + `POST /complete`. Tlačítko „Zkontrolovat
dokument“ přejmenovat na „Zobrazit dokument“ a přesunout do něj kontrolu.

#### K2 — Kontrola je nad TBS připraveným serverem, ne nad nepodepsaným originálem

**Důkaz:**
- `sessions_controller.rb:30-38` — `GET /document` vydá TBS jen ve stavu
  `awaiting_signature`, tj. až po `POST /certificate`.
- `mobile_app.rb:17-47` — TBS se staví v `POST /certificate`, tedy po odemčení
  klíče a po volbě certifikátu.
- `ceremony.ts:108-120` — appka stáhne TBS až po `POST /certificate`.
- `preparedDocument.ts:56-123` — ověří jen vnitřní konzistenci TBS a `data_to_sign`,
  ne vazbu na původní soubor.
- `sign-pdf.tsx:130-192` — místní `file.uri` se nahraje, ale appka si nikdy
  neuloží jeho hash ani ho neporovná se serverem; `preview_url` na S12 je
  serverový náhled (`sign-pdf.tsx:368`), ne místní soubor.

**Dopad:** malicious server může postavit TBS z jiného dokumentu, než který uživatel
vybral nebo který odesílatel zamýšlel. Appka zobrazí tento TBS a uživatel ho může
přehlédnout. V přímém PDF toku appka místní soubor má, ale neváže ho; v DocuSeal
toku nemá vůbec nic. Kontrola je tedy jen „co server ukázal“, ne „co uživatel chtěl“.

**Doporučení:**
- Server staví TBS **před** certifikátem s pevnou rezervou `/Contents`
  (`QES_SIGNATURE_RESERVE`, např. 64 KB) a uloží ho. `POST /certificate` už TBS
  nepřestavuje, jen nad ním vytvoří `signed_attrs_der`.
- `GET /document` povolit už v `awaiting_app`/`app_opened` a vrátit tento TBS.
- V přímém PDF toku appka spočítá SHA-256 místního souboru, server vrátí
  `source_sha256` z uloženého (normalizovaného) PDF a appka je porovná; při
  normalizaci rotace vrátí `normalized: true` a appka upozorní.
- V DocuSeal toku appka nemá originál; kontrola je lidská. Appka ale může
  zobrazit digest TBS a vázat ho na `completed.document_digest`.

#### K3 — Finální PDF se v appce neověřuje

**Důkaz:** `sign.tsx:298-318` stáhne finální PDF přes `PdfApi.documentUrl`
a `downloadPdf`, ale nepočítá jeho SHA-256, neporovnává `final_pdf_sha256`
(`types.ts:60-63`) ani nepřítomnost reviewed TBS. `sign.tsx:416-422` zobrazí jen
`done.digest` ze serveru.

**Dopad:** malicious nebo chybující server může vrátit jiné PDF; appka ho nabídne
jako „Podepsáno“ a uživatel ho stáhne/sdílí. Appka nemá žádný důkaz, že finální
PDF obsahuje to, co viděl.

**Doporučení:** po stažení finálního PDF:
1. spočítat SHA-256 a porovnat s `final_pdf_sha256` z `completed` payloadu;
2. ověřit, že prefix před `/Contents` a suffix za `/Contents` reviewed TBS jsou
   v finálním PDF beze změny (HexaPDF `embed_signature` zachovává offsety a doplňuje
   jen mezeru; DSS/pečeť/DocTS jsou až za TBS);
3. při neshodě zobrazit chybu a PDF nenabízet jako podepsané;
4. volitelně v další verzi ověřit CMS lokálně (`node-forge`) proti reviewed TBS.

#### K4 — `reviewOpened` je slabý gate, ne důkaz zobrazení

**Důkaz:** `sign.tsx:127-141` `openReview` nastaví `reviewOpened` hned po
`previewPdf`; `pdfShare.ts:244-269` zapíše soubor a zavolá `openPdf`;
`pdfShare.ts:165-180` na Androidu zavolá nativní `openPdf`; ten v
`SharePdfModule.kt` spustí `startActivity` a promise se vyřeší hned, ne po
návratu z prohlížeče. `sign.tsx:461` povolí „Podepsat“ po `reviewOpened`.

**Dopad:** uživatel může klepnout „Otevřít“ a hned „Podepsat“, aniž by prohlížeč
dokument vykreslil. Na iOS je „Otevřít“ share sheet (`pdfShare.ts:254-265`),
což není prohlížeč. Gate je tedy „byl spuštěn prohlížeč“, ne „uživatel viděl“.

**Doporučení:** neprezentovat to jako důkaz. Původně navržené AppState/checkbox
bylo **zamítnuto uživatelem (2026-10-27)**: `reviewOpened` zůstává tak, jak je,
kvůli riziku horšího UX. Gate tedy dál znamená „prohlížeč byl spuštěn“; appka
nemá tvrdit, že uživatel dokument skutečně četl.

#### K5 — `data_to_sign` se neověřuje proti certifikátu a času

**Důkaz:** `preparedDocument.ts:56-123` ověří `messageDigest` a `contentType`,
ale ne:
- `signingCertificateV2` (OID `1.2.840.113549.1.9.16.2.47`) — neověří, že
  atribut obsahuje hash certifikátu, který appka poslala;
- `signingTime` (OID `1.2.840.113549.1.9.5`) — neověří rozumný čas;
- `certificate_info` z `POST /certificate` (`types.ts:37-43`) — neporovná s místním
  certifikátem (subject, issuer, serial, platnost, level);
- `signature_algorithm` — neověří očekávaný algoritmus.

**Dopad:** server může vrátit `data_to_sign`, které tvrdí jiný certifikát nebo jiný
čas podpisu; appka to podepíše. Poctivý server to zachytí v `CmsBuilder.complete`
(`mobile_app.rb`), ale garance appky je slabší, než vypadá.

**Doporučení:** doplnit všechny čtyři kontroly. `signingCertificateV2` musí být
hash certifikátu, který appka poslala; `signingTime` v rozumném okně; `certificate_info`
musí odpovídat místnímu certifikátu; `signature_algorithm` očekávaný.

#### K6 — Session vyprší během kontroly

**Důkaz:** `qes_session.rb:70` `stale` = aktivní + `expires_at <= now`;
`Qes::ExpireSessionsJob` přepne všechny stale non-completed na `expired`;
`Qes::Config` `session_ttl: 600` (10 min); `GET /document` TTL neprodlužuje;
`sign.tsx` `expires_at` nezobrazuje.

**Dopad:** dlouhý dokument (smlouva, přílohy) se během kontroly přepne na
`expired`; `POST /complete` vrátí `410 expired_token`; uživatel už odemkl klíč
a podepsal, ale výsledek se zahodí. Musí začít znovu.

**Doporučení:** prodloužit TTL při `GET /document` a `POST /certificate`, nebo
oddělit `review_expires_at` a `sign_expires_at`; zobrazit zbývající čas; neexpirovat
`awaiting_signature`, dokud appka komunikuje.

#### K7 — `completed.document_digest` se neporovnává s reviewed digestem

**Důkaz:** `sign.tsx:212` a `:278` nastaví `done` z `payload.document_digest` /
`result.completed.document_digest`; `sign.tsx:422` ho zobrazí. Nikde se neporovná
s digestem reviewed TBS z `preparedDocument`.

**Dopad:** server může vrátit jiný digest; appka ho zobrazí jako digest podepsaného
dokumentu. Uživatel nemá jak poznat, že jde o jiný dokument.

**Doporučení:** uložit reviewed digest (`prepared.document_digest`), po `completed`
porovnat; při neshodě zobrazit chybu a PDF nenabízet jako podepsané.

### 4.2 Střední

#### K8 — Přímý PDF tok zakládá novou submission při každém pokusu

**Důkaz:** `sign-pdf.tsx:194-230` `place()` vždy volá `createSubmission` a
`startSession`; appka si submission nikam neuloží. Po `user_cancelled` nebo chybě
se z S12 znovu zakládá další submission.

**Dopad:** v DocuSealu vznikají duplicitní submissions; uživatel vidí víc dokumentů;
stará session zůstává `cancelled`/`expired`.

**Doporučení:** uložit `submitter`/`session` a při retry znovu použít; při
`409 signature_in_progress` nabídnout existující session (`id`, `state`) místo nové.

#### K9 — S12 „Podepsat“ nepodepisuje

**Důkaz:** `sign-pdf.tsx:194-230` pouze umístí pečeť, založí submission a session,
pak naviguje na S4. Vlastní podpis je až na S4.

**Dopad:** uživatel klepne „Podepsat“ a čeká podpis; místo toho se jen otevře další
obrazovka s dalším „Podepsat“. Dvě tlačítka „Podepsat“ s různým významem.

**Doporučení:** na S12 přejmenovat na „Pokračovat“ / „Umístit pečeť a pokračovat“;
„Podepsat“ nechat jen na S4.

#### K10 — `needs_reader` / `needs_qes_key` nevedou do wizardu

**Důkaz:** `signer.ts:20-47` vrací wizard s `needs_reader`/`needs_qes_key`;
`ceremony.ts:55-57` je vyhodí jako `CeremonyError`; `sign.tsx:145` `needsSetup`
obsahuje jen `no_signer`; `sign.tsx:468` zůstává „Zkontrolovat dokument“;
`ERROR_TEXT` tyto kódy nemá; `useFocusEffect` je nemaže.

**Dopad:** QES s klíčem v telefonu nebo s nepřipravenou čtečkou skončí chybou
a uživatel nemá cestu do S10/S8.

**Doporučení:** doplnit `needs_reader`/`needs_qes_key` do `needsSetup`,
`useFocusEffect` i `ERROR_TEXT`; primární akce „Nastavit podepisování“ → S10.

#### K11 — Chybí mapování serverových chyb

**Důkaz:** `sign.tsx` `ERROR_TEXT` nemá `signature_size_exceeded`,
`tsa_unavailable`, `ltv_unavailable`, `validation_failed`, `incomplete_coverage`,
`seal_failed`, `tsa_trust_not_configured`, `document_set_changed`,
`values_changed`, `signing_context_mismatch`, `completion_failed`,
`certificate_expired`, `unsupported_key`, `invalid_certificate`.

**Dopad:** uživatel vidí surový kód (`signature_size_exceeded`) místo vysvětlení
a další akce.

**Doporučení:** doplnit texty a akce (retry, import, kontakt podpory).

#### K12 — Chybí `202 / embedded` polling

**Důkaz:** `Qes::Providers::MobileApp#complete!` je dnes synchronní, ale SPEC § 5.3
připouští `202 { state: "embedded", poll_after_ms }`; `QesApi.postComplete`
čeká `completed`; `sign.tsx:278` hned nastaví `done`.

**Dopad:** až se server přepne na asynchronní TSA/LTV, appka spadne na
`done.level`/`document_digest` (undefined) nebo zobrazí neúplný stav.

**Doporučení:** obsloužit `202` smyčkou s maximem 30 s, zobrazit „Dokončuji na
serveru…“ a „Zkontrolovat znovu“; při `embedded` nepředávat `done`.

#### K13 — Chybí kontrola `X-QES-Protocol`

**Důkaz:** `QesApi` hlavičku posílá (`api.ts`), ale v odpovědi ji nekontroluje;
SPEC § 5.7 vyžaduje při neznámé verzi „Aktualizujte aplikaci“.

**Dopad:** appka může komunikovat s nekompatibilním serverem a chovat se
nepředvídatelně.

**Doporučení:** kontrolovat hlavičku ve všech QES odpovědích; při neznámé verzi
zobrazit chybu a podpis neprovádět.

#### K14 — Kontrola neukazuje certifikát, úroveň a digest

**Důkaz:** `sign.tsx` session blok zobrazuje jen `document_name`, `signer_name`,
`level_required`; `certificate_info` z `POST /certificate` se nepoužívá;
`certificateSummary` z vaultu je k dispozici, ale nezobrazuje se; `done` zobrazuje
jen `digest`.

**Dopad:** uživatel nevidí, kterým certifikátem a v jaké úrovni podepisuje;
SPEC S4 přitom říká „certifikát“.

**Doporučení:** v kontrolním stavu zobrazit subject, issuer, platnost, úroveň
a digest TBS; po podpisu totéž + `validation`, `seal_state`, `doc_timestamp_state`,
`final_pdf_sha256`.

### 4.3 Nízké a provozní

| # | Nález | Důkaz | Dopad |
|---|---|---|---|
| K15 | `certificateMatchesLevel` se u čtečky nevolá | `ceremony.ts:66-82` | čtečka s AdES certem pro QES → `level_mismatch`; čtečka bez QcSSCD pro QES → `qes_required_qscd`; jde odmítnout lokálně |
| K16 | `POST /certificate` neověří změnu hodnot před vytvořením `signed_attrs` | `mobile_app.rb:17-47` vs. `:165` | hodnoty se změní během kontroly; appka podepíše starý TBS, `complete!` vrátí `values_changed`; zbytečná signatura |
| K17 | `document_mismatch` má zavádějící text a není v SPEC § 5.4 | `sign.tsx:31`, `ceremony.ts:126` | uživatel neví, že jde o vnitřní konzistenci; server loguje neznámý kód |
| K18 | `isEncryptedPdf` se volá dvakrát | `preparedDocument.ts:66`, `:88` | zbytečná práce; zpomalení u velkých PDF |
| K19 | `/Contents` mezera se nekontroluje jako samé nuly | `preparedDocument.ts:80` | předvyplněná signatura projde jako „prázdná“; `embed_signature` ji přepíše, ale garance „nepodepsaný“ je slabší |
| K20 | `previewPdf` zakládá nový soubor při každé kontrole | `pdfShare.ts:244-252` | cache roste; žádné mazání |
| K21 | iOS „Otevřít“ je share sheet, ne prohlížeč | `pdfShare.ts:254-265` | uživatel nemusí PDF vidět; kontrola je slabší |
| K22 | `done` neukazuje validaci, pečeť, DocTS, finální hash ani „Ověřit PDF“ | `sign.tsx:416-422` | uživatel nevidí, zda je podpis důvěryhodný a platný |
| K23 | Sdílené PDF se při chybě uploadu ztratí | `sign-pdf.tsx:183-192` | parametry routy se vyčistí i při chybě; uživatel musí vybrat soubor znovu |
| K24 | Náhled stránky nemá `onError` | `sign-pdf.tsx:368` | prázdný náhled bez vysvětlení; pečeť nejde umístit |
| K25 | Po `user_cancelled` zůstane mrtvý token a text „Podpis už byl dokončen“ | `ceremony.ts:132`, `sign.tsx` `ERROR_TEXT.used_token` | uživatel si myslí, že podepsal; přitom zrušil |
| K26 | `errorDetail` zobrazuje surovou zprávu serveru | `sign.tsx:456` | možné vnitřní údaje; matoucí |
| K27 | `done.level.toUpperCase()` může spadnout | `sign.tsx:416` | `202`/neúplná odpověď → crash |
| K28 | `needsSetup` nezahrnuje `certificate_expired`/`not_trusted`/`revoked`/`unsupported_certificate`/`qes_required_qscd` | `sign.tsx:145` | uživatel nemá cestu k importu nového certu |
| K29 | Dokumentace odporuje kontrole | SPEC § 3 ř. 82 „appka NESMÍ dostat dokument v plném znění“; DESIGN § 12 ř. 567 „žádný náhled PDF“; docs/17 S4 kontrolu nezná; `GET /document` v SPEC § 5 není | audit nemůže ověřit zamýšlenou garanci |
| K30 | E2E harness kontrolu obchází | `scripts/qes-app-e2e.ts:84` `confirmDocument: async () => true` | pořadí `getDocument` → `postCertificate` → `unlock` → `sign` není testované |
| K31 | Serverové specy `GET /document` netestují | `spec/requests/qes_sessions_spec.rb` | regrese při přesunu TBS před cert |
| K32 | Chybí testy na `signingCertificateV2`/`signingTime`/`certificate_info`/finální PDF | `ceremony.test.ts`, `preparedDocument.test.ts` | regrese garancí |
| K33 | Chybí test `reviewOpened` a TTL během kontroly | `documentReview.test.ts` | regrese gate a expirace |

---

## 5. Cílový tok

Cílem není „méně kroků za každou cenu“, ale **kontrola před klíčem** a **kryptografická
vazba na to, co uživatel viděl**.

### 5.1 Pořadí

1. **S4 otevře metadata** (`GET /qes/sessions/:token`) — bez klíče, bez serverové
   přípravy podpisu.
2. **S4 stáhne nepodepsaný dokument** (`GET /qes/sessions/:token/document`) — TBS
   postavený **před** certifikátem s pevnou rezervou. Appka ho zobrazí.
3. **Uživatel zkontroluje** a potvrdí. Žádná biometrie, žádný `POST /certificate`.
4. **Appka odemkne klíč** (biometrie) nebo připojí čtečku a přečte certifikát.
5. **`POST /certificate`** — server ověří certifikát/řetěz/CRL a vytvoří
   `signed_attrs_der` **nad již uloženým TBS**. Vrátí `data_to_sign`, `byte_range`,
   `document_digest`, `certificate_info`.
6. **Appka ověří `data_to_sign`** proti reviewed TBS: `messageDigest`,
   `contentType`, `signingCertificateV2`, `signingTime`, `certificate_info`,
   `document_digest`, `signature_algorithm`. Při neshodě `POST /abort` a konec.
7. **Appka podepíše** `data_to_sign`, klíč ihned zahodí.
8. **`POST /complete`** — server vloží CMS do **stejného** TBS, přidá DSS, pečeť,
   DocTS, validuje.
9. **Appka ověří výsledek**: `completed.document_digest` = reviewed digest;
   `final_pdf_sha256` = SHA-256 staženého finálního PDF; reviewed TBS prefix/suffix
   je ve finálním PDF beze změny; `validation.intact/trusted/coverage` odpovídá.
10. **Appka nabídne** „Stáhnout“, „Sdílet“, „Ověřit PDF“ a zobrazí validaci.

### 5.2 Co je potřeba změnit

| Vrstva | Změna | Soubory |
|---|---|---|
| Server | TBS stavět před certifikátem s pevnou rezervou; `GET /document` povolit v `app_opened`; `POST /certificate` jen vytvoří `signed_attrs` nad uloženým TBS; `POST /certificate` ověří `qes_values` snapshot; `GET /document` prodlouží TTL | `app/controllers/qes/sessions_controller.rb`, `app/lib/qes/providers/mobile_app.rb`, `app/lib/qes/tbs_document.rb`, `app/lib/qes.rb` |
| Server | `POST /api/qes/documents` vrátí `source_sha256` (a `normalized`); `GET /document` vrátí `document_digest`; `completed` už ho vrací | `app/controllers/api/qes_documents_controller.rb`, `app/controllers/qes/sessions_controller.rb` |
| Server | `QesSession#stale` neexpiruje `awaiting_signature`, dokud appka komunikuje; nebo prodloužit `expires_at` | `app/models/qes_session.rb`, `app/jobs/qes/expire_sessions_job.rb` |
| Appka | Rozdělit `sign.tsx` na „Zobrazit dokument“ (jen `GET /document`) a „Podepsat“ (biometrie + `POST /certificate` + sign + `POST /complete`); kontrola před odemčením | `app/sign.tsx`, `src/lib/ceremony.ts` |
| Appka | Přidat `signingCertificateV2`, `signingTime`, `certificate_info`, `signature_algorithm`, `document_digest`; odstranit dvojí `isEncryptedPdf`; zkontrolovat `/Contents` nuly | `src/lib/preparedDocument.ts` |
| Appka | Po `completed` a po stažení finálního PDF ověřit `final_pdf_sha256`, reviewed prefix/suffix, `document_digest`; při neshodě chyba | `app/sign.tsx` |
| Appka | `needs_reader`/`needs_qes_key` do `needsSetup`/`useFocusEffect`/`ERROR_TEXT`; mapovat všechny serverové kódy; `202` polling; `X-QES-Protocol`; `expires_at` | `app/sign.tsx`, `src/lib/api.ts` |
| Appka | Přímý PDF: kontrola místního souboru před uploadem; `source_sha256`; reuse submission; `signature_in_progress`; `onError` náhledu; přejmenovat S12 „Podepsat“ | `app/sign-pdf.tsx`, `src/lib/pdfApi.ts` |
| Testy | E2E: `getDocument` před `postCertificate`, `unlock` až po potvrzení, `final_pdf_sha256` a reviewed bytes; fake server s jiným TBS → `document_mismatch`; server specy na `GET /document` a pořadí | `mobile/app/scripts/qes-app-e2e.ts`, `spec/requests/qes_sessions_spec.rb`, `mobile/app/__tests__/*` |
| Docs | SPEC § 3/§ 5/§ 9, DESIGN § 5.2/§ 12, docs/17 S4, docs/15 § 7 | `SPEC.md`, `DESIGN.md`, `docs/17-ui-hierarchie-akci.md`, `docs/15-primy-podpis-pdf.md` |

### 5.3 Co to neřeší

- **Nedokáže dokázat, že uživatel dokument skutečně četl.** Kontrola je lidská;
  appka může jen ukázat přesné bajty a vázat na ně signaturu.
- **Nedokáže ověřit, že dokument v DocuSealu je ten, který odesílatel zamýšlel.**
  Appka nemá originál; lidská kontrola je jediná obrana.
- **Nedokáže ověřit systémový PDF prohlížeč.** Appka zapíše přesné bajty a spustí
  prohlížeč; co prohlížeč zobrazí, appka nevidí.
- **Nedokáže ověřit TSA/CRL důvěryhodnost.** To zůstává na serveru.
- **Nedokáže plně ověřit CMS lokálně v v1.** Stačí hash + reviewed bytes;
  lokální CAdES verifikace je další verze.

---

## 6. Testovací plán

### 6.1 Appka (Jest)

- `ceremony.test.ts`: pořadí `getDocument` → `confirmDocument` → `unlock` →
  `postCertificate` → `sign` → `postComplete`; `unlock` nesmí být před `confirmDocument`;
  `postCertificate` nesmí být před `confirmDocument`.
- `ceremony.test.ts`: `signingCertificateV2` jiný cert → `document_mismatch`;
  `signingTime` mimo okno → `document_mismatch`; `certificate_info` jiný →
  `document_mismatch`; `signature_algorithm` jiný → `document_mismatch`.
- `ceremony.test.ts`: `completed.document_digest` jiný → chyba;
  `final_pdf_sha256` jiný → chyba; reviewed prefix/suffix jiný → chyba.
- `documentReview.test.ts`: `reviewOpened` se nastaví po spuštění prohlížeče
  (bez AppState/checkboxu dle rozhodnutí); „Podepsat“ je disabled do otevření;
  „Zrušit“ zavolá `postAbort('user_cancelled')`.
- `signScreen.test.ts`: `202` → polling; `embedded` → „Dokončuji na serveru…“;
  `X-QES-Protocol` jiný → chyba.
- `signPdf.test.ts`: `source_sha256` jiný → chyba; `signature_in_progress` →
  reuse; `onError` náhledu → chyba.

### 6.2 Server (RSpec)

- `GET /document` v `app_opened` → 200, TBS; v `awaiting_signature` → stejný TBS;
  po `POST /certificate` se TBS nemění.
- `POST /certificate` s jiným TBS → `signing_context_mismatch`.
- `POST /certificate` po změně hodnot → `values_changed`.
- `GET /document` prodlouží TTL; `ExpireSessionsJob` neexpiruje `awaiting_signature`
  během aktivity.
- `POST /complete` s jiným `document_digest` → chyba.

### 6.3 E2E

- `make qes-e2e`: appka stáhne TBS před `POST /certificate`, potvrdí, pak
  odemkne klíč; finální PDF ověří.
- `make qes-e2e-pdf`: místní soubor → kontrola → upload → `source_sha256` →
  TBS → kontrola → podpis → finální PDF ověření.
- Fake server, který vrátí jiný TBS → `document_mismatch`, žádná signatura.
- Fake server, který vrátí jiné finální PDF → chyba, PDF se nenabídne jako podepsané.

### 6.4 Manuálně

- Android emulátor: dokument > 10 min, kontrola, návrat, podpis; session neexpiruje.
- Android emulátor: zrušit kontrolu → `cancelled`, žádná biometrie, žádný `POST /certificate`.
- Android emulátor: otevřít PDF, ihned „Podepsat“ → gate se neobejde (checkbox/návrat).
- iOS: kontrola PDF, share sheet, potvrzení, podpis.
- Reálná čtečka: QES, QPIN až po kontrole; AdES cert na čtečce pro QES → lokální chyba.

---

## 7. Rozhodnutí k potvrzení

1. **Pevná rezerva `/Contents`**: `QES_SIGNATURE_RESERVE` (default 64 KB) místo
   závislosti na certifikátu. Tím se TBS dá postavit před certifikátem. **Hotovo.**
2. **Kontrola před klíčem**: „Zobrazit dokument“ bez biometrie a bez
   `POST /certificate`; „Podepsat“ až po potvrzení. **Hotovo.**
3. **Kontrola TBS, nebo base**: Kontrolovat TBS (přesné bajty, které se podepisují),
   nebo base před podpisovým polem? TBS je silnější a jednodušší. **Hotovo: TBS.**
4. **Gate**: `reviewOpened` po `startActivity` **zůstává** (rozhodnutí uživatele
   2026-10-27); checkbox/AppState se nezavádí kvůli horšímu UX. **Hotovo.**
5. **Finální PDF**: hash + reviewed prefix/suffix v v1; lokální CAdES verifikace
   v další verzi. **Hotovo: hash + prefix/suffix.**
6. **TTL**: prodloužit při `GET /document`/`POST /certificate` na 15 min, nebo
   oddělit review a sign TTL. **Hotovo: `review_ttl` 15 min, `session_ttl` 10 min.**

---

## 8. Závěr

Dnešní tok **není „kontrola, pak podpis“**. Je to **„odemkni klíč, připrav podpis na
serveru, ukaž TBS, potvrď, podepiš“**. Kryptografická vazba „signatura kryje
reviewed TBS“ funguje a je dobře testovaná. Chybí ale:
- kontrola **před** klíčem a **před** serverovou přípravou;
- vazba TBS na **originál** (místní PDF) nebo na dokument, který uživatel zamýšlel;
- ověření **finálního PDF**;
- důkaz, že uživatel dokument viděl;
- ošetření chyb, TTL a retry.

Cílový tok výše tyhle mezery zavírá bez bourání dobré části (`verifyPreparedDocument`).

---

## 9. Realizace (2026-10-27)

### 9.1 Server (fork)

- `Qes::Config`: `signature_reserve` 65 536 B, `review_ttl` 900 s.
- `Qes::Providers::MobileApp#prepare_document`: postaví TBS **před** certifikátem,
  uloží ho s `qes_values`, `qes_document_manifest`, `qes_base_digest` a `document_digest`.
- `Qes::SessionsController#document`: povolí `awaiting_app`/`app_opened`/`awaiting_signature`,
  postaví TBS při prvním volání a prodlouží `expires_at` na `review_ttl`.
- `Qes::SessionsController#certificate`: už TBS nepřestavuje, jen ověří certifikát/řetěz/CRL,
  zkontroluje `qes_values` snapshot (`values_changed`) a vytvoří `signed_attrs_der`; prodlouží TTL.
- `POST /api/qes/documents` vrací `source_sha256`, `document_sha256`, `normalized`.
- `Qes::Providers::MobileApp#data_to_sign` volá `prepare_document` (idempotentně) a
  `ensure_values_unchanged!`.

### 9.2 Appka

- `sign.tsx`: „Zobrazit dokument“ = jen `GET /document` + `previewPdf`; „Podepsat dokument“
  = `runSigningCeremony` s `reviewedDocument`/`reviewedDigest`; `reviewOpened` zůstává.
- `ceremony.ts`: `reviewedDocument` povinný, žádný `confirmDocument`; ověření
  `messageDigest`, `contentType`, `signingCertificateV2`, `signingTime`, `certificate_info`,
  `document_digest`, `signature_algorithm`; `202 embedded` polling; kontrola
  `completed.document_digest`.
- `preparedDocument.ts`: `documentDigest`, `sha256Hex`, `certificateIdentityFromPem`,
  prázdný `/Contents`, `signingCertificateV2`, `signingTime`, `certificate_info`.
- `pdfShare.ts`: `verifyFinalPdf` (SHA-256 finálního PDF + reviewed prefix/suffix),
  `readFileBytes`, `sha256File`; `PdfActionError('verification_failed')`.
- `sign-pdf.tsx`: místní kontrola PDF před uploadem, `source_sha256`, reuse submission
  (jiná pečet → cancel + nová submission), `signature_in_progress`, `onError` náhledu,
  S12 „Pokračovat“.
- `api.ts`: `X-QES-Protocol`, `202` polling, mapování nových chyb.
- `sign.tsx`: certifikát/platnost/otisk v kontrole, validace ve výsledku, `needs_reader`/
  `needs_qes_key` do wizardu, `canGoBack`, `verification_failed`.

### 9.3 Ověření

- `make qes-app-test` → **211/211**.
- `make qes-app-typecheck` → čisté.
- `make qes-test-qes` → **401/0**.
- `reviewOpened` zůstává po `startActivity` (rozhodnutí uživatele 2026-10-27).
