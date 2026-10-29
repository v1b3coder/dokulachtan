import React from 'react';
import { QesApi } from '../src/lib/api';
import { PdfApi } from '../src/lib/pdfApi';
import { CeremonyError, runSigningCeremony } from '../src/lib/ceremony';
import { downloadPdf, previewPdf, sharePdf } from '../src/lib/pdfShare';
import { resolveWorkflowOrigin, trustServer } from '../src/lib/trustedServers';
import { preparedPdf } from './helpers/preparedPdf';
import SignScreen from '../app/sign';

let mockParams: Record<string, string> = { token: 'tok', flow: 'pdf' };
const { create, act } = require('react-test-renderer');
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => {}, router: { replace: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({ platformVaultDeps: () => ({ storage: {}, dataStorage: {} }) }));
jest.mock('../src/lib/pdfShare', () => ({
  ...jest.requireActual('../src/lib/pdfShare'),
  sharePdf: jest.fn(),
  loadSaveFolder: jest.fn().mockResolvedValue(null),
  downloadPdf: jest.fn(),
  previewPdf: jest.fn().mockResolvedValue(undefined),
  savePdf: jest.fn(),
  openPdf: jest.fn(),
}));
jest.mock('../src/lib/signingOrigin', () => ({
  ...jest.requireActual('../src/lib/signingOrigin'), resolveSigningOrigin: async () => 'https://server',
}));
jest.mock('../src/lib/trustedServers', () => ({
  ...jest.requireActual('../src/lib/trustedServers'),
  resolveWorkflowOrigin: jest.fn(),
  trustServer: jest.fn(),
}));
jest.mock('../src/lib/pdfApi', () => ({
  ...jest.requireActual('../src/lib/pdfApi'),
  loadPdfApiSettings: async () => ({ serverUrl: 'https://server', apiToken: 'token' }),
}));
jest.mock('../src/lib/ceremony', () => ({
  ...jest.requireActual('../src/lib/ceremony'), runSigningCeremony: jest.fn(),
}));

const fixture = preparedPdf('sha256');

beforeEach(() => {
  mockParams = { token: 'tok', flow: 'pdf' };
  jest.spyOn(QesApi.prototype, 'getSession').mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://server', expires_at: null,
  });
  jest.spyOn(QesApi.prototype, 'getDocument').mockResolvedValue(fixture.bytes);
  jest.mocked(downloadPdf).mockResolvedValue({
    uri: 'file:///cache/contract-signed.pdf',
    bytes: async () => fixture.bytes,
  } as never);
  jest.mocked(runSigningCeremony).mockResolvedValue({
    completed: {
      state: 'completed', session_id: 1, submitter_id: 42, level: 'ades',
      document_digest: fixture.prepared.document_digest, signed_pdf_sha256: 'hash',
    },
    level: 'ades', keyLocation: 'phone_keystore', biometricPrompts: 1, documentDigest: fixture.prepared.document_digest,
  });
});

async function signOnScreen(screen: ReturnType<typeof create>) {
  await act(async () => { await screen.root.findByProps({ title: 'Zobrazit dokument' }).props.onPress(); });
  await act(async () => { await screen.root.findByProps({ title: 'Podepsat dokument' }).props.onPress(); });
}
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

it('offers saving retry after a signature and retries only submission completion', async () => {
  const complete = jest.spyOn(QesApi.prototype, 'completeSubmission')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await signOnScreen(screen);
  expect(screen.root.findByProps({ title: 'Dokončit uložení' })).toBeTruthy();
  expect(screen.root.findAllByProps({ title: 'Stáhnout' })).toHaveLength(0);
  await act(async () => { await screen.root.findByProps({ title: 'Dokončit uložení' }).props.onPress(); });
  expect(screen.root.findByProps({ title: 'Stáhnout' })).toBeTruthy();
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenLastCalledWith();
  expect(runSigningCeremony).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
});

it('offers check again when the server is still completing', async () => {
  jest.mocked(runSigningCeremony).mockRejectedValueOnce(new CeremonyError('server_pending'));
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });
  await signOnScreen(screen);
  expect(screen.root.findByProps({ title: 'Zkontrolovat znovu' })).toBeTruthy();

  jest.mocked(QesApi.prototype.getSession).mockResolvedValueOnce({
    state: 'completed', session_id: 1, submitter_id: 42, level: 'ades',
    document_digest: fixture.prepared.document_digest, signed_pdf_sha256: 'hash',
  });
  jest.spyOn(QesApi.prototype, 'completeSubmission')
    .mockResolvedValue({ state: 'completed', submitter_id: 42, completed: true });
  await act(async () => { await screen.root.findByProps({ title: 'Zkontrolovat znovu' }).props.onPress(); });
  await act(async () => {});
  expect(screen.root.findByProps({ title: 'Stáhnout' })).toBeTruthy();
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
    await signOnScreen(screen);
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

it('asks for TOFU before sending a workflow token to an unknown server', async () => {
  mockParams = { token: 'tok', server: 'https://new.test' };
  jest.mocked(resolveWorkflowOrigin).mockResolvedValue({
    origin: 'https://new.test', trusted: false,
  });
  jest.mocked(trustServer).mockResolvedValue({
    origin: 'https://new.test', approvedAt: '2026-10-28T00:00:00Z',
  });
  jest.mocked(QesApi.prototype.getSession).mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://new.test', expires_at: null,
  });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });

  expect(QesApi.prototype.getSession).not.toHaveBeenCalled();
  expect(JSON.stringify(screen.toJSON())).toContain('https://new.test');
  expect(screen.root.findByProps({ title: 'Důvěřovat a pokračovat' })).toBeTruthy();

  await act(async () => {
    await screen.root.findByProps({ title: 'Důvěřovat a pokračovat' }).props.onPress();
  });

  expect(trustServer).toHaveBeenCalledWith(expect.anything(), 'https://new.test');
  expect(QesApi.prototype.getSession).toHaveBeenCalledTimes(1);
  expect(screen.root.findByProps({ title: 'Zobrazit dokument' })).toBeTruthy();
  await act(async () => screen.unmount());
});

it('rejects a workflow server that claims a different origin in the payload', async () => {
  mockParams = { token: 'tok', server: 'https://new.test' };
  jest.mocked(resolveWorkflowOrigin).mockResolvedValue({
    origin: 'https://new.test', trusted: true,
  });
  jest.mocked(QesApi.prototype.getSession).mockResolvedValue({
    state: 'app_opened', session_id: 1, submitter_id: 42, provider: 'app', document_name: 'Contract', signer_name: 'Signer',
    hash_algorithm: 'sha256', level_required: 'ades', requires_certificate: true, server_url: 'https://other.test', expires_at: null,
  });
  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignScreen)); });

  expect(JSON.stringify(screen.toJSON())).toContain('Odkaz vede na jiný server');
  expect(screen.root.findAllByProps({ title: 'Zobrazit dokument' })).toHaveLength(0);
  expect(QesApi.prototype.getDocument).not.toHaveBeenCalled();
  await act(async () => screen.unmount());
});
