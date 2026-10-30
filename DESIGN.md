# DESIGN.md — aplikační design dokulachtan

Datum: 2026-10-15
Revize: 2026-10-22 — sdílení PDF do appky (Android share sheet, docs/15 § 6); 2026-10-18 — přímý podpis PDF
(fork jako obecná podpisová služba, docs/15).

Tento dokument popisuje **celý plánovaný model a interakce**: kdo s kým mluví, co se kde ukládá,
jaké jsou stavy a jak vypadá podpisová appka. Je to design, ze kterého se v dalším kroku udělá
detailní specifikace (obrazovky, endpointy, testy). Rozhodnutí a jejich odůvodnění jsou
v `docs/04`–`docs/09`.

> **Závazný je tento dokument (DESIGN.md).** Popisuje *co a proč* — lidský, high-level koncept.
> [SPEC.md](SPEC.md) je z něj odvozená **agentní detailní specifikace** (*jak přesně*: model, API,
> obrazovky, testy). Když si dokumenty odporují, je to **chyba** — opraví se DESIGN (koncept) a podle
> něj SPEC; historie už provedených oprav je v [SPEC.md](SPEC.md) § 16.
> Řetěz je: **DESIGN (koncept) → SPEC (detailní specifikace) → implementace**.

---

## 1. Cíl a rozsah

Firma pošle dokument k podpisu; zaměstnanec ho podepíše **svým certifikátem** z mobilu tak, aby
**klíč nikdy neopustil jeho zařízení**. Podepsaný dokument a záznam o podpisu zůstávají v DocuSealu.

**Hlavní výstup a kritérium hotovo:** finální PDF v DocuSealu s **platným digitálním podpisem**
podepisujícího, ověřené nezávislým validátorem (pyHanko/pdfsig). Záznam o podpisu v DocuSealu je
**důkaz a dohledatelnost, ne cíl**.

**Jak se finální PDF staví:** podepsané PDF z appky se **nepřestavuje** (žádný import stránek);
pečeť DocuSealu se případně přidá **inkrementálně až po** podpisu appky. Detail: 7.4.

V rozsahu (v1):
- fork DocuSealu (server) s novým typem pole a podpisovým obřadem,
- mobilní appka (Expo) pro **variantu B** (klíč v telefonu) **i variantu A** (čip eObčanky přes MOI Podpisové SDK),
- e-mailová pozvánka, podpisový odkaz, deep link, návrat výsledku,
- přímý podpis PDF a sdílení PDF do appky (Android share sheet, v1.6/v1.7),
- audit a validace podpisu.

Mimo rozsah: remote QTSP (varianta C), WebCrypto varianta B', podpora cizích e-mailových klientů,
vlastní certifikační autorita.

**Rozšíření v1.6 (schváleno 2026-10-18, přepsáno na nativní tok): přímý podpis PDF.** Zaměstnanec vybere PDF
v appce, umístí pečeť klepnutím do náhledu stránky, podepíše a výsledek najde v DocuSealu; fork přidává jediný
endpoint `POST /api/qes/documents` (PDF → šablona ve složce „Direct signing“) a zbytek je standardní DocuSeal
tok — šablona, submission, obřad, audit i úklid. Klíč zůstává v zařízení, server vidí jen PDF. Detail a rozhodnutí
D1–D13: [docs/15-primy-podpis-pdf.md](docs/15-primy-podpis-pdf.md).

**Rozšíření v1.7 (2026-10-22): sdílení PDF do appky (Android).** Zaměstnanec dostane PDF mimo DocuSeal
a chce ho podepsat, aniž by ho musel ukládat na disk a hledat v appce: v Android share sheetu je **„Podepsat PDF“**,
appka otevře S11 s už vybraným souborem a **rovnou ho nahraje** (bez ručního ukládání a hledání). Klíč zůstává
v zařízení, server vidí jen PDF. iOS share extension je mimo rozsah. Detail: docs/15 § 6, SPEC § 9.9 krok 0.

**Rozšíření v1.8 (hotovo 2026-10-22): ověření PDF.** Zaměstnanec chce ověřit cizí i vlastní PDF —
jestli je podepsané, kým, čím a jestli s ním po podpisu někdo nemanipuloval. Ověření běží na serveru
(`Qes::Validator` + `VerifyPdfSignature`), appka PDF nahraje a zobrazí verdikt; PDF se na serveru
**neukládá automaticky** — jen na tlačítko do složky „Verified documents“ (Documents). Stejně jako u podpisu
jde PDF sdílet do appky (Android share sheet „Dokulachtan“ → volba „Podepsat PDF“ / „Ověřit PDF“).
Detail a rozhodnutí D1–D14: [docs/16-overeni-pdf.md](docs/16-overeni-pdf.md).

---

## 2. Aktéři a komponenty

| Aktér/komponenta | Role |
|---|---|
| **Sender** | zaměstnanec firmy; vytvoří šablonu/submission v DocuSealu (UI nebo API) |
| **Signer** | zaměstnanec; otevře odkaz, zkontroluje dokument, podepíše v appce |
| **DocuSeal (fork)** | workflow, šablony, pole, e-maily, audit, úložiště; nově i QES obřad |
| **QES modul (ve forku)** | `Qes::Providers`, `QesSession`, endpointy, vložení PAdES |
| **Podpisová appka (Expo)** | drží klíč, zobrazí potvrzení, podepíše podepsané atributy CMS |
| **Čtečka + občanka (A)** | zdroj QES klíče; appka s ní komunikuje (BLE) — client-side |
| **Validátor** | ověření výsledného PDF (Pdfium ve forku, pyHanko/DSS v testech) |
| **Fly.io** | provoz (1 app + volume + SQLite pro staging) |

---

## 3. Doménový model

