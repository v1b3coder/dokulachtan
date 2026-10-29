# Rozhodnutí: vše v DocuSealu (fork), varianty A a B

Datum: 2026-10-14

> **Oprava (2026-10-15):** Tento dokument je historický záznam rozhodnutí. V některých detailech
> ho překonala pozdější zjištění — aktuální koncept je [DESIGN.md](../DESIGN.md) a detailní
> specifikace [SPEC.md](../SPEC.md). Co se změnilo:
> - **`Qes::Providers::Pkcs11` neexistuje** — server PKCS#11 neimplementuje; varianta A je client-side
>   (MOI Podpisové SDK v appce). Provider je jen `mobile_app` + `mock` (DESIGN § 6, § 7.1).
> - **HexaPDF 1.7 LTV neumí** (`add_validation_info` v něm není, ověřeno ve zdrojích 1.7–1.11);
>   LTV se řeší CRL v DSS slovníku s VRI (DESIGN § 7.3).
> - **Úroveň a `key_location` nejsou vlastnosti providera**, ale `QesSession` (dle certifikátu).
> - **Fáze F1–F4** nahradil plán **P0–P8** v [PLAN.md](../PLAN.md).
> - Podpis appky je **raw signatura podepsaných atributů CMS**; server ji vkládá do `SignerInfo`
>   (dvoukrokový protokol, DESIGN § 4 a § 8.2).

Reaguje na: „když už musíme forknout DocuSeal s patchem, a interface bude rozumně malý,
dávalo by smysl udělat to celé v DocuSealu, a ne fork A NAVÍC sidecar.“
a na: „B' bych zahodil, zní to dost fragile. Mít vlastní appku (klidně PWA pro Android
a iPhone) dnes není problém. Rozhoduji, že dělat budeme jen varianty A a B.“

## 1. Rozhodnutí

**Fork DocuSeal s moduly `Qes::Providers` a dvěma self-custody cestami:**

