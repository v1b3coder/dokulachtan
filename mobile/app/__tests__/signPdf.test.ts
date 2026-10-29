import React from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { previewPdf, readFileBytes } from '../src/lib/pdfShare';
import SignPdfScreen from '../app/sign-pdf';

const { create, act } = require('react-test-renderer');

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
  router: { replace: jest.fn(), push: jest.fn(), setParams: jest.fn() },
}));
jest.mock('../src/lib/platform', () => ({
  platformVaultDeps: () => ({
    storage: { getItem: jest.fn().mockResolvedValue(null), setItem: jest.fn(), deleteItem: jest.fn() },
  }),
  appVersion: () => '1.3.9',
}));
jest.mock('../src/lib/crypto/vault', () => ({ certificateSummary: async () => null }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('../src/lib/pdfShare', () => ({
  previewPdf: jest.fn(),
  readFileBytes: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  sha256File: jest.fn().mockResolvedValue('hash'),
}));

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
