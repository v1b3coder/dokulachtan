# Audit testů: kde jde čas a jak je bezpečně zrychlit

Datum: 2026-10-27. Všechna čísla níže jsou **změřená** v tomto repu (SQLite harness
z `test/qes/Dockerfile.system`, `podman`, 20 CPU / 29 GB, stroj sdílený s jinými službami).
Kde je uvedený rozsah, jde o víc běhů téže sady — rozptyl je velký, viz § 2.

Cíl: zkrátit smyčku vývoje QES vrstvy, aniž by se snížilo pokrytí doteků upstreamu
(SPEC § 14, `docs/18`).

## 1. Souhrn

| # | Zjištění | Dopad |
|---|---|---|
| 1 | **69 % času full sady jde na upstream specy, které fork nemodifikuje** (243 ex / 265,7 s z 384,1 s) | `make qes-test` v denní smyčce zbytečně běží 4–6 min |
| 2 | **`spec/system/signing_form_spec.rb` sám = 133 s (35 % celé sady)**, jediný soubor, čistě upstream | sám drží podlahu plného paralelního běhu |
| 3 | **`make qes-test-qes` je 98–144 s, z toho ~80 s je `QesHelpers.build_qes_submission` (279× × 288 ms)** | nejdražší věc v rychlé smyčce je stavba DocuSeal šablony, ne kryptografie |
| 4 | **97 % ceny `create(:template)` je generování PNG náhledů** (218–644 ms → 16,9 ms bez nich); QES specy náhledy nepotřebují | ověřeno: 401 ex, 1 failure (spec, který náhledy testuje), 71 s místo 98–145 s |
| 5 | **Paralelizace 4 workery je bezpečná a vydá ~2×** (QES 98 → 50 s, system 227 → 89 s, 0 nových failure) | bez změny Gemfile, jen jiná DB a jiný kontejner na workera |
| 6 | **Explicitní `sleep` v specách jsou jen 2** (`0.1 s`, oba oprávněné); žádné zbytečné `sleep`/`wait` | tady není co zrychlovat |
| 7 | **Žádné mrtvé testy** — specy pro odstraněný kód (`QesPdfSession`, mrtvé CMS-LTV metody) už neexistují | „zastaralé testy" v tomto repu nejsou, jen zastaralá **politika spouštění** |
| 8 | **Dva známé 2FA flaky** (`signing_form_spec.rb:253` a `:1253`) padly ve 2 ze 3 běhů | falešná červená, ne čas; root cause je `deliveries.last == nil` |

Doporučená kombinace (fáze 1+2+3 níže): **QES smyčka 98 s → ~30 s (3×)**, plná sada
254–384 s → ~150 s. Plná sada má ale **podlahu 133 s** v `signing_form_spec.rb`, dokud
se ten soubor nerozdělí.

## 2. Metodika a proč jsou čísla rozptýlená

Měřeno třemi běhy stejné sady:

| Běh | Celkem | Poznámka |
|---|---|---|
| `make qes-test` (report v repu) | 4:14 | klidný stroj |
| tentýž běh s `--profile 40` | 5:02 | + profilování, `files took 13,13 s` |
| tentýž běh s `--format json` | 6:24 | studený bootsnap, `files took 3,3 s` |

Stejná sada tedy 254–384 s. Proto **neporovnávám wall clock, ale `run_time` z JSON
reportéru** (CPU čas per example, mnohem stabilnější). Kde uvádím wall clock, je to
orientační a je potřeba ho brát s rezervou ±30 %.

Reprodukce:

