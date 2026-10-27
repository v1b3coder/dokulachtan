import React from 'react';
import { QesApi } from '../src/lib/api';
import { PdfApi } from '../src/lib/pdfApi';
import { runSigningCeremony } from '../src/lib/ceremony';
import { downloadPdf, sharePdf } from '../src/lib/pdfShare';
import SignScreen from '../app/sign';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: 'tok', flow: 'pdf' }),
  useFocusEffect: () => {}, router: { replace: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: () => ({ storage: {} }) }));
jest.mock('../src/lib/pdfShare', () => ({
  ...jest.requireActual('../src/lib/pdfShare'),
  sharePdf: jest.fn(),
  previewPdf: jest.fn(),
  loadSaveFolder: jest.fn().mockResolvedValue(null),
  downloadPdf: jest.fn().mockResolvedValue({ uri: 'file:///cache/contract-signed.pdf' }),
  savePdf: jest.fn(),
  openPdf: jest.fn(),
}));
jest.mock('../src/lib/signingOrigin', () => ({
  ...jest.requireActual('../src/lib/signingOrigin'), resolveSigningOrigin: async () => 'https://server',
}));
jest.mock('../src/lib/pdfApi', () => ({
  ...jest.requireActual('../src/lib/pdfApi'),
  loadPdfApiSettings: async () => ({ serverUrl: 'https://server', apiToken: 'token' }),
}));
jest.mock('../src/lib/ceremony', () => ({
  ...jest.requireActual('../src/lib/ceremony'), runSigningCeremony: jest.fn(),
}));

beforeEach(() => {
  jest.spyOn(QesApi.prototype, 'getSession').mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://server', expires_at: null,
  });
  jest.mocked(runSigningCeremony).mockResolvedValue({
    completed: { state: 'completed', session_id: 1, submitter_id: 42, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash' },
    level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1,
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

it('offers saving retry after a signature and retries only submission completion', async () => {
  const complete = jest.spyOn(QesApi.prototype, 'completeSubmission')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await act(async () => { await screen.root.findByProps({ title: 'Zkontrolovat dokument' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Dokončit uložení' })).toBeTruthy();
  expect(screen.root.findAllByProps({ title: 'Stáhnout' })).toHaveLength(0);
  await act(async () => { await screen.root.findByProps({ title: 'Dokončit uložení' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Stáhnout' })).toBeTruthy();
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenLastCalledWith();
  expect(runSigningCeremony).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
});

it('opens a completed link directly as success and finishes only saving', async () => {
  jest.mocked(QesApi.prototype.getSession).mockResolvedValue({
    state: 'completed', session_id: 1, submitter_id: 42, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash',
  });
  const complete = jest.spyOn(QesApi.prototype, 'completeSubmission')
    .mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  expect(screen.root.findByProps({ title: 'Stáhnout' })).toBeTruthy();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(runSigningCeremony).not.toHaveBeenCalled();
  await act(async () => screen.unmount());
});

it.each([false, true])('recovers an already completed submission (reopen: %s) and shares its PDF', async (reopen) => {
  if (reopen) {
    jest.mocked(QesApi.prototype.getSession).mockResolvedValue({
      state: 'completed', session_id: 1, submitter_id: 42, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash',
    });
  }
  const documentsResponse = new Response(JSON.stringify({ documents: [{ name: 'contract', url: 'https://server/final.pdf' }] }));
  Object.defineProperty(documentsResponse, 'url', { value: 'https://server/api/submitters/42' });
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(documentsResponse);
  const complete = jest.spyOn(QesApi.prototype, 'completeSubmission');
  if (!reopen) complete.mockRejectedValueOnce(new Error('response lost'));
  complete.mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  if (!reopen) {
    await act(async () => { await screen.root.findByProps({ title: 'Zkontrolovat dokument' }).props.onPress(); });
    expect(screen.root.findAllByProps({ title: 'Stáhnout' })).toHaveLength(0);
    await act(async () => { await screen.root.findByProps({ title: 'Dokončit uložení' }).props.onPress(); });
  }
  expect(screen.root.findAllByProps({ title: 'Dokončit uložení' })).toHaveLength(0);
  expect(JSON.stringify(screen.toJSON())).toContain('Podepsáno (');
  expect(JSON.stringify(screen.toJSON())).not.toContain('already completed');
  expect(JSON.stringify(screen.toJSON())).not.toContain('Chyba připojení');
  await act(async () => { await screen.root.findByProps({ title: 'Sdílet' }).props.onPress(); });
  expect(sharePdf).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///cache/contract-signed.pdf' }));
  expect(complete).toHaveBeenCalledTimes(reopen ? 1 : 2);
  expect(runSigningCeremony).toHaveBeenCalledTimes(reopen ? 0 : 1);
  expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
    'GET https://server/api/submitters/42',
  ]);
  expect(downloadPdf).toHaveBeenCalledWith('https://server/final.pdf', expect.stringContaining('-signed.pdf'));
  await act(async () => screen.unmount());
});
