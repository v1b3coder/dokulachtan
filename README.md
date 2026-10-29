# Dokulachtan

**Podepiš dokument z mobilu kvalifikovaným certifikátem. Klíč zůstane v tvém zařízení —
na server se nikdy nenahraje.**

Dokulachtan je appka, která se napojí na upravený [DocuSeal](https://github.com/v1b3coder/docuseal).
Appka umí z mobilu podepisovat a ověřovat dokumenty certifikáty od českých kvalifikovaných autorit
(iSignum/I.CA, PostSignum). Upravený DocuSeal přidává pole „Podpis certifikátem“, přímý podpis PDF
a ověření PDF. Dokumenty, e-maily, stav a audit zůstávají v DocuSealu, který si nainstaluješ u sebe;
appka se k němu připojí přes API.

DocuSeal není jen pro pokročilý workflow. Dokulachtan používá jeho infrastrukturu i pro základní podpis
a ověření. Navíc v upraveném DocuSealu najdeš týmové workflow a vícenásobné podpisy.

[**Stáhnout appku**](https://github.com/v1b3coder/dokulachtan/releases/latest) ·
[DocuSeal](https://github.com/v1b3coder/docuseal) ·
[Jak to funguje](#jak-to-funguje)

| Domů | Podepsat PDF | Ověřit PDF |
|:---:|:---:|:---:|
| <img src="docs/img/app-home.png" width="260" alt="Domovská obrazovka appky"> | <img src="docs/img/app-sign.png" width="260" alt="Obrazovka Podepsat PDF"> | <img src="docs/img/app-verify.png" width="260" alt="Obrazovka Ověřit PDF"> |

## Proč Dokulachtan

Stát k elektronickým podpisům nastavil pravidla. U nás díky tomu existují kvalifikované certifikační
autority — PostSignum a iSignum (I.CA). Můžeš si od nich pořídit kvalifikovaný certifikát a ten má právní
váhu: podpis jím je postavený na roveň vlastnoručnímu podpisu. To je dobrá zpráva.

Horší je software kolem toho. Nástroje pro práci s certifikáty jsou často jen pro Windows, proprietární,
nebo obojí. Podepsat PDF certifikátem z mobilu pak znamená ruční boj s několika aplikacemi, exportem klíčů
a hledáním, které okno vlastně chceš použít.

Lidi to proto řeší jinak. Někdo vloží do PDF naskenovaný obrázek svého podpisu a tváří se, že je dokument
podepsaný. To ale není elektronický podpis v právním smyslu — chybí kryptografická vazba na dokument i identita
podepisujícího. Někdo jiný to hodí na třetí stranu, jako DocuSign nebo SpotDraft. Ty umí podepisovat z mobilu
a mají slušné UX, ale důvěra v to, kdo podepsal, často stojí na přístupu k e-mailu a na tom, že třetí strana neprozradí
odkaz k podpisu. To je jiný model důvěry, než jaký dává kvalifikovaný certifikát.

Problém tedy není v tom, že by certifikáty nebyly. Problém je, že podepsat dokument certifikátem z mobilu je dnes
horší zážitek než vložit obrázek podpisu nebo kliknout na odkaz v cizí aplikaci.

Proto jsem se rozhodl udělat Dokulachtana. Jednoduchou appku, která umí z mobilu podepisovat a ověřovat dokumenty
certifikáty od iSignum (I.CA) a PostSignum. Klíč zůstává v tvém zařízení — v telefonu u AdES, v čipu občanky
u QES, který je v přípravě. Na server se nikdy nenahraje.
Dokulachtan se napojí na DocuSeal, který si nainstaluješ u sebe — dokumenty, e-maily, stav a audit pak zůstanou
na jednom místě.

## Co umí

| Co | Jak |
|---|---|
| **Podepsat dokument z e-mailu** | Přes podpisový workflow z upraveného DocuSealu. Šablona musí mít pole „Podpis certifikátem“ (typ `qes`). |
| **Podepsat PDF, které přišlo jinudy** | Vybereš soubor v appce, nahraje se do DocuSealu, klepnutím umístíš pečeť a podepíšeš. |
| **Ověřit cizí PDF** | Appka ti řekne, jestli je podpis platný, kdo ho udělal a jestli se soubor nezměnil. |
| **Vše zůstane v DocuSealu** | Podepsané dokumenty, historie i audit jsou na jednom místě. |

## Jak to funguje

**Podpisový workflow z DocuSealu**

1. Firma nahraje PDF do upraveného DocuSealu, do šablony přidá pole „Podpis certifikátem“ (typ `qes`)
   a odešle ti e-mail s odkazem.
2. Otevři odkaz a dokument si prohlédni.
3. Klepni na „Podepsat“ a potvrď otiskem prstu nebo PINem.
4. Hotovo — dokument je podepsaný a uložený, firma vidí stav.

Tohle je standardní podpisový workflow DocuSealu. Bez pole `qes` v šabloně se podpisový odkaz vůbec nevytvoří.

**Přímý podpis PDF**

PDF, které ti přišlo e-mailem, z WhatsAppu nebo z portálu, vybereš přímo v appce. Appka ho nahraje
do DocuSealu, ty klepnutím umístíš pečeť a podepíšeš. Výsledek najdeš ve složce „Direct signing“.

**Ověření PDF**

PDF nahraješ do appky, server ověří podpis a řekne ti, kdo ho podepsal a jestli se soubor nezměnil.
PDF se neukládá, dokud ho sám neuložíš.

| Co | Kde |
|---|---|
| Dokument, e-mail, historie, audit | DocuSeal |
| Podpis (AdES) | appka v telefonu |
| Klíč | telefon — nikdy na serveru |

QES s čipem eObčanky je v přípravě. Tam bude klíč v čipu a appka bude potřebovat čtečku.

## Dvě úrovně podpisu

| | AdES | QES |
|---|---|---|
| **Kde je klíč** | v telefonu | v čipu eObčanky |
| **Co potřebuješ** | telefon | telefon a čtečku |
| **Co podpis umí** | průkazný podpis, ověřitelný běžnými nástroji | má stejnou váhu jako vlastnoruční podpis |
| **Stav** | hotové | v přípravě |

Teď Dokulachtan podepisuje AdES. Za AdES podpis se neplatí. QES s čipem eObčanky je v přípravě.

## Vyzkoušet

**Podepisuješ dokument?**

1. Otevři odkaz z e-mailu, který ti poslal upravený DocuSeal.
2. Zkontroluj dokument a klepni na „Podepsat“.
3. Potvrď otisk prstu nebo PIN.

Odkaz posílá upravený DocuSeal; v šabloně musí být pole „Podpis certifikátem“ (typ `qes`).

**Chceš to provozovat?**

1. Nainstaluj si [upravený DocuSeal](https://github.com/v1b3coder/docuseal) a nastav trust roots na autoritu,
   která ti certifikát vydala (výchozí je PostSignum). Appka se k němu připojí přes API.
2. Stáhni si appku (Android 7.0+) z [Releases](https://github.com/v1b3coder/dokulachtan/releases/latest)
   a v *Nastavení* zadej Server URL a API token (DocuSeal → Nastavení → API).
3. V DocuSealu nahraj PDF, přidej pole „Podpis certifikátem“ a odešli.

## Stav

- **Hotové:** podpis certifikátem v DocuSealu (AdES), Android appka, přímý podpis PDF,
  ověření PDF, vícenásobné podpisy, v praxi se používá.
- **Zbývá:** QES s čipem eObčanky (reálná čtečka) a kvalifikované časové razítko.
- Detail a stav: [AGENTS.md](AGENTS.md#stav).

## Pro vývojáře

Vývoj, testy, nasazení a mapa dokumentace: [DEVELOPMENT.md](DEVELOPMENT.md).

- [DESIGN.md](DESIGN.md) — co a proč
- [SPEC.md](SPEC.md) — jak přesně (model, API, obrazovky, testy)
- [PLAN.md](PLAN.md) — fáze P0–P8
- [AGENTS.md](AGENTS.md) — pravidla repa a aktuální stav

## Licence

Fork vychází z [DocuSeal](https://github.com/docusealco/docuseal) (AGPL-3.0) a zůstává
AGPL-3.0 s uvedením autorství. Vlastní kód forku: <https://github.com/v1b3coder/docuseal>.
