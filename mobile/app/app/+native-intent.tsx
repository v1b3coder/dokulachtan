// Přepis příchozích odkazů (SPEC § 10.1): iOS Universal Link míří na
// webovou stránku `/qes/sign` (resp. `/qes/app`), ale routy appky jsou `/sign`
// (resp. `/`). Z HTTPS odkazu předáme i origin serveru; custom scheme
// `dokulachtan://sign?token=…&server=…` odpovídá routě přímo a server už nese.
// Android App Links jsou zrušeny (#18.1) — Android jde jen přes custom scheme.
const APP_LINK = /^(https?:\/\/[^/?#]+)?\/qes(\/[^?#]*)?(?:\?([^#]*))?$/;

// Routy, které nikdy nesmí přijmout parametry z odkazu: lokální soubor se
// předává handoffem v paměti (opaque id), takže `?share=file:///…` zvenku
// nesmí projít. `dokulachtan://` je schéma appky, ne kanál serveru.
const PARAM_FREE_LINK =
  /^(?:dokulachtan:\/\/|(?:https?:\/\/[^/?#]+)?\/qes\/)(sign-pdf|verify-pdf)(?:[?#].*)?$/i;

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const stripped = PARAM_FREE_LINK.test(path) ? path.replace(/[?#].*$/, '') : path;
  const match = stripped.match(APP_LINK);

  if (!match) {
    return stripped;
  }

  const route = match[2] === undefined || match[2] === '/app' ? '/' : match[2];
  const params = new URLSearchParams(match[3] ?? '');

  // Host u iOS Universal Linku ověřil OS (AASA). Appka ho použije jen
  // pro podpisový odkaz, nikdy pro přímý podpis PDF (ten má Nastavení).
  if (match[1] && route === '/sign') {
    params.set('server', match[1]);
  }

  const query = params.toString();

  return `${route}${query ? `?${query}` : ''}`;
}
