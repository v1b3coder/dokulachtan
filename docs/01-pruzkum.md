# Kvalifikovaný elektronický podpis (QES) v ČR — průzkum landscape

Datum: 2026-10-14

> **Historický průzkum.** Dokument zachycuje stav před implementací forku. Aktuální koncept
> je v [DESIGN.md](../DESIGN.md), detailní specifikace v [SPEC.md](../SPEC.md); zdejší
> komerční a právní kontext zůstává jako zdůvodnění rozhodnutí.

Cíl: zjistit, co dnes existuje pro podepisování dokumentů kvalifikovaným certifikátem v ČR,
co z toho je použitelné pro self-hosted DocuSeal a kde je mezera, kterou má smysl vyplnit.

---

## 1. Rychlé uvedení do pojmů

| Pojem | Význam | Právní dopad |
|---|---|---|
| **SES** (simple) | klik, obrázek podpisu, e-mail OTP | slabá důkazní váha |
| **AdES/AES** (advanced) | kryptografický podpis, certifikát, identita | silná důkazní váha, ne „vlastnoruční“ |
| **QES** (qualified) | kvalifikovaný certifikát od QTSP + **QSCD** (kvalifikovaný prostředek) | dle čl. 25(2) eIDAS = **právní ekvivalent vlastnoručního podpisu** v celé EU |
| **QSCD** | čipová karta / token / certifikovaný HSM QTSP (remote QSCD) | klíč nikdy neopustí QSCD |
| **QTSP** | kvalifikovaný poskytovatel služeb vytvářejících důvěru (I.CA, PostSignum, …) | podléhá dozoru, je na trust listu EU |
| **PAdES** | PDF podpis dle ETSI EN 319 142 (B-B, B-T, B-LT, B-LTA) | standard pro PDF |
| **CSC API** | Cloud Signature Consortium API v2.1 — de-facto standard pro remote signing | interoperabilita s více QTSP |
| **TSA / LTV** | RFC 3161 časové razítko; OCSP/CRL data pro dlouhodobou validitu | podpis zůstane ověřitelný i po expiraci certu |

**Tvrdé podmínky QES** (eIDAS + ETSI EN 419 241 / TS 119 431):

1. kvalifikovaný certifikát vydaný QTSP,
2. soukromý klíč vytvořen a používán v QSCD (čip karty, token nebo certifikovaný HSM QTSP),
3. výhradní kontrola podepisujícího (PIN, biometrie, aktivace podpisu),
4. identita podepisujícího je QTSP ověřena,
5. podpis je jednoznačně spojen s dokumentem a je detekovatelná jakákoli změna.

**Praktický důsledek:** „certifikát zůstane u člověka“ lze splnit dvěma způsoby — klíč je
v čipu jeho karty/tokenu, **nebo** je v certifikovaném HSM poskytovatele a uživatel jej
aktivuje ze svého telefonu. Do naší aplikace se v žádném případě nenahrává klíč ani certifikát.

### 1.1 Pozor: kvalifikovaný certifikát ≠ QES

Častý omyl: „mám kvalifikovaný certifikát, tedy mám QES“. Nestačí. Rozhoduje, **kde je
soukromý klíč**, resp. zda má certifikát nastavený **příznak QSCD**:

| Kde je klíč | Úložiště | Výsledný podpis |
|---|---|---|
| čip eObčanky, USB token, čipová karta | QSCD | **QES** (certifikát má příznak QSCD) |
| software (Windows/macOS keystore, iSignum app) | není QSCD | **AdES** (certifikát nemá příznak QSCD) |

Jiří Peterka to shrnuje přesně: „Pokud tedy máte kvalifikovaný prostředek (pro vytváření
elektronických podpisů), je určitě vhodné jej využít jako úložiště pro soukromý klíč a pak můžete
vytvářet kvalifikované elektronické podpisy. Pokud ale žádný kvalifikovaný prostředek nemáte, můžete jako
úložiště použít systém Vašeho operačního systému (např. Windows). Vystavený certifikát pak ale nebude mít
nastavený příslušný příznak a Vámi vytvořené elektronické podpisy budou jen uznávanými elektronickými
podpisy (AdES), ne QES.“
Zdroj: <https://www.earchiv.cz/b22/b0530001.php3>

