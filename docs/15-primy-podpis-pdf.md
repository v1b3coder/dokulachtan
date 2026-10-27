# 15 — Přímý podpis PDF (bez DocuSeal submission)

Status: **hotovo** (2026-10-18) — appka jede **standardní DocuSeal tok**; fork přidává jediný endpoint na
nahrání PDF. Ověřeno `make qes-test-qes` (88/0), `make qes-e2e-pdf` (2 signatury, pečeť v místě klepnutí),
`make qes-negative` (N1–N17), `make qes-e2e`/`make qes-e2e-two` beze změny a na emulátoru (výběr PDF →
náhled → klepnutí → podpis → stažení a sdílení) i **PDF ze share sheetu** (Android, štítek „Podepsat PDF“ →
S11 s vybraným souborem → rovnou upload). Navazuje na DESIGN.md § 1/§ 4/§ 7, SPEC.md § 4.8/§ 5.8/§ 9.9.

## 1. Use case

Zaměstnanec dostane PDF **mimo DocuSeal** (e-mailem, přes WhatsApp, stažené z portálu) a chce ho podepsat
**svým certifikátem z telefonu** — bez šablony, submissionu a submittera, které by zakládal ručně. PDF vybere
v appce, klepnutím umístí pečeť, podepíše (AdES klíčem, nebo QES čipem) a výsledek si stáhne a nasdílí.

**Klíč zůstává v zařízení.** Server dělá jen obal (TBS PDF, CMS, TSA, LTV, DSS, pečeť, validace) — stejný trust
model jako u QES obřadu pro DocuSeal submission (SPEC § 9).

## 2. Rozhodnutí

| # | Rozhodnutí | Důvod |
|---|---|---|
| D1 | **Nativní DocuSeal tok**: přímý podpis = **šablona** s polem `qes` + **submission** + dnešní obřad | minimum vlastního kódu; dokument je v účtu vidět jako každý jiný (Documents, složka „Direct signing“) |
| D2 | **Server vidí PDF, klíč nikdy** | stejný trust model jako dnes; PDF se nahrává na server (jako u každé šablony) |
| D3 | **Autentizace uploadu API tokenem** (`X-Auth-Token`) | nulový nový auth kód; token je per-user a revokovatelný |
| D4 | **Fork přidává jen `POST /api/qes/documents`** (upload PDF → šablona s polem `qes`) | jediná věc, kterou existující API neumí (API neumí vytvořit šablonu s dokumentem); zbytek je existující API |
| D5 | **Umístění pečeti = oblast pole `qes`** (`PATCH /api/templates/:id`) | pole už oblast má; kreslí ho `Qes::TbsDocument#draw_stamp` (pečeť s diakritikou) |
| D6 | **Náhled stránky generuje DocuSeal** (`preview_images` šablony, Pdfium) | appka nemá PDF renderer; souřadnice klepnutí sedí (normalizovaně 0–1 od shora) |
| D7 | **Úroveň volí appka** (`ades` default, `qes` se čtečkou) | server vynutí stejné kontroly jako dnes (`Qes::CertificateInfo`, `Qes::Validator.verify_chain!`, `Qes::Ltv.check_revoked!`) |
| D8 | **Výstup = finální PDF v DocuSealu** (Documents → Download / odkaz / sdílení) | uživatel ho vidí, může stáhnout, sdílet odkazem i smazat; nic se neuklízí vlastním kódem |
| D9 | **Obřad se spouští s API tokenem** (`POST /s/:slug/qes_sessions`) | appka nepotřebuje prohlížeč; slug je kapabilita (jako podpisový odkaz) |
| D10 | **Dokončení přes existující API** (`PUT /api/submitters/:id` s `completed: true`) | DocuSeal vygeneruje finální PDF i **auditní stránku**; žádný vlastní kód |
| D11 | **V1 jen nepodepsaná PDF bez šifrování**; rotace stránek se normalizuje při uploadu | DocuSeal staví výsledek znovu ze stránek, takže původní podpis by zmizel; u otočených stránek by pečeť seděla mimo |
| D12 | **Žádná nová ENV** — reuse `QES_ENABLED`, `QES_TSA_URL`, `QES_TRUST_ROOTS`, `QES_LTV_ALLOWED_HOSTS`, `QES_SESSION_TTL`; nově jen `QES_PDF_MAX_BYTES` (default 25 MB) | provozní konfigurace zůstává jedna |
| D13 | **Offline core (původní varianta A) mimo v1**, ale appka má rozhraní `SessionSource` | ceremoniál se nemění, jde doplnit později |

