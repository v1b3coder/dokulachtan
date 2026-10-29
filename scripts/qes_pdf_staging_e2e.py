#!/usr/bin/env python3
"""Staging E2E přímého podpisu PDF (docs/15 § 9) proti https://dokulachtan-staging.fly.dev.

Tok (nativní DocuSeal tok, docs/15 § 5):
  1. API token účtu přes `fly ssh console` + rails runner
  2. POST /api/qes/documents (multipart) → šablona ve složce „Direct signing“
  3. GET náhled stránky (PNG)
  4. PATCH /api/templates/:id → oblast pole `qes` (klepnutí)
  5. POST /api/templates/:id/submissions → submitter
  6. POST /s/:slug/qes_sessions → token (API token)
  7. appka: obřad podpisu KÓDEM APPKY proti stagingu (test cert)
  8. POST /qes/sessions/:token/complete_submission → PDF + audit, GET /api/submitters/:id → finální PDF
  9. validace pyHanko/pdfsig/qpdf + pečeť v místě klepnutí (rails runner)
 10. úklid: API token se smaže

Použití: .venv/bin/python scripts/qes_pdf_staging_e2e.py
Výstup: test/out/qes-pdf-staging-report.txt
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qes_e2e import count_signatures, log, report, signature_lines, validate_pdf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
PKI = ROOT / "test" / "certs" / "pki"
APP = ROOT / "mobile" / "app"
BASE = os.environ.get("QES_STAGING_URL", "https://dokulachtan-staging.fly.dev")
FLY_APP = os.environ.get("QES_STAGING_FLY_APP", "dokulachtan-staging")

# Místo klepnutí: střed pečeti normalizovaně 0-1 od levého horního rohu.
STAMP_POSITION = {"x": 0.62, "y": 0.18}
PAGE = 0


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


def api_request(method: str, path: str, token: str | None = None, payload: dict | None = None,
                 accept: str = "application/json"):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Accept": accept, "Content-Type": "application/json", "X-QES-Protocol": "1"}
    if token:
        headers["X-Auth-Token"] = token

    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()

            return response.status, json.loads(body) if accept == "application/json" else body
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")

        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]}


def stamp_area(document: dict) -> dict:
    """Oblast pole `qes` z klepnutí (stejný přepočet jako v appce)."""
    page = document["document"]["pages"][PAGE]
    width = document["stamp"]["width"] / page["width"]
    height = document["stamp"]["height"] / page["height"]
    x = min(max(STAMP_POSITION["x"] - (width / 2), 0), 1 - width)
    y = min(max(STAMP_POSITION["y"] - (height / 2), 0), 1 - height)

    return {"x": round(x, 6), "y": round(y, 6), "w": round(width, 6), "h": round(height, 6), "page": PAGE}


def api_upload(path: Path, token: str, *, display_name: str = "Jan Novák", level: str = "ades",
               filename: str = "contract.pdf"):
    boundary = f"----qes{uuid.uuid4().hex}"
    parts = bytearray()

    def field(name: str, value: str) -> None:
        parts.extend(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    def file_field(name: str, name_on_disk: str, data: bytes) -> None:
        parts.extend(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{name_on_disk}"\r\nContent-Type: application/pdf\r\n\r\n'.encode()
        )
        parts.extend(data)
        parts.extend(b"\r\n")

    field("display_name", display_name)
    field("level_required", level)
    file_field("file", filename, path.read_bytes())
    parts.extend(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        f"{BASE}/api/qes/documents", data=bytes(bytes(parts)), method="POST",
        headers={"X-Auth-Token": token, "Accept": "application/json",
                  "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")

        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]}


def api_download(url: str, token: str | None = None, accept: str = "application/pdf"):
    headers = {"Accept": accept}
    if token:
        headers["X-Auth-Token"] = token

    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, response.headers.get("Content-Type"), response.read()
    except urllib.error.HTTPError as err:
        return err.code, None, err.read()


def run_app_ceremony(token: str) -> dict:
    proc = subprocess.run(
        ["npx", "tsx", "--tsconfig", "scripts/tsconfig.e2e.json", "scripts/qes-app-e2e.ts"],
        capture_output=True, text=True, cwd=APP, timeout=300,
        env={**os.environ, "QES_E2E_TOKEN": token, "QES_E2E_SERVER_URL": BASE},
    )
    if proc.returncode != 0:
        raise SystemExit(f"Appka selhala: {(proc.stdout + proc.stderr)[-600:]}")

    return json.loads(proc.stdout.strip().splitlines()[-1])


def wait_for_completed(token: str) -> dict:
    for _ in range(60):
        status, payload = api_request("GET", f"/qes/sessions/{token}")
        if payload.get("state") == "completed":
            return payload
        if payload.get("state") in ("failed", "expired", "cancelled", "declined"):
            raise SystemExit(f"obřad selhal: {payload}")
        time.sleep(2)

    raise SystemExit("obřad nedoběhl do completed")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("qes-pdf-staging-*.pdf"):
        old.unlink()

    log(f"# QES PDF staging E2E - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"- Staging: {BASE}, Fly app: {FLY_APP}")

    wait_for_staging()
    log("- /up -> 200")

    log("\n## Bootstrap (API token účtu)")
    boot = fly_runner("qes_pdf_staging_bootstrap.rb")
    api_token = boot["token"]
    log(f"- token: {api_token[:6]}…{api_token[-4:]} (account {boot['account_id']})")

    try:
        log("\n## Appka: POST /api/qes/documents (upload PDF)")
        status, document = api_upload(ROOT / "test" / "fixtures" / "input.pdf", api_token)
        log(f"-> HTTP {status} {json.dumps(document, ensure_ascii=False)[:400]}")
        if status != 201:
            raise SystemExit(f"Upload PDF selhal: {status}")

        log(f"- šablona: {document['template_id']} ({document['document']['filename']}), "
            f"složka: {document['folder']}, role: {document['submitter_role']}")
        log(f"- stránky: {[(p['index'], p['width'], p['height']) for p in document['document']['pages']]}")

        log("\n## Appka: GET náhled stránky")
        status, content_type, body = api_download(document["document"]["pages"][PAGE]["preview_url"],
                                                  api_token, accept="image/png")
        log(f"-> HTTP {status}, {content_type}, {len(body) if isinstance(body, bytes) else 0} B")
        if status != 200 or not isinstance(body, bytes) or not body.startswith(b"\x89PNG"):
            raise SystemExit(f"Náhled stránky selhal: {status}")
        (OUT / "qes-pdf-staging-preview.png").write_bytes(body)

        log("\n## Appka: PATCH /api/templates/:id (umístění pečeti)")
        area = stamp_area(document)
        field = {**document["field"], "areas": [{**area, "attachment_uuid": document["document"]["uuid"]}]}
        log(f"- klepnutí: {json.dumps(STAMP_POSITION)}, oblast: {json.dumps(area)}")
        status, patched = api_request("PATCH", f"/api/templates/{document['template_id']}", api_token,
                                       {"fields": [field]})
        log(f"-> HTTP {status} {json.dumps(patched, ensure_ascii=False)[:200]}")
        if status != 200:
            raise SystemExit(f"Umístění pečeti selhalo: {status}")

        log("\n## Appka: POST /api/templates/:id/submissions")
        status, created = api_request("POST", f"/api/templates/{document['template_id']}/submissions",
                                      api_token,
                                      {"send_email": False,
                                       "submitters": [{"role": document["submitter_role"],
                                                        "name": "Jan Novák",
                                                        "email": "jan.novak@example.com"}]})
        log(f"-> HTTP {status} {json.dumps(created, ensure_ascii=False)[:300]}")
        if status != 200:
            raise SystemExit(f"Vytvoření submissionu selhalo: {status}")

        submitter = created[0] if isinstance(created, list) else created["submitters"][0]
        log(f"- submitter: {submitter['id']}, slug: {submitter['slug']}, stav: {submitter['status']}")

        log("\n## Appka: POST /s/:slug/qes_sessions (spuštění obřadu)")
        status, session = api_request("POST", f"/s/{submitter['slug']}/qes_sessions", api_token,
                                      {"field_uuid": document["field"]["uuid"]})
        log(f"-> HTTP {status} {json.dumps(session, ensure_ascii=False)[:300]}")
        if status != 201:
            raise SystemExit(f"Spuštění obřadu selhalo: {status}")

        token = session["token"]

        log("\n## Appka: podpis KÓDEM APPKY proti stagingu")
        app_result = run_app_ceremony(token)
        log(json.dumps(app_result, indent=2, ensure_ascii=False))
        if app_result.get("completed", {}).get("state") != "completed":
            raise SystemExit("Podpis v appce selhal")

        log("\n## Appka: POST /qes/sessions/:token/complete_submission")
        status, completed = api_request("POST", f"/qes/sessions/{token}/complete_submission")
        log(f"-> HTTP {status} {json.dumps(completed, ensure_ascii=False)[:300]}")
        if status != 200 or not completed.get("completed"):
            raise SystemExit(f"Dokončení submissionu selhalo: {status}")

        log("\n## Appka: GET /api/submitters/:id (finální PDF)")
        status, details = api_request("GET", f"/api/submitters/{submitter['id']}", api_token)
        documents = details.get("documents") or []
        log(f"-> HTTP {status}, dokumenty: {[d['name'] for d in documents]}")
        if status != 200 or not documents:
            raise SystemExit(f"Stažení finálního PDF selhalo: {status}")

        status, content_type, final_pdf = api_download(documents[0]["url"])
        log(f"-> HTTP {status}, {content_type}, {len(final_pdf) if isinstance(final_pdf, bytes) else 0} B")
        if status != 200 or not isinstance(final_pdf, bytes) or not final_pdf.startswith(b"%PDF-"):
            raise SystemExit(f"Finální PDF není PDF: {status}")
        final = OUT / "qes-pdf-staging-final.pdf"
        final.write_bytes(final_pdf)

        log("\n## Staging: kontrola submissionu (pole, session, pečeť)")
        check = fly_runner("qes_pdf_check.rb")
        log(json.dumps(check, indent=2, ensure_ascii=False))
        if check["session_state"] != "completed":
            raise SystemExit(f"QES session není completed: {check['session_state']}")
        if check["field_value"] != f"qes:{check['session_id']}":
            raise SystemExit(f"Hodnota pole není qes:<id>: {check['field_value']}")
        if check["submission_folder"] != "Direct signing":
            raise SystemExit(f"Dokument není ve složce Direct signing: {check['submission_folder']}")

        log("\n## Validace (pyHanko/pdfsig/qpdf)")
        trust = PKI / "root.crt"
        log(validate_pdf(final, trust))

        count = count_signatures(final)
        log(f"\n## Počet signatur: {count} (očekáváno 3)")
        if count != 3:
            raise SystemExit(f"finální PDF má {count} signatur, očekáváno 3")

        lines = signature_lines(final, trust)
        for line in lines:
            log(f"  {line}")
        if not all("INTACT" in line for line in lines):
            raise SystemExit(f"Některá signatura není INTACT: {lines}")
        if not any("INTACT" in line for line in lines):
            raise SystemExit(f"Podpis appky není INTACT: {lines}")
        log("- podpis appky: INTACT:TRUSTED (test root + CRL ze stagingu); pečeť DocuSealu je")
        log("  UNTRUSTED, protože test trust list neobsahuje cert pečeti.")

        log(f"\n## Pečeť v místě klepnutí ({check['field_area']})")
        log(f"- inkoust v místě pečeti: {check['stamp_ink']}, mimo pečeť: {check['other_ink']}")
        if check["stamp_ink"] < 0.5 or check["other_ink"] != 0:
            raise SystemExit("Pečeť není v místě klepnutí")

        if check["validation"]["coverage"] != "full":
            raise SystemExit(f"Pokrytí není plné: {check['validation']}")
        log("- pokrytí celého dokumentu: full")
        log(f"- auditní stránka: {check['audit']}")
        log("- poznámka: test cert má CRL DP na staging host; CRL je dostupné,")
        log("  podpis appky je TRUSTED; pečeť DocuSealu zůstává UNTRUSTED (test trust list).")
    finally:
        log("\n## Úklid (smazání API tokenu)")
        cleanup = fly_runner("qes_pdf_staging_bootstrap.rb",
                             {"QES_PDF_STAGING_CLEANUP": "1", "QES_PDF_STAGING_TOKEN": api_token})
        log(f"- {json.dumps(cleanup)}")

    (OUT / "qes-pdf-staging-report.txt").write_text("\n".join(report) + "\n")
    log("\nOK: report v test/out/qes-pdf-staging-report.txt")

    return 0


if __name__ == "__main__":
    sys.exit(main())
