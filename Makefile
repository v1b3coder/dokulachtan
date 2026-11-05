# `pipefail` je potřeba, jinak `rspec … | tee` schová nenulový exit kód RSpecu
# (make by jinak hlásil úspěch i u červených testů).
SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

.PHONY: help venv test-pki test-pki-crl fixtures validate negative docuseal-up docuseal-down clean qes-test qes-test-images qes-test-image qes-test-system-image qes-test-assets qes-test-qes qes-test-fast qes-test-parallel qes-test-parallel-fast qes-test-parallel-full qes-test-timings qes-test-parallel-selftest qes-js-test qes-test-postgres smtp-setup smtp-check smtp-test smtp-invite-test qes-e2e qes-e2e-two qes-e2e-pdf qes-verify-e2e qes-eu-dss-verify qes-negative qes-staging-e2e qes-staging-same-signer deploy-prod deploy-staging check-public apk-fingerprint-test verify fork-setup qes-staging-e2e-pdf qes-e2e-card qes-e2e-card-real qes-e2e-card-real-xvfb qes-e2e-card-apdu qes-app-test qes-app-typecheck hooks push app-deps fork-deps test-check test-check-js test-check-app test-check-python test test-ci test-full test-manual test-prepare test-tools test-help test-staging test-android test-eu-dss test-card test-t0 test-t1 test-t2 test-t3 test-app test-negative test-e2e debug-phone emulator release

# Fly app pro SMTP cíle: APP=dokulachtan-staging (staging, default) / APP=dokulachtan (produkce)
APP ?= dokulachtan-staging
# ADB pro install z `make debug-phone` / `make emulator`; pro konkrétní zařízení použij ADB="adb -s …".
ADB ?= adb
# Sériové číslo emulátoru pro `make emulator` (výchozí první emulátor).
EMULATOR_SERIAL ?= emulator-5554

help: ## Vypíše fáze testů a ostatní cíle
	@echo "Fáze testů:"
	@grep -hE '^(test|test-ci|test-full|test-manual|test-prepare|test-tools|test-help|test-staging|test-android|test-eu-dss|test-card):.*?## ' $(MAKEFILE_LIST) | sort | sed -E 's/:.*## / — /'
	@echo
	@echo "Interní testovací cíle (používat přes fáze):"
	@grep -hE '^test-(t0|t1|t2|t3|app|negative|e2e):.*?## ' $(MAKEFILE_LIST) | sort | sed -E 's/:.*## / — /'
	@echo
	@echo "Ostatní:"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| grep -vE '^(test|qes-|fixtures:|validate:|negative:|verify:|apk-fingerprint-test:|help:)' \
		| sort | sed -E 's/:.*## / — /'

test-help: ## Vypíše mapování fází na interní targety
	@echo "F0 test-prepare = venv fork-setup qes-test-images qes-test-assets app-deps fork-deps hooks"
	@echo "F1 test         = test-t0 test-app"
	@echo "F2 test-ci      = test-t0 test-t1 test-app"
	@echo "F3 test-full    = test-ci test-t2 test-t3 test-negative test-e2e"
	@echo "F4 test-manual  = test-staging test-eu-dss (ALLOW_EXTERNAL=1)"
	@echo "F4 test-android = emulátor + instrumentace (ALLOW_EMULATOR=1)"
	@echo "F4 debug-phone = debug APK na telefon (arm64)"
	@echo "F4 emulator    = debug APK pro emulátor (x86_64)"
	@echo "F4 release     = release APK v CI na tag (TAG=v1.3.10)"
	@echo "F4 test-card   = reálná čtečka (průzkum čipu, bez PINu)"
	@echo "F5 test-tools   = verify apk-fingerprint-test qes-test-parallel-selftest"

venv: ## Vytvoří .venv (pyHanko + podman-compose, pin z requirements-qes.txt)
	python3 -m venv .venv
	.venv/bin/pip install --index-url https://pypi.org/simple -r requirements-qes.txt

hooks: ## Nainstaluje git hooky z .githooks (pre-push: T0 + app testy + typecheck)
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-push

push: ## Push do gitea + GitHub zrcadla, pre-push testy jen jednou (ARGS=<refspec>)
	scripts/push.sh $(ARGS)

app-deps: ## Nainstaluje npm závislosti appky (npm ci)
	cd mobile/app && npm ci

