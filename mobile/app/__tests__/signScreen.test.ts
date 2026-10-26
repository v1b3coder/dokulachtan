import React from 'react';
import { QesApi } from '../src/lib/api';
import { PdfApi } from '../src/lib/pdfApi';
import { runSigningCeremony } from '../src/lib/ceremony';
import { downloadPdf, sharePdf } from '../src/lib/pdfShare';
import SignScreen from '../app/sign';

const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: 'tok', flow: 'pdf', submitter: '42' }),
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
    state: 'app_opened', session_id: 1, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://server', expires_at: null,
  });
  jest.mocked(runSigningCeremony).mockResolvedValue({
    completed: { state: 'completed', session_id: 1, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash' },
    level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1,
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

it('offers saving retry after a signature and retries only submission completion', async () => {
  const complete = jest.spyOn(PdfApi.prototype, 'completeSubmission')
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await act(async () => { await screen.root.findByProps({ title: 'Zkontrolovat dokument' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Dokončit uložení' })).toBeTruthy();
  expect(screen.root.findAllByProps({ title: 'Stáhnout' })).toHaveLength(0);
  await act(async () => { await screen.root.findByProps({ title: 'Dokončit uložení' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Stáhnout' })).toBeTruthy();
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenLastCalledWith(42);
  expect(runSigningCeremony).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
});

it('opens a completed link directly as success and finishes only saving', async () => {
  jest.mocked(QesApi.prototype.getSession).mockResolvedValue({
    state: 'completed', session_id: 1, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash',
  });
  const complete = jest.spyOn(PdfApi.prototype, 'completeSubmission').mockResolvedValue(undefined);
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
      state: 'completed', session_id: 1, level: 'ades', document_digest: 'digest', signed_pdf_sha256: 'hash',
    });
  }
  const fetchMock = jest.spyOn(global, 'fetch');
  if (!reopen) fetchMock.mockRejectedValueOnce(new Error('response lost'));
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Submitter has already completed the submission.' }), { status: 422 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{ name: 'contract', url: 'https://server/final.pdf' }] })))
    .mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70])));
  const complete = jest.spyOn(PdfApi.prototype, 'completeSubmission');
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
    ...(!reopen ? ['PUT https://server/api/submitters/42'] : []),
    'PUT https://server/api/submitters/42',
    'GET https://server/api/submitters/42',
  ]);
  expect(downloadPdf).toHaveBeenCalledWith('https://server/final.pdf', expect.stringContaining('-signed.pdf'));
  await act(async () => screen.unmount());
});
