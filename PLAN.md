# PLAN.md — implementační plán dokulachtan (v1)

Datum: 2026-10-15
Vychází z: [DESIGN.md](DESIGN.md) (závazný koncept), [SPEC.md](SPEC.md) (odvozená detailní specifikace),
[docs/08](docs/08-fork-workflow.md).

Cíl: dodat **finální PDF v DocuSealu s platným podpisem podepisujícího** (AdES/QES), ověřené
nezávislým validátorem, a to pro variantu **B** (telefon) i **A** (eObčanka) — bez toho, aby klíč
opustil zařízení.

## Pravidla práce

- **TDD**: nejdřív test (RSpec / Jest / e2e skript), pak implementace.
- **Malé commity**: Conventional Commits; každý zásah do upstream souboru vlastní commit (max. 10 řádků).
- **Větev**: `dokulachtan` ve forku (`vendor/docuseal`), lineární historie, rebase na upstream.
- **Jeden krok = jedna ověřitelná změna**; po každém kroku `make qes-test` (nebo cílený test).
- **Nic se nenasazuje na produkci**; staging až v poslední fázi.
- **Všechny nové soubory** v `app/lib/qes/`, `app/models/qes_session.rb`, `app/controllers/qes/`,
  `app/jobs/qes/`, `app/views/qes/`, `mobile/app/`; upstream jen dle tabulky v SPEC § 14.

## Mapa fází

| Fáze | Obsah | Výstup |
|---|---|---|
| **P0** | Příprava: fork sync, RSpec harness, QES fixtures, Make cíle | `make qes-test` zelené |
| **P1** | Model + stavový automat + token | `QesSession` s testy |
| **P2** | Kryptografie: TBS → CMS → embed → LTV → validace → pečeť | `Qes::*` moduly s testy |
| **P3** | API + integrace do DocuSealu + frontend krok | e2e „API → podpis → PDF“ |
| **P4** | Expo appka B: obrazovky, vault, podpis | APK podepíše dokument |
| **P5** | Expo appka A: MOI SDK, čtečky, kontejnery, QPIN | QES z eObčanky |
| **P6** | E2E, negativní testy, staging, dokumentace | akceptační kritéria SPEC § 15.4 |
| **P7** | Vícenásobné digitální podpisy (firemní podpisy): pořadí + řetězení revizí + e2e se 2 podpisy | `make qes-e2e-two` zelené, SPEC § 4.6 a § 15.2 |
| **P8** | Přímý podpis PDF nativním tokem: upload → náhled → pečeť → obřad → PDF v účtu (+ sdílení PDF do appky) | `make qes-e2e-pdf` zelené, docs/15 |

## Stav implementace (2026-10-29)

| Fáze | Stav | Důkaz |
|---|---|---|
| P0 | **hotová** | `make qes-test` (659/0), `make qes-test-postgres` (660/0), runbook `test/qes/README.md` |
| P1 | **hotová** | `spec/models/qes_session_spec.rb` (5), `spec/lib/qes/token_spec.rb` (3), `Qes::SessionManager` |
| P2 | **hotová** | `spec/lib/qes/pipeline_spec.rb` (9): TBS, signed attrs, CMS, LTV, validace, pečeť |
| P3 | **hotová** | `make qes-e2e` zelené: `qes-signed.pdf` = `INTACT:TRUSTED,UNTOUCHED`, `qes-final.pdf` = 3 signatury |
| P4 | **hotová** (appka `mobile/app`: vault, P12, softwareSigner, api, signer, deep link, obrazovky, `make qes-app-test`) | `make qes-e2e` podepisuje KÓDEM APPKY (`src/lib/*`), `biometric_prompts: 1` |
| P5 | **stub** (`StubCardSigner` + `FakeCardSigner`); MOI SDK / reálná čtečka mimo rozsah | `src/lib/cardSigner.ts` |
| P6 | **hotová** — `qes-e2e`, `qes-e2e-two`, `qes-negative`, `qes-staging-e2e` | `test/out/qes-negative-report.txt`, `test/out/qes-staging-e2e-report.txt` |
| P7 | **hotová** — pořadí, řetězení TBS, validace všech signatur; `make qes-e2e-two` zelené (6 signatur) | `test/out/qes-e2e-two-report.txt` |
| P8 | **hotová** (nativní tok, přepsáno 2026-10-18) — přímý podpis PDF: šablona s polem `qes` + submission; sdílení PDF ze share sheetu (Android, „Podepsat PDF“); `make qes-test-qes` 422/0, `make qes-e2e-pdf` (3 signatury, pečeť v místě klepnutí), `make qes-negative` N1–N17, ověřeno i na emulátoru | `test/out/qes-pdf-e2e-report.txt`, `test/out/qes-negative-report.txt` |


---

## Phase 0: Příprava a testovací harness

Cíl: mít místo, kde se dá bezpečně vyvíjet — fork je synchronizovaný, testy běží, fixtures existují.

- [ ] 0.1 `make fork-setup` + kontrola `vendor/docuseal` na větvi `dokulachtan`, `git status` čistý
      → verify: `git -C vendor/docuseal rev-parse HEAD` == `vendor/docuseal.rev` (pin = HEAD forku)
