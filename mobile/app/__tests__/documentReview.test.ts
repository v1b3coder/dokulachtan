import React from 'react';
import { QesApi } from '../src/lib/api';
import { runSigningCeremony } from '../src/lib/ceremony';
import { previewPdf } from '../src/lib/pdfShare';
import { preparedPdf } from './helpers/preparedPdf';
import SignScreen from '../app/sign';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: 'tok' }),
  useFocusEffect: () => {},
  router: { replace: jest.fn(), back: jest.fn(), canGoBack: () => false },
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
jest.mock('../src/lib/trustedServers', () => ({
  ...jest.requireActual('../src/lib/trustedServers'),
  resolveWorkflowOrigin: async () => ({ origin: 'https://server', trusted: true }),
}));
jest.mock('../src/lib/ceremony', () => ({
  ...jest.requireActual('../src/lib/ceremony'), runSigningCeremony: jest.fn(),
}));

const fixture = preparedPdf('sha256');
const bytes = fixture.bytes;

beforeEach(() => {
  jest.spyOn(QesApi.prototype, 'getSession').mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://server', expires_at: null,
  });
  jest.spyOn(QesApi.prototype, 'getDocument').mockResolvedValue(bytes);
  jest.spyOn(QesApi.prototype, 'postAbort').mockResolvedValue({ state: 'cancelled' });
  jest.mocked(previewPdf).mockResolvedValue();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('reviews the unsigned document before unlocking the key and signs the same bytes', async () => {
  jest.mocked(runSigningCeremony).mockResolvedValue({
    completed: {
      state: 'completed', session_id: 1, submitter_id: 42, level: 'ades', document_digest: 'digest',
      signed_pdf_sha256: 'hash',
    },
    level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1, documentDigest: 'digest',
  });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });

  await act(async () => { await screen.root.findByProps({ title: 'Zobrazit dokument' }).props.onPress(); });

  expect(QesApi.prototype.getDocument).toHaveBeenCalledTimes(1);
  expect(previewPdf).toHaveBeenCalledWith(bytes);
  expect(runSigningCeremony).not.toHaveBeenCalled();
  expect(screen.root.findByProps({ title: 'Podepsat dokument' }).props.disabled).toBe(false);

  await act(async () => { await screen.root.findByProps({ title: 'Podepsat dokument' }).props.onPress(); });

  expect(runSigningCeremony).toHaveBeenCalledWith(
    expect.objectContaining({ reviewedDocument: bytes }),
    'ades',
  );
  await act(async () => screen.unmount());
});

it('cancels the session without unlocking the key', async () => {
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await act(async () => { await screen.root.findByProps({ title: 'Zobrazit dokument' }).props.onPress(); });

  await act(async () => { await screen.root.findByProps({ title: 'Zrušit' }).props.onPress(); });

  expect(QesApi.prototype.postAbort).toHaveBeenCalledWith('user_cancelled');
  expect(runSigningCeremony).not.toHaveBeenCalled();
  await act(async () => screen.unmount());
});
