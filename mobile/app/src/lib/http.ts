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
