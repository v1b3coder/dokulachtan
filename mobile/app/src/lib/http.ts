// Transport pro QES/PDF API. V React Native použije `expo/fetch`, který
// předává `redirect` nativnímu OkHttp; `redirect: 'error'` zabrání tomu, aby
// token nebo tělo odešly na cizí host po přesměrování (N3).
// `assertResponseOrigin` zůstává druhá vrstva.

type FetchImpl = typeof fetch;

function nativeFetch(): FetchImpl | undefined {
  // V Jestu a v Node e2e harnessu není nativní modul k dispozici.
  if (process.env.NODE_ENV === 'test'
    || typeof navigator === 'undefined'
    || navigator.product !== 'ReactNative') {
    return undefined;
  }

  try {
    // Líný require: `expo/fetch` na Node/netest cestě nesmí být načtený.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetch } = require('expo/fetch') as { fetch: FetchImpl };

    return fetch;
  } catch {
    return undefined;
  }
}

export const secureFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
  const implementation = nativeFetch() ?? globalThis.fetch;

  return implementation(input, { ...init, redirect: 'error' });
}) as typeof fetch;

// Strop pro jednu operaci (hlavičky i tělo): bez něj visí UI navěky — spinner
// u initial loadu, zamčené tlačítko u podpisu. Automatický retry záměrně není,
// uživatel opakuje ručně.
export const READ_TIMEOUT_MS = 15_000; // GET metadata (session, submitter)
export const DOCUMENT_TIMEOUT_MS = 30_000; // GET /document (TBS PDF)
export const WRITE_TIMEOUT_MS = 60_000; // POST certificate / complete_submission
export const HEAVY_TIMEOUT_MS = 120_000; // POST complete, 25MB upload, download PDF

export class HttpTimeoutError extends Error {
  readonly code = 'timeout';

  constructor() {
    super('timeout');
  }
}

function isAbortError(error: unknown): boolean {
  // `expo/fetch` i undici odmítnou pending čtení s AbortError; některé
  // implementace dají jen `Error('The operation was aborted.')`.
  return error instanceof Error
    && (error.name === 'AbortError' || /abort/i.test(error.message));
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    // Timer mohl vypršet mezi hlavičkami a tělem: signál je pak už abortovaný,
    // ale čtení těla to nemusí poznat (implementace bez `signal`).
    throw controller.signal.aborted || isAbortError(error) ? new HttpTimeoutError() : error;
  } finally {
    clearTimeout(timer);
  }
}
