# 19 — Externí ověření PDF přes EU DSS (jen appka)

Status: **implementováno v appce** (2026-10-24, verze 1.3.4), DocuSeal se nemění. Navazuje na
[docs/16](16-overeni-pdf.md) a [docs/17](17-ui-hierarchie-akci.md).

## 1. Use case

Zaměstnanec ověřuje PDF, které dostal zvenčí, a chce si vybrat, **kde** se ověří:

1. **DocuSeal** — rychlé, soukromé, proti trust rootům DocuSealu (dnešní chování).
2. **EU DSS** — nezávislé, proti EU trusted listům a s revokací, ale PDF se odešle
   na servery Evropské komise (veřejné demo, bez SLA).

Volba je **per dokument**, ne globální nastavení. Default je vždy DocuSeal; externí volba
se nezapamatovává.

## 2. Rozhodnutí

| # | Rozhodnutí | Důvod |
|---|---|---|
| D1 | Volba je **radio group v S14** před primární akcí, ne checkbox „ověřit i externě“ | provideři se vylučují; checkbox by znamenal „ověřit obojím“ |
| D2 | Default **DocuSeal**; externí je opt-in | soukromí je default; PDF neopustí zařízení bez vědomého výběru |
| D3 | Externí volba má **inline varování + povinný checkbox** před primární akcí | disclaimer je vidět před odesláním, ne až v dialogu po klepnutí |
| D4 | Primární akce zůstává jedna; u externí volby se změní její label | uživatel vidí, co se stane; jedna primární akce zůstává |
| D5 | Externí volba se **nezapamatovává**; po „Ověřit jiné PDF“ se vrací DocuSeal | příští PDF může být důvěrné; bezpečný default |
| D6 | **Appka volá EU DSS přímo**, DocuSeal se nemění | zadání „jen v appce“; žádný nový serverový endpoint ani ENV |
| D7 | Externí provider je **plná validace QES podpisu** (integrita, trust, revokace, kvalifikace); pečeť, `origin` a `modified` nejsou dostupné | EU DSS umí trust/revokaci proti EU TL; pečeť účtu a `CompletedDocument` jsou jen na serveru |
| D8 | Žádný tichý fallback; při chybě `eu_dss_unavailable` a UI nabídne „Ověřit v DocuSealu“ | uživatel si vybral nezávislost; nesmí dostat lokální verdikt bez vysvětlení |
| D9 | Externí report se **neukládá**; „Uložit do DocuSealu“ zůstává jen pro lokální ověření | uložený report vzniká na serveru a musí být lokální; appka nemá kam uložit externí report |
| D10 | Report v appce má `provider`, `provider_name`, `provider_url`; lokální server report bez `provider` = `local` | UI a audit vědí, kdo ověřoval; server se nemění |
| D11 | Web UI se **nemění**; panel jen zobrazuje uložené lokální reporty | externí report se neukládá, web nemá co zobrazit |
| D12 | URL EU DSS je **konstanta v appce**; timeout 20 s | žádná nová konfigurace v DocuSealu; URL se mění v kódu appky |

## 3. UI

### 3.1 S14 — výběr před ověřením

| # | Prvek | Obsah | Chování |
|---|---|---|---|
| 1 | Titulek | „Ověřit PDF“ | beze změny |
| 2 | Popis | „PDF se nahraje kvůli ověření a neukládá se.“ | beze změny |
| 3 | Karta souboru | jen shared: „PDF z jiné aplikace“ + název | beze změny |
| 4 | **Radio group „Kde ověřit“** | „V DocuSealu“ / „Přes EU DSS“ | default DocuSeal; výběr mění zbytek |
| 5 | **Varování** | jen EU DSS: „PDF opustí DocuSeal“ + text | amber karta hned pod radio group |
| 6 | **Checkbox** | jen EU DSS: „Rozumím, PDF se odešle na servery Evropské komise.“ | povinný; bez něj je primární akce vypnutá |
| 7 | **Primární akce** | DocuSeal: „Vybrat PDF“ / „Ověřit PDF“; EU DSS: „Vybrat PDF (EU DSS)“ / „Ověřit přes EU DSS“ | vypnutá bez souboru / bez souhlasu |
| 8 | Sekundární akce | jen shared: „Podepsat PDF“ | beze změny |
| 9 | Terciární | „Zavřít“ | beze změny |