fork-deps: ## Nainstaluje yarn závislosti forku (pro JS testy)
	@if command -v yarn >/dev/null; then \
		cd vendor/docuseal && yarn install --frozen-lockfile; \
	else \
		cd vendor/docuseal && npx --yes yarn@1.22.22 install --frozen-lockfile; \
	fi

test-check:
	@test -d vendor/docuseal/.git || { echo "chybí vendor/docuseal — make test-prepare"; exit 1; }

test-check-js:
	@test -d vendor/docuseal/node_modules || { echo "chybí vendor/docuseal/node_modules — make test-prepare"; exit 1; }

test-check-app:
	@test -d mobile/app/node_modules || { echo "chybí mobile/app/node_modules — make test-prepare"; exit 1; }

test-check-python:
	@test -x .venv/bin/python || { echo "chybí .venv — make test-prepare"; exit 1; }

test-pki: ## Vygeneruje testovací PKI (root, issuing CA, koncové certy)
	./scripts/make_test_pki.sh

fixtures: test-pki ## Vygeneruje testovací fixtures (PDF, podpisy)
	./scripts/make_fixtures.sh

validate: ## Zvaliduje fixtures (pdfsig, pyHanko, OpenSSL)
	./scripts/validate.sh

test-pki-crl: ## Regenerace testovací PKI (potřebuje test/certs-private/root.key, gitignored)
	.venv/bin/python scripts/make_test_pki_crl.py

negative: ## Negativní/LTV scénáře: expirace, revokace, tamper, QSCD flag → test/out/negative-report.txt
	.venv/bin/python scripts/negative_tests.py

verify: fixtures validate negative ## Vše: fixtures + validace + negativní scénáře

fork-setup: ## Klon forku + remote upstream + větev dokulachtan (pin z vendor/docuseal.rev)
	./scripts/fork-setup.sh

# --- QES test harness (SPEC § 15.1, PLAN 0.2) ---------------------------------
# Test image (dev/test gemy nad produkčním image): test/qes/Dockerfile
# System image (navíc chromium pro spec/system): test/qes/Dockerfile.system
QES_REPO := vendor/docuseal
QES_IMAGE ?= dokulachtan-qes-test
QES_SYSTEM_IMAGE ?= dokulachtan-qes-system-test
QES_CONTAINER ?= podman
QES_BUILD ?= $(QES_CONTAINER) build
# Fresh DB pro hook/CI: QES_DB=qes-hook-$$.sqlite3 make qes-test-qes
QES_DB ?= qes-test.sqlite3
QES_SCHEMA ?= qes-test-schema.rb
QES_RUN := $(QES_CONTAINER) run --rm -v "$(PWD)/$(QES_REPO):/app" -v "$(PWD)/test:/qes-test:ro" -w /app \
	-e RAILS_ENV=test -e BUNDLE_WITHOUT= -e BUNDLE_GEMFILE=/app/Gemfile \
	-e PRIMARY_DATABASE_URL=sqlite3:/app/db/$(QES_DB) \
	-e SCHEMA=/app/tmp/$(QES_SCHEMA) -e HOME=/tmp -e TZ=UTC -e QES_TEST_DIR=/qes-test

# Reporty se v čerstvém klonu tee do neexistujícího adresáře jinak rozbijí (pipefail).
test/out:
	mkdir -p $@

qes-test-image: ## postaví QES test image (dev/test gemy, bez Chromia)
	$(QES_BUILD) -t $(QES_IMAGE) -f test/qes/Dockerfile .

qes-test-system-image: qes-test-image ## postaví system image (test image + Chromium)
	$(QES_BUILD) -t $(QES_SYSTEM_IMAGE) -f test/qes/Dockerfile.system .

qes-test-images: qes-test-image qes-test-system-image ## postaví oba image (test + system)

qes-test-assets: ## zkopíruje buildnuté assety z produkčního image do forku (public/packs-test, gitignored)
	$(QES_CONTAINER) run --rm docker.io/docuseal/docuseal:latest tar -C /app/public -cf - packs \
		| tar -C $(QES_REPO)/public -xf -
	rm -rf $(QES_REPO)/public/packs-test
	cp -r $(QES_REPO)/public/packs $(QES_REPO)/public/packs-test

