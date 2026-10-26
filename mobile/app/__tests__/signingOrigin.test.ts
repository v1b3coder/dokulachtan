import { DEFAULT_SERVER_URL, resolveSigningOrigin, signingOrigin } from '../src/lib/signingOrigin';

const storage = (settings: unknown) => ({
  getItem: async () => settings === null ? null : JSON.stringify(settings),
  setItem: async () => {},
  deleteItem: async () => {},
});

it('uses Settings even without an account API token', async () => {
  await expect(resolveSigningOrigin(storage({ serverUrl: 'https://company.test/' }), undefined,
    'https://fallback.test')).resolves.toBe('https://company.test');
});

it('uses the build origin only when no server is configured', async () => {
  await expect(resolveSigningOrigin(storage(null), undefined, 'https://fallback.test'))
    .resolves.toBe('https://fallback.test');
});

it('signs for the built-in production server on a fresh install with no build origin', async () => {
  expect(DEFAULT_SERVER_URL).toBe('https://dokulachtan.fly.dev');
  await expect(resolveSigningOrigin(storage(null), 'https://dokulachtan.fly.dev'))
    .resolves.toBe('https://dokulachtan.fly.dev');
  await expect(resolveSigningOrigin(storage(null), 'https://attacker.test'))
    .rejects.toMatchObject({ code: 'foreign_server' });
});

it('rejects a foreign link before any request and accepts equivalent origins', async () => {
  const settings = storage({ serverUrl: 'https://company.test' });
  await expect(resolveSigningOrigin(settings, 'https://attacker.test'))
    .rejects.toMatchObject({ code: 'foreign_server' });
  await expect(resolveSigningOrigin(settings, 'https://COMPANY.test:443/'))
    .resolves.toBe('https://company.test');
});

it.each(['http://company.test', 'https://user:pass@company.test', 'file:///file',
  'https://company.test/path', 'https://company.test?x=1', ''])('rejects unsafe origin %s', (url) => {
  expect(() => signingOrigin(url)).toThrow('invalid_server');
});

it.each(['localhost', '10.0.2.2'])('allows HTTP %s only in development', (host) => {
  expect(signingOrigin(`http://${host}:3000`, true)).toBe(`http://${host}:3000`);
  expect(() => signingOrigin(`http://${host}:3000`, false)).toThrow('invalid_server');
});