```bash
# JSON report s run_time per example (do mountnutého /app/tmp, jinak ho kontejner ztratí)
podman run --rm -v "$PWD/vendor/docuseal:/app" -v "$PWD/test:/qes-test:ro" -w /app \
  -e RAILS_ENV=test -e BUNDLE_WITHOUT= -e BUNDLE_GEMFILE=/app/Gemfile \
  -e PRIMARY_DATABASE_URL=sqlite3:/app/db/qes-test.sqlite3 \
  -e SCHEMA=/app/tmp/qes-test-schema.rb -e HOME=/tmp -e TZ=UTC -e QES_TEST_DIR=/qes-test \
  localhost/dokulachtan-qes-system-test \
  sh -c 'bundle exec rspec --exclude-pattern "spec/system/dashboard_spec.rb" \
    --format json --out /app/tmp/rspec.json --format progress'
```

## 3. Inventář a naměřené časy

### 3.1 Podle adresáře (646 ex, 384,1 s)

| Adresář | Examples | Čas | Podíl | s/example |
|---|---:|---:|---:|---:|
| `spec/system` | 136 | 226,7 s | 59,0 % | 1,67 |
| `spec/lib` | 254 | 76,6 s | 20,0 % | 0,30 |
| `spec/requests` | 171 | 51,5 s | 13,4 % | 0,30 |
| `spec/jobs` | 65 | 24,2 s | 6,3 % | 0,37 |
| `spec/models` | 20 | 5,0 s | 1,3 % | 0,25 |

### 3.2 Vlastní (fork) vs upstream specy

Zdroj: `git diff --name-only upstream/master...HEAD -- spec/` (51 souborů, z toho 47 speců).

| | Examples | Čas | Podíl |
|---|---:|---:|---:|
| **fork-owned specy** | 403 | 118,4 s | **30,8 %** |
| **upstream specy (beze změny)** | 243 | 265,7 s | **69,2 %** |

`make qes-test-qes` pustí 401 z 403 fork speců (98 s) — chybí 2 examples
z `spec/requests/doc_ts_verification_spec.rb`, viz § 5.3.

### 3.3 Nej dražší soubory

| Soubor | Examples | Čas | s/example | Fork? |
|---|---:|---:|---:|---|
| `spec/system/signing_form_spec.rb` | 48 | 133,0 s | 2,77 | ❌ upstream |
| `spec/system/template_spec.rb` | 11 | 24,4 s | 2,22 | ❌ upstream |
| `spec/system/team_settings_spec.rb` | 10 | 16,7 s | 1,67 | ❌ upstream |
| `spec/lib/qes/chain_spec.rb` | 6 | 15,9 s | 2,66 | ✅ fork |
| `spec/requests/qes_sessions_spec.rb` | 42 | 14,2 s | 0,34 | ✅ fork |
| `spec/lib/qes/revocation_pipeline_spec.rb` | 24 | 12,9 s | 0,54 | ✅ fork |
| `spec/lib/qes/verifier_spec.rb` | 31 | 11,2 s | 0,36 | ✅ fork |
| `spec/requests/submissions_spec.rb` | 21 | 8,8 s | 0,42 | ❌ upstream |
| `spec/lib/qes/validator_spec.rb` | 26 | 8,1 s | 0,31 | ✅ fork |
| `spec/system/webhook_settings_spec.rb` | 11 | 6,4 s | 0,58 | ❌ upstream |

### 3.4 Fixní režie jednoho běhu

| Položka | Čas |
|---|---:|
| `make qes-test-images` (plně z cache) | 1,1 s |
| start kontejneru + `db:create db:migrate` | 5,0 s |
| boot Rails + eager load + bootsnap (teplý) | 3,3 s |
| boot Rails (studený bootsnap) | 13–16 s |
| `qes-test-postgres`: síť + Postgres + `pg_isready` + DB + boot | ~10–15 s |

Fixní režie je ~2–5 % plného běhu. Nemá smysl ji řešit dřív než § 6.

## 4. Kde čas v QES vrstvě skutečně jde

Změřeno instrumentací (`OpenSSL::PKey::RSA.new` počítadlo) na 401 examples:

| Helper | Volání | Cena za volání | Celkem |
|---|---:|---:|---:|
| `QesHelpers.build_qes_submission` | **279** | **288 ms** | **~80 s** |
| `QesHelpers.build_qes_submitter` | 244 | (volá submission) | — |
| `QesHelpers.tsa_key_and_certificate` | 100 | 2× 42 ms | ~8 s |
| `QesHelpers.signed_pdf` | 65 | **580 ms** | **~38 s** |
| `QesHelpers.self_signed_pkcs12` | 7 | 42 ms | ~0,3 s |
| RSA 2048 keygen celkem | **152** | 42 ms | ~6,4 s |

Mikro-benchmark primitiv (5–10 iterací, `rails runner`):

| Operace | Čas |
|---|---:|
| `create(:template)` plně | **218–644 ms** |
| `create(:template)` bez generování náhledů | **16,9 ms** |
| `build_qes_submission` | **288 ms** |
| `Qes::TbsDocument.build` | 52–144 ms |
| `QesHelpers.signed_pdf` (celý) | **580 ms** |
| `Qes::Verifier.call` | 31 ms |
| `Qes::Validator.call` | 27 ms |
| `Qes::Seal.apply` | 10 ms |
| `Qes::PdfiumTrust.report` | 14 ms |
| HexaPDF parse signatur | 1,3 ms |
| RSA 2048 keygen | 42 ms |

**Závěr:** drahá část QES speců není kryptografie (Verifier 31 ms, Validator 27 ms), ale
**stavba DocuSeal šablony** — 279× upload PDF + Pdfium + Vips PNG náhledy + ActiveStorage.
`Templates::ProcessDocument.generate_pdf_preview_images` renderuje stránky v 200 DPI,
konvertuje přes libvips a ukládá PNG blob; to je 97 % ceny `create(:template)`.

## 5. Zastaralé a nerelevantní testy

### 5.1 Žádné mrtvé testy

Zkontrolováno, že v specách nejsou odkazy na odstraněný kód (nálezy z `docs/18` a `docs/20`):

| Hledaný symbol | Výskyty v `app lib` | Výskyty v `spec` |
|---|---:|---:|
| `QesPdfSession` | 0 | 0 |
| `QesSession#signed_attrs` (sloupec) | 0 | 0 |
| `QesSession.failed` scope | 0 | 0 |
| `Qes::Token::LENGTH` | 0 | 0 |
| `Qes::Config[:embed_inline]` | 0 | 0 |

Poznámka: `embed_inline` už v kódu vůbec není (odstraněno v `docs/20`), proto 0 výskytů
na obou stranách. Tabulka ověřuje, že po odstranění nezůstaly osiřelé specy.
| `adobe_revocation_info_der` | 0 | 0 |
| `revocation_values_der` | 0 | 0 |

Mrtvý kód byl odstraněn v `docs/18`/`docs/20`, specy s ním zmizely taky. **Nic k smazání.**

### 5.2 `spec/system` je z 99 % nerelevantní pro QES změny

`git diff upstream/master...HEAD -- spec/system/` je **prázdný diff**: fork v `spec/system`
nemodifikoval ani řádek. Přesto je to 136 examples / 226,7 s (59 % sady).

Jediné system specy, které chrání doteky forku, jsou ty, které projdou celý obřad a tím
spustí `GenerateResultAttachments`, `GenerateCombinedAttachment`, `GenerateAuditTrail`,
`Submitters::SubmitValues` a `SubmitFormController` — prakticky jen
**`signing_form_spec.rb`** (133 s) a částečně `submission_spec.rb` (2,1 s).

Zbylých ~92 s (`template_spec`, `team_settings_spec`, `webhook_settings_spec`,
`storage_settings_spec`, `profile_settings_spec`, `setup_spec`, `sign_in_spec`, …) testuje
upstream UI, které fork nezměnil. Pro vývoj QES je to nerelevantní.

**Není to ale „stale"** — je to jediná obrana proti regresi při rebase. Proto: **nevypínat,
jen přesunout z per-commitu do per-release gate** (§ 7, fáze 1).