**Zamítnuto** (rozhodnutí uživatele 2026-10-18): vlastní tabulka `qes_pdf_sessions`, vlastní náhledy a vlastní
pipeline (`Qes::PdfSource`, `Qes::PagePreview`, `Api::QesPdfSessionsController`). Důvod: maximum vlastního kódu,
minimum užitku — dokument pak v DocuSealu není vidět a uživatel ho nemůže stáhnout ani smazat. Historie: § 10.

## 3. Tok

```
appka (S11/S12)                    fork (server)                        TSA / CRL
  │ POST /api/qes/documents ───────▶ ověří PDF, založí šablonu
  │   (multipart, X-Auth-Token)      ve složce „Direct signing“,
  │                                  pole `qes`, nahraje dokument
  │◀── template_id, field, pages ────│  (náhledy Pdfium + rozměry stránek)
  │ GET náhled stránky ─────────────▶ 200 PNG
  │◀──────────── PNG ──────────────│
  │ klepnutí → obrys pečeti          │
  │ PATCH /api/templates/:id ───────▶ oblast pole `qes` (umístění pečeti)
  │ POST /api/templates/:id/submissions ▶ submission + submitter (bez e-mailu)
  │ POST /s/:slug/qes_sessions ─────▶ TBS PDF s pečetí → token
  │◀── token + metadata ────────────│
  │ GET /qes/sessions/:token ───────▶ (dnešní obřad, beze změny)
  │ POST …/certificate → biometrie → podpis → …/complete
  │◀────────── state: completed ────│  CMS + TSA + LTV + pečeť + validace
  │ PUT /api/submitters/:id ────────▶ completed: true → finální PDF + audit
  │ GET /api/submitters/:id ────────▶ documents[].url
  │◀──────────── finální PDF ──────│
  │ share sheet / uložení            │
```

**Trust boundary:** PDF (obsah) jde na server — stejně jako dnes u každé šablony. Privátní klíč, biometrie a raw
signatura zůstávají v telefonu. Server nikdy nevidí klíč ani PIN/QPIN.

**Co se reuse beze změny:** celý QES obřad pro submission (`Qes::SessionsController`, `Qes::CmsBuilder`,
`Qes::Embed`, `Qes::Ltv`, `Qes::Dss`, `Qes::Validator`, `Qes::Seal`, `Qes::Token`,
`Qes::ExpireSessionsJob`, `Qes::Providers::MobileApp`) i DocuSeal šablony, submissions, náhledy, audit a úklid.

## 4. Patch forku (docs/15 § 5)

| Soubor | Změna | ~řádků |
|---|---|---|
| `app/controllers/api/qes_documents_controller.rb` | **nový**: upload PDF → šablona s polem `qes` | 120 |
| `app/lib/qes/pdf_source.rb` | **nový**: kontrola PDF + normalizace rotace | 60 |
| `spec/requests/qes_documents_spec.rb` | **nový**: request spec | 200 |
| `config/routes.rb` | `resources :qes_documents` (1 řádek) | 1 |
| `config/locales/i18n.yml` | hlášky (`invalid_pdf`, `encrypted_pdf`, `already_signed`, `file_too_large`, `invalid_level`) | 10 |
| `app/lib/qes.rb` | `pdf_max_bytes` (default 25 MB) | 1 |
| `lib/api_path_consider_json_middleware.rb` | multipart upload na `/api/qes/documents` | 2 |
| `app/controllers/qes/form_sessions_controller.rb` | spuštění obřadu s API tokenem (bez CSRF a prohlížečové session) | 13 |

