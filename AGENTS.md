# AGENTS.md — dokulachtan

Rozcestník pro agenty. Detaily nejsou tady: **DESIGN.md** (co a proč) → **SPEC.md** (jak přesně)
→ **PLAN.md** (fáze P0–P8). Když si odporují, je to chyba v DESIGN.md (historie oprav v SPEC § 16).
Provoz, příkazy a mapa repa: [DEVELOPMENT.md](DEVELOPMENT.md); runbooky v `docs/`.

## Cíl

Přidat do [DocuSeal](https://github.com/docusealco/docuseal) podpis **certifikátem** (AdES/QES) tak,
aby klíč zůstal u člověka (telefon, čip občanky) a nikdy se nenahrál na server. Výsledek: fork
DocuSealu (větev `dokulachtan`) + Expo appka. Uživatel: zaměstnanci firmy, podepisuje se hlavně z mobilu.

## Závazná rozhodnutí — neediskutovat znovu

1. **Jen self-custody**: žádný remote QTSP, OAuth ani CSC. Klíč v čipu (A) nebo v telefonu (B).
2. **B je hlavní cesta**, A je doplňková pro QES a musí být client-side (čtečka u uživatele).
3. **Vše ve forku**, žádný sidecar: jedna aplikace, jedna evidence, jeden audit.
4. **Dvoukrokový protokol**: `GET /qes/sessions/:token` → `POST …/certificate` (cert → TBS s pečetí
   z certu → `data_to_sign`) → `GET …/document` (kontrola) → `POST …/complete` (raw signatura).
   Cert je veřejný, posílá se před kontrolou; klíč se odemyká až po ní.
5. Podepisují se **podepsané atributy CMS**, ne digest dokumentu. **LTV patří do DSS**, ne do CMS
   (HexaPDF ho neumí, pyHanko unsigned CMS atributy nečte).
6. **Pečeť DocuSealu se přidává inkrementálně** až po podpisu appky; podpis appky zůstává INTACT.
7. **Vícenásobné podpisy**: každý signer má vlastní pole `qes` a `QesSession`, podpisy jdou po sobě
   a řetězí se jako PAdES revize.
8. **Přímý podpis PDF = nativní tok DocuSealu** (šablona + submission + obřad), jediný endpoint navíc
   `POST /api/qes/documents`. Nevracet vlastní vrstvu `QesPdfSession`.
9. **Při podpisu se nikdy nezadává heslo**: heslo k PKCS#12 jen při importu, pak AES-256-GCM + biometrie.
10. **Volba podepisujícího je automatická** dle `level_required`; appka se neptá.
11. **Varianta A = MOI Podpisové SDK** v appce, ne PKCS#11 na serveru.
12. **Dev/test na SQLite**, Postgres 18 jen jako parita s upstream CI.
13. **České defaulty jsou ve forku** (`Qes::Config::DEFAULTS`), ENV je jen override.
14. **Pečeť nese identitu z certifikátu** (CN + první SAN e-mail), ne submittera; `complete` ověří
    shodu (`stamp_mismatch`).

## Nepřekročitelná pravidla

- **Klíč nikdy neopustí telefon/čip**; server vidí jen hash a podpis.
- **AdES se nikdy nesmí vydávat za QES** (kontrola QCStatements `QcSSCD`).
- **Stampa se kreslí z certifikátu, ne ze submittera**; `complete` po podpisu ověří shodu.
- **Tajemství** (SMTP, klíče) jen přes `fly secrets` / `.env` (gitignored), nikdy do repa.
- **„Produkce“ = privátní instance uživatele** (dnes Fly app `dokulachtan`), ne centrální služba ani
  konkrétní URL; `RAILS_ENV=production` je jen prostředí Rails. Proti produkční instanci nic netestuj.
  Adresa instance se v každém nasazení mění (`QES_PUBLIC_BASE_URL`, server URL v appce, `app` ve `fly*.toml`)
  — nikdy ji nezapeč jako default do forku nebo serverového kódu.
- **Nepleť „Android podpis APK“ a „certifikát pro podpis dokumentů“**: první je integrita APK
  (debug vs. release keystore), druhý je AdES/QES podpis PDF (PostSignum `.p12` od uživatele).
  Samotné slovo „certifikát“ je zakázané.
- **Android odkazy jdou přes custom scheme** `dokulachtan://sign` (App Links zrušeny); iOS AASA zůstává.
- **Lokální buildy mají vlastní applicationId** (`debug` = `.debug`, testovací APK = `.test`), aby se vešly
  vedle produkce; data jsou oddělená. Detaily: [docs/10-qes.md](docs/10-qes.md#apk-pro-testování).
- **Fork zůstává AGPL-3.0 + attribution**, patch minimální a rebasovatelný.

## Pravidla patche forku

- **Žádná duplikace upstream kódu** — hook volá náš kód (`nil` = pokračuj) nebo `super`.
- **Explicitní seam > prepend s kopií** — malý parametr/větev, výchozí cesta upstreamu beze změny.
- **`prepend`/`include` jen pro nové chování** — validace, callbacky, asociace, `rescue_from`.
- **Konfigurace mimo upstream soubory** — i18n, routes, testy, Tailwind, UI komponenty.
- Obecné bugfixy patří do upstreamu; nový dotek jen s odůvodněním a contract testem.
  Detail: [docs/08-fork-workflow.md](docs/08-fork-workflow.md).

## Příkazy a testy

**Nevypisuj si příkazy odsud — přečti si `Makefile`.** Každý cíl má `##` popis, `make help`
vypíše všechny. Oblasti: příprava (`venv`, `fork-setup`), fáze testů (`test*`), interní tiery (`qes-test*`), JS a appka
(`qes-js-test`, `qes-app-*`), E2E (`qes-e2e*`, `qes-negative`), staging (`qes-staging-*`),
nasazení a provoz (`deploy-*`, `smtp-*`), historické interop nástroje (`fixtures`, `validate`, `negative`).

**Fáze testů** (detail a rozhodovací strom: [test/README.md](test/README.md)):

- **F0** `make test-prepare` — po klonu / změně Dockerfilu.
- **F1** `make test` — před pushem (T0 + JS + app + typecheck); hook `.githooks/pre-push`.
- **F2** `make test-ci` — před PR (F1 + T1).
- **F3** `make test-full` — před release / po bumpu pinu (F2 + T2 + T3 + negativní + E2E).
- **F4** `make test-manual` / `make test-android` — staging, EU DSS, emulátor; nikdy v CI.
- **F5** `make test-tools` — fixtures, validate, legacy.

Pin forku musí sedět na `vendor/docuseal.rev`; hook to blokuje. Přeskočení: `SKIP_QES_HOOK=1 git push`.

## Kde co hledat

- [DEVELOPMENT.md](DEVELOPMENT.md) — rychlý start, tiery, E2E, nasazení, konfigurace, mapa repa a docs.
- `docs/` — průzkum, runbooky, triage; seznam v [DEVELOPMENT.md](DEVELOPMENT.md#dokumentace).
- **Před zásahem do deploy nebo QES konfigurace si přečti** [docs/09-deployment-flyio.md](docs/09-deployment-flyio.md)
  a [docs/10-qes.md](docs/10-qes.md) (prostředí, ENV, trust roots, TSA, troubleshooting).
- `vendor/docuseal` — gitignored klon forku, pin = `vendor/docuseal.rev`.

## Stav

Hotovo P0–P8 kromě reálné čtečky (P5 je stub + fake card): QES vrstva, kryptografie
(TBS → CMS → embed → LTV/DSS → DocTS → validace → pečeť), vícenásobné podpisy, přímý podpis PDF,
ověření PDF, appka s vaultem a importem PKCS#12, tiery T0–T3.

Zbývá: reálná čtečka eObčanky (MOI SDK) a kvalifikované časové razítko (nyní DigiCert free).
Zapojení čtečky v appce je odloženo do dodání hardware; QES v appce je dnes nedosažitelné.

Historie je v gitu. Drž tento soubor kompaktní (do 100 řádků), jen aktuální pravidla, žádná duplikace
docs ani kódu — linkuj.