### 5.3 Mezery v rychlé smyčce (opačný problém — chybí, ne přebývá)

`make qes-test-qes` matchuje jen `spec/requests/qes_*_spec.rb`, takže **vynechává**
`spec/requests/doc_ts_verification_spec.rb` (2 examples, ověření DocTS v upstream
verifikačních endpointech, nález N5 z `docs/20`). Je to 2 ze 403 fork examples.

`spec/javascript/qes_*.test.mjs` (3 soubory, 9 testů) se pouští jen přes `make qes-js-test`,
ne v `make qes-test` ani `qes-test-qes`. Rychlé, ale snadno zapomenuté.

### 5.4 Dva známé 2FA flaky — **opraveno**

`spec/system/signing_form_spec.rb:253` a `:1253` (upstream, `sidekiq: :inline`) padly
**ve 2 ze 3 běhů** tohoto auditu. Původní hypotéza (`deliveries.last == nil` kvůli
`sidekiq: :inline`) byla neúplná — skutečné příčiny jsou dvě:

1. **`RateLimit::STORE` je proces-globální `MemoryStore`** (`app/lib/rate_limit.rb`), ne
   `Rails.cache`. SQLite po rollbacku recykluje `submitter.id`, takže klíč
   `send-email-code-1` sčítá napříč example a po dvou kliknutích `update` vrátí
   `too_many_attempts` — e-mail se neodešle. V izolovaném běhu to projde (počítadlo 0),
   v plné sadě ne. **Oprava:** `config.before { RateLimit::STORE.clear }` v
   `spec/support/qes_helpers.rb` (test isolation, produkce se nemění).
2. **Re-send je omezený na 15 s** od předchozího `send_2fa_email` eventu
   (`SubmitFormEmail2fasController#update`), takže spec, která klikne na re-send hned,
   nikdy nedostane druhý e-mail. **Oprava:** `travel_to(+20 s)` kolem kliknutí a
   `change.by(1)` na obou odesláních.

Ověřeno 16/16 běhů zelených (6× izolovaně, 10× celý 2FA kontext).

### 5.5 Známé trvalé vyloučení

`spec/system/dashboard_spec.rb` je vyloučený z `make qes-test` (SQLite nemá `search_entries`,
`lib/search_entries.rb` bez guardu). Běží jen v `make qes-test-postgres`. To je správně,
nic k řešení.

## 6. `sleep` / `wait` audit

### 6.1 Specy (Ruby) — čisté

| Místo | Co to je | Hodnocení |
|---|---|---|
| `spec/signing_form_helper.rb:50` | `sleep 0.1` po `requestAnimationFrame` kreslení podpisu | ✅ oprávněné (čeká na dokreslení canvasu) |
| `spec/system/signing_form_spec.rb:774` | `sleep 0.1` po `attach_file` u uploadu | ✅ oprávněné (čeká na file input) |
| `spec/system/setup_spec.rb:33` | `wait_for_network_idle` | ✅ oprávněné |
| `spec/system/template_builder_spec.rb:26` | `wait_for_network_idle` | ✅ oprávněné |

**Žádné zbytečné `sleep`.** Zbytek čekání v system specách je implicitní Capybara wait
(`have_content`/`find` s default `max_wait_time` 2 s), který se použije jen na chybové cestě.
To je správně — nemá smysl snižovat.

`travel_to`/`freeze_time` (13 výskytů v 12 souborech: 10× `spec/jobs`, `validator_spec`,
`qes_signing_values_spec`) nejsou čekání, jen deterministický čas. V pořádku.

### 6.2 E2E (Python) — poll, ne fixed sleep

