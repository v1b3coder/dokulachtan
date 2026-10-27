# Deployment na Fly.io — analýza

Datum: 2026-10-15

Otázka: „Lze dokulachtan releasovat jednoduše jako Docker kontejner? Uvažuju o staging deploymentu
na Fly.io.“ — analýza, nic se nenasazuje.

**Rozhodnutí (2026-10-15): varianta A** — 1 Fly app **`dokulachtan`** + volume + SQLite,
region `fra`, staging. Varianta A (eObčanka) je **client-side** (čtečka je u uživatele); server ji
neimplementuje, v cloudu ji řeší appka / lokální agent.

**Aktualizace (2026-10-18):** prostředí je rozdělené na **produkci** `dokulachtan`
(volume `dokulachtan_prod_data`, reálné PostSignum CA, `QES_REQUIRE_LTV=true`, bez testovacího
rootu) a **staging** `dokulachtan-staging` (volume `dokulachtan_staging_data`, testovací root +
PostSignum CA, `QES_REQUIRE_LTV=false`). Konfigurace jsou v parent repu: `deploy/docuseal/fly.toml` = produkce,
`fly.staging.toml` = staging (do forku se předávají přes `--config`).

## TL;DR

**Ano.** Fork používá upstream Dockerfile a náš patch pro variantu B **nepřidává žádné systémové
závislosti** (PAdES dělá HexaPDF, který už v image je). Kontejner je self-contained: web (Puma)
+ joby (Sidekiq) + Redis + automatické migrace. Na Fly tedy stačí **1 app + 1 volume** a databáze
(SQLite na volume pro staging, Postgres pro produkci). Mobilní appka (Expo) se nasazuje zvlášť,
není to kontejner.

## Co kontejner potřebuje (zjištěno z forku)

| Věc | Zjištění |
|---|---|
| Web | Puma, port `PORT` (default 3000), healthcheck `/up` |
| Joby | Sidekiq embedovaný v Pumě (`plugin :sidekiq_embed`) |
| Redis | embedovaný (`plugin :redis_server`, `LOCAL_REDIS_URL`); heslo se odvozuje z `SECRET_KEY_BASE` |
| Migrace | automaticky při startu (`config/initializers/migrate.rb`), vypnutelné `RUN_MIGRATIONS=false` |
| Úložiště souborů | ActiveStorage `disk`, root `$WORKDIR/attachments` = `/data/docuseal/attachments` → **volume** |
| Databáze | `DATABASE_URL`; když je prázdná, použije se **SQLite** `$WORKDIR/db.sqlite3` |
| Secrets | `SECRET_KEY_BASE` se vygeneruje a uloží do `$WORKDIR/docuseal.env` (tedy na volume) |
| Build | multi-stage (fonts + pdfium + onnx → webpack → app); lock má `x86_64-linux-musl` i `aarch64-linux-musl` |
| Náš patch | pro variantu B žádné nové systémové balíčky |

## Varianty nasazení

| # | Varianta | Jak | Cena/poznámka | Vhodné pro |
|---|---|---|---|---|
| A | **1 app + volume (SQLite)** | kontejner + 1 GB volume | ~$3–5/měs.; 1 machine, bez záloh (jen snapshot volume) | staging |
| B | 1 app + volume + **Fly Postgres** | `fly postgres create` + `attach` | ~$10–15/měs.; Postgres je „self-managed“ | staging/malá produkce |
| C | 1 app + **Managed Postgres (MPG)** | spravovaná DB, zálohy řeší Fly | dražší | produkce |
| D | 1 app + **externí Postgres** (Neon/Supabase) | `DATABASE_URL` na externí DB | zdarma/levné, DB mimo Fly | staging |
| E | více app + **S3 (Tigris)** | ActiveStorage na S3, více strojů | produkce, horizontální scaling | produkce |

Doporučení pro staging: **A** (nejjednodušší) nebo **D** (externí DB). Pro produkci: **C** nebo **E**.

**Zvoleno pro obě prostředí: A** (1 app + volume + SQLite; `dokulachtan` = produkce,
`dokulachtan-staging` = staging).

## Stav nasazení (2026-10-18)

> Aktuální stav (release, verifikace po nasazení) je v `AGENTS.md` → Deployment; tato sekce
> popisuje prvotní nasazení. Prostředí jsou dvě (rozdělení 2026-10-18):

