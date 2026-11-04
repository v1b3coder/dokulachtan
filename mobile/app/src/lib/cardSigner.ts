// Varianta A (eObčanka) — SPEC § 9.4: MOI Podpisové SDK přes BLE čtečku.
// Fyzická čtečka je mimo rozsah této fáze: rozhraní je hotové, implementace
// `StubCardSigner` vrací `reader_not_found` a `FakeCardSigner` umí celý tok
// s testovacím certifikátem (EXPO_PUBLIC_QES_FAKE_CARD=1, SPEC § 15.3).
import {
  cardDeviceInfo,
  connectCardReader,
  disconnectCardReader,
  isCardReaderAvailable,
  scanCardReaders,
  transmitApdu,
  type CardDeviceInfo,
} from '../../modules/dokulachtan-card-reader';
import { aidFromAtr, EopCardError, readDocumentNumber, selectApplet } from './eopCard';
import { parseP12 } from './crypto/p12';
import { signSignedAttrs, toBase64 } from './crypto/softwareSigner';
import { TEST_P12_PASSWORD, TEST_QSCD_P12_BASE64 } from './testCertificate';

export interface CardContainer {
  id: string;
  label: string;
  certificatePem: string;
  level: 'qes' | 'ades' | 'none';
}

export interface CardCertificate {
  certificatePem: string;
  chainPems: string[];
}

export interface CardSigner {
  readonly kind: 'card';
  initializeSession(): Promise<void>;
  listContainers(): Promise<CardContainer[]>;
  getCertificate(containerId: string): Promise<CardCertificate>;
  signData(containerId: string, dataToSign: Uint8Array, pin?: string): Promise<Uint8Array>;
  finalizeSession(): Promise<void>;
}

export class CardSignerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// ACS EVK (`acssmcio`): scan LE-only, connect, device info, baterie a APDU přes
// standardní javax.smartcardio. Kartový info protokol je v `eopCard.ts`.
// Podpisový protokol řeší knihovna, ale karta bez certu ho neodemkne.
export class AcsCardSigner implements CardSigner {
  readonly kind = 'card' as const;

  private readerName: string | null = null;
  private info: CardDeviceInfo | null = null;

  async initializeSession(): Promise<void> {
    const readers = await withCardErrors(() => scanCardReaders());

    if (readers.length === 0) {
      throw new CardSignerError('reader_not_found');
    }

    const reader = await withCardErrors(() => connectCardReader(readers[0].name));

    this.readerName = reader.name;
    this.info = await withCardErrors(() => cardDeviceInfo());
  }

  async listContainers(): Promise<CardContainer[]> {
    if (!this.readerName) {
      throw new CardSignerError('reader_disconnected');
    }

    // Karta bez certu: žádný kontejner k podpisu.
    throw new CardSignerError('no_qualified_certificate');
  }

  async getCertificate(): Promise<CardCertificate> {
    throw new CardSignerError('no_qualified_certificate');
  }

  async signData(): Promise<Uint8Array> {
    throw new CardSignerError('no_qualified_certificate');
  }

  async finalizeSession(): Promise<void> {
    try {
      await disconnectCardReader();
    } catch {
      // Odpojení nesmí nechat appku ve stavu „připojeno“.
    }

    this.readerName = null;
    this.info = null;
  }

  /** Číslo dokladu z čipu (tag 0x01), čitelné bez PINu. */
  async readDocumentNumber(): Promise<string> {
    if (!this.readerName) {
      throw new CardSignerError('reader_disconnected');
    }

    // ATR se čte přes PC/SC vrstvu knihovny, tady ho nahradíme konstantou
    // odposlechnutou z karty (docs/26). AID je z ATR odvozené.
    const aid = aidFromAtr(ATR_EOP);

    if (!aid) {
      throw new CardSignerError('applet_not_found');
    }

    return withCardErrors(async () => {
      await selectApplet(transmitApdu, aid);

      return readDocumentNumber(transmitApdu);
    });
  }

  get deviceInfo(): CardDeviceInfo | null {
    return this.info;
  }
}

const CARD_READER_CODES = new Set([
  'reader_not_found',
  'reader_disconnected',
  'reader_error',
]);

// Přeloží chybu transportu nebo kartového protokolu na kód, který UI zná.
async function withCardErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof CardSignerError) {
      throw err;
    }

    if (err instanceof EopCardError) {
      throw new CardSignerError(err.code);
    }

    // Kódy z nativního modulu (CodedException) už UI zná.
    const code = (err as { code?: unknown }).code;

    if (typeof code === 'string' && CARD_READER_CODES.has(code)) {
      throw new CardSignerError(code);
    }

    throw new CardSignerError('reader_error');
  }
}

// ATR eObčanky vydané po 7/2018 (docs/26).
const ATR_EOP = Uint8Array.from([
  0x3b, 0x7e, 0x94, 0x00, 0x00, 0x80, 0x25, 0xd2, 0x03, 0x10, 0x01, 0x00, 0x56, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x00,
]);

// Zatím jen stub — interakce s fyzickou čtečkou (BLE párování, QPIN dialog).
export class StubCardSigner implements CardSigner {
  readonly kind = 'card' as const;

  async initializeSession(): Promise<void> {
    throw new CardSignerError('reader_not_found');
  }

  async listContainers(): Promise<CardContainer[]> {
    throw new CardSignerError('reader_not_found');
  }

  async getCertificate(): Promise<CardCertificate> {
    throw new CardSignerError('reader_not_found');
  }

  async signData(): Promise<Uint8Array> {
    throw new CardSignerError('reader_not_found');
  }

  async finalizeSession(): Promise<void> {
    return undefined;
  }
}

// Dev mód bez hardwaru: stejné rozhraní, podepisuje testovacím QSCD certem
// (SPEC § 15.3) — server vyžaduje key_location=card => QcSSCD.
export class FakeCardSigner implements CardSigner {
  readonly kind = 'card' as const;

  private parsed: ReturnType<typeof parseP12> | null = null;

  async initializeSession(): Promise<void> {
    this.parsed = parseP12(base64ToBytes(TEST_QSCD_P12_BASE64), TEST_P12_PASSWORD, {
      allowQscd: true,
    });
  }

  async listContainers(): Promise<CardContainer[]> {
    if (!this.parsed) {
      await this.initializeSession();
    }

    return [
      {
        id: 'fake-container-1',
        label: this.parsed!.subject,
        certificatePem: this.parsed!.certificatePem,
        level: 'qes',
      },
    ];
  }

  async getCertificate(_containerId: string): Promise<CardCertificate> {
    if (!this.parsed) {
      await this.initializeSession();
    }

    return {
      certificatePem: this.parsed!.certificatePem,
      chainPems: this.parsed!.chainPems,
    };
  }

  async signData(_containerId: string, dataToSign: Uint8Array): Promise<Uint8Array> {
    if (!this.parsed) {
      await this.initializeSession();
    }

    return signSignedAttrs(this.parsed!.privateKeyPem, dataToSign);
  }

  async finalizeSession(): Promise<void> {
    this.parsed = null;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createCardSigner(fakeCard: boolean): CardSigner {
  if (fakeCard) {
    return new FakeCardSigner();
  }

  return isCardReaderAvailable() ? new AcsCardSigner() : new StubCardSigner();
}
