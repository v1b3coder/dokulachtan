# 16 — Ověření PDF

Status: **implementováno a nasazeno** (2026-10-22) — produkční instance **v52**, staging **v25**, APK **1.3.9**; server + appka + testy. **Web UI** (panel ověření, náhled a stažení PDF) doplněno 2026-10-23.
Navazuje na DESIGN.md § 1/§ 4/§ 7, SPEC.md § 7.5 a docs/15 (přímý podpis PDF).

## 1. Use case

Zaměstnanec dostane PDF (e-mailem, WhatsAppem, z portálu, z DocuSealu) a chce si ověřit,
**jestli je podepsané, kým, čím a jestli s ním po podpisu někdo nemanipuloval**. Stejně jako
u podpisu chce mít dvě cesty:

1. **v appce** — Home → „Ověřit PDF“ → výběr souboru → výsledek,
2. **share/open intent** — PDF nasdílené nebo otevřené v aplikaci Dokulachtan (Android) → S14 → volba „Podepsat PDF“ / „Ověřit PDF“.

Druhá cesta je ekvivalent dnešního „Podepsat PDF“: uživatel nemusí PDF ukládat na disk
a hledat v appce. Výsledek se zobrazí v appce, PDF zůstává v zařízení a na serveru se
**neukládá automaticky** — jen na tlačítko do složky „Verified documents“.

## 2. Rozhodnutí