**Produkce `dokulachtan`** (<https://dokulachtan.fly.dev/>):

- machine `80e9579c6de348`, region `fra`
- volume `dokulachtan_prod_data` (1 GB, `fra`, snapshoty zapnuté) → `/data/docuseal`
  (nový prázdný volume; starý `dokulachtan_data` s testovacími daty zůstává odpojený)
- `QES_TRUST_ROOTS=/app/config/qes/postsignum.pem` (jen reálné PostSignum CA, bez test rootu)
- `QES_REQUIRE_LTV=true`, `QES_TSA_REQUIRED=false`, `QES_ENABLED=true`
- `QES_ANDROID_CERT_SHA256=80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0`
  (release APK; testovací APK na `dokulachtan-download` má debug podpis a App Links neotevře)
- healthcheck `/up` = 200; `/` → `/setup` (čeká na první účet)
- migrace proběhly automaticky při startu; `SECRET_KEY_BASE` a `docuseal.env` na volume
- SMTP zatím nenastaveno (`deploy/smtp.env` neexistuje)
- první účet (setup) vytváří uživatel v prohlížeči

**Staging `dokulachtan-staging`** (<https://dokulachtan-staging.fly.dev/>):

- machine `78111546b1dd68`, volume `dokulachtan_stg_restore` → `/data/docuseal`
  (obnovený ze snapshotu starého staging volume; účet a šablona „QES E2E (staging)“ k dispozici)
- `QES_TRUST_ROOTS=/app/config/qes/root.crt,/app/config/qes/postsignum.pem`
  (testovací klíče fungují, reálné PostSignum certy také)
- `QES_REQUIRE_LTV=false` (testovací CRL DP `127.0.0.1:8765` není dostupné)
- `QES_PUBLIC_BASE_URL=https://dokulachtan-staging.fly.dev`
- `QES_ANDROID_CERT_SHA256=80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0`
  (release keystore z `deploy/android-release/`; lokální debug build má jiný otisk)

## Konkrétní kroky (až se bude nasazovat)

1. `deploy/docuseal/fly.toml` (produkce) / `fly.staging.toml` (staging) v parent repu: `[build] dockerfile`,
   `[http_service] internal_port = 3000`, `[[vm]] shared-cpu-1x 1GB`, `[[mounts]]` s vlastním volume,
   healthcheck na `/up`. `release_command` netřeba — migrace běží při startu.
2. Secrets: `HOST` (veřejná URL), případně `DATABASE_URL`, SMTP. `SECRET_KEY_BASE` se vygeneruje sám
   a zůstane na volume (každé prostředí má vlastní).
3. Build: `make deploy-prod` / `make deploy-staging` (`fly deploy --config deploy/docuseal/fly*.toml`
   z parent repa) — remote builder
   **nebo** lokálně `podman build` + `fly auth docker` + `podman push registry.fly.io/<app>:staging` +
   `fly deploy --image`.
4. Region: `fra`/`ams` (EU, blízko ČR).
5. Staging: `auto_stop_machines = true`, `min_machines_running = 0` → platí se jen za provoz.
6. TLS: `*.fly.dev` zdarma; vlastní doména přes `fly certs add`.
7. Mobil: `EXPO_PUBLIC_API_URL=https://<app>.fly.dev`; deep link custom scheme pro staging,
   universal links až s doménou.

## SMTP (odesílání e-mailů)

**Fly.io žádnou e-mailovou službu neposkytuje** — je to hosting, ne e-mailový provider. V marketplace
Extensions žádný e-mailový provider není a Fly sám doporučuje externí službu: jeho odchozí IP adresy nemají
rDNS, takže je přijímající servery často blokují. **Odchozí SMTP ale blokované není** — z obou machine
(`dokulachtan` i `dokulachtan-staging`, region fra) ověřeno TCP spojení na Gmail 587, Resend 465, Postmark 587,
Brevo 587, Mailtrap 2525 i port 25. Odesílá se tedy přes **externí SMTP relay**; e-mailovou infrastrukturu
nikdo neprovozuje.

**Nasazeno (2026-10-18):** Brevo free (300 e-mailů/den). Obě prostředí mají stejné přihlašovací údaje
(`SMTP_USERNAME=<SMTP_USERNAME>` — login **není** e-mail účtu, Brevo u novějších účtů generuje
`[ID]@smtp-brevo.com`) a jako odesílatele `<SMTP_FROM>` (registrační adresa účtu = ověřený sender).
Reálné hodnoty jsou v `deploy/smtp.env` (gitignored).
Doménu odesílatele Brevo u neautentizovaných domén — včetně free providerů jako gmail.com — **sám nahradí
za `@<id>.brevosend.com`**, což je jejich vlastní autentizovaná doména; vybrat si ji nedá, přiděluje ji Brevo.
Dřívější pokus s `staging@example.com` / `noreply@example.com` se nedoručil (nešlo o ověřeného sendera).

| Prostředí | App | `SMTP_FROM` | Ověřeno |
|---|---|---|---|
| Staging | `dokulachtan-staging` | `<SMTP_FROM>` | STARTTLS + auth OK, `MAIL FROM` 250, `RCPT TO` 250 |
| Produkce | `dokulachtan` | `<SMTP_FROM>` | totéž |

Vyplnit stačí 6 hodnot (`SMTP_AUTHENTICATION` a `SMTP_ENABLE_STARTTLS` mají rozumný default):

| Proměnná | Význam |
|---|---|
| `SMTP_ADDRESS` | host relaye |
| `SMTP_PORT` | port (obvykle 587 STARTTLS, 465 SSL) |
| `SMTP_USERNAME` | login |
| `SMTP_PASSWORD` | heslo / SMTP key |
| `SMTP_DOMAIN` | doména pro EHLO |
| `SMTP_FROM` | odesílatel; **povinný** — bez něj DocuSeal přepíše From prázdným řetězcem |

Dvě cesty, jak je zadat (tajemství nikdy do repa):

1. **UI DocuSealu** — `/settings/email` (Settings → Email). Uloží se zašifrovaně v DB na volume,
   nepotřebuje redeploy a DocuSeal při uložení sám pošle testovací e-mail na `from_email`.
2. **fly secrets** — vyplň `deploy/smtp.env` (staging) nebo `deploy/smtp.prod.env` (produkce), oba gitignored,
   vzory `deploy/smtp*.env.example`, a spusť `make smtp-setup APP=dokulachtan-staging`
   (produkce: `APP=dokulachtan SMTP_FILE=deploy/smtp.prod.env`); pak `make smtp-check APP=…`
   a `make smtp-test APP=… TO=adresa@example.com` — testovací e-mail se posílá na `TO=`, protože
   `SMTP_FROM` (např. `example.com` bez MX) nemusí umět přijímat poštu.

### Odesílatelská doména

Relay nesmí jen tak posílat „jako“ z domény, kterou nevlastní — přijímající servery kontrolují SPF/DKIM.
Bez autentizované domény proto **Brevo přepíše doménu odesílatele na `@brevosend.com`**
(`<id>.brevosend.com`), a to i pro adresy z free providerů, jako je gmail.com. Ověření
jednotlivého odesílatele kódem navíc potřebuje schránku, která umí poštu přijmout (MX záznam) —
`example.com` žádné MX nemá (apex míří na GitHub Pages), takže tudy cesta nevede.

**Nejjednodušší varianta: posílat z reálné schránky, kterou už máme.** Adresa je stabilní, provider
(Google/Seznam/firma) ji autentizuje sám, nic se nepřepisuje — žádné DNS, žádná doména. Pozor: i tak musí
`SMTP_FROM` přesně odpovídat přihlašované schránce — Seznam jinou adresu odmítne (`5.1.0 Use your own
address, please`), stejně tak Google. U schránky se dvoufázovým ověřením je místo hesla potřeba
„heslo pro aplikace“ (Seznam: Účet → Zabezpečení účtu → Dvoufázové ověření → Heslo pro aplikace).

| Varianta | Zdarma | Odesílatel | Poznámka |
|---|---|---|---|
| **Vlastní schránka — Gmail** | ~500 příjemců/den | tvoje adresa, autentizovaná Googlem | app password (nutné 2FA) |
| **Vlastní schránka — Seznam** | dle účtu | tvoje adresa | `smtp.seznam.cz:465` (SSL); login = celá adresa; s 2FA **heslo pro aplikace**; `SMTP_FROM` musí být přesně adresa schránky, jinak Seznam vrátí `5.1.0 Use your own address, please` |
| **Brevo** | 300/den | jen s autentizovanou doménou (SPF+DKIM v DNS) | bez ní přepíše doménu na `@brevosend.com` |
| **Resend** | 3000/měsíc | bez ověřené domény jen `onboarding@resend.dev` | doručí jen na adresu účtu |

Konkrétně u Breva:

- **SMTP klíč**: dropdown účtu (vpravo nahoře) → *Settings → SMTP & API* → záložka *SMTP* → *Generate a new SMTP key*.
  Login **není** vždy e-mail účtu — u novějších účtů je to vygenerované `[ID]@smtp-brevo.com`, přesná hodnota je v poli *Login*.
  Free plán je **300 e-mailů/den** (ne měsíčně).
- **Autentizace domény**: *Settings → Senders, Domains & Dedicated IPs → Domains → Authenticate*
  (Brevo code TXT + 2× DKIM CNAME + DMARC). U autentizované domény Brevo ověření jednotlivých
  odesílatelů nevyžaduje, takže doména nemusí umět přijímat poštu (MX).
- Na Cloudflare (kde je `example.com`) musí být u DKIM CNAME vypnutý proxy status a CNAME flattening,
  jinak je Brevo nepřečte.

### Brevo: proč se e-maily nedoručí

Testovací e-maily z obou prostředí Brevo na SMTP úrovni přijalo (`MAIL FROM` i `RCPT TO` 250, `DATA` OK),
ale **nedoručily se**. Brevo podle vlastní dokumentace blokují dvě věci:

1. **Transakční odesílání se aktivuje zvlášť** — „Transactional email sending requires a separate
   activation step from Brevo. If you've never sent transactional emails from your account, contact our support
   team by creating a ticket from your account to request activation“ (chyba `450 Your SMTP account is not yet
   activated`). Nový účet tedy musí poslat ticket (ikona nápovědy → *Support and Tickets*) a počkat na schválení;
   bez aktivace se zprávy přes SMTP přijmou, ale nikdy neodejdou.
2. **SMTP login nesmí být v poli From** — „Your SMTP login (`xxx@smtp-brevo.com`) is a technical
   authentication identifier, not a sender address. It must not be used in the From field.“ Odesílatel musí být
   buď ověřený sender (kód do schránky — ta musí umět přijímat poštu), nebo adresa z autentizované domény.

Stav konkrétní zprávy je vidět v **Transactional → Logs** (<https://app-smtp.sendinblue.com/log>),
fronta ve *Real time → Usage and plan → Email queue*.

## Pozor a rizika

- **Varianta A (eObčanka, PKCS#11) na Fly nefunguje server-side** — čtečka je u uživatele, ne v cloudu.
  V cloudu musí být A klientská komponenta (naše appka / lokální agent), nebo A jen v self-hosted/LAN.
- **SQLite** = jedna machine, žádné škálování; záloha = snapshot volume.
- `MULTITENANT=true` vypne embedded Redis + Sidekiq — pro nás nechat vypnuté (single-tenant).
- `RUN_MIGRATIONS=false` jen když chceme migrace řídit ručně.
- **E-maily**: staging potřebuje SMTP (jinak pozvánky neodejdou), nebo je vypnout.
- **GDPR**: na staging neposílat reálné dokumenty; použít testovací data.
- **Náklady**: staging s auto-stop ~$1–5/měsíc, trvale běžící ~$5–15/měsíc (podle DB varianty).

## Mobilní appka (není kontejner)

- Build: EAS (cloud) nebo lokálně `npx expo run:android` (SDK + Gradle jsou k dispozici).
- Staging: APK s `EXPO_PUBLIC_API_URL` na staging URL; distribuce interně (přímý APK / Firebase
  App Distribution; TestFlight později). Testovací APK z `deploy/apk/` má výchozí produkci a na staging se
  přepíná v appce *Nastavení → Server URL*; pro App Links na staging je potřeba rebuild APK s hostem
  `dokulachtan-staging.fly.dev`.
- Deep link: custom scheme `dokulachtan://` stačí pro staging; universal links (https) až s vlastní doménou
  a soubory `assetlinks.json` / `apple-app-site-association` v `public/`.