**Radio group** je karta se dvěma řádky; každý řádek má radio kruh, titulek a popis:

| Volba | Titulek | Popis |
|---|---|---|
| `local` | „V DocuSealu“ | „PDF zůstane na našem serveru. Ověření proti trust rootům DocuSealu.“ |
| `eu_dss` | „Přes EU DSS“ | „PDF se odešle na servery Evropské komise. Ověření proti EU trusted listům.“ |

**Varování (jen `eu_dss`)** — text:

> Pro nezávislé ověření se PDF odešle na veřejnou demo službu EU DSS (Evropská komise).
> Neposílejte důvěrné dokumenty. Služba je bez SLA a může být přetížená. Certifikát musí
> být v EU trusted listu, jinak ověření vyjde jako nedůvěryhodné.

**Checkbox** — text: „Rozumím, PDF se odešle na servery Evropské komise.“

Checkbox se resetuje při přepnutí na `local` i po dokončení ověření. Primární akce
je vypnutá, dokud není zaškrtnutý; u `local` se checkbox ani varování nezobrazují.

**Proč radio group, ne checkbox:** dva provideři nejsou aditivní; checkbox „ověřit i externě“
by znamenal dvojí odeslání a dva verdikty. Radio group odpovídá „jedna primární akce“ a je
to stejný vzor jako volba úrovně v S11.

### 3.2 S15 — výsledek

| # | Prvek | Obsah |
|---|---|---|
| 1 | **Badge provider** | „Ověřeno: DocuSeal“ / „Ověřeno: EU DSS“ |
| 2 | Velký verdikt | existující texty; u `eu_dss` upravené (níže) |
| 3 | Karta souboru | název, velikost, datum; `origin` jen u lokálního |
| 4 | Karta „Podepsal“ | CN, issuer, level, čas, coverage, trusted |
| 5 | Karta „Kontrola“ | intact, změny, coverage, revokace, pečeť |
| 6 | Karta „Externí ověření“ | jen `eu_dss`: „PDF bylo odesláno na servery Evropské komise (EU DSS).“ |
| 7 | Seznam podpisů | beze změny (u `eu_dss` jen QES, bez pečeti) |
| 8 | Primární | „Ověřit jiné PDF“ (reset na `local`) |
| 9 | Sekundární | „Uložit do DocuSealu“ jen u `local`; u `eu_dss` text „Externí ověření se neukládá.“ |
| 10 | Terciární | „Technické detaily“ |
| 11 | Terciární | „Zavřít“ |

**Texty verdiktu u `eu_dss`:**

| Verdikt | Dnes | `eu_dss` |
|---|---|---|
| `valid` | „Podpis je platný (QES/AdES)“ | „Podpis je platný (QES/AdES) — ověřeno přes EU DSS“ |
| `valid_untrusted` | „Podpis je platný, ale certifikát není důvěryhodný“ | „Podpis je platný, ale certifikát není v EU trusted listu“ |
| `valid_unqualified` | „PDF je podepsané, ale ne kvalifikovaným podpisem“ | beze změny |
| `invalid` | „PDF bylo po podpisu změněno“ / „Podpis je neplatný“ | beze změny |
| `unsigned` | „PDF není podepsané“ | beze změny |

**Karta „Kontrola“ u `eu_dss`:**

- „Podpisy jsou v pořádku“ / „Podpis je neplatný“ (z DSS),
- „Změny po podpisu: neověřeno (externí ověření)“ — externí služba změny po podpisu
  nekontroluje; pro kontrolu změn je lokální ověření,
