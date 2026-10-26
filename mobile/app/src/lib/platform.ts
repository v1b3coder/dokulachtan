// Napojení appky na reálné Expo moduly (SecureStore, LocalAuthentication,
// expo-crypto, expo-file-system). Testy a e2e harness používají paměťové
// implementace.
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import type { VaultDeps, VaultStorageOptions } from './crypto/vault';

const keyStorageOptions: VaultStorageOptions = {
  keychainService: 'cz.dokulachtan.signer.vault',
  requireAuthentication: true,
  authenticationPrompt: 'Odemkněte klíč pro podpis',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function dataFile(key: string): File {
  return new File(Paths.document, ...key.split('/'));
}

// Biometricky chráněný klíč ukládáme pod `auth_` alias, aby ho import mohl
// smazat jako legacy klíč a nový zůstal dostupný pro unlock. Dvojtečku
// SecureStore nepovoluje (klíč musí být jen [\w.-]+).
function storageKey(key: string, options?: VaultStorageOptions): string {
  return options?.requireAuthentication ? `auth_${key}` : key;
}

export function platformVaultDeps(): VaultDeps {
  return {
    storage: {
      getItem: (key, options) => SecureStore.getItemAsync(storageKey(key, options), options),
      setItem: (key, value, options) => SecureStore.setItemAsync(storageKey(key, options), value, options),
      deleteItem: (key, options) => SecureStore.deleteItemAsync(storageKey(key, options), options),
    },
    dataStorage: {
      getItem: async (key) => {
        const file = dataFile(key);

        return file.exists ? file.text() : null;
      },
      setItem: async (key, value) => {
        const file = dataFile(key);

        if (!file.exists) {
          file.create({ intermediates: true, overwrite: true });
        }

        await file.write(value);
      },
      deleteItem: async (key) => {
        const file = dataFile(key);

        if (file.exists) {
          file.delete();
        }
      },
    },
    keyStorageOptions,
    biometrics: {
      isAvailable: async () => {
        const [hasHardware, isEnrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);

        return hasHardware && isEnrolled && SecureStore.canUseBiometricAuthentication();
      },
      authenticate: async (reason) => {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: reason,
          cancelLabel: 'Zrušit',
          disableDeviceFallback: true,
          biometricsSecurityLevel: 'strong',
        });

        return result.success;
      },
    },
    crypto: {
      randomBytes: (length) => Crypto.getRandomBytes(length),
    },
  };
}
