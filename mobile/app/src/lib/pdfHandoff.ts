// Předání lokálního PDF mezi obrazovkami (S14 → S11): route param nese jen
// opaque id, soubor zůstává v paměti appky. Cesta v URL by byla veřejná —
// `dokulachtan://sign-pdf?share=file:///…` umí otevřít kterákoli appka.
import type { PdfUpload } from './pdfApi';

const pending = new Map<string, PdfUpload>();

export function offerPdf(file: PdfUpload): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  pending.set(id, file);

  return id;
}

export function takePdf(id: string | string[] | undefined): PdfUpload | null {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  const file = pending.get(id) ?? null;

  pending.delete(id);

  return file;
}