- „Pokrytí: …“ (z DSS),
- „Revokace: ověřena (EU DSS)“ / „certifikát je revokován“ / „nepodařilo se ověřit“,
- „Pečeť DocuSealu: neověřená (externí ověření)“.

**Karta „Externí ověření“ u `eu_dss`:**

> PDF bylo odesláno na servery Evropské komise (EU DSS). Externí ověření nekontroluje
> změny po podpisu ani pečeť DocuSealu; pro kontrolu změn použijte ověření v DocuSealu.

**Technické detaily:** `Důvěryhodné kořeny: EU trusted list (EU DSS)` u `eu_dss`,
jinak `trusted_roots` ze serveru; `messages` z DSS jsou anglicky.

### 3.3 Web UI

Web UI se **nemění**: panel „Ověření PDF“ zobrazuje jen uložené lokální reporty.
Externí report se neukládá, takže se v webu neobjeví.

## 4. Appka

### 4.1 `src/lib/euDssApi.ts` (nový)

- `EU_DSS_URL` = `https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/services/rest/validation/validateSignature`,
- `EU_DSS_TIMEOUT_MS` = 20 000,
- `EuDssApi.verifyDocument(file)`:
  - PDF jako base64 (`File.base64()` nebo `toBase64(bytes)`),
  - `POST` JSON `{"signedDocument":{"bytes": base64, "name": ...}}`,
  - `AbortController` + timeout,
  - `SimpleReport` + `DetailedReport` → `PdfVerification`,
  - `provider: "eu_dss"`, `provider_name: "EU DSS"`, `provider_url: EU_DSS_URL`,
  - `origin: "unknown"`, `seal: { present, trusted: false, count }`,
  - `signatures` jen QES (pečeť a timestamp se agregují zvlášť),
  - `revocation` z `SubIndication` (`REVOKED` → `revoked`, `TOTAL_PASSED` → `good`,
    jinak `unknown`; bez podpisů `not_checked`),
  - `level` z `SignatureQualification` (`QESig` → `qes`, `AdESig` → `ades`, jinak `none`),
  - `coverage` z `SignatureScope` (`FULL` → `full`, jinak `partial`/`none`),
  - `intact` z `Indication`/`SubIndication` (`TOTAL_FAILED`/`HASH_FAILURE` →
    `false`),
  - `modified` = některý podpis není `intact` (konzervativní; externí služba
    nerozliší změnu po podpisu od neplatného podpisu),
  - `sha256` z base64 přes `node-forge`,
  - chyby: `eu_dss_unavailable` (timeout/5xx/429/network), `eu_dss_error`
    (4xx/neplatná odpověď), `invalid_pdf`.

### 4.2 `src/lib/pdfApi.ts`

- `PdfProvider = 'local' | 'eu_dss'`,
- `PdfVerification` má `provider`, `provider_name`, `provider_url`,
  `origin: 'docuseal' | 'external' | 'unknown'`,
- `PdfApi.verifyDocument` a `storeVerifiedDocument` obalí serverový report na
  `provider: "local"`, `provider_name: "DocuSeal"`, `provider_url: null`;
  serverový JSON se nemění.

### 4.3 `src/lib/verifyPdf.ts`

- `verdictView` rozlišuje `provider` (externí texty výše),
- `canStore` jen `provider === 'local' && intact && !modified && !stored`,
- `originLabel('unknown')` → „Původ neověřen“,
- `revocationLabel` (`not_checked` / `good` / `revoked` / `unknown`).

### 4.4 Share intent: prázdná cache kopie

`expo-share-intent` někdy předá `path` jako **0bajtovou cache kopii**; původní soubor
zůstává v `contentUri`. `resolveSharedPdfFile` proto preferuje `contentUri` a kopíruje ho
nativním `OpenPdfModule.copyPdf` do cache (stejná cesta jako open intent). Tím se opravil
500 z EU DSS: appka dřív poslala prázdné PDF. `EuDssApi` navíc před odesláním kontroluje
base64 hlavičku `%PDF-` (`JVBERi0`) a prázdný/ne-PDF soubor vrátí jako `invalid_pdf`,
ne jako HTTP 500.

