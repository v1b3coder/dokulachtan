import { loadPdfApiSettings, type PdfApiStorage } from './pdfApi';

// Server z Nastavení pro přímý podpis PDF a ověření PDF. Bez
// EXPO_PUBLIC_API_URL je prázdný a uživatel ho vyplní v Nastavení; workflow
// má server z odkazu (trustedServers.ts), ten Nastavení nepoužívá.
export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_API_URL || '';

export class SigningOriginError extends Error {
  constructor(readonly code: 'foreign_server' | 'invalid_server' | 'missing_server') {
    super(code);
  }
}

export function signingOrigin(value: string, dev = typeof __DEV__ !== 'undefined' && __DEV__): string {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname);

    if ((url.protocol !== 'https:' && !(dev && local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('invalid origin');
    }

    const port = url.port && !((url.protocol === 'https:' && url.port === '443')
      || (url.protocol === 'http:' && url.port === '80')) ? `:${url.port}` : '';

    return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
  } catch {
    throw new SigningOriginError('invalid_server');
  }
}

// `fetch` v React Native je `whatwg-fetch` nad XHR: `redirect: 'error'` ignoruje
// a redirecty následuje. Origin odpovědi proto kontrolujeme sami — token se nesmí
// poslat na cizí host ani po redirectu.
export function isSameOrigin(url: string, origin: string): boolean {
  const base = origin.replace(/\/+$/, '');

  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}

export function assertResponseOrigin(response: Response, origin: string): void {
  // Prázdné `url` nesmí kontrolu přeskočit: bez důkazu o originu odpověď
  // odmítneme (N3).
  if (!response.url || !isSameOrigin(response.url, origin)) {
    throw new SigningOriginError('foreign_server');
  }
}

export async function resolveSigningOrigin(
  storage: PdfApiStorage,
  linkServer?: string,
  fallback = DEFAULT_SERVER_URL,
): Promise<string> {
  const settings = await loadPdfApiSettings(storage);
  const origin = signingOrigin(settings?.serverUrl ?? fallback ?? '');

  if (linkServer !== undefined && signingOrigin(linkServer) !== origin) {
    throw new SigningOriginError('foreign_server');
  }

  return origin;
}