```
Account
 └── Template ── fields[] (…, type: "qes")
      └── Submission
           └── Submitter ── QesSession (1:N, aktivní max 1)
                └── documents (podepsané PDF)
```

### 3.1 Template a pole

- Nový typ pole **`qes`**: chová se jako `signature` (role, pozice, povinnost), ale místo kreslení
  spouští certifikátový obřad.
- Šablona může mít `qes` i běžná pole; signer vyplní ostatní pole standardně.
- `preferences.level` = `ades` (default) nebo `qes`; `qes` vyžaduje certifikát s `QcSSCD`.
- **Firemní podpisy (potvrzeno 2026-10-17):** dokument podepisuje **více stakeholderů** (jednatel,
  finanční ředitel, HR, …) a výsledek musí být digitálně podepsaný **všemi**. Každý signer má vlastní
  pole `qes` a vlastní certifikát; podpisy jdou **striktně po sobě** a řetězí se inkrementálně
  (PAdES multi-signature). Každý podpis zůstává INTACT, `combined_document` je poslední revize.
- **Stejná osoba ve víc rolích:** jedna osoba může mít víc polí `qes` (třeba podepisuje jako
  jednatel i jako člen představenstva); její další podpis se řetězí na **její vlastní** předchozí revizi,
  ne na revizi jiného podepisujícího — žádný podpis se nezahodí.
- **Interní `qes:<id>` se uživateli nikdy neukazuje**; v poli dokumentu i v kartě podepisujícího
  je přehled podpisu (kdo, čím, kdy, platnost, pečeť) a plná metadata jsou v auditu.

### 3.2 QesSession

| Atribut | Význam |
|---|---|
| `id` | interní |
| `submitter_id` | komu patří |
| `provider` | `mobile_app` (B i A) / `mock` (testy) |
| `level` | `none` / `ades` / `qes` (dle certu; určí se při přijetí certifikátu) |
| `key_location` | `phone_keystore` (B) / `card` (A) |
| `state` | viz stavový automat |
| `token_digest` | sha256 jednorázového tokenu pro appku (token sám se neukládá) |
| `tbs_document` | TBS PDF s podpisovým polem a rezervou (ActiveStorage) |
| `signed_attrs_der` | DER podepsaných atributů CMS (co appka podepisuje) |
| `signature` | raw signatura od appky |
| `certificate_info` | subject, issuer, serial, platnost, QCStatements (AdES/QES) |
| `certificate_chain` | řetěz certifikátů |
| `document_digest` | SHA-256 ByteRange (pro kontrolu a audit; spočítá se při přijetí certifikátu) |
| `signed_pdf_sha256` | SHA-256 `signed_document` (**před** pečetí) |
| `final_pdf_sha256` | SHA-256 `final_document` (s pečetí) |
| `validation_report` | výsledek validace (stav, čas, LTV) |
| `seal_state` | `none` / `applied` / `failed` (pečeť DocuSealu) |
| `doc_timestamp_state` | `none` / `applied` / `failed` (DocTS, PAdES-LTA) |
| `app_metadata` | self-reported platforma a verze appky (do auditní stránky) |
| `signed_document` | PDF s podpisem appky (před pečetí, ActiveStorage) |
| `final_document` | finální PDF s pečetí (artefakt do `documents`) |
| `expires_at` | expirace session (5–10 min) |
| `completed_at` | dokončení |

### 3.3 Stavový automat QesSession

```
created ──prepare──▶ prepared ──issue_token──▶ awaiting_app
   │                                             │
   │                                       app_opened
   │                                             │
   │                                    awaiting_signature
   │                                             │
   │                                        signed ──embed──▶ embedded
   │                                             │              │
   │                                             │        validated ──▶ completed
   │                                             │
   └──────────── expired / failed / cancelled / declined ◀──────────┘
```

Přechody:

| Z → Do | Trigger | Kdo |
|---|---|---|
| created → prepared | session připravena (TBS se staví až při přijetí certifikátu) | server |
| prepared → awaiting_app | token + deep link vygenerován | server |
| awaiting_app → app_opened | appka si vyzvedla metadata | appka |
| app_opened → awaiting_signature | appka poslala certifikát → TBS PDF (rezerva dle CRL) + CMS placeholder + signed attrs | appka |
| awaiting_signature → signed | appka poslala raw signaturu | appka |
| signed → embedded | server vložil CMS do PDF | server |
| embedded → validated → completed | validace OK (+ pečeť) | server |
| * → expired | `expires_at` | server (job) |
| * → failed | chyba (token, podpis, validace) | kdokoli |
| * → cancelled/declined | uživatel | signer |

### 3.4 Stav submittera a pole

- `Submitter`: `sent` → `opened` → `completed` (nebo `declined`).
- Pole `qes` v podpisovém formuláři: `empty` → `pending` (session běží, „čekáme na appku“) →
  `signed` (hotovo) / `failed`.

---

## 4. Workflow end-to-end (varianta B)

```
Sender        DocuSeal (fork)        Appka (Expo)         Signer
  │                 │                     │                  │
  │ vytvoří         │                     │                  │
  │ submission      │                     │                  │
  │────────────────▶│                     │                  │
  │                 │ e-mail s odkazem    │                  │
  │                 │───────────────────────────────────────▶│
  │                 │                     │        otevře odkaz (prohlížeč)
  │                 │◀───────────────────────────────────────│
  │                 │ PDF + pole          │                  │
  │                 │───────────────────────────────────────▶│
  │                 │                     │      vyplní pole, zkontroluje
  │                 │◀───────────────────────────────────────│
  │                 │ klik „Podepsat“     │                  │
  │                 │──prepare session──▶ │                  │
  │                 │ TBS PDF             │                  │
  │                 │ deep link / QR      │                  │
  │                 │───────────────────────────────────────▶│
  │                 │                     │◀──otevře appku───│
  │                 │◀──GET metadata─────│                  │
  │                 │───metadata─────────▶│                  │
  │                 │◀──POST certifikát───│                  │
  │                 │───signed attrs────▶│                  │
  │                 │                     │  biometrie / QPIN │
  │                 │◀──POST signatura────│                  │
  │                 │ embed CMS + TSA+LTV │                  │
  │                 │ validace + pečeť    │                  │
  │                 │ audit + notifikace  │                  │
  │◀────────────────│                     │                  │
```