| Místo | Co to je | Hodnocení |
|---|---|---|
| `scripts/qes_e2e.py:116–123` | `for _ in range(120): … time.sleep(2)` na `/up` | ✅ poll s limitem (max 240 s), ne fixed sleep |
| `scripts/qes_staging_e2e.py:60–67` | `range(60)` × `sleep(5)` na `/up` | ⚠️ funguje, ale 5s granularita; `sleep(1)` ušetří až 4 s na start |
| `scripts/qes_pdf_staging_e2e.py:49–56` | totéž | ⚠️ totéž |
| `scripts/qes_pdf_staging_e2e.py:168–174` | `range(60)` × `sleep(2)` na `completed` | ✅ poll, správně |
| `scripts/qes_staging_e2e.py:wait_for_completed` | `range(60)` × `sleep(2)` | ✅ poll, správně |

E2E skripty používají **bounded polling**, ne fixed sleep — to je správný vzor. Jediná
drobná optimalizace: `sleep(5)` → `sleep(1)` u staging `/up` (ušetří jednotky sekund,
ne minuty). Není to příčina pomalých testů.

## 7. Paralelizace

### 7.1 Co je ověřené bezpečné

Ověřeno experimenty na tomto stroji (4 workery = 4 kontejnery, každý vlastní DB soubor):

| Běh | Sekvenčně | 4 workery | Zrychlení |
|---|---:|---:|---:|
| QES sada (401 ex) | 98 s | **50 s** | **2,0×** |
| system specy (136 ex) | 227 s | **89 s** | **2,5×** |
| QES bez náhledů + 4 workery | 98 s | **64 s** | 1,5× (studený boot) |

Nulové nové failure (kromě dvou známých 2FA flaků v system).

Proč to funguje bez konfliktů:

- **Každý worker v jiném kontejneru = jiný network namespace.** `QesHelpers.with_crl_server`
  binduje `127.0.0.1:8765` a Capybara Puma server také port — ověřeno, že
  `dss_spec` + `lta_spec` v paralelních kontejnerech projdou oba.
- **Každý worker vlastní SQLite soubor** přes
  `PRIMARY_DATABASE_URL=sqlite3:/app/db/qes-test$N.sqlite3` a `SCHEMA=/app/tmp/qes-schema$N.rb`.
- `tmp/cache` (bootsnap) je bezpečný pro víc procesů (stejně jako produkční Puma).
- `public/packs-test` je jen pro čtení.

### 7.2 Kde to naopak nefunguje

| Problém | Projev | Řešení |
|---|---|---|
| Jeden SQLite soubor pro víc workerů | `SQLite3::BusyException: database is locked` (pozorováno při prvním pokusu) | vlastní DB soubor per worker |
| Dělení souborů round-robin | 85 s místo 50 s (worker 2 dostal 258 examples) | dělit podle naměřeného času, ne podle počtu souborů |
| Jeden soubor = jedna jednotka | `signing_form_spec.rb` 133 s drží podlahu plné sady | dělit `file:line`, nebo přesunout system specy z per-commitu |
| 20 workerů | 20× 1,68 GB image + Chromium; stroj je sdílený | strop 4–6 workerů |
| `parallel_tests` gem | přidá řádek do `Gemfile`/`Gemfile.lock` = dotek upstreamu | shell skript, žádná změna Gemfile |

### 7.3 Podlaha plné sady

Plná sada s 4 workery má **podlahu 133 s** v `spec/system/signing_form_spec.rb` — RSpec
nedělí jeden soubor mezi workery. Bez rozdělení toho souboru je 254–384 s → ~150 s maximum,
ne 96 s. Proto je **fáze 1 (tiering) důležitější než fáze 3 (paralelizace)**.

## 8. Plán optimalizace

> **Stav: implementováno 2026-10-27.** Naměřené výsledky před/po jsou v § 12; níže zůstává
> původní plán s čísly z doby auditu (sloupec „Před“).

Pořadí je zvolené podle poměru zisk/riziko. Každá fáze je samostatně ověřitelná.

### Fáze 1 — Tiering: `qes-test-qes` jako výchozí, plná sada jako gate (riziko: nulové)

