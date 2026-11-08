#!/usr/bin/env python3
"""eOP: průzkum SM handshake (EXTERNAL AUTHENTICATE) bez PINu.

Podle docs/26 § 13 se SSC **negenereuje**, ale **čte** z karty:

  00 A6 00 00        -> 6C 12        (délka 18)
  00 A6 00 00 12     -> 18 B 9000    (4 B + 4 B SSC + 10 B AID)

Pak se stejný SSC pošle zpět v `MSE:Set DST`:

  00 A6 00 00 12 <8 B SSC> <10 B AID>  -> 9000

Následuje `MSE:Set AT` a `GET CHALLENGE`; teprve pak se posílá
`EXTERNAL AUTHENTICATE`. Skript nic z toho neposílá jako PIN, ale každý
`EXTERNAL AUTHENTICATE` **spotřebuje jeden pokus z interního counteru na
kartě** (start 15, `63 CF` → `63 C0`); po 15. pokusu karta applet
invaliduje (`62 83`) a obnovit ho z PC nelze (docs/26 § 14.1, § 17).
Proto je `EXTERNAL AUTHENTICATE` ve výchozím stavu vypnutý a pouští se
jen s `--allow-external-auth`.

Použití:
  .venv/bin/python scripts/eop_sm_probe.py
  .venv/bin/python scripts/eop_sm_probe.py --ssc 3B9166EA8B24197D
  .venv/bin/python scripts/eop_sm_probe.py --allow-external-auth

Poznámka: middleware drží kartu po chybném APDU ve stavu
`SCARD_E_NOT_TRANSACTED`; pomůže jen fyzický cold reset (docs/26 § 14.1).
"""
from __future__ import annotations

import argparse
import os
import sys

from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from eop_apdu import Pcsc, apdu, sw, APPLET_AID  # noqa: E402


def show(card: Pcsc, label: str, data: bytes) -> bytes:
    r = card.transmit(data)
    print(f'{label:14s} {data.hex().upper()} -> {r.hex().upper()}')
    return r


def get_data(card: Pcsc, ins: int, p1: int, p2: int) -> bytes:
    r = show(card, 'GET DATA', apdu(ins, p1, p2))
    if (sw(r) >> 8) == 0x6C:
        r = show(card, 'GET DATA', apdu(ins, p1, p2, le=r[-1]))
    if (sw(r) >> 8) == 0x61:
        r = show(card, 'GET RESPONSE', apdu(0xC0, 0x00, 0x00, le=r[-1]))
    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--ssc', help='vynutit 8B SSC (hex); jinak se přečte z karty')
    ap.add_argument('--allow-external-auth', action='store_true',
                    help='povolí EXTERNAL AUTHENTICATE; každý pokus sníží interní '
                         'counter karty a po 15 applet invaliduje (docs/26 § 14.1, § 17)')
    args = ap.parse_args()

    card = Pcsc()
    try:
        print(f'čtečka: {card.reader}')
        show(card, 'SELECT AID', apdu(0xA4, 0x04, 0x0C, APPLET_AID))

        # 1) SSC z karty (get_reset_select_info): 4 B + 4 B + 10 B AID.
        r = get_data(card, 0xA6, 0x00, 0x00)
        info = r[:-2]
        if len(info) < 18:
            print(f'CHYBA: reset select info má {len(info)} B, čekáno 18')
            return 1
        ssc = info[:8]
        aid = info[8:18]
        print(f'SSC z karty: {ssc.hex().upper()}  AID: {aid.hex().upper()}')
        if args.ssc:
            ssc = bytes.fromhex(args.ssc)
            print(f'SSC vynucené: {ssc.hex().upper()}')

        # 2) SSC zpět do karty (MSE:Set DST) a MSE:Set AT (AES-128).
        show(card, 'MSE:Set DST', apdu(0xA6, 0x00, 0x00, ssc + aid))
        show(card, 'MSE:Set AT', bytes.fromhex('0022C1A40980018C830101950180'))

        # 3) Challenge a efemérní P-256 pár.
        r = show(card, 'GET CHALLENGE', apdu(0x84, 0x00, 0x00, le=8))
        challenge = r[:-2]
        priv = ec.generate_private_key(ec.SECP256R1())
        nums = priv.public_key().public_numbers()
        pub = nums.x.to_bytes(32, 'big') + nums.y.to_bytes(32, 'big')
        print(f'challenge: {challenge.hex().upper()}')
        print(f'náš pubkey: {pub.hex().upper()}')

        # 4) EXTERNAL AUTHENTICATE: 8 B + 64 B pubkey + 8 B (MAC zatím neznámý).
        if not args.allow_external_auth:
            print('EXTERNAL AUTHENTICATE přeskočen: bez --allow-external-auth '
                  'by spotřeboval pokus z interního counteru karty (15 → 0 = invalidace appletu).')
            return 0
        ext = challenge + pub + bytes(8)
        r = show(card, 'EXTERNAL AUTH', apdu(0x82, 0x00, 0x00, ext))
        if (sw(r) >> 8) == 0x61:
            show(card, 'GET RESPONSE', apdu(0xC0, 0x00, 0x00, le=r[-1]))
    finally:
        card.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
