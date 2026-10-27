#!/usr/bin/env python3
"""Vygeneruje lokální testovací PKI pro negativní scénáře:

- root CA (RSA 3072) s CRL Distribution Points na 127.0.0.1:8765 a staging hostu
- signer AdES (QCStatements: QcCompliance, bez QcSSCD)  -> AdES
- signer QSCD (QCStatements: QcCompliance + QcSSCD)    -> QES-capable
- signer expirovaný (validita v minulosti)               -> EXPIRED
- prázdný CRL a CRL se zneplatněným AdES certifikátem   -> REVOKED
- PKCS#12 pro e2e/appku: signer-ades.p12, signer-qscd.p12 (heslo `test`, s řetězem root.crt)

Veřejné certy a CRL jdou do test/certs/pki/, privátní root klíč do
test/certs-private/ (gitignored, TEST_PKI_DIR).
"""
from __future__ import annotations

import datetime as dt
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID, ObjectIdentifier

P12_PASSWORD = b"test"

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "certs" / "pki"
PRIVATE = Path(os.environ.get("TEST_PKI_DIR", ROOT / "test" / "certs-private"))
CRL_DPS = [
    "http://127.0.0.1:8765/root.crl",
    "https://dokulachtan-staging.fly.dev/qes-test/root.crl",
]
QC_STATEMENTS_OID = ObjectIdentifier("1.3.6.1.5.5.7.1.3")

# QCStatements = SEQUENCE OF QCStatement; QCStatement = SEQUENCE { statementId OID }
QC_COMPLIANCE = bytes.fromhex("3008060604008E460101")  # 0.4.0.1862.1.1 QcCompliance
QC_SSCD = bytes.fromhex("3008060604008E460104")        # 0.4.0.1862.1.4 QcSSCD
QC_COMPLIANCE_ONLY = bytes.fromhex("300A") + QC_COMPLIANCE
QC_COMPLIANCE_SSCD = bytes.fromhex("3014") + QC_COMPLIANCE + QC_SSCD


def key(bits: int = 3072):
    return rsa.generate_private_key(public_exponent=65537, key_size=bits)


def name(cn: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CZ"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Dokulachtan Test"),
            x509.NameAttribute(NameOID.COMMON_NAME, cn),
        ]
    )


def write(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    print(f"  {path.relative_to(OUT.parent.parent.parent)}")


def build_cert(
    subject: x509.Name,
    issuer: x509.Name,
    pubkey,
    issuer_key,
    serial: int,
    not_before: dt.datetime,
    not_after: dt.datetime,
    *,
    ca: bool = False,
    qc_statements: bytes | None = None,
) -> x509.Certificate:
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(pubkey)
        .serial_number(serial)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=not ca,
                content_commitment=not ca,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=ca,
                crl_sign=ca,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(pubkey), critical=False)
        .add_extension(
            x509.CRLDistributionPoints(
                [
                    x509.DistributionPoint(
                        full_name=[x509.UniformResourceIdentifier(url) for url in CRL_DPS],
                        relative_name=None,
                        reasons=None,
                        crl_issuer=None,
                    )
                ]
            ),
            critical=False,
        )
    )
    if qc_statements is not None:
        builder = builder.add_extension(
            x509.UnrecognizedExtension(QC_STATEMENTS_OID, qc_statements), critical=False
        )
    return builder.sign(issuer_key, hashes.SHA256())


def build_crl(root_name, root_key, revoked_serial: int | None) -> bytes:
    now = dt.datetime.now(dt.timezone.utc)
    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(root_name)
        .last_update(now - dt.timedelta(days=1))
        .next_update(now + dt.timedelta(days=3650))
    )
    if revoked_serial is not None:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder()
            .serial_number(revoked_serial)
            .revocation_date(now - dt.timedelta(hours=1))
            .build()
        )
    return builder.sign(root_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)

    root_key = key()
    root_name = name("Dokulachtan Test Root CA")
    root_cert = build_cert(
        root_name, root_name, root_key.public_key(), root_key,
        serial=1, not_before=now - dt.timedelta(days=1),
        not_after=now + dt.timedelta(days=3650), ca=True,
    )
    write(PRIVATE / "root.key", root_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    write(OUT / "root.crt", root_cert.public_bytes(serialization.Encoding.PEM))

    def signer(cn: str, serial: int, qc: bytes | None, not_before=None, not_after=None):
        k = key(2048)
        cert = build_cert(
            name(cn), root_name, k.public_key(), root_key, serial=serial,
            not_before=not_before or now - dt.timedelta(days=1),
            not_after=not_after or now + dt.timedelta(days=730),
            qc_statements=qc,
        )
        write(OUT / f"{cn}.key", k.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))
        write(OUT / f"{cn}.crt", cert.public_bytes(serialization.Encoding.PEM))
        return cert, k

    def write_p12(path: Path, signer_key, cert, chain) -> None:
        data = pkcs12.serialize_key_and_certificates(
            name=None, key=signer_key, cert=cert, cas=chain,
            encryption_algorithm=serialization.BestAvailableEncryption(P12_PASSWORD),
        )
        write(path, data)

    ades, ades_key = signer("signer-ades", 0x1001, QC_COMPLIANCE_ONLY)
    qscd, qscd_key = signer("signer-qscd", 0x1002, QC_COMPLIANCE_SSCD)
    expired, _expired_key = signer(
        "signer-expired", 0x1003, QC_COMPLIANCE_ONLY,
        not_before=now - dt.timedelta(days=800), not_after=now - dt.timedelta(days=30),
    )

    write_p12(OUT / "signer-ades.p12", ades_key, ades, [root_cert])
    write_p12(OUT / "signer-qscd.p12", qscd_key, qscd, [root_cert])

    write(OUT / "root.crl", build_crl(root_name, root_key, None))
    write(OUT / "root-revoked.crl", build_crl(root_name, root_key, ades.serial_number))
    write(OUT / "revoked-serial.txt", f"{ades.serial_number}\n".encode())

    print("OK: test/certs/pki/ (certy, klíče, PKCS#12, CRL) + test/certs-private/root.key")
    print("POZOR: regenerace změnila root.crt; zkopíruj ho do forku (config/qes/root.crt) a aktualizuj staging trust.")


if __name__ == "__main__":
    main()
