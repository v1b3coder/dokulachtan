import {
  importCertificate,
  unlockCertificate,
  removeCertificate,
  certificateSummary,
  signerDisplayName,
  hasCertificate,
  VaultError,
  type VaultDeps,
  type VaultStorage,
  type VaultStorageOptions,
} from '../src/lib/crypto/vault';
import { TEST_P12_BASE64, TEST_P12_PASSWORD, importTestCertificate } from '../src/lib/testCertificate';

const KEY_ENTRY = 'cz.dokulachtan.signer.vault.key';
const DATA_ENTRY = 'cz.dokulachtan.signer.vault.certificate';
const DATA_FILE = 'vault/certificate.json';

function storageKey(key: string, options?: VaultStorageOptions): string {
  return options?.requireAuthentication ? `auth_${key}` : key;
}

function makeDeps() {
  const memory = new Map<string, string>();
  const dataMemory = new Map<string, string>();
  const storagePrompts: string[] = [];
  const biometricPrompts: string[] = [];
  let available = true;
  let rejectAuth = false;

  const storage: VaultStorage = {
    getItem: async (key, options) => {
      if (options?.requireAuthentication) {
        storagePrompts.push(options.authenticationPrompt ?? 'auth');

        if (rejectAuth) {
          throw new Error('User canceled the authentication');
        }
      }

      return memory.get(storageKey(key, options)) ?? null;
    },
    setItem: async (key, value, options) => {
      if (options?.requireAuthentication) {
        storagePrompts.push(options.authenticationPrompt ?? 'auth');
      }

      memory.set(storageKey(key, options), value);
    },
    deleteItem: async (key, options) => {
      memory.delete(storageKey(key, options));
    },
  };

  const dataStorage: VaultStorage = {
    getItem: async (key) => dataMemory.get(key) ?? null,
    setItem: async (key, value) => {
      dataMemory.set(key, value);
    },
    deleteItem: async (key) => {
      dataMemory.delete(key);
    },
  };

  const deps: VaultDeps = {
    storage,
    dataStorage,
    keyStorageOptions: { requireAuthentication: true, authenticationPrompt: 'sign' },
    biometrics: {
      isAvailable: async () => available,
      authenticate: async (reason) => {
        biometricPrompts.push(reason);

        return true;
      },
    },
    crypto: {
      randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
    },
  };

  return {
    deps,
    memory,
    dataMemory,
    storagePrompts,
    biometricPrompts,
    denyBiometrics: () => {
      available = false;
    },
    rejectAuth: () => {
      rejectAuth = true;
    },
  };
}

function testP12(): Uint8Array {
  return Uint8Array.from(atob(TEST_P12_BASE64), (char) => char.charCodeAt(0));
}