Původně `DEVELOPMENT.md` říkal „`qes-test` před commitem forku“ — to je 4–6 min na každý commit.
Zavést tři tiery:

| Tier | Cíl | Kdy | Examples | Před |
|---|---|---|---:|---:|
| T0 | `make qes-test-qes` | po každé změně QES | 401 | 98 s |
| T1 | `make qes-test-fast` (bez `spec/system`) | před commitem | 510 | 157 s |
| T2 | `make qes-test` | před PR / rebase | 646 | 254–384 s |
| T3 | `make qes-test-postgres` | před vydáním | 650 | 290–350 s |

Očekávaný zisk: vnitřní smyčka 98 s místo 254–384 s. **Bez změny kódu testů.**

Riziko: T1 nezachytí regresi v system UI. Ta ale není QES a `signing_form_spec` v T2 ji
zachytí před PR.

### Fáze 2 — `previews: false` pro QES šablony (riziko: nízké, ověřeno)

**Implementováno jinak než v plánu:** místo transientu ve `spec/factories/templates.rb`
(upstream soubor) je stub `QesHelpers.without_page_previews` v `spec/support/qes_helpers.rb` —
nulový dotek upstreamu. Stubuje jen render PNG náhledů; `number_of_pages` se počítá dál.

Naměřeno: 404 examples, **0 failures** (`spec/requests/qes_documents_spec.rb:26` jde přes API
endpoint, ne přes factory, takže zůstává zelený), **42 s** místo 100 s.

Riziko: šablona bez `preview_images` attachmentu. QES specy čtou jen `number_of_pages`
(v `generate_pdf_preview_images`, které zůstává) a skutečné PDF dokumentu, ne náhledy. Ověřeno:
404/404 prošlo v plné sadě.

### Fáze 3 — Paralelní runner bez nového gemu (riziko: střední, ověřeno)

Shell skript `scripts/qes-test-parallel.sh` + `scripts/qes_test_groups.py`:

1. Rozdělí spec soubory do N skupin podle **naměřeného času** (`test/qes/timings.txt`,
   LPT bin packing) — round-robin podle počtu souborů dá jen 1,15×.
2. Soubory nad 45 s rozbalí po examplech (`file:řádek`), aby jeden soubor nedržel podlahu.
3. Pro každou skupinu spustí vlastní `podman run` s vlastní DB a `SCHEMA`.
4. `xargs`/`wait`, návratový kód = součet.

Naměřeno: T0 42 → **25 s**, T1 81 → **43 s**, T2 205 → **90 s**.

Riziko: paměť (4× 1,68 GB + Chromium). Strop 4–6 workerů. **Nepřidávat
`parallel_tests` do Gemfile** — byl by to dotek upstreamu.

### Fáze 4 — Cache RSA klíčů v helpers (riziko: nízké, ale s pastí)

152× RSA 2048 keygen × 42 ms = 6,4 s. V `QesHelpers` memoizovat na **třídní úrovni**
(ne per example) klíče pro `tsa_root`, `tsa` a `self_signed_qc_sscd`. Certy jsou v testech
jen testovací, takže sdílení mezi example je bezpečné — ale **pozor na platnost**:
`tsa_key_and_certificate` dnes staví cert s `not_after = Time.current + 3600`.

Past: `spec/lib/qes/validator_spec.rb:179` má `let(:later) { leaf.not_after + 3600 }`, tj.
`travel_to(Time.current + 7200)` — cachovaný TSA cert by byl po dvou hodinách **expirovaný**
a testy „po expiraci" by spadly. Při class-level cache proto `not_after` prodloužit
(stačí `+ 1.day`, běh sady je minuty) a znovu pustit `validator_spec`, `lta_spec`
(`self_signed_tsa_certificate` už cert kopíruje a přepodepisuje, což zůstává bezpečné).
Zisk je malý (6,4 s z 98 s) — má smysl až po fázích 1–3.

