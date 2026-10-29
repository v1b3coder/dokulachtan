#!/usr/bin/env python3
"""E2E přímého podpisu PDF nativním tokem DocuSealu (docs/15 § 5).

Tok:
  1. lokální HTTP server s CRL (127.0.0.1:8765, certifikáty mají CRL DP)
  2. DocuSeal fork v kontejneru (production, SQLite, --network=host)
  3. bootstrap: účet + API token (rails runner)
  4. appka: POST /api/qes/documents (multipart) → šablona ve složce „Direct signing“
  5. appka: GET náhled stránky (podepsaná URL)
  6. appka: PATCH /api/templates/:id → umístění pečeti (oblast pole `qes`)
  7. appka: POST /api/templates/:id/submissions → submitter
  8. appka: POST /s/:slug/qes_sessions → token (slug je kapabilita)
  9. appka: obřad podpisu KÓDEM APPKY (scripts/qes-app-e2e.ts, beze změny)
 10. appka: POST /qes/sessions/:token/complete_submission → PDF + audit (SPEC § 5.3.1)
 11. appka: GET /api/submitters/:id → finální PDF
 12. validace: pyHanko/pdfsig/qpdf; pečeť v místě klepnutí (Pdfium inkoust)

Použití: .venv/bin/python scripts/qes_pdf_e2e.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import qes_e2e as base  # noqa: E402

BASE = base.BASE
OUT = base.OUT
PKI = base.PKI

# Místo klepnutí: střed pečeti normalizovaně 0-1 od levého horního rohu.
STAMP_POSITION = {"x": 0.62, "y": 0.18}
PAGE = 0


def api_request(method: str, path: str, token: str | None = None, payload: dict | None = None,
                 accept: str = "application/json", raw: bool = False):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Accept": accept, "Content-Type": "application/json", "X-QES-Protocol": "1"}
    if token:
        headers["X-Auth-Token"] = token

    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read()

            return response.status, body if raw else json.loads(body)
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")

        return err.code, body if raw else (json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]})


def api_upload(path: Path, token: str, *, display_name: str = "Jan Novák", level: str = "ades",
               filename: str = "contract.pdf", content_type: str = "application/pdf"):
    boundary = f"----qes{uuid.uuid4().hex}"
    parts = bytearray()

    def field(name: str, value: str) -> None:
        parts.extend(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    def file_field(name: str, name_on_disk: str, data: bytes) -> None:
        parts.extend(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{name_on_disk}"\r\nContent-Type: {content_type}\r\n\r\n'.encode()
        )
        parts.extend(data)
        parts.extend(b"\r\n")

    field("display_name", display_name)
    field("level_required", level)
    file_field("file", filename, path.read_bytes())
    parts.extend(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        f"{BASE}/api/qes/documents",
        data=bytes(parts),
        method="POST",
        headers={
            "X-Auth-Token": token,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")

        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]}


def api_pdf(path: Path, token: str, endpoint: str, *, filename: str = "document.pdf",
             content_type: str = "application/pdf"):
    boundary = f"----qes{uuid.uuid4().hex}"
    parts = bytearray()
    parts.extend(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode()
    )
    parts.extend(path.read_bytes())
    parts.extend(b"\r\n")
    parts.extend(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        f"{BASE}{endpoint}",
        data=bytes(parts),
        method="POST",
        headers={
            "X-Auth-Token": token,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")

        return err.code, json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body[:400]}


def api_verify(path: Path, token: str, *, filename: str = "document.pdf"):
    return api_pdf(path, token, "/api/qes/verify", filename=filename)


def api_store(path: Path, token: str, *, filename: str = "document.pdf"):
    return api_pdf(path, token, "/api/qes/verified_documents", filename=filename)


def api_download(url: str, token: str | None = None):
    headers = {"Accept": "application/pdf"}
    if token:
        headers["X-Auth-Token"] = token

    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, response.headers.get("Content-Type"), response.read()
    except urllib.error.HTTPError as err:
        return err.code, None, err.read()


def stamp_area(document: dict) -> dict:
    """Oblast pole `qes` z klepnutí (stejný přepočet jako v appce)."""
    page = document["document"]["pages"][PAGE]
    width = document["stamp"]["width"] / page["width"]
    height = document["stamp"]["height"] / page["height"]
    x = min(max(STAMP_POSITION["x"] - (width / 2), 0), 1 - width)
    y = min(max(STAMP_POSITION["y"] - (height / 2), 0), 1 - height)

    return {"x": round(x, 6), "y": round(y, 6), "w": round(width, 6), "h": round(height, 6), "page": PAGE}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ("qes-pdf-final.pdf", "qes-pdf-audit.pdf", "qes-pdf-preview.png"):
        (OUT / name).unlink(missing_ok=True)

    base.start_crl_server()
    base.log(f"# QES PDF E2E report - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    base.log(f"- DocuSeal: {BASE}, image: {base.IMAGE}")

    base.log("\n## Start DocuSeal")
    base.start_app()
    base.wait_for_app()
    base.log("- /up -> 200")

    base.log("\n## Bootstrap (účet + API token)")
    bootstrap = json.loads(base.runner("/qes-scripts/qes_pdf_bootstrap.rb").strip().splitlines()[-1])
    base.log(json.dumps(bootstrap, indent=2, ensure_ascii=False))
    api_token = bootstrap["token"]

    base.log("\n## Appka: POST /api/qes/documents (upload PDF)")
    status, document = api_upload(base.ROOT / "test" / "fixtures" / "input.pdf", api_token)
    base.log(f"-> HTTP {status} {json.dumps(document, ensure_ascii=False)[:500]}")
    if status != 201:
        raise SystemExit(f"Upload PDF selhal: {status}")

    base.log(f"- šablona: {document['template_id']} ({document['document']['filename']}), "
              f"složka: {document['folder']}, role: {document['submitter_role']}")
    base.log(f"- stránky: {[(p['index'], p['width'], p['height']) for p in document['document']['pages']]}")
    base.log(f"- pečeť: {document['stamp']}")

    base.log("\n## Appka: GET náhled stránky")
    status, content_type, body = api_download(document["document"]["pages"][PAGE]["preview_url"], api_token)
    base.log(f"-> HTTP {status}, {content_type}, {len(body)} B")
    if status != 200 or not body.startswith(b"\x89PNG"):
        raise SystemExit(f"Náhled stránky selhal: {status} {content_type}")
    (OUT / "qes-pdf-preview.png").write_bytes(body)

    base.log("\n## Appka: PATCH /api/templates/:id (umístění pečeti)")
    area = stamp_area(document)
    field = {**document["field"], "areas": [{**area, "attachment_uuid": document["document"]["uuid"]}]}
    base.log(f"- klepnutí: {json.dumps(STAMP_POSITION)}, oblast: {json.dumps(area)}")
    status, patched = api_request("PATCH", f"/api/templates/{document['template_id']}", api_token,
                                 {"fields": [field]})
    base.log(f"-> HTTP {status} {json.dumps(patched, ensure_ascii=False)[:200]}")
    if status != 200:
        raise SystemExit(f"Umístění pečeti selhalo: {status}")

    base.log("\n## Appka: POST /api/templates/:id/submissions")
    status, created = api_request("POST", f"/api/templates/{document['template_id']}/submissions", api_token,
                                  {"send_email": False,
                                   "submitters": [{"role": document["submitter_role"],
                                                    "name": "Jan Novák",
                                                    "email": "jan.novak@example.com"}]})
    base.log(f"-> HTTP {status} {json.dumps(created, ensure_ascii=False)[:300]}")
    if status != 200:
        raise SystemExit(f"Vytvoření submissionu selhalo: {status}")

    submitter = created[0] if isinstance(created, list) else created["submitters"][0]
    base.log(f"- submitter: {submitter['id']}, slug: {submitter['slug']}, stav: {submitter['status']}")

    base.log("\n## Appka: POST /s/:slug/qes_sessions (spuštění obřadu)")
    status, session = api_request("POST", f"/s/{submitter['slug']}/qes_sessions", api_token,
                                  {"field_uuid": document["field"]["uuid"]})
    base.log(f"-> HTTP {status} {json.dumps(session, ensure_ascii=False)[:300]}")
    if status != 201:
        raise SystemExit(f"Spuštění obřadu selhalo: {status}")

    token = session["token"]

    base.log("\n## Appka: podpis KÓDEM APPKY (obřad beze změny)")
    app_result = base.run_app_ceremony(token)
    base.log(json.dumps(app_result, indent=2, ensure_ascii=False))
    if app_result.get("completed", {}).get("state") != "completed":
        raise SystemExit("Podpis v appce selhal")

    base.log("\n## Appka: POST /qes/sessions/:token/complete_submission")
    status, completed = api_request("POST", f"/qes/sessions/{token}/complete_submission")
    base.log(f"-> HTTP {status} {json.dumps(completed, ensure_ascii=False)[:300]}")
    if status != 200 or not completed.get("completed"):
        raise SystemExit(f"Dokončení submissionu selhalo: {status}")

    base.log("\n## Appka: GET /api/submitters/:id (finální PDF)")
    status, details = api_request("GET", f"/api/submitters/{submitter['id']}", api_token)
    documents = details.get("documents") or []
    base.log(f"-> HTTP {status}, dokumenty: {[d['name'] for d in documents]}")
    if status != 200 or not documents:
        raise SystemExit(f"Stažení finálního PDF selhalo: {status}")

    status, content_type, final_pdf = api_download(documents[0]["url"])
    base.log(f"-> HTTP {status}, {content_type}, {len(final_pdf)} B")
    if status != 200 or not final_pdf.startswith(b"%PDF-"):
        raise SystemExit(f"Finální PDF není PDF: {status}")

    base.log("\n## Server: kontrola submissionu (pole, session, pečeť)")
    check = json.loads(base.runner("/qes-scripts/qes_pdf_check.rb").strip().splitlines()[-1])
    base.log(json.dumps(check, indent=2, ensure_ascii=False))
    if check["session_state"] != "completed":
        raise SystemExit(f"QES session není completed: {check['session_state']}")
    if check["field_value"] != f"qes:{check['session_id']}":
        raise SystemExit(f"Hodnota pole není qes:<id>: {check['field_value']}")
    if check["submission_folder"] != "Direct signing":
        raise SystemExit(f"Dokument není ve složce Direct signing: {check['submission_folder']}")
    if not check["submission_completed"]:
        raise SystemExit("Submission není completed")

    base.log("\n## Server: POST /api/qes/verify (finální PDF)")
    status, report = api_verify(OUT / "qes-pdf-final.pdf", api_token, filename="qes-pdf-final.pdf")
    base.log(f"-> HTTP {status} {json.dumps(report, ensure_ascii=False)[:800]}")
    if status != 200 or report.get("verdict") != "valid":
        raise SystemExit(f"Ověření finálního PDF selhalo: {status} {report}")
    if report.get("origin") != "docuseal":
        raise SystemExit(f"origin není docuseal: {report.get('origin')}")
    if len(report.get("signatures", [])) != 3 or not report.get("seal", {}).get("present"):
        raise SystemExit(f"Neočekávané signatury/pečeť: {report.get('signatures')} {report.get('seal')}")
    base.log("- verdikt: valid, origin: docuseal, 3 signatury, pečeť přítomná")

    base.log("\n## Server: POST /api/qes/verified_documents (uložení do Verified documents)")
    status, stored = api_store(OUT / "qes-pdf-final.pdf", api_token, filename="qes-pdf-final.pdf")
    base.log(f"-> HTTP {status} {json.dumps(stored, ensure_ascii=False)[:400]}")
    if status != 200 or not stored.get("stored") or stored.get("folder") != "Verified documents":
        raise SystemExit(f"Uložení do Verified documents selhalo: {status} {stored}")
    base.log(f"- template: {stored.get('template_id')}, složka: {stored.get('folder')}")

    tampered_path = OUT / "qes-pdf-tampered.pdf"
    tampered = bytearray((OUT / "qes-pdf-final.pdf").read_bytes())
    tampered[-1] = ord("X") if tampered[-1] != ord("X") else ord("Y")
    tampered_path.write_bytes(bytes(tampered))
    status, tampered_report = api_verify(tampered_path, api_token, filename="tampered.pdf")
    base.log(f"\n## Server: ověření tampered PDF -> HTTP {status} {tampered_report.get('verdict')}")
    if status != 200 or tampered_report.get("verdict") != "invalid":
        raise SystemExit(f"Tampered PDF nevyšlo invalid: {status} {tampered_report}")

    status, unsigned_report = api_verify(base.ROOT / "test" / "fixtures" / "input.pdf", api_token,
                                       filename="unsigned.pdf")
    base.log(f"## Server: ověření nepodepsaného PDF -> HTTP {status} {unsigned_report.get('verdict')}")
    if status != 200 or unsigned_report.get("verdict") != "unsigned":
        raise SystemExit(f"Nepodepsané PDF nevyšlo unsigned: {status} {unsigned_report}")

    base.log("\n## Validace (pyHanko/pdfsig/qpdf)")
    trust = PKI / "root.crt"
    base.log(base.validate_pdf(OUT / "qes-pdf-final.pdf", trust))
    base.log(base.validate_pdf(OUT / "qes-pdf-audit.pdf", trust))

    lines = base.signature_lines(OUT / "qes-pdf-final.pdf", trust)
    base.log(f"\n## Podpis appky (qes-pdf-final.pdf): {lines}")
    if not all("INTACT" in line for line in lines):
        raise SystemExit(f"Některá signatura není INTACT: {lines}")

    app_lines = [line for line in lines if ":INTACT:TRUSTED" in line]

    if not app_lines:
        raise SystemExit(f"Podpis appky není INTACT:TRUSTED: {lines}")
    base.log("- podpis appky: INTACT:TRUSTED (pokrytí celého dokumentu; DSS/LTA rozšíření je "
              "přípustná modifikace, stejně jako u `make qes-e2e`)")

    count = base.count_signatures(OUT / "qes-pdf-final.pdf")
    base.log(f"- signatury: {count} (očekáváno 3: podpis appky + pečeť DocuSealu + DocTS)")
    if count != 3:
        raise SystemExit(f"qes-pdf-final.pdf má {count} signatur, očekáváno 3")

    base.log(f"\n## Pečeť v místě klepnutí ({check['field_area']})")
    base.log(f"- inkoust v místě pečeti: {check['stamp_ink']}, mimo pečeť: {check['other_ink']}")
    if check["stamp_ink"] < 0.5 or check["other_ink"] != 0:
        raise SystemExit("Pečeť není v místě klepnutí")

    if check["validation"]["coverage"] != "full":
        raise SystemExit(f"Pokrytí není plné: {check['validation']}")
    base.log("- pokrytí celého dokumentu: full")
    base.log(f"- auditní stránka: {check['audit']}")

    report_name = os.environ.get("QES_PDF_E2E_REPORT", "qes-pdf-e2e-report.txt")
    (OUT / report_name).write_text("\n".join(base.report) + "\n")
    base.log(f"\nOK: report v test/out/{report_name}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        if not os.environ.get("QES_E2E_KEEP"):
            base.podman("rm", "-f", base.CONTAINER, check=False)
