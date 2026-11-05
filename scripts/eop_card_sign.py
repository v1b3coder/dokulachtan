#!/usr/bin/env python3
"""Reálná čtečka (F4d): eOP čip — průzkum protokolu a podpis PDF.

Protokol je odposlechnutý a ověřený 2026-11-05 (docs/26 § 7):

  1. C_Login(CKU_USER, PIN)          jednorázově odemkne kartu (PIN 5–15 číslic)
  2. C_SignInit(SHA256-RSA-PKCS, key) připraví kontext
  3. C_Sign(...)                      ovladač zobrazí dialog „Verification of
                                      signature PIN (QPIN)"; QPIN se zadává
                                      při každém kvalifikovaném podpisu
  4. výsledek = raw RSA podpis DER podepsaných atributů CMS (ne digest PDF)

pyHanko dodá v `async_sign_raw` DER podepsaných atributů; karta podepíše je.
LTV/DSS zůstává mimo CMS (rozhodnutí #5).

Použití:
  .venv/bin/python scripts/eop_card_sign.py --probe
  EOP_PIN=... .venv/bin/python scripts/eop_card_sign.py --sign
  .venv/bin/python scripts/eop_card_sign.py --verify /tmp/eop-signed.pdf

`--sign` potřebuje `python-pkcs11` (v requirements-qes.txt) a pyHanko z venv.

QPIN se nezadává přes `C_Login`: ovladač ho vyžádá vlastním dialogem během
`C_Sign` (proto se v headless prostředí spouští přes `xvfb-run` + `xdotool`).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

PKCS11_MODULE = '/usr/lib/x86_64-linux-gnu/libeop2v1czep11.so'
TOKEN_LABEL = 'eOP2v1 CZE 210910093'
CERT_CACHE = Path('/tmp/eop-card-cert.der')
CERT_ID = '695369676e756d2032303236313130342d313433323133'

# OID, které rozhodují QES vs. AdES (ETSI EN 319 412-5).
QC_OIDS = {
    '0.4.0.1862.1.1': 'QcCompliance',
    '0.4.0.1862.1.4': 'QcSSCD',
    '0.4.0.194112.1.3': 'QcSSCD (starší)',
}


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def probe() -> int:
    atr = run(['opensc-tool', '--reader', '0', '--atr']).strip()
    print(f'ATR      : {atr}')
    slots = run(['pkcs11-tool', '--module', PKCS11_MODULE, '-L'])
    print(slots.strip())

    if not CERT_CACHE.exists():
        run(['pkcs11-tool', '--module', PKCS11_MODULE, '--read-object',
             '--type', 'cert', '--id', CERT_ID, '-o', str(CERT_CACHE)])

    from asn1crypto import x509
    cert = x509.Certificate.load(CERT_CACHE.read_bytes())
    print(f'subject  : {cert.subject.human_friendly}')
    print(f'issuer   : {cert.issuer.human_friendly}')

    from asn1crypto.core import Any, ObjectIdentifier, Sequence, SequenceOf

    class QCStatement(Sequence):
        _fields = [('statement_id', ObjectIdentifier),
                   ('statement_info', Any, {'optional': True})]

    class QCStatements(SequenceOf):
        _child_spec = QCStatement

    names = []
    for ext in cert['tbs_certificate']['extensions']:
        if ext['extn_id'].dotted == '1.3.6.1.5.5.7.1.3':
            for st in QCStatements.load(ext['extn_value'].native):
                oid = st['statement_id'].dotted
                if oid in QC_OIDS:
                    names.append(QC_OIDS[oid])

    print(f'QcSSCD   : {"ano" if names else "NE"} ({", ".join(names) or "—"})')
    return 0


def card_signer(pin: str):
    try:
        import pkcs11
    except ImportError:
        print('chybí python-pkcs11: .venv/bin/pip install python-pkcs11')
        raise SystemExit(1)

    from pkcs11 import Attribute, ObjectClass

    lib = pkcs11.lib(PKCS11_MODULE)
    token = lib.get_token(token_label=TOKEN_LABEL)
    try:
        session = token.open(user_pin=pin)
    except pkcs11.exceptions.PinIncorrect:
        print('STOP: PIN odmítnut; další pokus karta zablokuje.')
        raise SystemExit(2)
    except pkcs11.exceptions.PinLocked:
        print('STOP: karta hlásí PIN zablokovaný.')
        raise SystemExit(2)

    key = next(session.get_objects({Attribute.CLASS: ObjectClass.PRIVATE_KEY}))
    print(f'login OK, klíč: {key.label}')

    def sign(data: bytes, digest_algorithm: str) -> bytes:
        mech = getattr(pkcs11.Mechanism, f'{digest_algorithm.upper()}_RSA_PKCS')
        # QPIN zadává uživatel v dialogu ovladače během C_Sign.
        return bytes(key.sign(data, mechanism=mech))

    return session, sign


def sign(pdf: Path, out: Path) -> int:
    from asn1crypto import x509
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers
    from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata, PdfSigner
    from pyhanko_certvalidator.registry import SimpleCertificateStore

    cert = x509.Certificate.load(CERT_CACHE.read_bytes())
    session, raw_sign = card_signer(os.environ['EOP_PIN'])

    class RawSigner(signers.Signer):
        def __init__(self, signing_cert, cert_registry):
            self._raw_sign = raw_sign
            super().__init__(signing_cert=signing_cert, cert_registry=cert_registry)

        async def async_sign_raw(self, data: bytes, digest_algorithm: str, dry_run=False) -> bytes:
            return b'\0' * 256 if dry_run else self._raw_sign(data, digest_algorithm)

    registry = SimpleCertificateStore()
    registry.register(cert)
    meta = PdfSignatureMetadata(field_name='Signature1', md_algorithm='sha256')

    with open(pdf, 'rb') as f:
        w = IncrementalPdfFileWriter(f)
        with open(out, 'wb') as o:
            PdfSigner(meta, RawSigner(cert, registry)).sign_pdf(w, output=o)

    session.close()
    print(f'podepsáno: {out}')
    return verify(out)


def verify(pdf: Path) -> int:
    from asn1crypto import x509
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    cert = x509.Certificate.load(CERT_CACHE.read_bytes())
    vc = ValidationContext(trust_roots=[cert], allow_fetching=False)

    with open(pdf, 'rb') as f:
        for sig in PdfFileReader(f).embedded_signatures:
            status = validate_pdf_signature(sig, signer_validation_context=vc)
            print(f'pole={sig.field_name} valid={status.valid} intact={status.intact} '
                  f'coverage={status.coverage}')
            print(f'podepsal={sig.signer_cert.subject.human_friendly}')

    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', action='store_true', help='jen čtení, bez PINu')
    ap.add_argument('--sign', action='store_true', help='podepsat PDF (EOP_PIN)')
    ap.add_argument('--verify', metavar='PDF', type=Path, help='ověřit podepsané PDF')
    ap.add_argument('--pdf', type=Path, default=Path('test/fixtures/input.pdf'))
    ap.add_argument('--out', type=Path, default=Path('/tmp/eop-signed.pdf'))
    args = ap.parse_args()

    if args.probe:
        return probe()
    if args.sign:
        return sign(args.pdf, args.out)
    if args.verify:
        return verify(args.verify)

    ap.error('zvol --probe, --sign nebo --verify')


if __name__ == '__main__':
    sys.exit(main())
