import React from 'react';
import { TextInput } from 'react-native';
import { platformVaultDeps } from '../src/lib/platform';
import { PDF_API_SETTINGS_KEY } from '../src/lib/pdfApi';
import SignPdfScreen from '../app/sign-pdf';
import VerifyPdfScreen from '../app/verify-pdf';
import SettingsScreen from '../app/settings';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ share: 'file:///contract.pdf', name: 'contract.pdf' }),
  useFocusEffect: () => {}, useRouter: () => ({ push: jest.fn() }),
  router: { push: jest.fn(), replace: jest.fn(), setParams: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: jest.fn() }));
jest.mock('../src/lib/crypto/vault', () => ({ certificateSummary: async () => null }));
jest.mock('../src/lib/testCertificate', () => ({ importTestCertificate: jest.fn() }));

const invalidServers = [
  'http://company.test', 'https://company.test/path', 'https://company.test?x=1',
  'https://company.test#fragment', 'https://user:password@company.test', 'not a URL',
];
const storage = { getItem: jest.fn(), setItem: jest.fn(), deleteItem: jest.fn() };

beforeEach(() => {
  jest.mocked(platformVaultDeps).mockReturnValue({ storage } as unknown as ReturnType<typeof platformVaultDeps>);
  storage.setItem.mockResolvedValue(undefined);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected request'));
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

function configure(serverUrl: string) {
  storage.getItem.mockResolvedValue(JSON.stringify({ serverUrl, apiToken: 'test-token' }));
}

describe.each([
  ['sign-pdf', SignPdfScreen], ['verify-pdf', VerifyPdfScreen],
] as const)('%s configured origin', (name, Component) => {
  it.each(invalidServers)('rejects stored %s before sending a PDF or token', async (serverUrl) => {
    configure(serverUrl);
    let screen: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(Component)); });
    if (name === 'verify-pdf') {
      await act(async () => { await screen.root.findByProps({ title: 'Ověřit PDF' }).props.onPress(); });
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain('V Nastavení zadejte HTTPS adresu serveru bez cesty, parametrů a fragmentu.');
    await act(async () => screen.unmount());
  });

  it.each([
    ['https://COMPANY.test:443/', 'https://company.test'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['http://10.0.2.2:3000/', 'http://10.0.2.2:3000'],
  ])('uses the validated origin %s', async (configured, expected) => {
    configure(configured);
    // Jest/Expo běží v development režimu; produkční zákaz HTTP testuje signingOrigin.test.
    let screen: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(Component)); });
    if (name === 'verify-pdf') {
      await act(async () => { await screen.root.findByProps({ title: 'Ověřit PDF' }).props.onPress(); });
    }
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `${expected}/api/qes/${name === 'sign-pdf' ? 'documents' : 'verify'}`,
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Auth-Token': 'test-token' }) }),
    );
    await act(async () => screen.unmount());
  });
});

describe('Settings save', () => {
  it.each(invalidServers)('refuses to persist %s and keeps the previous server', async (serverUrl) => {
    configure('https://company.test');
    let screen: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(SettingsScreen)); });
    await act(async () => { screen.root.findAllByType(TextInput)[0].props.onChangeText(serverUrl); });
    await act(async () => { await screen.root.findByProps({ title: 'Uložit' }).props.onPress(); });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(screen.root.findByProps({ accessibilityRole: 'alert' }).props.children)
      .toBe('Zadejte platnou HTTPS adresu serveru bez cesty, parametrů, fragmentu a přihlašovacích údajů.');
    expect(screen.root.findByProps({ title: 'Uložit' }).props.disabled).toBe(false);
    // Oprava adresy musí odstranit chybu a uložit normalizovanou hodnotu.
    await act(async () => { screen.root.findAllByType(TextInput)[0].props.onChangeText('https://OTHER.test:443/'); });
    await act(async () => { await screen.root.findByProps({ title: 'Uložit' }).props.onPress(); });
    expect(storage.setItem).toHaveBeenCalledWith(PDF_API_SETTINGS_KEY,
      JSON.stringify({ serverUrl: 'https://other.test', apiToken: 'test-token' }));
    expect(screen.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    expect(screen.root.findByProps({ title: 'Uloženo' }).props.disabled).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    await act(async () => screen.unmount());
  });

  it.each(['localhost', '10.0.2.2'])('saves development HTTP for %s', async (host) => {
    configure('https://company.test');
    let screen: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(SettingsScreen)); });
    await act(async () => { screen.root.findAllByType(TextInput)[0].props.onChangeText(`http://${host}:3000/`); });
    await act(async () => { await screen.root.findByProps({ title: 'Uložit' }).props.onPress(); });
    expect(storage.setItem).toHaveBeenCalledWith(PDF_API_SETTINGS_KEY,
      JSON.stringify({ serverUrl: `http://${host}:3000`, apiToken: 'test-token' }));
    expect(screen.root.findByProps({ title: 'Uloženo' }).props.disabled).toBe(true);
    await act(async () => screen.unmount());
  });
});
