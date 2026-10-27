// Transport pro QES/PDF API. `expo/fetch` předává `redirect` nativnímu
// OkHttp; `redirect: 'error'` zabrání tomu, aby token nebo tělo odešly na cizí
// host po přesměrování (N3). `assertResponseOrigin` zůstává druhá vrstva.
import { fetch as expoFetch } from 'expo/fetch';

const nativeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  // V Jestu není nativní modul k dispozici; testy používají global.fetch.
  if (process.env.NODE_ENV === 'test' || typeof expoFetch !== 'function') {
    return globalThis.fetch(input, init);
  }

  return expoFetch(input, init);
}) as typeof fetch;

export const secureFetch = ((input: RequestInfo | URL, init: RequestInit = {}) =>
  nativeFetch(input, { ...init, redirect: 'error' })) as typeof fetch;