Totéž potvrzuje PostSignum: u služby **Certifikát Online** si u kvalifikovaného certifikátu **volíte
úložiště** — eObčanku, USB token nebo čipovou kartu (→ QSCD → QES), anebo software (→ AdES).
Zdroj: <https://www.postsignum.cz/certifikat_online.html>

**Důsledek pro návrh:** úroveň podpisu je vlastnost zvolené cesty (providera), ne certifikátu.
Bridge musí úroveň nést v metadatech, zobrazit ji v UI a v auditu a nikdy nesmí AdES prezentovat
jako QES.

---

## 2. Co dnes existuje v ČR

### 2.1 Národní eID a čipové karty (lokální QSCD)

- **eObčanka (občanský průkaz s čipem)** — od 1. 7. 2018 splňuje požadavky na QSCD; soukromý klíč
  se generuje v čipu a nikdy jej neopustí. Čip může kromě autentizačního certifikátu nést i **kvalifikovaný
  certifikát pro elektronický podpis** — PostSignum vydává certifikáty s příznakem QSCD do eOP od 15. 10. 2018,
  takový podpis je **QES**. Na PC se používá aplikace *eObčanka – správce karty* + čtečka. Na mobilu
  oficiální aplikace **eObčanka** podporuje **pouze Bluetooth čtečku karet** (ne NFC) a slouží primárně
  k **autentizaci**, ne k podepisování PDF.
  Zdroj: <https://info.identita.gov.cz/eop/Podepisovani.aspx>,
  <https://info.identita.gov.cz/eop/InstalaceMobil.aspx>,
  <https://www.postsignum.cz/novinky_postsignum.html>,
  <https://www.lupa.cz/clanky/jak-se-podepisuje-s-novou-elektronickou-obcankou>
- **PostSignum (Česká pošta)** — kvalifikované certifikáty na **ProID+ / eToken** (QSCD, platnost do 2031),
  serverové pečetění *ProID QSeal*; aplikace **PDF Signer PLUS/PRO**, **Signer** (602) pro Windows/macOS/
  Android/iOS umí podepisovat PDF, konvertovat do PDF/A a **ověřovat podpisy z celé EU**.
  Zdroj: <https://www.postsignum.cz/kvalifikovane_prostredky.html>, <https://www.postsignum.cz/podepisovani_pdf.html>
