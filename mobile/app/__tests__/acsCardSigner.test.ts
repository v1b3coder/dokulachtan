// Chybové cesty S8 (SPEC § 9.1): čtečka nenalezena, karta není vložena,
// karta není eOP, čtení čipu selhalo, karta bez certifikátu.
import {
  cardDeviceInfo,
  connectCardReader,
  disconnectCardReader,
  isCardReaderAvailable,
  scanCardReaders,
  transmitApdu,
} from '../modules/dokulachtan-card-reader';
import { AcsCardSigner, CardSignerError, batteryLabel } from '../src/lib/cardSigner';

jest.mock('../modules/dokulachtan-card-reader', () => ({
  isCardReaderAvailable: jest.fn(),
  scanCardReaders: jest.fn(),
  connectCardReader: jest.fn(),
  cardDeviceInfo: jest.fn(),
  transmitApdu: jest.fn(),
  disconnectCardReader: jest.fn(),
}));

const mocked = {
  isCardReaderAvailable: isCardReaderAvailable as jest.Mock,
  scanCardReaders: scanCardReaders as jest.Mock,
  connectCardReader: connectCardReader as jest.Mock,
  cardDeviceInfo: cardDeviceInfo as jest.Mock,
  transmitApdu: transmitApdu as jest.Mock,
  disconnectCardReader: disconnectCardReader as jest.Mock,
};

const READER = { name: 'ACR3901U-S1-016073' };
const DEVICE = {
  model: 'acr3901u-s1-016073',
  serial: 'RR305-016073',
  firmware: 'V1F23',
  manufacturer: 'ACS',
  battery: 254,
};

async function expectCode(action: () => Promise<unknown>, code: string) {
  await expect(action()).rejects.toThrow(CardSignerError);

  try {
    await action();
  } catch (error) {
    expect((error as CardSignerError).code).toBe(code);
  }
}

describe('batteryLabel', () => {
  it('přeloží ACS status baterie na text', () => {
    expect(batteryLabel(0)).toBe('nepodporováno');
    expect(batteryLabel(1)).toBe('neznámá');
    expect(batteryLabel(2)).toBe('nízká');
    expect(batteryLabel(3)).toBe('plná');
    expect(batteryLabel(4)).toBe('nabíjí se (USB)');
  });

  it('neznámý stav (včetně -1) nespadne', () => {
    expect(batteryLabel(-1)).toBe('neznámá');
    expect(batteryLabel(undefined)).toBe('neznámá');
    expect(batteryLabel(99)).toBe('neznámá');
  });
});

describe('AcsCardSigner chybové cesty (SPEC § 9.1 S8)', () => {
  let signer: AcsCardSigner;

  beforeEach(() => {
    jest.resetAllMocks();
    signer = new AcsCardSigner();

    mocked.scanCardReaders.mockResolvedValue([READER]);
    mocked.connectCardReader.mockResolvedValue(READER);
    mocked.cardDeviceInfo.mockResolvedValue(DEVICE);
    mocked.disconnectCardReader.mockResolvedValue(undefined);
  });

  it('hlásí reader_not_found, když se čtečka nenajde', async () => {
    mocked.scanCardReaders.mockResolvedValue([]);

    await expectCode(() => signer.initializeSession(), 'reader_not_found');
  });

  it('hlásí reader_error, když spojení se čtečkou selže', async () => {
    mocked.connectCardReader.mockRejectedValue(new Error('gatt connect failed'));

    await expectCode(() => signer.initializeSession(), 'reader_error');
  });

  it('hlásí reader_disconnected, když se čtečka odpojí během čtení', async () => {
    await signer.initializeSession();
    mocked.transmitApdu.mockRejectedValue(
      Object.assign(new Error('not connected'), { code: 'reader_disconnected' }),
    );

    await expectCode(() => signer.readDocumentNumber(), 'reader_disconnected');
  });

  it('hlásí applet_not_found, když karta není eOP', async () => {
    await signer.initializeSession();
    mocked.transmitApdu.mockResolvedValue('6A82');

    await expectCode(() => signer.readDocumentNumber(), 'applet_not_found');
  });

  it('hlásí data_tag_failed, když čtení tagu selže', async () => {
    await signer.initializeSession();
    // SELECT projde, délku tagu karta nevrátí a ani přímé čtení neprojde.
    mocked.transmitApdu.mockImplementation(async (apdu: string) =>
      apdu.includes('A4 04') ? '9000' : '6A88',
    );

    await expectCode(() => signer.readDocumentNumber(), 'data_tag_failed');
  });

  it('hlásí no_qualified_certificate pro kontejner i podpis', async () => {
    await signer.initializeSession();

    await expectCode(() => signer.listContainers(), 'no_qualified_certificate');
    await expectCode(() => signer.getCertificate(), 'no_qualified_certificate');
    await expectCode(() => signer.signData(), 'no_qualified_certificate');
  });

  it('hlásí reader_disconnected, když se čte bez připojení', async () => {
    await expectCode(() => signer.readDocumentNumber(), 'reader_disconnected');
  });

  it('vyčistí stav i když odpojení selže', async () => {
    await signer.initializeSession();
    mocked.disconnectCardReader.mockRejectedValue(new Error('disconnect failed'));

    await expect(signer.finalizeSession()).resolves.toBeUndefined();
    expect(signer.deviceInfo).toBeNull();
    await expectCode(() => signer.readDocumentNumber(), 'reader_disconnected');
  });

  it('přečte číslo dokladu ze správně orámované odpovědi', async () => {
    await signer.initializeSession();
    mocked.transmitApdu
      .mockResolvedValueOnce('9000')
      .mockResolvedValueOnce('00099000')
      .mockResolvedValueOnce('3231303931303039339000');

    await expect(signer.readDocumentNumber()).resolves.toBe('210910093');
  });
});
