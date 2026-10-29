# SPEC.md — detailní specifikace dokulachtan (v1.5)

Datum: 2026-10-15
Revize: 2026-10-17 — vícenásobné digitální podpisy (firemní podpisy): § 4.6, § 7.1, § 7.6, § 7.7, § 15;
zapisuje do DESIGN.md (rozhodnutí #14) a ruší původní omezení „jen jeden podepisující“ z § 4.1.
Oprava 2026-10-17: stejná osoba může podepsat víc polí (§ 4.6 — vlastní session má přednost),
jinak se druhý podpis zahodil; přehled podpisu se v poli zobrazuje místo `qes:<id>` (§ 13, § 14).
Vychází z: [DESIGN.md](DESIGN.md) (aplikační design), [docs/04](docs/04-architektura-fork.md),
[docs/07](docs/07-pred-implementaci.md).

> **Závazný je [DESIGN.md](DESIGN.md)** (lidský koncept: co a proč). Tato specifikace je z něj
> odvozená a rozvádí ho do detailu (*jak přesně*: model, API, obrazovky, testy). Když si dokumenty
> odporovaly, byla to chyba — opravy jsou v § 16 a **DESIGN.md je už zapracovaný**.
> Řetěz je: **DESIGN (koncept) → SPEC (detailní specifikace) → implementace**.

Konvence: **MUSÍ** = povinné v v1, **MĚL BY** = doporučené, **NESMÍ** = zakázané.
`F1`–`F4` označují fáze z [docs/04](docs/04-architektura-fork.md) § 6.

---

## 1. Rozsah v1

### 1.1 V rozsahu

| # | Co | Poznámka |
|---|---|---|
| 1 | **Varianta B** — klíč z PKCS#12 v telefonu, AdES | hlavní produktová cesta |
| 2 | **Varianta A** — eObčanka přes BLE čtečku, QES | kompletní, včetně integrace MOI SDK |
| 3 | Server: pole `qes`, `QesSession`, API, joby, audit | ve forku DocuSealu |
| 4 | Expo appka: obrazovky S1–S9, úložiště klíče, biometrie | Android first, iOS později |
| 5 | Universal links + custom scheme fallback | vlastní doména pro produkční instanci |
| 6 | Pečeť DocuSealu inkrementálně **nad** podpisem appky | viz § 7.6 |
| 7 | Validace výsledku (Pdfium interně, pyHanko/pdfsig v testech) | viz § 15 |
| 8 | Audit: QES záznam v audit trail + vlastní data v DB | viz § 13 |
| 9 | **Více podepisujících** (firemní podpisy): řetězení PAdES revizí, každý signer vlastní `QesSession` | § 4.6, § 7.11 |

### 1.2 Mimo rozsah v1

Remote QTSP (varianta C), WebCrypto (B'), desktopový lokální agent, push notifikace,
hromadné podepisování více dokumentů jedním obřadem (multi-signer jednoho dokumentu je v rozsahu, § 4.6),
vlastní CA, ne-EU eID, vizuální vzhled podpisu (signature appearance), více aktivních
certifikátů v appce (import nahrazuje předchozí).

---

## 2. Pojmy

| Pojem | Význam |
|---|---|
| **AdES / QES** | úroveň podpisu; AdES = QcCompliance bez QcSSCD, QES = QcCompliance + QcSSCD |
| **QSCD** | kvalifikovaný prostředek pro vytváření podpisu (čip eObčanky); příznak je v certifikátu (`QcSSCD`) |
| **TBS PDF** | PDF připravené k podpisu: obsahuje podpisové pole s rezervovaným `/Contents` a `/ByteRange` |
| **Podepsané atributy** | DER `SET` atributů CMS `SignerInfo` (`content-type`, `message-digest`, `signing-time`, `signingCertificateV2`); **to, co appka podepisuje** |
| **Raw signatura** | RSA/ECDSA signatura nad podepsanými atributy; server ji vloží do `SignerInfo` |
| **MOI SDK** | oficiální *Podpisové SDK* MV ČR pro mobilní appky (Android AAR / iOS CocoaPods); umí `signData` na čipu eObčanky |
| **Čtečky (A)** | podporované BLE čtečky: ACR 3901 U-S1, bR301 BLE (černá), CT 1100; nově AirID 2 a USB OTG (Android) |
| **QPIN** | kód schvalující **kvalifikovaný** podpis na eObčance (PIN je pro ostatní operace s klíči) |

---

## 3. Architektura a hranice důvěry

```
┌──────────────────────────┐        ┌────────────────────────────────────┐
│ Expo appka (uživatel)     │        │ DocuSeal fork (server, Fly.io)      │
│                          │        │                                    │
│ PKCS#12 / eObčanka       │        │ TBS PDF, CMS, TSA, LTV, validace   │
│ privátní klíč ─ NIKDY ────┼───X────┤ privátní klíč NIKDY nevidí         │
│                          │        │                                    │
│ podepíše podepsané        │        │ vidí: certifikát, chain, podepsané   │
│ atributy (data_to_sign)    │        │ atributy, raw signaturu, veřejná data │
│                          │        │                                    │
│ token (jednorázový)       │◀──────▶│ token jen jako sha256 v DB           │
└──────────────────────────┘        └────────────────────────────────────┘
        │                                        ▲
        │ universal link / custom scheme          │
        └────────────────────────────────────────┘
```

**Server NESMÍ**: vidět privátní klíč, PIN/QPIN, obsah PKCS#12, ani dešifrovat cokoli z appky.
**Server MUSÍ**: ověřit, že raw signatura kryptograficky odpovídá certifikátu a podepsaným atributům.
**Appka MŮŽE**: dostat **nepodepsaný TBS** pro kontrolu uživatelem (`GET /document`) — PDF se tím
nevrací kvůli podpisu, ale kvůli tomu, aby uživatel viděl přesně ty bajty, které podepíše.
**Appka NESMÍ**: dostat dokument v plném znění *mimo* kontrolu; klíč se odemyká až po potvrzení
reviewed TBS a `data_to_sign` se ověřuje proti němu (§ 5.1a, § 9.3).

---

## 4. Datový model

### 4.1 Pole `qes` v šabloně

Pole typu `qes` je v `template.fields` JSON objekt:

```json
{
  "uuid": "…",
  "submitter_uuid": "…",
  "name": "Podpis zaměstnance",
  "type": "qes",
  "required": true,
  "readonly": false,
  "title": null,
  "description": null,
  "preferences": {
    "level": "ades",
    "with_signature_id": true
  },
  "areas": [{ "uuid": "…", "x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06,
              "attachment_uuid": "…", "page": 0 }]
}
```

| Klíč | Význam |
|---|---|
| `type` | vždy `"qes"` |
| `preferences.level` | `"ades"` (default) nebo `"qes"`; `qes` vyžaduje QcSSCD |
| `preferences.with_signature_id` | zapíše do audit trail ID dokumentu (stejně jako u `signature`) |
| `required` | chová se jako `signature`: bez hodnoty nelze formulář dokončit |
| `areas` | pozice jako u `signature`; používá se pro umístění podpisového pole v TBS PDF |

Chování:
- V **template builderu** se `qes` nabízí jako typ pole vedle `signature` (ikona `IconWritingSign`).
- V **template builderu** je u pole `qes` volba úrovně (`preferences.level`); **QES je do nasazení reálné
  čtečky viditelná, ale neaktivní**, takže z UI vznikají jen AdES pole (tok A/B, § 9.4).
- V **podpisovém formuláři** se místo kreslení zobrazí krok `QesStep` (§ 9).
- V **renderování výsledného PDF** se `qes` pole **nevykresluje** (žádný text ani obrázek);
  jeho hodnota je interní token.
- Pro ostatní submitters se pole `qes` nezobrazuje (jako prázdné `signature`).

**Pravidla pro více podepisujících (firemní podpisy, v1.5):** šablona s polem `qes` MUSÍ mít pole `qes`
u **každého** non-viewer submittera (`qes_all_signers_required`) a MUSÍ podepisovat **striktně po sobě**
(`qes_signing_order_required` a `qes_parallel_signers_not_allowed`). Uložení šablony MUSÍ selhat,
pokud:
- některý non-viewer submitter nemá pole `qes`,
- při >1 non-viewer submitterovi není `preferences['submitters_order'] == 'preserved'` ani nemá každý
  submitter vlastní `order`,
- dva non-viewer submitteři mají stejný `order` (paralelní skupina).

Kontrolu dělá validace na modelu `Template` (`validate :qes_signing_order`, § 7.7) — serverová validace
typů polí jinde v DocuSealu neexistuje, takže bez ní by uživatel dostal 500 místo chybové zprávy.
Pro podepisování platí: každý signer má právě jedno pole `qes` a právě jednu aktivní `QesSession`.

### 4.2 Tabulka `qes_sessions`

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigint PK | |
| `account_id` | bigint FK | |
| `submission_id` | bigint FK | |
| `submitter_id` | bigint FK | |
| `field_uuid` | string | uuid pole `qes` |
| `provider` | string | `mobile_app` (v1), `mock` (testy) |
| `state` | string | viz § 4.3 |
| `token_digest` | string | `sha256(token)`, unique index |
| `hash_algorithm` | string | `sha256` (default) |
| `signature_algorithm` | string | v1 jen `rsa_pkcs1v15` (HexaPDF 1.7 CMS umí jen RSA; ECDSA/RSA-PSS mimo v1) |
| `level` | string | `none`, `ades`, `qes` (určeno z certifikátu) |
| `key_location` | string | `phone_keystore`, `card` |
| `certificate_info` | text (JSON) | subject, issuer, serial, platnost, QCStatements, key type/size |
| `certificate_chain` | text (JSON) | pole base64 DER certifikátů řetězu |
| `signed_attrs_der` | binary | DER `SET` podepsaných atributů (co appka podepsala) |
| `signature` | binary | raw signatura |
| `document_digest` | string | hex SHA-256 přes ByteRange TBS PDF (počítá se při přijetí certifikátu, § 7.1) |
| `signed_pdf_sha256` | string | hex SHA-256 `signed_document` (**před** pečetí — artefakt pro kritérium UNTOUCHED) |
| `final_pdf_sha256` | string | hex SHA-256 `final_document` (s pečetí; = `signed_pdf_sha256`, pokud pečeť selhala) |
| `validation_report` | text (JSON) | výsledek validace (§ 7.5) |
| `seal_state` | string | `none`, `applied`, `failed` |
| `doc_timestamp_state` | string | `none`, `applied`, `failed` (DocTS, § 7.6) |
| `app_metadata` | text (JSON) | self-reported platforma a verze appky (whitelist, jen `android`/`ios` a `X.Y.Z`); jde do auditní stránky |
| `expires_at` | datetime | `created_at + QES_SESSION_TTL` |
| `prepared_at` | datetime | session připravena (TBS se staví až při přijetí certifikátu) |
| `app_opened_at` | datetime | appka si vyzvedla payload |
| `signed_at` | datetime | raw signatura přijata |
| `embedded_at` | datetime | CMS v PDF |
| `validated_at` | datetime | validace OK |
| `completed_at` | datetime | pole má hodnotu, submitter může dokončit |
| `failed_at` | datetime | |
| `failure_code` | string | viz § 5.6 |
| `failure_message` | string | bez citlivých dat |
| `created_at`, `updated_at` | datetime | |

ActiveStorage (na `QesSession`):
- `has_one_attached :tbs_document` — TBS PDF (obsahuje podpisové pole s rezervou),
- `has_one_attached :signed_document` — PDF s vloženým CMS appky (**před** pečetí; validuje se pro kritérium UNTOUCHED),
- `has_one_attached :final_document` — finální PDF s pečetí DocuSealu (artefakt, který jde do `documents`; při selhání pečeti = kopie `signed_document`).

Indexy: `token_digest` (unique), `[submitter_id, state]`, `[expires_at]`, `[submission_id]`.

Scopes: `active` (`created`…`embedded`), `completed` (`completed`), `failed` (`failed`, `expired`, `cancelled`, `declined`).

### 4.3 Stavový automat

```
created ──prepare──▶ prepared ──issue_token──▶ awaiting_app
   │                                             │
   │                                       app_opened
   │                                             │
   │                                     awaiting_signature
   │                                             │
   │                                        signed ──embed──▶ embedded
   │                                             │             │
   │                                             │       validated
   │                                             │             │
   │                                             │       completed
   │                                             │
   └──── expired / failed / cancelled / declined ◀─┘
```

| Z → Do | Trigger | Kdo | Zapisuje |
|---|---|---|---|
| `created` → `prepared` | session připravena (TBS se staví až při přijetí certifikátu) | server | `prepared_at` |
| `prepared` → `awaiting_app` | token + deep link | server | `token_digest`, `expires_at` |
| `awaiting_app` → `app_opened` | appka si vyzvedla payload | appka | `app_opened_at` |
| `app_opened` → `awaiting_signature` | certifikát přijat, TBS PDF (rezerva dle CRL) + CMS placeholder + signed attrs | appka | `certificate_info`, `level`, `key_location`, `signed_attrs_der`, `tbs_document`, `document_digest` |
| `awaiting_signature` → `signed` | raw signatura přijata a ověřena | appka | `signed_at`, `signature` |
| `signed` → `embedded` | CMS vloženo do TBS PDF | server | `embedded_at`, `signed_document`, `signed_pdf_sha256` |
| `embedded` → `validated` → `completed` | DSS + pečeť + DocTS + validace | server | `doc_timestamp_state`, `validation_report`, `completed_at` |
| `embedded` → `validated` → `completed` | validace OK | server | `validated_at`, `validation_report`, `completed_at` |
| `*` → `expired` | `expires_at < now` | job | `failure_code = "expired"` |
| `*` → `failed` | chyba | server/appka | `failed_at`, `failure_code` |
| `*` → `cancelled` | uživatel v prohlížeči | browser | |
| `*` → `declined` | standardní decline formuláře | signer | QesSession se zruší |

Pravidla:
- **MUSÍ** platit: `completed` je dosažitelné jen přes `validated` (nikdy ne přeskočit validaci).
- **NESMÍ** nastat `completed` bez `validation_report.ok == true` (obsahuje `intact`, `trusted` a plné pokrytí);
  `complete!` proto vyžaduje `report[:ok]`, ne jen `intact` (§ 7.5).
- **MUSÍ** platit: `token_digest` se **nevyhazuje** při přechodu do terminálního stavu (`completed`, `failed`,
  `cancelled`, `declined`, `expired`) — drží se po dobu retence session, aby fungovalo `410 used_token` (§ 5.6),
  idempotentní opakování `POST /complete` a obnova stavu appkou po chybě sítě (§ 7.10). Nuluje se až při
  úklidu/anonymizaci session po retenci, nikdy dřív než `expires_at`.
- **MUSÍ** platit: nejvýše **1 aktivní** session (`created`…`embedded`) na submittera; nové `POST` ji zruší (`cancelled`) a založí novou.
- **MUSÍ** platit: `certificate_info`, `level` a `key_location` se nastavují až v `awaiting_signature`;
  do té doby `NULL`.
- **NESMÍ** nastat `completed` bez `validation_report.ok == true`.

### 4.4 Hodnota pole a stav submittera

- Hodnota pole `qes`: `submitter.values[qes_uuid] = "qes:<session_id>"` (nastavuje server při `completed`).
- Stav pole v UI: `empty` → `pending` (session aktivní) → `signed` (hotovo) / `failed`.
- Submitter: `sent` → `opened` → `completed` (standardní DocuSeal); `qes` pole **MUSÍ** být vyplněné před `completed`, jinak `SubmitValues` vyhodí `RequiredFieldError`.
- Server **MUSÍ** ověřit i **formát** hodnoty: `values[qes_uuid]` smí být jen `"qes:<id>"`, session musí patřit
  témuž submitterovi a být `completed` (§ 7.7, `Qes::ValueValidator`). Bez toho by klient mohl poslat libovolný
  řetězec a obřad obejít (required pole by bylo „vyplněné“ bez podpisu) → `ValidationError`.

### 4.5 Kdy se hodnota zapisuje

1. `POST /s/:slug/qes_sessions` → session `created` (pole zůstává `empty`).
2. `POST /qes/sessions/:token/certificate` → session `awaiting_signature` (server má certifikát,
   `signed_attrs_der`, `data_to_sign`; pole stále `empty`).
3. `POST /qes/sessions/:token/complete` → server vloží CMS, přejde do `completed` a **v transakci** nastaví
   `submitter.values[qes_uuid] = "qes:<session_id>"` a uloží submittera.
4. Prohlížeč při pollingu dostane `value` a odešle formulář (`values[qes_uuid] = value`), takže
   standardní `Submitters::SubmitValues` projde (required pole je vyplněné) — formát hodnoty ale ověří
   `Qes::ValueValidator` (§ 4.4), takže podvržený řetězec neprojde.

### 4.6 Více podepisujících — řetězení revizí

- Pořadí je striktní: signer N+1 NESMÍ otevřít formulář ani vytvořit `QesSession` dřív, než je submitter N
  `completed` (gating v `SubmitFormController#show` + `Qes::FormSessionsController#create`).
- Stejný submitter **MŮŽE** mít víc polí `qes` (stejná osoba ve víc rolích): jeho další session se **MUSÍ** řetězit
  na jeho vlastní poslední dokončenou session (`QesSession.completed.where(submitter_id:)`), teprve když žádnou nemá,
  na finální PDF předchozího dokončeného submittera. Bez toho by se první podpis zahodil.
- `Qes::TbsDocument.build(submitter)` MUSÍ jako základ vzít **finální PDF posledního dokončeného**
  signera (`QesSession#final_document`) a otevřít ho přímo; NESMÍ dokument přestavovat ani importovat
  stránky (zahodilo by to předchozí podpisy). První signer použije dnešní stavbu z šablony.
- Hodnoty aktuálního signera a jeho viditelná pečeť se do základu dokreslí v **nové revizi**; podpisové
  pole a CMS se přidají inkrementálně (`pdf.sign`, HexaPDF zapisuje vždy inkrementálně).
- Každá předchozí signatura (podpis appky i pečeť) MUSÍ zůstat INTACT; poslední signatura MUSÍ pokrývat
  celý soubor.
- `documents` signera N = finální PDF revize N (před/po pečeti dle § 7.6); `combined_document` = poslední revize.
- Pro dokumenty složené z více příloh (`template_schema.size > 1`) MUSÍ být stránky mapované globálně
  (`page_offsets` dle metadat `pdf.number_of_pages`), aby se hodnoty a pečeť kreslily na správnou stránku.
- Všechny strany MUSÍ podepisovat certifikátem (pole `qes`); smíšené pořadí (kreslený podpis po QES) je mimo v1.5.

**Omezení v1.5:** pole `qes` je přípustné jen v šabloně, kde **každý** non-viewer submitter má pole `qes`
(žádné kreslené podpisy v QES šabloně). Ukládání šablony s kresleným podpisem vedle `qes` MUSÍ selhat
s `qes_all_signers_required`.

### 4.7 Datový model — `qes_sessions` a více signerů

Tabulka `qes_sessions` se **NEMĚNÍ** — každý signer má vlastní session s vlastním tokenem,
vlastním TBS i vlastními dokumenty. `QesSession#value_token` (`qes:<id>`) zůstává vázaný na konkrétní
session; `Qes::ValueValidator` ověří, že hodnota patří submitterovi a session je `completed`.

### 4.8 Přímý podpis PDF (bez submission)

Přímý podpis PDF (docs/15) **nezavádí vlastní tabulku ani model** — používá standardní DocuSeal tok:
appka nahraje PDF přes API (`POST /api/qes/documents`, § 5.8.1), tím vznikne **šablona** ve složce
„Direct signing“ s jedním podepisujícím a jedním polem typu `qes`. Umístění pečeti je oblast tohoto pole
(`PATCH /api/templates/:id`, § 5.8.2), dokument k podpisu je standardní **submission** (§ 5.8.3) a obřad je
dnešní QES obřad pro submission (§ 5.1–§ 5.4) — spouští ho appka s API tokenem.

Důsledky:

- **Nic nového v DB** — platí `templates`, `submissions`, `submitters`, `qes_sessions` beze změny.
- **Dokument je vidět v účtu** ve složce „Direct signing“ (Documents) jako běžný dokument: lze ho stáhnout,
  sdílet odkazem, archivovat i smazat; DocuSeal k němu generuje **auditní stránku** (`audit_trail`).
- **Výsledné PDF** = finální PDF QES session (pečeť appky + pečeť DocuSealu), viz `Qes::ResultAttachments`
  (§ 7.6); pole `qes` se do výsledku nekreslí (kreslí ho `Qes::Stamp.draw` do TBS).
- **Retence** je věcí DocuSealu (smazání dokumentu v UI smaže i PDF); žádný vlastní úklid QES nad PDF sessions.
- Patch forku je minimální: `Api::QesDocumentsController#create` (§ 5.8.1) a `Qes::PdfSource`
  (kontrola šifrovaných/už podepsaných PDF a normalizace rotace stránek).

---|---|
| `display_name` | jméno do pečeti (appka posílá default CN z vaultu) |
| `file_name` | původní název souboru (`document_name` v payloadu § 5.1) |
| `page_count`, `page_sizes` | počet a rozměry stránek v bodech (JSON) |
| `stamp` | `{page, x, y}` normalizovaně 0–1 (střed pečeti) |
| `original_document` | nahrané PDF (ActiveStorage) |
| `page_previews` | náhledy stránek (ActiveStorage, keš) |

Stavový automat, token i pipeline jsou shodné s § 4.3 a § 5; `Qes::SessionManager`, `Qes::CmsBuilder`,
`Qes::Embed`, `Qes::Ltv`, `Qes::Dss`, `Qes::Validator`, `Qes::Seal` a `Qes::RateLimiter` se používají
beze změny. Model **MUSÍ** implementovat rozhraní „signable“ (`document_name`, `signer_name`,
`level_required`, `seal_reason`, `after_complete`) jako `QesSession`; `Qes::Providers::MobileApp` je pak
zdroj-agnostický.

---

## 5. Protokol server ↔ appka

Základ: HTTPS, `Content-Type: application/json`, `Accept: application/json`.
Autentizace: jednorázový token v cestě. Token **NESMÍ** být logován; v DB jen `sha256` (`token_digest`).
Token: `SecureRandom.urlsafe_base64(32)` (43 znaků), TTL `QES_SESSION_TTL` (default 600 s), jednorázové použití.

Společná obálka chyby (HTTP 4xx/5xx):

```json
{ "error": "expired_token", "message": "Platnost odkazu vypršela. Vyžádejte nový." }
```

Rate limiting: **MUSÍ** být limit na IP a na token: max 60 požadavků / 5 min / IP a max 10 neúspěšných
pokusů o token / 5 min / IP (Rails.cache, bez nové závislosti). Překročení → `429 rate_limited`.
Testovací prostředí má `cache_store = :null_store` (`config/environments/test.rb`), proto musí
`config/environments/test.rb` pro QES testy použít `:memory_store` — jinak test na `429` nikdy neprojde.

Sémantika tokenu (platí pro § 5.1–§ 5.4):
- token se hledá podle `token_digest` (sha256) po celou dobu retence session,
- session v terminálním stavu (`completed`, `failed`, `cancelled`, `declined`) → `410 used_token`,
- `expires_at < now` nebo stav `expired` → `410 expired_token`,
- jinak se požadavek vykoná (stavové přechody dle § 4.3).

### 5.1 `GET /qes/sessions/:token` — payload pro appku

Server ověří token (existuje, neexpirovaný, ne v terminálním stavu), session přejde `awaiting_app → app_opened`
(pokud už není `app_opened`), zapíše `app_opened_at` (idempotentně). Odpověď vrací stav **po** přechodu
(`app_opened`); opakované volání je idempotentní a vrací stejný payload.

200:

```json
{
  "session_id": 42,
  "submitter_id": 7,
  "state": "app_opened",
  "provider": "mobile_app",
  "document_name": "Pracovní smlouva",
  "signer_name": "Jan Novák",
  "hash_algorithm": "sha256",
  "level_required": "ades",
  "requires_certificate": true,
  "server_url": "https://dokulachtan.fly.dev",
  "expires_at": "2026-10-15T10:30:00Z"
}
```

Pozn.: `server_url` je adresa **konkrétní instance** (zde instance uživatele), ne centrální server;
v každém nasazení se mění. Appka se řídí originem odkazu a TOFU (§ 8.1), ne pevně zapsanou adresou.

Chyby: `404 unknown_token`, `410 expired_token`, `410 used_token`, `409 session_not_active`.

### 5.1a `GET /qes/sessions/:token/document` — nepodepsaný TBS pro kontrolu

Server **MUSÍ** vrátit **nepodepsaný TBS** (PDF s prázdnou rezervou `/Contents`) **před** přijetím
certifikátu, aby appka mohla uživateli zobrazit přesně ty bajty, které se budou podepisovat. TBS se staví
při prvním volání (nebo při vytvoření session) s pevnou rezervou `QES_SIGNATURE_RESERVE` (default 64 KB),
nezávislou na certifikátu; `POST /certificate` už TBS **NEPŘESTAVUJE**.

- Stav: `awaiting_app`, `app_opened`, `awaiting_signature`.
- Odpověď: `application/pdf` (`Cache-Control: no-store`), hlavička `X-QES-Protocol: 1`.
- `GET /document` **MUSÍ** prodloužit `expires_at` na `review_ttl` (default 15 min), aby dlouhá kontrola
  neprošla expirací.
- `POST /certificate` **MUSÍ** ověřit, že se hodnoty pole od přípravy TBS nezměnily (`values_changed`).
- Chyby: `404 unknown_token`, `410 expired_token`, `410 used_token`, `409 wrong_state`,
  `409 document_missing`, `422 values_changed`.

### 5.2 `POST /qes/sessions/:token/certificate` — certifikát a podepsané atributy

Request:

```json
{
  "certificate": "<base64 DER X.509>",
  "chain": ["<base64 DER>", "…"],
  "key_location": "phone_keystore",
  "app": { "platform": "android", "version": "1.3.9" }
}
```

Server **MUSÍ** ověřit:
1. certifikát je X.509, podpisové klíče (`keyUsage.digitalSignature`), platný (`not_before ≤ now ≤ not_after`),
2. certifikát vede řetězem (`chain`) k některému z `QES_TRUST_ROOTS` (i s intermediate CA); jinak
   `422 not_trusted` — bez toho by šel jako QES zapsat i self-signed certifikát s podvrženými QCStatements,
3. `key_location == "card"` → certifikát **MUSÍ** mít `QcSSCD`; `key_location == "phone_keystore"` → certifikát
   **NESMÍ** tvrdit `QcSSCD` (jinak `422 level_mismatch`),
4. `level_required == "qes"` → certifikát **MUSÍ** mít `QcSSCD` (jinak `422 qes_required_qscd`),
5. `level_required == "ades"` → stačí `QcCompliance` (bez něj `422 not_qualified`).

Odmítnutý certifikát **NEMĚNÍ** stav session (zůstává `app_opened`, uživatel může poslat jiný certifikát);
do session se zapíše jen `failure_code` pro diagnostiku. Volání je přípustné z `awaiting_app` i `app_opened`
(appka nemusí před `POST /certificate` volat `GET`; server v takovém případě doplní `app_opened_at`).

Server ověří certifikát a řetěz, ale **TBS už je uložený** z § 5.1a; `POST /certificate` nad ním
jen vytvoří `signed_attrs_der`, uloží ho a vrátí 200. Přechod `app_opened → awaiting_signature`;
opakované volání se stejným certifikátem je idempotentní (vrátí stejné `data_to_sign`).

```json
{
  "data_to_sign": "<base64 DER SET podepsaných atributů>",
  "hash_algorithm": "sha256",
  "digest_algorithm_oid": "2.16.840.1.101.3.4.2.1",
  "signature_algorithm": "rsa_pkcs1v15",
  "expires_at": "2026-10-15T10:30:00Z",
  "certificate_info": {
    "subject": "CN=Jan Novák, …",
    "issuer": "CN=I.CA …",
    "serial": "0x…",
    "not_before": "2025-01-01T00:00:00Z",
    "not_after": "2027-01-01T00:00:00Z",
    "level": "ades",
    "qc_statements": ["QcCompliance"],
    "key_type": "rsa",
    "key_size": 2048
  }
}
```

Idempotence: opakované volání se stejným certifikátem vrátí stejné `data_to_sign` (uložené `signed_attrs_der`).

Chyby: `404 unknown_token`, `410 expired_token`, `422 invalid_certificate`, `422 certificate_expired`,
`422 unsupported_key`, `422 level_mismatch`, `422 qes_required_qscd`, `422 not_qualified`, `409 wrong_state`.

### 5.3 `POST /qes/sessions/:token/complete` — raw signatura

Request:

```json
{ "signature": "<base64 raw RSA/ECDSA signatura>" }
```

Server **MUSÍ**:
1. ověřit `signature` proti `certificate.public_key` a `signed_attrs_der`
   (`OpenSSL::PKey#verify` s `SHA256`; ECDSA raw r||s),
2. sestavit finální CMS (raw signatura do `SignerInfo`, TSA token do unsigned attrs; LTV jde do DSS, § 7.4),
3. vložit CMS do TBS PDF (`HexaPDF::DigitalSignature::Signing.embed_signature`),
4. validovat výsledek (§ 7.5), uložit `signed_document` a pečeť (§ 7.6) do `final_document`,
5. přejít do `completed` a nastavit hodnotu pole (§ 4.5).

200:

```json
{
  "state": "completed",
  "submitter_id": 7,
  "level": "qes",
  "document_digest": "<hex SHA-256 ByteRange>",
  "signed_pdf_sha256": "<hex>",
  "validation": { "intact": true, "trusted": true, "trusted_roots": ["I.CA …"] },
  "completed_at": "2026-10-15T10:05:00Z"
}
```

Pokud TSA/LTV/pečeť ještě běží (typicky u A s TSA), server vrátí **202** a appka (i prohlížeč) dál
polluje `GET /qes/sessions/:token` (appka) resp. `GET /s/:slug/qes_sessions/:id` (prohlížeč):

```json
{ "state": "embedded", "poll_after_ms": 1000 }
```

Appka **MUSÍ** pollovat max. 30 s, pak zobrazí „Dokončuji na serveru…" s tlačítkem „Zkontrolovat znovu"
(session se dokončí i bez appky — výsledek je v DocuSealu).

Chyby: `409 wrong_state`, `410 expired_token`, `422 signature_invalid`, `422 signature_size`,
`410 form_not_active` (submission byla během obřadu archivována nebo vypršela; podpis se do PDF nevloží).

### 5.3.1 `POST /qes/sessions/:token/complete_submission` — dokončení submissionu

Po `completed` session appka **MUSÍ** dokončit submission přes tento endpoint, ne přes
`PUT /api/submitters/:id` s plným API tokenem účtu. Server dokončí **jen submittera vázaného
na session token**; `submitter` z deep linku se ignoruje. Endpoint je idempotentní a vrací
`{ "state": "completed", "submitter_id": 7, "completed": true }`.
Dokončený token platí 24 h po `completed_at`, pak `410 expired_token` (§ 5.1).

**Stav submissionu.** `complete`, `complete_submission` i `POST /s/:slug/qes_sessions` odmítnou
submission, která je archivovaná (submission nebo šablona) nebo jejíž `expire_at` už prošel:
`410 form_not_active`. Session token je kapabilita a nesmí přežít smrt dokumentu — jinak podepisující
dokončí smlouvu, kterou odesílatel zrušil. Podmínky jsou stejné jako v upstream
`SubmitFormController#update`. Guard v `complete` je před modifikací PDF, takže archivace během
obřadu nevyrobí podepsanou revizi, kterou už nikdo nedokončí.

### 5.4 `POST /qes/sessions/:token/abort` — chyba na straně appky

Request: `{ "code": "user_cancelled", "message": "…" }` (`code` ∈ `user_cancelled`, `reader_error`,
`pin_blocked`, `token_expired`, `network`, `unsupported_certificate`).
Server nastaví `cancelled` (u `reader_error`/`pin_blocked`/`network`/`unsupported_certificate`
na `failed`), 200 `{ "state": "cancelled" }` nebo `{ "state": "failed" }`.
`token_expired` → `failed` s `failure_code = "expired"`; ostatní `failed` kódy → `failure_code = "cancelled"`
(interní kódy dle § 5.6).

### 5.5 Sekvence volání (varianta B i A)

```
App                                   Server
 │ GET /qes/sessions/:token             │
 │─────────────────────────────────────▶│  200 payload (metadata, requires_certificate)
 │ POST /qes/sessions/:token/certificate │
 │─────────────────────────────────────▶│  CMS placeholder → signed_attrs
 │◀─────────── data_to_sign ────────────│
 │  biometrie / QPIN → sign             │
 │ POST /qes/sessions/:token/complete    │
 │────────────── raw sig ───────────────▶│  verify → CMS → embed → TSA → LTV
 │                                      │  validate → completed → hodnota pole
 │◀────────── state: completed ──────────│
```

### 5.6 Kódy chyb (server → appka)

| HTTP | `error` | Význam | Chování appky |
|---|---|---|---|
| 404 | `unknown_token` | token neexistuje | „Vyžádejte nový odkaz" |
| 410 | `expired_token` | TTL vypršel | totéž |
| 410 | `used_token` | token už byl použit | „Podpis už byl dokončen" |
| 410 | `expired_token` | dokončený token po 24 h | „Vyžádejte nový odkaz" |
| 410 | `form_not_active` | submission archivována / vypršela | „Dokument už není aktivní, požádejte nový" |
| 409 | `wrong_state` | operace neodpovídá stavu | znovu načíst payload |
| 422 | `invalid_certificate` | cert nejde načíst / chybí klíč | „Zkontrolujte certifikát" |
| 422 | `certificate_expired` | mimo platnost | „Certifikát vypršel" |
| 422 | `unsupported_key` | jiný algoritmus než RSA/ECDSA | „Nepodporovaný klíč" |
| 422 | `level_mismatch` | QcSSCD u klíče v telefonu | „Vyberte certifikát z karty" |
| 422 | `qes_required_qscd` | pole vyžaduje QES, cert bez QcSSCD | „Vyžaduje se kvalifikovaný certifikát" |
| 422 | `signature_invalid` | signatura neodpovídá | retry podpisu |
| 422 | `completion_failed` | submission po podpisu nejde dokončit | znovu načíst stav |
| 422 | `signing_context_mismatch` | podepsané atributy fáze 2 se liší od fáze 1 | znovu načíst stav |
| 422 | `not_trusted` | certifikát nevede řetězem k trust rootu | „Použijte kvalifikovaný certifikát (I.CA/PostSignum)" |
| 422 | `revoked` | certifikát je v CRL revokovaný | „Certifikát byl revokován" |
| 429 | `rate_limited` | příliš pokusů | zpožděný retry |
| 500 | `server_error` | chyba serveru | retry s backoffem |

Interní `failure_code` (zapisují se do `QesSession` a objevují se v pollingu § 6.2):

| `failure_code` | Význam |
|---|---|
| `prepare_failed` | TBS PDF / CMS placeholder se nepodařilo vytvořit |
| `signature_invalid` | raw signatura neodpovídá certifikátu a `signed_attrs_der` |
| `signing_context_mismatch` | podepsané atributy fáze 2 se liší od fáze 1 |
| `signature_size_exceeded` | finální CMS se nevejde do rezervy `/Contents` |
| `tsa_unavailable` | TSA nedostupné a `QES_TSA_REQUIRED=true` |
| `ltv_unavailable` | OCSP/CRL nedostupné a `QES_REQUIRE_LTV=true` |
| `validation_failed` | validace finálního PDF selhala |
| `incomplete_coverage` | podpis nepokrývá celý dokument |
| `expired` | `expires_at` vypršelo |
| `cancelled` | uživatel zrušil obřad |

### 5.7 Verzování

**MUSÍ** být hlavička `X-QES-Protocol: 1` v odpovědích; appka při neznámé verzi zobrazí
„Aktualizujte aplikaci". Změny kontraktu jen s novou verzí protokolu.

### 5.8 Přímý podpis PDF — API pro appku (bez submission)

Přímý podpis PDF je **standardní DocuSeal tok** řízený appkou; fork přidává jediný endpoint na nahrání PDF.
Zbytek jde přes existující API (§ 6.1, § 7.6) a existující endpoint podpisového formuláře (§ 6.6).

#### 5.8.1 `POST /api/qes/documents` — nahrání PDF (nový endpoint forku)

Request: `multipart/form-data` s `file` (povinné), `display_name` (nepovinné), `level_required`
(`ades` default / `qes`; jiná hodnota → `422 invalid_level`). Autentizace `X-Auth-Token`
(`Api::ApiBaseController#current_user`). Server **MUSÍ**:
1. ověřit velikost (`QES_PDF_MAX_BYTES`, default 25 MB) → `422 file_too_large`,
2. ověřit magic bytes `%PDF-` a `content_type: application/pdf` → `422 invalid_pdf`,
3. odmítnout šifrovaná PDF (`422 encrypted_pdf`) a PDF s existující signaturou (`422 already_signed`) —
   DocuSeal staví výsledek znovu ze stránek, takže by původní podpis zmizel,
4. normalizovat rotaci stránek (`Qes::PdfSource.normalize_rotation`),
5. založit **šablonu** (`Template`) ve složce „Direct signing“ s jedním podepisujícím (role = jméno do pečeti)
   a jedním polem typu `qes` (`preferences.level = level_required`, prázdné `areas`) a nahrát PDF jako její dokument,
6. vrátit `201` s `template_id`, definicí pole, stránkami s náhledy a velikostí pečeti v bodech.

201: `{ "template_id": 12, "folder": "Direct signing", "submitter_role": "Jan Novák",
"field": { "uuid": "…", "type": "qes", "preferences": { "level": "ades" }, "areas": [] },
"document": { "uuid": "…", "filename": "smlouva.pdf",
"pages": [{ "index": 0, "width": 595.28, "height": 841.89, "preview_url": "…" }] },
"stamp": { "width": 150, "height": 44 } }`

Chyby: `401 not_authenticated`, `404 disabled`, `422 invalid_pdf`, `422 encrypted_pdf`,
`422 already_signed`, `422 file_too_large`, `422 invalid_level`, `429 rate_limited`.

#### 5.8.2 `PATCH /api/templates/:id` — umístění pečeti (existující API)

Appka pošle `fields: [{ …field, areas: [{x, y, w, h, page, attachment_uuid}] }]` — oblast pole
v normalizovaných souřadnicích 0–1 **od shora** (jako u běžných polí DocuSealu). Server kreslí pečeť
QES přesně do této oblasti (`Qes::Stamp.draw`, § 7.1); appka clampuje klepnutí do stránky.

#### 5.8.3 `POST /api/templates/:id/submissions` — dokument k podpisu (existující API)

`{ "send_email": false, "submitters": [{ "role": "<role šablony>", "name": "Jan Novák",
"email": "…" }] }` → vrátí submittera se `slug` a `id`. E-mail se neposílá (podepisuje sám uživatel).

#### 5.8.4 Spuštění obřadu (existující endpoint, § 6.6)

`POST /s/:slug/qes_sessions` s `{ "field_uuid": "…" }` → `201` s `token`, `universal_link` a `custom_scheme_link` (QR s custom scheme).
Appka tento endpoint volá s **API tokenem** místo prohlížečové session; token je kapabilita (jako podpisový
odkaz), CSRF kontrola se u něj přeskakuje. Dál je tok shodný s § 5.1–§ 5.4 (`GET /qes/sessions/:token`,
`POST …/certificate`, `POST …/complete`).

#### 5.8.5 Dokončení a stažení

1. `POST /qes/sessions/:token/complete_submission` (§ 5.3.1) → DocuSeal označí submittera jako dokončeného,
   vygeneruje výsledné PDF (`Qes::ResultAttachments` → finální PDF QES session, § 7.6) a **auditní stránku**.
   Endpoint je vázaný na session token; `PUT /api/submitters/:id` s plným API tokenem účtu se
   pro dokončení nepoužívá (S1).
2. `GET /api/submitters/:id` → `documents[0].url` (podepsaná URL s platností dle `FILE_URLS_EXPIRE_MINUTES`)
   → appka PDF stáhne a předá systémovému share sheetu.

#### 5.8.6 Sekvence volání

```
App (S11/S12)                        Server
 │ POST /api/qes/documents            │  201 {template_id, field, pages, stamp}
 │ GET náhled stránky (URL)           │  200 PNG
 │ PATCH /api/templates/:id            │  pole `qes` s oblastí (klepnutí)
 │ POST /api/templates/:id/submissions │  submitter (slug)
 │ POST /s/:slug/qes_sessions         │  token (X-Auth-Token)
 │ GET /qes/sessions/:token           │  200 payload
 │ POST …/certificate → sign → …/complete │  CMS + TSA + LTV + pečeť + validace
 │ POST …/complete_submission         │  PDF + auditní stránka (session token)
 │ GET /api/submitters/:id → documents │  finální PDF
```

---

## 6. API pro prohlížeč (podpisový formulář)

### 6.1 `POST /s/:submit_form_slug/qes_sessions`

Autorizace: `Submitters::AuthorizedForForm.call(submitter, current_user, request)` (jako ostatní `/s/:slug` endpointy).

Request: `{ "field_uuid": "…", "provider": "mobile_app" }`

201:

```json
{
  "id": 42,
  "state": "awaiting_app",
  "token": "<jednorázový token, jen v této odpovědi>",
  "universal_link": "https://dokulachtan.fly.dev/qes/sign?token=…",
  "fallback_url": "https://dokulachtan.fly.dev/qes/app?token=…",
  "custom_scheme_link": "dokulachtan://sign?token=…&server=https%3A%2F%2Fdokulachtan.fly.dev",
  "expires_at": "2026-10-15T10:30:00Z",
  "poll_interval_ms": 2000
}
```

Pozn.: `universal_link`, `fallback_url` i `server` v `custom_scheme_link` nesou adresu **konkrétní instance**
(zde instance uživatele), ne centrální server; v každém nasazení se mění.

Pravidla: existující aktivní session se zruší a založí nová; odpověď **NESMÍ** obsahovat token
při žádném dalším volání (jen digest v DB); `field_uuid` **MUSÍ** patřit submitterovi a být typu `qes`.
`universal_link` míří na `/qes/sign` (App Links / Universal Links, § 10.1), `fallback_url` na
web fallback `/qes/app` (§ 6.4); `custom_scheme_link` je `dokulachtan://sign?token=…&server=<origin>`.

### 6.2 `GET /s/:submit_form_slug/qes_sessions/:id` — polling

200:

```json
{
  "id": 42,
  "state": "awaiting_app",
  "value": null,
  "error": null,
  "completed": false
}
```

Při `completed`: `{ "state": "completed", "value": "qes:42", "completed": true }`.
Při `failed`: `{ "state": "failed", "error": { "code": "signature_invalid", "message": "…" } }`.

### 6.3 `POST /s/:submit_form_slug/qes_sessions/:id/cancel`

Uživatel zruší obřad v prohlížeči → `cancelled`, token přestane platit, 200 `{ "state": "cancelled" }`.

### 6.4 `GET /qes/app?token=…` — web fallback

Veřejná HTML stránka (bez autorizace): zobrazí název dokumentu, jméno podepisujícího, platnost
odkazu, tlačítko „Otevřít aplikaci" (custom scheme), QR kód (custom scheme), odkazy na stažení
appky (APK / App Store). **NESMÍ** zobrazit `data_to_sign` ani jiné citlivé údaje.

### 6.5 `QesStep` — chování kroku v prohlížeči

Komponenta `app/javascript/submission_form/qes_step.vue` (registrovaná ve `form.vue` vedle `SignatureStep`).

**Fáze komponenty:** `idle → creating → awaiting_app → completed | failed | expired | cancelled`.

| Fáze | UI | Akce |
|---|---|---|
| `idle` | název pole, vysvětlení („Podepíše se vaším certifikátem v aplikaci. Klíč zůstává ve vašem zařízení."), tlačítko **„Podepsat certifikátem“** | `POST /s/:slug/qes_sessions` |
| `creating` | spinner, tlačítko zakázané | — |
| `awaiting_app` | QR kód (custom scheme `dokulachtan://sign`), tlačítko **„Otevřít aplikaci“** (custom scheme), odkaz na web fallback (`fallback_url`), odpočet do `expires_at`, tlačítko **„Zrušit“** | polling `GET /s/:slug/qes_sessions/:id` každých `poll_interval_ms` |
| `completed` | „Podepsáno“ + úroveň (AdES/QES) + čas | nastaví `values[field.uuid] = value`, zavolá `submitStep()` (auto-submit) |
| `failed` | chybová zpráva dle `error.code` (§ 5.6) | **„Zkusit znovu“** (nová session), **„Zrušit“** |
| `expired` | „Platnost odkazu vypršela“ | **„Vyžádat nový odkaz“** (nová session) |
| `cancelled` | „Podepisování bylo zrušeno“ | **„Zkusit znovu“** |

Pravidla:
- Krok **MUSÍ** být posledním krokem formuláře; tlačítko „Dokončit“ je zakázané, dokud není `completed`
  (server by jinak vrátil `RequiredFieldError`).
- Polling: exponenciální backoff při chybě sítě (2 s → 4 s → 8 s, max 10 s), max 15 minut (do `expires_at`).
- Po reloadu stránky se token ztratí → krok se vrátí do `idle`; stará session zůstane aktivní do expirace
  a nové kliknutí ji zruší (§ 7.10).
- `dryRun` (náhled šablony): krok se vykreslí, tlačítko je zakázané s tooltipem „V náhledu nelze podepsat".
- `nativePlatform` (DocuSeal iOS/Android app): krok zobrazí „Podepište v prohlížeči" + tlačítko otevře
  systémový prohlížeč (v1 nepodporováno).
- Přístupnost: stavové změny v `aria-live="polite"`, QR má `aria-label`, vše ovladatelné klávesnicí.
- Texty: příloha D (§ 21).

### 6.6 Universal links

- Android: **custom scheme** `dokulachtan://sign?token=…&server=<origin>`; aplikaci vybírá systémový
  chooser. Android App Links (`assetlinks.json`) **nejsou** — vážou odkaz na podpis konkrétního APK
  a host zapečený v buildu, což u self-hosted instance nemá smysl (#18.1, `docs/24`).
- iOS: `https://<host>/qes/sign?token=…` (Universal Links) + `/.well-known/apple-app-site-association`.
- Web fallback `https://<host>/qes/sign?token=…` (resp. `/qes/app`) funguje vždy: zobrazí QR
  s custom scheme a tlačítko „Otevřít v aplikaci“.
- AASA **MUSÍ** servírovat `Qes::WellKnownController` s `Content-Type: application/json`
  a bez přesměrování (statický soubor v `public/.well-known/` neexistuje); **MUSÍ** obsahovat
  `QES_IOS_TEAM_ID`.
- AASA nemá příponu, takže statika (`ActionDispatch::Static` + `Rack::Mime`) by ho poslala jako
  `application/octet-stream`; proto ho **MUSÍ** servírovat route/controller s explicitním
  `Content-Type: application/json` (`Qes::WellKnownController#apple_app_site_association`, § 7.7).

---

## 7. Serverová kryptografická pipeline

Nové moduly žijí v **`app/lib/qes/`** (Rails autoloaduje `app/**`). Testy v `spec/lib/qes/`. Do `lib/` (DocuSeal konvence) se nesahá — patch zůstává
izolovaný v `app/lib/qes/`.

### 7.1 TBS PDF

Vstup: aktuální stav submission (vyplněná pole, bez `qes` hodnoty) a základ (buď šablona, nebo finální PDF předchozího signera).
TBS se staví až při `POST /qes/sessions/:token/certificate`, kdy je znám certifikát a CRL podepisujícího
(rezerva `/Contents` závisí na velikosti LTV revokačních dat, § 7.4).
Postup (`Qes::TbsDocument.build(submitter, field, signature_size:)`):
1. **Základ:**
   - první QES signer (žádný dokončený předchůdce): vygeneruje PDF ze všech `submission.schema_documents`
     v pořadí šablony (`Submissions::GenerateResultAttachments.generate_pdfs(submitter)`) — dnešní chování.
   - další QES signer: otevře `QesSession#final_document` posledního dokončeného non-viewer submittera
     (`HexaPDF::Document.new(io: StringIO.new(final_document.download))`); dokument se **NEPŘESTAVUJE**
     ani neimportuje po stránkách.
2. Do základu dokreslí hodnoty aktuálního submittera (`fill_submitter_fields`, `qes` pole se přeskočí)
   a **viditelnou pečeť podepisujícího** („Digitálně podepsáno“, jméno, datum) na pozici pole `qes`.
3. Vloží **jedno** podpisové pole `Sig` s rezervovaným `/Contents`: rezerva je **pevná**
   `QES_SIGNATURE_RESERVE` (default 64 KB), nezávislá na certifikátu, protože TBS se staví **před**
   certifikátem (§ 5.1a); pole je neviditelné (`Rect: [0, 0, 0, 0]`).
4. Zapíše **inkrementálně** (`HexaPDF::Document#sign` s `external_signing`), takže všechny předchozí revize
   zůstanou nedotčené a TBS PDF je jen nová revize.
5. Stránky se mapují **globálně** (`page_offsets` dle `submission.schema_documents` a metadat
   `pdf.number_of_pages`), aby se hodnoty a pečeť kreslily na správnou stránku i u dokumentů z více příloh.
6. Viditelná pečeť podepisujícího je součástí podepsané revize, takže ji podpis kryje a zůstává INTACT;
   finální PDF tak má na první pohled vidět, že je digitálně podepsané (viz § 16).

### 7.2 CMS placeholder a podepsané atributy

`Qes::CmsBuilder.prepare(data:, certificate:, chain:, signing_time:, digest_algorithm: 'sha256')`:

1. Podtřída `HexaPDF::DigitalSignature::Signing::SignedDataCreator` (`Qes::PlaceholderSignedDataCreator`)
   přepíše `digest_and_sign_data(data)`:
   - uloží `@signed_attrs_der = data` (DER `SET` podepsaných atributů),
   - vrátí placeholder signatury délky `signature_size` (bajty `\x00`).
2. Přepíše i `create_signed_attrs(data, ess_cert_hash:, signing_time:)`: HexaPDF 1.7 volá
   `create_signed_attrs(data, signing_time: (type == :cms))`, takže pro `type: :pades` atribut
   `id-signingTime` **vůbec nevytvoří** (ověřeno ve zdrojích 1.7.0, `signed_data_creator.rb`).
   Protože PAdES B-B `signing-time` vyžaduje, podtřída ho **MUSÍ** vynutit (`signing_time: true`).
3. `create(data, type: :pades, certificate:, certificates: chain, digest_algorithm:, signing_time:)`
   vrátí kompletní CMS s placeholderem; **NESMÍ** používat `timestamp_handler` (TSA až ve fázi 2).
4. `signing_time` **MUSÍ** být explicitní (`Time.now.utc`) a v obou fázích identický.
5. Server uloží `signed_attrs_der` a vrátí appce base64.

**Rezerva:** `QES_SIGNATURE_RESERVE` (default 65 536 B) je pevná a nezávislá na certifikátu, protože TBS
se staví **před** jeho přijetím (§ 5.1a). Finální CMS se do ní musí vejít; jinak `signature_size_exceeded`
(nikdy nezkracovat). LTV revokační data jdou do DSS (§ 7.4), ne do CMS.

**Vlastnosti CMS, které server MUSÍ dodržet:**
- `SubFilter = ETSI.CAdES.detached` (`type: :pades`, `signature_type: :pades`),
- `SignerInfo` obsahuje `content-type`, `message-digest`, `signingCertificateV2` a (vynuceně) `signing-time`,
- `message-digest` = SHA-256 přes data pokrytá `/ByteRange`,
- `signingCertificateV2` = SHA-256 certifikátu + issuer/serial (ESS, RFC 5035),
- `certificates` = celý řetěz (intermediate + root, pokud je k dispozici).

### 7.3 Vložení signatury a TSA

`Qes::CmsBuilder.complete(data:, signed_attrs_der:, signature:, certificate:, chain:, tsa_url:)`:

1. Znovu vytvoří `Qes::PlaceholderSignedDataCreator` (§ 7.2) se stejným `signing_time` a `digest_algorithm`.
2. `external_signing` vrátí raw signaturu z appky (server NEPOČÍTÁ hash znovu; signatura je nad
   identickými `signed_attrs`).
3. Pokud je `QES_TSA_URL` nastaveno, `timestamp_handler` vytvoří `id-aa-timeStampToken` (unsigned attr).
4. Ověří, že nový `signed_attrs_der` je **byte-identical** s uloženým; jinak `422 signing_context_mismatch`.
5. Vrátí finální CMS DER.

Vložení: `HexaPDF::DigitalSignature::Signing.embed_signature(io, cms_der)`.
Rezerva se počítá při stavbě TBS z odhadu (§ 7.1), takže finální CMS se do ní **MUSÍ** vejít. Pokud ne
(např. TSA token nebo CRL mezi fázemi narostly nad marži), server **MUSÍ** selhat s `signature_size_exceeded`
a session označit `failed` (nikdy nezkracovat podpis).

### 7.4 LTV (long-term validation)

- **v1 MUSÍ** vložit revokační data (CRL) tak, aby je přečetl validátor:
  - **DSS slovník** (`/DSS` v katalogu PDF, `/CRLs` se streamy CRL, `/Certs` s certy a `/VRI`
    s klíčem SHA-1 `/Contents` podpisu appky, `/Cert`, `/CRL`, `/TU`) — PAdES-LT; přidává se jako
    inkrementální revize po podpisu, takže podpis zůstává INTACT.
  - **CMS LTV se nepoužívá** (ETSI `RevocationValues` ani Adobe `RevocationInfoArchival` v unsigned
    atributech): pyHanko unsigned atributy nečte a Adobe používá DSS VRI; drží se jen v DSS.
- **MUSÍ** platit: offline validace (pyHanko `ades_lta_validation` s `allow_fetching=False`) označí
  podpis jako `AdESPassed.OK`; DocTS (§ 7.6) kryje DSS důvěryhodným časem.
- Revokační data se získávají z `CRLDistributionPoints`; reálný CRL PostSignum Qualified CA 4 má ~800 KB
  a je v PDF jen jednou (DSS), takže rezerva `/Contents` může zůstat malá (§ 7.1).
- **SSRF ochrana:** URL z certifikátu je nedůvěryhodný vstup. Host musí být v `QES_LTV_ALLOWED_HOSTS`
  (pak je povolen i `http`, pro testovací CRL server), jinak se vyžaduje `https` a veřejná adresa
  (privátní/loopback/link-local se odmítne); odpověď má limit velikosti.
- `Qes::Ltv.check_revoked!` při přijetí certifikátu **MUSÍ** ověřit, že certifikát není v CRL uvedený jako
  revokovaný; pokud je, session **MUSÍ** selhat s `422 revoked` (SPEC § 15.2 N4).
- Pokud cert má `CRLDistributionPoints` a CRL nelze získat (allowlist, egress, DNS), session **MUSÍ**
  selhat s `failure_code = "ltv_unavailable"`; `QES_REQUIRE_LTV` řídí jen certy **bez** CRL DP
  (`true` = fail, `false` = podpis bez LTV s varováním v auditu).
- **Poznámka:** HexaPDF 1.7 LTV neumí (viz § 16), proto je LTV implementováno vlastními moduly
  `Qes::Ltv` (CRL pro DSS) a `Qes::Dss` (DSS slovník); CMS LTV se nepoužívá (viz § 7.4 výše).

### 7.5 Validace

`Qes::Validator.call(signed_pdf_bytes, trust_roots:, at:)` — `trust_roots` je **verification**
trust store (`QES_VERIFICATION_TRUST_ROOTS`, výchozí `config/qes/czech.pem`); signing acceptance
používá samostatný `QES_TRUST_ROOTS` (výchozí `config/qes/postsignum.pem`, § 5.2). Trust anchory
v `trust_roots` **MUSÍ** být vydávající CA (TSL service digital identity), ne rooty; store nastavuje
`X509_V_FLAG_PARTIAL_CHAIN`, takže řetěz končí na vydávající CA. Root jako anchor by důvěřoval celému
podstromu, tj. i CA, které v TSL nejsou (nález #9). Postup:
1. **Pdfium** (`VerifyPdfSignature.call`) — interní validace jako u DocuSealu; výsledek se ukládá do `validation_report`.
2. **Všechny signatury**: `signature_dicts` vrací všechny signatury v aktuální revizi; `intact` = kryptografická
   platnost všech (NOVERIFY — kontroluje se jen signatura, ne řetěz), `trusted` = jen QES signatury
   (`ETSI.CAdES.detached`) vůči trust rootům; do store se přidávají i intermediate certifikáty z CMS
   (bez nich OpenSSL řetěz nepostaví a reálné I.CA/PostSignum certifikáty vycházejí jako nedůvěryhodné);
   pečeti DocuSealu (`adbe.pkcs7.detached`) se ověřují vlastním certem a trust rooty QES se na ně nevztahují.
   `ok` = `intact ∧ trusted ∧ coverage == full`; `complete!` **MUSÍ** vyžadovat `ok` (§ 4.3).
3. **Kontrola pokrytí**: poslední signatura **MUSÍ** pokrývat celý soubor (`ByteRange` = celý dokument);
   jinak `failure_code = "incomplete_coverage"`.
4. **Kontrola úrovně**: `QcSSCD` → `qes`, `QcCompliance` → `ades`; nikdy nezapisovat `qes` bez `QcSSCD`.
   `level` se bere z poslední QES signatury (ne z pečeti).
5. Kontrola `document_digest` proti `signed_attrs_der` (message-digest) — server **MUSÍ** ověřit před vložením
   i po vložení.

Externí validace (pyHanko/pdfsig) je součástí testů (§ 15.2), ne runtime.

### 7.6 Pečeť DocuSealu inkrementálně nad podpisem

Po úspěšné validaci (u každé QES session — i když je signerů více):
1. `Qes::Seal.apply(signed_pdf_bytes, submitter)`:
   - načte PDF, přidá nové podpisové pole (pečeť) na poslední stránku,
   - `pdf.sign(io, write_options: { validate: false }, reason: …, certificate:, key:, certificate_chain:, timestamp_handler:)`
     s PKCS DocuSealu (`Accounts.load_signing_pkcs(account)`) a TSA (`Accounts.load_timeserver_url(account)`),
   - HexaPDF `sign` **vždy** zapisuje inkrementálně (`Signatures#add` vynucuje `incremental: true`), takže
     všechny předchozí revize (podpisy appky i pečeti) zůstávají **INTACT** a nová revize je přidána za ně,
   - při chybě se pečeť přeskočí (`seal_state = "failed"`), dokument se uloží bez pečeti a do auditu se zapíše varování
     (pečeť **NESMÍ** zablokovat dokončení podpisu).
2. `signed_pdf_sha256` = hash `signed_document` (bez pečeti — kritérium UNTOUCHED); `final_pdf_sha256` = hash
   `final_document` (s pečetí; při selhání pečeti = kopie `signed_document`).
3. `tbs_document` a `signed_document` (bez pečeti) se uchovávají pro audit a reprodukovatelnost.
4. Pečeť se aplikuje **po každé QES session** (u N signerů N pečetí): `documents` signera N a
   `combined_document`/`merged_document` pro QES submission jsou **kopie téhož** `final_document` poslední
   session (žádné další podepisování, žádné přestavování stránek) — viz § 7.7.

**MUSÍ platit (N signerů):** finální PDF obsahuje N podpisů appky + N pečetí; každá předchozí
signatura (podpis appky i pečeť) je INTACT a poslední signatura (pečeť poslední session) pokrývá celý soubor.
Uprostřed řetězu (session N, N < poslední) je poslední signaturou právě pečeť session N.

**Dokumentový timestamp (DocTS, PAdES-LTA):** po pečeti se přidá **nová inkrementální revize**
s podpisovým polem typu `DocTimeStamp` (`SubFilter ETSI.RFC3161`) a RFC 3161 tokenem z TSA
(`QES_TSA_URL`, produkční instance DigiCert free/AATL). DocTS kryje celý dokument včetně DSS a pečeti;
řetězení DocTS je evidence record pro LTA. Když `QES_TSA_REQUIRED=true` a TSA selže, session
**MUSÍ** skončit `tsa_unavailable`; při `false` se DocTS přeskočí (`doc_timestamp_state=failed`)
a do auditu se zapíše varování.

### 7.7 Hooky do generování PDF (přesné soubory)

Přesný seznam **21 doteků** upstreamu, jejich změny a počty řádků je v § 14
(jediný zdroj pravdy). Hooky, které fork potřebuje:

- `app/lib/qes/extensions/lib/generate_result_attachments.rb` — podepsané PDF + přeskočit `qes` pole,
- `app/lib/qes/extensions/lib/generate_combined_attachment.rb` — combined = kopie `final_document`,
- `app/lib/qes/extensions/lib/submit_values.rb` — finalizace hodnot (N1, nález #2),
- `lib/submissions/generate_audit_trail.rb` — stránka QES v auditu,

Generátory rozhodují podle **dokončené QES session** (`submitter.qes_sessions.completed.exists?`),
ne podle šablony: volitelné `qes` pole bez podpisu musí dostat upstream PDF a finální PDF
session se použije i po změně polí šablony (nález #3). `QES_ENABLED=false` zůstává **feature
gate** — s vypnutým QES se QES kód nespouští a starší podepsaný dokument projde
ne-QES cestou (očekávané chování).
- `app/views/submissions/_value.html.erb`, `show.html.erb` — přehled podpisu,
- `app/views/templates/show.html.erb`, `edit.html.erb`, `templates_preview/show.html.erb` — panel a chyby,
- `app/javascript/submission_form/form.vue`, `area.vue` — krok a oblast formuláře,
- `app/javascript/template_builder/field_type.vue`, `field_context_menu.vue`,
  `dynamic_insert_menu.vue`, `fields.vue`, `builder.vue` — typ pole, volba AdES/QES, gate a save error,
- `app/javascript/application.js` — `withQes`,
- `lib/api_path_consider_json_middleware.rb`, `db/schema.rb`.

`lib/verify_pdf_signature.rb` **není** dotek: je bit-identický s upstreamem a orchestrace
ověření je v `Qes::PdfiumTrust.report`.

`Qes::ResultAttachments.call(submitter)`:
- vezme `final_document` (§ 7.6) a vytvoří `ActiveStorage::Attachment` name `documents`
  s `metadata: { original_uuid: <attachment_uuid pole qes>, analyzed: true, sha256: … }`,
- pokud existuje více `qes` polí, spojí jejich dokumenty do jednoho PDF **kopií** (bez importu stránek).

`Qes::ResultAttachments.combined_document(submitter)`:
- pro QES submission vytvoří `combined_document` (příp. `merged_document` pro `?merge=true`) **kopií**
  `final_document` poslední dokončené QES session — bez `pdf.sign` a bez přidání auditní stránky (obojí by zneplatnilo podpis appky),
- auditní stránka QES žije v samostatném artefaktu `audit_trail` (`EnsureAuditGenerated` → `build_audit_trail`).
- **MUSÍ** platit: `documents` signera N i `combined_document` mají za poslední signaturou pečeť a všechny
  předchozí podpisy appky i pečeti INTACT; počet signatur = N podpisů appky + N pečetí (nikdy víc).

`Qes::TbsDocument.chained_base(submitter)` (nové, § 4.6):
- `own = QesSession.completed.where(submitter_id: submitter.id).order(:id).last`; pokud existuje, otevři jeho `final_document`,
- jinak `previous = submission.submitters.reject(&:viewer?).select(&:completed_at?).max_by(&:completed_at)`,
- `session = QesSession.completed.where(submitter_id: previous.id).order(:id).last`,
- `session&.final_document&.attached?` → otevři `HexaPDF::Document.new(io: StringIO.new(session.final_document.download))`,
- jinak `nil` (první signer — dnešní stavba ze šablony).

`Qes::TbsDocument.page_offsets(submission)` (nové, § 4.6):
- v pořadí `Qes.template_schema(submission)` sečte `pdf.number_of_pages` z metadat `submission.schema_documents`
  (bez stahování), `attachment_uuid → globální index první stránky`.

`Qes::AuditPage.append(document, submission)`:
- nadpis „Kvalifikovaný elektronický podpis (QES/AdES)", tabulka: pole, podepisující,
  certifikát (subject/issuer/serial), čas podpisu, úroveň, kde je klíč, `document_digest`,
  `signed_pdf_sha256`, `final_pdf_sha256`, výsledek validace, stav pečeti, verze protokolu.

### 7.8 Selhání a retry

| Krok | Selhání | Chování |
|---|---|---|
| `prepare` | chyba HexaPDF | `failed`, `failure_code = "prepare_failed"`, pole zůstává `empty` |
| `complete` | neplatná signatura | `failed`, uživatel může založit novou session |
| `embed` | CMS delší než rezerva | `failed`, `signature_size_exceeded`, do auditu velikosti |
| TSA | nedostupné | při `QES_TSA_REQUIRED=false` pokračovat bez TSA; jinak `failed` |
| LTV | OCSP/CRL nedostupné | viz § 7.4 |
| pečeť | chyba | `seal_state = "failed"`, dokument bez pečeti se uloží |
| validace | `intact=false` | `failed`, `failure_code = "validation_failed"` |

Retry: `Qes::Providers::MobileApp#complete!` se **MUSÍ** volat synchronně v requestu (idempotence přes `with_lock` + stav),
záznam `complete` = hotovo) a **MUSÍ** mít omezený počet pokusů (3), pak `failed`.
`QesSession#complete!` **MUSÍ** běžet pod zámkem řádku (`with_lock`), aby souběžná dokončení
nezapsala dvě různé signatury.

Plánování expirace: fork nemá `sidekiq-cron` ani jiný plánovač a SPEC § 22 zakazuje nové závislosti,
proto **MUSÍ** `Qes::ExpireSessionsJob` fungovat jako samo-plánující se smyčka: inicializér při bootu
zařadí první běh a job na konci přeplánuje sám sebe přes `perform_in(QES_EXPIRY_JOB_INTERVAL)`.
Duplicitní smyčky po restartu **MUSÍ** být vyloučeny atomickým cache lockem
`qes_expire_sessions` (`Rails.cache.write(..., unless_exist: true)`), ne oknem `LockEvent`.

### 7.9 Logging, redakce a observabilita

**MUSÍ** se logovat (structured, bez osobních údajů):
`[qes] session=<id> submission=<id> submitter=<id> state=<state> level=<level> code=<failure_code>`.

**NESMÍ** se nikdy logovat: token, `data_to_sign`, raw signatura, PIN/QPIN, obsah certifikátu (subject),
obsah PDF. Do `config/initializers/qes.rb` přidat filtr parametrů:

```ruby
Rails.application.config.filter_parameters += %i[token signature data_to_sign certificate pin qpin]
```

Observabilita pro provoz:
- `fly logs` + filtr `[qes]` → časová osa jedné session (všechny přechody),
- `QesSession` je zdrojem pravdy pro dohledání (id, časy, `failure_code`, `validation_report`),
- runbook (`docs/10-qes.md`) obsahuje postup „jak dohledat session podle id a ověřit podpis
  nezávislým validátorem“,
- v1 bez metrik/monitoringu; stačí logy a DB (staging je single-tenant).

### 7.10 Souběh a idempotence

| Situace | Chování |
|---|---|
| Dvě karty prohlížeče | Druhé `POST /qes_sessions` zruší první session; první karta v pollingu dostane `cancelled` → UI „Podepisování bylo nahrazeno“ + „Zkusit znovu“ |
| Opakované `POST /certificate` se stejným certem | 200 + stejné `data_to_sign` (idempotentní) |
| Jiný certifikát po `awaiting_signature` | `409 wrong_state` |
| Opakované `POST /complete` se stejnou signaturou | 200 + stejný výsledek (idempotentní), session se nemění |
| Opakované `POST /complete` s jinou signaturou | `409 wrong_state` |
| App ztratí odpověď a zkusí to znovu | Stejné jako výše; app po chybě sítě znovu načte `GET /qes/sessions/:token` a zobrazí skutečný stav — token se drží do retence (§ 4.3), takže i po `completed` dostane 200 se stavem |
| Zrušení v prohlížeči během podpisu v appce | Session `cancelled`; app dostane `409 wrong_state` (nebo `410 used_token`) → „Podepisování bylo zrušeno v prohlížeči“ |
| Souběh jobu a requestu | `LockEvent` klíč `qes_embed:<session_id>`; druhý běh počká nebo přeskočí (stav je již `embedded`+) |
| Expirace během `complete` | `410 expired_token`; žádný částečný zápis (vše v transakci) |

**MUSÍ** platit: všechny změny stavu a hodnoty pole probíhají v jedné DB transakci se zapsáním
`submitter.values[qes_uuid]`; při výjimce se stav vrací na poslední konzistentní hodnotu a session je `failed`.

---

## 8. Úroveň a QCStatements

### 8.1 Mapování

| QCStatement OID | Význam | `level` |
|---|---|---|
| `0.4.0.1862.1.1` (QcCompliance) | kvalifikovaný certifikát | `ades` |
| `0.4.0.1862.1.4` (QcSSCD) | klíč v QSCD | `qes` (s QcCompliance) |
| žádný | nekvalifikovaný | `none` |

`Qes::CertificateInfo.parse(cert_der)` vrací `level`:
`qes` ⇔ `QcCompliance ∧ QcSSCD`; `ades` ⇔ `QcCompliance`; jinak `none`.

### 8.2 Pravidla pro varianty

- **B (telefon)**: `key_location = "phone_keystore"` → `level` **MUSÍ** být `ades` nebo `none`;
  `QcSSCD` v certifikátu se **MUSÍ** odmítnout (`422 level_mismatch`) — telefon není QSCD.
- **A (karta)**: `key_location = "card"` → `level` **MUSÍ** být `qes`; certifikát **MUSÍ** mít `QcSSCD`.
- Pole s `preferences.level == "qes"` **MUSÍ** vyžadovat `qes` certifikát i pro variantu A.
- **NESMÍ** se stát, že se AdES zapíše jako QES v `level`, auditu ani UI.

### 8.3 Kontrola v auditu

Audit **MUSÍ** obsahovat `level` a `qc_statements` přesně tak, jak byly z certifikátu zjištěny,
spolu s `key_location`, `reader` (u A) a verzí protokolu.

---

## 9. Podpisová appka (Expo)

### 9.1 Obrazovky

| # | Obrazovka | Obsah a akce | Chybové stavy |
|---|---|---|---|
| S1 | **Home** | stav certifikátu (žádný / platný / **expiruje** = méně než 30 dní, jen varování); s klíčem primární „Podepsat PDF“ + sekundární „Ověřit PDF“, bez klíče primární „Importovat klíč (PKCS#12)“ + sekundární „Ověřit PDF“; karta certifikátu je klikací → S3, varování u expirace odkazuje na import; terciárně „Připojit čtečku“ (A) a „Nastavení“ | — |
| S2 | **Import certifikátu** | výběr PKCS#12 (sekundární), heslo, primární „Importovat“ (vypnuté bez souboru), **testovací certifikát až za oddělovačem „Nebo“ jako alternativní cesta**; po uložení souhrn + primární „Hotovo“ | `invalid_p12`, `wrong_password`, `no_signing_key`, `qscd_certificate` (telefon není QSCD, § 5.2) |
| S3 | **Detail certifikátu** | subject, issuer, platnost, sériové číslo, úroveň (AdES/QES dle QCStatements), „Importovat jiný klíč“ (sekundární), nebezpečná zóna s odstraněním (potvrzení + biometrie) | — |
| S4 | **Žádost o podpis** (deep link) | název dokumentu, kdo podepisuje, certifikát, vyžaduje úroveň; **automaticky zvolený podepisující (§ 9.8)**; primární „Zobrazit dokument“ (jen `GET /document`, žádný klíč, žádný `POST /certificate`), po otevření dokumentu primární „Podepsat dokument“ (biometrie + `POST /certificate` + podpis), terciární „Zrušit“; při `certificate_missing`/`no_signer`/`needs_reader`/`needs_qes_key` primární „Nastavit podepisování“ → S10; po úspěchu primární „Stáhnout“ + sekundární „Sdílet“ + terciární „Zavřít“ | `expired_token`, `network`, `wrong_certificate` (lokální cert nesplňuje `level_required`, § 9.6), `no_signer` (→ S10), `document_mismatch` (reviewed TBS ≠ `data_to_sign`), `verification_failed` (finální PDF neobsahuje reviewed TBS) |
| S5 | **Biometrie** | systémová výzva (`expo-local-authentication`) před každým podpisem | zamítnuto → zpět na S4 |
| S6 | **Výsledek** | úspěch (úroveň, čas, hash) / chyba + „Zkusit znovu" / „Vyžádat nový odkaz" | — |
| S7 | **Nastavení** | sekce Přímý podpis a ověření PDF (URL + API token jen pro přímý podpis PDF a ověření PDF + primární „Uložit“), seznam důvěryhodných serverů pro podpisové odkazy s možností odvolat důvěru, Podepisování (certifikát → S3, čtečka → S8), Diagnostika, O aplikaci + **attribution MOI SDK** (u A), Pokročilé (testovací certifikát); smazání dat je jen v S3 | — |
| S8 | **Připojení čtečky** (A) | párování BLE, výběr čtečky, stav baterie, připojení | `reader_not_found`, `reader_disconnected` |
| S9 | **Výběr certifikátu z karty** (A) | seznam kontejnerů (`getContainerList`), jen kvalifikované (`QcCompliance`), úroveň QES, PIN/QPIN výzva | `pin_blocked`, `applet_blocked`, `no_qualified_certificate` |
| S10 | **Konfigurační wizard** (z S4, když není podepisující — § 9.8) | primární „Importovat klíč (PKCS#12)“ → S2, sekundární „Nastavit čtečku“ → S8, testovací certifikát až na konci; „Zpět“ | `import_failed`, `reader_not_found` |
| S11 | **Výběr PDF** (přímý podpis, docs/15) | `expo-document-picker` (PDF) **nebo PDF ze share sheetu (Android, docs/15 § 6)** jako sekundární pole, název souboru, jméno do pečeti (default CN z vaultu), úroveň (AdES/QES), primární „Pokračovat“ (vypnuté bez souboru) → upload, terciární „Zrušit“ | `file_too_large`, `invalid_pdf`, `encrypted_pdf`, `already_signed`, `network` |
| S12 | **Umístění pečeti** (přímý podpis) | náhled stránky ze serveru, přepínání stránek, klepnutí → obrys pečeti, primární „Podepsat“ (vypnuté bez umístění) → `place` → S4, terciární „Vybrat jiné PDF“ a „Zrušit“ | `invalid_position`, `wrong_state`, `expired_token` |
| S13 | **Výsledek PDF** (přímý podpis) | reuse S6 + primární „Stáhnout a sdílet“ + sekundární „Zavřít“ | `wrong_state` (server ještě dokončuje → polling) |

Pořadí a váha tlačítek na obrazovkách S1–S13 se řídí [docs/17-ui-hierarchie-akci.md](docs/17-ui-hierarchie-akci.md):
jedna primární akce na stav, alternativní cesty za oddělovačem, navigace a „Zrušit“ jako textové
odkazy, mazání oddělené a s potvrzením.

### 9.2 Navigace a stav

- Router: `expo-router`; stav: `zustand` nebo React context (jen v paměti).
- Token se drží **jen v paměti**; **NESMÍ** se ukládat do AsyncStorage ani do logů.
- Při přesunu appky na pozadí během podpisu se operace **MUSÍ** dokončit nebo bezpečně zrušit
  (žádné částečné podpisy); po návratu se stav obnoví z `GET /qes/sessions/:token`.

### 9.3 Varianta B (telefon) — tok

0. Automatická volba podepisujícího dle § 9.8 (bez ptaní; dle `level_required`); když není ani klíč, ani čtečka, spustí se S10 místo S4.
1. Deep link → S4 (`GET /qes/sessions/:token`).
2. **Kontrola:** `GET /qes/sessions/:token/document` → nepodepsaný TBS; appka ho otevře
   a uživatel potvrdí. **Žádný klíč, žádná biometrie, žádný `POST /certificate`.**
3. Biometrie (S5) → odemčení vault klíče (`expo-secure-store`) → dešifrování klíčového materiálu
   v paměti. **Heslo k PKCS#12 se při podpisu nevyžaduje** (jen při importu, § 9.5).
4. `POST /certificate` s certifikátem a **řetězem** z PKCS#12 → `data_to_sign`; appka ověří
   `messageDigest`, `signingCertificateV2`, `signingTime` a `certificate_info` proti reviewed TBS
   (§ 5.1a); při neshodě `POST /abort` a konec.
5. Podpis: `node-forge` `privateKey.sign(forge.md.sha256.create().update(data_to_sign))`
   (`RSASSA-PKCS1-V1_5`, SHA-256; `pki.rsa.sign` v node-forge neexistuje) → raw signatura (256/384/512 B).
6. `POST /complete` → S6; appka porovná `completed.document_digest` s reviewed digestem.
7. Po stažení finálního PDF appka ověří `final_pdf_sha256` a přítomnost reviewed TBS
   (prefix/suffix mimo `/Contents`); při neshodě PDF nenabídne.
8. Klíč se ihned po podpisu vymaže z paměti (`key = null`, `p12 = null`).

### 9.4 Varianta A (karta) — tok

1. S8: připojení čtečky (BLE). Podporované čtečky: ACR 3901 U-S1, bR301 BLE (černá),
   CT 1100, AirID 2; na Androidu navíc USB OTG čtečka.
2. Integrace **oficiálního MOI Podpisového SDK** (AAR `APDU-SDK-v1.2-EOP-release.aar`,
   `apdu-sender-v1.2-release.aar`, `BLE-wrapper-v2.0.0-release.aar`, `ACS-v2.0.2-release.aar`,
   `Feitian-v2.0.2-release.aar`, `AirID-v2.0.0-release.aar`, `USB-v1.0.3-release.aar`,
   `AirIdDriverAndroid-2.0.3-GA.aar`, `com.aheaditec:ccid:0.3.2`).
3. S9: `ApduProvider.initializeSession` → `getContainerList` → výběr kontejneru s kvalifikovaným certem
   → `getCertificate` → kontrola QCStatements (QcCompliance; QcSSCD ⇒ QES).
4. `POST /certificate` s certifikátem a `key_location = "card"` → `data_to_sign`.
5. `provider.signData(container, data_to_sign, AlgorithmID.RSA_SHA256_PKCS1_PADDING, callback)`;
   SDK si vyžádá **QPIN** (kvalifikovaný podpis) nebo PIN (ostatní) — zadává uživatel v dialogu SDK.
6. `POST /complete` → S6; `provider.finalizeSession` (reset stavu karty).
7. PIN/QPIN se **NESMÍ** ukládat ani logovat; po 3 chybných zadáních karta zablokuje kód →
   appka zobrazí „Kód zablokován, odblokujte na úřadu / v aplikaci eObčanka".

### 9.5 Úložiště klíče (B) — rozhodnutí 2026-10-16: **při podpisu jen biometrie, žádné heslo**

- **Import (jednorázově):** uživatel vybere PKCS#12 a zadá heslo; app soubor v paměti dešifruje
  (`node-forge`) a **soukromý klíč + certifikát + řetěz ihned znovu zašifruje** AES-256-GCM klíčem z vaultu.
  Heslo k PKCS#12 se **NIKDY neukládá** a po importu se zahodí; samotný soubor PKCS#12 se po importu smaže
  (neuchovává se).
- **Vault klíč:** náhodný 256bitový klíč v `expo-secure-store` (`keychainService: "cz.dokulachtan.signer.vault"`)
  s `requireAuthentication: true`; SecureStore ho vydá jen po biometrickém ověření (Android `BiometricPrompt`,
  iOS `biometryCurrentSet`). Šifrovaný payload (klíč + cert + řetěz) je v souboru v dokumentovém úložišti appky.
- **Podpis (B):** biometrie (OS prompt ze SecureStore) → dešifrování klíčového materiálu v paměti → podpis →
  klíč se ihned vymaže (`key = null`). **Při podpisu se heslo k PKCS#12 nevyžaduje** (rozhodnutí uživatele 2026-10-16).
- **Bez biometrie se nepodepisuje** — žádný fallback na heslo ani na PIN appky.
- Import nového PKCS#12 **nahrazuje** předchozí; před nahrazením i smazáním se vyžaduje biometrie.
- Změna biometrie může klíč zneplatnit; appka to hlásí jako `key_invalidated` a vyžádá nový import.
  Na Androidu může Expo `BiometricPrompt` povolit i PIN/heslo zařízení; striktně jen otisk je mimo v1.
- **Při importu se odmítne certifikát s `QcSSCD`** (telefon není QSCD → server by vrátil `422 level_mismatch`, § 5.2);
  appka to řekne hned a klíč neuloží.
- **NESMÍ** se stát: uložení hesla k PKCS#12, jeho logování, nebo použití hesla při podpisu.

### 9.6 Chybové stavy appky

| Stav | Chování |
|---|---|
| Token expiroval / neznámý | „Platnost odkazu vypršela. Vyžádejte nový." |
| Bez sítě | retry s exponenciálním backoffem (max 3×), pak chyba |
| Certifikát chybí / expiroval | „Importujte nový certifikát" / „Certifikát vypršel" |
| Biometrie zamítnuta | podpis se neprovede, zpět na S4 |
| Biometrie nedostupná / klíč zneplatněn | „V telefonu není dostupná biometrie“ / „Importujte klíč znovu“ (`key_invalidated`) |
| Certifikát nepodporuje podpis (keyUsage) | `unsupported_certificate` |
| Úroveň pole `qes` a cert bez QcSSCD | „Vyžaduje se kvalifikovaný certifikát" |
| Čtečka odpojena (A) | „Připojte čtečku" + retry |
| QPIN blokován (A) | „Kód blokován — odblokujte v aplikaci eObčanka" |
| Server 5xx | retry s backoffem, session v prohlížeči čeká |
| Žádný podepisující (ani klíč, ani čtečka) | S10 wizard: import klíče, nebo nastavení čtečky (§ 9.8) |
| Neznámá verze protokolu (`X-QES-Protocol`) | „Aktualizujte aplikaci." (§ 5.7) |
| Server dokončuje (202/`embedded`) | „Dokončuji na serveru…" + „Zkontrolovat znovu", polling max 30 s |

### 9.7 Expo moduly a struktura appky

```
mobile/app/
  app/                     # expo-router: index, import, certificate, sign, setup, settings, reader, containers
  src/lib/api.ts            # QES API klient (token endpoints)
  src/lib/signer.ts         # volba podepisujícího dle lokální konfigurace (§ 9.8)
  src/lib/crypto/softwareSigner.ts   # B: node-forge
  src/lib/crypto/cardSigner.ts      # A: MOI SDK přes native modul
  src/lib/vault.ts          # AES-GCM + SecureStore + biometrie
  src/lib/level.ts          # QCStatements → level
  src/modules/eop-signing-sdk/       # Expo Module: MOI AAR (Android)
    android/build.gradle             # lokální AAR + spongycastle + ccid
    expo-module.config.json
    app.plugin.js                   # config plugin: kopíruje AAR, přidává závislosti
  src/lib/pdfApi.ts          # přímý podpis PDF: upload / náhled / place / download
  app/sign-pdf.tsx           # S11 + S12 (výběr PDF, umístění pečeti)
  src/lib/pdfShare.ts        # zápis do cache + expo-sharing
```

Použité Expo moduly: `expo-linking`, `expo-document-picker`, `expo-file-system`, `expo-secure-store`,
`expo-local-authentication`, `expo-crypto`; podpis `node-forge` (B). Pro A je potřeba **dev build**
(`npx expo run:android`), protože MOI SDK je nativní AAR.

### 9.8 Automatická volba podepisujícího (rozhodnutí 2026-10-16)

Appka volí podepisujícího **automaticky, bez ptaní** — lokálně podle `level_required` a své konfigurace,
ne podle serveru (server cert podepisujícího předem nezná, § 5):

| Stav appky | Cesta | `key_location` |
|---|---|---|
| Je importovaný klíč (PKCS#12 ve vaultu) | B (klíč v telefonu) | `phone_keystore` |
| Není klíč, ale je nastavená/spárovaná čtečka | A (čip) | `card` |
| Ani jedno | S10 wizard: „Importovat klíč" → S2, nebo „Nastavit čtečku" → S8 | — |

Pravidla:
- **MUSÍ** platit: při podpisu se **nikdy nezadává heslo** k PKCS#12 — odemyká se jen biometrií (§ 9.5).
- Volba je **automatická, bez ptaní** (rozhodnutí uživatele 2026-10-16); v S4 je jen vidět, který podepisující se použije
  (změna je přes S1/S10, ne přepínačem v S4):

| `level_required` | Klíč (AdES) ve vaultu | Čtečka (QES) | Automaticky použije |
|---|---|---|---|
| `ades` | ano | — | klíč (`key_location = "phone_keystore"`) |
| `ades` | ne | ano | čtečka (`key_location = "card"`) — QES je přípustná vyšší úroveň |
| `ades` | ne | ne | S10 wizard |
| `qes` | ano (AdES) | ano | čtečka (`key_location = "card"`) |
| `qes` | ano (AdES) | ne | S10 wizard: nabídne nastavení čtečky (klíč QES nesplní) |
| `qes` | — | ano | čtečka (`key_location = "card"`) |

- Priorita je tedy **dle `level_required`**: pro `qes` vyhrává čtečka, pro `ades` klíč → čtečka → wizard.
- `level_required = qes` a lokálně jen AdES klíč → appka **MUSÍ** nabídnout S10 (nastavení čtečky),
  nikdy neposílat certifikát, který server odmítne (`422 qes_required_qscd`, § 5.2).
- `level_required = ades` a lokálně QES (karta) → použije se QES (vyšší úroveň je přípustná), `key_location = "card"`.
- **NESMÍ** se stát, že appka pošle certifikát, který neodpovídá `level_required` (zbytečná chyba
  `qes_required_qscd`/`level_mismatch`).

### 9.9 Přímý podpis PDF — tok (S11–S13)

0. S11 ze **share sheetu** (Android, docs/15 § 6): `ACTION_SEND` `application/pdf` → appka otevře S11 s už vybraným PDF
   a **rovnou ho nahraje** (bez ručního ukládání a hledání); štítek v share sheetu je „Podepsat PDF“.
1. S11: `expo-document-picker` (PDF) → název souboru, jméno do pečeti (default CN z vaultu),
   úroveň (AdES/QES; na iOS jen AdES) → `POST /api/qes/documents` (multipart).
2. Server vrátí `{template_id, field, document.pages[], stamp}`; appka zobrazí náhled stránky (S12)
   a klepnutím umístí obrys pečeti (velikost `stamp` × měřítko náhledu).
3. `PATCH /api/templates/:id` (oblast pole) → `POST /api/templates/:id/submissions` →
   `POST /s/:slug/qes_sessions` → token; appka pokračuje na S4 (dnešní obřad, § 9.3/§ 9.4).
4. Po `completed` (S13) appka zavolá `POST /qes/sessions/:token/complete_submission` (SPEC § 5.3.1;
   DocuSeal vygeneruje finální PDF + auditní stránku) a pak `GET /api/submitters/:id` → PDF se stáhne nativně do cache a nabídne
   se **„Stáhnout“** (uložit do telefonu: `MediaStore` na Androidu 10+, SAF na starším Androidu, Files na iOS;
   volitelně **„Uložit jinam…“** se zapamatovanou SAF složkou), **„Otevřít“** (systémový prohlížeč PDF) a
   **„Sdílet“** (systémový share sheet; na Androidu vlastní modul na hlavním vlákně, na iOS `expo-sharing`).
5. Mapování klepnutí: server vrací `pages[].width/height` v bodech; appka zobrazí náhled
   (`resizeMode: contain`) a zná zobrazený obdélník (`x0, y0, w, h`); `x = (tapX - x0) / w`,
   `y = (tapY - y0) / h`; `stampArea` z toho udělá oblast pole (`x`, `y` = levý horní roh pečeti,
   `w = stamp.width / page.width`, `h = stamp.height / page.height`, clamp na 0–1).
6. Chybové stavy: `invalid_pdf`, `encrypted_pdf`, `already_signed`, `file_too_large`, `invalid_level`,
   `wrong_state`, `expired_token`, `used_token`; texty dle § 9.6.

---

## 10. Deep links

### 10.1 Formáty

| Formát | Použití |
|---|---|
| `https://<host>/qes/sign?token=…` | web fallback (vždy); na iOS zároveň Universal Link |
| `dokulachtan://sign?token=…&server=<origin>` | primární na Androidu (systémový chooser); server se bere z parametru a při prvním použití ho uživatel potvrdí (TOFU) |
| `https://<host>/qes/app?token=…` | web fallback stránka s QR |

Appka **MUSÍ** podporovat custom scheme; na iOS navíc universal link. Server **MUSÍ** vracet
`universal_link` (`/qes/sign`) i `custom_scheme_link` (`dokulachtan://sign?token=…&server=<origin>`)
v `POST /s/:submit_form_slug/qes_sessions` (§ 6.1).

### 10.2 Soubory pro ověření

`/.well-known/apple-app-site-association` (iOS Universal Links; servíruje `Qes::WellKnownController`):

```json
{ "applinks": { "details": [{ "appID": "<QES_IOS_TEAM_ID>.cz.dokulachtan.signer",
  "paths": ["/qes/sign", "/qes/app"] }] } }
```

### 10.3 Fallback scénáře

| Situace | Chování |
|---|---|
| Appka není nainstalovaná | prohlížeč zůstane na `/qes/app`, zobrazí QR + odkazy na stažení |
| Universal link neověřený (dev build, fly.dev) | fallback na custom scheme odkaz |
| Appka otevřená bez tokenu | S1 s chybou „Neplatný odkaz" |
| Deep link z jiného serveru | origin z odkazu je autoritativní pro danou session; server shodný s Nastavením (přímý podpis PDF) je důvěryhodný bez TOFU; jinak pokud není v seznamu důvěryhodných, appka vyžádá potvrzení (TOFU); odkaz bez serveru skončí `missing_server`; `server_url` z payloadu musí odpovídat originu odkazu, jinak `foreign_server` |
| Token expiroval | S6 s „Vyžádejte nový odkaz"; prohlížeč nabídne „Zkusit znovu" (nová session) |

---

## 11. Konfigurace

`Qes::Config` v `app/lib/qes.rb` čte ENV s prefixem `QES_`; defaulty jsou české, ENV je override:

| ENV | Default | Význam |
|---|---|---|
| `QES_ENABLED` | `true` | vypínač QES (default pro český deployment; `false` pro upstream/ne-QES) |
| `QES_SESSION_TTL` | `600` | platnost session pro podpis [s] |
| `QES_REVIEW_TTL` | `900` | platnost session pro kontrolu dokumentu [s] (`GET /document` ji prodlouží) |
| `QES_SIGNATURE_SIZE` | `20000` | placeholder signatury v CMS [B] |
| `QES_SIGNATURE_MIN_SIZE` | `20000` | minimální rezerva `/Contents` (fallback) [B] |
| `QES_SIGNATURE_RESERVE` | `65536` | pevná rezerva `/Contents` v TBS; staví se před certifikátem (§ 5.1a) [B] |
| `QES_DEEP_LINK_BASE` | `dokulachtan://sign` | custom scheme |
| `QES_PUBLIC_BASE_URL` | `APP_URL` | host pro universal links |
| `QES_TRUST_ROOTS` | `config/qes/postsignum.pem` | signing trust store: které certy smí podepsat v tomto DocuSealu (PEM); jiná CA přepíše |
| `QES_VERIFICATION_TRUST_ROOTS` | `config/qes/czech.pem` | verification trust store: české kvalifikované CA pro ověření cizích PDF (PEM) |
| `QES_TSA_URL` | `http://timestamp.digicert.com` | RFC 3161 TSA (DigiCert free, AATL); kvalifikované I.CA/PostSignum přepíše |
| `QES_TSA_TRUST_ROOTS` | `config/qes/digicert-tsa.pem` | cesty k rootům TSA; povinné když je `QES_TSA_URL` nastavené |
| `QES_TSA_REQUIRED` | `true` | vyžadovat TSA token |
| `QES_REQUIRE_LTV` | `true` | vyžadovat revokační data pro certy bez CRL DP; staging/testy `false` |
| `QES_LTV_ALLOWED_HOSTS` | `crl.postsignum.cz,crl2.postsignum.cz,crl.postsignum.eu,qcrldp1.ica.cz,qcrldp2.ica.cz,crldp1.ica.cz,crldp2.ica.cz` | allowlist hostů pro CRL (SSRF ochrana; čárkou oddělené); prázdná hodnota = jen https a veřejná adresa (pro I.CA s http CRL DP nestačí); explicitní ENV default plně nahradí |
| `QES_IOS_TEAM_ID` | — | pro AASA |
| `QES_EXPIRY_JOB_INTERVAL` | `60` | perioda expiračního jobu [s]; `0` = vypnuto |
| `QES_COMPLETED_SESSION_TTL` | `86400` | platnost dokončeného tokenu [s] (24 h) |
| `QES_TEST_CRL_PATH` | — | test CRL vystavený na `/qes-test/root.crl` (jen staging) |
| `QES_PDF_MAX_BYTES` | `26214400` | max. velikost PDF pro přímý podpis [B] |

Plánování expiračního jobu: fork nemá `sidekiq-cron` a nové závislosti jsou zakázané (§ 22), proto se
`Qes::ExpireSessionsJob` plánuje sám sebou: inicializér při bootu zařadí první běh a job na konci přeplánuje
`perform_in(QES_EXPIRY_JOB_INTERVAL)`; duplicity po restartu vylučuje idempotentní klíč `qes_expire_sessions`
přes `LockEvent` (§ 7.8).

Pro testy a staging: `QES_TRUST_ROOTS=test/certs/pki/root.crt` (AdES/QES fixtures) a
`QES_VERIFICATION_TRUST_ROOTS=test/certs/pki/root.crt` (verification fixtures); produkční instance I.CA rooty;
`QES_TSA_URL` prázdné v CI (testy bez TSA), FreeTSA/I.CA jen lokálně/produkční instance.

Appka (Expo) má vlastní konfiguraci: `EXPO_PUBLIC_API_URL` (server URL), `EXPO_PUBLIC_QES_FAKE_CARD`
(dev mód pro variantu A bez hardwaru). Tajemství jen přes `fly secrets` / `.env`; **NESMÍ** být v repu.

---

## 12. Bezpečnostní model

| Hrozba | Opatření |
|---|---|
| Krádež tokenu z logu/URL | token jednorázový, TTL 10 min, v DB jen sha256, `Referrer-Policy: no-referrer`, token nikdy v logu |
| Záměna dokumentu (MITM) | `data_to_sign` obsahuje `message-digest`; server po podpisu ověří signaturu i digest |
| Appka pošle cizí signaturu | ověření `OpenSSL::PKey#verify` proti certifikátu a `signed_attrs_der` |
| Appka pošle cizí/nekvalifikovaný certifikát | kontrola `key_location` × `QcSSCD`, platnost, `keyUsage` |
| Replay tokenu | jednorázové použití (`state`); opakované volání → `410 used_token` |
| DoS na endpointy | rate limiting (§ 5), max 1 aktivní session na submittera |
| Únik klíče z telefonu | AES-GCM + SecureStore + biometrie; klíč nikdy neopustí zařízení |
| PIN/QPIN v logu | appka PIN neukládá ani neloguje; SDK zobrazuje vlastní dialog |
| Záměna AdES za QES | kontrola QCStatements + `level_mismatch`/`qes_required_qscd` |
| Podvržení pečeti | pečeť je samostatná signatura, ověřitelná zvlášť; audit zapíše obě |
| Únik dokumentu do třetí země | region `fra`, data jen v EU, staging jen testovací data |
| Únik PDF na server (přímý podpis) | přijato uživatelem (docs/15 D2); server vidí obsah, nikdy klíč; offline core mimo v1 |
| Zneužití API tokenu (přímý podpis) | token per-user a revokovatelný; rate limit; `QES_ENABLED`; limit velikosti; TTL session |
| Cizí draft v účtu (přímý podpis) | `create`/`preview`/`place` ověřují `account_id` session (jinak `404`) |

---

## 13. Audit a dokladování

`QesSession` **MUSÍ** uchovávat pro každý podpis:
- `certificate_info` (subject, issuer, serial, platnost, QCStatements, key type/size),
- `signed_attrs_der`, `signature` (raw), `document_digest`, `signed_pdf_sha256`, `final_pdf_sha256`,
- `level`, `key_location`, `provider`, `app_metadata` (self-reported platforma a verze appky),
- časy všech přechodů, `validation_report`, `seal_state`.

Audit trail PDF **MUSÍ** obsahovat stránku QES (§ 7.7) s těmito údaji a s upozorněním, že jde
o kvalifikovaný/zdokonalený podpis podle zjištěné úrovně.

Hodnoty v `submitter.values[qes_uuid]` **MUSÍ** být `"qes:<session_id>"`, aby bylo možné dohledat
session z UI a DB. Rozšíření `GET /api/submissions/:id` o `qes` metadata je **mimo v1** (§ 17 #6);
dohledání je v v1 možné přes `QesSession` v DB a hodnotu pole (kontrolu formátu řeší § 4.4).

V UI se hodnota `qes:<id>` **NESMÍ** zobrazovat jako text: v podpisovém formuláři i v kartě
podepisujícího se místo ní vykreslí přehled podpisu (`submit_form/_qes_summary.html.erb` — platnost, úroveň,
subject/issuer/serial certifikátu, umístění klíče, čas podpisu, validace, pečeť). Pro pole aktuálního
podepisujícího vrací stejný HTML `GET /s/:slug/qes_sessions/:id` jako `summary_html` (Vue `qes_summary.vue`);
pro pole předchozích podepisujících ho vykresluje `submissions/_value.html.erb`. V **poli dokumentu**
(omezená výška) se používá zkrácená varianta (`compact: true` — ikona, úroveň, podepisující, certifikát,
bez issuer/serial a auditu) s podbarvením a `overflow-hidden`; plná varianta zůstává v kartě podepisujícího.
Třídy přehledu **MUSÍ** být v CSS balíčku `form` (content glob `tailwind.form.config.js` zahrnuje
`app/views/submit_form`, kde partial přehledu žije).

---

## 14. Integrační body do DocuSealu

Stav forku při měření (2026-10-28, `vendor/docuseal`, větev `dokulachtan`, base `8f8f69f0`) —
**21 modifikovaných upstream souborů**, +199/−33 řádků. Čísla jsou měřená
`git diff upstream/master...HEAD --numstat`; všechny nové soubory jsou mimo upstream
(`app/lib/qes/**`, controllery, views, i18n, migrace).

| # | Soubor | Změna | +/− |
|---|---|---|---|
| 1 | `db/schema.rb` | regenerovaný (obsahuje `qes_sessions` a migrace) | 48/1 |
| 2 | `lib/submissions/generate_result_attachments.rb` | hook na podepsané PDF + `base:`/`page_offsets:` | 27/13 |
| 3 | `app/javascript/template_builder/builder.vue` | save error + `withQes` | 25/1 |
| 4 | `app/javascript/submission_form/form.vue` | krok `QesStep` | 22/1 |
| 5 | `app/javascript/submission_form/area.vue` | oblast kroku v podpisovém formuláři | 13/1 |
| 6 | `spec/system/signing_form_spec.rb` | 2FA flake (test-only) | 12/2 |
| 7 | `app/javascript/template_builder/field_context_menu.vue` | volba AdES/QES | 9/1 |
| 8 | `app/controllers/api/submitters_controller.rb` | lock + boolean + hook | 8/2 |
| 9 | `app/javascript/template_builder/field_type.vue` | ikona + název typu `qes` | 8/4 |
| 10 | `lib/submitters/submit_values.rb` | hooky + `prepend` | 6/2 |
| 11 | `app/views/submissions/show.html.erb` | přehled podpisu v kartě | 4/0 |
| 12 | `app/views/submissions/_value.html.erb` | přeskočit `qes` pole (`return`) | 4/0 |
| 13 | `lib/submissions/generate_combined_attachment.rb` | early-return hook + `template.schema` fallback | 3/1 |
| 14 | `lib/submissions/generate_audit_trail.rb` | QES stránka v auditu | 2/0 |
| 15 | `lib/api_path_consider_json_middleware.rb` | multipart pro upload/ověření PDF | 2/1 |
| 16 | `app/javascript/application.js` | `withQes` | 1/0 |
| 17 | `app/views/templates/show.html.erb` | panel ověření PDF | 1/0 |
| 18 | `app/javascript/template_builder/dynamic_insert_menu.vue` | gate | 1/1 |
| 19 | `app/javascript/template_builder/fields.vue` | gate | 1/1 |
| 20 | `app/views/templates/edit.html.erb` | banner při chybě šablony | 1/1 |
| 21 | `app/views/templates_preview/show.html.erb` | flash při chybě šablony | 1/1 |

**Pravidlo:** historie forku je rozdělená na logické bloky (feature commity), ne na jednotlivé
doteky; každý blok drží jednu featuru včetně jejích doteků upstreamu a testů. Cílem je
**< 10 řádků na dotek**, výjimky jsou zdůvodněné níže.

**Odůvodněné výjimky** (nejde splnit bez rozbití upstream struktury): `generate_result_attachments`
(PDF seam `base:`/`page_offsets:`), `builder.vue` (save error + `withQes`), `form.vue`/`area.vue`
(krok a oblast formuláře), `db/schema.rb` (generovaný), `generate_combined_attachment.rb`
(fallback `template.schema`). `lib/verify_pdf_signature.rb` je **bit-identický s upstreamem**
(nulový diff); orchestrace je v `Qes::PdfiumTrust.report`.

**Testy doteků:** `spec/lib/qes/upstream_contract_spec.rb` hlídá kontrakty upstream souborů
(signatury, metody, `Struct`, sloupce, routes), `spec/requests/qes_views_spec.rb` doteky ve views
a `spec/javascript/qes_step_logic.test.mjs` JS logiku kroku — rebase, který je tiše rozbije, spadne
tady, ne až na stagingu.

---

## 15. Testy a kritéria přijetí

### 15.1 Fork — RSpec (běží v `make qes-test`)

Harness: **`make qes-test` na SQLite** (stejná DB jako staging) — test image `test/qes/Dockerfile`
(`docuseal:latest` + dev/test gemy, Ruby 4.0.5, `libpdfium.so`) a system image `test/qes/Dockerfile.system`
(+ `chromium`); `PRIMARY_DATABASE_URL=sqlite3:db/qes-test.sqlite3`, `SCHEMA=tmp/qes-test-schema.rb`
(chrání `db/schema.rb`), `make qes-test-assets` (assety z produkčního image pro `spec/system`).
**`make qes-test-postgres`** pustí celou sadu na Postgresu 18 (parita s upstream CI). QES vrstva
**MUSÍ** být DB-agnostická (§ 22). Změřené výsledky a pasti: `test/qes/README.md`.

Konkrétní testovací případy (describe/it) jsou v příloze B (§ 19). Souhrn:

| Oblast | Test | Kritérium |
|---|---|---|
| Model | `spec/models/qes_session_spec.rb` | přechody stavů, expirace, token digest (drží se do retence), 1 aktivní session |
| Certifikát | `spec/lib/qes/certificate_info_spec.rb` | QCStatements → level (AdES/QES/none), expirace, keyUsage |
| CMS | `spec/lib/qes/cms_builder_spec.rb` | `signed_attrs_der` je byte-identical při opakovaném `prepare`; `message-digest` = SHA-256 ByteRange; placeholder délka |
| Embed | `spec/lib/qes/embed_spec.rb` | vložený CMS je platná PAdES-B-B (fixtures), ByteRange pokrývá celý dokument |
| LTV | `spec/lib/qes/ltv_spec.rb` | CRL v DSS s VRI; offline validace trusted |
| Validace | `spec/lib/qes/validator_spec.rb` | INTACT/UNTRUSTED, tamper → `intact=false`, chybějící pokrytí → fail |
| Úroveň | `spec/lib/qes/level_spec.rb` | AdES vs QES vs none; `qes` bez QcSSCD → reject |
| API | `spec/requests/qes_sessions_spec.rb` | token jednorázový, TTL, `410`, rate limit, autorizace `/s/:slug` |
| Hook | `spec/lib/submissions/generate_result_attachments_spec.rb` | QES submission → `documents` = podepsané PDF, nevykresluje `qes` |
| Audit | `spec/lib/submissions/generate_audit_trail_spec.rb` | QES stránka obsahuje cert/čas/hash/level/validaci |
| Hodnota pole | `spec/lib/qes/value_validator_spec.rb` | podvržená hodnota `qes` → `ValidationError`; platná `qes:<id>` s `completed` session projde |
| Šablona | `spec/models/template_spec.rb` | `qes` pole + kreslený podpis → `qes_all_signers_required`; paralelní `order` → `qes_parallel_signers_not_allowed`; chybějící pořadí → `qes_signing_order_required` |
| Doteky upstreamu | `spec/lib/qes/upstream_contract_spec.rb` | signatury/metody/struct upstreamu, na které fork nasedá (rebases je nesmí tiše rozbít) |
| Doteky ve views | `spec/requests/qes_views_spec.rb` | plný přehled v kartě + zkrácený v poli; QES stránka v auditu |
| Dotek JS | `spec/javascript/qes_step_logic.test.mjs` | `ERROR_KEYS`, polling/backoff, terminální stavy kroku |
| Řetězení | `spec/lib/qes/chain_spec.rb` | 2 signeři: TBS 2 nad `final_document` signera 1; oba podpisy INTACT; poslední pokrývá celý soubor; varianta se 2 přílohami (`page_offsets`); **stejný submitter 2× se stejným certifikátem** → TBS 2 nad jeho `final_document`, 6 signatur INTACT, `documents` = poslední revize |
| Pořadí | `spec/models/submission_spec.rb` | `submitters_order: random` u QES šablony → vynuceno `preserved` |
| Well-known | `spec/requests/qes_well_known_spec.rb` | AASA `Content-Type: application/json`; `assetlinks.json` → 404 (App Links zrušeny) |

### 15.2 E2E — `make qes-e2e` (nahradil `scripts/e2e_api.py`)

1. Nahraje šablonu s polem `qes` (přes `rails runner`).
2. Vytvoří submission přes API.
3. Simuluje appku: `GET /qes/sessions/:token` → `POST /certificate` s PKCS#12, které má
   `QcCompliance` (`test/certs/pki/signer-ades.p12`, heslo `test`; generuje `scripts/make_test_pki_crl.py`)
   → podepíše `data_to_sign` raw RSA (`cryptography`) → `POST /complete`.
   S necertifikovaným `test/certs/signer.p12` (bez QCStatements) server správně vrátí `422 not_qualified` (§ 5.2).
4. Stáhne finální PDF: `GET /api/submissions/:id/documents` (**bez** `merge=true` → vrací `documents`
   s `final_document`; `merge=true` vrací `merged_document` a testuje jím § 7.6 bod 4).
5. Validuje **podepsaný dokument před pečetí** (`signed_document`):
   `pyhanko sign validate --trust test/certs/pki/root.crt` → `INTACT:TRUSTED,UNTOUCHED`
   s pokrytím celého dokumentu; `pdfsig` → „Signature is Valid." a „Total document signed";
   `qpdf --check` bez chyb. (Pro self-signed fixture `test/certs/signer.p12` je trust root
   `test/certs/signer.cert.pem`; `test/certs/ica/*` slouží pro testy s reálnými I.CA řetězy.)
6. Validuje **finální PDF po pečeti**: obsahuje **dvě** signatury (appka + pečeť DocuSealu),
   poslední (pečeť) pokrývá celý soubor a podpis appky zůstává `INTACT` (žádné nepodepsané
   změny v jeho revizi); totéž platí pro `combined_document` (kopie bez dalšího podpisu, § 7.6 bod 4).
7. Ověří audit trail PDF (QES stránka) a `validation_report`.

**E2E pro dva podpisy jednoho dokumentu (v1.5):** `make qes-e2e-two` (nebo `QES_E2E_SIGNERS=2 make qes-e2e`)
spustí bootstrap se 2 submitters (šablona `submitters_order: preserved`, každý s vlastním polem `qes`)
a obřad pro každého zvlášť v pořadí. Kritéria navíc:
- `qes-final.pdf` má **2 podpisy appky + 2 pečeti + 2 DocTS** (6 signatur), všechny `INTACT`,
- poslední signatura pokrývá celý soubor, první dvě revize zůstávají UNTOUCHED,
- `documents` signera 1 obsahuje revizi 1 (1 podpis + 1 pečeť), `documents` signera 2 revizi 2 (2 + 2),
- `combined_document` = revize 2,
- pokus o `POST /s/:slug/qes_sessions` pro signera 2 před dokončením signera 1 → `409 awaiting_previous_signer`,
- `pyhanko validate` bez `--fetch` označí podpisy appky jako `INTACT:TRUSTED`; pečeti DocuSealu
  jako `INTACT:UNTRUSTED` (vlastní ESIGN cert, trust roots QES se na ně nevztahují).

**Stejný podepisující, víc polí `qes` (v1.5):** pokryto RSpec testem `chain_spec.rb`
(„lets the same submitter sign twice with the same certificate“) — druhý TBS navazuje na první finální PDF
téhož podepisujícího, 6 signatur `INTACT`, `documents` = poslední revize. E2E skript `qes_e2e.py`
tento scénář neověřuje (bootstrap dělá jedno pole na submittera); na stagingu ho ověřuje
`make qes-staging-same-signer` (`scripts/qes_staging_same_signer_check.py`, 6 signatur `INTACT`).
Texty kroku `QesStep` (`Podepsáno ({level})`, `Odkaz vyprší za {minutes} min`) **MUSÍ** skládat sám
`qes_step.vue` (`doneText`/`expiresInText`), protože kořenový `t` v `form.vue` neinterpoluje.

Negativní scénáře (rozšíření `scripts/negative_tests.py`):

- `make qes-negative` spustí `scripts/qes_negative_tests.py` proti forku (N1–N17) → `test/out/qes-negative-report.txt`;
  N10–N17 pokrývají přímý podpis PDF (docs/15 § 8).
- `make qes-e2e` a `make qes-e2e-two` jsou pozitivní scénáře (1 a 2 signeři).

| # | Scénář | Kritérium ||---|---|---|
| N1 | přepis byte v TBS PDF po `prepare` | `422 signing_context_mismatch`, session `failed` |
| N2 | cizí signatura | `422 signature_invalid` |
| N3 | expirovaný certifikát | `422 certificate_expired` |
| N4 | revokovaný certifikát | `422 revoked`, session `failed` |
| N5 | AdES certifikát u pole `preferences.level=qes` | `422 qes_required_qscd` |
| N6 | QcSSCD certifikát s `key_location=phone_keystore` | `422 level_mismatch` |
| N7 | expirovaný token | `410 expired_token` |
| N8 | opakované použití tokenu | `410 used_token` |
| N9 | změna PDF po vložení | validace `intact=false` |

**Staging e2e se dvěma signery (v1.5):** `make qes-staging-e2e` (`QES_STAGING_SIGNERS=2`)
provede bootstrap, obřad a dokončení na <https://dokulachtan-staging.fly.dev> přes `fly ssh console`
a podepíše KÓDEM APPKY; finální PDF se stáhne a validuje. Kritéria: 6 signatur
(2× appka + 2× pečeť + 2× DocTS), všechny INTACT, `documents` signera 1 = 3, signera 2 = 6;
`openssl verify` test certu proti test trust rootu = OK. **Staging:** test CRL je na
`https://dokulachtan-staging.fly.dev/qes-test/root.crl` (`QES_TEST_CRL_PATH`), takže LTV data
jsou dostupná; pečeť DocuSealu zůstává `UNTRUSTED` (test trust list neobsahuje její cert).

### 15.3 Appka — testy

- **Unit (Jest)**: `level.ts` (QCStatements), `vault.ts` (AES-GCM round-trip a **přešifrování po importu**),
  `signer.ts` (**automatická** volba podepisujícího dle § 9.8: pro QES čtečka, pro AdES klíč → čtečka → wizard),
  `p12.test.ts` (import odmítne PKCS#12 s `QcSSCD`), `api.ts` (chybové stavy).
- **Bez hesla při podpisu**: test, že podpis vyžaduje jen biometrii (žádné zadání hesla k PKCS#12).
- **Dev fake card**: `EXPO_PUBLIC_QES_FAKE_CARD=1` nahradí `cardSigner` testovacím PKCS#12
  (stejné rozhraní jako MOI SDK) → test celého A toku bez hardwaru.
- **Manuální (A)**: reálná čtečka + eObčanka — protokol v příloze C (§ 20.1).
- **Manuální (B)**: import PKCS#12 z iSignum, biometrie, podpis, validace — příloha C (§ 20.2).
- **Emulátor (Android)**: deep link, síťové chyby, expirace tokenu, chybové obrazovky.
- **Texty**: jednotné řetězce v příloze D (§ 21).

### 15.4 Akceptační kritéria (Definition of Done)

1. `make verify`, `make qes-test` (SQLite) a `make qes-test-postgres` (Postgres 18) zelené (fork RSpec + fixtures).
2. `make qes-e2e` zelené: finální PDF v DocuSealu má **platný podpis podepisujícího**
   (`signed_document` před pečetí: `pyHanko` → `INTACT:TRUSTED,UNTOUCHED` s pokrytím celého dokumentu,
   `pdfsig` → valid), **druhou** signaturu (pečeť DocuSealu) a **třetí** (DocTS) v pozdějších
   revizích; poslední pokrývá celý finální soubor.
2b. `make qes-e2e-two` zelené: **dva podpisy jednoho dokumentu** — 6 signatur (2× appka + 2× pečeť + 2× DocTS),
   všechny `INTACT`, poslední pokrývá celý soubor, gating pořadí vrací `409 awaiting_previous_signer`.
3. Audit trail obsahuje QES stránku se subject/issuer/serial, časem, hashem, úrovní a výsledkem validace.
4. Negativní scénáře N1–N17 mají očekávané výsledky.
5. Appka (B): import PKCS#12, biometrie, podpis → validace na serveru (e2e na emulátoru s test certem).
6. Appka (A): fake card mód testuje celý tok; manuální test s reálnou čtečkou a eObčankou zdokumentován.
7. iOS Universal Links (AASA) ověřené; Android jde přes custom scheme + systémový chooser.
8. AdES **NIKDY** není zapsán jako QES (test N5/N6 + kontrola auditu).
9. Staging `https://dokulachtan-staging.fly.dev/` běží s `QES_ENABLED=true` a healthcheckem;
   `make qes-staging-e2e` se dvěma signery projde (6 signatur INTACT, test cert
   ověřený vůči test trust rootu; test CRL je na staging hostu, pečeť zůstává UNTRUSTED).
10. Dokumentace: SPEC.md, PLAN.md, `docs/10-qes.md` (provozní runbook) a README aktualizované.
11. Appka volí podepisujícího **automaticky** dle § 9.8 (pro QES čtečka, pro AdES klíč → čtečka → wizard)
    a při podpisu se **nikdy** nezadává heslo k PKCS#12 (test v § 15.3).

### 15.5 Přímý podpis PDF — testy a kritéria

- **RSpec** (`make qes-test-qes`): `spec/requests/qes_documents_spec.rb` — upload PDF (`201` s `template_id`,
  polem a náhledy; `401` bez tokenu; `422 invalid_pdf`/`file_too_large`/`encrypted_pdf`/`already_signed`/
  `invalid_level`; spuštění obřadu přes `/s/:slug/qes_sessions` s API tokenem); stávající QES specy musí
  zůstat zelené.
- **E2E** `make qes-e2e-pdf` (`scripts/qes_pdf_e2e.py`): bootstrap účtu + API token,
  upload PDF (`POST /api/qes/documents`), náhled stránky, `PATCH` oblast pole, submission,
  spuštění obřadu, podpis **kódem appky** (`scripts/qes-app-e2e.ts`, reuse), `POST /qes/sessions/:token/complete_submission`
  (session token, § 5.3.1), stažení finálního PDF, validace `pyhanko` (`INTACT:TRUSTED`, pokrytí celého
  dokumentu), `pdfsig`, `qpdf --check`; report `test/out/qes-pdf-e2e-report.txt`. Ověří se i to, že dokument
  je ve složce „Direct signing“, pole má hodnotu `qes:<id>` a vznikla auditní stránka.
- **Negativní** (N10–N17, `make qes-negative`): upload bez tokenu → `401`; ne-PDF → `422 invalid_pdf`;
  příliš velké → `422 file_too_large`; šifrované → `422 encrypted_pdf`; už podepsané → `422 already_signed`;
  nepodporovaná úroveň → `422 invalid_level`; cizí API token → `403`; druhé spuštění obřadu zruší první.
- **Akceptační kritéria**: (1) `make qes-test-qes` zelené; (2) `make qes-e2e-pdf` zelené
  (3 signatury: appka + pečeť + DocTS, podpis appky `INTACT:TRUSTED` s pokrytím celého dokumentu,
  pečeť na klepnutém místě, dokument ve složce „Direct signing“ s auditní stránkou);
  (3) `make qes-e2e` a `make qes-e2e-two` beze změny; (4) N10–N17 mají
  očekávané výsledky; (5) appka na emulátoru: výběr PDF → náhled → klepnutí → podpis → stažení a sdílení.

---

## 16. Opravy DESIGN.md a docs/04 (zapracováno)

Při psaní specifikace se ukázalo, že některá tvrzení v DESIGN.md/docs/04 byla nesprávná nebo
neúplná. **DESIGN.md byl opraven** (níže je historie, aby se dal dohledat původ rozhodnutí).
Oba dokumenty teď musí být v souladu; případný další rozpor je chyba, která se opraví v DESIGN.md.

| # | Co bylo v DESIGN/docs/04 | Skutečnost | Jak je to teď |
|---|---|---|---|
| 1 | `Qes::Providers::Pkcs11` (server-side A) | Server PKCS#11 neimplementuje; A je client-side (MOI SDK v appce) | Provider je jen `mobile_app` + `mock`; A/B se liší `key_location` |
| 2 | HexaPDF umí LTV (`add_validation_info`) | **HexaPDF 1.7 LTV neumí** (ověřeno v zdrojích 1.7–1.11) | LTV řeší `Qes::Ltv` + `Qes::Dss` (CRL v DSS) |
| 3 | `GET /qes/sessions/:token` vrací `data_to_sign` | Server nezná certifikát podepisujícího předem | Dvoukrokový protokol: `POST /certificate` → `data_to_sign` |
| 4 | `Qes::Provider#level` je vlastnost providera | Úroveň plyne z certifikátu, ne z providera | `level`/`key_location` jsou na `QesSession` (§ 8) |
| 5 | `QesSession#signed_attrs` (text) | DER bajty | `signed_attrs_der` (binary) |
| 6 | Combined dokument se nestaví ze stránek | Platí; pro QES = kopie podepsaného PDF (+ pečeť) | § 7.7 |
| 7 | `QES_LEVEL_CHECK` (globální ENV) | Úroveň je per-field (`preferences.level`) | AdES/QES se řídí polem, ne globálním ENV |
| 8 | `qes` pole i ve vícesignatářské šabloně | **v1.5 podporuje** — řetězení PAdES revizí; všichni signeři mají `qes` pole a striktní pořadí | § 4.1, § 4.6, § 7.1 |
| 9 | Deep link `dokulachtan://sign?token=…&server=<origin>` | Server URL se bere z odkazu (HTTPS host, custom scheme `server`); Nastavení je jen pro přímý podpis PDF a ověření PDF | Jeden zdroj pravdy pro workflow, žádné použití Nastavení pro podpisové odkazy |
| 10 | Stav `awaiting_signature` chyběl | Certifikát přichází až po otevření appky | DESIGN § 3.3 |
| 11 | Heslo k PKCS#12 se použije i při podpisu | Při podpisu se zadává jen biometrie; heslo jen při importu (klíčový materiál se ihned přešifruje AES-256-GCM) | SPEC § 9.5 |
| 12 | Appka neměla rozhodnutí, kterou cestou podepsat | Volba lokálně: klíč → čtečka → wizard (S10); server cert nezná | SPEC § 9.8 |
| 13 | Pečeť až po posledním QES podpisu (návrh docs/13) | **Zamítnuto** — vyžadovalo by regeneraci `documents` všech signeřů; pečeť zůstává po každé session | SPEC § 7.6 |
| 14 | Vlastní vykreslování polí na merged základ (místo upstream) | **Zamítnuto** — duplikace ~250 řádků `fill_submitter_fields`; místo toho `page_offsets` (2 řádky upstream) | SPEC § 7.1, § 7.7 |
| 15 | Přímý podpis PDF bez submission | **Schváleno 2026-10-18, přepsáno 2026-10-18**: nativní DocuSeal tok (šablona s polem `qes` + submission), fork přidává jen `POST /api/qes/documents`; dokument je v účtu vidět, pečeť umístěná klepnutím; server vidí PDF, klíč ne | SPEC § 4.8, § 5.8, § 9.9, docs/15 |
| 16 | Náhled stránky pro umístění pečeti | **Server** (Pdfium + Vips, stejná mašinérie jako DocuSeal preview); appka nemá PDF renderer | SPEC § 5.8.2, § 9.9 |
| 17 | Offline core (přímý podpis bez serveru) | **Mimo v1** — appka má rozhraní `SessionSource`, takže jde doplnit později bez změny obřadu | docs/15 § 2 (D12) |
| 18 | `QES_PDF_PREVIEW_JPEG` (docs/15 § 5.2) | **Nezavádí se** — v1 je vždy PNG (docs/15 D11: jediný nový ENV je `QES_PDF_MAX_BYTES`) | SPEC § 5.8.2 |
| 19 | Upload ověřuje `content_type` a `level_required` | docs/15 § 5.1 žádá obojí; SPEC to nezmiňoval | SPEC § 5.8.1 (`422 invalid_pdf` / `422 invalid_level`) |
| 20 | Analýza nahraného PDF (`Qes::PdfSource`) | docs/15 § 6 uváděl jen `page_preview.rb`; normalizace rotace a validace patří do jednoho místa | SPEC § 4.8 (`Qes::PdfSource`) |
| 21 | Vlastní tabulka `qes_pdf_sessions` a vlastní pipeline pro přímý podpis | **Zamítnuto 2026-10-18** (rozhodnutí uživatele: minimum vlastního kódu) — přímý podpis jede standardním DocuSeal tokem: šablona s polem `qes`, submission, běžný obřad; fork přidává jen nahrání PDF a API token pro spuštění obřadu | docs/15, SPEC § 4.8 a § 5.8 |
| 22 | TBS PDF a `document_digest` v `GET /qes/sessions/:token` | **Opraveno 2026-10-22**: pevná rezerva 20 000 B nestačila na reálný CMS — CRL PostSignum Qualified CA 4 má 812 863 B a do CMS jde 2× (ETSI + Adobe), tj. ~1,63 MB; reálný certifikát končil `signature_size_exceeded` | TBS se staví až po přijetí certifikátu, rezerva = `Qes::CmsBuilder.estimate_size` + `QES_SIGNATURE_SIZE_MARGIN`; `document_digest` se počítá tamtéž (§ 7.1, § 11). **Od 2026-10-27** nahrazeno pevnou rezervou `QES_SIGNATURE_RESERVE` a TBS se staví **před** certifikátem (§ 5.1a); `estimate_size`/`SIGNATURE_SIZE_MARGIN` odstraněny. |
| 23 | LTV v CMS (ETSI `RevocationValues` + Adobe `RevocationInfoArchival`) | **Změněno 2026-10-22**: pyHanko unsigned atributy nečte (čte DSS a signed Adobe revinfo); CRL v CMS byl 2× ~813 kB a zvětšoval PDF; Adobe LTV používá DSS VRI | Revokační data jen v DSS s VRI, krytá DocTS (§ 7.4, § 7.6) |
| 24 | Generátor výsledného PDF se vybírá podle šablony (`Qes.active_for?`) | **Opraveno 2026-10-29 (nález #3)**: rozhoduje dokončená QES session, ne pole v šabloně — volitelné `qes` pole bez podpisu vracelo prázdné `documents`; `QES_ENABLED` zůstává feature gate | § 7.7 |

Kde je co v DESIGN.md opravené (řetěz DESIGN → SPEC):
- § 3.1 — `preferences.level` (per-field), vícenásobní signeři a řetězení revizí,
- § 3.2 — atributy `QesSession` (`signed_attrs_der`, `certificate_chain`, `final_document`, `seal_state`, `app_metadata`),
- § 3.3 — stavový automat včetně `awaiting_signature`,
- § 4 — kroky 5–9 (dvoukrokový protokol) + odstavec „Více podepisujících“,
- § 5.1 — obrazovky S1–S9, § 6 — varianta A přes MOI Podpisové SDK,
- § 7.1 — seznam souborů, § 7.2 — endpointy, § 7.3 — LTV v CMS, § 7.4 — pečeť, řetězení a kritérium hotovo,
- § 8.1 — deep link bez `s`, § 8.2 — payload ve dvou krocích, § 8.4 — konfigurace,
- § 12 #14 — vícenásobné digitální podpisy (firemní podpisy).

---

## 17. Otevřené otázky (mimo v1)

1. Push notifikace (`expo-notifications`) — až F2+.
2. Hromadné podepisování více dokumentů jedním obřadem (jeden dokument s více podpisy je v rozsahu, § 4.6).
3. Více certifikátů v appce (v1: import nahrazuje; u A výběr kontejneru je povinný).
4. iOS build + Universal Links na produkční instanci (potřebuje macOS/Xcode).
5. Desktop varianta A (lokální agent) — zvážit později.
6. `GET /api/submissions/:id` rozšíření o QES metadata.
7. DSS / ETSI conformance checker jako noční CI job (v1 stačí pyHanko + pdfsig).

---

## 18. Příloha A — struktura souborů a odpovědnosti

Nové soubory forku (vše v `app/lib/qes/` — Rails autoloaduje `app/**`):

| Soubor | Odpovědnost | Test |
|---|---|---|
| `app/lib/qes/providers/mobile_app.rb` | varianta B i A (společná cesta: appka podepíše signed attrs) | `spec/lib/qes/upstream_contract_spec.rb`, `spec/requests/qes_sessions_spec.rb` |
| `app/lib/qes/providers/mock.rb` | testy (PKCS#12 z fixtures) | `spec/lib/qes/pipeline_spec.rb` |
| `app/lib/qes/value_validator.rb` | kontrola formátu hodnoty `qes` (§ 4.4) | `spec/lib/qes/value_validator_spec.rb` |
| `app/lib/qes/session_manager.rb` | stavový automat (§ 4.3) | `spec/models/qes_session_spec.rb` |
| `app/lib/qes/token.rb` | generování a hash tokenu | `spec/lib/qes/token_spec.rb` |
| `app/lib/qes/tbs_document.rb` | TBS PDF: základ (šablona / finální PDF předchůdce) + podpisové pole | `spec/lib/qes/chain_spec.rb`, `spec/lib/qes/pipeline_spec.rb` |
| `app/lib/qes/stamp.rb` | viditelná pečeť podepisujícího (§ 7.1) | `spec/lib/qes/chain_spec.rb` |
| `app/lib/qes/cms_builder.rb` | CMS placeholder → signed attrs → finální CMS | `spec/lib/qes/pipeline_spec.rb` |
| `app/lib/qes/placeholder_signed_data_creator.rb` | podtřída `SignedDataCreator` (zachytí signed attrs) | `spec/lib/qes/pipeline_spec.rb` |
| `app/lib/qes/certificate_info.rb` | QCStatements, level, keyUsage, platnost | `spec/lib/qes/certificate_info_spec.rb` |
| `app/lib/qes/ltv.rb` | CRL pro DSS (SSRF allowlist) | `spec/lib/qes/ltv_spec.rb` |
| `app/lib/qes/dss.rb` | DSS slovník s VRI | `spec/lib/qes/dss_spec.rb` |
| `app/lib/qes/doc_timestamp.rb` | DocTS (PAdES-LTA) | `spec/lib/qes/doc_timestamp_spec.rb`, `spec/lib/qes/lta_spec.rb` |
| `app/lib/qes/timestamp_token.rb` | RFC 3161 token (TSTInfo v `eContent`) | `spec/lib/qes/validator_spec.rb`, `spec/lib/qes/verifier_spec.rb` |
| `app/lib/qes/validator.rb` | Pdfium + pokrytí + úroveň + digest | `spec/lib/qes/validator_spec.rb` |
| `app/lib/qes/verifier.rb` | report pro ověření PDF (docs/16) | `spec/lib/qes/verifier_spec.rb` |
| `app/lib/qes/verified_documents.rb` | uložení ověřeného PDF do „Verified documents“ | `spec/requests/qes_verifications_spec.rb` |
| `app/lib/qes/pdf_source.rb` | kontrola PDF (šifrované/už podepsané) a normalizace rotace | `spec/requests/qes_documents_spec.rb` |
| `app/lib/qes/embed.rb` | vložení CMS do TBS PDF | `spec/lib/qes/pipeline_spec.rb` |
| `app/lib/qes/seal.rb` | inkrementální pečeť DocuSealu | `spec/lib/qes/lta_spec.rb` |
| `app/lib/qes/result_attachments.rb` | hook: finální PDF → `documents` | `spec/lib/qes/chain_spec.rb` |
| `app/lib/qes/audit_page.rb` | stránka QES v audit trailu | `spec/lib/qes/upstream_contract_spec.rb` |
| `app/lib/qes/controller_concern.rb` | společné chování QES controllerů | `spec/requests/qes_sessions_spec.rb` |
| `app/lib/qes/pdf_upload.rb` | validace nahrávaného PDF | `spec/requests/qes_documents_spec.rb` |
| `app/lib/qes/link.rb` | odkaz do appky | `spec/requests/qes_sessions_spec.rb` |
| `app/models/qes_session.rb` | model, enum stavů, scopes | `spec/models/qes_session_spec.rb` |
| `app/controllers/qes/sessions_controller.rb` | app-facing (token) endpointy | `spec/requests/qes_sessions_spec.rb` |
| `app/controllers/qes/form_sessions_controller.rb` | browser-facing endpointy | `spec/requests/qes_sessions_spec.rb` |
| `app/controllers/qes/app_controller.rb` | web fallback stránka | — |
| `app/controllers/qes/well_known_controller.rb` | AASA s `Content-Type: application/json` (§ 6.6) | `spec/requests/qes_well_known_spec.rb` |
| `app/controllers/api/qes_documents_controller.rb` | nahrání PDF → šablona s polem `qes` (§ 5.8.1) | `spec/requests/qes_documents_spec.rb` |
| `app/controllers/api/qes_verifications_controller.rb` | ověření PDF (docs/16) | `spec/requests/qes_verifications_spec.rb` |
| `app/controllers/templates_qes_verifications_controller.rb` | panel ověření PDF | `spec/requests/qes_verifications_spec.rb` |
| `app/jobs/qes/expire_sessions_job.rb` | expirace sessions | `spec/jobs/qes/expire_sessions_job_spec.rb` |
| `app/views/qes/app/show.html.erb` | fallback HTML (QR, tlačítko) | — |
| `app/views/templates/_qes_verification.html.erb` | panel ověření PDF | `spec/requests/qes_verifications_spec.rb` |
| `app/javascript/submission_form/qes_step.vue` | krok v prohlížeči (§ 6.5) | `spec/javascript/qes_step_logic.test.mjs` (logika) |
| `app/javascript/submission_form/qes_step_logic.mjs` | čistá logika kroku (polling, chyby, cancel) | `spec/javascript/qes_step_logic.test.mjs` |
| `db/migrate/*_create_qes_sessions.rb` | migrace (§ 4.2) | — |
| `db/migrate/*_add_doc_timestamp_state_to_qes_sessions.rb` | DocTS stav (§ 7.6) | — |
| `config/initializers/qes.rb` | konfigurace (§ 11) | — |

Změněné soubory upstreamu: tabulka v § 14 (**21 souborů**, logické bloky, ne jednotlivé doteky);
pro přímý podpis PDF se nemění žádný další upstream soubor — `Qes::Config` (limit velikosti)
a `Qes::FormSessionsController` (API token místo prohlížečové session) jsou nové soubory
a multipart povoluje `lib/api_path_consider_json_middleware.rb`.

Appka (Expo): struktura v § 9.7; `mobile/app/src/lib/…` + `mobile/app/src/modules/eop-signing-sdk/`.

---

## 19. Příloha B — plán RSpec testů

Konkrétní případy (každý test MUSÍ nejdřív selhat — TDD):

**`spec/models/qes_session_spec.rb`**
1. validace: `field_uuid` musí být `qes` pole submittera; `expires_at` v budoucnosti.
2. přechody: povolené i zakázané (např. `created → completed` vyhodí `Qes::InvalidTransition`).
3. `value_token` = `"qes:<id>"`; po `complete!` je hodnota v `submitter.values`.
4. scopes `active` / `completed` / `failed`.
5. nejvýše 1 aktivní session na submittera (druhá zruší první).
6. expirace: `active` po `expires_at` → `expired`; `token_digest` zůstává do retence (pak `NULL`),
   takže `410 expired_token` i `410 used_token` fungují (§ 4.3).

**`spec/lib/qes/certificate_info_spec.rb`**
1. cert s `QcCompliance` → `level = ades`; bez → `none`.
2. cert s `QcCompliance + QcSSCD` → `level = qes`.
3. `keyUsage` bez `digitalSignature` → odmítnuto.
4. expirovaný cert → `certificate_expired`; RSA 2048 / ECDSA P-256.
5. `qc_statements` obsahuje přesné OID v pořadí z certifikátu.

**`spec/lib/qes/cms_builder_spec.rb`**
1. `prepare` vrátí `signed_attrs_der` typu DER `SET` s `content-type`, `message-digest`,
   `signingCertificateV2` a **vynuceným** `signing-time` (HexaPDF 1.7 ho u `:pades` nepřidá — § 7.2 bod 2).
2. `message-digest` = SHA-256 dat pokrytých `/ByteRange`.
3. dva `prepare` se stejným `signing_time` → byte-identical `signed_attrs_der`.
4. `complete` se stejnou signaturou → byte-identical `signed_attrs_der` (kontrola kontextu).
5. `complete` s TSA → CMS obsahuje `id-aa-timeStampToken`; bez TSA → neobsahuje.
6. `complete` bez LTV → CMS neobsahuje `id-aa-ets-revocationValues`; CRL jde do DSS (§ 7.4).

**`spec/lib/qes/tbs_document_spec.rb`**
1. PDF obsahuje pole `Sig1` s rezervou `QES_SIGNATURE_RESERVE` (nebo `QES_SIGNATURE_MIN_SIZE` při přímém volání bez certifikátu).
2. `/ByteRange` pokrývá celý soubor kromě `/Contents`.
3. víc dokumentů v šabloně → stránky v pořadí šablony, jeden podpis.
4. `qes` pole se nevykresluje (žádný text `qes:` v obsahu).

**`spec/lib/qes/chain_spec.rb`** (nové, § 4.6)
1. TBS 2. signera se staví otevřením `final_document` signera 1 (ne přestavbou stránek);
   v základu je viditelná pečeť signera 1 a TBS 2 má nové podpisové pole.
2. Po `complete!` obou signerů má finální PDF 6 signatur (2× appka + 2× pečeť + 2× DocTS), všechny
   `intact`, poslední pokrývá celý soubor; `documents` signera 1 = revize 1, signera 2 = revize 2.
3. Varianta se dvěma přílohami: `page_offsets` mapuje stránky globálně a pečeť signera 2 je na správné
   stránce (kontrola obsahem/overlayem).
4. `combined_document` = poslední revize (žádný další podpis).

**`spec/models/template_spec.rb`**
1. `qes` pole + kreslený podpis u některého signera → `qes_all_signers_required`.
2. `qes` pole + 2 signeři bez pořadí → `qes_signing_order_required`.
3. `qes` pole + 2 signeři se stejným `order` → `qes_parallel_signers_not_allowed`.
4. `qes` pole + 2 signeři s `submitters_order: preserved` → platná šablona.
5. `qes` pole + 2 signeři s různým `order` → platná šablona.

**`spec/models/submission_spec.rb`**
1. `submitters_order: random` u QES šablony → po vytvoření je `preserved`.
2. bez QES polí zůstává `random`.

**`spec/lib/qes/embed_spec.rb` / `validator_spec.rb`**
1. vložený CMS (fixtures) → pyHanko `INTACT:TRUSTED`, `pdfsig` valid.
2. tamper po vložení → `intact=false`.
3. podpis nepokrývá celý dokument → `incomplete_coverage`.
4. `QcSSCD` bez `QcCompliance` → `level = none` (nikdy `qes`).

**`spec/lib/qes/ltv_spec.rb`**
1. CRL z `CRLDistributionPoints` (více URL → zkusí všechny).
2. CRL nedostupné + `QES_REQUIRE_LTV=true` → `ltv_unavailable`.
3. `crl_urls` vrací všechny URL z certifikátu (ne jen první).
4. offline `pyhanko validate` (bez `--fetch`) → `trusted=True`.

**`spec/lib/qes/seal_spec.rb`**
1. po `apply` má PDF o jednu signaturu víc; předchozí zůstávají `INTACT`.
2. poslední (pečeť) pokrývá celý soubor (poslední revize).
3. chyba pečeti → `seal_state = failed` a PDF bez pečeti je uložen.
4. `combined_document` pro QES = kopie `final_document`; u N signeřů má N podpisů appky + N pečetí
   (žádný podpis navíc).

**`spec/requests/qes_sessions_spec.rb`**
1. neznámý token → `404 unknown_token`; expirovaný → `410 expired_token`; použitý → `410 used_token`.
2. `certificate` bez `QcSSCD` u `level_required=qes` → `422 qes_required_qscd`.
3. `QcSSCD` + `key_location=phone_keystore` → `422 level_mismatch`.
4. cizí signatura → `422 signature_invalid`; session `failed`.
5. `complete` dvakrát se stejnou signaturou → 200 (idempotentní).
6. rate limit → `429 rate_limited`.
7. `abort` s `user_cancelled` → `cancelled`.

**`spec/requests/qes_form_sessions_spec.rb`**
1. cizí `field_uuid` → `404`; pole jiného typu → `422`.
2. `POST` zruší předchozí aktivní session.
3. polling vrací `state`, `value`, `error`; po `completed` je `value = "qes:<id>"`.
4. neautorizovaný submitter → `403`/`404` (jako ostatní `/s/:slug` endpointy).

**`spec/lib/qes/value_validator_spec.rb`**
1. hodnota `"qes:<id>"` s `completed` session téhož submittera projde.
2. libovolný jiný řetězec → `ValidationError`.
3. `"qes:<id>"` session jiného submittera / nedokončené → `ValidationError`.

**`spec/models/template_spec.rb`**
1. `qes` pole + kreslený podpis → `qes_all_signers_required`.
2. `qes` pole + 2 signeři bez pořadí → `qes_signing_order_required`.
3. `qes` pole + 2 signeři se stejným `order` → `qes_parallel_signers_not_allowed`.
4. `qes` pole + 2 signeři s `submitters_order: preserved` → uložení projde.
5. `qes` pole + 1 podepisující → uložení projde.

**`spec/requests/well_known_spec.rb`**
1. AASA → 200, `Content-Type: application/json`, platný JSON.
2. `/.well-known/assetlinks.json` → 404 (App Links zrušeny, #18.1).

**`spec/lib/submissions/generate_result_attachments_spec.rb`**
1. QES submission → `documents` = podepsané PDF (ne generované).
2. `qes` pole se nevykresluje (žádný text v PDF).
3. non-QES submission → chování beze změny (regresní test).

**`spec/lib/submissions/generate_combined_attachment_spec.rb`**
1. QES → combined = kopie podepsaného PDF (+ pečeť), bez importu stránek.
2. non-QES → beze změny.

**`spec/lib/submissions/generate_audit_trail_spec.rb`**
1. audit obsahuje QES stránku s cert/čas/hash/level/validací.
2. non-QES → beze změny.

**`spec/requests/qes_documents_spec.rb`** (přímý podpis, docs/15)
1. upload → `201` s `template_id`, polem `qes`, stránkami s náhledy a velikostí pečeti; šablona je ve
   složce „Direct signing“.
2. bez tokenu → `401`; ne-PDF / špatný `content_type` → `422 invalid_pdf`; příliš velké → `422 file_too_large`;
   šifrované → `422 encrypted_pdf`; už podepsané → `422 already_signed`; špatná úroveň → `422 invalid_level`.
3. `POST /s/:slug/qes_sessions` s API tokenem → `201` + token (spuštění obřadu bez prohlížeče).

---

## 20. Příloha C — manuální testovací protokol

### 20.1 Varianta A (eObčanka) — hardware

Předpoklady: Android telefon s BLE, podporovaná čtečka (ACR 3901 U-S1 / bR301 BLE černá / CT 1100 / AirID 2),
eObčanka s **aktivovanými elektronickými funkcemi**, nastaveným PIN a QPIN, kvalifikovaný certifikát
v čipu (vygenerovaný v čipu), testovací TSA/trust roots na serveru.

| # | Krok | Očekávaný výsledek | Důkaz |
|---|---|---|---|
| 1 | Spárovat čtečku v appce (S8) | čtečka se objeví v seznamu, stav baterie | screenshot |
| 2 | Vložit kartu | `onCardInserted` → seznam kontejnerů (S9) | screenshot |
| 3 | Vybrat kontejner s kvalifikovaným certem | zobrazen subject/issuer/platnost, úroveň QES | screenshot |
| 4 | Klik „Podepsat" → dialog QPIN | QPIN zadán, signatura vytvořena v čipu | screenshot |
| 5 | Server vloží CMS | `state = completed`, úroveň `qes` | browser + DB |
| 6 | Validace finálního PDF | `pyhanko`: `INTACT:TRUSTED,UNTOUCHED`; `pdfsig`: valid | report |
| 7 | Audit trail | QES stránka s `QcSSCD` a `key_location=card` | PDF |
| 8 | 3× chybný QPIN | karta zablokuje QPIN, session `failed`, jasná zpráva | screenshot |
| 9 | Vytáhnout kartu během podpisu | `reader_error`, session `failed`, lze zkusit znovu | screenshot |
| 10 | Expirovaný cert v čipu | `certificate_expired`, jasná zpráva | screenshot |

**Bezpečnost:** s reálnou kartou netestovat blokování PIN/QPIN (krok 8 jen s testovací kartou nebo
simulací). Reálný test dělat až po dohodě s uživatelem; jinak použít `EXPO_PUBLIC_QES_FAKE_CARD=1`.

### 20.2 Varianta B (telefon) — zařízení

| # | Krok | Očekávaný výsledek | Důkaz |
|---|---|---|---|
| 1 | Import PKCS#12 z iSignum (S2) | souhrn certu, úroveň AdES | screenshot |
| 2 | Restart appky → otevřít S3 | vyžádána biometrie, pak data | screenshot |
| 3 | Deep link z prohlížeče | S4 s názvem dokumentu a `document_digest` | screenshot |
| 4 | Klik „Podepsat" → biometrie | signatura odeslána, S6 úspěch | screenshot |
| 5 | Server | `state = completed`, úroveň `ades` | browser |
| 6 | Validace | `pyhanko`: `INTACT:TRUSTED,UNTOUCHED` | report |
| 7 | Expirovaný token | S6 „Vyžádejte nový odkaz" | screenshot |
| 8 | Vypnutá síť během podpisu | retry s backoffem, pak chyba | screenshot |

---

## 21. Příloha D — UX texty (cs)

| Klíč | Text |
|---|---|
| `qes.step.title` | Podepsat certifikátem |
| `qes.step.description` | Podepíše se vaším certifikátem v aplikaci Dokulachtan. Klíč zůstává ve vašem zařízení. |
| `qes.step.button` | Podepsat certifikátem |
| `qes.step.waiting` | Čekáme na potvrzení v aplikaci… |
| `qes.step.open_app` | Otevřít aplikaci |
| `qes.step.cancel` | Zrušit |
| `qes.step.expires_in` | Odkaz vyprší za {minutes} min |
| `qes.step.done` | Podepsáno ({level}) |
| `qes.step.retry` | Zkusit znovu |
| `qes.step.new_link` | Vyžádat nový odkaz |
| `qes.step.replaced` | Podepisování bylo nahrazeno novým požadavkem |
| `qes.step.preview_disabled` | V náhledu nelze podepsat |
| `qes.step.native` | Podepište v prohlížeči |
| `qes.error.expired_token` | Platnost odkazu vypršela. Vyžádejte nový. |
| `qes.error.used_token` | Podpis už byl dokončen. |
| `qes.error.signature_invalid` | Podpis se nepodařilo ověřit. Zkuste to znovu. |
| `qes.error.qes_required_qscd` | Vyžaduje se kvalifikovaný certifikát (QES). |
| `qes.error.level_mismatch` | Vybraný certifikát neodpovídá typu podpisu. |
| `qes.error.not_qualified` | Certifikát není kvalifikovaný. Použijte certifikát od I.CA/PostSignum. |
| `qes.error.network` | Chyba připojení. Zkuste to znovu. |
| `qes.app.confirm_title` | Potvrdit podpis |
| `qes.app.confirm_signer` | Podepisuje: {name} |
| `qes.app.confirm_document` | Dokument: {document_name} |
| `qes.app.confirm_hash` | Otisk dokumentu: {digest} |
| `qes.app.confirm_certificate` | Certifikát: {subject} |
| `qes.app.sign` | Podepsat |
| `qes.app.cancel` | Zrušit |
| `qes.app.success` | Podepsáno ({level}) |
| `qes.app.success_hint` | Dokument byl podepsán. Můžete se vrátit do prohlížeče. |
| `qes.app.error_token` | Platnost odkazu vypršela. Vyžádejte nový. |
| `qes.app.error_pin_blocked` | Kód je zablokovaný. Odblokujte ho v aplikaci eObčanka. |
| `qes.app.error_reader` | Připojte čtečku a zkuste to znovu. |
| `qes.app.error_certificate` | Certifikát chybí nebo vypršel. Importujte nový. |
| `qes.app.error_no_signer` | Nejdřív nastavte podepisování (klíč nebo čtečku). |
| `qes.app.error_protocol` | Aktualizujte aplikaci. |
| `qes.app.biometry_required` | Pro podpis se vyžaduje biometrie. |
| `qes.app.finishing` | Dokončuji na serveru… |
| `qes.app.check_again` | Zkontrolovat znovu |
| `qes.app.wizard_title` | Nastavit podepisování |
| `qes.app.wizard_import_key` | Importovat klíč (PKCS#12) |
| `qes.app.wizard_setup_reader` | Nastavit čtečku |
| `qes.app.error_qscd_certificate` | Tento certifikát patří čipu, v telefonu ho použít nelze. |
| `qes.app.about_moi_sdk` | Tato aplikace využívá softwarový produkt Podpisové SDK, který pro Ministerstvo vnitra ČR, v rámci projektu CDBP, realizovaného STÁTNÍ TISKÁRNOU CENIN, státním podnikem, vyvinula společnost MONET+, a.s. Softwarový produkt Podpisové SDK může být užíván pouze v souladu s licenčními podmínkami, pod kterými je šířen. |

Lokalizace: v1 čeština (`cs`) je kanonická sada klíčů výše; angličtina (`en`) se vede v
`mobile/app/src/i18n/en.ts` se **stejnými klíči** (P4.11); ostatní jazyky DocuSealu se pro QES texty
použijí anglicky (fallback).

---

## 22. Příloha E — kompatibilita a provozní požadavky

Pozn.: „produkce“ níže = **privátní instance uživatele s produkčním kódem** (self-hosted software),
ne centrální služba; adresa instance se v každém nasazení mění.

| Věc | Požadavek |
|---|---|
| Ruby/Rails | verze z pinu forku (`vendor/docuseal.rev`); patch nesmí měnit `Gemfile`/`Gemfile.lock` |
| HexaPDF | 1.7.0 z `Gemfile.lock`; API `Signing.embed_signature` a `SignedDataCreator` (§ 7.2, 7.3) |
| Nové závislosti | žádné (jen stdlib `openssl`, `active_support`, existující `hexapdf`); TSA/OCSP přes `Net::HTTP` |
| DB | SQLite v obou privátních instancích (staging i produkce); kód musí být DB-agnostický, volitelně PostgreSQL pro větší nasazení: žádné `jsonb`/pole; JSON v `text` + `serialize`, binární v `t.binary` |
| ActiveStorage | `disk` v obou privátních instancích (volume), S3 volitelně pro větší nasazení; `has_one_attached` + `metadata` |
| Joby | Sidekiq embedovaný v Pumě (single-tenant); joby krátké a idempotentní (§ 7.10) |
| Timeouty | `POST /complete` max 15 s (Puma default 30 s); TSA/OCSP v jobu, ne v requestu |
| Prohlížeče | Chrome/Edge/Safari/Firefox (poslední 2 verze); QR + WebShare API jen jako progressive enhancement |
| Expo | SDK 58 (dev build pro A), `minSdkVersion 24`; MOI AAR vyžaduje `compileSdk 35+` (SDK 58 staví s `compileSdk 37`) |
| Android | 8.0+ (API 26) pro BLE čtečky; **v1 = Android** (App Links ověřené); iOS až F2 (AASA + `QES_IOS_TEAM_ID` je příprava, § 6.6) |
| Rebase | po každém rebase upstreamu spustit `make qes-test` + `make qes-e2e`; hooky jsou malé (§ 7.7) |
| Produkční instance | dnes varianta A (SQLite + volume + SMTP + zálohy snapshotem); volitelně Postgres + S3 + vlastní doména (universal links) pro větší nasazení (§ 11) |
| Test harness | `make qes-test` = **SQLite** (parita se stagingem) + test image s Ruby 4.0.5 a `libpdfium.so`; `make qes-test-postgres` = Postgres 18 (parita s upstream CI, celá sada). `PRIMARY_DATABASE_URL=sqlite3:db/qes-test.sqlite3` (POZOR: `DATABASE_URL=sqlite3:…` neprojde — `database.yml` `production:` sekce je pro sqlite URL prázdná), `SCHEMA=tmp/qes-test-schema.rb` chrání `db/schema.rb` (gem default `dump_schema_after_migration = true`, DocuSeal ho vypíná jen v `production.rb:127`); na SQLite nelze `db:schema:load` (Postgres dump s `btree_gin`/`tsvector`/`using: :gin`), jen `db:migrate`. Změřeno 2026-10-27: SQLite 646/1 (známý upstream flake), Postgres 650/0 — `test/qes/README.md` |
| SQLite v testech | **Primární** (obě privátní instance = SQLite; § 22 vyžaduje DB-agnostický kód): 3 Postgres-specific migrace mají `return unless adapter_name == 'PostgreSQL'`, `LockEvent` používá `unique: connection.supports_partial_index?` → idempotence funguje i na SQLite. Jediný spec závislý na Postgresu: `spec/system/dashboard_spec.rb:53` (fulltext) → vyloučit `--exclude-pattern`, ověřit v `qes-test-postgres` |
| Assety v testech | `make qes-test-assets` zkopíruje `public/packs` z produkčního image → `public/packs-test` (pro `spec/system`); `chromium` jen v system image, `libpdfium.so` v obou (pro `VerifyPdfSignature`) |
| Plánování jobů | bez `sidekiq-cron`: samo-plánující smyčka `perform_in` + atomický cache lock `unless_exist` (§ 7.8) |
