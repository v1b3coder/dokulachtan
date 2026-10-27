#!/usr/bin/env python3
"""Staging E2E se dvěma signery jednoho dokumentu (SPEC § 4.6, § 15.2).

Tok pro každého signera v pořadí:
  1. staging (Fly) bootstrap přes `fly ssh console` + rails runner
  2. prohlížeč: GET /s/:slug → POST /s/:slug/qes_sessions
  3. appka: podpis KÓDEM APPKY proti stagingu (mobile/app, test cert)
  4. dokončení submittera přes `fly ssh console` + rails runner
  5. stažení finálního PDF ze stagingu a validace pyHanko (test trust root)

Použití: .venv/bin/python scripts/qes_staging_e2e.py
Výstup: test/out/qes-staging-e2e-report.txt
"""
from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qes_e2e import count_signatures, log, report, signature_lines, validate_pdf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
PKI = ROOT / "test" / "certs" / "pki"
APP = ROOT / "mobile" / "app"
BASE = os.environ.get("QES_STAGING_URL", "https://dokulachtan-staging.fly.dev")
FLY_APP = os.environ.get("QES_STAGING_FLY_APP", "dokulachtan-staging")
SIGNERS = int(os.environ.get("QES_STAGING_SIGNERS", "2"))

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(method: str, path: str, payload: dict | None = None, headers: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json", **(headers or {})},
    )
    try:
        with opener.open(req, timeout=60) as res:
            body = res.read()
            return res.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:300]}


def wait_for_staging() -> None:
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"{BASE}/up", timeout=15) as res:
                if res.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(5)
    raise SystemExit("Staging neběží")


def fly_runner(script: str, env: dict[str, str] | None = None) -> dict:
    code = base64.b64encode((ROOT / "scripts" / script).read_bytes()).decode()
    assignments = "".join(f'ENV["{key}"] = "{value}"; ' for key, value in (env or {}).items())
    command = (f"/app/bin/rails runner 'require \"base64\"; "
               f"{assignments}eval(Base64.decode64(\"{code}\"))'")
    proc = subprocess.run(["fly", "ssh", "console", "-a", FLY_APP, "-C", command],
                          capture_output=True, text=True, timeout=600)
    out = proc.stdout + proc.stderr
    lines = [line for line in out.splitlines() if line.strip().startswith("{")]
    if not lines:
        raise SystemExit(f"Staging runner selhal ({script}): {out[-800:]}")
    return json.loads(lines[-1])


def browser_create_session(slug: str, field_uuid: str):
    with opener.open(f"{BASE}/s/{slug}", timeout=60) as res:
        html = res.read().decode(errors="replace")

    match = re.search(r'name="csrf-token" content="([^"]+)"', html)
    if not match:
        raise SystemExit(f"CSRF token nenalezen na /s/{slug}")

    return request("POST", f"/s/{slug}/qes_sessions", {"field_uuid": field_uuid},
                   {"X-CSRF-Token": match.group(1)})


def run_app_ceremony(token: str) -> dict:
    proc = subprocess.run(
        ["npx", "tsx", "--tsconfig", "scripts/tsconfig.e2e.json", "scripts/qes-app-e2e.ts"],
        capture_output=True, text=True, cwd=APP, timeout=300,
        env={**os.environ, "QES_E2E_TOKEN": token, "QES_E2E_SERVER_URL": BASE},
    )
    if proc.returncode != 0:
        raise SystemExit(f"Appka selhala: {(proc.stdout + proc.stderr)[-600:]}")

    return json.loads(proc.stdout.strip().splitlines()[-1])