- **A — čip eObčanky** (QSCD, klíč nikdy neopustí kartu) → **QES**, zdarma.
- **B — vlastní klíč na mobilu** (PKCS#12 z iSignum v keystore telefonu) → **AdES**, zdarma.

**Žádný remote QTSP (varianta C vypuštěna), žádný WebCrypto v prohlížeči (B' vypuštěno),
žádný sidecar.** Vše je self-custody: klíč je buď na kartě, nebo v telefonu. Sidecar varianta zůstává jen jako možný spike, ne produkt.

Důsledek: **žádná smlouva s QTSP, žádné OAuth, žádné CSC, žádné poplatky za podpis,
žádná důvěra v poskytovatele.** Jediné náklady jsou čtečka pro variantu A.

**Potvrzené produktové odpovědi (2026-10-14):**

- Úroveň: **většinou AdES**, QES jen výjimečně (úřady/soud).
- Kde se podepisuje: **hlavně mobil**.
- Kdo podepisuje: **zaměstnanci firmy** (interní lidé, můžeme školit a vybavit).
- Kde je výsledek: **jen v DocuSealu**.

Z toho plyne priorita: **B (mobil, AdES) je hlavní cesta**, **A (QES) je doplňková** pro případy,
kdy je potřeba vlastnoruční váha. Finální PDF musí být **dokument DocuSealu** (hook), ne druhý
artefakt vedle — proto fork, ne sidecar.

## 2. Proč to jde (a je to málo kódu)

- **HexaPDF 1.7 je už v DocuSealu** a umí přesně to, co potřebujeme:
  - `external_signing:` (synchronní externí podpis),
  - **asynchronní externí podpis** (`HexaPDF::DigitalSignature::Signing.embed_signature`) —
    dokumentace ho doslova doporučuje pro „citizen ID signature system“,
  - **timestamp signatures** (TSA) pro PAdES-B-T,
  - **LTV** (CRL v DSS slovníku s VRI, `Qes::Dss`; CMS LTV se nepoužívá).
- **ruby-pkcs11** gem umí eObčanku / USB token / čipovou kartu přes PKCS#11 (OpenSC)
  na Linuxu, Windows i macOS.
- **Vlastní app** (native shell, viz níže) drží klíč v keystore telefonu a podepisuje hash;
  server dostane jen CMS. Žádné HTTP API třetí strany není potřeba.
- DocuSeal už má šablony, pole, workflow, notifikace, audit trail a ověření podpisu (Pdfium).

## 3. Rozhraní (návrh, ~6 metod)

```ruby
# app/lib/qes/provider.rb
module Qes
  class Provider
    def level = :qes | :ades
    def key_location = :card | :phone_keystore
    def prepare(pdf_bytes, signer) = Session   # placeholder + hash (HexaPDF)
    def activation(session) = Activation       # deep link / QR / push
    def collect(session) = Signature           # CMS + chain (+ TSA)
    def embed(pdf_bytes, signature) = bytes    # PAdES-B-LT/LTA
    def validate(pdf_bytes) = Report
  end
end
```

Providery:

| Provider | Kde je klíč | QSCD | Úroveň | Kdy |
|---|---|---|---|---|
| `Qes::Providers::Pkcs11` | čip eObčanky / token | ano | QES | A, desktop |
| `Qes::Providers::MobileApp` | keystore telefonu | ne | AdES | B, mobil |
| `Qes::Providers::P12` | software | ne | AdES | testy |

## 4. Tok v DocuSealu (bez sidecaru)

**Desktop (A):**

1. `qes` pole v šabloně (nový typ vedle `signature`).
2. Signer otevře podpisovou stránku; QES krok se vykreslí místo kreslení podpisu.
3. Klik „Podepsat kvalifikovaným certem“ → `QesSession` (token, hash, provider, TTL).
4. `Qes::PrepareJob`: PDF + placeholder + SHA-256 (HexaPDF async external signing).
5. Server přes PKCS#11 podepíše v čipu (PIN zadá uživatel do okna ovladače eObčanky).
6. `embed`: CMS + DSS + pečeť + DocTS → PAdES-LTA; `validate` (Pdfium).
7. `GenerateResultAttachments` / `GenerateCombinedAttachment`: pokud existuje QES PDF,
   použije se místo generovaného (jediný hook do stávajícího kódu).
8. Audit + notifikace + stažení.

**Mobil (A i B):**

1. Totéž, ale krok 5 se místo serveru řeší v naší appce:
   server pošle hash deep linkem (universal link / custom URL scheme), app zobrazí souhrn,
   uživatel potvrdí biometrií a app podepíše:
   - **A**: app komunikuje s čipem přes Bluetooth čtečku,
   - **B**: app použije klíč v keystore telefonu (PKCS#12 z iSignum).
2. App vrátí CMS (a chain) serveru; server vloží podpis a dokončí jako výše.

## 5. Klíč a self-custody

| Kde je klíč | QSCD | Úroveň | Mobil | Kdo drží klíč |
|---|---|---|---|---|
| čip eObčanky / token | ano | **QES** | čtečka (BT) + naše app | uživatel |
| keystore telefonu (PKCS#12 z iSignum) | ne | AdES | naše app | uživatel |
| p12 nahrané do DocuSealu | ne | AdES | — | DocuSeal (nikdy) |

**Self-custody QES dnes reálně = čip eObčanky.** Self-custody AdES = klíč v keystore telefonu.
Obojí zdarma, obojí bez poskytovatele. Remote QSCD (klíč u QTSP) jsme vypustili.

**Pozor na „PWA pro Android a iPhone“:** pro variantu B musí klíč ležet v **OS keystore**
(Android Keystore / iOS Keychain s biometrií), a to PWA v prohlížeči neumí spolehlivě —
webové úložiště může být evikováno (ITP limit, tlak na storage) a WebCrypto nemá vazbu
na biometrii pro jednotlivý podpis. UI může být sdílený webový kód (PWA), ale custody vrstva
musí být nativní: **tenký nativní shell (Capacitor) nebo nativní app** s keystore pluginem.

## 6. Fáze

| Fáze | Obsah | Výstup |
|---|---|---|
| **F1** | `qes` pole + `Qes::Provider` + `Pkcs11` (desktop A) + PAdES (HexaPDF async) + hook | QES zdarma na desktopu; ověří celý řetěz (karta → PAdES → finální PDF DocuSealu) |
| **F2** | `MobileApp` (B): nativní shell + keystore + deep link | **hlavní produktová cesta**: AdES z mobilu |
| **F3** | A na mobilu (BLE čtečka v appce) | QES z mobilu pro výjimečné případy |
| **F4** | upstream PR (`Qes::Provider` rozhraní) | udržovaná cesta bez forku |

Poznámka k pořadí: produktově je prioritou B (mobil/AdES), ale technicky je F1 s A na desktopu
nejrychlejší způsob, jak ověřit celý řetěz bez mobilní appky. Pořadí F1/F2 lze prohodit podle toho,
co chceme mít dřív — funkční důkaz řetězu, nebo produktovou cestu.

## 7. Větve: jen A a B

| Větev | Kde je klíč | QSCD | Úroveň | Mobil | Náklady |
|---|---|---|---|---|---|
| **A: eObčanka + čtečka** | čip karty | ano | **QES** | čtečka (BT/USB OTG) + naše app | čtečka 300–5 500 Kč |
| **B: iSignum export → naše app** | keystore telefonu | ne | AdES | naše app | 0 |

**Vypuštěno:**

- **B' (WebCrypto v prohlížeči)** — fragile: klíč může být evikován, žádná biometrická
  vazba na podpis, horší audit → neděláme.
- **C (remote QSCD / OAuth / CSC / I.CA RemoteSign)** — klíč u poskytovatele, závislost
  a poplatky za podpis → neděláme.

**Certifikovaná app není potřeba k nahrání klíče** — PKCS#12 z iSignum importuje běžná app
do keystore telefonu a podepisovat může. Ale výsledek je **AdES**, protože telefon není QSCD
a **příznak QSCD je vázaný na vznik klíče**, ne na appku. QES z klíče v softwaru by vyžadoval
nový certifikát vydaný QTSP pro klíč vygenerovaný v QSCD appce (certifikační projekt).

**Důsledek pro fork:** provider nese `level` (`qes`/`ades`) a `key_location`
(`card`/`phone_keystore`) v metadatech, UI je zobrazí a audit zapíše. Žádná cesta
nesmí AdES vydávat za QES.

## 8. Licence a údržba

- Fork zůstává **AGPL-3.0 + attribution** (`LICENSE_ADDITIONAL_TERMS`).
- Patch držet izolovaný: `app/lib/qes/`, `app/models/qes_session.rb`, `app/controllers/qes_*`,
  `app/views/qes_*`, `app/jobs/qes_*`; do stávajících souborů jen hook v generování PDF
  a nový typ pole.
- Mobilní app držet odděleně (`mobile/`), licence vlastní, UI sdílené.
- Připravit upstream PR (diskuse #537) — rozhraní je malé a obecně použitelné.