**Implementováno:** `TSA_KEYS` a `SELF_SIGNED_QC_SSCD` na úrovni modulu v `spec/support/qes_helpers.rb`;
TSA cert má `not_after = Time.current + 1.day`, self-signed cert se vrací jako **kopie**
(`revocation_pipeline_spec` ho přepodepisuje).

### Fáze 5 — Opravit dva 2FA flaky (riziko: nízké, ne čas)

Viz § 5.4. Nezkracuje běh, ale odstraní falešné červené, které nutí opakovat běh —
to je reálně nejvíc ztraceného času při vývoji.

**Implementováno:** root cause byl jinde než v plánu — `RateLimit::STORE` (proces-globální
`MemoryStore`) + recyklace `submitter.id` na SQLite → `RateLimit::STORE.clear` v `config.before`.
Navíc `travel_to(+20 s)` u re-sendu (15s okno). Ověřeno 16/16 běhů.

### Fáze 6 — Uzavřít mezery v rychlé smyčce (riziko: nulové)

`spec/requests/doc_ts_verification_spec.rb` je v globu `qes-test-qes` a `make qes-js-test`
je součástí T0 (33 testů, < 1 s).

## 9. Co nedělat

| Nápad | Proč ne |
|---|---|
| Smazat `spec/system` | Je to jediná obrana proti regresi při rebase v dotecích `generate_result_attachments`/`generate_audit_trail`; `upstream_contract_spec` chrání signatury, ale ne chování celého obřadu |
| Snížit `Capybara.default_max_wait_time` | Nezkrátí úspěšný běh (wait se použije jen při čekání), jen zvýší flaky |
| Odstranit `sleep 0.1` | Způsobí flaky v kreslení podpisu a uploadu; nejsou to zbytečné spánky |
| Přidat `parallel_tests` do Gemfile | Dotek upstreamu (`Gemfile`/`Gemfile.lock`), zbytečná cena rebase za ~2× zrychlení, které jde udělat skriptem |
| Přepnout `make qes-test` na Postgres | `qes-test-postgres` je paritní běh s upstream CI, ne rychlá smyčka; Postgres start je dalších ~10 s |
| Stubovat `Qes::Validator`/`Qes::Verifier` v QES specách | To je přesně to, co testují; ušetřilo by 31+27 ms z 98 s, tedy nic |
| Snížit `MAX_NUMBER_OF_PAGES_PROCESSED` v produkci kvůli testům | Mění produkční chování kvůli testovací rychlosti |

## 10. Mapování na dokumenty

