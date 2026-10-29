// Důvěryhodné servery pro podpisové odkazy (TOFU): při prvním odkazu
// uživatel potvrdí origin a appka si ho zapamatuje. Není to tajemství,
// proto dataStorage (soubor), ne SecureStore s biometrií.
import { loadPdfApiSettings, type PdfApiStorage } from './pdfApi';
import { signingOrigin, SigningOriginError } from './signingOrigin';

export const TRUSTED_SERVERS_KEY = 'cz.dokulachtan.signer.trusted_servers';

export interface TrustedServer {
  origin: string;
  approvedAt: string;
}

export interface WorkflowOrigin {
  origin: string;
  trusted: boolean;
}

export async function loadTrustedServers(storage: PdfApiStorage): Promise<TrustedServer[]> {
  const raw = await storage.getItem(TRUSTED_SERVERS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    const servers: TrustedServer[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof (item as TrustedServer).origin !== 'string') {
        continue;
      }

      let origin: string;

      try {
        origin = signingOrigin((item as TrustedServer).origin);
      } catch {
        continue;
      }

      if (seen.has(origin)) {
        continue;
      }

      seen.add(origin);
      servers.push({
        origin,
        approvedAt: typeof (item as TrustedServer).approvedAt === 'string'
          ? (item as TrustedServer).approvedAt
          : new Date(0).toISOString(),
      });
    }

    return servers;
  } catch {
    return [];
  }
}

export async function saveTrustedServers(
  storage: PdfApiStorage,
  servers: TrustedServer[],
): Promise<void> {
  await storage.setItem(TRUSTED_SERVERS_KEY, JSON.stringify(servers));
}

export async function trustServer(storage: PdfApiStorage, value: string): Promise<TrustedServer> {
  const origin = signingOrigin(value);
  const servers = await loadTrustedServers(storage);
  const existing = servers.find((server) => server.origin === origin);

  if (existing) {
    return existing;
  }

  const server = { origin, approvedAt: new Date().toISOString() };

  await saveTrustedServers(storage, [...servers, server]);

  return server;
}

export async function revokeTrustedServer(storage: PdfApiStorage, value: string): Promise<void> {
  const origin = signingOrigin(value);
  const servers = await loadTrustedServers(storage);

  await saveTrustedServers(storage, servers.filter((server) => server.origin !== origin));
}

// Workflow (podpisový odkaz) používá jen server z odkazu; Nastavení je jen
// pro přímý podpis a ověření PDF. Odkaz bez serveru je chyba, ne tichý fallback.
export async function resolveWorkflowOrigin(
  storage: PdfApiStorage,
  linkServer?: string,
): Promise<WorkflowOrigin> {
  if (!linkServer) {
    throw new SigningOriginError('missing_server');
  }

  const origin = signingOrigin(linkServer);
  const servers = await loadTrustedServers(storage);

  if (servers.some((server) => server.origin === origin)) {
    return { origin, trusted: true };
  }

  // Server z Nastavení je uživatelův vlastní; nechceme po něm TOFU potvrzení.
  const settings = await loadPdfApiSettings(storage);

  if (settings?.serverUrl) {
    try {
      if (signingOrigin(settings.serverUrl) === origin) {
        return { origin, trusted: true };
      }
    } catch {
      // Neplatné Nastavení nemá trust ovlivnit; rozhodne se podle seznamu.
    }
  }

  return { origin, trusted: false };
}
