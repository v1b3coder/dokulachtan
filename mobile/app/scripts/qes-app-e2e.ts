// E2E appky: spustí obřad podpisu KÓDEM APPKY (src/lib/*) proti reálnému
// serveru s testovacím certifikátem uloženým v appce (SPEC § 15.3).
// V appce je SecureStore/LocalAuthentication; tady je nahrazuje paměť.
// QES_E2E_FAKE_CARD=1 spustí variantu A (čip) s testovacím QSCD certem.
import { QesApi } from '../src/lib/api';
import { runSigningCeremony } from '../src/lib/ceremony';
import { FakeCardSigner } from '../src/lib/cardSigner';
import { importCertificate, type VaultDeps } from '../src/lib/crypto/vault';
import { TEST_P12_BASE64, TEST_P12_PASSWORD } from '../src/lib/testCertificate';

// Lokální testovací harness používá stejné HTTP výjimky jako dev build.
(globalThis as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

const token = process.env.QES_E2E_TOKEN ?? process.argv[2];
const serverUrl = process.env.QES_E2E_SERVER_URL ?? 'http://localhost:3030';
const fakeCard = process.env.QES_E2E_FAKE_CARD === '1';

if (!token) {
  console.error('Chybí token: QES_E2E_TOKEN nebo první argument');
  process.exit(1);
}

const memory = new Map<string, string>();
const dataMemory = new Map<string, string>();
const prompts: string[] = [];

function storageKey(key: string, options?: { requireAuthentication?: boolean }): string {
  return options?.requireAuthentication ? `auth_${key}` : key;
}

const storage = {
  getItem: async (key: string, options?: { requireAuthentication?: boolean; authenticationPrompt?: string }) => {
    if (options?.requireAuthentication) {
      prompts.push(options.authenticationPrompt ?? 'auth');
    }

    return memory.get(storageKey(key, options)) ?? null;
  },
  setItem: async (key: string, value: string, options?: { requireAuthentication?: boolean }) => {
    memory.set(storageKey(key, options), value);
  },
  deleteItem: async (key: string, options?: { requireAuthentication?: boolean }) => {
    memory.delete(storageKey(key, options));
  },
};

const dataStorage = {
  getItem: async (key: string) => dataMemory.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    dataMemory.set(key, value);
  },
  deleteItem: async (key: string) => {
    dataMemory.delete(key);
  },
};

const deps: VaultDeps = {
  storage,
  dataStorage,
  keyStorageOptions: { requireAuthentication: true, authenticationPrompt: 'sign' },
  biometrics: {
    isAvailable: async () => true,
    authenticate: async (reason) => {
      prompts.push(reason);

      return true;
    },
  },
  crypto: {
    randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  },
};

async function main(): Promise<void> {
  const p12 = Uint8Array.from(atob(TEST_P12_BASE64), (char) => char.charCodeAt(0));

  const info = await importCertificate(deps, p12, TEST_P12_PASSWORD);

  const result = await runSigningCeremony(
    {
      api: new QesApi(serverUrl, token),
      vault: deps,
      // Automatický souhlas pouze v explicitně spuštěném E2E harnessu.
      confirmDocument: async () => true,
      cardSigner: fakeCard ? new FakeCardSigner() : undefined,
      configuration: fakeCard
        ? { hasKey: false, hasReader: true, readerReady: true }
        : { hasKey: true, hasReader: false, readerReady: false },
    },
    fakeCard ? 'qes' : 'ades',
  );

  console.log(
    JSON.stringify({
      flow: fakeCard ? 'card' : 'key',
      level: result.level,
      key_location: result.keyLocation,
      biometric_prompts: prompts.length,
      certificate: { subject: info.subject, issuer: info.issuer, level: info.level },
      completed: result.completed,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: (error as Error).message }));
  process.exit(1);
});
