# 17 — Hierarchie akcí v appce: audit a návrh uspořádání

**Datum:** 2026-10-22
**Stav:** realizováno 2026-10-22 (D1–D5 potvrzeny uživatelem); nálezy N1–N19 jsou opravené, pravidla níže platí dál
**Rozsah:** všech 8 obrazovek appky (`mobile/app/app/*.tsx`), které obsahují tlačítka

## 1. Příčina

Funkce se přidávaly po jedné a každá si přinesla vlastní tlačítko do stávajícího seznamu.
V appce existují jen **dvě vizuální váhy** (`button` = plné, `secondaryButton` = obrys) a
**priorita = pořadí v kódu**, takže pozice odpovídá historii vývoje, ne tomu, co uživatel dělá.
Styly jsou navíc zkopírované v šesti souborech a už se rozešly (`marginTop` 0 / 16 / 24).

Důsledky, které lze v appce vidět:

- Na Home je jediné plné tlačítko **„Importovat jiný klíč“** — nejméně častá akce.
- Import má **dvě plná tlačítka** (výběr souboru a potvrzení) a mezi nimi alternativní cestu.
- Ověření PDF má **čtyři obrysová tlačítka stejné váhy** pod sebou.
- Mazání certifikátu je plnohodnotné tlačítko hned pod detaily, bez oddělení a bez potvrzení.
- Vypnutá tlačítka vypadají stejně jako zapnutá („Pokračovat“, „Podepsat“, „Importovat“).

## 2. Pravidla, která má nové uspořádání dodržet

| Váha | Vzhled | Použití | Max. na obrazovku |
|---|---|---|---|
| **Primární** | plné, barva `#291334` | jediná dopředná akce stavu | 1 |
| **Sekundární** | obrys | skutečná alternativa téhož úkolu | 1–2 |
| **Terciární** | textový odkaz bez rámečku | navigace, detail, zrušit, testovací cesty | libovolně |
| **Destruktivní** | text/obrys v červené, oddělený | smazání, nevratné akce | 1, vždy s potvrzením |

1. **Jedna primární akce na stav obrazovky.** Primární = to, co chce uživatel v tomto stavu
   nejčastěji udělat — ne nejnovější funkce.
2. **Primární akce je vždy ta dopředná.** „Zavřít“, „Zrušit“ a „Zpět“ nikdy nejsou plné.
3. **Alternativní cesta patří pod hlavní tok**, za oddělovač a s vysvětlením. Nikdy mezi
   vstupy a potvrzení.
4. **Akce patří k objektu, ne do hlavního seznamu.** Detail certifikátu je vlastnost karty
   certifikátu → karta je klikací, ne další tlačítko.
5. **Konfigurace nepatří na Home.** Nastavení a párování čtečky jsou jednorázové úkony.
6. **Destruktivní akce je poslední, oddělená a s potvrzením.** Nikdy dvakrát na dvou místech.
7. **Vypnuté tlačítko musí vypadat vypnutě** (snížená opacita, `accessibilityState.disabled`).
8. **Chyba patří k akci, kterou opravuje** — ne nad celou obrazovku, kde ji po scrollu není vidět.
9. **Symetrická volba** (dvě rovnocenné cesty bez výchozí) smí mít dvě stejně silná tlačítka;
   to je jediná výjimka z pravidla 1.

## 3. Nálezy

