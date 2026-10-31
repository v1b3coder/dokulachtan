// Regrese nálezu: `?share=` v odkazu nesmí způsobit čtení ani upload
// lokálního souboru. Soubor se předává jen handoffem z trusted cesty
// (share sheet, open-with), ne z URL.
import React from 'react';
import { platformVaultDeps } from '../src/lib/platform';
import SignPdfScreen from '../app/sign-pdf';
import VerifyPdfScreen from '../app/verify-pdf';

const { create, act } = require('react-test-renderer');

jest.mock('expo-router', () => {
  const React = require('react');

  return {
    useLocalSearchParams: () => ({
      share: 'file:///data/user/0/cz.dokulachtan.signer/files/vault/certificate.json',
      name: 'certificate.json',
    }),
    useFocusEffect: (callback: () => void) => React.useEffect(callback, []),
    useRouter: () => ({ push: jest.fn() }),
    router: { push: jest.fn(), replace: jest.fn(), setParams: jest.fn() },
  };
});
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: jest.fn(), appVersion: () => '1.3.9' }));
jest.mock('../src/lib/crypto/vault', () => ({ certificateSummary: async () => null }));

const storage = { getItem: jest.fn(), setItem: jest.fn(), deleteItem: jest.fn() };

beforeEach(() => {
  jest.mocked(platformVaultDeps).mockReturnValue({
    storage,
    dataStorage: storage,
  } as unknown as ReturnType<typeof platformVaultDeps>);
  storage.getItem.mockResolvedValue(
    JSON.stringify({ serverUrl: 'https://company.test', apiToken: 'test-token' }),
  );
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected request'));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe.each([
  ['sign-pdf', SignPdfScreen],
  ['verify-pdf', VerifyPdfScreen],
] as const)('%s ignoruje share z odkazu', (_name, Component) => {
  it('soubor z route param nepřečte ani nenahraje', async () => {
    let screen: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(Component)); });

    const rendered = JSON.stringify(screen.toJSON());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(rendered).not.toContain('certificate.json');
    expect(rendered).not.toContain('PDF z jiné aplikace');

    await act(async () => screen.unmount());
  });
});