Nic dalšího se nemění: `qes_sessions`, `qes` pole, kreslení pečeti (`Qes::TbsDocument#draw_stamp`), auditní stránka
i úklid dokumentů jsou upstream.

## LTV/LTA — co je a co není

- DSS obsahuje CRL a certifikáty **podepisujícího**; DocTS kryje DSS i pečeť.
- **TSA revokace se neověřuje** a v DSS nejsou certy TSA, pečeti ani DocTS.
- Offline ověření proto neslibuje úplné PAdES-LTA; UI a dokumentace mluví o LTV datech pro podepisujícího, ne o kvalifikovaném LTA.
- DigiCert TSA je free/AATL, **ne kvalifikované** časové razítko.

## 5. API kontrakty

### 5.1 `POST /api/qes/documents` — nahrání PDF (nový endpoint)

`multipart/form-data` s `file` (povinné), `display_name` (nepovinné), `level_required` (`ades` default / `qes`).
Server **MUSÍ**:
1. ověřit velikost (`QES_PDF_MAX_BYTES`) → `422 file_too_large`,
2. ověřit magic bytes a `content_type` → `422 invalid_pdf`,
3. odmítnout šifrovaná PDF (`422 encrypted_pdf`) a PDF s existující signaturou (`422 already_signed`),
4. normalizovat rotaci stránek (`Qes::PdfSource.normalize_rotation`),
5. založit šablonu ve složce **„Direct signing“** (jeden podepisující = jméno do pečeti, jedno pole `qes`
   s `preferences.level`, prázdné `areas`) a nahrát PDF jako dokument.

201:

```json
{
  "template_id": 12,
  "folder": "Direct signing",
  "submitter_role": "Jan Novák",
  "field": { "uuid": "…", "name": "Certificate signature", "type": "qes",
              "submitter_uuid": "…", "required": true,
              "preferences": { "level": "ades" }, "areas": [] },
  "document": { "uuid": "…", "filename": "smlouva.pdf",
    "pages": [{ "index": 0, "width": 595.28, "height": 841.89, "preview_url": "…" }] },
  "stamp": { "width": 150, "height": 44 }
}
```

Chyby: `401 not_authenticated`, `404 disabled`, `422 invalid_pdf`, `422 encrypted_pdf`, `422 already_signed`,
`422 file_too_large`, `422 invalid_level`, `429 rate_limited`.

### 5.2 Zbytek toku (existující API)

| Krok | Endpoint | Význam |
|---|---|---|
| umístění pečeti | `PATCH /api/templates/:id` | `fields: [{ …field, areas: [{x, y, w, h, page, attachment_uuid}] }]` |
| dokument k podpisu | `POST /api/templates/:id/submissions` | `send_email: false`, `submitters: [{role, name, email}]` |
| spuštění obřadu | `POST /s/:slug/qes_sessions` | `field_uuid` → `token` (API token místo session) |
| obřad | `GET /qes/sessions/:token`, `POST …/certificate`, `POST …/complete` | SPEC § 5.1–§ 5.4 |
| dokončení | `PUT /api/submitters/:id` | `completed: true` → PDF + auditní stránka |
| stažení | `GET /api/submitters/:id` | `documents[0].url` (platnost dle `FILE_URLS_EXPIRE_MINUTES`) |

## 6. Appka (Expo)