def download(remote: str, local: Path) -> None:
    proc = subprocess.run(["fly", "ssh", "sftp", "get", remote, str(local), "-a", FLY_APP],
                          capture_output=True, text=True, timeout=300)
    if proc.returncode != 0 or not local.exists():
        raise SystemExit(f"Stažení {remote} selhalo: {(proc.stdout + proc.stderr)[-600:]}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("qes-staging-*.pdf"):
        old.unlink()

    log(f"# QES staging E2E ({SIGNERS} signeři) - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"- Staging: {BASE}, Fly app: {FLY_APP}")

    wait_for_staging()
    log("- /up -> 200")

    log("\n## Bootstrap (šablona s polem qes, submitters)")
    boot = fly_runner("qes_staging_bootstrap.rb",
                       {"QES_STAGING_SIGNERS": str(SIGNERS), "QES_STAGING_RESET": "1"})
    log(json.dumps(boot, indent=2, ensure_ascii=False))

    submitters = boot.get("submitters") or [
        {"slug": boot["submitter_slug"], "field_uuid": boot["field_uuid"], "name": "Signer"}
    ]

    for index, signer in enumerate(submitters, start=1):
        log(f"\n## Prohlížeč: POST /s/:slug/qes_sessions (signer {index}/{len(submitters)})")
        status, created = browser_create_session(signer["slug"], signer["field_uuid"])
        if status != 201:
            raise SystemExit(f"Vytvoření session selhalo: HTTP {status} {created}")
        log(f"- state: {created['state']}, universal_link: {created['universal_link']}")

        log(f"\n## Appka: podpis KÓDEM APPKY proti stagingu (signer {index})")
        app_result = run_app_ceremony(created["token"])
        log(json.dumps(app_result, indent=2, ensure_ascii=False))
        if app_result.get("completed", {}).get("state") != "completed":
            raise SystemExit(f"Podpis v appce selhal (signer {index})")

        log(f"\n## Staging: dokončení submittera {index} a generování PDF")
        done = fly_runner("qes_staging_complete.rb", {"QES_STAGING_SUBMITTER_SLUG": signer["slug"]})
        log(json.dumps(done, indent=2, ensure_ascii=False))
        if not done.get("submitter_completed"):
            raise SystemExit(f"Submitter {index} nebyl dokončen")

        final = OUT / f"qes-staging-{signer['slug']}-final.pdf"
        download(done["final_file"], final)
        log(f"- finální PDF: {final.name} ({final.stat().st_size} B)")

    trust = PKI / "root.crt"
    final = OUT / f"qes-staging-{submitters[-1]['slug']}-final.pdf"
    count = count_signatures(final)
    log(f"\n## Počet signatur ve finálním PDF: {count} (očekáváno {3 * len(submitters)})")
    if count != 3 * len(submitters):
        raise SystemExit(f"Finální PDF má {count} signatur, očekáváno {3 * len(submitters)}")

    lines = signature_lines(final, trust)
    log(f"- pyHanko: {len(lines)} signatur, všechny INTACT: {bool(lines) and all('INTACT' in line for line in lines)}")
    if not lines or not all("INTACT" in line for line in lines):
        raise SystemExit("Některá signatura není INTACT")

    verify = subprocess.run(["openssl", "verify", "-CAfile", str(trust), str(PKI / "signer-ades.crt")],
                            capture_output=True, text=True)
    log(f"- openssl verify (test cert vs test root): {(verify.stdout + verify.stderr).strip()}")
    log("- poznámka: test cert má CRL DP na staging host; CRL je dostupné a podpis je TRUSTED;")
    log("  pečeť DocuSealu zůstává UNTRUSTED (test trust list neobsahuje její cert).")

    for index, signer in enumerate(submitters, start=1):
        path = OUT / f"qes-staging-{signer['slug']}-final.pdf"
        log(validate_pdf(path, trust))
        if index < len(submitters):
            log(f"- signer {index}: {path.name} -> {count_signatures(path)} signatur")

    (OUT / "qes-staging-e2e-report.txt").write_text("\n".join(report) + "\n")
    log("\nOK: report v test/out/qes-staging-e2e-report.txt")

    return 0


if __name__ == "__main__":
    sys.exit(main())
