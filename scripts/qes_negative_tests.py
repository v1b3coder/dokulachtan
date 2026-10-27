#!/usr/bin/env python3
"""Negativní scénáře N1–N9 (SPEC § 15.2) proti forku.

N1  přepis byte v TBS PDF po `prepare`  -> 422 signing_context_mismatch
N2  cizí raw signatura               -> 422 signature_invalid
N3  expirovaný certifikát              -> 422 certificate_expired
N4  revokovaný certifikát (CRL)        -> 422 revoked
N5  AdES certifikát u pole `level=qes`  -> 422 qes_required_qscd
N6  QcSSCD certifikát v telefonu       -> 422 level_mismatch
N7  expirovaný token                  -> 410 expired_token
N8  opakované použití tokenu            -> 410 used_token
N9  přepis finálního PDF po vložení    -> validace intact=false

Přímý podpis PDF (docs/15 § 9), N10–N17:
N10 upload bez API tokenu                -> 401 not_authenticated
N11 ne-PDF                                -> 422 invalid_pdf
N12 příliš velké PDF                       -> 422 file_too_large
N13 šifrované PDF                         -> 422 encrypted_pdf
N14 už podepsané PDF                      -> 422 already_signed
N15 nepodporovaná úroveň                   -> 422 invalid_level
N16 cizí API token (jiný účet)              -> 403 Not authorized
N17 druhé spuštění obřadu zruší první       -> první session cancelled

Použití: .venv/bin/python scripts/qes_negative_tests.py
Výstup: test/out/qes-negative-report.txt
"""
from __future__ import annotations

import base64
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import Encoding, pkcs12

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qes_e2e import (  # noqa: E402
    BASE, CONTAINER, CRL_PORT, IMAGE, OUT, PKI, ROOT, browser_create_session, log,
    podman, report, request, runner, start_app, wait_for_app,
)
from qes_pdf_e2e import api_request, api_upload  # noqa: E402

CRL_STATE = {"name": "root.crl"}


class CrlHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = (PKI / CRL_STATE["name"]).read_bytes()
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


def load_cert(name: str):
    path = PKI / name
    if path.suffix == ".p12":
        key, cert, cas = pkcs12.load_key_and_certificates(path.read_bytes(), b"test")
        return key, cert, cas or []

    cert = x509.load_pem_x509_certificate(path.read_bytes())
    root = x509.load_pem_x509_certificate((PKI / "root.crt").read_bytes())
    return None, cert, [root]


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def post_certificate(token: str, name: str, key_location: str = "phone_keystore"):
    _key, cert, cas = load_cert(name)
    return request(
        "POST",
        f"/qes/sessions/{token}/certificate",
        {
            "certificate": b64(cert.public_bytes(Encoding.DER)),
            "chain": [b64(c.public_bytes(Encoding.DER)) for c in cas],
            "key_location": key_location,
            "app": {"platform": "android", "version": "1.0.0", "reader": None, "container_ref": None},
        },
        {"X-QES-Protocol": "1"},
    )


def post_complete(token: str, signature: bytes):
    return request("POST", f"/qes/sessions/{token}/complete", {"signature": b64(signature)},
                   {"X-QES-Protocol": "1"})


def sign(name: str, data: bytes) -> bytes:
    key, _cert, _cas = load_cert(name)
    return key.sign(data, padding.PKCS1v15(), hashes.SHA256())


def new_session(slug: str, field_uuid: str) -> str:
    status, created = browser_create_session(slug, field_uuid)
    if status != 201:
        raise SystemExit(f"Vytvoření session selhalo: HTTP {status} {created}")

    request("GET", f"/qes/sessions/{created['token']}")

    return created["token"]


def new_submission(data: dict) -> tuple[str, str]:
    status, created = api_request("POST", f"/api/templates/{data['template_id']}/submissions", data["token"],
                                  {"send_email": False,
                                   "submitters": [{"role": data["submitters"][0]["name"],
                                                    "name": "N9 signer",
                                                    "email": "n9@example.com"}]})
    if status != 200:
        raise SystemExit(f"N9: nová submission selhala: HTTP {status} {created}")
    submitter = created[0] if isinstance(created, list) else created["submitters"][0]

    return submitter["slug"], data["submitters"][0]["field_uuid"]