| # | Rozhodnutí | Důvod |
|---|---|---|
| D1 | **Ověřování běží na serveru**, appka jen nahraje PDF a zobrazí výsledek | server už má `Qes::Validator` (Pdfium + OpenSSL + trust roots), appka nemá PDF parser ani CA store; stejný výsledek jako při podpisu |
| D2 | **Nový endpoint `POST /api/qes/verify`** (multipart, `X-Auth-Token`) | `/api/tools/verify` je upstream a ověřuje vůči „account“ certům, ne vůči `QES_VERIFICATION_TRUST_ROOTS`; neumí `intact/trusted/coverage/level` ani `origin`; nový endpoint je konzistentní s `POST /api/qes/documents` |
| D3 | **Bez automatického ukládání**: ověření PDF jen přečte v paměti; do složky „Verified documents“ se uloží **jen na tlačítko** | ověření je read-only; uživatel kontroluje, co zůstane na serveru; složka dá historii, download/share/delete bez nového modelu |
| D4 | **HTTP 200 i pro negativní verdikt** (`unsigned`, `invalid`, `valid_untrusted`); 422 jen pro nepřečtené PDF, šifrované PDF a příliš velký soubor | „ověření proběhlo“ je úspěch requestu; špatný podpis není chyba API |
| D5 | `verdict` = `valid` / `valid_untrusted` / `valid_unqualified` / `invalid` / `unsigned`; zvlášť `intact`, `trusted`, `modified`, `level`, `coverage`, `origin` | appka potřebuje jednoduchý verdikt i technické detaily; pole se nesmí míchat |
| D6 | **`modified` = `Qes::PdfiumTrust.report`** (hranice změn za posledním ověřeným podpisem), ne jen `coverage` z `Qes::Validator` | DSS/LTV aktualizace po podpisu je legitimní a `coverage` ji označí jako `partial`; naopak přidaná stránka po podpisu musí být `invalid` |
| D7 | **Trust pro ověření = `QES_VERIFICATION_TRUST_ROOTS`** (výchozí `czech.pem`: vydávající CA PostSignum, I.CA, eIdentity, NCA, KB — anchory, ne rooty); signing trust store `QES_TRUST_ROOTS` zůstává PostSignum | ověření cizích PDF a přijetí certu při podpisu jsou dvě různé politiky; root jako anchor by důvěřoval celému podstromu (nález #9) |
| D8 | **Revokace se v v1 nekontroluje** (`revocation: "not_checked"`) | korektní revokace potřebuje LTV/časové razítko; při podpisu už `Qes::Ltv.check_revoked!` běží; verifikace nesmí kvůli CRL zdržovat nebo padat |
| D9 | **`origin` = `docuseal` / `external`** podle `CompletedDocument.sha256` **scoped na účet** | uživatel chce vědět „je to PDF z našeho DocuSealu?“; hash je už dnes v `CompletedDocument` (upstream `/api/tools/verify`) |
| D10 | **Dvě cesty, jedna S14**: share sheet „Podepsat PDF“ (`ACTION_SEND`) i open-with „Ověřit PDF“ (`ACTION_VIEW`) → S14 s volbou „Podepsat PDF“ / „Ověřit PDF“ | share zůstává kompatibilní; open intent dostane původní content URI bez re-exportu z PDF editoru; `OpenPdfModule` ho zkopíruje do cache a `+not-found` přesměruje na S14 |
| D11 | **Web UI: template show page zobrazuje panel „Ověření PDF“** (verdikt, podpisy, issuer, časy, pečeť, origin, SHA-256) + **náhled** a **stažení PDF**; upstream „Verify PDF“ (účetní certy) zůstává | uživatel chce vidět uložený výsledek i PDF bez appky; panel čte `preferences['qes_verification']`, nic nepřepočítává; sjednocení upstream Verify PDF na QES trust roots je další fáze |
| D12 | **Jedna nová ENV**: `QES_VERIFICATION_TRUST_ROOTS` vedle stávajících `QES_ENABLED`, `QES_PDF_MAX_BYTES`, `QES_TRUST_ROOTS` | signing a verification trust store musí být oddělené |
| D13 | **Uložení na tlačítko**: `POST /api/qes/verified_documents` znovu ověří PDF a uloží ho jako template ve složce „Verified documents“; report JSON do `template.preferences['qes_verification']` | reuse DocuSeal Documents, žádná nová tabulka; PDF + výsledek pro audit |
| D14 | Ukládají se jen `intact && !modified` PDF (`valid`, `valid_untrusted`, `valid_unqualified`); `invalid`/`unsigned` ne | složka „Verified documents“ nemá obsahovat prokazatelně změněné PDF; server to vynutí |
| D15 | **Appka podpis neověřuje.** Po stažení finálního PDF jen konzistenční kontrola (`final_pdf_sha256` + reviewed TBS); chybějící otisk je chyba, ne průchod. Verifikace = server (`Ověřit PDF`), EU DSS nebo jiný software | server finální PDF validuje **před** `completed` (`Qes::Validator` + `RevisionChanges`: `intact`, `!modified`, `trusted`, DocTS) a servíruje přesně validované bajty; reimplementace CMS v appce by duplikovala `Qes::Validator` a nemá threat, proti kterému by v tomto modelu (důvěra v nakonfigurovaný server) chránila |

**Zamítnuto:** vlastní PDF parser v appce (žádný v JS), nová tabulka `qes_verifications`, vlastní
auditní záznam, ověřování bez API tokenu, ověřování podpisu v appce (D15). **Přijato:** explicitní uložení do Documents na
tlačítko (D13) — PDF se neukládá při každém ověření.

## 3. Architektura a tok

```
appka (S14/S15)                    fork (server)                     trust roots
  │ POST /api/qes/verify ──────────▶ ověří PDF (Qes::PdfSource)
  │   (multipart, X-Auth-Token)      Qes::Validator + Qes::PdfiumTrust.report
  │                                  ├─ intact / trusted / coverage / level
  │                                  ├─ modified (unsigned changes)
  │                                  ├─ seal (DocuSeal)
  │                                  └─ origin (CompletedDocument)
  │◀── JSON report ─────────────────│
  │ zobrazí verdikt + podpisy        │
  │ PDF se neukládá automaticky        │
```

**Trust boundary:** PDF (obsah) jde na server — stejně jako dnes u každé šablony a u přímého podpisu.
Privátní klíč, biometrie ani PIN se ověřování netýkají. Server PDF **neukládá automaticky**;
do Documents se dostane jen na tlačítko „Uložit do DocuSealu“ (D13).

**Co se reuse beze změny:** `Qes::Validator`, `Qes::PdfSource` (jen rozšíříme `validate!`),
`Qes::PdfiumTrust`, `CompletedDocument`, `Qes::RateLimiter`, `ApiBaseController` (API token),
`ApiPathConsiderJsonMiddleware` (jen přidáme výjimku pro multipart).

## 4. Server

### 4.1 `POST /api/qes/verify` — nový endpoint

`multipart/form-data` s `file` (povinné). Autentizace `X-Auth-Token` jako u přímého podpisu.

Server **MUSÍ**:

1. ověřit `QES_ENABLED` → `404 disabled`,
2. rate limit (`Qes::RateLimiter.check!`) → `429 rate_limited`,
3. ověřit velikost (`QES_PDF_MAX_BYTES`, default 25 MB) → `422 file_too_large`,
4. ověřit magic bytes `%PDF-` a `content_type: application/pdf` → `422 invalid_pdf`,
5. odmítnout šifrovaná PDF (`422 encrypted_pdf`); **podepsaná PDF naopak povolit**
   (`Qes::PdfSource.validate!(data, allow_signed: true)`),
6. spustit `Qes::Verifier` a vrátit report; PDF **neukládat**.

Úspěch: `200` i pro `unsigned`/`invalid` (D4). Chyby: `401 not_authenticated`,
`404 disabled`, `422 invalid_pdf`, `422 encrypted_pdf`, `422 file_too_large`,
`429 rate_limited` (`Qes::ClientError(:rate_limited)` se mapuje na `429`, ne na 422).
`HexaPDF::Error`/`Pdfium::PdfiumError` v `Qes::Verifier` → `422 invalid_pdf` (ne 500).

**Uložení:** `POST /api/qes/verified_documents` (multipart, stejný `file`) udělá stejné
ověření a navíc uloží PDF do složky „Verified documents“. Uloží se jen `intact && !modified`
(D14); jinak `422 not_verifiable`. Odpověď je stejný report + `stored: true`,
`template_id`, `folder`.

### 4.2 Response

```json
{
  "file": {
    "name": "smlouva.pdf",
    "size": 123456,
    "sha256": "9f2c…"
  },
  "verdict": "valid",
  "intact": true,
  "trusted": true,
  "modified": false,
  "level": "ades",
  "coverage": "full",
  "origin": "docuseal",
  "revocation": "not_checked",
  "seal": { "present": true, "trusted": true, "count": 1 },
  "signatures": [
    {
      "kind": "qes",
      "level": "ades",
      "intact": true,
      "trusted": true,
      "coverage": "full",
      "common_name": "Jan Novák",
      "subject": "CN=Jan Novák, O=Firma s.r.o., C=CZ",
      "issuer": "CN=PostSignum Qualified CA 4, O=PostSignum, C=CZ",
      "serial": "0x1A2B3C",
      "signing_time": "2026-10-22T09:15:00Z",
      "not_before": "2025-01-01T00:00:00Z",
      "not_after": "2027-01-01T00:00:00Z",
      "chain": ["CN=Jan Novák, …", "CN=PostSignum Qualified CA 4, …", "CN=PostSignum Root QCA 4, …"]
    }
  ],
  "trusted_roots": ["CN=PostSignum Root QCA 4, O=PostSignum, C=CZ"],
  "messages": [
    { "status": "success", "text": "Signature valid" },
    { "status": "success", "text": "Signed with trusted certificate" }
  ],
  "validated_at": "2026-10-22T09:16:00Z",
  "stored": false
}
```

Uložení (`POST /api/qes/verified_documents`) vrátí stejný report a navíc:

```json
{
  "stored": true,
  "template_id": 123,
  "folder": "Verified documents"
}
```

Poznámky:

- `signatures[].trusted` = řetěz k `QES_VERIFICATION_TRUST_ROOTS` (platí pro `kind: "qes"`, tj. `ETSI.CAdES.detached`);
  u `kind: "seal"` je vždy `false` — pečeť má vlastní `seal.trusted` proti certům účtu;
- `seal` = agregát z `Qes::PdfiumTrust.report` (`adbe.pkcs7.detached`, certy účtu DocuSeal);
- `messages` = texty z `Qes::PdfiumTrust.report` (pro „Technické detaily“);
- `modified` = `Qes::PdfiumTrust.report` (DSS/LTV je povoleno, přidaná stránka ne).

### 4.3 Verdikt

```ruby
qes = signatures.select { |s| s[:kind] == 'qes' }

verdict =
  if signatures.empty?
    'unsigned'
  elsif signatures.any? { |s| !s[:intact] } || modified
    'invalid'
  elsif qes.empty?
    'valid_unqualified'
  elsif qes.any? { |s| !s[:trusted] }
    'valid_untrusted'
  else
    'valid'
  end
```

| Verdikt | Význam | UI |
|---|---|---|
| `valid` | všechny podpisy INTACT, žádné unsigned změny, alespoň jeden CAdES a všechny CAdES důvěryhodné | zeleně „Podpis je platný“ + úroveň |
| `valid_untrusted` | podpis je kryptograficky platný, ale certifikát nevede k `QES_VERIFICATION_TRUST_ROOTS` | žlutě „Podpis je platný, ale certifikát není důvěryhodný“ |
| `valid_unqualified` | PDF je podepsané, ale jen pečetí / bez CAdES (žádný kvalifikovaný podpis) | žlutě „PDF je podepsané, ale ne kvalifikovaným podpisem“ |
| `invalid` | některý podpis není INTACT nebo `modified` (unsigned změny po podpisu) | červeně „PDF bylo po podpisu změněno“ / „Podpis je neplatný“ |
| `unsigned` | PDF nemá žádný digitální podpis | šedě „PDF není podepsané“ |

`valid` **nevyžaduje** `level == "qes"`: AdES je platný podpis, jen ne kvalifikovaný; appka to řekne
přímo (`level: "ades"`). `coverage: "partial"` u `valid` znamená jen DSS/LTV aktualizaci po podpisu
(D6), ne manipulaci.

### 4.4 Orchestrace

`app/lib/qes/verifier.rb` (nový):

```ruby
module Qes
  module Verifier
    module_function

    def call(pdf_bytes, name:, account: nil)
      report = Qes::Validator.call(
        pdf_bytes,
        trust_roots: Qes.verification_trust_roots,
        trusted_certs: trusted_certs_for(account)
      )
      pdfium = report[:pdfium]
      signatures = report[:signatures]
      qes = signatures.select { |s| s[:kind] == 'qes' }
      seals = pdfium.select { |s| s[:type] == 'adbe.pkcs7.detached' }
      modified = pdfium.any? { |s| s[:modified] }

      {
        file: { name:, size: pdf_bytes.bytesize, sha256: Digest::SHA256.hexdigest(pdf_bytes) },
        verdict: compute_verdict(signatures, qes, modified,
                                inspection: report[:inspection],
                                coverage_valid: report[:coverage_valid]),
        inspection: report[:inspection],
        intact: report[:intact],
        trusted: report[:trusted],
        modified:,
        level: report[:level],
        coverage: report[:coverage],
        origin: origin(pdf_bytes, account),
        revocation: 'not_checked',
        seal: { present: seals.any?, trusted: seals.any? && seals.all? { |s| s[:verified] && s[:trusted] },
                count: seals.size },
        signatures: signatures.map { |s| signature_payload(s) },
        trusted_roots: report[:trusted_roots],
        messages: seals.flat_map { |s| s[:messages] },
        validated_at: report[:validated_at]
      }
    end
  end
end
```

`signature_payload` jen vybere `kind`, `level`, `intact`, `trusted`, `coverage`, `common_name`, `subject`,
`issuer`, `serial`, `signing_time`, `not_before`, `not_after`, `chain`. `origin` je `docuseal`, když
`CompletedDocument` (scoped na `account`) má stejný `sha256`; jinak `external`. `seal.trusted` se
počítá z `Qes::PdfiumTrust.report` proti `Accounts.load_trusted_certs(account)`, zatímco `signatures[].trusted`
proti `QES_VERIFICATION_TRUST_ROOTS` (dvě různé důvěry). `messages` patří k pečeti (`seal`), ne k podpisu
podepisujícího — texty „signed with trusted certificate“ u QES by jinak mátly.

### 4.5 Změny ve forku

| Soubor | Změna | ~řádků |
|---|---|---|
| `app/controllers/api/qes_verifications_controller.rb` | **nový**: upload + ověření + JSON; `store` navíc uloží PDF | 100 |
| `app/lib/qes/verifier.rb` | **nový**: orchestrace `Qes::Validator` + `Qes::PdfiumTrust` + verdikt + `origin` | 80 |
| `app/lib/qes/verified_documents.rb` | **nový**: template ve složce „Verified documents“ + report v preferences | 50 |
| `app/lib/qes/validator.rb` | `verify_one`: `kind`, `common_name` (CN), `subject` (plný subject), `issuer`, `serial`, `not_before`, `not_after`, `chain`, `trusted` jen pro `qes`; `call`: `modified`, `trusted_certs:`; `pdfium_report`: `verified`, `trusted`, `modified` | 35 |
| `app/lib/qes/pdf_source.rb` | `validate!(data, allow_signed: false)` | 2 |
| `app/lib/qes.rb` | `trust_roots` (signing), `verification_trust_roots` (ověření) a `tsa_trust_roots` | 10 |
| `lib/verify_pdf_signature.rb` | **bit-identický s upstreamem** (nulový diff); `Qes::PdfiumTrust` ho jen volá | 0 |
| `config/initializers/qes_routes.rb` | **nový**: `resources :qes_verifications` + `post 'qes/verified_documents'` + `resource :qes_verification` pod `resources :templates` | 3 |
| `lib/api_path_consider_json_middleware.rb` | povolit multipart na `/api/qes/verify` a `/api/qes/verified_documents` | 2 |
| `app/controllers/templates_qes_verifications_controller.rb` | **nový**: náhled uloženého PDF v Turbo modalu | 14 |
| `app/views/templates/_qes_verification.html.erb` | **nový**: panel s reportem, náhledem a stažením PDF | 143 |
| `app/views/templates_qes_verifications/show.html.erb` | **nový**: iframe s PDF v Turbo modalu | 8 |
| `spec/requests/qes_verifications_spec.rb` | **nový**: request spec (verify + store + web UI) | 276 |
| `spec/lib/qes/verifier_spec.rb` | **nový**: unit test verdiktu | 120 |

Nic dalšího se nemění: `QesSession`, `Qes::SessionsController`, `Qes::Providers::MobileApp`,
`Qes::TbsDocument`, `Qes::CmsBuilder`, `Qes::Embed`, `Qes::Ltv`, `Qes::Dss`, `Qes::Seal`,
`Qes::ExpireSessionsJob`, `Qes::Token`, `Qes::SessionManager`,
`Qes::DocumentsController`, DB schema ani stávající API.

### 4.6 Uložení do „Verified documents“

`Qes::VerifiedDocuments.store!` reuse standardní DocuSeal template + dokument:

- template `name` = původní název PDF, `author` = uživatel, `source: :api`,
  `submitters: []`, `fields: []`, `schema` = jeden dokument;
- `folder = TemplateFolders.find_or_create_by_name(user, 'Verified documents')`;
- `preferences['qes_verification']` = celý report + `stored_at` (JSON);
- PDF se nahraje přes `Templates::CreateAttachments` (stejná cesta jako přímý podpis);
- uživatel ho vidí v **Documents** ve složce „Verified documents“; na template stránce je panel
  **„Ověření PDF“** s verdiktem, podpisy, issuerem, časy, pečetí, originem a SHA-256,
  tlačítko **„Náhled PDF“** (iframe v Turbo modalu) a **„Stáhnout PDF“** (attachment);
  archivovat i smazat jde jako dřív; retence je věcí DocuSealu;
- **žádná nová tabulka** — `templates`, `documents`, `ActiveStorage` a úklid jsou upstream.

### 4.7 Web UI

Panel se renderuje v `templates/show.html.erb` jen když `template.preferences['qes_verification']`
existuje (tj. template vznikl uložením ověřeného PDF). Nic se nepřepočítává; zdrojem je uložený report.

- `TemplatesQesVerificationsController#show` (`GET /templates/:template_id/qes_verification`)
  načte template přes `load_and_authorize_resource`, ověří, že report i dokument existují, a vrátí
  Turbo modal s `<iframe>` na `ActiveStorage::Blob.proxy_path` — PDF se zobrazí inline.
- „Stáhnout PDF“ je stejný proxy path s `?disposition=attachment`; soubor se stahuje pod původním
  názvem.
- Panel zobrazuje verdikt (`valid` / `valid_untrusted` / `valid_unqualified` / `invalid` /
  `unsigned`; u `invalid` rozliší `modified`), úroveň, origin, coverage, `validated_at`, `stored_at`,
  pečeť, revokaci (`not_checked`), seznam podpisů (CN, issuer, čas, INTACT, trusted u QES)
  a rozbalitelné technické detaily (subject, serial, chain, trusted roots, messages, SHA-256).
- Žádná nová tabulka ani endpoint pro čtení reportu; report zůstává v `preferences`.

## 5. Appka (Expo)

### 5.1 Obrazovky

| # | Obrazovka | Obsah a akce | Chybové stavy |
|---|---|---|---|
| S1 | **Home** | s klíčem primární „Podepsat PDF“ + sekundární „Ověřit PDF“; karta certifikátu je klikací → S3; import jen bez klíče nebo v S3 (docs/17) | — |
| S14 | **Ověřit PDF / Co s PDF?** | v appce výběr PDF (`expo-document-picker`) → rovnou `POST /api/qes/verify`; ze share sheetu nebo open intentu soubor + volba „Podepsat PDF“ / „Ověřit PDF“; soubor, velikost, poznámka „PDF se na serveru neukládá automaticky“ | `file_too_large`, `invalid_pdf`, `encrypted_pdf`, `network`, `not_authenticated`, `rate_limited` |
| S15 | **Výsledek ověření** | velký verdikt (barva), souhrn, seznam podpisů, pečeť, `origin`, primární „Ověřit jiné PDF“, sekundární „Uložit do DocuSealu“ (jen pro `intact && !modified`), „Technické detaily“ a „Zavřít“ jako textové odkazy | `invalid_pdf`, `encrypted_pdf`, `file_too_large`, `not_verifiable`, `storage_failed`, `network` |

S14 a S15 mohou být v jednom souboru `app/verify-pdf.tsx` (stejně jako S11/S12 v `sign-pdf.tsx`).

**S15 – co uživatel uvidí:**

- velký stav: „Podpis je platný (QES/AdES)“, „Podpis je platný, ale certifikát není důvěryhodný“,
  „PDF je podepsané, ale ne kvalifikovaným podpisem“, „PDF bylo po podpisu změněno“,
  „PDF není podepsané“;
- „Podepsal: Jan Novák“ / „Vydal: PostSignum Qualified CA 4“ / „Datum podpisu: …“ /
  „Úroveň: QES/AdES“ / „Pokrytí: celý dokument / částečné / žádné“ (u `partial` s `modified: false`
  jde o LTV data po podpisu, ne o změnu obsahu);
- „Pečeť DocuSealu: ověřena / neověřená“ (jen když `seal.present`);
- „Revokace: neověřeno“ (`revocation`, v1 vždy `not_checked`);
- „PDF z DocuSealu“ / „PDF z jiného zdroje“ (`origin`);
- „PDF bylo po podpisu změněno“ (jen když `modified`);
- seznam podpisů (u vícenásobných podpisů), každý: CN, úroveň, čas, issuer, INTACT/neplatný,
  důvěryhodný/nedůvěryhodný (u `kind: "qes"`), u `kind: "seal"` „pečeť DocuSealu“;
- „Technické detaily“: `chain`, `serial`, `not_before`, `not_after`, `trusted_roots`, `messages`;
- „Uložit do DocuSealu“ (jen když `intact && !modified` a ještě není uložené) →
  `POST /api/qes/verified_documents`; po úspěchu „Uloženo do složky Verified documents“;
- „Ověřit jiné PDF“ (reset) a „Zavřít“;
- žádné zobrazení PDF obsahu, žádné náhledy; PDF se ukládá jen na tlačítko.

**Barevnost:** zelená (`valid`), žlutá (`valid_untrusted`, `valid_unqualified`), červená (`invalid`),
šedá (`unsigned`). U `invalid` rozlišit „podpis je neplatný“ (`intact: false`) vs. „PDF bylo po podpisu
změněno“ (`modified: true`).

### 5.2 API klient

`src/lib/pdfApi.ts`:

```ts
export type PdfVerdict =
  | 'valid'
  | 'valid_untrusted'
  | 'valid_unqualified'
  | 'invalid'
  | 'unsigned';

export interface PdfVerificationSignature {
  kind: 'qes' | 'seal' | 'timestamp' | 'other';
  level: QesLevel;
  intact: boolean;
  trusted: boolean;
  coverage: 'full' | 'partial' | 'none';
  common_name: string | null;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  signing_time: string | null;
  not_before: string | null;
  not_after: string | null;
  chain: string[];
}

export interface PdfVerification {
  file: { name: string; size: number; sha256: string };
  verdict: PdfVerdict;
  intact: boolean;
  trusted: boolean;
  modified: boolean;
  level: QesLevel;
  coverage: 'full' | 'partial' | 'none';
  origin: 'docuseal' | 'external';
  revocation: 'not_checked' | 'good' | 'revoked' | 'unknown';
  seal: { present: boolean; trusted: boolean; count: number };
  signatures: PdfVerificationSignature[];
  trusted_roots: string[];
  messages: { status: 'success' | 'warning' | 'error'; text: string }[];
  validated_at: string;
  stored: boolean;
  template_id?: number;
  folder?: string;
}

async verifyDocument(file: PdfUpload): Promise<PdfVerification> {
  return this.postPdf('/api/qes/verify', file);
}

async storeVerifiedDocument(file: PdfUpload): Promise<PdfVerification> {
  return this.postPdf('/api/qes/verified_documents', file);
}
```

`PdfApi.throwError` normalizuje `Not authenticated` → `not_authenticated` (stejně jako u podpisu).

`src/lib/verifyPdf.ts` (čisté funkce pro testy): `verdictView(report)`, `signatureLabel(signature)`,
`coverageLabel(coverage)`, `canStore(report)`; `shareTargetRoute(target)` jen u volitelných dvou aliasů.

### 5.3 Share intent a open intent (Android)

**Share sheet** (`ACTION_SEND`, `application/pdf`):

- `plugins/withSharePdfTarget.js` přidá `.SharePdfAlias` s labelem **„Podepsat PDF“**.
- `app/_layout.tsx` přes `screenLayout` otevře S14 se souborem ze share sheetu;
  S14 nabídne **„Podepsat PDF“** / **„Ověřit PDF“**.

**Open with** (`ACTION_VIEW`, `application/pdf`):

- stejný plugin přidá `.OpenPdfAlias` s labelem **„Ověřit PDF“**.
- malý nativní modul `modules/dokulachtan-open-pdf` (`OpenPdfModule`) přečte původní
  `content://` URI, zkopíruje obsah do cache a předá ho JS.
- `app/+not-found.tsx` (Expo Router na `dokulachtan://media/...` spadne sem) soubor převezme
  a přesměruje na S14 se stejným souborem; S14 opět nabídne **„Podepsat PDF“** / **„Ověřit PDF“**.

**Proč open intent:** PDF editor při share často re-exportuje dokument; `ACTION_VIEW` z file manageru
/ e-mailu předá původní soubor. Obě cesty končí na stejné S14, takže uživatel má vždy volbu.

**iOS:** share extension není v rozsahu (stejně jako dnes); ověření je jen v appce.

### 5.4 Soubory appky

| Soubor | Obsah |
|---|---|
| `app/verify-pdf.tsx` | S14 + S15 (výběr / share / open, upload, verdikt, detaily) |
| `src/lib/pdfApi.ts` | `verifyDocument`, `storeVerifiedDocument`, typy reportu |
| `src/lib/verifyPdf.ts` | mapování verdiktu, `canStore`, české texty a barvy |
| `app/index.tsx` | tlačítko „Ověřit PDF“ |
| `app/settings.tsx` | label „API token (podpis a ověření PDF)“ (token se používá pro obě akce) |
| `app/_layout.tsx` | share intent přes `screenLayout` → S14 „Co s PDF?“ |
| `app/+not-found.tsx` | open intent (`ACTION_VIEW`) → `OpenPdfModule` → S14 |
| `plugins/withSharePdfTarget.js` | `.SharePdfAlias` „Podepsat PDF“ + `.OpenPdfAlias` „Ověřit PDF“ |
| `modules/dokulachtan-open-pdf/*` | nativní modul: `ACTION_VIEW` PDF → cache soubor pro JS |
| `__tests__/pdfApi.test.ts` | `verifyDocument` + `storeVerifiedDocument` (multipart, odpověď, chyby) |
| `__tests__/verifyPdf.test.ts` | mapování verdiktu, popisky; `shareTargetRoute` (jen u dvou aliasů) |
| `__tests__/shareIntent.test.ts` | PDF ze share sheetu beze změny |

## 6. Bezpečnost a soukromí

| Hrozba | Opatření |
|---|---|
| Únik PDF na server | přijato; PDF se neukládá automaticky, server vrací jen report; uložení je na tlačítko |
| Zneužití endpointu / DoS | API token, `Qes::RateLimiter`, limit velikosti, žádné ukládání |
| Malformované PDF | `Qes::PdfSource.validate!` + rescue `HexaPDF::Error`/`Pdfium::PdfiumError` → `422 invalid_pdf` |
| Šifrované PDF | `422 encrypted_pdf` (bez hesla nelze ověřit) |
| Cizí PDF v cizím účtu | `origin` se počítá jen v rámci `current_account`; žádná data z cizího účtu |
| Falešná pečeť „DocuSeal“ | `seal.trusted` se počítá proti `Accounts.load_trusted_certs(account)` (ne jen podle CN) |
| Falešný „trusted“ podpis | `Qes::Validator#trusted` jen proti `QES_VERIFICATION_TRUST_ROOTS`, ne proti account certům |
| Záměna podepsaného obsahu | `modified` z `Qes::PdfiumTrust.report` (DSS je povoleno, přidaná stránka ne) |
| Únik tokenu | token jen v hlavičce, nikdy se neloguje; PDF se neloguje |

**Soukromí:** server vidí PDF obsah (stejně jako při podpisu). Při ověření se PDF **neukládá**;
do ActiveStorage/Documents se dostane jen na tlačítko „Uložit do DocuSealu“ (D13), a to pouze
`intact && !modified`. Loguje se jen `[qes] verify size=… verdict=… origin=…` (bez názvu souboru a bez hashe).

## 7. Testy a verifikace

### 7.1 RSpec

`spec/requests/qes_verifications_spec.rb`:

- podepsané PDF (AdES, test PKI) → `200`, `verdict: "valid"`, `intact: true`, `trusted: true`,
  `level: "ades"`, `origin: "external"`, `signatures.size == 1`;
- podepsané PDF (QES, `signer-qscd.p12`) → `200`, `level: "qes"`;
- podepsané PDF s pečetí (2 signatury) → `200`, `seal.present: true`, `seal.trusted: true`;
- nepodepsané PDF → `200`, `verdict: "unsigned"`, `signatures: []`;
- podepsané PDF + přidaná stránka → `200`, `verdict: "invalid"`, `modified: true`;
- podepsané PDF + DSS aktualizace → `200`, `verdict: "valid"`, `modified: false` (D6);
- self-signed cert s QcSSCD → `200`, `verdict: "valid_untrusted"`, `trusted: false`;
- `CompletedDocument` s hashem PDF → `200`, `origin: "docuseal"`; bez něj `external`;
- `POST /api/qes/verified_documents` s valid PDF → `200`, `stored: true`, `template_id`,
  template ve složce „Verified documents“, report v `preferences['qes_verification']`, PDF přiložené;
- store s tampered/unsigned PDF → `422 not_verifiable`, počet templateů se nezmění;
- šifrované PDF → `422 encrypted_pdf`;
- ne-PDF → `422 invalid_pdf`;
- příliš velké → `422 file_too_large`;
- bez tokenu → `401 not_authenticated`;
- `QES_ENABLED=false` → `404 disabled`;
- rate limit → `429 rate_limited`;
- verify nic neuloží: `ActiveStorage::Attachment.count` a `QesSession.count` beze změny;
- store uloží právě jeden template a jedno PDF; invalid/unsigned se neuloží;
- template show page s `qes_verification` → panel s verdiktem, náhledem a stažením PDF;
  normální template panel nezobrazí;
- `GET /templates/:id/qes_verification` s `Turbo-Frame: modal` → iframe na proxy PDF;
- stažení PDF z panelu → `Content-Disposition: attachment`.

`spec/lib/qes/verifier_spec.rb`: verdikt pro všech 5 stavů, `seal` agregace, `origin` scoped na účet.

`spec/lib/qes/pipeline_spec.rb` (rozšíření): `report[:signatures].first` má `kind`, `subject`, `issuer`,
`serial`, `not_before`, `not_after`, `chain`; `report[:modified]` je `false` pro podepsané PDF a `true`
pro přidanou stránku.

### 7.2 E2E

`make qes-verify-e2e` (`QES_PDF_E2E_REPORT=qes-verify-e2e-report.txt scripts/qes_pdf_e2e.py`):

1. reuse `qes_pdf_e2e.py` (upload → place → podpis kódem appky → completed → finální PDF),
2. `POST /api/qes/verify` s finálním PDF → `verdict: "valid"`, `origin: "docuseal"`,
   `signatures.size == 2`, `intact: true`, `trusted: true`, `level: "ades"`, `coverage: "full"`,
   `seal.present: true`;
3. `POST /api/qes/verified_documents` s finálním PDF → `stored: true`, `template_id`,
   `folder: "Verified documents"`;
4. tampered kopie → `verdict: "invalid"`, `intact: false`;
5. nepodepsané PDF → `verdict: "unsigned"`;
6. report `test/out/qes-verify-e2e-report.txt`.

`make qes-staging-verify-e2e` (volitelně): stejný krok proti stagingu po `qes-pdf-staging-e2e`
(finální PDF se ověří před úklidem tokenu); report `test/out/qes-verify-staging-report.txt`.

`make qes-eu-dss-verify` (volitelně, externí API): pošle `test/out/qes-final.pdf`,
`qes-pdf-final.pdf` a staging PDF na EU DSS a zkontroluje PAdES, pečeť, DocTS,
integritu a plné pokrytí. Testovací certy jsou untrusted; `TRUSTED=1` vyžaduje
`TOTAL_PASSED` a QES/AdES-QC pro reálný cert. Report `test/out/qes-eu-dss-report.txt`.
PDF opouští stroj; nespouštět v běžném CI.

### 7.3 Appka

- `make qes-app-test` + `make qes-app-typecheck`;
- `__tests__/pdfApi.test.ts`: `verifyDocument` pošle multipart na `/api/qes/verify`,
  `storeVerifiedDocument` na `/api/qes/verified_documents`, parsuje report, `422` → `PdfApiError`;
- `__tests__/verifyPdf.test.ts`: všech 5 verdiktů → české texty/barvy, `canStore`,
  `shareTargetRoute` (jen u dvou aliasů);
- emulátor: Home → „Ověřit PDF“ → podepsané PDF → zelený verdikt; nepodepsané → šedý;
  přidaná stránka → červený; share sheet „Podepsat PDF“ i open-with „Ověřit PDF“ → S14 → volba
  „Podepsat PDF“ / „Ověřit PDF“ → stejný výsledek (cold start i warm start).

### 7.4 Akceptační kritéria

1. `make qes-test-qes` zelené (nové specy součástí).
2. `make qes-test-postgres` zelené (660/0); `make qes-test` 659/0.
3. `make qes-verify-e2e` zelené (valid/docuseal, store, tampered invalid, unsigned).
4. `make qes-app-test` a `make qes-app-typecheck` zelené (223/0 + tsc).
5. Na emulátoru projde ověření v appce i ze share sheetu („Dokulachtan“ → „Ověřit PDF“).
6. Verify po sobě nezanechá PDF v ActiveStorage ani nový template.
7. Store uloží PDF do „Verified documents“ a report do `preferences['qes_verification']`.
8. Store s tampered/unsigned PDF → `422 not_verifiable`, počet templateů se nezmění.
9. Bez API tokenu → `401`; rate limit → `429`; šifrované PDF → `422`.
10. Na stagingu i produkční instanci ověřeno reálným requestem: staging test cert → `valid` + `origin=docuseal`,
    store → template 30, tampered → `invalid`, unsigned → `unsigned`; produkční instance test cert →
    `valid_untrusted` (root jen z `QES_VERIFICATION_TRUST_ROOTS`), unsigned → `unsigned`; `/up` 200 na obou.
11. V appce (APK 1.2.0) na emulátoru ověřeno: Home → „Ověřit PDF“ → staging PDF →
    žlutý verdikt „Podpis je platný, ale certifikát není důvěryhodný“ (produkční instance, test cert),
    soubor, podpisy a „Uložit do DocuSealu“; sdílení i otevření PDF otevírá S14 s volbou.
12. Web UI: template s `qes_verification` zobrazí panel s verdiktem a metadaty, náhled PDF
    v modalu a stažení PDF; normální template panel nezobrazí; request spec zelený.

## 8. Omezení v1 a další fáze

- **Jen PDF**, ne detached CMS/XML; ověření jiných formátů je další fáze.
- **Bez revokace** (D8): `revocation: "not_checked"`; plná revokace/LTV je další fáze
  (CRL/OCSP přes `QES_LTV_ALLOWED_HOSTS`, cache, časové razítko).
- **Ukládání jen na tlačítko** (D3/D13): automaticky se neukládá nic; uživatel může PDF uložit
  do „Verified documents“ (template + JSON report). Historie je pak v Documents, retence je věcí DocuSealu.
- **Jen `intact && !modified`** (D14): `invalid`/`unsigned` PDF se neukládají; když bude potřeba
  audit i těchto výsledků, přidá se samostatná tabulka `qes_verifications` bez PDF.
- **Náhled jen ve webu**: appka nepotřebuje PDF renderer; web má iframe s uloženým PDF.
- **Web UI jen pro uložené verified documents**: panel + náhled/stažení PDF; upstream „Verify PDF“
  (účetní certy) zůstává beze změny a sjednocení na `QES_VERIFICATION_TRUST_ROOTS` je další fáze.
- **Bez iOS share extension**: stejně jako dnes; ověření jen v appce.
- **Bez dávkového ověření** více PDF v jednom requestu; jedno PDF na request.
- **Externí ověření (appka, 2026-10-23):** volba „DocuSeal / EU DSS“ v S14,
  varování + checkbox a přímé volání EU DSS z appky; DocuSeal se nemění —
  [docs/19](19-overeni-pdf-externi.md).

## 9. Otevřené otázky

1. **Open-with label:** „Ověřit PDF“ (doporučeno), nebo obecný „Dokulachtan“? Doporučeno
   „Ověřit PDF“; share sheet zůstává „Podepsat PDF“.
2. **Revokace:** v1 nechat `not_checked` (doporučeno), nebo hned best-effort CRL?
   Doporučeno nechat na další fázi; korektní revokace potřebuje LTV/časové razítko.
3. **Trust roots:** přidat do produkční instance I.CA (a tím ověřovat i I.CA podpisy), nebo zůstat jen
   PostSignum? Doporučeno rozhodnout provozně; kód se nemění.
4. **Detail výsledku:** jednoduchý verdikt + rozbalitelné technické detaily (doporučeno), nebo
   jen jednoduchý verdikt? Doporučeno s detaily pro diagnostiku.
5. **Retence uložených „Verified documents“**: stejná jako u běžných Documents, nebo kratší?
   Doporučeno stejná (DocuSeal retence); řešit provozně, ne v kódu.
6. **Report PDF**: JSON v preferences je pro v1 dost; pokud bude potřeba uživatelský doklad,
   doplní se generovaný report PDF (další fáze).
