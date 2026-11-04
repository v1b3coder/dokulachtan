// Test kartového protokolu eOP proti hodnotám odposlechnutým z Linux middleware
// (docs/26-eop-protokol-re.md): AID z ATR, SELECT, GET DATA.
import { aidFromAtr, readDocumentNumber, selectApplet } from '../src/lib/eopCard';

// ATR skutečné eObčanky vydané po 7/2018.
const ATR = Uint8Array.from([
  0x3b, 0x7e, 0x94, 0x00, 0x00, 0x80, 0x25, 0xd2, 0x03, 0x10, 0x01, 0x00, 0x56, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x00,
]);

const AID = 'D20310010001000202';

describe('aidFromAtr', () => {
  it('odvodí AID z ATR (IIN + issuer data)', () => {
    expect(Buffer.from(aidFromAtr(ATR)!).toString('hex').toUpperCase()).toBe(AID);
  });

  // Hypotéza pravidla, ne ověřený fakt: druhý český ATR z pcsc-tools by měl
  // dát AID D2 03 10 01 00 01 00 01 01. Ověřit lze jen druhou kartou.
  it('odvodí AID i pro druhý český ATR (hypotéza pravidla)', () => {
    const second = Uint8Array.from([
      0x3b, 0x7e, 0x94, 0x00, 0x00, 0x80, 0x25, 0xd2, 0x03, 0x10, 0x01, 0x00, 0x56, 0x00, 0x00,
      0x00, 0x01, 0x01, 0x00,
    ]);

    expect(Buffer.from(aidFromAtr(second)!).toString('hex').toUpperCase()).toBe(
      'D20310010001000101',
    );
  });

  it('vrátí null pro cizí ATR', () => {
    expect(aidFromAtr(Uint8Array.from([0x3b, 0x65, 0x00, 0x00, 0x9c, 0x11]))).toBeNull();
  });
});

describe('selectApplet', () => {
  it('vybere applet na logickém kanálu 2 s P2 0x0C', async () => {
    const sent: string[] = [];
    const transmit = async (apdu: string) => {
      sent.push(apdu);
      return '9000';
    };

    await selectApplet(transmit, aidFromAtr(ATR)!);

    expect(sent).toEqual([`02 A4 04 0C 09 ${'D2 03 10 01 00 01 00 02 02'}`]);
  });

  it('zkusí kanál 1, když kanál 2 selže', async () => {
    const sent: string[] = [];
    const transmit = async (apdu: string) => {
      sent.push(apdu);
      return sent.length === 1 ? '6A82' : '9000';
    };

    await selectApplet(transmit, aidFromAtr(ATR)!);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('01 A4 04 0C');
  });
});

describe('readDocumentNumber', () => {
  it('přečte číslo dokladu dvoufázově (délka, pak data)', async () => {
    const sent: string[] = [];
    const transmit = async (apdu: string) => {
      sent.push(apdu);

      // P1 00 vrátí 2bajtovou délku (9), P1 01 data + 9000.
      return sent.length === 1 ? '00099000' : '3231303931303039339000';
    };

    await expect(readDocumentNumber(transmit)).resolves.toBe('210910093');
    expect(sent).toEqual(['81 CA 00 01 02', '81 CA 01 01 09']);
  });

  it('spadne na přímé čtení s 6C retry, když délka nepřijde', async () => {
    const sent: string[] = [];
    const transmit = async (apdu: string) => {
      sent.push(apdu);

      return sent.length === 1 ? '6A88' : sent.length === 2 ? '6C09' : '3231303931303039339000';
    };

    await expect(readDocumentNumber(transmit)).resolves.toBe('210910093');
    expect(sent[0]).toBe('81 CA 00 01 02');
    expect(sent[2]).toBe('81 CA 01 01 09');
  });

  it('vyhodí chybu, když tag selže', async () => {
    await expect(readDocumentNumber(async () => '6A88')).rejects.toThrow('data_tag_failed');
  });
});