- [ ] 0.2 Připravit reálný test harness na **SQLite** (parita se stagingem, DB-agnostický kód dle § 22):
      test image `test/qes/Dockerfile` (`docuseal:latest` + dev/test gemy; Ruby 4.0.5 i `libpdfium.so`
      už v image jsou) a system image `test/qes/Dockerfile.system` (+ `chromium`); `PRIMARY_DATABASE_URL=sqlite3:db/qes-test.sqlite3`
      (POZOR: `DATABASE_URL=sqlite3:…` **neprojde** — `database.yml` `production:` sekce je pro sqlite URL prázdná
      → `InvalidConfigurationError`; `PRIMARY_DATABASE_URL` yml nechá validní), `SCHEMA=tmp/qes-test-schema.rb`
      (gem default `dump_schema_after_migration = true`; `production.rb:127` ho vypíná jen v produkci → bez toho
      by `db:migrate` přepsal `db/schema.rb`), `make qes-test-assets` (kopie `public/packs` z produkčního
      image → `packs-test`, pro `spec/system`), `bundle exec rake db:create db:migrate`
      (na SQLite nelze `db:schema:load`; 3 Postgres-specific migrace jsou guardované)
      → verify: `make qes-test` = **243 examples, 1 failure** (upstream flake `signing_form_spec.rb:1253`,
      izolovaně projde) a `git -C vendor/docuseal status` čistý; `make qes-test-qes` po P0.3
- [ ] 0.2b (paritní běh) Postgres 18 jako v upstream CI (`.github/workflows/ci.yml:111-169`):
      `scripts/qes-test-postgres.sh` (podman síť se statickou IP, CNI bez DNS pluginu),
      `PRIMARY_DATABASE_URL=postgresql://postgres:postgres@10.89.98.2:5432/qes_test_db`, celá sada
      → verify: `make qes-test-postgres` = **247 examples, 0 failures** (změřeno 2026-10-16)
- [ ] 0.3 Přidat `spec/lib/qes/` skeleton a RSpec helper `spec/support/qes_helpers.rb` (test PKCS#12,
      QCStatements fixtures, `Qes::TestPki`)
      → verify: `bundle exec rspec spec/lib/qes` projde (i s prázdnými testy)
- [ ] 0.4 Fixtures už QCStatements mají (`scripts/make_test_pki_crl.py:24-28,102-104`; `test/certs/pki/signer-ades.crt`,
      `signer-qscd.crt`) — doplnit jen PKCS#12 pro e2e/appku: `signer-ades.p12` a `signer-qscd.p12`
      (heslo `test`, s řetězem `root.crt`) a ověřit, že bez QCStatements vrátí server `422 not_qualified`
      → verify: `make negative` zelené + `openssl pkcs12 -in test/certs/pki/signer-ades.p12 -nokeys` vypíše QCStatements
- [ ] 0.5 Přidat Make cíle do kořenového `Makefile`: `qes-test-images`, `qes-test-assets`, `qes-test`
      (SQLite, celá sada kromě `spec/system/dashboard_spec.rb`), `qes-test-postgres` (Postgres 18, celá sada),
      `qes-test-qes` (jen QES vrstva), `qes-e2e`, `qes-fixtures`; runbook `test/qes/README.md`
      → verify: `make qes-test` projde (i když testy zatím prázdné)
- [ ] 0.6 Založit `docs/10-qes.md` s runbookem (ENV, TSA, trust roots včetně `test/certs/pki/root.crt`,
      troubleshooting, jak spustit harness z 0.2)
      → verify: dokument existuje a je odkazovaný z README

**⏸️ Checkpoint 0**: `make verify` + `make qes-test` zelené, fork se dá rebasovat (`git rebase upstream/master`
bez konfliktů). Teprve pak kód.