describe('vault', () => {
  it('imports the certificate and stores the encrypted material outside SecureStore', async () => {
    const { deps, memory, dataMemory } = makeDeps();

    const info = await importCertificate(deps, testP12(), TEST_P12_PASSWORD);

    expect(info.level).toBe('ades');
    expect(memory.get(`auth_${KEY_ENTRY}`)).toBeDefined();
    expect(memory.get(DATA_ENTRY)).toBeUndefined();
    expect(dataMemory.get(DATA_FILE)).toBeDefined();
    expect(dataMemory.get(DATA_FILE)).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(dataMemory.get(DATA_FILE)).not.toContain(TEST_P12_PASSWORD);
    expect((dataMemory.get(DATA_FILE) ?? '').length).toBeGreaterThan(2048);
    expect(await hasCertificate(deps)).toBe(true);
  });

  it('uses a random 256-bit vault key, not a password', async () => {
    const { deps, memory } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);

    const key = memory.get(`auth_${KEY_ENTRY}`) ?? '';

    expect(atob(key)).toHaveLength(32);
  });

  it('unlocks only through SecureStore authentication, never with an app-level prompt', async () => {
    const { deps, storagePrompts, biometricPrompts } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    storagePrompts.length = 0;
    biometricPrompts.length = 0;

    const material = await unlockCertificate(deps, 'sign');

    expect(storagePrompts).toEqual(['sign']);
    expect(biometricPrompts).toEqual([]);
    expect(material.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(material.info.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(material.info.chainPems.length).toBeGreaterThan(0);
  });

  it('refuses to unlock when biometrics are unavailable', async () => {
    const { deps, denyBiometrics } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    denyBiometrics();

    await expect(unlockCertificate(deps, 'sign')).rejects.toThrow(VaultError);
  });

  it('refuses to unlock when the OS prompt is cancelled', async () => {
    const { deps, rejectAuth } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    rejectAuth();

    await expect(unlockCertificate(deps, 'sign')).rejects.toMatchObject({ code: 'biometry_rejected' });
  });

  it('reports an invalidated key after the vault key disappears', async () => {
    const { deps, memory } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    memory.delete(`auth_${KEY_ENTRY}`);

    await expect(unlockCertificate(deps, 'sign')).rejects.toMatchObject({ code: 'key_invalidated' });
  });

  it('requires biometrics before replacing an existing certificate', async () => {
    const { deps, biometricPrompts, rejectAuth } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    biometricPrompts.length = 0;

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);

    expect(biometricPrompts).toEqual(['Nahradit uložený klíč']);

    rejectAuth();
    biometricPrompts.length = 0;

    await expect(importCertificate(deps, testP12(), TEST_P12_PASSWORD)).rejects.toMatchObject({
      code: 'biometry_rejected',
    });
  });

  it('removes the certificate, payload and both vault key aliases', async () => {
    const { deps, memory, dataMemory, biometricPrompts } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    biometricPrompts.length = 0;

    expect((await certificateSummary(deps))?.subject).toContain('signer-ades');

    await removeCertificate(deps);

    expect(await hasCertificate(deps)).toBe(false);
    expect(memory.get(`auth_${KEY_ENTRY}`)).toBeUndefined();
    expect(memory.get(KEY_ENTRY)).toBeUndefined();
    expect(dataMemory.get(DATA_FILE)).toBeUndefined();
    expect(biometricPrompts).toEqual(['Smazat uložený klíč']);
  });

  it('ignores a legacy vault entry and cleans it on the next import', async () => {
    const { deps, memory } = makeDeps();

    memory.set(DATA_ENTRY, '{"version":1}');
    memory.set(KEY_ENTRY, 'legacy');

    expect(await hasCertificate(deps)).toBe(false);

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);

    expect(await hasCertificate(deps)).toBe(true);
    expect(memory.get(DATA_ENTRY)).toBeUndefined();
    expect(memory.get(KEY_ENTRY)).toBeUndefined();
  });

  it('imports the test certificate into an empty vault', async () => {
    const { deps } = makeDeps();

    expect((await importTestCertificate(deps)).subject).toContain('signer-ades');
    expect(await hasCertificate(deps)).toBe(true);
  });

  it('uses the certificate CN, then the SAN e-mail, then the stored subject', () => {
    const info = {
      subject: 'Jan Novák',
      issuer: 'Test CA',
      serial: '0x01',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z',
      qcStatements: [],
      level: 'ades' as const,
      keyType: 'rsa',
      keySize: 2048,
      certificatePem: '',
      chainPems: [],
    };

    expect(signerDisplayName({ ...info, commonName: 'Jan Novák', email: 'jan@example.com' }))
      .toBe('Jan Novák');
    expect(signerDisplayName({ ...info, commonName: null, email: 'jan@example.com' }))
      .toBe('jan@example.com');
    expect(signerDisplayName(info)).toBe('Jan Novák');
  });

  it('refuses to overwrite a stored key with the test certificate', async () => {
    const { deps, dataMemory } = makeDeps();

    await importCertificate(deps, testP12(), TEST_P12_PASSWORD);
    const stored = dataMemory.get(DATA_FILE);

    await expect(importTestCertificate(deps)).rejects.toMatchObject({
      code: 'certificate_present',
    });
    expect(dataMemory.get(DATA_FILE)).toBe(stored);
  });
});