### Detailní kroky

1. **Příprava (sender).** Šablona s polem `qes`; submission (UI nebo API) s příjemci.
2. **Pozvánka.** DocuSeal pošle e-mail s podpisovým odkazem (nebo se použije API a odkaz předá
   jinak; ve stagingu bez SMTP přes API).
3. **Otevření (signer).** Prohlížeč zobrazí dokument + pole (PDF.js). Signer zkontroluje obsah.
4. **Vyplnění polí.** Ostatní pole se uloží (jako dnes).
5. **Spuštění podpisu.** Klik na `qes` pole → `POST /s/:submit_form_slug/qes_sessions`:
   - server vytvoří `QesSession`,
   - vygeneruje jednorázový token (TTL 5–10 min) a deep link,
   - vrátí `{id, state, token, universal_link, fallback_url, custom_scheme_link, expires_at, poll_interval_ms}`;
     stránka zobrazí tlačítko + QR a čeká.
   (CMS s podepsanými atributy vzniká až po přijetí certifikátu — server cert podepisujícího předem nezná.)
6. **Předání do appky.** Deep link `dokulachtan://sign?token=…&server=<origin>` (na desktopu QR). Appka token
   vymění za payload: `GET /qes/sessions/:token` → `{document_name, signer_name, hash_algorithm,
   level_required, expires_at, server_url}`.
7. **Potvrzení v appce.** Appka zobrazí: název dokumentu, kdo podepisuje, jaký certifikát se použije,
   a vyžádá biometrii (B) / QPIN (A).