| Soubor | Obsah |
|---|---|
| `app/sign-pdf.tsx` | S11 (výběr PDF, jméno do pečeti, úroveň) + S12 (náhled, klepnutí, obrys, „Podepsat“) |
| `app/_layout.tsx` | sdílené PDF: `expo-share-intent` → routa `/sign-pdf` s parametrem souboru |
| `src/lib/shareIntent.ts` | PDF ze share intentu (`sharedPdfFile`), ostatní soubory ignoruje |
| `plugins/withSharePdfTarget.js` | config plugin: Android `activity-alias` „Podepsat PDF“ pro `ACTION_SEND` `application/pdf` |
| `src/lib/pdfApi.ts` | klient (`createDocument`, `setStampArea`, `createSubmission`, `startSession`, `completeSubmission`, `documentUrl`, `user`), `stampArea`, mapování klepnutí |
| `src/lib/pdfShare.ts` | stažení nativně do cache (`File.downloadFileAsync`), uložení do telefonu (`MediaStore` na Androidu 10+, SAF na starším Androidu, Files na iOS) a share sheet (vlastní modul na Androidu, `expo-sharing` na iOS) |
| `modules/dokulachtan-share` | Android: chooser na hlavním vlákně + `saveToDownloads` přes `MediaStore` (bez promise visící po zavření sheetu) |
| `app/sign.tsx` | S13: po obřadu dokončí submission a nabídne „Stáhnout“ (uložit do telefonu) a „Sdílet“ (share sheet) |
| `app/settings.tsx` | Server URL + API token (SecureStore) |
| `__tests__/pdfApi.test.ts` | Jest (upload, chyby, mapování souřadnic) |
| `__tests__/pdfShare.test.ts` | Jest (stažení, uložení, share sheet, fallback) |
| `__tests__/shareIntent.test.ts` | Jest (PDF ze share intentu, ignorování ne-PDF) |

**Mapování klepnutí (SPEC § 9.9):** server vrací `pages[].width/height` v bodech a `stamp` v bodech; appka
zobrazí náhled (`resizeMode: contain`) a zná zobrazený obdélník (`x0, y0, w, h`); `x = (tapX - x0) / w`,
`y = (tapY - y0) / h`; `stampArea` z toho udělá oblast pole (`x`, `y` = levý horní roh pečeti,
`w = stamp.width / page.width`, `h = stamp.height / page.height`, clamp na 0–1).

**iOS:** celý tok je cross-platform (upload `FormData` s `{uri, name, type}`, náhled `Image` s hlavičkou
`X-Auth-Token`, klepnutí z `nativeEvent.locationX/locationY`, sdílení s `UTI`); jediná platformová větev je skrytí
volby QES (čtečka eObčanky je Android-only, SPEC § 9.4). Build čeká na Apple Developer účet (EAS, `docs/10-qes.md`).

**Sdílení PDF (Android, SPEC § 9.9 krok 0):** v Android manifestu je `activity-alias` „**Podepsat PDF**“
(`plugins/withSharePdfTarget.js`) pro `ACTION_SEND` s `application/pdf`; `app/_layout.tsx` přes
`expo-share-intent` přijme soubor a otevře `/sign-pdf` s parametrem souboru. `app/sign-pdf.tsx` po načtení
nastavení a jména do pečeti **rovnou nahraje** sdílené PDF (bez ručního ukládání a hledání). Zdroj je v cache
appky (`file://`), takže se nic nekopíruje do Documents; iOS share extension není v rozsahu.

