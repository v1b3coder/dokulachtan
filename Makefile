# `pipefail` je potřeba, jinak `rspec … | tee` schová nenulový exit kód RSpecu
# (make by jinak hlásil úspěch i u červených testů).
SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

.PHONY: venv test-pki test-pki-crl fixtures validate negative docuseal-up docuseal-down clean qes-test qes-test-images qes-test-assets qes-test-qes qes-test-fast qes-test-parallel qes-test-parallel-fast qes-test-parallel-full qes-test-timings qes-js-test qes-test-postgres smtp-setup smtp-check smtp-test smtp-invite-test qes-e2e qes-e2e-two qes-e2e-pdf qes-verify-e2e qes-eu-dss-verify qes-negative qes-staging-e2e qes-staging-same-signer deploy-prod deploy-staging check-public apk-fingerprint-test

# Fly app pro SMTP cíle: APP=dokulachtan-staging (staging, default) / APP=dokulachtan (produkce)
APP ?= dokulachtan-staging

venv:
	python3 -m venv .venv
	.venv/bin/pip install --index-url https://pypi.org/simple pyhanko pyhanko-cli podman-compose

test-pki:
	./scripts/make_test_pki.sh

fixtures: test-pki
	./scripts/make_fixtures.sh

validate:
	./scripts/validate.sh

# Regenerace testovací PKI (potřebuje test/certs-private/root.key, gitignored)
test-pki-crl:
	.venv/bin/python scripts/make_test_pki_crl.py

# Negativní/LTV scénáře: expirace, revokace, tamper, QSCD flag (test/out/negative-report.txt)
negative:
	.venv/bin/python scripts/negative_tests.py

# vše: fixtures + validace + negativní scénáře
verify: fixtures validate negative

# fork: klon + remote upstream + větev dokulachtan (pin = HEAD forku v vendor/docuseal.rev)
fork-setup:
	./scripts/fork-setup.sh

# --- QES test harness (SPEC § 15.1, PLAN 0.2) ---------------------------------
# Test image (dev/test gemy nad produkčním image): test/qes/Dockerfile
# System image (navíc chromium pro spec/system): test/qes/Dockerfile.system
QES_REPO := vendor/docuseal
QES_IMAGE ?= dokulachtan-qes-test
QES_SYSTEM_IMAGE ?= dokulachtan-qes-system-test
QES_RUN := podman run --rm -v "$(PWD)/$(QES_REPO):/app" -v "$(PWD)/test:/qes-test:ro" -w /app \
	-e RAILS_ENV=test -e BUNDLE_WITHOUT= -e BUNDLE_GEMFILE=/app/Gemfile \
	-e PRIMARY_DATABASE_URL=sqlite3:/app/db/qes-test.sqlite3 \
	-e SCHEMA=/app/tmp/qes-test-schema.rb -e HOME=/tmp -e TZ=UTC -e QES_TEST_DIR=/qes-test

qes-test-images: ## postaví QES test image (dev/test gemy) a system image (+ chromium)
	podman build -t $(QES_IMAGE) -f test/qes/Dockerfile .
	podman build -t $(QES_SYSTEM_IMAGE) -f test/qes/Dockerfile.system .

qes-test-assets: ## zkopíruje buildnuté assety z produkčního image do forku (public/packs-test, gitignored)
	podman run --rm docker.io/docuseal/docuseal:latest tar -C /app/public -cf - packs \
		| tar -C $(QES_REPO)/public -xf -
	rm -rf $(QES_REPO)/public/packs-test
	cp -r $(QES_REPO)/public/packs $(QES_REPO)/public/packs-test

