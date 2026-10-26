#!/usr/bin/env python3
"""E2E test QES (varianta B): DocuSeal fork + simulovaná appka.

Tok (pro každého signera v pořadí):
  1. lokální HTTP server s CRL (127.0.0.1:8765, certifikáty mají CRL DP)
  2. DocuSeal fork v kontejneru (production, SQLite, --network=host)
  3. bootstrap: účet + šablona s polem `qes` + submission + submitteři
  4. prohlížeč: GET /s/:slug → POST /s/:slug/qes_sessions (token + odkazy)
  5. appka: GET /api…/qes/sessions/:token → POST /certificate (PKCS#12)
     → podpis podepsaných atributů (cryptography) → POST /complete
  6. dokončení: finální PDF v DocuSealu (documents + combined + audit)
  7. validace: pyHanko (INTACT:TRUSTED,UNTOUCHED) + pdfsig + qpdf

`QES_E2E_SIGNERS=2` spustí dva signery jednoho dokumentu (SPEC § 4.6):
finální PDF má 6 signatur (2× appka + 2× pečeť + 2× DocTS), první revize zůstává INTACT;
report jde do `test/out/qes-e2e-two-report.txt` (QES_E2E_REPORT).

Použití: .venv/bin/python scripts/qes_e2e.py
"""
from __future__ import annotations

import base64
import http.cookiejar
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
PKI = ROOT / "test" / "certs" / "pki"
IMAGE = os.environ.get("QES_E2E_IMAGE", "localhost/dokulachtan-qes-system-test")
CONTAINER = "dokulachtan-qes-e2e"
PORT = os.environ.get("QES_E2E_PORT", "3030")
BASE = os.environ.get("QES_E2E_URL", f"http://127.0.0.1:{PORT}")
CRL_PORT = 8765
report: list[str] = []


def log(line: str = "") -> None:
    print(line, flush=True)
    report.append(line)


# --- CRL server (host) --------------------------------------------------------

class CrlHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = (PKI / "root.crl").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pkix-crl")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_crl_server() -> socketserver.TCPServer:
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.TCPServer(("127.0.0.1", CRL_PORT), CrlHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --- podman helpers -----------------------------------------------------------

def podman(*args: str, check: bool = True, input: str | None = None) -> str:
    proc = subprocess.run(["podman", *args], capture_output=True, text=True, input=input)
    if check and proc.returncode != 0:
        raise SystemExit(f"podman {' '.join(args)} selhalo: {proc.stderr[:800]}")
    return (proc.stdout + proc.stderr).strip()


def start_app() -> None:
    podman("rm", "-f", CONTAINER, check=False)
    podman(
        "run", "-d", "--name", CONTAINER, "--network=host",
        "-v", f"{ROOT / 'vendor' / 'docuseal'}:/app",
        "-v", f"{ROOT / 'test'}:/qes-test:ro",
        "-v", f"{ROOT / 'test' / 'out'}:/qes-out",
        "-v", f"{ROOT / 'scripts'}:/qes-scripts:ro",
        "-e", "RAILS_ENV=production",
        "-e", "SECRET_KEY_BASE=qes-e2e-secret-key-base-0123456789abcdef",
        "-e", f"PORT={PORT}",
        "-e", "PRIMARY_DATABASE_URL=sqlite3:/data/docuseal/db.sqlite3",
        "-e", "SCHEMA=/data/docuseal/schema.rb",
        "-e", "WORKDIR=/data/docuseal",
        "-e", "QES_ENABLED=true",
        "-e", "QES_TRUST_ROOTS=/qes-test/certs/pki/root.crt",
        "-e", "QES_TSA_URL=http://timestamp.digicert.com",
        "-e", "QES_TSA_REQUIRED=true",
        "-e", "QES_TSA_TRUST_ROOTS=/app/config/qes/digicert-tsa.pem",
        "-e", "QES_REQUIRE_LTV=true",
        # SSRF allowlist (SPEC § 7.4): testovací CRL server na 127.0.0.1
        "-e", "QES_LTV_ALLOWED_HOSTS=127.0.0.1",
        "-e", f"QES_PUBLIC_BASE_URL={BASE}",
        "-e", "QES_EXPIRY_JOB_INTERVAL=0",
        IMAGE, "sh", "-c",
        "mkdir -p /data/docuseal && bin/bundle exec rake db:create db:migrate >/dev/null && "
        "bin/bundle exec puma -C config/puma.rb --dir /app",
    )


def wait_for_app() -> None:
    for _ in range(120):
        try:
            with urllib.request.urlopen(f"{BASE}/up", timeout=3) as res:
                if res.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(2)
    raise SystemExit("DocuSeal neběží: " + podman("logs", "--tail", "40", CONTAINER, check=False))


def runner(script: str, env: dict[str, str] | None = None) -> str:
    args = ["exec"]
    for key, value in (env or {}).items():
        args += ["-e", f"{key}={value}"]
    args += [CONTAINER, "bin/bundle", "exec", "rails", "runner", script]
    return podman(*args)


# --- HTTP (prohlížeč + appka) --------------------------------------------------

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(method: str, path: str, payload: dict | None = None, headers: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json", **(headers or {})},
    )
    try:
        with opener.open(req, timeout=60) as res:
            body = res.read()
            return res.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]}