**Stažení, uložení a sdílení finálního PDF (docs/17):** finální PDF se stahuje nativně přes
`File.downloadFileAsync` přímo do cache — ne přes `arrayBuffer`/`FileReader` v JS (velké PDF s LTV, CRL a DocTS
tam dřív končilo jako „Chyba připojení“). Na Androidu 10+ jde „**Stáhnout**“ přes `MediaStore` do
`Download/Dokulachtan/` (root Downloadu nejde v SAF vybrat, Android 11+ ho zakazuje), na starším Androidu přes
SAF a na iOS přes výběr složky v aplikaci Soubory. „**Uložit jinam…**“ otevře SAF picker s naposledy použitou
složkou a vybranou složku si zapamatuje (SecureStore) — další „Stáhnout“ už jde přímo tam. Po uložení se nabídne
„**Otevřít**“ (Android `ACTION_VIEW` s `FLAG_GRANT_READ_URI_PERMISSION`). „**Sdílet**“ na Androidu otevírá vlastní
modul `DokulachtanShare` na hlavním vlákně a promise resolve hned po otevření sheetu; `expo-sharing` tam startuje
chooser z vlákna na pozadí, občas rejectuje NPE (`dispatchCancelPendingInputEvents`, expo/expo#51164) a jindy
nechá promise po zavření sheetu viset (tlačítko zůstalo mrtvé). Na iOS zůstává `expo-sharing`. Po návratu ze
sheetu se stav tlačítek resetuje (`AppState`), takže akce jde provést znovu.

## 7. Bezpečnost a soukromí

| Hrozba | Opatření |
|---|---|
| Únik PDF na server | přijato uživatelem; server vidí jen obsah, nikdy klíč (jako u každé šablony) |
| Zneužití API tokenu | token per-user a revokovatelný; rate limit; `QES_ENABLED`; limit velikosti |
| Cizí šablona | `PATCH`/`submissions` jdou přes `load_and_authorize_resource` (jiný účet → `403`) |
| Cizí obřad | slug je kapabilita (jako podpisový odkaz); `AuthorizedForForm` + kontrola pořadí |
| Šifrovaná / už podepsaná PDF | `422 encrypted_pdf` / `422 already_signed` (DocuSeal staví výsledek znovu ze stránek) |
| SSRF při LTV | reuse `QES_LTV_ALLOWED_HOSTS` (SPEC § 7.4) |
| Únik tokenu obřadu | jednorázový token, TTL 10 min, v DB jen sha256 (SPEC § 5) |

**Viditelnost a úklid:** dokument je běžný DocuSeal dokument — uživatel ho vidí v **Documents** (ve složce
„Direct signing“), může ho stáhnout, poslat odkazem, archivovat i smazat; DocuSeal k němu generuje auditní stránku.
Smazáním dokumentu v UI zmizí i PDF — žádný vlastní úklid QES nad PDF neexistuje.

## 8. Testy a verifikace

- **RSpec** `make qes-test-qes` (88/0): `spec/requests/qes_documents_spec.rb` — upload (201, šablona, pole, náhledy),
  chyby (401/422), spuštění obřadu s API tokenem; stávající QES specy zelené.
- **E2E** `make qes-e2e-pdf` (`scripts/qes_pdf_e2e.py`): upload → náhled → `PATCH` oblast → submission →
  spuštění obřadu → podpis **kódem appky** (`scripts/qes-app-e2e.ts`) → `PUT …/completed` → stažení →
  validace `pyhanko` (`INTACT:TRUSTED`, pokrytí celého dokumentu) + `pdfsig` + `qpdf`; ověří složku „Direct signing“,
  hodnotu pole `qes:<id>`, auditní stránku a pečeť v místě klepnutí (inkoust z Pdfium renderu).
  Report `test/out/qes-pdf-e2e-report.txt`.
- **Staging** `make qes-staging-e2e-pdf` (release v23+): stejný tok proti <https://dokulachtan.fly.dev>;
  API token se na konci smaže. Report `test/out/qes-pdf-staging-report.txt`.
- **Negativní** `make qes-negative` (N1–N17): N10 bez tokenu → `401`; N11 ne-PDF → `422 invalid_pdf`;
  N12 příliš velké → `422 file_too_large`; N13 šifrované → `422 encrypted_pdf`; N14 už podepsané → `422 already_signed`;
  N15 nepodporovaná úroveň → `422 invalid_level`; N16 cizí API token → `403`; N17 druhé spuštění obřadu zruší první.
- **Appka** `make qes-app-test` (92/0) + `make qes-app-typecheck`; na emulátoru (Pixel Imprint + biometrie,
  lokální fork + `adb reverse`): výběr PDF → náhled → klepnutí → podpis → stažení a sdílení.
- **Appka – uložení a sdílení** (2026-10-25): `__tests__/pdfShare.test.ts` (stažení do cache,
  uložení do telefonu, share sheet, fallback, zrušení); na emulátoru uloženo do
  `Download/Dokulachtan/`, share sheet otevřen a druhé sdílení i uložení po back funguje.
- **Appka – sdílení** (Android, docs/15 § 6): sdílené PDF → S11 s vybraným souborem → rovnou upload →
  S12; ověřeno na emulátoru (share sheet „Podepsat PDF“, cold start i běžící appka).

**Akceptační kritéria:** (1) `make qes-test-qes` zelené; (2) `make qes-e2e-pdf` zelené (2 signatury: appka +
pečeť, podpis appky `INTACT:TRUSTED` s pokrytím celého dokumentu, pečeť v místě klepnutí, dokument ve složce
„Direct signing“ s auditní stránkou); (3) `make qes-e2e` a `make qes-e2e-two` beze změny; (4) N10–N17 mají očekávané
výsledky; (5) appka na emulátoru projde celý tok.

## 9. Omezení v1 a další fáze

- **Náhledy jen pro prvních 15 stránek** (`Templates::ProcessDocument::MAX_NUMBER_OF_PAGES_PROCESSED`); pečeť na
  dalších stránkách by appka nemohla umístit (další fáze: vlastní náhled, nebo limit zvednout).
- **Jen nepodepsaná PDF bez šifrování** (D11). PDF s existující signaturou DocuSeal přestaví (původní podpis zmizí),
  proto ho endpoint odmítá.
- **Rotace stránek** se normalizuje při uploadu (jinak by pečeť na otočené stránce seděla mimo) — jediná vlastní logika
  nad rámec DocuSealu.
- **„Moje podpisy“** = běžný seznam Documents (složka „Direct signing“); vlastní sekce v appce (D13) je další fáze.
- **Offline core** (PDF nikdy neopustí telefon) je mimo v1; appka má `SessionSource`, takže jde doplnit bez změny obřadu.
- **Hromadné podepisování, push notifikace, counter-signature** (PDF už podepsané) další fáze.

## 10. Historie (2026-10-18)

První implementace (P8) jela **vlastní vrstvu**: tabulka `qes_pdf_sessions`, `Qes::PagePreview`, `Qes::PdfSource`,
`Qes::Stamp`, `Api::QesPdfSessionsController` (`create`/`preview`/`place`), `GET /qes/sessions/:token/download`
a generalizace pipeline (`signable`, `Seal.apply(reason:)`, `Token.find` ve dvou tabulkách). Fungovalo to a bylo ověřené,
ale dokumenty nebyly v DocuSealu vidět (ležely mimo šablony/submissiony) a uživatel je nemohl stáhnout, sdílet ani smazat.

**Uživatel rozhodl (2026-10-18)**: přepsat na nativní DocuSeal tok s minimem vlastního kódu. Celá vlastní vrstva byla
revertnuta (commity `Revert "…"`), zůstala jen nahrávací endpoint a API token pro spuštění obřadu. Bonus: dokument je
vidět v účtu, má auditní stránku a úklid (smazání, retence) je věcí DocuSealu.

**Nalezené chyby při přepisu:** `ApiPathConsiderJsonMiddleware` nutil JSON na `/api` (multipart upload),
`Qes::FormSessionsController` vyžadoval prohlížečovou session (CSRF + `AuthorizedForForm`), API neumí vytvořit šablonu
s dokumentem a DocuSeal needělá `/Rotate` (pečeť by seděla mimo) — proto 8 souborů v § 4.