| # | Obrazovka | Před změnou (2026-10-22) | Problém |
|---|---|---|---|
| N1 | S1 Home | „Importovat jiný klíč“ = plné, první | nejméně častá akce je nejvýš a nejsilnější |
| N2 | S1 Home | „Podepsat PDF“ a „Ověřit PDF“ = obrys | každodenní akce jsou vizuálně slabší než import |
| N3 | S1 Home | „Detail certifikátu“ = samostatné tlačítko | je to vlastnost karty certifikátu hned nad ním |
| N4 | S1 Home | „Připojit čtečku“, „Nastavení“ = stejná váha | konfigurace soutěží s prací |
| N5 | S1 Home | „Podepsat PDF“ i bez klíče | vede na obrazovku, která skončí `certificate_missing` |
| N6 | S2 Import | testovací certifikát mezi heslem a „Importovat“ | vypadá jako krok formuláře, ne jako jiná cesta |
| N7 | S2 Import | „Vybrat soubor“ i „Importovat“ = plné | dvě primární akce; import jde zmáčknout bez souboru |
| N8 | S2 Import | po úspěchu zůstává formulář i souhrn | dvě primární akce („Importovat“ + „Hotovo“) |
| N9 | S3 Certifikát | „Smazat certifikát a klíč“ hned pod detaily | nevratná akce bez oddělení a bez potvrzení |
| N10 | S7 Nastavení | „Uložit nastavení“ = obrys | akce sekce je slabší než nic; „Uloženo“ zůstává po editaci |
| N11 | S7 Nastavení | testovací certifikát mezi serverem a diagnostikou | vývojářská cesta v produkčním nastavení |
| N12 | S7 Nastavení | druhé „Smazat certifikát a klíč“ | duplicita s S3, opět bez potvrzení |
| N13 | S10 Setup | testovací certifikát mezi klíčem a čtečkou | alternativní cesta rozděluje dvě skutečné volby; chybí „Zpět“ |
| N14 | S11 Podepsat PDF | „Vybrat PDF“ = plné, „Pokračovat“ = plné | výběr souboru je formulářové pole, ne akce obrazovky |
| N15 | S4 Podpis | po úspěchu „Stáhnout a sdílet“ i „Zavřít“ = plné | dvě primární akce, „Zavřít“ je špatně silné |
| N16 | S4 Podpis | při `certificate_missing` je import testovacího certu nad „Podepsat“ | alternativní cesta výš než primární akce |
| N17 | S14/S15 Ověřit | „Uložit do DocuSealu“ plné, „Ověřit jiné PDF“ obrys | vedlejší akce je primární; „Zavřít“ duplikuje back |
| N18 | všechny | vypnutá tlačítka bez vizuálního rozdílu | uživatel mačká a nic se neděje |
| N19 | všechny | 6× zkopírované styly tlačítek | rozešlé okraje, nelze změnit hierarchii na jednom místě |

## 4. Návrh po obrazovkách

### S1 Home

**Před změnou (2026-10-22):** 1. Importovat jiný klíč (plné), 2. Podepsat PDF, 3. Ověřit PDF, 4. Detail certifikátu,
5. Připojit čtečku, 6. Nastavení — vše obrys.

**Nově, klíč nahraný:**

1. **Karta certifikátu je klikací** (šipka `›`, text „Spravovat“) → S3. Varování o expiraci
   obsahuje odkaz „Importovat nový“ → S2.
2. **Primární:** „Podepsat PDF“.
3. **Sekundární:** „Ověřit PDF“.
4. **Terciární řádek:** „Připojit čtečku“ (jen Android) · „Nastavení“.

**Nově, bez klíče:**

