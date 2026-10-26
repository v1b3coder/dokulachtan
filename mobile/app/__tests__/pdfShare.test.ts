import { Directory, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';

import {
  isNativeShareAvailable,
  openPdf as nativeOpenPdf,
  saveToDownloads,
  sharePdf as nativeSharePdf,
} from '../modules/dokulachtan-share';
import {
  downloadPdf,
  isPickerCancelled,
  loadSaveFolder,
  openPdf,
  PdfActionError,
  previewPdf,
  rememberSaveFolder,
  SaveCancelled,
  savePdf,
  sharePdf,
  SAVE_FOLDER_KEY,
} from '../src/lib/pdfShare';

jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 36 } }));

const mockWrite = jest.fn();

jest.mock('expo-file-system', () => {
  const downloadFileAsync = jest.fn();
  const pickDirectoryAsync = jest.fn();
  const create = jest.fn();
  const bytes = jest.fn();

  class MockFile {
    uri: string;

    constructor(...uris: unknown[]) {
      this.uri = String(uris[uris.length - 1]);
    }

    static downloadFileAsync = downloadFileAsync;

    write = mockWrite;

    create = create;

    bytes = bytes;
  }

  class MockDirectory {
    uri: string;

    get name(): string {
      return this.uri.split('/').pop() ?? '';
    }

    constructor(...uris: unknown[]) {
      this.uri = String(uris[uris.length - 1]);
    }

    static pickDirectoryAsync = pickDirectoryAsync;

    create = jest.fn();
  }

  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///cache/' } } };
});

jest.mock('expo-file-system/legacy', () => ({
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(),
    createFileAsync: jest.fn(),
  },
}));

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

jest.mock('../modules/dokulachtan-share', () => ({
  isNativeShareAvailable: jest.fn(),
  saveToDownloads: jest.fn(),
  sharePdf: jest.fn(),
  openPdf: jest.fn(),
}));

const downloadFileAsync = jest.mocked(File.downloadFileAsync);
const pickDirectoryAsync = jest.mocked(Directory.pickDirectoryAsync);
const requestDirectoryPermissions = jest.mocked(
  FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync,
);
const createFileAsync = jest.mocked(FileSystem.StorageAccessFramework.createFileAsync);
const shareAsync = jest.mocked(Sharing.shareAsync);
const isAvailableAsync = jest.mocked(Sharing.isAvailableAsync);
const nativeAvailable = jest.mocked(isNativeShareAvailable);
const nativeSave = jest.mocked(saveToDownloads);
const nativeShare = jest.mocked(nativeSharePdf);
const nativeOpen = jest.mocked(nativeOpenPdf);
const platform = Platform as { OS: string; Version: number | string };

function file(uri: string, bytes = new Uint8Array([37, 80, 68, 70])): File {
  const value = new File(uri);

  jest.spyOn(value, 'bytes').mockResolvedValue(bytes);

  return value;
}

function storage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));

  return {
    items,
    getItem: jest.fn(async (key: string) => items.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    deleteItem: jest.fn(async (key: string) => {
      items.delete(key);
    }),
  };
}

