import React from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { previewPdf, readFileBytes } from '../src/lib/pdfShare';
import SignPdfScreen from '../app/sign-pdf';

const { create, act } = require('react-test-renderer');

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => void) => {
    require('react').useEffect(callback, [callback]);
  },
  router: { replace: jest.fn(), push: jest.fn(), setParams: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({
  platformVaultDeps: () => ({
    storage: {
      getItem: jest.fn().mockResolvedValue(
        JSON.stringify({ serverUrl: 'https://server', apiToken: 'token' }),
      ),
      setItem: jest.fn(),
      deleteItem: jest.fn(),
    },
  }),
  appVersion: () => '1.3.9',
}));
jest.mock('../src/lib/crypto/vault', () => ({
  ...jest.requireActual('../src/lib/crypto/vault'),
  certificateSummary: async () => ({
    subject: 'Jan Novák',
    commonName: 'Jan Novák',
    email: 'jan@example.com',
    issuer: 'Test CA',
    serial: '0x01',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    qcStatements: ['QcCompliance'],
    level: 'ades',
    keyType: 'rsa',
    keySize: 2048,
    certificatePem: '',
    chainPems: [],
  }),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('../src/lib/pdfShare', () => ({
  previewPdf: jest.fn(),
  readFileBytes: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  sha256File: jest.fn().mockResolvedValue('hash'),
}));

const createdDocument = {
  template_id: 7,
  folder: 'Direct signing',
  submitter_role: 'Jan Novák',
  field: {
    uuid: 'field-1',
    name: 'Certificate signature',
    type: 'qes',
    submitter_uuid: 'submitter-1',
    required: true,
    preferences: { level: 'ades' },
    areas: [],
  },
  document: {
    uuid: 'doc-1',
    filename: 'contract.pdf',
    pages: [{ index: 0, width: 595, height: 842, preview_url: 'https://server/file/0.png' }],
  },
  stamp: { width: 150, height: 44 },
  source_sha256: 'hash',
  document_sha256: 'hash',
  normalized: false,
};

it('keeps the picker label and shows the selected file as a separate Otevřít link', async () => {
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///contract.pdf', name: 'smlouva-2026.pdf', mimeType: 'application/pdf' }],
  } as never);

  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignPdfScreen)); });

  expect(screen.root.findByProps({ title: 'Vybrat PDF' })).toBeTruthy();

  await act(async () => { await screen.root.findByProps({ title: 'Vybrat PDF' }).props.onPress(); });

  expect(screen.root.findByProps({ title: 'Vybrat PDF' })).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).toContain('smlouva-2026.pdf');
  expect(JSON.stringify(screen.toJSON())).toContain('Otevřít');

  const link = screen.root.findByProps({ accessibilityRole: 'link' });
  expect(link.props.accessibilityLabel).toBe('Otevřít místní PDF: smlouva-2026.pdf');

  await act(async () => { await link.props.onPress(); });

  expect(readFileBytes).toHaveBeenCalledWith(expect.objectContaining({ name: 'smlouva-2026.pdf' }));
  expect(previewPdf).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));

  await act(async () => screen.unmount());
});

it('sends the certificate name as display_name and no longer asks for it', async () => {
  const pdf = new File(Paths.cache, 'contract.pdf');

  pdf.create({ overwrite: true });
  await pdf.write(new Uint8Array([1, 2, 3]));

  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [{ uri: pdf.uri, name: 'contract.pdf', mimeType: 'application/pdf' }],
  } as never);

  const fetchMock = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const response = new Response(JSON.stringify(createdDocument), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });

    Object.defineProperty(response, 'url', { value: 'https://server/api/qes/documents' });

    return response;
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;

  let screen: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(SignPdfScreen)); });

  expect(JSON.stringify(screen.toJSON())).not.toContain('Jméno do pečeti');

  await act(async () => { await screen.root.findByProps({ title: 'Vybrat PDF' }).props.onPress(); });
  await act(async () => { await screen.root.findByProps({ title: 'Pokračovat' }).props.onPress(); });

  const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;

  expect(fetchMock.mock.calls[0][0]).toBe('https://server/api/qes/documents');
  expect(form.get('display_name')).toBe('Jan Novák');

  await act(async () => screen.unmount());
});