> Skeleton `app/lib/qes/provider.rb` v P0 přepsat podle dvoukrokového protokolu (SPEC § 16 #1/#4) — viz 2.10.

---

## Phase 1: Model a stavový automat

Cíl: `QesSession` + přechody + token, bez kryptografie. Testy first.

- [ ] 1.1 Migrace `db/migrate/*_create_qes_sessions.rb` dle SPEC § 4.2 (+ `has_one_attached`)
      → verify: `bundle exec rails db:migrate` projde, `QesSession.column_names` odpovídá SPEC
- [ ] 1.2 Model `app/models/qes_session.rb`: `belongs_to`, enum stavů, scopes `active`, `completed`,
      validace (`field_uuid` typu `qes`, `expires_at` v budoucnosti)
      → verify: `spec/models/qes_session_spec.rb` — validace, scopes (SPEC § 19)
- [ ] 1.3 Stavový automat `Qes::SessionManager` (SPEC § 4.3): `prepare!`, `open!`, `attach_certificate!`,
      `sign!`, `embed!`, `validate!`, `complete!`, `fail!`, `cancel!`, `expire!`; každý zapíše čas + stav;
      zakázané přechody vyhodí `Qes::InvalidTransition`
      → verify: `spec/lib/qes/session_manager_spec.rb` — všechny přechody + zakázané přechody
- [ ] 1.4 Token: `Qes::Token.generate` (43 znaků), `Qes::Token.digest` (sha256), `Qes::Token.find(token)`,
      TTL z `QesSession.expires_at`; `used_token?` dle stavu
      → verify: `spec/lib/qes/token_spec.rb` — digest, expirace, jednorázovost
- [ ] 1.5 „Nejvýše 1 aktivní session na submittera“: `QesSession.active_for(submitter)`; nové volání
      zruší předchozí (`cancel!`) v transakci
      → verify: `spec/models/qes_session_spec.rb` — 2× `POST` → první `cancelled`
- [ ] 1.6 `Qes::ExpireSessionsJob` (`active` → `expired`); bez `sidekiq-cron` (žádná nová závislost):
      inicializér při bootu zařadí první běh a job se na konci sám přeplánuje `perform_in(QES_EXPIRY_JOB_INTERVAL)`;
      duplicity po restartu vylučuje idempotentní klíč `qes_expire_sessions` přes `LockEvent`
      → verify: `spec/jobs/qes/expire_sessions_job_spec.rb` — expirace, neaktivní session se nedotkne,
      po dvou zařazeních nevznikne druhá smyčka
- [ ] 1.7 (TDD) hodnota pole: `QesSession#value_token` = `"qes:<id>"`; `complete!` nastaví
      `submitter.values[field_uuid]` v transakci
      → verify: `spec/models/qes_session_spec.rb` — hodnota je nastavena po `complete!`

**⏸️ Checkpoint 1**: model + stavy + token zelené, `git log` má 4–6 commitů `feat(qes): …`.
Bez kryptografie. **Zkontrolovat, že se nic nezměnilo v upstream souborech** (`git diff --stat upstream/master..HEAD`).

---

## Phase 2: Kryptografická pipeline

Cíl: TBS → signed attrs → raw signatura → CMS → embed → TSA → LTV → validace → pečeť. Vše pokryté testy
s fixtures z `test/certs/`. Nové moduly v `app/lib/qes/`, testy v `spec/lib/qes/`.

- [ ] 2.1 `Qes::CertificateInfo` (SPEC § 8): parse DER certifikátu (`OpenSSL::X509::Certificate`),
      QCStatements OID `0.4.0.1862.1.1`/`0.4.0.1862.1.4`, `keyUsage`, platnost, key type/size
      → verify: `spec/lib/qes/certificate_info_spec.rb` — AdES/QES/none, expirace, keyUsage
- [ ] 2.2 `Qes::TbsDocument.build(submitter, field)` (SPEC § 7.1): spojení `schema_documents`, podpisové
      pole `Sig1` na pozici `qes` pole, rezerva `QES_SIGNATURE_RESERVE`, `external_signing` vrací placeholder CMS
      → verify: `spec/lib/qes/tbs_document_spec.rb` — PDF má `Sig1`, `/ByteRange` pokrývá vše, `/Contents` má rezervu
- [ ] 2.3 `Qes::PlaceholderSignedDataCreator` (SPEC § 7.2): zachytí `signed_attrs_der`, vrátí placeholder
      → verify: `spec/lib/qes/cms_builder_spec.rb` — `signed_attrs_der` je DER `SET`, deterministický při stejném `signing_time`
- [ ] 2.4 `Qes::CmsBuilder.prepare` (SPEC § 7.2): `create(data, type: :pades, certificate:, certificates:, signing_time:, digest_algorithm:)`;
      `Qes::PlaceholderSignedDataCreator` přepíše i `create_signed_attrs` a **vynutí `signing-time`**
      (HexaPDF 1.7 ho u `:pades` nepřidá)
      → verify: `openssl cms -cmsout -print` nad CMS: atributy včetně `signingTime` + `message-digest` = SHA-256 ByteRange
- [ ] 2.5 `Qes::CmsBuilder.complete` (SPEC § 7.3): `external_signing` vrátí raw signaturu z appky,
      ověří byte-identical `signed_attrs_der`, TSA token jako unsigned attr
      → verify: `spec/lib/qes/cms_builder_spec.rb` — nová `signed_attrs_der` se rovná uložené; s TSA (FreeTSA) je token přítomen
- [ ] 2.6 `Qes::Embed.embed(tbs_bytes, cms_der)` (SPEC § 7.3): `HexaPDF::DigitalSignature::Signing.embed_signature`,
      výstup = PDF, který pyHanko označí `INTACT:TRUSTED` (s test rootem) a `pdfsig` „Total document signed“
      → verify: `spec/lib/qes/embed_spec.rb` + `pyhanko` nad fixture; `qpdf --check` bez chyb
- [ ] 2.7 `Qes::Ltv.add_revocation_values` (SPEC § 7.4): OCSP z AIA (fallback CRL z CRLDistributionPoints),
      `id-aa-ets-revocationValues` do CMS, chybějící intermediates do `certificates`
      → verify: `spec/lib/qes/ltv_spec.rb`; offline `pyhanko validate` (bez `--fetch`) → `trusted=True`
- [ ] 2.8 `Qes::Validator.call` (SPEC § 7.5): Pdfium (`VerifyPdfSignature`) + pokrytí + úroveň + digest
      → verify: `spec/lib/qes/validator_spec.rb` — platný/tamper/neúplné pokrytí
- [ ] 2.9 `Qes::Seal.apply` (SPEC § 7.6): druhá inkrementální signatura pečeti DocuSealu
      → verify: `spec/lib/qes/seal_spec.rb` — 2 signatury, první `INTACT`, druhá pokrývá celý soubor
- [ ] 2.10 `Qes::Providers::MobileApp` + `Qes::Providers::Mock` (SPEC § 16): implementace **dvoukrokového**
      rozhraní (`prepare` → `data_to_sign(certificate)` → `build_cms(signature)` → `embed` → `validate`);
      skeleton `app/lib/qes/provider.rb` přepsat (odstranit `Pkcs11`/`P12` a `level`/`key_location` z providera)
      → verify: `spec/lib/qes/providers_spec.rb` — celý řetěz s mock providerem bez sítě

**⏸️ Checkpoint 2**: celý kryptografický řetěz funguje v testech bez serveru (unit) i s fixturemi.
Spustit `make qes-test`. Pokud cokoli padá, **nestartovat fázi 3**.

---

## Phase 3: API a integrace do DocuSealu

Cíl: browser ↔ server ↔ appka přes HTTP; finální PDF v DocuSealu.

- [ ] 3.1 `config/routes.rb` (SPEC § 14): `resources :qes_sessions, only: %i[create show]` pod `/s/:slug`,
      `post :cancel`, routes pro `/qes/sessions/:token` a `/qes/app`
      → verify: `bundle exec rails routes | grep qes` odpovídá SPEC § 6
- [ ] 3.2 `Qes::FormSessionsController#create` (SPEC § 6.1): autorizace `Submitters::AuthorizedForForm`,
      `field_uuid` typu `qes`, zrušení předchozí aktivní session, vytvoření nové, token jen v odpovědi
      → verify: `spec/requests/qes_form_sessions_spec.rb` — 201, token, `field_uuid` cizího submittera → 404
- [ ] 3.3 `Qes::SessionsController#show/complete/abort` (SPEC § 5): token → session, `certificate`,
      `complete`, `abort`; rate limiting; idempotence
      → verify: `spec/requests/qes_sessions_spec.rb` — 200/404/410/422/429 dle SPEC § 5.6
- [ ] 3.4 `Qes::FormSessionsController#show` (polling, SPEC § 6.2) a `#cancel` (SPEC § 6.3)
      → verify: `spec/requests/qes_form_sessions_spec.rb` — stavy, `value`, `error`
- [ ] 3.5 `Qes::AppController#show` (SPEC § 6.4): fallback HTML s QR, bez citlivých dat
      → verify: `spec/requests/qes_app_spec.rb` — 200, QR odkaz, žádný `data_to_sign`
- [ ] 3.6 `Qes::ResultAttachments.call` (SPEC § 7.7) + `has_many :qes_sessions` na `Submitter` +
      hook v `generate_result_attachments.rb`
      → verify: `spec/lib/submissions/generate_result_attachments_spec.rb` — QES submission → `documents` = podepsané PDF
- [ ] 3.7 Hook v `generate_combined_attachment.rb` `call` (SPEC § 7.7) — pro QES vrátit kopii `final_document`
      **bez** `sign_pdf` (jinak vznikne třetí signatura); auditní stránka zůstává v `audit_trail`
      → verify: `spec/lib/submissions/generate_combined_attachment_spec.rb` — combined neimportuje stránky a má 2 signatury
- [ ] 3.8 `Qes::AuditPage.append` + hook v `generate_audit_trail.rb` (SPEC § 13)
      → verify: `spec/lib/submissions/generate_audit_trail_spec.rb` — audit obsahuje QES stránku
- [ ] 3.9 Přeskočit `qes` pole ve `fill_submitter_fields` (ř. 215) a v `_value.html.erb` (ř. 9 — **`return`**,
      ne `next`: partial se kompiluje do `def`)
      → verify: render PDF nemá text `qes:`; `_value` partial nespadne
- [ ] 3.10 `QesStep` ve `form.vue` (ř. 487) + `QesStep.vue`: tlačítko, QR, polling, stavy, auto-submit
      dle SPEC § 6.5 (fáze, texty, přístupnost, dry-run, native)
      → verify: `npx jest` (unit), manuální test na `/s/:slug` s dry-run
- [ ] 3.11 Typ pole `qes` v builderu (`field_type.vue` ř. 142 `fieldIcons` + `fieldNames` + `skipTypes`, i18n;
      `builder.vue` ř. 1176 je jen definice propu — no-op)
      → verify: v builderu lze přidat `qes` pole, uloží se do `fields`
- [ ] 3.12 `public/.well-known/assetlinks.json` (statika) + `Qes::WellKnownController` pro AASA
      s `Content-Type: application/json` (SPEC § 6.6, 7.7)
      → verify: `curl -i https://dokulachtan.fly.dev/.well-known/assetlinks.json` → 200 JSON;
      `curl -i .../apple-app-site-association` → `Content-Type: application/json`
- [ ] 3.13 `Qes::ValueValidator` + hook v `lib/submitters/submit_values.rb` `validate_values!` (SPEC § 4.4)
      — hodnota `qes` pole smí být jen `"qes:<id>"` s `completed` session téhož submittera
      → verify: `spec/lib/qes/value_validator_spec.rb` — podvržená hodnota → `ValidationError`
- [ ] 3.14 Validace šablony `validate :qes_single_signer_only` v `app/models/template.rb` (SPEC § 4.1)
      → verify: `spec/models/template_spec.rb` — `qes` pole + >1 podepisující → chyba
      (v P7.1 nahrazeno validací `qes_signing_order` — vícenásobní signeři)
- [ ] 3.15 `Submitter#with_signature_fields?`: přidat `qes` do `signature_field_types` (e-maily/UI)
      → verify: `spec/models/submitter_spec.rb` — šablona jen s `qes` → `with_signature_fields?` je `true`

**⏸️ Checkpoint 3**: `make qes-e2e` (server + simulovaná appka v Pythonu) — finální PDF má
platný podpis a pečeť, audit má QES stránku. Toto je **hlavní důkaz řetězu**.

---

## Phase 4: Expo appka — varianta B (telefon)

Cíl: reálná appka podepíše dokument klíčem z PKCS#12 v telefonu.

- [ ] 4.1 Založit `mobile/app` (Expo, TypeScript, `expo-router`) + `app.json` s `scheme: dokulachtan`,
      `android.intentFilters` (App Links) a `EXPO_PUBLIC_API_URL`
      → verify: `npx expo start` + `npx expo run:android` na emulátoru
- [ ] 4.2 S1 Home + S7 Nastavení + `api.ts` (QES klient: `getSession`, `postCertificate`, `postComplete`)
      → verify: Jest unit `api.ts` (chyby 404/410/422/429), obrazovky v emulátoru
- [ ] 4.3 S2 Import: `expo-document-picker` → PKCS#12, heslo, `node-forge` parse, kontrola klíče+certu
      → verify: Jest `p12.test.ts` (platný, špatné heslo, bez klíče), manuálně na emulátoru
- [ ] 4.4 `vault.ts`: AES-256-GCM + `expo-secure-store` + `expo-local-authentication`; import
      dešifruje PKCS#12 heslem a klíčový materiál **ihned přešifruje** vault klíčem (heslo se zahodí)
      → verify: Jest round-trip; **při podpisu se heslo nevyžaduje** (jen biometrie); po restartu
      appky se klíč odemkne biometrií
- [ ] 4.5 S3 Detail certifikátu + úroveň z QCStatements (`level.ts`)
      → verify: Jest `level.test.ts`; UI zobrazí AdES/QES
- [ ] 4.6 S4 Žádost o podpis: deep link → `GET /qes/sessions/:token` → zobrazení metadat + hashe
      → verify: manuálně s reálným tokenem ze serveru; chybové stavy dle SPEC § 9.6
- [ ] 4.7 S5 Biometrie + `softwareSigner.ts` (`node-forge`
      `privateKey.sign(forge.md.sha256.create().update(data_to_sign))`, `RSASSA-PKCS1-V1_5`; `pki.rsa.sign` neexistuje)
      → verify: Jest `signer.test.ts` (fixture PKCS#12 → signatura ověřitelná `cryptography`)
- [ ] 4.8 `POST /complete` + S6 Výsledek + mazání klíče z paměti
      → verify: server vrátí `state: completed`; klíč v paměti je `null`
- [ ] 4.9 Universal links: `assetlinks.json` (Android) + ověření otevření appky z HTTPS odkazu
      → verify: `adb shell am start -a android.intent.action.VIEW -d "https://<host>/qes/sign?token=…"` otevře appku
- [ ] 4.10 Chybové stavy appky (SPEC § 9.6) + retry/backoff + expirace
      → verify: manuálně: vypnutá síť, expirovaný token, chybný cert
- [ ] 4.11 `signer.ts` + S10 wizard (SPEC § 9.8): **automatická** volba podepisujícího (pro QES čtečka,
      pro AdES klíč → čtečka → wizard); kontrola `level_required` proti lokálnímu certu; wizard nabídne
      import klíče / nastavení čtečky
      → verify: Jest `signer.test.ts` (pět stavů konfigurace × úroveň pole); manuálně S4 → S10 → S4
- [ ] 4.12 Anglické texty (`mobile/app/src/i18n/en.ts`) se stejnými klíči jako příloha D (SPEC § 21)
      → verify: aplikace v `en` zobrazí všechny obrazovky bez chybějícího klíče

**⏸️ Checkpoint 4**: `make qes-e2e-app` — Python simulace nahrazena reálnou appkou na emulátoru:
submission → deep link → podpis v appce → finální PDF validované pyHanko + pdfsig. Podpis proběhne
**bez zadání hesla** (jen biometrie) a appka zvolí podepisujícího dle § 9.8.

---

## Phase 5: Expo appka — varianta A (eObčanka)

Cíl: QES z čipu eObčanky přes BLE čtečku.

- [ ] 5.1 Expo Module `eop-signing-sdk`: `app.plugin.js` kopíruje AAR do `android/libs/`,
      `build.gradle` přidá závislosti (AAR + `spongycastle` + `com.aheaditec:ccid`)
      → verify: `npx expo run:android` zkompiluje; `./gradlew :app:dependencies` obsahuje AAR
- [ ] 5.2 Ověřit dostupnost AAR a závislostí (`com.aheaditec:ccid` z veřejného Maven/Nexus;
      pokud není veřejné, zdokumentovat jako blokátor a kontaktovat SZR)
      → verify: build projde bez chybějících artefaktů; případný blokátor v `docs/10-qes.md`
- [ ] 5.3 S8 Připojení čtečky: `BLE-wrapper` + `ACS`/`Feitian`/`AirID`, párování v aplikaci (ne v OS)
      → verify: manuálně s reálnou čtečkou; bez čtečky chybová obrazovka
- [ ] 5.4 `cardSigner.ts`: `ApduProvider.initializeSession` → `getContainerList` → filtr kvalifikovaných
      → verify: manuálně: seznam kontejnerů (jen s QcCompliance)
- [ ] 5.5 S9 Výběr kontejneru + `getCertificate` + kontrola QcSSCD → úroveň QES
      → verify: cert bez QcSSCD se v UI odmítne
- [ ] 5.6 `provider.signData(container, data_to_sign, AlgorithmID.RSA_SHA256_PKCS1_PADDING, callback)` +
      QPIN dialog SDK → raw signatura → `POST /complete`
      → verify: manuálně s reálnou eObčankou: pyHanko označí finální PDF jako `INTACT:TRUSTED,UNTOUCHED`
- [ ] 5.7 `provider.finalizeSession` (reset karty) + chybové stavy (PIN blokován, applet deaktivován)
      → verify: manuálně: po 3 chybných PIN je stav „blokováno“ a session `failed`
- [ ] 5.8 Dev fake card mód (`EXPO_PUBLIC_QES_FAKE_CARD=1`) pro testy bez hardwaru
      → verify: celý A tok proběhne s test PKCS#12 a stejnou validací jako B
- [ ] 5.9 Attribution MOI SDK v S7 (text dle licenčních podmínek) + odkaz na licenci
      → verify: text je v appce a v README

**⏸️ Checkpoint 5**: manuální test A s reálnou čtečkou a eObčankou: QES podpis, validace, audit.
Pokud hardware není k dispozici, **zastavit a požádat uživatele** (blokátor, ne obcházet).

---

## Phase 6: E2E, negativní testy, staging a dokumentace

Cíl: všechna akceptační kritéria SPEC § 15.4 splněna a doložena.

- [ ] 6.1 `scripts/qes_e2e.py` (SPEC § 15.2): template s `qes` → submission → token → cert
      (`test/certs/pki/signer-ades.p12`, heslo `test`) → sign → complete → validace finálního PDF
      (pyHanko `--trust test/certs/pki/root.crt` + pdfsig + qpdf) → kontrola 2 signatur
      v `GET /api/submissions/:id/documents` (bez `merge=true`) i v `combined_document`
      → verify: `make qes-e2e` zelené, report v `test/out/qes-e2e-report.txt`
- [x] 6.2 `scripts/qes_negative_tests.py` (SPEC § 15.2 N1–N17) — hotové
      → verify: `make qes-negative` → report v `test/out/qes-negative-report.txt` (N1–N17 OK)
- [ ] 6.3 CI: `make verify` + `make qes-test` na každý commit; `make qes-e2e` v separátním jobu
      → verify: CI zelené (lokálně/Gitea Actions)
- [ ] 6.4 Staging: `QES_ENABLED=true`, `QES_TRUST_ROOTS`, `QES_TSA_URL` přes `fly secrets`;
      `fly deploy` z forku; healthcheck `/up`
      → verify: `curl https://dokulachtan.fly.dev/up` → 200; `fly logs` bez chyb
- [x] 6.5 Staging e2e se dvěma signery (SPEC § 15.2): `make qes-staging-e2e`
      → verify: 6 signatur INTACT, `openssl verify` vůči test trust rootu OK; LTV na stagingu
      chybí (CRL DP test certů = `127.0.0.1:8765`), proto pyHanko `INTACT:UNTRUSTED`
- [ ] 6.6 Dokumentace: `docs/10-qes.md` (runbook: ENV, TSA, trust roots, troubleshooting,
      rotace certů, limity) + aktualizace README a AGENTS.md (stav P0–P8); texty dle SPEC § 21,
      kompatibilita dle SPEC § 22
      → verify: odkazy fungují, `make qes-e2e` v runbooku
- [ ] 6.7 Upstream PR příprava (F4, volitelné): rozhraní `Qes::Provider` + hook jako malý patch
      → verify: `git format-patch` nad `dokulachtan` bez konfliktů

**⏸️ Checkpoint 6 (finální)**: projít SPEC § 15.4 bod po bodu a doložit každý bod
(reporty v `test/out/`, logy z `fly logs`, screenshoty obrazovek, `pdfsig`/pyHanko výstupy).

---

## Phase 7: Vícenásobné digitální podpisy (firemní podpisy)

Cíl: dokument podepsaný **všemi** stakeholdery, každý vlastním certifikátem, se všemi podpisy INTACT
(SPEC § 4.6, § 7.1, § 7.6). Detaily a rozhodnutí: `docs/13-navrh-vicenasobnych-podpisu.md`.

- [x] 7.1 Validace šablony `qes_signing_order` (SPEC § 4.1): nahradit `qes_single_signer_only`
      → verify: `spec/models/template_spec.rb` (5 případů) zelené
- [x] 7.2 Gating pořadí: `SubmitFormController#show` podle `submission.submitters_order_preserved?`
      + `Qes::FormSessionsController#create` vrací `409 awaiting_previous_signer` + `Submission`
      `before_validation` vynutí `preserved` u QES šablon
      → verify: `spec/models/submission_spec.rb`, `spec/requests/qes_form_sessions_spec.rb` zelené
- [x] 7.3 Řetězení TBS: `Qes::TbsDocument.chained_base` + `page_offsets`; `generate_pdfs`
      s `base:`/`page_offsets:`; `fill_submitter_fields` s `page_offsets:`
      → verify: `spec/lib/qes/chain_spec.rb` (2 signeři) zelené, `make qes-test-qes`
- [x] 7.4 `original_uuid` v `Qes::ResultAttachments` = `attachment_uuid` pole `qes`
      → verify: chain spec bod 2 (druhá session najde finální PDF předchůdce)
- [x] 7.5 E2E se dvěma podpisy jednoho dokumentu: `make qes-e2e-two`
      (bootstrap 2 submitteři, `submitters_order: preserved`, obřad pro každého zvlášť, finální PDF
      se 6 signaturami: 2× appka + 2× pečeť + 2× DocTS; `pyhanko validate` bez `--fetch` trusted)
      → verify: `test/out/qes-e2e-two-report.txt`
- [x] 7.6 Dokumentace: DESIGN § 3.1/§ 4/§ 7.4/§ 12, SPEC § 4.1/§ 4.6/§ 7.1/§ 7.6/§ 7.7/§ 15,
      PLAN P7, AGENTS.md #11, `docs/10-qes.md`
      → verify: `docs/13` a DESIGN/SPEC bez rozporu
- [x] 7.7 Oprava řetězení pro stejného podepisujícího (stejná osoba, víc polí): `chained_base`
      nejdřív použije vlastní poslední dokončenou session, teprve pak předchozího submittera;
      test „lets the same submitter sign twice with the same certificate“ (2× podpis + 2× pečeť, 4 INTACT)
      → verify: `spec/lib/qes/chain_spec.rb` zelené, `make qes-test-qes` (422/0),
      `make qes-staging-same-signer` (staging, 6 signatur INTACT)
- [x] 7.8 Oprava zobrazení: pole s `qes:<id>` zobrazuje přehled podpisu (`submissions/_value.html.erb`,
      `qes_summary.vue` + `summary_html` z `GET /s/:slug/qes_sessions/:id`)
      → verify: `spec/requests/qes_sessions_spec.rb` (summary pro dokončenou session i pro předchozího signera)
- [x] 7.9 Oprava formátování a textů: `compact` varianta přehledu (podbarvení, `overflow-hidden`)
      pro pole v dokumentu, glob `app/views/submissions` v `tailwind.form.config.js` (třídy v CSS balíčku
      `form`), `qes_step.vue` skládá `Podepsáno ({level})` a `Odkaz vyprší za {minutes} min` sám
      → verify: `make qes-test-qes` (422/0), webpack build, prohlížeč na stagingu (žádné `{{level}}`,
      oba přehledy formátované)

**⏸️ Checkpoint 7**: `make qes-e2e-two` zelené, finální PDF má 6 signatur (2× appka + 2× pečeť + 2× DocTS),
`pyhanko validate` bez `--fetch` označí všechny jako trusted, `docs/13` odsouhlaseno.

---

## Phase 8: Přímý podpis PDF (nativní tok DocuSealu)

Cíl: zaměstnanec podepíše PDF vybrané v appce (mimo DocuSeal submission) — appka nahraje PDF, klepnutím umístí
pečeť a podepíše; dokument zůstane v účtu (Documents, složka „Direct signing“) ke stažení, sdílení i smazání.
Detail: `docs/15-primy-podpis-pdf.md`. Stávající QES tok pro submissiony zůstává **beze změny**.

- [x] 8.1 `POST /api/qes/documents` (`Api::QesDocumentsController#create`): multipart PDF → šablona ve složce
      „Direct signing“ s jedním podepisujícím a jedním polem `qes`; limit velikosti (`QES_PDF_MAX_BYTES`),
      magic bytes, `content_type`, šifrovaná / už podepsaná PDF → `422`
      → verify: `spec/requests/qes_documents_spec.rb` zelené se stávajícími specy
- [x] 8.2 `Qes::PdfSource`: kontrola PDF (šifrovaná/už podepsaná) + normalizace rotace stránek
      → verify: spec v 8.1 (šifrované/už podepsané → `422`, otočené stránky sedí)
- [x] 8.3 Spuštění obřadu s API tokenem: `Qes::FormSessionsController` přijme `X-Auth-Token` (bez CSRF
      a prohlížečové session), slug je kapabilita jako podpisový odkaz
      → verify: spec v 8.1 (spuštění obřadu s tokenem → `201` + token)
- [x] 8.4 Umístění pečeti = oblast pole `qes` (`PATCH /api/templates/:id`, existující API)
      → verify: `make qes-e2e-pdf` (pečeť v místě klepnutí, inkoust 1.0)
- [x] 8.5 Dokument k podpisu = `POST /api/templates/:id/submissions` (`send_email: false`),
      dokončení = `PUT /api/submitters/:id` (`completed: true` → PDF + auditní stránka),
      stažení = `GET /api/submitters/:id` → `documents[0].url` (existující API, žádný kód forku)
      → verify: `make qes-e2e-pdf` (3 signatury, auditní stránka, dokument ve složce)
- [x] 8.6 Appka: `sign-pdf.tsx` (S11 + S12: picker, upload, náhled, klepnutí, obrys, `place`),
      `pdfApi.ts` (klient + `stampArea`), `pdfShare.ts`, `settings.tsx` (API token), S13 (stažení a sdílení)
      → verify: `make qes-app-test` (44/0) + `make qes-app-typecheck`; na emulátoru (Pixel Imprint + biometrie):
      výběr PDF → náhled → klepnutí → podpis → stažení a sdílení
- [x] 8.7 E2E `make qes-e2e-pdf` (`scripts/qes_pdf_e2e.py`): bootstrap účtu + API token → upload →
      náhled → `PATCH` oblast → submission → spuštění obřadu → podpis **kódem appky**
      (`scripts/qes-app-e2e.ts`, reuse) → `PUT …/completed` → stažení → validace `pyhanko`
      (`INTACT:TRUSTED`, pokrytí `full`) + `pdfsig` + `qpdf`
      → verify: `test/out/qes-pdf-e2e-report.txt`, pečeť v místě klepnutí (`stamp_ink` 1.0)
- [x] 8.8 Negativní N10–N17 (`scripts/qes_negative_tests.py`) + dokumentace (`docs/15`, SPEC/PLAN/AGENTS)
      → verify: `make qes-negative` zelené, report `test/out/qes-negative-report.txt`

**⏸️ Checkpoint 8**: `make qes-e2e-pdf` zelené, finální PDF má 3 signatury (appka + pečeť + DocTS), podpis appky
`INTACT:TRUSTED` s pokrytím celého dokumentu, dokument je v účtu ve složce „Direct signing“ s auditní stránkou;
`make qes-e2e` a `make qes-e2e-two` beze změny — **splněno 2026-10-18**.

## Rizika a blokátory

| Riziko | Dopad | Mitigace |
|---|---|---|
| MOI SDK AAR není veřejně dostupné (Nexus s credentials) | Fáze 5 nejde dokončit | Ověřit v kroku 5.2; kontaktovat SZR (`eidentita@szrcr.cz`); fake card mód pro testy |
| MOI SDK nepodporuje Android 15 / nové Expo | A na mobilu nefunguje | Otestovat v kroku 5.1 na emulátoru s reálnou verzí; fallback: A jen na desktopu |
| `pyHanko` neuzná naše LTV v CMS | Akceptační kritérium 2 | Ověřit v kroku 2.7; fallback: DSS dictionary (další práce) |
| FreeTSA/TSA nedostupné v CI | Testy TSA padají | TSA vypnout v CI (`QES_TSA_URL` prázdné), test s TSA jen lokálně |
| Universal links na `fly.dev` neověřené | Deep link neotevře appku | Custom scheme fallback (SPEC § 10.3); vlastní doména v produkci |
| Zablokovaný PIN/QPIN při testech s reálnou kartou | Karta nepoužitelná | Testovat nejdřív fake card mód; reálný test až po dohodě |
| Rebase na upstream rozbije hooky | Fork se rozbije | Hooky jsou malé a izolované (SPEC § 14); `make qes-test` po každém rebase |
| Pdfium render náhledu v produkčním image chybí/je pomalý | Přímý podpis nejde | Ověřit v 8.4 na test image (`libpdfium.so` už je); fallback: pevná pozice pečeti bez náhledu |
| Zaměstnanec nemá API token v appce | Upload PDF nejde | Token v S13 (nastavení), návod v `docs/15`; později párování z webu |

## Poznámky k pořadí

- **Fáze 3 je „hlavní důkaz řetězu“** — po ní je hotové finální PDF s podpisem, i když appka je zatím
  jen simulovaná v Pythonu. To je nejrychlejší cesta k ověření, že to celé funguje (odpovídá F1 v docs/04).
- **Fáze 4 je produktová cesta** (B, mobil) a **fáze 5 je doplňková** (A, QES). Pořadí 4 → 5 odpovídá
  rozhodnutí „B je hlavní, A doplňková“.
- Fáze 0–3 se dají dělat průběžně; fáze 4 a 5 vyžadují reálný Android (emulátor pro B, hardware pro A).