def check(name: str, status: int, payload: dict, expected_status: int, expected_error: str) -> None:
    ok = status == expected_status and payload.get("error") == expected_error
    log(f"- {name}: HTTP {status} {payload.get('error')} -> {'OK' if ok else 'FAIL'}")
    if not ok:
        raise SystemExit(f"{name}: očekáváno HTTP {expected_status} {expected_error}, dostali {status} {payload}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    start_crl_server()
    log(f"# QES negativní scénáře N1–N9 - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"- DocuSeal: {BASE}, image: {IMAGE}")

    start_app()
    wait_for_app()

    boot = runner("/qes-scripts/qes_e2e_bootstrap.rb",
                   {"QES_E2E_PDF": "/qes-test/fixtures/input.pdf", "QES_E2E_SIGNERS": "1"})
    data = json.loads(boot.strip().splitlines()[-1])
    slug, field_uuid = data["submitter_slug"], data["field_uuid"]
    log(f"- submitter: {slug}, field: {field_uuid}\n")

    log("## N1: přepis byte v TBS PDF po prepare")
    token = new_session(slug, field_uuid)
    status, prepared = post_certificate(token, "signer-ades.p12")
    if status != 200:
        raise SystemExit(f"N1: certifikát selhal: {prepared}")
    runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "tamper_tbs"})
    status, payload = post_complete(token, sign("signer-ades.p12", base64.b64decode(prepared["data_to_sign"])))
    check("N1", status, payload, 422, "signing_context_mismatch")

    log("\n## N2: cizí raw signatura")
    token = new_session(slug, field_uuid)
    status, prepared = post_certificate(token, "signer-ades.p12")
    if status != 200:
        raise SystemExit(f"N2: certifikát selhal: {prepared}")
    status, payload = post_complete(token, sign("signer-ades.p12", b"cizi podepsane atributy"))
    check("N2", status, payload, 422, "signature_invalid")

    log("\n## N3: expirovaný certifikát")
    token = new_session(slug, field_uuid)
    status, payload = post_certificate(token, "signer-expired.crt")
    check("N3", status, payload, 422, "certificate_expired")

    log("\n## N4: revokovaný certifikát (CRL)")
    CRL_STATE["name"] = "root-revoked.crl"
    token = new_session(slug, field_uuid)
    status, payload = post_certificate(token, "signer-ades.p12")
    CRL_STATE["name"] = "root.crl"
    check("N4", status, payload, 422, "revoked")

    log("\n## N5: AdES certifikát u pole s `level=qes`")
    runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "level", "QES_NEG_LEVEL": "qes"})
    token = new_session(slug, field_uuid)
    status, payload = post_certificate(token, "signer-ades.p12")
    runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "level", "QES_NEG_LEVEL": "ades"})
    check("N5", status, payload, 422, "qes_required_qscd")

    log("\n## N6: QcSSCD certifikát s `key_location=phone_keystore`")
    token = new_session(slug, field_uuid)
    status, payload = post_certificate(token, "signer-qscd.p12")
    check("N6", status, payload, 422, "level_mismatch")

    log("\n## N7: expirovaný token")
    token = new_session(slug, field_uuid)
    runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "expire"})
    status, payload = request("GET", f"/qes/sessions/{token}")
    check("N7", status, payload, 410, "expired_token")

    log("\n## N8: opakované použití tokenu")
    token = new_session(slug, field_uuid)
    status, prepared = post_certificate(token, "signer-ades.p12")
    if status != 200:
        raise SystemExit(f"N8: certifikát selhal: {prepared}")
    status, payload = post_complete(token, sign("signer-ades.p12", base64.b64decode(prepared["data_to_sign"])))
    if status != 200 or payload.get("state") != "completed":
        raise SystemExit(f"N8: dokončení selhalo: {status} {payload}")
    status, payload = post_certificate(token, "signer-ades.p12")
    check("N8", status, payload, 410, "used_token")

    log("\n## N9: přepis finálního PDF po vložení")
    n9_slug, n9_field_uuid = new_submission(data)
    token = new_session(n9_slug, n9_field_uuid)
    status, prepared = post_certificate(token, "signer-ades.p12")
    if status != 200:
        raise SystemExit(f"N9: certifikát selhal: {prepared}")
    status, payload = post_complete(token, sign("signer-ades.p12", base64.b64decode(prepared["data_to_sign"])))
    if status != 200:
        raise SystemExit(f"N9: dokončení selhalo: {status} {payload}")
    result = json.loads(runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "tamper_final"}).strip().splitlines()[-1])
    log(f"- N9: {json.dumps(result, ensure_ascii=False)}")
    if result.get("intact") is not False:
        raise SystemExit("N9: přepsané PDF má intact=true")

    api_token = data["token"]
    test_pdf = ROOT / "test" / "fixtures" / "input.pdf"
    signature_png = ROOT / "test" / "fixtures" / "signature.png"

    log("\n## N10: upload bez API tokenu")
    status, payload = api_upload(test_pdf, "")
    check("N10", status, payload, 401, "Not authenticated")

    log("\n## N11: ne-PDF")
    status, payload = api_upload(signature_png, api_token, filename="signature.png",
                                content_type="image/png")
    check("N11", status, payload, 422, "invalid_pdf")

    log("\n## N12: příliš velké PDF")
    big = OUT / "qes-neg-big.pdf"
    big.write_bytes(b"%PDF-1.7\n" + (b"0" * (26 * 1024 * 1024)))
    status, payload = api_upload(big, api_token, filename="big.pdf")
    big.unlink()
    check("N12", status, payload, 422, "file_too_large")

    log("\n## N13: šifrované PDF")
    result = json.loads(runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "pdf_encrypted"}).strip().splitlines()[-1])
    status, payload = api_upload(OUT / Path(result["path"]).name, api_token)
    check("N13", status, payload, 422, "encrypted_pdf")

    log("\n## N14: už podepsané PDF")
    result = json.loads(runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "pdf_signed"}).strip().splitlines()[-1])
    status, payload = api_upload(OUT / Path(result["path"]).name, api_token)
    check("N14", status, payload, 422, "already_signed")

    log("\n## N15: nepodporovaná úroveň")
    status, payload = api_upload(test_pdf, api_token, level="something")
    check("N15", status, payload, 422, "invalid_level")

    log("\n## N16: cizí API token (jiný účet)")
    status, document = api_upload(test_pdf, api_token)
    if status != 201:
        raise SystemExit(f"N16: upload selhal: {status} {document}")
    foreign = json.loads(runner("/qes-scripts/qes_negative.rb", {"QES_NEG_MODE": "pdf_foreign"}).strip().splitlines()[-1])
    status, payload = api_request("PATCH", f"/api/templates/{document['template_id']}", foreign["token"],
                                 {"fields": [document["field"]]})
    check("N16", status, payload, 403, "Not authorized")

    log("\n## N17: druhé spuštění obřadu zruší první")
    status, document = api_upload(test_pdf, api_token)
    if status != 201:
        raise SystemExit(f"N17: upload selhal: {status} {document}")

    status, created = api_request("POST", f"/api/templates/{document['template_id']}/submissions", api_token,
                                  {"send_email": False,
                                   "submitters": [{"role": document["submitter_role"],
                                                    "name": "Jan Novák",
                                                    "email": "jan.novak@example.com"}]})
    if status != 200:
        raise SystemExit(f"N17: submission selhal: {status} {created}")

    submitter = created[0] if isinstance(created, list) else created["submitters"][0]
    status, first = api_request("POST", f"/s/{submitter['slug']}/qes_sessions", api_token,
                                 {"field_uuid": document["field"]["uuid"]})
    if status != 201:
        raise SystemExit(f"N17: první obřad selhal: {status} {first}")

    status, second = api_request("POST", f"/s/{submitter['slug']}/qes_sessions", api_token,
                                  {"field_uuid": document["field"]["uuid"]})
    if status != 201:
        raise SystemExit(f"N17: druhý obřad selhal: {status} {second}")

    sessions = json.loads(runner("/qes-scripts/qes_negative.rb",
                                 {"QES_NEG_MODE": "qes_sessions"}).strip().splitlines()[-1])["sessions"]
    log(f"- sessions: {json.dumps(sessions)}")
    if not any(s["state"] == "cancelled" for s in sessions):
        raise SystemExit(f"N17: první session není cancelled: {sessions}")
    if not any(s["state"] == "awaiting_app" for s in sessions):
        raise SystemExit(f"N17: druhá session není awaiting_app: {sessions}")
    log("- N17: první session cancelled, druhá awaiting_app -> OK")

    (OUT / "qes-negative-report.txt").write_text("\n".join(report) + "\n")
    log("\nOK: report v test/out/qes-negative-report.txt")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        if not os.environ.get("QES_E2E_KEEP"):
            podman("rm", "-f", CONTAINER, check=False)
