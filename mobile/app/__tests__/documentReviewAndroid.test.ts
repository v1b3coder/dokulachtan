import React from 'react';
import { AppState, Platform } from 'react-native';
import { QesApi } from '../src/lib/api';
import { runSigningCeremony, type CeremonyDeps } from '../src/lib/ceremony';
import { previewPdf } from '../src/lib/pdfShare';
import SignScreen from '../app/sign';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: 'tok' }),
  useFocusEffect: () => {},
  router: { replace: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: () => ({ storage: {} }) }));
jest.mock('../src/lib/pdfShare', () => ({
  ...jest.requireActual('../src/lib/pdfShare'),
  previewPdf: jest.fn(),
}));
jest.mock('../src/lib/signingOrigin', () => ({
  ...jest.requireActual('../src/lib/signingOrigin'),
  resolveSigningOrigin: async () => 'https://server',
}));
jest.mock('../src/lib/ceremony', () => ({
  ...jest.requireActual('../src/lib/ceremony'),
  runSigningCeremony: jest.fn(),
}));

it('unlocks signing only after returning from the Android PDF viewer', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const listeners: ((state: string) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener as (state: string) => void);

    return { remove: jest.fn() } as never;
  });
  jest.spyOn(QesApi.prototype, 'getSession').mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract',
    signer_name: 'Signer', hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true,
    server_url: 'https://server', expires_at: null,
  });
  jest.mocked(previewPdf).mockResolvedValue(undefined);
  jest.mocked(runSigningCeremony).mockImplementation(async (deps: CeremonyDeps) => {
    await deps.confirmDocument(new Uint8Array([37, 80, 68, 70]));

    return {
      completed: { state: 'completed', session_id: 1, submitter_id: 42, level: 'ades',
        document_digest: 'digest', signed_pdf_sha256: 'hash' },
      level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1,
    };
  });

  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await act(async () => {
    void screen.root.findByProps({ title: 'Zkontrolovat dokument' }).props.onPress();
  });
  await act(async () => {
    await screen.root.findByProps({ title: 'Otevřít přesné PDF' }).props.onPress();
  });
  expect(previewPdf).toHaveBeenCalled();
  expect(screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.disabled).toBe(true);

  await act(async () => { listeners.forEach((listener) => listener('active')); });
  expect(screen.root.findByProps({ title: 'Podepsat tento dokument' }).props.disabled).toBe(false);
  await act(async () => screen.unmount());
  jest.restoreAllMocks();
});