describe('pdfShare', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nativeAvailable.mockReturnValue(true);
    platform.OS = 'android';
    platform.Version = 36;
  });

  it('downloads the final PDF natively into the cache', async () => {
    const downloaded = file('file:///cache/contract-signed.pdf');

    downloadFileAsync.mockResolvedValue(downloaded);

    await expect(downloadPdf('https://server/file/x.pdf', 'contract-signed.pdf')).resolves.toBe(downloaded);
    expect(downloadFileAsync).toHaveBeenCalledWith(
      'https://server/file/x.pdf',
      expect.any(File),
      { idempotent: true },
    );
  });

  it('maps a failed download to download_failed', async () => {
    downloadFileAsync.mockRejectedValue(new Error('response has status: 404'));

    await expect(downloadPdf('https://server/file/x.pdf', 'x.pdf')).rejects.toMatchObject({
      code: 'download_failed',
      message: 'response has status: 404',
    });
  });

  it('saves into the default Downloads when no folder is remembered', async () => {
    nativeSave.mockResolvedValue({ uri: 'content://media/downloads/1', label: 'Download/Dokulachtan/x.pdf' });

    await expect(savePdf(file('file:///cache/x.pdf'), 'x.pdf')).resolves.toEqual({
      uri: 'content://media/downloads/1',
      label: 'Download/Dokulachtan/x.pdf',
      folder: null,
    });
    expect(nativeSave).toHaveBeenCalledWith('file:///cache/x.pdf', 'x.pdf', 'application/pdf');
    expect(createFileAsync).not.toHaveBeenCalled();
  });

  it('saves into the remembered folder', async () => {
    const folder = { uri: 'content://tree/dokumenty', label: 'Dokumenty' };
    const target = file('content://dokumenty/x.pdf');

    createFileAsync.mockResolvedValue(target.uri);

    await expect(savePdf(file('file:///cache/x.pdf'), 'x.pdf', { folder })).resolves.toEqual({
      uri: 'content://dokumenty/x.pdf',
      label: 'Dokumenty/x.pdf',
      folder,
    });
    expect(createFileAsync).toHaveBeenCalledWith('content://tree/dokumenty', 'x.pdf', 'application/pdf');
    expect(target.write).toHaveBeenCalledWith(new Uint8Array([37, 80, 68, 70]));
    expect(nativeSave).not.toHaveBeenCalled();
  });

  it('asks for a folder and returns it for remembering', async () => {
    const target = file('content://dokumenty/x.pdf');

    requestDirectoryPermissions.mockResolvedValue({
      granted: true,
      directoryUri: 'content://tree/dokumenty',
    });
    createFileAsync.mockResolvedValue(target.uri);

    await expect(
      savePdf(file('file:///cache/x.pdf'), 'x.pdf', {
        folder: { uri: 'content://tree/old', label: 'Staré' },
        chooseFolder: true,
      }),
    ).resolves.toEqual({
      uri: 'content://dokumenty/x.pdf',
      label: 'dokumenty/x.pdf',
      folder: { uri: 'content://tree/dokumenty', label: 'dokumenty' },
    });
    expect(requestDirectoryPermissions).toHaveBeenCalledWith('content://tree/old');
  });

  it('treats a cancelled folder picker as cancellation, not an error', async () => {
    requestDirectoryPermissions.mockResolvedValue({ granted: false });

    const error = await savePdf(file('file:///cache/x.pdf'), 'x.pdf', { chooseFolder: true })
      .catch((err) => err);

    expect(error).toBeInstanceOf(SaveCancelled);
    expect(isPickerCancelled(error)).toBe(true);
  });

  it('falls back to Downloads when the remembered folder is gone', async () => {
    const folder = { uri: 'content://tree/deleted', label: 'Smazaná' };

    createFileAsync.mockRejectedValue(new Error('no permission'));
    nativeSave.mockResolvedValue({ uri: 'content://media/downloads/1', label: 'Download/Dokulachtan/x.pdf' });

    await expect(savePdf(file('file:///cache/x.pdf'), 'x.pdf', { folder })).resolves.toEqual({
      uri: 'content://media/downloads/1',
      label: 'Download/Dokulachtan/x.pdf',
      folder: null,
    });
  });

  it('maps a failed save to save_failed', async () => {
    nativeSave.mockRejectedValue(new Error('insert failed'));

    await expect(savePdf(file('file:///cache/x.pdf'), 'x.pdf')).rejects.toMatchObject({
      code: 'save_failed',
    });
  });

  it('opens the saved PDF in the system viewer', async () => {
    nativeOpen.mockResolvedValue(undefined);

    await openPdf('content://media/downloads/1');

    expect(nativeOpen).toHaveBeenCalledWith('content://media/downloads/1', 'application/pdf');
  });

  it('reports a missing PDF viewer', async () => {
    nativeOpen.mockRejectedValue(Object.assign(new Error('No activity found'), { code: 'ERR_NO_PDF_VIEWER' }));

    await expect(openPdf('content://media/downloads/1')).rejects.toMatchObject({
      code: 'no_pdf_viewer',
    });
  });

  it('remembers and clears the save folder', async () => {
    const store = storage();
    const folder = { uri: 'content://tree/primary%3ADokumenty', label: 'Dokumenty' };

    await rememberSaveFolder(store, folder);
    expect(store.setItem).toHaveBeenCalledWith(SAVE_FOLDER_KEY, JSON.stringify(folder));
    await expect(loadSaveFolder(store)).resolves.toEqual(folder);

    await rememberSaveFolder(store, null);
    expect(store.deleteItem).toHaveBeenCalledWith(SAVE_FOLDER_KEY);
    await expect(loadSaveFolder(store)).resolves.toBeNull();
  });

  it('normalizes a technical label stored by an older version', async () => {
    const store = storage({
      [SAVE_FOLDER_KEY]: JSON.stringify({ uri: 'content://tree/primary%3ADocuments', label: 'primary:Documents' }),
    });

    await expect(loadSaveFolder(store)).resolves.toEqual({
      uri: 'content://tree/primary%3ADocuments',
      label: 'Documents',
    });
  });

  it('shares through the native module on Android', async () => {
    const value = file('file:///cache/contract-signed.pdf');

    nativeShare.mockResolvedValue(undefined);

    await sharePdf(value);

    expect(nativeShare).toHaveBeenCalledWith('file:///cache/contract-signed.pdf', 'application/pdf', 'Podepsané PDF');
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it('falls back to expo-sharing when the native module is missing', async () => {
    const value = file('file:///cache/contract-signed.pdf');

    nativeAvailable.mockReturnValue(false);
    isAvailableAsync.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);

    await sharePdf(value);

    expect(shareAsync).toHaveBeenCalledWith('file:///cache/contract-signed.pdf', {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: 'Podepsané PDF',
    });
  });

  it('reports sharing_unavailable when no share sheet exists', async () => {
    nativeAvailable.mockReturnValue(false);
    isAvailableAsync.mockResolvedValue(false);

    await expect(sharePdf(file('file:///cache/x.pdf'))).rejects.toMatchObject({
      code: 'sharing_unavailable',
    });
  });

  it('uses the folder picker on iOS', async () => {
    const target = file('file:///Documents/x.pdf');

    platform.OS = 'ios';
    pickDirectoryAsync.mockResolvedValue({
      uri: 'file:///Documents',
      name: 'Documents',
      createFile: () => target,
    } as unknown as Directory);

    await expect(savePdf(file('file:///cache/x.pdf'), 'x.pdf')).resolves.toEqual({
      uri: 'file:///Documents/x.pdf',
      label: 'Documents/x.pdf',
      folder: { uri: 'file:///Documents', label: 'Documents' },
    });
  });

  it('exposes a code for every action error', () => {
    expect(new PdfActionError('open_failed').code).toBe('open_failed');
  });

  it('opens the exact bytes from the ceremony in the native PDF viewer', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 255, 0]);

    platform.OS = 'android';
    nativeOpen.mockResolvedValue(undefined);

    await previewPdf(bytes);

    expect(mockWrite).toHaveBeenCalledWith(bytes);
    expect(nativeOpen).toHaveBeenCalledWith(expect.any(String), 'application/pdf');
  });

  it('maps a missing PDF viewer to no_pdf_viewer', async () => {
    nativeOpen.mockRejectedValue(Object.assign(new Error('No activity found'), { code: 'ERR_NO_PDF_VIEWER' }));

    await expect(previewPdf(new Uint8Array([1]))).rejects.toMatchObject({ code: 'no_pdf_viewer' });
  });
});