qes-test: qes-test-system-image test/out ## RSpec na SQLite (jako staging) bez fulltext specu → test/out/qes-test-report.txt
	$(QES_RUN) $(QES_SYSTEM_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec --exclude-pattern "spec/system/dashboard_spec.rb"' 2>&1 | tee test/out/qes-test-report.txt

# Tiery: T0 = qes-test-qes, T1 = qes-test-fast,
# T2 = qes-test / qes-test-parallel-full, T3 = qes-test-postgres.
QES_PARALLEL_WORKERS ?= 4

qes-test-qes: qes-test-image test/out ## T0: QES vrstva + JS testy (rychlá smyčka) → test/out/qes-report.txt
	$(QES_RUN) $(QES_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null; \
		paths=$$(ls -d spec/lib/qes spec/models/qes_session_spec.rb spec/models/template_spec.rb spec/models/submission_spec.rb spec/jobs/qes spec/requests/qes_*_spec.rb spec/requests/doc_ts_verification_spec.rb 2>/dev/null); \
		if [ -z "$$paths" ]; then echo "QES specy zatím nejsou - nic k běhu"; exit 0; fi; \
		bundle exec rspec $$paths' 2>&1 | tee test/out/qes-report.txt
	$(MAKE) qes-js-test

qes-test-fast: qes-test-image test/out ## T1: celá sada bez spec/system (bez Chromia) → test/out/qes-test-fast-report.txt
	$(QES_RUN) $(QES_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec spec/models spec/lib spec/requests spec/jobs' 2>&1 | tee test/out/qes-test-fast-report.txt

qes-test-parallel: qes-test-image ## T0 paralelně: QES vrstva, N workerů (QES_PARALLEL_WORKERS=4)
	./scripts/qes-test-parallel.sh --group qes --workers $(QES_PARALLEL_WORKERS)

qes-test-parallel-fast: qes-test-image ## T1 paralelně: vše kromě spec/system
	./scripts/qes-test-parallel.sh --group fast --workers $(QES_PARALLEL_WORKERS)

qes-test-parallel-full: qes-test-system-image ## T2 paralelně: celá sada (potřebuje system image s Chromiem)
	./scripts/qes-test-parallel.sh --group full --workers $(QES_PARALLEL_WORKERS)

qes-test-parallel-selftest: ## Ověří, že paralelní runner neprojde s prázdným plánem (#23.2)
	./scripts/qes_test_parallel_test.sh

qes-test-timings: qes-test-system-image test/out ## Přeměří časy spec souborů pro paralelní runner → test/qes/timings.txt
	$(QES_RUN) $(QES_SYSTEM_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec --exclude-pattern "spec/system/dashboard_spec.rb" \
			--format json --out /app/tmp/rspec.json --format progress'
	./scripts/qes-test-parallel.sh --write-timings

qes-test-postgres: qes-test-system-image ## Paritní běh celé sady na Postgresu 18 (jako upstream CI)
	./scripts/qes-test-postgres.sh

qes-js-test: ## node --test pro čistou logiku QES kroku (qes_step_logic.mjs)
	cd $(QES_REPO) && node --test spec/javascript/*.test.mjs

qes-e2e: ## E2E: fork + podpis KÓDEM APPKY (mobile/app/src/lib) → validované PDF
	.venv/bin/python scripts/qes_e2e.py

qes-e2e-two: ## E2E se dvěma signery jednoho dokumentu → 6 signatur (2× appka + 2× pečeť + 2× DocTS)
	QES_E2E_SIGNERS=2 QES_E2E_REPORT=qes-e2e-two-report.txt .venv/bin/python scripts/qes_e2e.py

qes-e2e-pdf: ## E2E přímého podpisu PDF (docs/15): upload + náhled + place + podpis kódem appky
	.venv/bin/python scripts/qes_pdf_e2e.py

qes-verify-e2e: ## E2E ověření PDF (docs/16): verify + store + tampered/unsigned
	QES_PDF_E2E_REPORT=qes-verify-e2e-report.txt .venv/bin/python scripts/qes_pdf_e2e.py

# Volitelné: nezávislá kontrola vygenerovaných PDF přes veřejné EU DSS API
# (docs/19). PDF opouští stroj; testovací certy jsou untrusted,
# pro reálný cert použij TRUSTED=1. Nespouští se v běžném CI.
QES_EU_DSS_PDFS ?= test/out/qes-final.pdf test/out/qes-pdf-final.pdf test/out/qes-staging-*-final.pdf test/out/qes-pdf-staging-final.pdf
qes-eu-dss-verify: ## EU DSS compliance check PDF (externí API; volitelné, PDF opouští stroj)
	.venv/bin/python scripts/qes_eu_dss_verify.py --allow-missing $(if $(TRUSTED),--require-trusted,) \
		--report qes-eu-dss-report.txt $(QES_EU_DSS_PDFS)

qes-negative: ## Negativní scénáře N1–N17 (SPEC § 15.2) → test/out/qes-negative-report.txt
	.venv/bin/python scripts/qes_negative_tests.py

qes-staging-e2e: ## Staging E2E: 2 signeři na https://dokulachtan-staging.fly.dev → 6 signatur
	QES_STAGING_SIGNERS=2 .venv/bin/python scripts/qes_staging_e2e.py

qes-staging-same-signer: ## Staging: stejný podepisující podepíše 2 pole → 6 signatur INTACT
	.venv/bin/python scripts/qes_staging_same_signer_check.py

qes-staging-e2e-pdf: ## Staging: přímý podpis PDF (docs/15) → upload, place, podpis kódem appky, validace
	.venv/bin/python scripts/qes_pdf_staging_e2e.py

qes-e2e-card: ## E2E varianta A: podpis fake čipem (test QSCD cert v appce)
	QES_E2E_FAKE_CARD=1 .venv/bin/python scripts/qes_e2e.py

qes-app-test: ## Jest testy appky (mobile/app): vault, P12, signer, API
	cd mobile/app && npm test

qes-app-typecheck: ## TypeScript kontrola appky
	cd mobile/app && npx tsc --noEmit

# --- Fáze testů (veřejné entrypointy; detail: test/README.md) -----------------
# F0 příprava, F1 před pushem, F2 CI basic, F3 CI full,
# F4 post-deploy/manuální, F5 nástroje/legacy.

test-prepare: ## F0: příprava (venv, fork, image, assety, deps, hooky)
	$(MAKE) venv fork-setup qes-test-images qes-test-assets app-deps fork-deps hooks

test: test-check test-check-js test-check-app ## F1: rychlá smyčka (T0 + JS + app + typecheck)
	$(MAKE) test-t0 test-app

test-ci: test-check test-check-js test-check-app ## F2: CI basic (T0 + T1 + app + typecheck)
	$(MAKE) test-t0 test-t1 test-app

test-full: test-check test-check-js test-check-app test-check-python qes-test-assets ## F3: plná sada (T0–T3 + negativní + E2E + app)
	$(MAKE) venv
	$(MAKE) test-ci
	$(MAKE) test-t2 test-t3
	$(MAKE) test-negative test-e2e

test-manual: ## F4: post-deploy/manuální (staging + EU DSS); vyžaduje ALLOW_EXTERNAL=1
	@test "$(ALLOW_EXTERNAL)" = 1 || { \
		echo "F4 pouští testy proti živému stagingu a externímu API."; \
		echo "Potvrď: ALLOW_EXTERNAL=1 make test-manual"; exit 1; }
	$(MAKE) venv
	$(MAKE) test-staging test-eu-dss

test-staging: test-check test-check-python ## F4a: staging E2E proti nasazenému stagingu (Fly)
	@test "$(ALLOW_EXTERNAL)" = 1 || { echo "F4a vyžaduje ALLOW_EXTERNAL=1"; exit 1; }
	command -v fly >/dev/null || { echo "chybí fly CLI"; exit 1; }
	$(MAKE) qes-staging-e2e qes-staging-same-signer qes-staging-e2e-pdf

test-eu-dss: test-check test-check-python ## F4c: EU DSS (PDF opouští stroj)
	@test "$(ALLOW_EXTERNAL)" = 1 || { echo "F4c vyžaduje ALLOW_EXTERNAL=1"; exit 1; }
	$(MAKE) qes-eu-dss-verify

test-android: test-check-app ## F4b: emulátor + instrumentace (lokálně; SDK/KVM)
	@test "$(ALLOW_EMULATOR)" = 1 || { \
		echo "F4b staví APK a pouští emulátor."; \
		echo "Potvrď: ALLOW_EMULATOR=1 make test-android"; exit 1; }
	cd mobile/app && APP_TARGET=emulator npx expo prebuild --platform android --clean --no-install
	cd mobile/app/android && APP_TARGET=emulator ./gradlew assembleDebug -PreactNativeArchitectures=x86_64
	@echo "instrumentace zatím není implementovaná — TODO"

debug-phone: ## Debug APK na telefon (arm64, lokální klíč)
	cd mobile/app && APP_TARGET=phone npx expo prebuild --platform android --clean --no-install
	cd mobile/app/android && APP_TARGET=phone ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
	$(ADB) install -r mobile/app/android/app/build/outputs/apk/debug/app-debug.apk

emulator: ## Debug APK pro emulátor (x86_64, lokální klíč)
	cd mobile/app && APP_TARGET=emulator npx expo prebuild --platform android --clean --no-install
	cd mobile/app/android && APP_TARGET=emulator ./gradlew assembleDebug -PreactNativeArchitectures=x86_64
	$(ADB) -s $(EMULATOR_SERIAL) install -r mobile/app/android/app/build/outputs/apk/debug/app-debug.apk

release: ## Release APK se staví v CI na tag (TAG=v1.3.10)
	@test -n "$(TAG)" || { echo "Použij make release TAG=v1.3.10"; exit 1; }
	@echo "Release APK se staví v CI:"
	@echo "  git tag $(TAG) && make push ARGS=$(TAG)"
	@exit 1

test-card: ## F4d: reálná čtečka — průzkum čipu (bez PINu)
	.venv/bin/python scripts/eop_card_sign.py --probe
	.venv/bin/python scripts/eop_apdu.py --attempts
	@echo "Podpis s čipem: EOP_PIN=... make qes-e2e-card-real (QPIN zadáš v dialogu ovladače)"

qes-e2e-card-apdu: ## F4d: přímé APDU — pokusy + cert (bez PINu, bez middleware)
	.venv/bin/python scripts/eop_apdu.py --attempts
	.venv/bin/python scripts/eop_apdu.py --cert /tmp/eop-cert-apdu.der

qes-e2e-card-real: ## F4d: podpis PDF reálným čipem (PIN + QPIN, docs/26 § 7)
	@test -n "$$EOP_PIN" || { echo "Použij EOP_PIN=... make qes-e2e-card-real"; exit 1; }
	.venv/bin/python scripts/eop_card_sign.py --sign

qes-e2e-card-real-xvfb: ## F4d: podpis reálným čipem pod Xvfb (QPIN dialog se vyplní sám)
	@test -n "$$EOP_PIN" -a -n "$$EOP_QPIN" || { echo "Použij EOP_PIN=... EOP_QPIN=... make qes-e2e-card-real-xvfb"; exit 1; }
	xvfb-run -a --server-args="-screen 0 1400x1000x24" scripts/eop_card_sign_xvfb.sh

test-tools: ## F5: nástroje a legacy (fixtures, validate, staré negative)
	$(MAKE) verify apk-fingerprint-test qes-test-parallel-selftest

# Interní sub-targety pro CI a debug; normálně používej fáze výše.
test-t0: test-check test-check-js qes-test-assets ## T0: QES vrstva + JS (interní)
	QES_DB="$${QES_DB:-qes-t0.sqlite3}" QES_SCHEMA="$${QES_SCHEMA:-qes-t0.rb}" $(MAKE) qes-test-qes

test-t1: test-check qes-test-assets ## T1: celá sada bez system (interní)
	QES_DB="$${QES_DB:-qes-t1.sqlite3}" QES_SCHEMA="$${QES_SCHEMA:-qes-t1.rb}" $(MAKE) qes-test-fast

test-t2: test-check qes-test-assets ## T2: celá sada se system (interní)
	QES_DB="$${QES_DB:-qes-t2.sqlite3}" QES_SCHEMA="$${QES_SCHEMA:-qes-t2.rb}" $(MAKE) qes-test

test-t3: test-check qes-test-assets ## T3: Postgres 18 (interní)
	$(MAKE) qes-test-postgres

test-app: test-check-app ## App Jest + typecheck (interní)
	$(MAKE) qes-app-test qes-app-typecheck

test-negative: test-check test-check-python qes-test-image qes-test-assets ## N1–N17 (interní)
	QES_E2E_IMAGE=$(QES_IMAGE) $(MAKE) qes-negative

test-e2e: test-check test-check-app test-check-python qes-test-image qes-test-assets ## E2E: 4 běhy + fake card (interní)
	QES_E2E_IMAGE=$(QES_IMAGE) $(MAKE) qes-e2e qes-e2e-two qes-e2e-pdf qes-verify-e2e
	QES_E2E_IMAGE=$(QES_IMAGE) QES_E2E_REPORT=qes-e2e-card-report.txt $(MAKE) qes-e2e-card

# Fly.io: konfigurace jsou v parent repu (deploy/docuseal/), do forku se předávají --config;
# ve forku tak nezůstává nic, co nepatří k DocuSealu.
deploy-prod: ## fly deploy produkce (dokulachtan) — deploy/docuseal/fly.toml
	cd $(QES_REPO) && fly deploy . --config ../../deploy/docuseal/fly.toml

deploy-staging: ## fly deploy staging (dokulachtan-staging) — deploy/docuseal/fly.staging.toml
	cd $(QES_REPO) && fly deploy . --config ../../deploy/docuseal/fly.staging.toml

# SMTP (APP=dokulachtan pro produkci, APP=dokulachtan-staging pro staging): vyplň deploy/smtp.env
# (produkce používá SMTP_FILE=deploy/smtp.prod.env, gitignored) → fly secrets
SMTP_FILE ?= deploy/smtp.env

smtp-setup: ## Nahraje $(SMTP_FILE) jako fly secrets a restartuje app (APP=dokulachtan-staging pro staging)
	@test -f $(SMTP_FILE) || { echo "chybí $(SMTP_FILE) — zkopíruj deploy/smtp.env.example"; exit 1; }
	fly secrets import -a $(APP) < $(SMTP_FILE)

smtp-invite-test: ## Pošle reálnou pozvánku (stejný job jako v provozu) na adresu TO= z běžící app
	@test -n "$(TO)" || { echo "chybí TO= — např. make smtp-invite-test TO=nekdo@example.com"; exit 1; }
	@curl -s -o /dev/null https://$(APP).fly.dev/up || true
	fly ssh console -a $(APP) -C "sh -c 'echo $(shell base64 -w0 scripts/smtp_invitation_probe.rb) | base64 -d > /tmp/smtp_invite.rb && SMTP_INVITE_TO=$(TO) /app/bin/rails runner /tmp/smtp_invite.rb'"

smtp-check: ## Ověří, že app vidí SMTP konfiguraci (heslo se nevypisuje)
	@curl -s -o /dev/null https://$(APP).fly.dev/up || true
	fly ssh console -a $(APP) -C "sh -c 'env | grep -E \"^SMTP_(ADDRESS|PORT|USERNAME|DOMAIN|FROM)=\" || echo SMTP_nenastaveno'"

smtp-test: ## Pošle testovací e-mail na adresu TO= z běžící app (předmět obsahuje název appky)
	@test -n "$(TO)" || { echo "chybí TO= — např. make smtp-test TO=nekdo@example.com"; exit 1; }
	@curl -s -o /dev/null https://$(APP).fly.dev/up || true
	fly ssh console -a $(APP) -C "sh -c 'echo $(shell base64 -w0 scripts/smtp_probe.rb) | base64 -d > /tmp/smtp_probe.rb && SMTP_PROBE_TO=$(TO) SMTP_PROBE_TAG=$(APP) /app/bin/rails runner /tmp/smtp_probe.rb'"

docuseal-up: ## Spustí lokální DocuSeal z vendor/docuseal (podman-compose)
	cd vendor/docuseal && ../../.venv/bin/podman-compose up -d

docuseal-down: ## Zastaví lokální DocuSeal
	cd vendor/docuseal && ../../.venv/bin/podman-compose down

check-public: ## Ověří, že lokální hodnoty z .env.local / deploy/smtp.env nejsou v tracked souborech
	./scripts/check_public.sh

apk-fingerprint-test: ## Ověří parser otisku z apksigner (build-tools ≤36 a 37, #18.2)
	./scripts/apk_fingerprint_test.sh

clean: ## Smaže vygenerované artefakty (test/out)
	rm -rf test/out