def browser_create_session(slug: str, field_uuid: str):
    with opener.open(f"{BASE}/s/{slug}", timeout=30) as res:
        html = res.read().decode(errors="replace")

    match = re.search(r'name="csrf-token" content="([^"]+)"', html)
    if not match:
        raise SystemExit("CSRF token nenalezen na /s/:slug")

    return request(
        "POST", f"/s/{slug}/qes_sessions",
        {"field_uuid": field_uuid},
        {"X-CSRF-Token": match.group(1)},
    )


# --- validace -----------------------------------------------------------------

def run_tool(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return (proc.stdout + proc.stderr).strip()


def signature_lines(path: Path, trust: Path) -> list[str]:
    """Řádky `SignatureN:…` z pyHanko (INTACT/TRUSTED a modifikace)."""
    pyhanko = str(ROOT / ".venv" / "bin" / "pyhanko")
    out = run_tool([pyhanko, "sign", "validate", "--trust-replace", "--trust", str(trust), str(path)])

    return [line for line in out.splitlines() if re.match(r"Signature\d+:", line)]


def count_signatures(path: Path) -> int:
    """Počet PAdES signatur v PDF (pyHanko z .venv)."""
    from pyhanko.pdf_utils.reader import PdfFileReader

    with path.open("rb") as handle:
        return len(PdfFileReader(handle).embedded_signatures)


def validate_pdf(path: Path, trust: Path) -> str:
    pyhanko = str(ROOT / ".venv" / "bin" / "pyhanko")
    lines = [f"\n# Soubor: {path.name} ({path.stat().st_size} B)"]
    for cmd in (
        ["qpdf", "--check", str(path)],
        ["pdfsig", str(path)],
        [pyhanko, "sign", "validate", "--trust-replace", "--trust", str(trust), str(path)],
    ):
        lines.append(f"## {' '.join(cmd)}")
        lines.append(run_tool(cmd))
    return "\n".join(lines)


def run_app_ceremony(token: str, fake_card: bool = False) -> dict:
    """Spustí obřad podpisu kódem appky (mobile/app/src/lib) přes `tsx`.

    `fake_card=True` spustí variantu A (čip) s testovacím QSCD certem
    (EXPO_PUBLIC_QES_FAKE_CARD=1, SPEC § 15.3) — fyzická čtečka je mimo rozsah.
    """
    app_dir = ROOT / "mobile" / "app"
    proc = subprocess.run(
        ["npx", "tsx", "--tsconfig", "scripts/tsconfig.e2e.json", "scripts/qes-app-e2e.ts"],
        capture_output=True,
        text=True,
        cwd=app_dir,
        env={
            **os.environ,
            "QES_E2E_TOKEN": token,
            "QES_E2E_SERVER_URL": BASE,
            "QES_E2E_FAKE_CARD": "1" if fake_card else "0",
        },
        timeout=300,
    )

    if proc.returncode != 0:
        raise SystemExit(f"Appka e2e selhala: {(proc.stdout + proc.stderr)[-800:]}")

    return json.loads(proc.stdout.strip().splitlines()[-1])


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.pdf"):
        old.unlink()

    report_name = os.environ.get("QES_E2E_REPORT", "qes-e2e-report.txt")
    signer_count = int(os.environ.get("QES_E2E_SIGNERS", "1"))

    start_crl_server()
    log(f"# QES E2E report - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"- DocuSeal: {BASE}, image: {IMAGE}, signeři: {signer_count}")

    log("\n## Start DocuSeal")
    start_app()
    wait_for_app()
    log("- /up -> 200")

    log("\n## Bootstrap (účet, šablona s polem qes, submission)")
    boot = runner("/qes-scripts/qes_e2e_bootstrap.rb",
                   {"QES_E2E_PDF": "/qes-test/fixtures/input.pdf",
                    "QES_E2E_SIGNERS": str(signer_count)})
    data = json.loads(boot.strip().splitlines()[-1])
    log(json.dumps(data, indent=2, ensure_ascii=False))

    signers = data.get("submitters") or [
        {"slug": data["submitter_slug"], "field_uuid": data["field_uuid"], "name": "Signer"}
    ]

    fake_card = os.environ.get("QES_E2E_FAKE_CARD") == "1"
    completed = []

    for index, signer in enumerate(signers, start=1):
        log(f"\n## Prohlížeč: POST /s/:slug/qes_sessions (signer {index}/{len(signers)})")
        status, created = browser_create_session(signer["slug"], signer["field_uuid"])
        log(f"-> HTTP {status} {json.dumps(created, ensure_ascii=False)[:300]}")
        if status != 201:
            raise SystemExit(f"Vytvoření QES session selhalo (signer {index})")

        token = created["token"]
        log(f"- state: {created['state']}, universal_link: {created['universal_link']}")
        log(f"- custom_scheme_link: {created['custom_scheme_link']}")

        if index == 1:
            log("\n## Prohlížeč: web fallback /qes/app + /.well-known")
            for path in (
                f"/qes/app?token={token}",
                "/.well-known/assetlinks.json",
                "/.well-known/apple-app-site-association",
            ):
                try:
                    with urllib.request.urlopen(BASE + path, timeout=30) as res:
                        body = res.read().decode(errors="replace")
                        log(f"- {path} -> HTTP {res.status}, {res.headers.get('Content-Type')}, {len(body)} B")
                except urllib.error.HTTPError as err:
                    log(f"- {path} -> HTTP {err.code}")
                    raise SystemExit(f"Fallback {path} selhal")

        log(
            f"\n## Appka: podpis KÓDEM APPKY (signer {index}, "
            + ("varianta A - fake čip)" if fake_card else "varianta B - klíč)")
        )
        app_result = run_app_ceremony(token, fake_card=fake_card)
        log(json.dumps(app_result, indent=2, ensure_ascii=False))
        if app_result.get("completed", {}).get("state") != "completed":
            raise SystemExit(f"Podpis v appce selhal (signer {index})")
        if fake_card and (
            app_result.get("key_location") != "card" or app_result.get("level") != "qes"
        ):
            raise SystemExit("Fake čip nevrátil key_location=card / level=qes")

        log(f"\n## DocuSeal: dokončení submittera {index} a generování PDF")
        done = json.loads(
            runner("/qes-scripts/qes_e2e_complete.rb",
                   {"QES_E2E_SUBMITTER_SLUG": signer["slug"]}).strip().splitlines()[-1]
        )
        log(json.dumps(done, indent=2, ensure_ascii=False))
        completed.append(done)

    log("\n## Validace (pyHanko/pdfsig/qpdf)")
    trust = PKI / "root.crt"
    for name in ("qes-signed.pdf", "qes-final.pdf"):
        path = OUT / name
        if path.exists():
            log(validate_pdf(path, trust))
    for done in completed:
        for name in done.get("documents", []) + done.get("combined", []) + done.get("audit", []):
            path = OUT / name["filename"]
            if path.exists():
                log(validate_pdf(path, trust))

    if len(signers) > 1:
        final_path = OUT / "qes-final.pdf"
        count = count_signatures(final_path)
        log(f"\n## Počet signatur v qes-final.pdf: {count} (očekáváno {3 * len(signers)})")
        if count != 3 * len(signers):
            raise SystemExit(f"qes-final.pdf má {count} signatur, očekáváno {3 * len(signers)}")
        for index, done in enumerate(completed, start=1):
            for document in done.get("documents", []):
                path = OUT / document["filename"]
                if not path.exists():
                    continue
                lines = signature_lines(path, trust)
                log(f"- signer {index}: {document['filename']} -> "
                    f"{len(lines)} signatur, INTACT: "
                    f"{bool(lines) and all('INTACT' in line for line in lines)}")
                if not lines or not all("INTACT" in line for line in lines):
                    raise SystemExit(f"{document['filename']}: signatura není INTACT")

    (OUT / report_name).write_text("\n".join(report) + "\n")
    log(f"\nOK: report v test/out/{report_name}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        if not os.environ.get("QES_E2E_KEEP"):
            podman("rm", "-f", CONTAINER, check=False)