1. Karta „Žádný certifikát“ s vysvětlením, co import znamená.
2. **Primární:** „Importovat klíč (PKCS#12)“.
3. **Sekundární:** „Ověřit PDF“ (ověření klíč nepotřebuje).
4. **Terciární řádek:** „Připojit čtečku“ (Android) · „Nastavení“.

„Importovat jiný klíč“ z Home **mizí** — nahrazování klíče patří do S3 (rozhodnutí D1).

### S2 Import certifikátu

**Před změnou (2026-10-22):** Vybrat soubor (plné) → heslo → testovací certifikát (obrys) → chyba → Importovat (plné).

**Nově:**

1. Vysvětlení (beze změny).
2. Label „Soubor PKCS#12“ + **sekundární** „Vybrat soubor“ / po výběru název souboru a „Změnit“.
3. Label „Heslo“ + pole s ikonou oka uvnitř pole: heslo je zamaskované, klepnutím na oko
   se zobrazí (kontrola překlepů u složitého hesla), dalším klepnutím zase skryje.
   Pole má vypnutý autocorrect a autoCapitalize — při přepnutí masky na iOS jinak
   může zahodit napsaný text. Obrazovka má `keyboardShouldPersistTaps="handled"`,
   aby oko zabralo i na první klepnutí, když je otevřená klávesnice (jinak ScrollView
   první klepnutí spolkne na její zavření).
4. **Primární** „Importovat“ — vypnuté, dokud není vybraný soubor.
5. Chyba těsně nad primární akcí.
6. Oddělovač + „Nebo“ + tlumené „Testovací certifikát je jen pro staging — nemá důvěryhodný
   kořen.“ + **terciární** „Použít testovací certifikát“.
7. Po úspěchu: formulář se schová, zůstane souhrn certifikátu + **primární** „Hotovo“.

### S3 Detail certifikátu

**Před změnou (2026-10-22):** detaily → „Smazat certifikát a klíč“ (obrys).

**Nově:**

1. Detaily (beze změny).
2. **Sekundární** „Importovat jiný klíč“ → S2 (sem se přesouvá nahrazování klíče z Home).
3. Oddělovač + nadpis „Nebezpečná zóna“.
4. **Destruktivní** „Smazat certifikát a klíč“ + `Alert` potvrzení (a biometrie dle SPEC § 9.1 —
   dnes chybí, viz § 6).

### S7 Nastavení

**Před změnou (2026-10-22):** URL → token → „Uložit nastavení“ (obrys) → testovací certifikát (obrys) → diagnostika →
o aplikaci → „Smazat certifikát a klíč“ (obrys).

**Nově, sekce:**

1. **Přímý podpis a ověření PDF** — URL, API token, **primární** „Uložit“ (vypnuté, dokud se
   nic nezmění; „Uloženo“ se resetuje při první editaci). Používá se jen pro přímý podpis PDF
   a ověření PDF, ne pro podpisové odkazy.
2. **Důvěryhodné servery pro podpisové odkazy** — seznam originů s datem důvěry a „Odvolat“;
   server se přidá při prvním podpisu z odkazu (TOFU). Server z Nastavení je v seznamu
   jako vždy důvěryhodný, bez „Odvolat“.
3. **Podepisování** — řádek „Certifikát“ (subject + úroveň) → S3; řádek „Čtečka“ (Android) → S8.
   Sem se přesouvá párování čtečky z Home.
4. **O aplikaci** — verze + attribution MOI SDK (beze změny).
5. **Pokročilé (testování)** — tlumené vysvětlení + **terciární** „Importovat testovací certifikát“.
6. Mazání certifikátu zde **není** — jediné místo je S3 (rozhodnutí D3).

### S10 Setup (wizard)

**Před změnou (2026-10-22):** Importovat klíč (plné) → testovací certifikát (obrys) → Nastavit čtečku (obrys).

**Nově:**

1. Vysvětlení.
2. **Primární** „Importovat klíč (PKCS#12)“.
3. **Sekundární** „Nastavit čtečku“ (Android; na iOS se neukazuje).
4. Oddělovač + **terciární** „Použít testovací certifikát“ s poznámkou „jen staging“.
5. **Terciární** „Zpět“.

### S11/S12 Podepsat PDF

**Před změnou (2026-10-22):** Vybrat PDF (plné) → jméno → úroveň → Pokračovat (plné) → Zrušit (obrys);
v náhledu Podepsat (plné) → Vybrat jiné PDF (obrys) → Zrušit (obrys).

**Nově, výběr:**

1. Label „Soubor PDF“ + **sekundární** „Vybrat PDF“ (label zůstává i po výběru; žádné
   nahrazení názvem souboru). Po výběru se pod tlačítkem objeví malý **terciární**
   odkaz **„Otevřít“ + název souboru** (místní soubor před nahráním; podepisuje se
   verze s pečetí). Žádný samostatný řádek „Zkontrolovat PDF“.
2. Jméno do pečeti, úroveň (beze změny).
3. Chyba těsně nad akcí.
4. **Primární** „Pokračovat“ (vypnuté bez souboru) — jen upload a založení session,
   **nepodepisuje**.
5. **Terciární** „Zrušit“.

**Nově, náhled:** **primární** „Pokračovat“ (vypnuté bez umístěné pečeti; jen založí
submission + session a přejde na S4), **terciární** „Vybrat jiné PDF“, **terciární** „Zrušit“.

### S4 Žádost o podpis

**Před změnou (2026-10-22):** Zkontrolovat dokument (plné) → biometrie + `POST /certificate` + stažení TBS
→ Otevřít přesné PDF → Podepsat tento dokument; po úspěchu Stáhnout a sdílet (plné) + Zavřít (plné).

**Nově:**

- **Stav kontroly:** **primární** „Zobrazit dokument“ (jen `GET /document`, žádný klíč,
  žádný `POST /certificate`), **terciární** „Zrušit“.
- **Po otevření dokumentu:** **sekundární** „Otevřít dokument“ (znovu),
  **primární** „Podepsat dokument“ (odemkne klíč biometrií, ověří `data_to_sign`
  proti reviewed TBS a podepíše), **terciární** „Zrušit“ (zruší session).
- **Chyba `certificate_missing` / `no_signer` / `needs_reader` / `needs_qes_key`:**
  **primární** „Nastavit podepisování“ → S10, kontrola dokumentu zůstává viditelná.
- **Hotovo:** **primární** „Stáhnout“ (uložit do telefonu), **sekundární** „Sdílet“ (share sheet),
  **terciární** „Zavřít“; po návratu ze share sheetu jdou obě akce znovu.
- **Neshoda digestu / finálního PDF:** místo stahování se zobrazí chyba
  „Server vrátil jiný dokument, než jste viděli. Nestahujte ho a kontaktujte podporu.“

### S8 Připojení čtečky

Jediná akce „Vyhledat čtečku“ (plné) — beze změny. Vstup se přesouvá do S7/S10.

### S14/S15 Ověřit PDF

**Před změnou (2026-10-22), výběr:** Ověřit PDF (plné) → Podepsat PDF (obrys) → Zavřít (obrys).
**Před změnou (2026-10-22), výsledek:** Uložit do DocuSealu (plné) → Technické detaily → Ověřit jiné PDF → Zavřít.

**Nově, výběr (PDF ze share sheetu):** jde o symetrickou volbu → **dvě stejně silná** tlačítka
„Ověřit PDF“ a „Podepsat PDF“, pod nimi **terciární** „Zavřít“ (výjimka z pravidla 1).

**Nově, výsledek:**

1. Verdikt a karty (beze změny).
2. **Primární** „Ověřit jiné PDF“.
3. **Sekundární** „Uložit do DocuSealu“; po uložení se změní na stav „Uloženo do složky
   Verified documents.“ (žádné tlačítko).
4. **Terciární** „Technické detaily“.
5. **Terciární** „Zavřít“.

## 5. Sdílené komponenty

Nový soubor `mobile/app/src/ui/buttons.tsx` (cca 60 řádků, žádná závislost):

- `PrimaryButton`, `SecondaryButton`, `TextButton`, `DangerButton` — stejné rozměry a barvy
  jako dnes, navíc `disabled` (opacita 0,4 + `accessibilityState`).
- Volitelný `Section`/`Divider` jen pokud se použije na víc místech; jinak zůstane v obrazovkách.
- Obrazovky přestanou definovat `button`/`secondaryButton` styly; karty, inputy a layout zůstávají.

Tím se opraví N18/N19 a hierarchie půjde měnit na jednom místě.

## 6. Rozhodnutí k potvrzení

| # | Otázka | Doporučení |
|---|---|---|
| D1 | Má „Importovat jiný klíč“ zůstat na Home? | Ne — jen v S3 a v odkazu u expirace |
| D2 | Má „Připojit čtečku“ zůstat na Home? | Ne — do S7 (sekce Podepisování) a S10 |
| D3 | Má mazání certifikátu zůstat v S7? | Ne — jen v S3, s potvrzením |
| D4 | Co je primární na výsledku ověření? | „Ověřit jiné PDF“; uložení je sekundární |
| D5 | Má se po importu automaticky vrátit na Home? | Ne — souhrn + „Hotovo“ (uživatel vidí, co uložil) |

Mimo rozsah tohoto návrhu (samostatné nálezy): chybějící biometrie u mazání (SPEC § 9.1),
nerozlišené štítky share sheetu „Podepsat PDF“ / „Ověřit PDF“ (obojí končí na volbě, rozhodnutí
2026-10-22), diagnostika v S7 je jen text.

## 7. Verifikace

- `make qes-app-typecheck` zelené.
- `make qes-app-test` beze změny (testy pokrývají `src/lib`, ne obrazovky).
- Ruční průchod na emulátoru: Home s klíčem i bez, import (soubor + test cert), detail + mazání
  s potvrzením, Nastavení (uložení, čtečka, test cert), podpis PDF, ověření PDF, deep link S4.
- Aktualizovat SPEC § 9.1 (řádky S1, S2, S3, S4, S7, S10, S11, S14) a DESIGN § 5.1;
  řádek v `docs/16-overeni-pdf.md` § 273 („Ověřit PDF secondary mezi…“) je po změně neplatný.

## 8. Realizace (2026-10-22)

- Nový `mobile/app/src/ui/buttons.tsx`: `PrimaryButton`, `SecondaryButton`, `TextButton`,
  `DangerButton`; vypnutý stav má opacitu 0,4 a `accessibilityState.disabled`.
- Obrazovky přepsané na sdílené váhy: S1 (klikací karta, primární podle stavu klíče, terciární
  řádek), S2 (sekundární výběr souboru, testovací certifikát za oddělovačem, souhrn místo formuláře),
  S3 (import jiného klíče + nebezpečná zóna s `Alert` potvrzením), S7 (sekce Server/Podepisování/
  Diagnostika/O aplikaci/Pokročilé, „Uložit“ vypnuté dokud není změna), S10 (dvě skutečné cesty +
  testovací certifikát na konci + „Zpět“), S11/S12 (výběr souboru jako pole, primární „Pokračovat“/
  „Podepsat“), S4 (při chybě certifikátu primární „Nastavit podepisování“ → S10), S14/S15 (dvě stejně
  silné volby u share PDF, primární „Ověřit jiné PDF“, uložení sekundární), S8 (sdílené tlačítko).
- Chyby se zobrazují těsně nad akcí, kterou opravují (S11/S12); „Zrušit“/„Zavřít“ jsou terciární.
- Aktualizováno SPEC § 9.1, DESIGN § 5.1 a docs/16 (S1, S15).
- Ověřeno: `make qes-app-typecheck`, `make qes-app-test` (223/0).

## 9. Realizace (2026-10-25)

- **S4 dokončený přímý podpis:** **primární** „Stáhnout“ (uložit do telefonu), **sekundární**
  „Sdílet“ (share sheet), **terciární** „Zavřít“ — opravuje N15.
- Stažení finálního PDF jde nativně do cache (`File.downloadFileAsync`), ne přes blob v JS.
- „Stáhnout“ na Androidu 10+ ukládá přes `MediaStore` do `Download/Dokulachtan/`, na starším
  Androidu přes SAF a na iOS přes výběr složky (Soubory) — bez share sheetu.
- „Sdílet“ na Androidu otevírá vlastní modul `DokulachtanShare` (hlavní vlákno, promise hned),
  takže tlačítka po návratu ze sheetu zůstávají použitelná (opravuje N18 pro S4).
- Po uložení se nabídne „**Otevřít**“ (systémový prohlížeč PDF) a „**Uložit jinam…**“ (SAF picker);
  vybranou složku si appka zapamatuje a příště do ní ukládá přímo (výchozí zůstává Downloads).
- Ověřeno: `make qes-app-typecheck`, `make qes-app-test` (223/0), ručně na emulátoru
  (uložení do `Download/Dokulachtan/`, uložení do Documents + zapamatování, otevření v Drive PDF Viewer,
  share sheet, druhé sdílení i uložení po back).