qes-test: qes-test-images ## RSpec na SQLite (jako staging) bez fulltext specu → test/out/qes-test-report.txt
	$(QES_RUN) $(QES_SYSTEM_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec --exclude-pattern "spec/system/dashboard_spec.rb"' 2>&1 | tee test/out/qes-test-report.txt

# Tiery: T0 = qes-test-qes, T1 = qes-test-fast,
# T2 = qes-test / qes-test-parallel-full, T3 = qes-test-postgres.
QES_PARALLEL_WORKERS ?= 4

qes-test-qes: qes-test-images ## T0: QES vrstva + JS testy (rychlá smyčka) → test/out/qes-report.txt
	$(QES_RUN) $(QES_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null; \
		paths=$$(ls -d spec/lib/qes spec/models/qes_session_spec.rb spec/models/template_spec.rb spec/models/submission_spec.rb spec/jobs/qes spec/requests/qes_*_spec.rb spec/requests/doc_ts_verification_spec.rb 2>/dev/null); \
		if [ -z "$$paths" ]; then echo "QES specy zatím nejsou - nic k běhu"; exit 0; fi; \
		bundle exec rspec $$paths' 2>&1 | tee test/out/qes-report.txt
	$(MAKE) qes-js-test

qes-test-fast: qes-test-images ## T1: celá sada bez spec/system (bez Chromia) → test/out/qes-test-fast-report.txt
	$(QES_RUN) $(QES_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec spec/models spec/lib spec/requests spec/jobs' 2>&1 | tee test/out/qes-test-fast-report.txt

qes-test-parallel: qes-test-images ## T0 paralelně: QES vrstva, N workerů (QES_PARALLEL_WORKERS=4)
	./scripts/qes-test-parallel.sh --group qes --workers $(QES_PARALLEL_WORKERS)

qes-test-parallel-fast: qes-test-images ## T1 paralelně: vše kromě spec/system
	./scripts/qes-test-parallel.sh --group fast --workers $(QES_PARALLEL_WORKERS)

qes-test-parallel-full: qes-test-images ## T2 paralelně: celá sada (potřebuje system image s Chromiem)
	./scripts/qes-test-parallel.sh --group full --workers $(QES_PARALLEL_WORKERS)

qes-test-timings: qes-test-images ## Přeměří časy spec souborů pro paralelní runner → test/qes/timings.txt
	$(QES_RUN) $(QES_SYSTEM_IMAGE) sh -c 'bundle exec rake db:create db:migrate >/dev/null && \
		bundle exec rspec --exclude-pattern "spec/system/dashboard_spec.rb" \
			--format json --out /app/tmp/rspec.json --format progress'
	./scripts/qes-test-parallel.sh --write-timings

qes-test-postgres: qes-test-images ## Paritní běh celé sady na Postgresu 18 (jako upstream CI)
	./scripts/qes-test-postgres.sh

qes-js-test: ## node --test pro čistou logiku QES kroku (qes_step_logic.mjs)
	cd $(QES_REPO) && node --test spec/javascript/*.test.mjs

qes-e2e: ## E2E: fork + podpis KÓDEM APPKY (mobile/app/src/lib) → validované PDF
	.venv/bin/python scripts/qes_e2e.py

qes-e2e-two: ## E2E se dvěma signery jednoho dokumentu → 4 signatury (2× appka + 2× pečeť)
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

qes-staging-e2e: ## Staging E2E: 2 signeři na https://dokulachtan-staging.fly.dev → 4 signatury
	QES_STAGING_SIGNERS=2 .venv/bin/python scripts/qes_staging_e2e.py

qes-staging-same-signer: ## Staging: stejný podepisující podepíše 2 pole → 4 signatury INTACT
	.venv/bin/python scripts/qes_staging_same_signer_check.py

qes-staging-e2e-pdf: ## Staging: přímý podpis PDF (docs/15) → upload, place, podpis kódem appky, validace
	.venv/bin/python scripts/qes_pdf_staging_e2e.py

qes-e2e-card: ## E2E varianta A: podpis fake čipem (test QSCD cert v appce)
	QES_E2E_FAKE_CARD=1 .venv/bin/python scripts/qes_e2e.py

qes-app-test: ## Jest testy appky (mobile/app): vault, P12, signer, API
	cd mobile/app && npm test

qes-app-typecheck: ## TypeScript kontrola appky
	cd mobile/app && npx tsc --noEmit

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

docuseal-up:
	cd vendor/docuseal && ../../.venv/bin/podman-compose up -d

docuseal-down:
	cd vendor/docuseal && ../../.venv/bin/podman-compose down

check-public: ## Ověří, že lokální hodnoty z .env.local / deploy/smtp.env nejsou v tracked souborech
	./scripts/check_public.sh

apk-fingerprint-test: ## Ověří parser otisku z apksigner (build-tools ≤36 a 37, #18.2)
	./scripts/apk_fingerprint_test.sh

clean:
	rm -rf test/out