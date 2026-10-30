import {
  loadTrustedServers,
  resolveWorkflowOrigin,
  revokeTrustedServer,
  trustServer,
  TRUSTED_SERVERS_KEY,
} from '../src/lib/trustedServers';
import { PDF_API_SETTINGS_KEY } from '../src/lib/pdfApi';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));

  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => { data.set(key, value); },
    deleteItem: async (key: string) => { data.delete(key); },
  };
}

it('starts with no trusted servers', async () => {
  await expect(loadTrustedServers(memoryStorage())).resolves.toEqual([]);
});

it('stores a normalized origin only once', async () => {
  const storage = memoryStorage();

  await trustServer(storage, 'https://COMPANY.test:443/');
  await trustServer(storage, 'https://company.test');

  expect(await loadTrustedServers(storage)).toEqual([
    { origin: 'https://company.test', approvedAt: expect.any(String) },
  ]);
  expect(JSON.parse(storage.data.get(TRUSTED_SERVERS_KEY) ?? '[]')).toHaveLength(1);
});

it('revokes trust by normalized origin', async () => {
  const storage = memoryStorage();

  await trustServer(storage, 'https://company.test');
  await trustServer(storage, 'https://other.test');
  await revokeTrustedServer(storage, 'https://COMPANY.test:443/');

  expect((await loadTrustedServers(storage)).map((server) => server.origin))
    .toEqual(['https://other.test']);
});

it('ignores malformed and unsafe stored entries', async () => {
  const storage = memoryStorage({
    [TRUSTED_SERVERS_KEY]: JSON.stringify([
      { origin: 'https://company.test/path', approvedAt: 'x' },
      { origin: 'http://company.test', approvedAt: 'x' },
      { origin: 'https://company.test', approvedAt: '2026-01-01T00:00:00Z' },
      { origin: 'https://company.test', approvedAt: 'duplicate' },
      'not-an-object',
    ]),
  });

  expect(await loadTrustedServers(storage)).toEqual([
    { origin: 'https://company.test', approvedAt: '2026-01-01T00:00:00Z' },
  ]);
});

it('rejects an invalid origin when trusting', async () => {
  await expect(trustServer(memoryStorage(), 'http://company.test'))
    .rejects.toMatchObject({ code: 'invalid_server' });
});

it('uses the link origin on a fresh install without Settings', async () => {
  await expect(resolveWorkflowOrigin(memoryStorage(), 'https://link.test'))
    .resolves.toEqual({ origin: 'https://link.test', trusted: false });
});

it('uses the link origin and reports trust for workflows', async () => {
  const storage = memoryStorage({
    [PDF_API_SETTINGS_KEY]: JSON.stringify({ serverUrl: 'https://settings.test', apiToken: '' }),
  });

  await expect(resolveWorkflowOrigin(storage, 'https://link.test'))
    .resolves.toEqual({ origin: 'https://link.test', trusted: false });

  await trustServer(storage, 'https://link.test');

  await expect(resolveWorkflowOrigin(storage, 'https://link.test'))
    .resolves.toEqual({ origin: 'https://link.test', trusted: true });
});

it('trusts the server configured in Settings without a TOFU record', async () => {
  const storage = memoryStorage({
    [PDF_API_SETTINGS_KEY]: JSON.stringify({ serverUrl: 'https://settings.test', apiToken: '' }),
  });

  await expect(resolveWorkflowOrigin(storage, 'https://SETTINGS.test:443/'))
    .resolves.toEqual({ origin: 'https://settings.test', trusted: true });
});

it('rejects a link without a server instead of using Settings', async () => {
  const storage = memoryStorage({
    [PDF_API_SETTINGS_KEY]: JSON.stringify({ serverUrl: 'https://settings.test', apiToken: '' }),
  });

  await expect(resolveWorkflowOrigin(storage)).rejects.toMatchObject({ code: 'missing_server' });
});
