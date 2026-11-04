// Kartový protokol eObčanky (eOP), odposlechnutý z Linux middleware.
// Detaily a důkazy: docs/26-eop-protokol-re.md.
//
// Karta používá logické kanály a proprietární třídu `CLA 0x81`; standardní
// `SELECT MF` (CLA 0x00) odmítá. AID se odvozuje z ATR (IIN + issuer data),
// není to pevná konstanta.

export type Transmit = (apduHex: string) => Promise<string>;

/** Chyba kartového protokolu s kódem, který UI umí přeložit. */
export class EopCardError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const SELECT_AID_CHANNELS = [0x02, 0x01];

/** Vrátí AID appletu odvozené z ATR, nebo null když ATR není eOP. */
export function aidFromAtr(atr: Uint8Array): Uint8Array | null {
  // ATR: 3B 7E 94 00 00 | historické bajty (14 B)
  // Historické bajty: 80 (compact TLV) | tag 2 len 5 (IIN) | tag 5 len 6 (issuer)
  if (atr.length < 5 + 14) {
    return null;
  }

  const historical = atr.slice(5);

  if (historical[0] !== 0x80) {
    return null;
  }

  const iin = readCompactTlv(historical, 1, 2);

  if (!iin) {
    return null;
  }

  // AID = IIN (5 B) + 01 + poslední 3 bajty ATR v opačném pořadí
  const aid = new Uint8Array(9);
  aid.set(iin, 0);
  aid[5] = 0x01;
  aid[6] = atr[atr.length - 1];
  aid[7] = atr[atr.length - 2];
  aid[8] = atr[atr.length - 3];

  return aid;
}

// Compact TLV (ISO 7816-4 Annex D): tag = horních 4 bity, len = dolní 3 bity.
function readCompactTlv(buf: Uint8Array, offset: number, expectedTag: number): Uint8Array | null {
  if (offset + 1 > buf.length) {
    return null;
  }

  const tag = (buf[offset] >> 4) & 0x0f;
  const len = buf[offset] & 0x07;
  const start = offset + 1;

  if (tag !== expectedTag || start + len > buf.length) {
    return null;
  }

  return buf.slice(start, start + len);
}

/** Vybere applet karty na logickém kanálu (P2 0x0C = bez FCI). */
export async function selectApplet(transmit: Transmit, aid: Uint8Array): Promise<void> {
  const data = toHex(aid);

  for (const channel of SELECT_AID_CHANNELS) {
    const sw = await send(transmit, `${hex(channel)} A4 04 0C ${hex(aid.length)} ${data}`);

    if (sw === 0x9000) {
      return;
    }
  }

  throw new EopCardError('applet_not_found');
}

// Kanonické čtení je dvoufázové: P1 00 vrátí 2bajtovou délku, P1 01 data.
// Když karta délku nevrátí, zkusí se přímé čtení s 6C xx (wrong length) retry.
export async function readDataTag(transmit: Transmit, tag: number): Promise<Uint8Array> {
  const size = await sendWithData(transmit, `81 CA 00 ${hex(tag)} 02`);

  if (size.sw === 0x9000 && size.data.length === 2) {
    const length = (size.data[0] << 8) | size.data[1];
    const data = await sendWithData(transmit, `81 CA 01 ${hex(tag)} ${hex(length)}`);

    if (data.sw === 0x9000) {
      return data.data;
    }

    throw new EopCardError('data_tag_failed');
  }

  const direct = await sendWithData(transmit, `81 CA 01 ${hex(tag)} 00`);

  if (direct.sw === 0x9000) {
    return direct.data;
  }

  if ((direct.sw >> 8) === 0x6c) {
    const le = direct.sw & 0xff;
    const retry = await sendWithData(transmit, `81 CA 01 ${hex(tag)} ${hex(le)}`);

    if (retry.sw === 0x9000) {
      return retry.data;
    }
  }

  throw new EopCardError('data_tag_failed');
}

/** Přečte číslo dokladu (tag 0x01) jako ASCII. */
export async function readDocumentNumber(transmit: Transmit): Promise<string> {
  const data = await readDataTag(transmit, 0x01);

  return String.fromCharCode(...data);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

/** Pošle APDU a vrátí SW. */
async function send(transmit: Transmit, apduHex: string): Promise<number> {
  const response = await transmit(apduHex);
  const bytes = fromHex(response);

  if (bytes.length < 2) {
    throw new EopCardError('invalid_response');
  }

  return (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
}

/** Pošle APDU a vrátí data + SW. */
async function sendWithData(transmit: Transmit, apduHex: string): Promise<{ data: Uint8Array; sw: number }> {
  const bytes = fromHex(await transmit(apduHex));

  if (bytes.length < 2) {
    throw new EopCardError('invalid_response');
  }

  return {
    data: bytes.slice(0, bytes.length - 2),
    sw: (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1],
  };
}

function fromHex(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '');

  if (clean.length % 2 !== 0) {
    throw new EopCardError('invalid_hex');
  }

  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16));
}
