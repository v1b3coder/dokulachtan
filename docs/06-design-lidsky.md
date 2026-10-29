# Design lidsky (bez odborných termínů)

Datum: 2026-10-14

Cíl: vysvětlit, co vlastně stavíme, aby bylo jasné, jestli si rozumíme. Odborné termíny
jsou schválně potlačené — technické detaily jsou v [DESIGN.md](../DESIGN.md) a [SPEC.md](../SPEC.md).

## 1. Co stavíme

Nástroj, ve kterém firma pošle dokument k podpisu a člověk ho podepíše **svým vlastním
„úředním“ podpisem** — z mobilu nebo z počítače. Důležité je, že **klíč k podpisu zůstane
u člověka** (v čipu občanky, nebo v telefonu). Nikdy se nenahraje na server.

## 2. Přirovnání

- **DocuSeal = úřadovna.** Připraví dokument, pošle e-mail, hlídá, kdo už podepsal,
  uloží výsledek a vede záznam (kdo, kdy, co).
- **Certifikát = průkaz totožnosti podpisu.** Je veřejný, může ho vidět každý. Říká: „tento
  podpis patří Janu Novákovi a vydala mu ho tato autorita.“
- **Soukromý klíč = samotné pero.** Kdo ho získá, může podepisovat za vás. Proto se nesmí
  nikam posílat.
- **Čip v občance / telefon = trezor na pero.** Když je pero v **certifikovaném** trezoru
  (odborně QSCD), podpis má ze zákona stejnou váhu jako vlastnoruční (říká se mu **QES**).
  Když je pero jen v běžném úložišti telefonu, podpis je pořád průkazný, ale ne „jako
  vlastnoruční“ (říká se mu **AdES**).

## 3. Dvě cesty, které jsme si vybrali

**Potvrzeno 2026-10-14:** většina dokumentů potřebuje **AdES** (průkazný podpis), QES jen
výjimečně; podepisuje se **hlavně z mobilu**; podepisují **zaměstnanci firmy**; výsledek má být
**jen v DocuSealu**.

Z toho plyne: **hlavní cesta je B** (mobil, AdES). Cesta A (QES z čipu občanky) je doplňková pro
případy, kdy zákon nebo úřad chce vlastnoruční váhu.

| | Cesta A | Cesta B |
|---|---|---|
| Odkud bere pero | čip občanky | úložiště v telefonu |
| Co je potřeba | čtečka karet | nic (jen telefon) |
| Jak silný podpis | **QES** (jako vlastnoruční) | **AdES** (průkazný) |
| Kolik stojí | cena čtečky (300–5 500 Kč) | 0 |
| Na mobilu | Bluetooth čtečka + naše appka | naše appka |

Obě cesty jsou **zdarma** (žádné poplatky za podpis) a obě mají pero u člověka.
Rozdíl je jen v tom, jak silný podpis vznikne a co je k tomu potřeba.

## 4. Jak to vypadá pro člověka, který podepisuje

1. Přijde mu e-mail: „Podepište prosím smlouvu.“
2. Otevře odkaz a uvidí dokument.
3. Zkontroluje ho (klidně si ho prolistuje).
4. Klikne na „Podepsat“.
5. Telefon si vyžádá otisk prstu nebo obličej (biometrie; PIN zařízení se nepovoluje).
6. Hotovo — dokument je podepsaný a uložený, firma dostane zprávu.

Pro firmu, která dokument posílá, se nic nemění: jako dnes nahraje dokument do DocuSealu,
vybere, kdo má podepsat, a sleduje stav.

## 5. Co je kde

| Co | Kde to je |
|---|---|
| Dokumenty, e-maily, evidence, záznam o podpisu | **DocuSeal** |
| Podepisování (appka, čtečka) | **naše aplikace** |
| Pero (klíč) | **v čipu občanky nebo v telefonu** — nikdy na serveru |

Výsledný podepsaný dokument zůstane **v DocuSealu** — naše appka ho tam vrátí a nic dalšího
se nezakládá. Proto upravujeme DocuSeal (fork), místo abychom vedle něj stavěli druhý systém.

## 6. Co znamená „upravit DocuSeal“ (fork)

Do DocuSealu přidáme **nový typ pole: „podpis certifikátem“**. Jinak je to pořád stejný
DocuSeal — jedna aplikace, jedna evidence, jeden e-mail. **Nestavíme druhý systém vedle.**

## 7. Co už máme ověřené

- Umíme přečíst cizí podepsaný dokument a říct: je v pořádku / byl změněn / certifikát
  vypršel / byl zneplatněn.
- Umíme vyrobit podpis, který obstojí před ostatními nástroji (pdfsig, pyHanko, DSS/ETSI).
- Umíme poznat, jestli je pero v certifikovaném trezoru (QES), nebo ne (AdES) — takže
  nebudeme AdES vydávat za QES.
- Umíme ověřit i bez internetu (důležité pro dlouhodobou platnost podpisu).

## 8. Co ještě není

- Reálná čtečka eObčanky (MOI Podpisové SDK) — v appce je zatím stub a fake card pro testy.
- Kvalifikované časové razítko (nyní DigiCert free, non-qualified).
- První reálný podpis na produkční instanci s PostSignum certem.

Úpravy DocuSealu, podpisová appka, AdES podpis, přímý podpis PDF i ověření PDF jsou hotové.