**Diagnóza 500 (2026-10-24):** `qes-final-4.pdf` vrací z EU DSS přímo **200**
(`Jan Novák TOTAL_PASSED`, `DocuSeal INDETERMINATE`). 500 v appce
vzniklo tím, že share intent předal **0bajtovou cache kopii**; EU DSS na prázdný
dokument vrací `500 DSSDocument is null`. Po opravě se používá původní
`contentUri`; prázdný/ne-PDF vstup se odmítá jako `invalid_pdf`.

**Diagnóza „untrusted“ (2026-10-24):** DSS vrací pro český PostSignum certifikát
`SignatureQualification: AdESig-QC` (AdES s kvalifikovaným certifikátem) a
`TOTAL_PASSED`. Appka znala jen `QESig`/`AdESig`, takže `AdESig-QC` mapovala na
`none` a certifikát označila jako nedůvěryhodný. Opraveno: `AdESig-QC` → `ades`,
`trusted: true`; `coverage` se bere z posledního QES podpisu, ne z pečeti.

### 4.5 `app/verify-pdf.tsx`

- stav `provider` (`local` default) a `consent` (false),
- radio group + varování + checkbox (jen `eu_dss`),
- `verify` volá `EuDssApi` přímo, nebo `PdfApi` na server,
- `store` jen u `local`; u `eu_dss` text „Externí ověření se neukládá.“,
- `reset` vrací `provider` na `local` a `consent` na `false`,
- `ERROR_TEXT` má `eu_dss_unavailable` a `eu_dss_error`.

## 5. Bezpečnost a soukromí

| Hrozba | Opatření |
|---|---|
| Nechtěné odeslání PDF | default `local`; externí jen po radio + checkboxu; bez zapamatování |
| Únik PDF do EU | povinný disclaimer; PDF se neukládá; appka neloguje obsah ani název |
| Zneužití externí služby | timeout, limit velikosti, EU demo má vlastní rate limit; bez souhlasu se neposílá |
| Podvržený report | externí report se neukládá; store znovu ověří lokálně na serveru |
| Falešný trust | `trusted` z DSS; pečeť se u externího ověření netvrdí jako ověřená |
| Závislost na demu | URL je konstanta v appce; self-hosted DSS jde změnit v kódu |

## 6. Testy

- `__tests__/euDssApi.test.ts` (12/0): request base64, valid QES, untrusted,
  `AdESig-QC`, seal agregace, coverage QES, tampered, unsigned, 429, network,
  invalid response, empty/non-PDF vstup.
- `__tests__/pdfApi.test.ts`: lokální report má `provider: "local"`.
- `__tests__/verifyPdf.test.ts`: externí texty, `canStore`, `originLabel`,
  `revocationLabel`.
- `make qes-app-test` 223/0, `make qes-app-typecheck` zelené.
- `make qes-eu-dss-verify` (volitelné): nezávislý compliance check vygenerovaných
  PDF přes EU DSS API; test certy untrusted, `TRUSTED=1` pro reálný cert;
  report `test/out/qes-eu-dss-report.txt`. PDF opouští stroj, nespouštět v CI.

## 7. Omezení

- **Jen PDF**, ne detached CMS/XML.
- **Share intent:** prázdná cache kopie se nahradí `contentUri`; bez toho EU DSS
  dostávalo 0bajtové PDF a vracelo 500. Ověřeno na `qes-final-4.pdf` (EU DSS 200).
- **Externí ověření nekontroluje `origin`, `seal.trusted` ani `modified`**;
  pro kontrolu změn a pečeti použij lokální ověření v DocuSealu.
- **Externí report se neukládá**; store je jen pro lokální ověření.
- **Testovací certy nejsou v EU trusted listu** → externí ověření vyjde
  `valid_untrusted`; produkční instance s PostSignum certem → `valid`.
- **Web UI se nemění**; externí report se v webu nezobrazí.
- **Bez dávkového ověření**; jedno PDF na request.