- SPEC § 15.1 (harness), § 15.2 (negativní scénáře), § 14 (doteky upstreamu)
- `docs/18-audit-fork-vs-upstream.md` § 2.2 (doteky), § 5 (nálezy M19 — netestované doteky)
- `docs/20-audit-2026-10-27-opravy.md` (nálezy N5 — DocTS v upstream endpointech)
- `test/qes/README.md` (harness, past)
- `DEVELOPMENT.md` (tabulka cílů, § „Testy")

## 11. Ověřovací checklist po implementaci

```bash
make qes-test-qes            # T0: QES + JS
make qes-test-parallel       # T0 paralelně
make qes-test-fast           # T1: bez spec/system
make qes-test-parallel-fast   # T1 paralelně
make qes-test                # T2: celá sada
make qes-test-parallel-full   # T2 paralelně
make qes-test-postgres       # T3: parita s upstream CI
make qes-app-test            # appka (už paralelní)
make qes-app-typecheck
```

Po každé fázi znovu změřit `run_time` z JSON reportéru, ne wall clock (viz § 2).

## 12. Implementace (2026-10-27) a naměřené výsledky

Všechny fáze z § 8 jsou implementované. Čísla níže jsou měřená **před** a **po**
na stejném stroji, stejnou sadou examples.

| Fáze | Co je hotové | Kde |
|---|---|---|
| 1 — tiering | `qes-test-qes` (T0), `qes-test-fast` (T1), `qes-test` (T2), `qes-test-postgres` (T3); `pipefail` v Makefile | `Makefile`, `DEVELOPMENT.md`, `AGENTS.md` |
| 2 — `previews: false` | `QesHelpers.without_page_previews` stubuje jen render PNG náhledů, `number_of_pages` zůstává | `spec/support/qes_helpers.rb` |
| 3 — paralelní runner | `scripts/qes-test-parallel.sh` + `scripts/qes_test_groups.py` (LPT podle časů, dělení souborů po examplech) | `scripts/`, `test/qes/timings.txt` |
| 4 — cache RSA klíčů | `TSA_KEYS` a `SELF_SIGNED_QC_SSCD` na úrovni modulu, certifikát jako kopie | `spec/support/qes_helpers.rb` |
| 5 — 2FA flaky | `RateLimit::STORE.clear` per example + `travel_to(+20 s)` u re-sendu | `spec/support/qes_helpers.rb`, `spec/system/signing_form_spec.rb` |
| 6 — mezery v T0 | `doc_ts_verification_spec.rb` v QES globu, `qes-js-test` součástí T0 | `Makefile` |

Naměřeno (2026-10-27, 404 examples v QES vrstvě):

| Běh | Před | Po | Zrychlení |
|---|---:|---:|---:|
| QES sekvenčně (`qes-test-qes`) | **100,3 s** | **42,2 s** | **2,4×** |
| QES paralelně 4 workery | — | **25 s** | **4,0×** |
| T1 bez `spec/system` | 157 s | **81 s** | 1,9× |
| T1 paralelně 4 workery | — | **43 s** | 3,7× |
| T2 celá sada | **211–384 s** | **205 s** | 1,8× |
| T2 paralelně 4 workery | — | **90 s** | **2,3×** |

Konkrétní dopad (run_time per soubor, stejný stroj):

| Soubor | Před | Po |
|---|---:|---:|
| `spec/lib/qes/chain_spec.rb` | 15,9 s | 4,5 s |
| `spec/lib/qes/verifier_spec.rb` | 11,2 s | 4,6 s |
| `spec/lib/qes/validator_spec.rb` | 8,1 s | 4,3 s |
| `spec/lib/qes/revocation_pipeline_spec.rb` | 12,9 s | 3,2 s |
| `spec/requests/qes_sessions_spec.rb` | 14,2 s | 5,4 s |
| `spec/system/signing_form_spec.rb` | 133,0 s | 60,7 s |

Co se neudělalo a proč:

- **`previews: false` jako transient ve `spec/factories/templates.rb`** — factory je upstream soubor;
  místo toho stub v `spec/support/qes_helpers.rb` (nulový dotek upstreamu).
- **`parallel_tests` gem** — přidal by řádek do `Gemfile`/`Gemfile.lock` (dotek upstreamu);
  shell runner dělá totéž.
- **Rozdělení `spec/system/signing_form_spec.rb` do souborů** — to je upstream soubor; runner
  ho dělí po examplech (`file:řádek`), takže zůstává netknutý.
- **`spec/system` v T0/T1** — zůstává jen v T2, protože je to jediná obrana proti
  regresi doteků `generate_result_attachments`/`generate_audit_trail` při rebase.

Nový nález při implementaci (nebyl v původním auditu): **`RateLimit::STORE` je
proces-globální `MemoryStore`** a SQLite recykluje `submitter.id` po rollbacku → počítadla
rate limitu se sčítají napříč example. To byl skutečný root cause 2FA flaky, ne `sidekiq: :inline`
(viz § 5.4). Oprava je `RateLimit::STORE.clear` v `config.before`.

Také opraveno: `make qes-test*` dřív maskoval červený RSpec, protože `rspec … | tee`
bere exit kód z `tee`. Nově `SHELL := /bin/bash` + `.SHELLFLAGS := -o pipefail -c`.

