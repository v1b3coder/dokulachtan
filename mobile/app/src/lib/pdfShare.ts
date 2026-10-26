// Finální PDF z DocuSealu (docs/15 § 7.1): stažení do souboru, uložení do
// telefonu (výchozí Downloads, volitelně zapamatovaná složka), otevření v PDF
// prohlížeči a systémový share sheet. PDF se stahuje nativně přímo do cache,
// ne přes blob v JS paměti — velké PDF (LTV, CRL, DocTS) tak neprojde
// `arrayBuffer`/`FileReader` a chyba se neprojeví jako „network“.
import { Directory, File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

// Náhled před podpisem i otevření po podpisu jdou stejnou cestou (docs/16 S12):
// chooser nechává na systému, takže nabídka aplikací je v obou případech stejná.

import {
  isNativeShareAvailable,
  openPdf as nativeOpenPdf,
  saveToDownloads,
  sharePdf as nativeSharePdf,
} from '../../modules/dokulachtan-share';

export type PdfActionErrorCode =
  | 'download_failed'
  | 'save_failed'
  | 'share_failed'
  | 'sharing_unavailable'
  | 'open_failed'
  | 'no_pdf_viewer';

export class PdfActionError extends Error {
  readonly code: PdfActionErrorCode;

  constructor(code: PdfActionErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// Zrušení výběru složky není chyba — appka nemá co hlásit (docs/17).
export class SaveCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export function isPickerCancelled(err: unknown): boolean {
  return err instanceof SaveCancelled || (err instanceof Error && /cancel/i.test(err.message));
}

export interface SaveFolder {
  uri: string;
  label: string;
}

export interface SavedPdf {
  uri: string;
  label: string;
  // Složka, do které se uložilo (null = výchozí Downloads/Dokulachtan).
  folder: SaveFolder | null;
}

// Zapamatovaná SAF složka (Android); SecureStore klíč musí být jen [\w.-]+.
export const SAVE_FOLDER_KEY = 'cz.dokulachtan.signer.saveFolder';

export interface SaveFolderStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export async function loadSaveFolder(storage: SaveFolderStorage): Promise<SaveFolder | null> {
  const raw = await storage.getItem(SAVE_FOLDER_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SaveFolder;

    if (!parsed.uri) {
      return null;
    }

    // Label se odvozuje z URI, aby dřív uložené hodnoty nezůstaly technické.
    return { uri: parsed.uri, label: folderLabel(parsed.uri) };
  } catch {
    return null;
  }
}

export async function rememberSaveFolder(
  storage: SaveFolderStorage,
  folder: SaveFolder | null,
): Promise<void> {
  if (!folder) {
    await storage.deleteItem(SAVE_FOLDER_KEY);

    return;
  }

  await storage.setItem(SAVE_FOLDER_KEY, JSON.stringify(folder));
}

export async function downloadPdf(url: string, fileName: string): Promise<File> {
  try {
    const file = await File.downloadFileAsync(url, new File(Paths.cache, fileName), { idempotent: true });

    // `downloadFileAsync` je v typování deklarované nad třídou z `ExpoFileSystem.types`,
    // ale vrací stejnou instanci `File` jako export z `expo-file-system`.
    return file as unknown as File;
  } catch (err) {
    throw new PdfActionError('download_failed', err instanceof Error ? err.message : undefined);
  }
}

// Uložení do telefonu: Android 10+ výchozí Downloads přes MediaStore, na přání
// uživatele SAF složka (zapamatovaná), na iOS výběr složky v aplikaci Soubory.
export async function savePdf(
  file: File,
  fileName: string,
  options: { folder?: SaveFolder | null; chooseFolder?: boolean } = {},
): Promise<SavedPdf> {
  try {
    if (Platform.OS !== 'android') {
      // `pickDirectoryAsync` je v typování deklarované nad třídou z
      // `ExpoFileSystem.types`, ale vrací stejnou instanci `Directory` jako export.
      const picked = await Directory.pickDirectoryAsync(options.folder?.uri);
      const directory = picked as unknown as Directory;
      const target = directory.createFile(fileName, 'application/pdf');

      target.write(await file.bytes());

      return {
        uri: target.uri,
        label: `${directory.name}/${fileName}`,
        folder: { uri: directory.uri, label: directory.name },
      };
    }

    if (options.chooseFolder) {
      const folder = await pickAndroidFolder(options.folder ?? null);

      return await saveToAndroidFolder(file, fileName, folder);
    }

    if (options.folder) {
      try {
        return await saveToAndroidFolder(file, fileName, options.folder);
      } catch {
        // Zapamatovaná složka už neplatí (odebraná permission) → výchozí Downloads.
        return { ...(await saveDefault(file, fileName)), folder: null };
      }
    }

    return { ...(await saveDefault(file, fileName)), folder: null };
  } catch (err) {
    if (err instanceof SaveCancelled || isPickerCancelled(err)) {
      throw err;
    }

    throw new PdfActionError('save_failed', err instanceof Error ? err.message : undefined);
  }
}

export async function openPdf(uri: string): Promise<void> {
  if (Platform.OS !== 'android' || !isNativeShareAvailable()) {
    throw new PdfActionError('open_failed');
  }

  try {
    await nativeOpenPdf(uri, 'application/pdf');
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_NO_PDF_VIEWER') {
      throw new PdfActionError('no_pdf_viewer');
    }

    throw new PdfActionError('open_failed', err instanceof Error ? err.message : undefined);
  }
}

export async function sharePdf(file: File): Promise<void> {
  if (isNativeShareAvailable()) {
    await nativeSharePdf(file.uri, 'application/pdf', 'Podepsané PDF');

    return;
  }

  if (!(await Sharing.isAvailableAsync())) {
    throw new PdfActionError('sharing_unavailable');
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: 'Podepsané PDF',
  });
}

async function saveDefault(file: File, fileName: string): Promise<{ uri: string; label: string }> {
  if (!isNativeShareAvailable()) {
    throw new PdfActionError('save_failed');
  }

  return saveToDownloads(file.uri, fileName, 'application/pdf');
}

async function saveToAndroidFolder(
  file: File,
  fileName: string,
  folder: SaveFolder,
): Promise<SavedPdf> {
  const uri = await FileSystem.StorageAccessFramework.createFileAsync(
    folder.uri,
    fileName,
    'application/pdf',
  );

  new File(uri).write(await file.bytes());

  return { uri, label: `${folder.label}/${fileName}`, folder };
}

async function pickAndroidFolder(initial: SaveFolder | null): Promise<SaveFolder> {
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(
    initial?.uri ?? null,
  );

  if (!permissions.granted) {
    throw new SaveCancelled();
  }

  return { uri: permissions.directoryUri, label: folderLabel(permissions.directoryUri) };
}

function folderLabel(uri: string): string {
  // SAF tree URI končí dokumentem `primary%3ADocuments`; zobrazíme jen jeho část.
  const segment = decodeURIComponent(uri.split('/').pop() ?? '');
  const label = segment.includes(':') ? segment.slice(segment.indexOf(':') + 1) : segment;

  return label || 'Vybraná složka';
}

// Každá kontrola má vlastní soubor; žádný další download ani přepis náhledu.
export async function previewPdf(bytes: Uint8Array): Promise<void> {
  const directory = new Directory(Paths.cache, 'reviewed-pdf');

  directory.create({ idempotent: true });

  const file = new File(directory, `document-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

  file.create();
  file.write(bytes);

  if (Platform.OS !== 'android') {
    if (!(await Sharing.isAvailableAsync())) {
      throw new PdfActionError('no_pdf_viewer');
    }

    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: 'Otevřít dokument ke kontrole',
    });

    return;
  }

  // Stejná cesta jako otevření po podpisu — jeden `openPdf` pro obě místa.
  await openPdf(file.uri);
}
