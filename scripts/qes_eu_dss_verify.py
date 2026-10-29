#!/usr/bin/env python3
"""Externí compliance check PDF přes EU DSS (docs/19).

Posílá vygenerované PDF na veřejné demo EU DSS a kontroluje, že je služba
pozná jako PAdES, že jsou všechny podpisy/razítka kryptograficky v pořádku
a že poslední revize pokrývá celý dokument. Trust se u testovacích certů
nekontroluje (nejsou v EU trusted listu); `--require-trusted` je pro reálné certy.

PDF opouští stroj — spouštět jen nad testovacími/veřejnými PDF.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
DEFAULT_URL = (
    "https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/"
    "services/rest/validation/validateSignature"
)
FAILED_SUB_INDICATIONS = {"HASH_FAILURE", "SIG_CRYPTO_FAILURE", "FORMAT_FAILURE"}
TRUSTED_QUALIFICATIONS = {"QESig", "AdESig", "AdESig-QC"}
DEFAULT_PDFS = [
    "test/out/qes-final.pdf",
    "test/out/qes-pdf-final.pdf",
    "test/out/qes-staging-final.pdf",
    "test/out/qes-pdf-staging-final.pdf",
]


def post_pdf(path: Path, url: str, timeout: int) -> dict:
    payload = json.dumps(
        {
            "signedDocument": {
                "bytes": base64.b64encode(path.read_bytes()).decode("ascii"),
                "name": path.name,
            }
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read(500).decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code}: {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"EU DSS není dostupné: {error.reason}") from error


def qualification_map(report: dict) -> dict[str, str]:
    detailed = report.get("DetailedReport") or {}
    result: dict[str, str] = {}

    for item in detailed.get("signatureOrTimestampOrEvidenceRecord") or []:
        signature = item.get("Signature") or {}
        identifier = signature.get("Id")

        if identifier:
            result[identifier] = (
                (signature.get("ValidationSignatureQualification") or {}).get(
                    "SignatureQualification"
                )
                or ""
            )

    return result


def is_intact(indication: str, sub_indication: str) -> bool:
    return indication != "TOTAL_FAILED" and sub_indication not in FAILED_SUB_INDICATIONS


def scope_is_full(scopes: list[dict] | None) -> bool:
    return any((scope.get("scope") or "").upper() == "FULL" for scope in scopes or [])


def collect(report: dict) -> tuple[list[dict], list[dict], dict]:
    simple = report.get("SimpleReport") or {}
    qualifications = qualification_map(report)
    signatures: list[dict] = []
    timestamps: list[dict] = []

    for item in simple.get("signatureOrTimestampOrEvidenceRecord") or []:
        signature = item.get("Signature")

        if signature:
            signature_format = signature.get("SignatureFormat") or ""
            signed_by = signature.get("SignedBy") or ""
            qualification = qualifications.get(signature.get("Id") or "", "")
            indication = signature.get("Indication") or ""
            sub_indication = signature.get("SubIndication") or ""
            kind = "pades" if signature_format.startswith("PAdES") else (
                "seal" if signature_format == "PKCS7-T" or signed_by == "DocuSeal" else "other"
            )

            signatures.append(
                {
                    "kind": kind,
                    "signed_by": signed_by,
                    "format": signature_format,
                    "indication": indication,
                    "sub_indication": sub_indication,
                    "qualification": qualification,
                    "intact": is_intact(indication, sub_indication),
                    "full_scope": scope_is_full(signature.get("SignatureScope")),
                }
            )

            for timestamp in (signature.get("Timestamps") or {}).get("Timestamp") or []:
                indication = timestamp.get("Indication") or ""
                sub_indication = timestamp.get("SubIndication") or ""
                timestamps.append(
                    {
                        "produced_by": timestamp.get("ProducedBy") or "",
                        "indication": indication,
                        "sub_indication": sub_indication,
                        "intact": is_intact(indication, sub_indication),
                        "full_scope": scope_is_full(timestamp.get("TimestampScope")),
                    }
                )

        timestamp = item.get("Timestamp")

        if timestamp:
            indication = timestamp.get("Indication") or ""
            sub_indication = timestamp.get("SubIndication") or ""
            timestamps.append(
                {
                    "produced_by": timestamp.get("ProducedBy") or "",
                    "indication": indication,
                    "sub_indication": sub_indication,
                    "intact": is_intact(indication, sub_indication),
                    "full_scope": scope_is_full(timestamp.get("TimestampScope")),
                }
            )

    policy = (simple.get("ValidationPolicy") or {}).get("PolicyName") or "?"
    return signatures, timestamps, {
        "policy": policy,
        "validation_time": simple.get("ValidationTime") or "?",
    }


def check(path: Path, url: str, timeout: int, require_trusted: bool,
          expect_signatures: int | None) -> tuple[list[str], bool]:
    report = post_pdf(path, url, timeout)
    signatures, timestamps, metadata = collect(report)
    pades = [signature for signature in signatures if signature["kind"] == "pades"]
    seals = [signature for signature in signatures if signature["kind"] == "seal"]
    full_timestamps = [timestamp for timestamp in timestamps if timestamp["full_scope"]]
    errors: list[str] = []

    if not pades:
        errors.append("chybí PAdES podpis")
    if not seals:
        errors.append("chybí pečeť DocuSealu (PKCS7-T)")
    if not full_timestamps:
        errors.append("chybí plně pokrývající časové razítko (DocTS)")
    if any(not signature["intact"] for signature in signatures):
        errors.append("některý podpis není kryptograficky v pořádku")
    if any(not timestamp["intact"] for timestamp in timestamps):
        errors.append("některé časové razítko není kryptograficky v pořádku")
    if expect_signatures is not None and len(signatures) != expect_signatures:
        errors.append(f"počet podpisů {len(signatures)} != {expect_signatures}")

    if require_trusted:
        for signature in pades:
            if signature["indication"] != "TOTAL_PASSED":
                errors.append(
                    f"{signature['signed_by']}: {signature['indication']} "
                    f"({signature['sub_indication'] or 'bez subindikace'})"
                )
            if signature["qualification"] not in TRUSTED_QUALIFICATIONS:
                errors.append(
                    f"{signature['signed_by']}: qualification "
                    f"{signature['qualification'] or '?'} není QES/AdES-QC"
                )

    lines = [
        f"\n# Soubor: {path.name} ({path.stat().st_size} B)",
        f"## EU DSS: {metadata['policy']} · {metadata['validation_time']}",
        f"## Podpisy: {len(signatures)} · časová razítka: {len(timestamps)} "
        f"(plné pokrytí: {len(full_timestamps)})",
    ]

    for signature in signatures:
        lines.append(
            f"- {signature['format'] or '?'}  {signature['signed_by'] or '?'}  "
            f"{signature['indication']}  {signature['qualification'] or '-'}  "
            f"{'FULL' if signature['full_scope'] else 'partial'}"
        )

    for timestamp in timestamps:
        lines.append(
            f"  - TSA {timestamp['produced_by'] or '?'}  {timestamp['indication']}  "
            f"{'FULL' if timestamp['full_scope'] else 'partial'}"
        )

    if errors:
        lines.append("## Výsledek: FAIL")
        lines.extend(f"   - {error}" for error in errors)
    else:
        suffix = "" if require_trusted else " (test cert: trust se nekontroluje)"
        lines.append(f"## Výsledek: OK{suffix}")

    return lines, not errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdfs", nargs="*", help="PDF soubory (výchozí: test/out/qes-final.pdf…)")
    parser.add_argument("--url", default=os.environ.get("QES_EU_DSS_URL") or DEFAULT_URL)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--report", default="qes-eu-dss-report.txt")
    parser.add_argument("--require-trusted", action="store_true",
                        help="vyžadovat TOTAL_PASSED a QES/AdES-QC (reálný cert)")
    parser.add_argument("--expect-signatures", type=int, default=None)
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args()

    paths = [Path(path) for path in args.pdfs] if args.pdfs else [
        Path(path) for path in DEFAULT_PDFS
    ]
    paths = [path if path.is_absolute() else ROOT / path for path in paths]
    paths = list(dict.fromkeys(paths))

    if not paths:
        print("Žádné PDF k ověření (chybí test/out/qes-final.pdf…).", file=sys.stderr)
        return 1

    report_lines = [f"# EU DSS compliance report - {len(paths)} PDF"]
    failed = False
    checked = 0

    for path in paths:
        if not path.exists():
            if args.allow_missing:
                report_lines.append(f"\n# Soubor: {path} — přeskočeno (neexistuje)")
                print(f"Přeskakuji {path} (neexistuje)")
                continue
            print(f"Chybí {path}", file=sys.stderr)
            return 1

        checked += 1

        try:
            lines, ok = check(
                path, args.url, args.timeout, args.require_trusted,
                args.expect_signatures,
            )
        except Exception as error:  # noqa: BLE001 - report musí obsahovat i chybu služby
            lines = [f"\n# Soubor: {path.name}", f"## Výsledek: FAIL", f"   - {error}"]
            ok = False

        failed = failed or not ok
        report_lines.extend(lines)
        print("\n".join(lines))

    if checked == 0:
        print("Žádné existující PDF k ověření.", file=sys.stderr)
        return 1

    report_path = OUT / args.report
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(report_lines) + "\n")

    print(f"\nOK: report v {report_path.relative_to(ROOT)}" if not failed
          else f"\nFAIL: report v {report_path.relative_to(ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