8. **Podpis.** Appka pošle certifikát (`POST /qes/sessions/:token/certificate`); server postaví TBS PDF
   s rezervou podle CRL podepisujícího a spočítá `document_digest`, appka dostane `data_to_sign`;
   podepíše ho klíčem z úložiště (`node-forge`, PKCS#1 v1.5 / MOI SDK `signData`)
   a pošle `POST /qes/sessions/:token/complete` s raw signaturou.
9. **Vložení a validace.** Server:
   - ověří raw signaturu proti certifikátu (kryptograficky),
   - sestaví finální CMS (raw signatura do `SignerInfo`, TSA token do unsigned attrs; LTV jde do DSS),
   - vloží CMS do TBS PDF (HexaPDF, PAdES), přidá DSS a DocTS,
   - ověří výsledek (Pdfium; pro kritérium hotovo viz 1 a 7.4) a uloží jako dokument submittera,
   - přidá inkrementálně pečeť DocuSealu (pokud je k dispozici PKCS) → `final_document`,
   - zapíše audit (cert, čas, hash, úroveň, výsledek) — stránka QES v audit trailu,
   - označí submittera `completed` a spustí standardní DocuSeal dokončení.
10. **Výsledek.** Signer vidí potvrzení (a může PDF stáhnout); sender dostane notifikaci a v DocuSealu
    je finální dokument **podepsané PDF** — combined document se pro QES submission **nestaví znovu**,
    použije se podepsané PDF (viz 7.4).

**Více podepisujících (firemní podpisy).** Krok 5–9 proběhne pro každého signera v pořadí šablony:
DocuSeal pošle pozvánku až po dokončení předchozího signera (`submitters_order: preserved`).
TBS dalšího signera se staví **otevřením finálního PDF předchozího signera** a podpis se přidává
jako **nová inkrementální revize** — žádná přestavba stránek, žádný import. Každý signer má vlastní
`QesSession`, vlastní token i vlastní `documents` (revize v okamžiku jeho podpisu).

### Přímý podpis PDF (mimo DocuSeal submission, v1.6)

Zaměstnanec dostane PDF mimo DocuSeal (e-mailem, WhatsApp, stažené z portálu) a podepíše ho v appce
**standardním tokem DocuSealu**: `POST /api/qes/documents` nahraje PDF a založí šablonu s polem `qes`
ve složce „Direct signing“; appka zobrazí náhled stránky ze serveru, klepnutím umístí pečeť
(`PATCH /api/templates/:id`), založí submission a spustí obřad. Pak **dnešní obřad beze změny**
(`GET /qes/sessions/:token/document` → `certificate` → `complete`) a `POST …/complete_submission`
vygeneruje finální PDF i auditní stránku. Server dělá jen obal (TBS, CMS, TSA,
LTV, DSS, pečeť, validace); klíč zůstává v zařízení. Detail:
[docs/15-primy-podpis-pdf.md](docs/15-primy-podpis-pdf.md).

---

## 5. Podpisová appka (Expo)

### 5.1 Obrazovky

Přesná specifikace obrazovek (stavy, chyby, texty): [SPEC.md](SPEC.md) § 9.1 (S1–S15) a příloha D (§ 21).
Pořadí a váha tlačítek: [docs/17-ui-hierarchie-akci.md](docs/17-ui-hierarchie-akci.md) — jedna primární akce
na stav, alternativy za oddělovačem, navigace a „Zrušit“ jako textové odkazy.

| # | Obrazovka | Obsah a akce |
|---|---|---|
| S1 | **Home** | stav certifikátu (žádný / platný / expiruje < 30 dní), s klíčem primární „Podepsat PDF“ + sekundární „Ověřit PDF“, bez klíče primární import; karta certifikátu je klikací → S3; čtečka a nastavení jako textové odkazy |
| S2 | **Import certifikátu** | výběr PKCS#12, zadání hesla, primární „Importovat“ (vypnuté bez souboru), testovací certifikát až za oddělovačem jako alternativní cesta, souhrn + „Hotovo“ |
| S3 | **Detail certifikátu** | subject, issuer, platnost, sériové číslo, úroveň (AdES/QES dle QCStatements), „Importovat jiný klíč“, nebezpečná zóna se smazáním (potvrzení) |
| S4 | **Žádost o podpis** (deep link) | název dokumentu, kdo podepisuje, certifikát, úroveň, automaticky zvolený podepisující (§ 9.8 SPEC), „Podepsat“ |
| S5 | **Biometrie** | systémová výzva (otisk/obličej) před každým podpisem |
| S6 | **Výsledek** | úspěch (úroveň, čas, hash) / chyba s možností zkusit znovu |
| S7 | **Nastavení** | server URL + API token jen pro přímý podpis PDF a ověření PDF (primární „Uložit“), seznam důvěryhodných serverů pro podpisové odkazy s možností odvolat důvěru, sekce Podepisování (certifikát → S3, čtečka → S8), diagnostika, o aplikaci (+ attribution MOI SDK); smazání dat je jen v S3, testovací certifikát jen v S2 |
| S8 | **Připojení čtečky** (A) | párování BLE, výběr čtečky, stav baterie |
| S9 | **Výběr certifikátu z karty** (A) | seznam kontejnerů, jen kvalifikované, QPIN |
| S10 | **Konfigurační wizard** | když není podepisující: primární import klíče (PKCS#12), sekundární nastavení čtečky, testovací certifikát až na konci, „Zpět“ |
| S11 | **Výběr PDF** (přímý podpis) | `expo-document-picker` **nebo PDF ze share sheetu (Android, štítek „Podepsat PDF“, rovnou upload)** jako sekundární pole, jméno souboru, jméno do pečeti (default CN z vaultu), úroveň (AdES/QES), primární „Pokračovat“ (vypnuté bez souboru), „Zrušit“ |
| S12 | **Umístění pečeti** (přímý podpis) | náhled stránky ze serveru, přepínání stránek, klepnutí → obrys pečeti, primární „Podepsat“ (vypnuté bez umístění), „Vybrat jiné PDF“ a „Zrušit“ |
| S13 | **Výsledek PDF** (přímý podpis) | reuse S6 + primární „Stáhnout a sdílet“ + sekundární „Zavřít“ |

### 5.2 Interakce a stavy

- **Deep link**: `dokulachtan://sign?token=…&server=<origin>`; appka při otevření načte payload (HTTPS).
- **Token**: jednorázový; appka ho drží jen v paměti, neukládá.
- **Biometrie**: vyžádána před každým podpisem; u klíče ji vynucuje SecureStore (`requireAuthentication`).
- **Klíč**: při importu se PKCS#12 dešifruje heslem a klíčový materiál se **ihned přešifruje**
  AES-256-GCM klíčem z `expo-secure-store` (heslo se zahodí a nikdy neukládá). Vault klíč je náhodný
  256bitový a SecureStore ho vydá jen po biometrickém ověření (`requireAuthentication`); šifrovaný payload
  je v souboru v dokumentovém úložišti. Při podpisu se odemyká jen biometrií — **žádné zadávání hesla** —
  klíč se použije v paměti a zahodí; nikdy se neposílá.
- **Volba podepisujícího**: **automaticky** (bez ptaní) podle `level_required` a konfigurace appky:
  pro QES čtečka, pro AdES klíč → čtečka → wizard (S10); server cert podepisujícího předem nezná.
  Detail: SPEC § 9.8.
- **Chyby**: expirovaný token („vyžádejte nový odkaz“), síťová chyba (retry), neplatný cert
  (znovu import), zamítnutá biometrie (zrušeno).
- **Offline**: v1 nepodporováno (payload i dokončení potřebují server).
- **Sdílení PDF** (Android, docs/15 § 6): PDF z jiné appky → share sheet → „Podepsat PDF“ → S11
  s vybraným souborem a rovnou upload (bez ručního ukládání); iOS share extension není v rozsahu.

### 5.3 Datové toky appky

```
Import:   soubor PKCS#12 ─▶ heslo ─▶ parse (node-forge) ─▶ kontrola ─▶ přešifrování AES-256-GCM ─▶ soubor
Podpis:   deep link ─▶ GET metadata ─▶ volba podepisujícího (klíč → čip → wizard)
          ─▶ GET document (nepodepsaný TBS) ─▶ kontrola uživatelem
          ─▶ biometrie (SecureStore) ─▶ POST certificate ─▶ ověření data_to_sign proti reviewed TBS
          ─▶ sign(data_to_sign) ─▶ POST complete ─▶ ověření finálního PDF
```

---

## 6. Varianta A (občanka) — client-side

- Stejný obřad, stejná appka; místo klíče v telefonu se použije **čip občanky**:
  - appka komunikuje se čtečkou (BLE) a čipem přes **oficiální MOI Podpisové SDK**
    (`ApduProvider.initializeSession` → `getContainerList` → `signData`), PIN/**QPIN** zadává uživatel
    v dialogu SDK (QPIN schvaluje kvalifikovaný podpis),
  - podpis vzniká v čipu (QSCD) → **QES**.
- Server o čipu nic neví; dostane jen raw signaturu (jako u B). Žádné PKCS#11 na serveru.
- Na desktopu (budoucí): lokální agent / rozšíření prohlížeče se stejným protokolem.
- **Důsledek pro deployment:** varianta A funguje jen tam, kde je čtečka (mobil/PC uživatele),
  ne v cloudu serveru.
- **Kdy se použije:** appka zvolí čip, když není importovaný klíč a je nastavená/spárovaná čtečka;
  jinak se použije klíč, nebo se spustí wizard S10 (SPEC § 9.8).
- Podporované čtečky a licence SDK: [SPEC.md](SPEC.md) § 9.4.

---

## 7. Server (fork) — moduly a rozhraní

### 7.1 Soubory

Přesný seznam souborů a odpovědností: [SPEC.md](SPEC.md) příloha A (§ 18).

Nové (vše v `app/lib/qes/`, Rails autoloaduje `app/**`):
```
app/lib/qes/controller_concern.rb              # společné chování QES controllerů
app/lib/qes/providers/mobile_app.rb            # varianta B i A (společná cesta: app podepíše signed attrs)
app/lib/qes/providers/mock.rb                  # testy (PKCS#12 z fixtures)
app/lib/qes/value_validator.rb                 # kontrola formátu hodnoty qes pole
app/lib/qes/session_manager.rb                 # stavový automat
app/lib/qes/token.rb                           # token (generování, sha256)
app/lib/qes/tbs_document.rb                    # TBS PDF (spojení dokumentů + podpisové pole)
app/lib/qes/stamp.rb                           # viditelná pečeť podepisujícího
app/lib/qes/cms_builder.rb                     # CMS placeholder → signed attrs → finální CMS
app/lib/qes/certificate_info.rb                 # QCStatements, level, keyUsage
app/lib/qes/ltv.rb                             # CRL pro DSS (HexaPDF 1.7 LTV neumí)
app/lib/qes/dss.rb                             # DSS slovník s VRI
app/lib/qes/doc_timestamp.rb                   # DocTS (PAdES-LTA)
app/lib/qes/timestamp_token.rb                 # RFC 3161 token (TSTInfo v eContent)
app/lib/qes/validator.rb                       # Pdfium + pokrytí + úroveň + digest
app/lib/qes/verifier.rb                        # report pro ověření PDF
app/lib/qes/pdfium_trust.rb                    # orchestrace ověření (upstream primitivy)
app/lib/qes/pdf_source.rb                      # kontrola PDF a normalizace rotace
app/lib/qes/pdf_upload.rb                      # upload PDF (přímý podpis)
app/lib/qes/seal.rb                            # inkrementální pečeť DocuSealu
app/lib/qes/result_attachments.rb               # hook: finální PDF → documents
app/lib/qes/revision_changes.rb                 # hranice změn po podpisu
app/lib/qes/signing_values.rb                 # snapshot hodnot a defaultů při dokončení
app/lib/qes/audit_page.rb                      # stránka QES v audit trailu
app/lib/qes/hooks.rb                           # hooky do generování PDF
app/lib/qes/extensions.rb, app/lib/qes/extensions/**  # prependy pro nové chování
app/lib/qes/link.rb, rate_limiter.rb
app/models/qes_session.rb
app/controllers/qes/sessions_controller.rb       # app-facing (token)
app/controllers/qes/form_sessions_controller.rb # browser-facing
app/controllers/qes/app_controller.rb           # web fallback
app/controllers/qes/well_known_controller.rb    # AASA s Content-Type: application/json
app/controllers/qes/test_crl_controller.rb      # test CRL jen při QES_TEST_CRL_PATH
app/controllers/api/qes_documents_controller.rb # upload PDF (přímý podpis)
app/controllers/api/qes_verifications_controller.rb # ověření PDF
app/controllers/templates_qes_verifications_controller.rb # panel ověření v template
app/jobs/qes/expire_sessions_job.rb            # expirace (samo-plánující smyčka)
app/views/qes/app/show.html.erb                 # fallback stránka s QR
app/views/submissions/_qes_badge.html.erb
app/views/submit_form/_qes_summary.html.erb
app/views/templates/_qes_verification.html.erb
app/views/templates_qes_verifications/show.html.erb
app/javascript/submission_form/qes_step.vue      # krok v podpisovém formuláři
app/javascript/submission_form/qes_step_logic.mjs
app/javascript/submission_form/qes_summary.vue
app/javascript/template_builder/qes_field_type.js
app/javascript/template_builder/qes_level_submenu.vue
config/initializers/qes.rb                     # konfigurace (trust roots, TTL, deep link base)
config/initializers/qes_routes.rb               # routy mimo upstream `routes.rb`
config/locales/qes.yml                         # texty (cs/en)
config/qes/*.pem, config/qes/test-root.crl       # trust roots a test CRL
db/migrate/…_create_qes_sessions.rb
db/migrate/…_add_doc_timestamp_state_to_qes_sessions.rb
db/migrate/…_add_signing_time_to_qes_sessions.rb
db/migrate/…_add_expired_at_to_qes_sessions.rb
```

Změněné (minimálně, každý vlastní commit, max. 10 řádků):
```
app/controllers/api/submitters_controller.rb            # lock + boolean + hook
app/javascript/application.js                           # withQes
app/javascript/submission_form/form.vue                  # krok QesStep
app/javascript/submission_form/area.vue                  # QES oblast
app/javascript/template_builder/builder.vue              # save error + withQes
app/javascript/template_builder/dynamic_insert_menu.vue   # gate
app/javascript/template_builder/field_context_menu.vue    # volba AdES/QES
app/javascript/template_builder/field_type.vue           # ikona + název typu qes
app/javascript/template_builder/fields.vue               # gate
app/views/submissions/_value.html.erb                   # přeskočit qes pole (return)
app/views/submissions/show.html.erb                     # přehled podpisu v kartě
app/views/templates/edit.html.erb                       # banner při chybě šablony
app/views/templates/show.html.erb                       # panel ověření PDF
app/views/templates_preview/show.html.erb                # flash při chybě šablony
db/schema.rb                                           # regenerovaný (obsahuje qes_sessions)
lib/api_path_consider_json_middleware.rb                # multipart pro upload/ověření PDF
lib/submissions/generate_audit_trail.rb                 # QES stránka v auditu
lib/submissions/generate_combined_attachment.rb          # kombinovaný dokument = kopie bez dalšího podpisu
lib/submissions/generate_result_attachments.rb           # podepsané PDF + přeskočit qes pole
lib/submitters/submit_values.rb                        # validace hodnoty qes pole
spec/system/signing_form_spec.rb                        # 2FA flake (test-only)
```

**Poznámka:** `app/lib/submissions/...` v DESIGN.md je chyba — soubory jsou v `lib/submissions/`
(upstream konvence). Nová logika jde do `app/lib/qes/` (viz SPEC § 7).

### 7.2 Endpointy

| Metoda | Cesta | Kdo | Účel |
|---|---|---|---|
| POST | `/s/:submit_form_slug/qes_sessions` | prohlížeč (submitter session) | založí obřad, vrátí token + odkazy |
| GET | `/s/:submit_form_slug/qes_sessions/:id` | prohlížeč | stav (polling) |
| POST | `/s/:submit_form_slug/qes_sessions/:id/cancel` | prohlížeč | zrušení |
| GET | `/qes/sessions/:token` | appka (token) | metadata (bez `data_to_sign`) |
| GET | `/qes/sessions/:token/document` | appka (token) | TBS PDF ke kontrole před podpisem |
| POST | `/qes/sessions/:token/certificate` | appka (token) | certifikát → `data_to_sign` |
| POST | `/qes/sessions/:token/complete` | appka (token) | raw signatura → vložení |
| POST | `/qes/sessions/:token/complete_submission` | appka (token) | dokončení submittera přes session token |
| POST | `/qes/sessions/:token/abort` | appka (token) | chyba/odmítnutí v appce |
| GET | `/qes/sign`, `/qes/app?token=…` | prohlížeč | web fallback s QR a tlačítkem na custom scheme |
| POST | `/api/qes/documents` | appka (API token) | upload PDF → šablona „Direct signing“ |
| POST | `/api/qes/verify` | appka (API token) | ověření PDF (stateless) |
| POST | `/api/qes/verified_documents` | appka (API token) | uložení do „Verified documents“ |
| GET | `/templates/:template_id/qes_verification` | prohlížeč | panel ověření PDF v šabloně |
| GET | `/.well-known/apple-app-site-association` | systém | AASA |
| GET | `/qes-test/root.crl` | test | test CRL, jen když je `QES_TEST_CRL_PATH` |

Token: jednorázový, vázaný na session + hash, TTL 5–10 min, pouze HTTPS; v DB jen `sha256`.
Dokončený token platí 24 h (`completed_session_ttl`) a vrací stav bez `values`.
Přesné kontrakty (chyby, idempotence, souběh): [SPEC.md](SPEC.md) § 5, § 6 a § 7.10.

### 7.3 Joby

- `Qes::ExpireSessionsJob` — expirace neaktivních sessions (samo-plánující smyčka, viz SPEC § 7.8).
- `Qes::Providers::MobileApp#complete!` — vložení CMS, DSS, pečeť, DocTS, validace (synchronně, idempotentně přes `with_lock`).
- `Qes::DocTimestamp` — DocTS po pečeti; `Qes::PdfiumTrust.report` — orchestrace ověření PDF.

Notifikace po dokončení (e-mail/webhook) řeší standardní DocuSeal po označení submittera `completed`;
žádný `Qes::NotifyJob` v v1 není.

**LTV (změněno 2026-10-22):** revokační data (CRL) jdou do **DSS** (`/DSS` s `/CRLs`,
`/Certs` a `/VRI` s SHA-1 `/Contents` podpisu appky) — Adobe LTV je čte; CMS unsigned atributy
(ETSI `RevocationValues` + Adobe `RevocationInfoArchival`) pyHanko nečte a jen zvětšují PDF.
Po pečeti následuje **DocTS** (DigiCert TSA), který DSS kryje důvěryhodným časem; offline LTA validace
(pyHanko `ades_lta_validation`) je kritérium. Reálný CRL má stovky KB (PostSignum Qualified CA 4
~800 KB), ale v PDF je jen jednou (DSS), takže rezerva `/Contents` může zůstat malá (SPEC § 7.1).
Detail: [SPEC.md](SPEC.md) § 7.4, § 7.6 a § 16.

### 7.4 Finální PDF a hook do DocuSealu

**Rozhodnutí: finální PDF = PDF podepsané appkou (combined document), ne přestavěné PDF.**

- `GenerateResultAttachments`: pokud má submitter `QesSession` s `embedded/validated`, použije se
  její PDF místo generovaného (a znovu se nepodepisuje).
- `GenerateCombinedAttachment`: pro submission s QES se **nestaví znovu ze stránek** — import stránek
  zahodí AcroForm i podpisové pole a podpis by přestal platit. Finální PDF se vytvoří **kopií
  podepsaného PDF**.
- **Kdo pečetí a v jakém pořadí:** 1) podpis appky (QES/AdES, náš), 2) pečeť DocuSealu
  (**ano — potvrzeno 2026-10-15**). Pečeť se přidává **inkrementálně až po** podpisu appky —
  nikdy ne naopak a nikdy přes přestavbu stránek; při chybě se pečeť přeskočí a podpis se uloží.
- **Pečeť se aplikuje po každé QES session** (`Qes::Seal`, § 7.6 SPEC). `documents` i `combined_document`
  (`merged_document`) pro QES submission jsou **kopie téhož** finálního PDF — upstream `sign_pdf`
  v `GenerateCombinedAttachment#call` se pro QES **přeskakuje**, jinak by vznikla další signatura.
  Auditní stránka QES je v samostatném artefaktu `audit_trail` (`EnsureAuditGenerated`).
- **Při více signerech** finální PDF obsahuje N podpisů appky + N pečetí + N DocTS
  (pečeť a DocTS po každé session);
  každá předchozí revize zůstává INTACT a poslední revize pokrývá celý soubor.
- **Kritérium hotovo:** podepsaný dokument (před pečetí) obsahuje podpis podepisujícího a nezávislý
  validátor (pyHanko/pdfsig) ho označí jako INTACT/TRUSTED/UNTOUCHED s pokrytím celého dokumentu;
  finální PDF po pečeti a DocTS má poslední signaturu (DocTS) pokrývající celý soubor a **všechny předchozí
  podpisy zůstávají INTACT** (u N signerů: N podpisů appky + N pečetí + N DocTS). K tomu záznam v auditu
  (stránka QES se všemi session v audit trailu).
  Přesná definice: [SPEC.md](SPEC.md) § 7.6 a § 15.2.
- Audit trail: události QES se zapíšou jako součást auditu (cert, čas, hash, úroveň, validace).

---

## 8. Protokoly a kontrakty

### 8.1 Deep link

```
dokulachtan://sign?token=<jednorazovy>&server=<origin>   (Android, systémový chooser)
https://<host>/qes/sign?token=<jednorazovy>   (web fallback; na iOS universal link)
```
Fallback (web): `https://<host>/qes/app?token=…` → stránka s tlačítkem „Otevřít appku“ + QR + odkazy
na stažení. Server URL se bere z odkazu: u HTTPS z hostu, u custom scheme z parametru `server`.
Nastavení se používá jen pro přímý podpis PDF a ověření PDF. Při prvním odkazu z neznámého
serveru appka zobrazí potvrzení (TOFU), origin uloží a v Nastavení ho lze odvolat. Server
shodný s Nastavením (přímý podpis PDF) je důvěryhodný bez TOFU. Odkaz
bez serveru skončí `missing_server`; `server_url` z payloadu musí odpovídat originu odkazu,
jinak `foreign_server`.

### 8.2 Payload pro appku

**Krok 1** — metadata (`GET /qes/sessions/:token`), bez `data_to_sign` (certifikát zatím není znám):

```json
{
  "session_id": 123,
  "document_name": "Pracovní smlouva",
  "signer_name": "Jan Novák",
  "hash_algorithm": "sha256",
  "level_required": "ades",
  "expires_at": "2026-10-15T10:30:00Z",
  "server_url": "https://dokulachtan.fly.dev"
}
```

Pozn.: `server_url` v příkladech výše je adresa **konkrétní instance** (zde instance uživatele), ne centrální
server; v každém nasazení se mění. Appka se řídí originem odkazu a TOFU (§ 8.1), ne pevně zapsanou adresou.

**Krok 2** — podepsané atributy (`POST /qes/sessions/:token/certificate` s certifikátem):

```json
{
  "data_to_sign": "<base64 DER podepsaných atributů CMS>",
  "hash_algorithm": "sha256",
  "digest_algorithm_oid": "2.16.840.1.101.3.4.2.1",
  "signature_algorithm": "rsa_pkcs1v15",
  "certificate_info": { "subject": "…", "issuer": "…", "level": "ades" }
}
```

Přesné kontrakty (chyby, kódy, idempotence): [SPEC.md](SPEC.md) § 5.

### 8.3 Odpověď appky

```json
{ "signature": "<base64 raw RSA signature>" }
```

Server ověří: token platný a nepoužitý, signatura kryptograficky platná vůči certu, cert
odpovídá očekávanému subjektu (volitelně), session neexpirovaná.

### 8.4 Konfigurace (env / inicializér)

Úroveň podpisu je **per-field** (`field.preferences.level` = `ades` / `qes`), ne globální přepínač.
Přesný seznam ENV (včetně `QES_ENABLED`, `QES_SIGNATURE_SIZE`, `QES_TSA_REQUIRED`,
`QES_REQUIRE_LTV`, `QES_PUBLIC_BASE_URL`, `QES_IOS_TEAM_ID`):
[SPEC.md](SPEC.md) § 11.

| Klíč | Význam |
|---|---|
| `QES_DEEP_LINK_BASE` | `dokulachtan://sign` (custom scheme fallback) |
| `QES_PUBLIC_BASE_URL` | host pro universal links (`/qes/sign`) |
| `QES_SESSION_TTL` | 600 s |
| `QES_TRUST_ROOTS` | signing trust store: cesty k rootům pro přijetí certu při podpisu (PostSignum) |
| `QES_VERIFICATION_TRUST_ROOTS` | verification trust store: české kvalifikované CA pro ověření cizích PDF |
| `QES_TSA_URL` | kvalifikované TSA (I.CA/PostSignum) |

---

## 9. Bezpečnostní a právní model

- **Klíč nikdy neopustí zařízení.** Server vidí jen podepsané atributy (data_to_sign) a raw signaturu.
- **Podepsané atributy** vážou hash dokumentu + certifikát podepisujícího; podpis je tedy vázán na
  konkrétní dokument.
- **Jednorázový token** s krátkou TTL, vázaný na session a hash; v DB jen hash; rate limiting.
- **Biometrie při každém podpisu**; uživatel vidí, co podepisuje (dokument, hash, cert).
- **Úroveň**: QCStatements → `QcCompliance` = AdES, `+ QcSSCD` = QES. Nikdy nevydávat AdES za QES.
- **Audit**: události obřadu + výsledek validace; dohledatelné v DocuSealu.
- **GDPR**: dokumenty zůstávají v EU (region `fra`); na staging jen testovací data.

---

## 10. UX detaily a chybové stavy

| Situace | Chování |
|---|---|
| Signer zavře prohlížeč | session zůstává `awaiting_app` do expirace; po ní lze založit novou |
| Appka není nainstalovaná | web fallback stránka s QR + odkazy; po instalaci znovu otevřít odkaz |
| Token expiroval | appka zobrazí „vyžádejte nový odkaz“; prohlížeč nabídne „Zkusit znovu“ |
| Biometrie selhala | podpis se neprovede, lze zkusit znovu |
| Certifikát vypršel / chybí | appka upozorní; import nového |
| Server nedostupný | appka zobrazí chybu + retry; session v prohlížeči čeká |
| Podpis neplatný | server session označí `failed`, uživatel může zkusit znovu |
| Signer odmítne | `declined` v DocuSealu (standardní flow) |

---

## 11. Provoz

Vyvíjíme **self-hosted software**: neexistuje centrální instance, každý uživatel si DocuSeal s naším forkem
nasadí u sebe. „Produkce“ níže proto znamená **privátní instanci uživatele s produkčním kódem**, ne veřejnou
službu; adresa instance se v každém nasazení mění.

- **Produkce (instance uživatele):** dnes Fly app `dokulachtan` (varianta A: 1 machine + volume + SQLite),
  region `fra`; healthcheck `/up`; SMTP, zálohy snapshotem volume. Větší nasazení (Postgres + S3/Tigris,
  více strojů, vlastní doména kvůli universal links) je volba, ne požadavek.
- **Staging (instance uživatele):** Fly app `dokulachtan-staging`, stejná varianta A, jen testovací data.
- **Observability:** `fly logs`, události sessions, validační reporty, chybovost providerů.
- **Mobil:** Expo; build EAS nebo lokálně; distribuce interně (APK / Firebase App Distribution).

---

## 12. Otevřené otázky — **vyřešeno ve [SPEC.md](SPEC.md)**

Všechny níže uvedené body jsou rozhodnuté ve SPEC.md (potvrzeno 2026-10-15):

| # | Otázka | Rozhodnutí | Kde |
|---|---|---|---|
| 1 | Zobrazení dokumentu v appce | appka zobrazí název, podepisujícího a cert; **nepodepsaný TBS** (`GET /document`) otevře ke kontrole **před** odemčením klíče | SPEC § 5.1a, § 9.1 |
| 2 | Universal links vs custom scheme | **custom scheme** + systémový chooser na Androidu; universal links jen iOS | SPEC § 6.6, § 10 |
| 3 | Více certifikátů v appce | v1: import PKCS#12 **nahrazuje**; u A povinný výběr kontejneru na kartě | SPEC § 1.2, § 9.4 |
| 4 | Obnova certifikátu | v1: upozornění na expiraci + ruční re-import; staré podpisy zůstávají | SPEC § 9.1 (S3) |
| 5 | Varianta A: čtečka + PIN/QPIN | **MOI Podpisové SDK**; čtečky ACR 3901 U-S1, bR301 BLE (černá), CT 1100, AirID 2 (+ USB OTG); PIN/QPIN zadává dialog SDK | SPEC § 9.4 |
| 6 | Desktop varianta A | mimo v1 (lokální agent až později) | SPEC § 17 |
| 7 | Push notifikace | mimo v1 (deep link z e-mailu) | SPEC § 17 |
| 8 | Signature appearance | **viditelná pečeť podepisujícího** (jméno, „Digitálně podepsáno“, datum) na pozici pole `qes`; kreslí se do TBS PDF, takže ji podpis kryje a zůstává INTACT. Podpisové pole je neviditelné. | SPEC § 7.1 |
| 9 | Hromadné podepisování | mimo v1 | SPEC § 17 |
| 10 | Lokalizace a přístupnost | čeština + angličtina, přístupnost dle Expo defaults | SPEC § 21 |
| 11 | Pečeť DocuSealu u QES | **ano, inkrementálně po podpisu appky** | SPEC § 7.6 |
| 12 | Heslo k PKCS#12 při podpisu | **ne** — jen při importu; klíčový materiál se ihned přešifruje, při podpisu jen biometrie | SPEC § 9.5 |
| 13 | Volba podepisujícího (klíč vs. čip) | **automaticky lokálně**: dle `level_required` (QES → čtečka, AdES → klíč → čtečka → wizard S10), bez ptaní | SPEC § 9.8 |
| 14 | Více digitálních podpisů (firemní podpisy) | **řetězení PAdES revizí**: všichni signeři mají pole `qes`, striktní pořadí, TBS dalšího = finální PDF předchozího; každý signer vlastní session i dokument | SPEC § 4.6, § 7.11 |
| 15 | Přímý podpis PDF (mimo submission) | **nativní tok DocuSealu**: `POST /api/qes/documents` založí šablonu s polem `qes`, appka klepnutím umístí pečeť a spustí obřad; finální PDF je v účtu (Documents, „Direct signing“) ke stažení/sdílení; server vidí PDF, klíč ne | SPEC § 4.8, § 5.8, § 9.9 |
| 16 | Offline core (přímý podpis bez serveru) | **mimo v1**: appka má rozhraní `SessionSource`, takže jde doplnit později bez změny obřadu; cena je ~2000–3500 řádků TS | docs/15 § 2 (D12) |

**Omezení v1.5:** všichni non-viewer signeři šablony s polem `qes` musí mít pole `qes`
(žádné kreslené podpisy v QES šabloně) a podepisuje se striktně po sobě (SPEC § 4.1).

## 13. Mimo rozsah

- Remote QTSP (varianta C) a WebCrypto (B').
- Vlastní CA / vydávání certifikátů.
- Podpora ne-EU eID.
- iOS share extension pro sdílení PDF do appky (v1.7 je jen Android).
