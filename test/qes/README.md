# QES test harness (P0.2)

Ověřený postup, jak spustit RSpec forku bez Postgresu i s ním, a jak ho zrychlit.
Vše níže je **změřené**, ne odhad (poslední měření 2026-10-27, audit a optimalizace:
[docs/21-audit-testu.md](../docs/21-audit-testu.md)).

## Image

```bash
make qes-test-images    # postaví oba image
make qes-test-assets    # zkopíruje buildnuté assety z produkčního image (gitignored)
```

| Image | Dockerfile | Obsah |
|---|---|---|
| `dokulachtan-qes-test` | `test/qes/Dockerfile` | `docuseal:latest` + dev/test gemy (Ruby 4.0.5, `libpdfium.so` z image) |
| `dokulachtan-qes-system-test` | `test/qes/Dockerfile.system` | totéž + `chromium` (capybara/cuprite pro `spec/system`) |

Produkční image má `BUNDLE_WITHOUT=[:development, :test]`, proto se dev/test gemy doinstalovávají
(`BUNDLE_WITHOUT='' bundle install`). Repo forku se mountuje na `/app` (image má vlastní `/app`).

## Tiery: co kdy pouštět

| Tier | Cíl | Co to je | Kdy |
|---|---|---|---|
| **T0** | `make qes-test-qes` | QES vrstva (404 ex) + JS testy kroku | po každé změně QES vrstvy |
| **T0** | `make qes-test-parallel` | totéž, 4 workery | když potřebuješ T0 rychleji |
| **T1** | `make qes-test-fast` | celá sada bez `spec/system` (511 ex) | před commitem forku |
| **T1** | `make qes-test-parallel-fast` | totéž paralelně | před commitem, když spěcháš |
| **T2** | `make qes-test` | celá sada kromě `spec/system/dashboard_spec.rb` (647 ex) | před PR / po rebase |
| **T2** | `make qes-test-parallel-full` | totéž paralelně (potřebuje system image) | před PR, když spěcháš |
| **T3** | `make qes-test-postgres` | celá sada na Postgresu 18 (651 ex) | před vydáním, parita s upstream CI |

Proč tři tiery: **69 % času plné sady jde na upstream specy, které fork nemodifikuje**
(243 ex / 265,7 s z 384,1 s), a `spec/system/signing_form_spec.rb` sám je 35 % sady.
Denní smyčka QES je T0, plná sada patří k PR a rebase.

## Paralelní běh

```bash
make qes-test-parallel                      # QES vrstva, 4 workery
make qes-test-parallel-fast                   # bez spec/system
make qes-test-parallel-full                   # celá sada
QES_PARALLEL_WORKERS=6 make qes-test-parallel # víc workerů (strop ~6, viz níže)
./scripts/qes-test-parallel.sh --dry-run -g full # jen vypíše rozdělení
```

`scripts/qes-test-parallel.sh`:

- **každý worker = vlastní kontejner** s vlastní SQLite DB
  (`PRIMARY_DATABASE_URL=sqlite3:/app/db/qes-parallel-N.sqlite3`) a vlastním `SCHEMA` dumpem;
- **dělení podle naměřených časů** (`test/qes/timings.txt`), ne podle počtu souborů:
  round-robin podle souborů dá 1,15×, LPT podle časů ~2×;
- **soubory nad 45 s se dělí po examplech** (`spec/…:řádek`), aby jeden soubor nedržel
  podlahu — `signing_form_spec.rb` (48 ex) se tak rozdělí mezi workery;
- `test/qes/timings.txt` se regeneruje `make qes-test-timings` (jeden sekvenční běh
  s JSON reportem), po velké změně skladby speců.

Proč to jde bez konfliktů: každý kontejner má **vlastní network namespace**, takže
`QesHelpers.with_crl_server` (`127.0.0.1:8765`) ani Capybara Puma port si nekonkurují
(ověřeno: `dss_spec` + `lta_spec` paralelně, 4 system workery paralelně).

Bez `parallel_tests` gemu: ten by přidal řádek do `Gemfile`/`Gemfile.lock`, což je dotek
upstreamu (`docs/08`, `docs/18`). Shell runner dělá totéž bez změny Gemfile.

## Změřené výsledky

Naměřeno 2026-10-27 (20 CPU, sdílený stroj; `run_time` z JSON reportéru):

| Běh | DB | Výsledek | Čas |
|---|---|---|---|
| `make qes-test-qes` | SQLite | 404 ex, 0 failures | **43 s** (+ JS 0,2 s) |
| `make qes-test-parallel` | SQLite ×4 | 404 ex, 0 failures | **25 s** |
| `make qes-test-fast` | SQLite | 511 ex, 0 failures | **81 s** |
| `make qes-test-parallel-fast` | SQLite ×4 | 511 ex, 0 failures | **43 s** |
| `make qes-test` | SQLite | 647 ex, 0 failures | **3 min 20 s** |
| `make qes-test-parallel-full` | SQLite ×4 | 647 ex, 0 failures | **90 s** |
| `make qes-test-postgres` | Postgres 18 | 651 ex, 0 failures | 3 min 37 s |
| `make qes-js-test` | — | 33 ex, 0 failures | 0,2 s |
| `make qes-app-test` | — | 212 ex, 0 failures | 13 s |

