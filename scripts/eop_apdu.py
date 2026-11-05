#!/usr/bin/env python3
"""Přímé APDU na eOP čip přes PC/SC (ctypes), bez middleware.

Protokol je odposlechnutý z Linux middleware (docs/26 § 8): standardní ISO 7816-4,
AID `A0000000288010370202`, plaintext (žádné secure messaging v čtecí cestě).

Proč vlastní klient: `libeop2v1czep11.so` je x86-64 Linux a do appky se nevejde;
appka mluví APDU přímo přes `javax.smartcardio` (ACS EVK). Tenhle skript je
referenční implementace téhož protokolu pro ověření na desktopu.

Bezpečnost PINů: `--attempts` pošle VERIFY **bez dat** (`00 20 00 83`), což je
dotaz na zbývající pokusy — karta odpoví `63Cx` a počítadlo se **nesnižuje**.
Nikdy neposílej VERIFY s daty, pokud nevíš, že kód je správný.

Použití:
  .venv/bin/python scripts/eop_apdu.py --attempts
  .venv/bin/python scripts/eop_apdu.py --cert /tmp/eop-cert.der
  .venv/bin/python scripts/eop_apdu.py --raw 00A4040C0AA0000000288010370202
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import sys
import zlib
from pathlib import Path

# AID appletu, který používá `libeop2v1czep11.so` (na rozdíl od AID odvozeného
# z ATR, které používá starší `libsa2v1czep11.so` s CLA 0x81).
APPLET_AID = bytes.fromhex('A0000000288010370202')

# DF 0x0202 = kontejner "mscp", EF 0x000B = certifikát, EF 0x0004 = jméno.
CONTAINER_DF = b'\x02\x02'
CERT_EF = b'\x00\x0B'

SCARD_S_SUCCESS = 0
SCARD_SCOPE_SYSTEM = 2
SCARD_SHARE_SHARED = 2
SCARD_PROTOCOL_ANY = 3
SCARD_LEAVE_CARD = 0


class IoRequest(ctypes.Structure):
    _fields_ = [('dwProtocol', ctypes.c_ulong), ('cbPciLength', ctypes.c_ulong)]


class Pcsc:
    """Minimální PC/SC klient: connect + transmit, nic víc."""

    def __init__(self, reader: str | None = None) -> None:
        self.lib = ctypes.CDLL(ctypes.util.find_library('pcsclite') or 'libpcsclite.so.1')
        self.ctx = ctypes.c_ulong()
        self.card = ctypes.c_ulong()
        self.proto = ctypes.c_ulong()
        self._check(self.lib.SCardEstablishContext(SCARD_SCOPE_SYSTEM, None, None,
                                                  ctypes.byref(self.ctx)), 'SCardEstablishContext')
        name = reader or self._first_reader()
        self._check(self.lib.SCardConnect(self.ctx, name.encode(), SCARD_SHARE_SHARED,
                                         SCARD_PROTOCOL_ANY, ctypes.byref(self.card),
                                         ctypes.byref(self.proto)), 'SCardConnect')
        self.reader = name

    def _first_reader(self) -> str:
        needed = ctypes.c_ulong(0)
        self.lib.SCardListReaders(self.ctx, None, None, ctypes.byref(needed))
        buf = ctypes.create_string_buffer(needed.value)
        self._check(self.lib.SCardListReaders(self.ctx, None, buf, ctypes.byref(needed)),
                    'SCardListReaders')
        names = [n for n in buf.raw[:needed.value].split(b'\0') if n]
        if not names:
            raise SystemExit('žádná čtečka')
        return names[0].decode()

    def _check(self, rv: int, what: str) -> None:
        if rv != SCARD_S_SUCCESS:
            raise SystemExit(f'{what} selhalo: 0x{rv & 0xFFFFFFFF:08X}')

    def transmit(self, apdu: bytes) -> bytes:
        pci = IoRequest(self.proto.value, ctypes.sizeof(IoRequest))
        out = ctypes.create_string_buffer(4096)
        out_len = ctypes.c_ulong(len(out))
        self._check(self.lib.SCardTransmit(self.card, ctypes.byref(pci), apdu, len(apdu),
                                          None, out, ctypes.byref(out_len)), 'SCardTransmit')
        return out.raw[:out_len.value]

    def close(self) -> None:
        if self.card.value:
            self.lib.SCardDisconnect(self.card, SCARD_LEAVE_CARD)
            self.card = ctypes.c_ulong()
        if self.ctx.value:
            self.lib.SCardReleaseContext(self.ctx)
            self.ctx = ctypes.c_ulong()


def sw(resp: bytes) -> int:
    return (resp[-2] << 8) | resp[-1] if len(resp) >= 2 else 0


def apdu(ins: int, p1: int = 0, p2: int = 0, data: bytes = b'', le: int | None = None) -> bytes:
    """Case 1 bez Le, case 2 s Le, case 3 s Lc, case 4 s Lc i Le."""
    body = bytes([0x00, ins, p1, p2])
    if data:
        body += bytes([len(data)]) + data
    if le is not None:
        body += bytes([le])
    return body


def select_aid(card: Pcsc) -> None:
    resp = card.transmit(apdu(0xA4, 0x04, 0x0C, APPLET_AID))
    if sw(resp) != 0x9000:
        raise SystemExit(f'SELECT AID selhalo: {sw(resp):04X}')


def select_file(card: Pcsc, fid: bytes, fci: bool) -> bytes:
    """Vybere DF (P1=00 P2=00, s FCI) nebo EF (P1=02 P2=00, s FCI)."""
    p1, p2 = (0x02, 0x00) if fci else (0x00, 0x00)
    resp = card.transmit(apdu(0xA4, p1, p2, fid))
    if (sw(resp) >> 8) == 0x61:
        resp = card.transmit(apdu(0xC0, 0x00, 0x00, le=resp[-1]))
    elif (sw(resp) >> 8) == 0x6C:
        resp = card.transmit(apdu(0xA4, p1, p2, fid, le=resp[-1]))
    if sw(resp) != 0x9000:
        raise SystemExit(f'SELECT {fid.hex()} selhalo: {sw(resp):04X}')
    return resp[:-2]


def read_binary(card: Pcsc, length: int) -> bytes:
    out = b''
    while len(out) < length:
        chunk = min(0xDC, length - len(out))
        resp = card.transmit(apdu(0xB0, (len(out) >> 8) & 0x7F, len(out) & 0xFF, le=chunk))
        if sw(resp) != 0x9000:
            raise SystemExit(f'READ BINARY @{len(out)} selhalo: {sw(resp):04X}')
        out += resp[:-2]
    return out


def attempts(card: Pcsc) -> dict[int, int]:
    """VERIFY bez dat = dotaz na zbývající pokusy; počítadlo se nesnižuje."""
    names = {0x81: 'MRZ', 0x82: 'CAN', 0x83: 'PIN', 0x84: 'PUK', 0x85: '?', 0x86: '?', 0x87: '?'}
    out = {}
    for p2, name in names.items():
        resp = card.transmit(apdu(0x20, 0x00, p2))
        code = sw(resp)
        if (code >> 8) == 0x63:
            out[p2] = code & 0x0F
            print(f'{name:4s} (P2 {p2:02X}): {code & 0x0F} pokusů')
        elif code == 0x6A88:
            print(f'{name:4s} (P2 {p2:02X}): neexistuje')
        else:
            print(f'{name:4s} (P2 {p2:02X}): {code:04X}')
    return out


def read_cert(card: Pcsc) -> bytes:
    select_aid(card)
    select_file(card, CONTAINER_DF, fci=False)
    fci = select_file(card, CERT_EF, fci=True)
    size = fci_size(fci)
    if not size:
        raise SystemExit('FCI bez velikosti')
    raw = read_binary(card, size)
    # Obsah EF je zlib (78 9C), certifikát je až po dekompresi.
    return zlib.decompress(raw) if raw[:2] == b'\x78\x9C' else raw


def fci_size(fci: bytes) -> int:
    """V FCI najde tag 0x81 (velikost souboru); obal 6F se přeskakuje."""
    i = 2 if fci[:1] == b'\x6F' else 0
    while i + 1 < len(fci):
        tag, length = fci[i], fci[i + 1]
        if tag == 0x81 and length in (1, 2):
            return int.from_bytes(fci[i + 2:i + 2 + length], 'big')
        i += 2 + length
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--reader')
    ap.add_argument('--attempts', action='store_true', help='dotaz na pokusy (bezpečné)')
    ap.add_argument('--cert', type=Path, help='zapsat certifikát (DER)')
    ap.add_argument('--raw', help='poslat APDU po bajtech (hex)')
    args = ap.parse_args()

    card = Pcsc(args.reader)
    try:
        print(f'čtečka: {card.reader}')
        if args.attempts:
            attempts(card)
        elif args.cert:
            der = read_cert(card)
            args.cert.write_bytes(der)
            print(f'certifikát: {len(der)} B -> {args.cert}')
        elif args.raw:
            resp = card.transmit(bytes.fromhex(args.raw))
            print(f'-> {resp.hex().upper()}')
        else:
            ap.error('zvol --attempts, --cert nebo --raw')
    finally:
        card.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
