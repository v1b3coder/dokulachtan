import React from 'react';
import { QesApi } from '../src/lib/api';
import { runSigningCeremony, type CeremonyDeps } from '../src/lib/ceremony';
import { previewPdf } from '../src/lib/pdfShare';
import SignScreen from '../app/sign';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: 'tok' }), useFocusEffect: () => {}, router: { replace: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: () => ({ storage: {} }) }));
jest.mock('../src/lib/pdfShare', () => ({
  ...jest.requireActual('../src/lib/pdfShare'),
  sharePdf: jest.fn(),
  previewPdf: jest.fn(),
}));
jest.mock('../src/lib/signingOrigin', () => ({
  ...jest.requireActual('../src/lib/signingOrigin'), resolveSigningOrigin: async () => 'https://server',
}));
jest.mock('../src/lib/ceremony', () => ({
  ...jest.requireActual('../src/lib/ceremony'), runSigningCeremony: jest.fn(),
}));

it('requires opening the exact downloaded PDF and a separate explicit confirmation', async () => {
  jest.spyOn(QesApi.prototype, 'getSession').mockResolvedValue({
    state: 'app_opened', session_id: 1, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://server', expires_at: null,
  });
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const signature = jest.fn();
  jest.mocked(runSigningCeremony).mockImplementation(async (deps: CeremonyDeps) => {
    if (!await deps.confirmDocument(bytes)) throw new Error('cancelled');
    signature();
    return { completed: { state: 'completed', session_id: 1, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash' },
      level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1 };
  });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  let signing!: Promise<void>;
  await act(async () => { signing = screen.root.findByProps({ title: 'Zkontrolovat dokument' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.disabled).toBe(true);
  jest.mocked(previewPdf).mockRejectedValueOnce(new Error('no viewer'));
  await act(async () => { await screen.root.findByProps({ title: 'Otevřít přesné PDF' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.disabled).toBe(true);
  await act(async () => { await screen.root.findByProps({ title: 'Otevřít přesné PDF' }).props.onPress(); });
  expect(previewPdf).toHaveBeenLastCalledWith(bytes);
  expect(screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.disabled).toBe(false);
  expect(signature).not.toHaveBeenCalled();
  await act(async () => {
    screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.onPress();
    await signing;
  });
  expect(signature).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
  jest.restoreAllMocks();
});