- **iSignum** — aplikace České pošty pro **správu certifikátů PostSignum** (žádost, import, export do
  PKCS#12). Není to podepisovací aplikace pro cizí dokumenty a klíč generovaný v telefonu/PC **není QSCD**
  (verze pro macOS dokonce nepodporuje USB tokeny ani čipové karty). Výsledný podpis je proto **AdES**,
  i když je certifikát kvalifikovaný. Cesta k QES vede jen přes uložení téhož certifikátu na eObčanku /
  token / čipovou kartu, nebo přes remote signing.
  Zdroj: <https://play.google.com/store/apps/details?id=cz.aconte.isignum>,
  <https://www.elektronickypodpis.cz/isignum-program-pro-spravu-certifikatu-ke-stazeni-zdarma>
- **I.CA** — čipové karty a tokeny (QSCD), certifikáty pro eObčanku i vlastní prostředky.
  Zdroj: <https://www.ica.cz/certifikaty-hw>

### 2.2 Remote signing (certifikát v HSM poskytovatele) — dnes nejschůdnější cesta

- **I.CA RemoteSign** — kvalifikovaný certifikát uložený u I.CA, podpis potvrzuje uživatel v mobilní
  aplikaci I.CA; splňuje eIDAS/GDPR/NIS2, QES uznávaný v EU. Spuštěno 24. 11. 2025.
  Zdroj: <https://www.ica.cz/ica-remotesign-0>
- **Signi (platforma I.CA) + I.CA RemoteSign přes API** — pro integrátory je k dispozici API
  (`POST https://api.signi.com/api/v1/contract/` s `x-api-key`, role podepisujícího `sign_remote_sign`).
  Certifikát nemá na kartě ani v počítači, podpis se potvrzuje v aplikaci I.CA RemoteSign.
  Zdroj: <https://helpdesk.signi.com/cs/support/solutions/articles/201000131180>,
  <https://helpdesk.signi.com/cs/support/solutions/articles/201000132667-remote-sign>
- **PostSignum eIDAS Platform** — nová generace služeb pro **vzdálené podepisování a pečetění**
  (certifikované HSM + kvalifikovaný certifikát v cloudu), ve spolupráci se Software602.
  Zdroj: <https://www.postsignum.cz/eidas_platform.html>, <https://www.egovernment.cz/inpage/postsignum>
- **Circularo + I.CA** (partnerství oznámeno 4/2026) — dokumentová platforma s napojením na
  QSCD technologii I.CA, USB dongle i NFC telefony.
  Zdroj: <https://www.ica.cz/partnerstvi-se-spolecnosti-circularo>
- **I.CA Circularo** — platforma I.CA pro správu a podepisování dokumentů.
  Zdroj: <https://www.ica.cz/sk/ica-circularo>

### 2.3 Služby, které vypadají jako QES, ale nejsou

- **Bank iD podepis** (<https://podepis.bankid.cz>) — zaručený (AdES) podpis, bez registrace, identita přes banku.
- **MojeID** (CZ.NIC) — identita na úrovni „vysoká“, podepisování dokumentů; jde o AdES, ne QES.
  Zdroj: <https://www.nic.cz/page/4290/sluzba-mojeid-nove-nabizi-overeni-na-uroven-zaruky-vysoka>
- **Podpisovna** (<https://www.podpisovna.cz>) — český SaaS pro online podepisování s ověřením přes
  Bank iD/MojeID; AdES s velmi dobrou UX (vzor pro onboarding a ověření identity).
- **Mobilní klíč eGovernmentu** a **eDoklady** — identita/autentizace, nikoli podepisování dokumentů.
  Zdroj: <https://archi.gov.cz/nap:mobilni_klic_egov>
- **Portál občana** — umožňuje jen zápis údajů o kvalifikovaném certifikátu do registru obyvatel,
  samotný podpis probíhá jinde.
  Zdroj: <https://portalobcana.gov.cz/cs/napoveda/clanky-a-navody/certifikaty>

### 2.4 Ověřování podepsaných PDF

Aplikace, která nejspíš odpovídá tomu, co máte na mysli:

- **Signer (Software602 / PostSignum)** — podepisování i **ověřování dokumentů z celé EU**, Windows/macOS/
  Android/iOS, umí datové schránky a vzdálené podepisování.
  Zdroj: <https://www.postsignum.cz/signer.html>, <https://www.602.cz/signer-pro-win>
- **eObčanka (správce karty)** na PC — ověření podpisu proti trust listu.
- **PDF Signer PLUS/PRO** (Recomando, distribuce PostSignum) — ověřování podpisů.
- **DSS Demonstration WebApp** (EU, open source) — univerzální validátor AdES/QES.
  Zdroj: <https://dss.nowina.lu>

> Poznámka: „čTečka“ od NAKIT je aplikace k COVID certifikátům, s podpisy nesouvisí.

### 2.5 Čtečky a softwarová pipeline pro eObčanku

Čip eObčanky je **kontaktní** — na mobilu tedy potřebujete bezdrátovou (Bluetooth) čtečku
kontaktních karet nebo USB čtečku přes USB OTG. Oficiální výčet (DIA, verze aplikace 3.2.3, © 2025):

| Čtečka | Rozhraní | Poznámka | Orientační cena |
|---|---|---|---|
| **AirID 2 Business** (certgate) | Bluetooth (AES-256) | LCD 132×32, jog/dial, auto-odhlášení, iOS + Android | ~190–230 € |
| **ACR 3901 U-S1** (ACS) | Bluetooth Smart + USB | AES-128, 600 Kbps, Android 4.3+, iOS 5.0+, Win, macOS | ~58–70 € |
| **bR301 BLE – c45 (černá)** (Feitian) | Bluetooth LE + USB | pozor: výrobce dodává dvě různé čtečky pod stejným názvem, podporovaná je černá BLE varianta | ~50–90 $ |
| **USB OTG čtečka** | USB OTG | jen Android, univerzální čtečka bez klávesnice; bez záruky na všech telefonech | ~300–600 Kč |
| **Gemalto SafeNet Reader CT1100** | Bluetooth | podporována byla ve starší verzi iOS aplikace; dnes není v oficiálním výčtu | ~1 700–2 600 Kč |
| ~~Axagon CRE-ESNP2a~~ | USB | **varování DIA: může narušit datovou strukturu podpisové části eOP** | — |

> „Jiné čtečky, než je uvedeno ve výčtu, nelze pro práci s občanským průkazem na mobilním
> zařízení použít!“ — DIA (<https://info.identita.gov.cz/eop/CteckyMobil.aspx>)

Na PC je situace jiná — funguje jakákoli čtečka splňující ISO 7816 a CCID
(<https://info.identita.gov.cz/eop/CteckyKaret.aspx>).

**Softwarová pipeline na PC je dnes plně funkční:** oficiální software eObčanka instaluje
kryptografické ovladače čipu včetně **PKCS#11** na všech platformách — na Windows vedle CSP/CAPI
(aplikace závislé na kryptu Windows), na macOS vedle CryptoTokenKit (dříve tokenD), na Linuxu přímo
(`libeopproxyp11.so`). `pyHanko` (případně DSS nebo SignServer) se přes PKCS#11 připojí k čipu,
udělá dvoufázový PAdES podpis (prepare → digest → sign v čipu → embed), přidá TSA + LTV. Klíč
neopustí čip, PIN/QPIN zadává uživatel do okna ovladače eObčanka. To je přesně provider
`eobcanka-local` v našem bridge a **jediná cesta k QES zdarma** (platí se jen čtečka).

**Podmínka QES:** certifikát v čipu musí mít **příznak QSCD** — klíčový pár se musí vygenerovat
**v čipu** (iSignum / Správce karty, schválení PINem a QPINem) a certifikát vydá PostSignum nebo
I.CA (obě autority vydávají kvalifikované certifikáty s příznakem uložení klíče v eOP od roku 2018).
Když se do eOP naimportuje kvalifikovaný certifikát s klíčem vygenerovaným jinde (např. iSignum
na PC), je výsledek jen AdES, i když je certifikát kvalifikovaný
(<https://www.lupa.cz/clanky/jak-se-podepisuje-s-novou-elektronickou-obcankou>,
<https://www.earchiv.cz/b18/b1025001.php3>).

**Softwarová pipeline na mobilu** je dnes jen vlastní app: oficiální aplikace eObčanka umí na mobilu
pouze identifikaci/autentizaci, ne podpis PDF. Vlastní app by musela přes BLE mluvit s konkrétní
čtečkou (ACS, Feitian i certgate dodávají SDK) a sama implementovat komunikaci s čipem i PAdES —
reálné, ale je to samostatný projekt (fáze 3). Bez čtečky a hardwaru řeší QES dnes **I.CA RemoteSign**
(klíč v HSM I.CA, potvrzení v mobilu).

### 2.6 Jak zjistit, co je v čipu (a co z karty fyzicky poznat)

**Fyzicky z karty poznáte jen přítomnost čipu** — na přední straně jsou vidět zlaté kontaktní
plošky (viz oficiální vzor Ministerstva vnitra). Jestli je v čipu uložený podpisový certifikát,
z karty nijak nepoznáte — čip je bezpečný prvek a certifikáty se na kartu netisknou.

Platí:

* **Kontaktní čip** má každý průkaz vydaný po **1. 7. 2018** (od 2. 8. 2021 navíc i **bezkontaktní čip**,
  ale ten slouží jen ke čtení biometrických údajů dokladu jako u pasu — **ne k eID ani k podpisu**:
  „Pro účely elektronické identifikace bude nadále sloužit pouze kontaktní elektronický čip umístěný na
  eObčance.“ — MV ČR (<https://www.lupa.cz/aktuality/nove-bezkontaktni-eobcanky-budou-komunikovat-i-s-nekterymi-nfc-cteckami>)
* **Podpisový certifikát není součástí karty** — standardně je v čipu jen autentizační certifikát (NIA),
  podpisový certifikát zapisuje držitel až po vydání karty (klíč se generuje v čipu, schvaluje PIN + QPIN,
  certifikát vydá PostSignum nebo I.CA). „Všechny občanské průkazy vydané po 1. 7. 2018 obsahují čip“
  (<https://info.identita.gov.cz/eop>) — ale **ne všechny mají podpisový certifikát**.

**Jak to zjistit:**

1. **eObčanka – Správce karty**: zobrazí strom certifikátů a kryptografických klíčů v čipu; klíč bez
   certifikátu nebo nedůvěryhodný certifikát zvýrazní růžově a nabídne řešení
   (<https://info.identita.gov.cz/eop/SpravceKarty.aspx>).
2. **PKCS#11** (Linux) nebo **CSP/CryptoTokenKit** (Windows/macOS): např. `pkcs11-tool -O --login`,
   `certutil -scinfo` (Windows), v prohlížeči přes PKCS#11 modul eObčanky.
3. **Příznak QSCD v certifikátu**: podpisový certifikát musí mít v QCStatements uvedeno
   `id-etsi-qcs-QcSSCD`; bridge to musí kontrolovat, jinak výsledek nesmí označit jako QES.
   Certifikát s klíčem vygenerovaným mimo čip (např. iSignum na PC) tento příznak nemá
   (<https://www.lupa.cz/clanky/jak-se-podepisuje-s-novou-elektronickou-obcankou>).

**Prakticky:** máte-li kartu vydanou po 1. 7. 2018, čip máte jistě; ale jestli je v něm podpisový
certifikát, zjistíte jen vyčtením čipu — a když tam není, musíte si ho nejdřív nechat vygenerovat a zapsat.

**Než koupíte čtečku:**

1. Zkontrolujte, jestli čtečku už nemáte — některé business notebooky a klávesnice mají integrovanou
   čtečku Smart card (Windows `certutil -scinfo`, Linux `pcsc_scan`, macOS `pcsctest`).
2. Bez čtečky zjistíte, jestli vám byl certifikát vůbec vydán: **Zákaznický portál PostSignum**
   (<https://www.postsignum.cz/zakaznicky_portal.html>) nebo **I.CA Moje služby**
   (<https://bica.ica.cz/cgi-bin/client_portal.cgi>), případně iSignum. Nezjistí ale, jestli je klíč
   v čipu — jen že certifikát existuje.
3. Pro samotnou kontrolu čipu stačí levná USB CCID čtečka (~300–600 Kč) + eObčanka software na PC;
   Bluetooth čtečka z oficiálního výčtu (~1 500–5 500 Kč) má smysl až pro podepisování z mobilu.
4. Pokud jste podpisový certifikát nikdy nežádali, v čipu není — čtečka to jen potvrdí.
5. Pro QES z čipu je čtečka tak jako tak potřeba (generování klíče i podpis), pro QES bez hardwaru
a čtečky je tu **I.CA RemoteSign**.

---

## 3. Open-source e-sign platformy a jejich vztah k QES

| Projekt | Licence | Podpora QES dnes | Architektura / hooky | Relevance pro nás |
|---|---|---|---|---|
| **DocuSeal** | AGPL-3.0 + attribution | **Cloud EU ano** (Czech ID Card, MojeID AdES, Local Certificate, D-Trust, …), **self-hosted NE** | Rails, HexaPDF pro PAdES pečeť, Pdfium validace, `PUT /api/submitters/:id` umí `completed` + hodnoty včetně base64 obrázků, webhooky, TSA URL v konfiguraci | Cílový systém; chybí právě „bring your own QTSP“ |
| **Documenso** | AGPL-3.0 | ne, **plán 2026** | Local AES + **partner QES přes CSC 2.0**, dlouhodobě být sám QTSP | Nejlepší architektonická inspirace (viz blog) |
| **OpenSign** | AGPL-3.0 | pouze SES | eIDAS AES/QES „planned“ (GitHub #178) | Konkurence, ale bez konkrétního plánu |
| **LibreSign** | AGPL-3.0 (Nextcloud) | podpora certifikátů/PKCS#12, ne QES | integrace do Nextcloud | Okrajové |
| **SignServer CE** | LGPL-2.1 | PAdES/CAdES/XAdES, PKCS#11, TSA | serverové podepisování s klíči v HSM organizace | Vhodné pro pečetění/TSA, ne pro klíče uživatelů |
| **DSS (EU)** | LGPL-2.1 | tvorba i validace AdES/QES, **ExternalCMSService** (dvoufázový remote signing) | Java knihovna + demo webapp | Referenční implementace EU, dobrá pro validaci |
| **pyHanko** | MIT | PAdES B-B/B-T/B-LT/B-LTA, **external signing** (`PdfTBSDocument`), PKCS#11, LTV | Python knihovna | Ideální PAdES engine pro sidecar |
| **Trust1Connector** | části Apache-2.0 (`t1c-native-pkcs11`), část proprietární | lokální middleware pro čipové karty/tokeny | používají Penneo, eID Easy | Kandidát pro eObčanku na desktopu |
| **Web eID** | open source (EU) | architektura browser extension + nativní app pro eID karty (EE, FI, LV, LT, BE, HR) | Estonsko a spol. | Vzor pro čipovou kartu v prohlížeči, ČR zatím ne |
| **NexU (Nowina)** | open source | remote signature klient pro DSS | Java | Vzor pro „activation client“ |

Klíčová zjištění:

- **DocuSeal FAQ to říká natvrdo:** „Currently, QeS is only available in the DocuSeal Cloud version and
  is not supported in the On-Premises deployment. This is because QeS requires integration with external
  third-party services for signature generation, which are not compatible with self-hosted environments.“
  <https://www.docuseal.com/faq/how-to-use-qes-signing-with-docuseal-on-premises>
- **DocuSeal cloud** QES/AES dnes nabízí přes partnery; v seznamu je i „**Czech ID Card qualified**“,
  „**MojeID advanced**“ a „**Local Certificate qualified**“ (0,20 USD/podpis vs 2 USD/podpis u třetího QTSP).
  <https://www.docuseal.com/faq/which-qes-and-aes-signing-methods-are-available-in-my-country>,
  <https://www.docuseal.com/qualified-electronic-signature>
- **DocuSeal nemá plugin API pro podpisové providery.** V kódu jsou jen Puma pluginy; podepisování je
  napevno v HexaPDF (`lib/submissions/generate_combined_attachment.rb`) a validace v Pdfium
  (`lib/verify_pdf_signature.rb`). Fork nebo upstream patch je tedy nutný.
- **DocuSeal diskuse #537** (11/2025) — uživatel se ptá na smartcard middleware a remote signature;
  maintainer odpovídá jen na cloud partnery (Trust1Connector, D-Trust). To je přesně ta mezera.
  <https://github.com/docusealco/docuseal/discussions/537>
- **Documenso** plánuje přesně naši architekturu: lokální AES v self-hosted + partner QES přes **CSC 2.0**,
  a to včetně self-hosted instalací. <https://documenso.com/blog/building-documenso-part-3---aes-qes-qtsp>

---

## 4. Standardy, na které je třeba se napojit

| Standard | Co řeší |
|---|---|
| eIDAS (nař. 910/2014), čl. 25(2) | QES = vlastnoruční podpis |
| eIDAS 2 (nař. (EU) 2024/1183) | remote QES je nově regulovaná kvalifikovaná služba; EUDI wallet |
| Implementační nař. (EU) 2025/847 | požadavky na remote QSCD |
| ETSI EN 419 241-1/-2 | bezpečnostní požadavky na remote QSCD (QSCD v HSM poskytovatele) |
| ETSI TS 119 431-1/-2 | politika a bezpečnost vytváření QES |
| **ETSI TS 119 432** | protokoly pro remote digital signature creation (základ pro CSC API) |
| **CSC API v2.1** | OAuth2, `credentials/list`, `credentials/info`, `signatures/signHash`, `signatures/timestamp`, SAD |
| ETSI EN 319 142 | PAdES (B-B, B-T, B-LT, B-LTA) |
| ETSI EN 319 102 | validace podpisů, validační report |
| ETSI TS 119 461 | remote identifikace osoby (onboarding k certifikátu) |
| RFC 3161 | kvalifikované časové razítko |
| EUDI wallet ARF | QES v peněžence, cíl ČR: start začátek 2027 |

---

## 5. Komerční QES platformy — srovnání a inspirace

| Platforma | Země | Co nabízí | Pro nás inspirativní |
|---|---|---|---|
| **Skribble** | CH/EU | API pro SES/AES/QES, mobilní app, QR aktivace | UX podpisu a „signature request“ API |
| **sproof sign** | AT | eID Hub — **podporuje českou eObčanku**, API, QES | Přímý existující ekvivalent pro CZ, ale closed-source |
| **Signi / I.CA** | CZ | QES remote sign, API pro integrátory, mobilní app I.CA | Nejschůdnější backend pro MVP |
| **PostSignum eIDAS Platform** | CZ | Remote signing/sealing, HSM v cloudu | Alternativa k I.CA |
| **Circularo + I.CA** | CZ | Dokumentová platforma s QSCD I.CA, USB/NFC | Ukazuje, že to jde i v ČR (4/2026) |
| **eID Easy** | EE | Agregátor QTSP, **Czech ID Card**, MojeID, API | Jedno API na mnoho eID |
| **Dokobit / Signicat** | LT/EU | Agregátor eID a QES (Mobile-ID, Smart-ID, …) | Model „identity brokeru“ |
| **Validated ID (VIDsigner)** | ES | QES, biometrický remote signing, API | UX a ověření biometrií |
| **Evrotrust** | BG | QES + identita v jedné appce | Model „vše v jedné appce“ |
| **Autenti / Yousign / Universign** | PL/FR | QES nad eIDAS | Workflow a API design |
| **Podpisovna / Podepis** | CZ | AdES přes Bank iD/MojeID, ověření identity | Onboarding a identita bez QES certu |

---

## 6. Kde je tedy mezera

1. **Self-hosted open-source platforma s QES neexistuje.** DocuSeal to má jen v cloudu, Documenso a OpenSign to teprve plánují.
2. **České QTSP API nejsou v open-source světa napojené.** I.CA RemoteSign (přes Signi) a PostSignum eIDAS Platform
   jsou komerční API bez open-source adaptéru.
3. **Chybí „workflow layer“ pro QES**: příprava PDF, dvoufázový podpis, časové razítko, LTV, validace,
   audit a napojení na envelope/DMS systém.
4. **Lokální podepisování eObčankou na mobilu dnes prakticky nejde** — oficiální aplikace eObčanka
   používá Bluetooth čtečku a slouží k autentizaci, ne k podpisu PDF; vlastní app by musela řešit NFC (Android)
   nebo čtečku (desktop) a protokol PKCS#11.
5. **EUDI wallet** (ČR start začátek 2027) QES přinese, ale nebude to hned a nebude to pro firemní workflow.

Přesně tuhle mezeru má smysl vyplnit: **otevřený QES bridge**, který je nezávislý na jednom QTSP,
umí lokální i remote QSCD a umí se napojit na DocuSeal (i Documenso/OpenSign) jako podpisový provider.