Před optimalizacemi (docs/21) byl `qes-test-qes` **100 s** pro 404 examples; dnes
**43 s** sekvenčně a **25 s** paralelně, tedy **4×**.

## Co testy zdržuje a co s tím

| Příčina | Řešení | Úspora |
|---|---|---|
| PNG náhledy stránek v `create(:template)` = 97 % ceny šablony (218–644 ms → 17 ms) | `QesHelpers.without_page_previews` stubuje jen render náhledů; `number_of_pages` zůstává | ~58 s z QES sady |
| 152× RSA 2048 keygen (42 ms) v `QesHelpers` | klíče cachované na úrovni modulu (`TSA_KEYS`, `SELF_SIGNED_QC_SSCD`), certifikát se vrací jako kopie | ~6 s |
| Jeden velký spec soubor drží podlahu | dělení po examplech (`file:řádek`) v paralelním runneru | `signing_form_spec` 60 s → 4× ~15 s |
| `rspec … \| tee` maskoval exit kód | `SHELL := /bin/bash` + `.SHELLFLAGS := -o pipefail -c` v Makefile | — (správnost) |

## Známé rozdíly proti Postgresu

1. `spec/system/dashboard_spec.rb:53` („searches be submitter email“) — fulltext search. Na SQLite
   tabulka `search_entries` **neexistuje** (migrace `create_search_enties.rb:7` je guardovaná
   `return unless adapter_name == 'PostgreSQL'`) a `SearchEntries.reindex_all` nemá guard
   (`lib/search_entries.rb:10-14`) → `NoMethodError`. V `make qes-test` je proto celý soubor vyloučen.
2. `spec/system/signing_form_spec.rb:1253` (2FA resend) byl upstream flake: `ActionMailer::Base.deliveries.last`
   bylo `nil`, protože `SubmitFormEmail2fasController#update` odmítne re-send dřív než 15 s po předchozím
   odeslání a spec na to nesynchronizovala. **Opraveno 2026-10-27** (`travel_to(+20 s)` + `change.by(1)`
   na obou odesláních); 16/16 běhů zelených.

QES vrstva (P0.3+) tyto rozdíly neovlivňuje: nové specy jsou unit/request a `QesSession` používá
jen `t.binary`/`text`/`serialize` + `LockEvent` (`unique: connection.supports_partial_index?`).

## Pasti, na které se narazilo

| Past | Co se stane | Řešení |
|---|---|---|
| `DATABASE_URL=sqlite3:…` | `database.yml` `production:` sekce je pro sqlite URL prázdná → `InvalidConfigurationError` (`database_configurations.rb:261`) | použít **`PRIMARY_DATABASE_URL`** (`environment_value_for` zkusí `PRIMARY_DATABASE_URL` první, `database.yml` zůstane validní) |
| DB v `/tmp` | každý `podman run` má čerstvý `/tmp` → `check_pending_migrations` spadne | DB do repa: `sqlite3:/app/db/qes-test.sqlite3` (gitignored `/db/*.sqlite3`) |
| `db:schema:load` | `db/schema.rb` je Postgres dump (`btree_gin`, `t.tsvector`, `using: :gin`) | jen `db:migrate`; `SCHEMA=/app/tmp/qes-test-schema.rb` (gitignored `/tmp/*`) → `db/schema.rb` zůstane čistý |
| assety pro `spec/system` | shakapacker `compile: true` by chtěl `node_modules` | `make qes-test-assets` (kopie `public/packs` z produkčního image → `public/packs-test`) |
| `podman run -u $(id -u)` | rootless podman mapuje roota na host uid, ne na 1001 | `-u` nepoužívat (root v kontejneru = host uživatel) |
| `bundle exec rspec` v image | image má `BUNDLE_WITHOUT=development:test` | test image z `test/qes/Dockerfile` |
| `--out /tmp/rspec.json` | `/tmp` je v kontejneru, ne na hostu → soubor se ztratí | `--out /app/tmp/rspec.json` (mountované) |
| víc workerů na jedné SQLite | `SQLite3::BusyException: database is locked` | vlastní DB soubor per worker (`qes-parallel-N.sqlite3`) |

## Mapování na dokumenty

- SPEC § 15.1 (harness), § 22 (kompatibilita), PLAN 0.2 (SQLite) a 0.2b (Postgres parita),
  AGENTS #12.
- `docs/21-audit-testu.md` (naměřené časy, tiery, paralelizace), `DEVELOPMENT.md` (přehled cílů).
