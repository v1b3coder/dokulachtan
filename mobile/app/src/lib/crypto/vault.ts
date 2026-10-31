// Úložiště klíče (SPEC § 9.5): PKCS#12 se dešifruje heslem při importu a klíčový
// materiál se IHNED přešifruje AES-256-GCM klíčem z vaultu. Vault klíč je
// náhodný 256bitový a SecureStore ho vydá jen po biometrickém ověření
// (requireAuthentication). Heslo k PKCS#12 se NIKDY neukládá a při podpisu se
// nevyžaduje — jen biometrie.
//
// AES-GCM je přes node-forge (čistý JS), protože React Native/Hermes nemá WebCrypto.
import forge from 'node-forge';

import { parseP12, binaryToUint8, uint8ToBinary } from './p12';
import type { QesLevel } from '../types';

export interface VaultStorageOptions {
  keychainService?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainAccessible?: number;
}

export interface VaultStorage {
  getItem(key: string, options?: VaultStorageOptions): Promise<string | null>;
  setItem(key: string, value: string, options?: VaultStorageOptions): Promise<void>;
  deleteItem(key: string, options?: VaultStorageOptions): Promise<void>;
}

export interface Biometrics {
  isAvailable(): Promise<boolean>;
  authenticate(reason: string): Promise<boolean>;
}

export interface VaultCrypto {
  randomBytes(length: number): Uint8Array;
}

export interface VaultDeps {
  storage: VaultStorage;
  dataStorage: VaultStorage;
  keyStorageOptions: VaultStorageOptions;
  biometrics: Biometrics;
  crypto: VaultCrypto;
}

export interface StoredCertificateInfo {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  qcStatements: string[];
  level: QesLevel;
  keyType: string;
  keySize: number;
  // Veřejný cert a chain leží mimo šifrovaný payload: appka je posílá
  // serveru před odemčením klíče (TBS s pečetí z certu).
  certificatePem: string;
  chainPems: string[];
}

interface StoredPayload {
  iv: string;
  tag: string;
  ciphertext: string;
  info: StoredCertificateInfo;
}

interface KeyMaterial {
  privateKeyPem: string;
}

const VAULT_KEY = 'cz.dokulachtan.signer.vault';
const VAULT_KEY_ENTRY = `${VAULT_KEY}.key`;
const VAULT_DATA_ENTRY = `${VAULT_KEY}.certificate`;
const VAULT_DATA_FILE = 'vault/certificate.json';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class VaultError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function toBase64(bytes: Uint8Array): string {
  return btoa(uint8ToBinary(bytes));
}

function fromBase64(value: string): Uint8Array {
  return binaryToUint8(atob(value));
}

// AES-256-GCM přes node-forge (funguje v Hermes/React Native i v Node testech).
function encryptGcm(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const cipher = forge.cipher.createCipher('AES-GCM', uint8ToBinary(key));
  const options: forge.cipher.StartOptions = {
    iv: uint8ToBinary(iv),
    tagLength: TAG_LENGTH * 8,
  };

  if (aad) {
    options.additionalData = uint8ToBinary(aad);
  }

  cipher.start(options);
  cipher.update(forge.util.createBuffer(uint8ToBinary(plaintext)));

  if (!cipher.finish()) {
    throw new VaultError('vault_encrypt_failed');
  }

  return {
    ciphertext: binaryToUint8(cipher.output.getBytes()),
    tag: binaryToUint8(cipher.mode.tag.getBytes()),
  };
}

function decryptGcm(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const decipher = forge.cipher.createDecipher('AES-GCM', uint8ToBinary(key));
  const options: forge.cipher.StartOptions = {
    iv: uint8ToBinary(iv),
    tagLength: TAG_LENGTH * 8,
    tag: forge.util.createBuffer(uint8ToBinary(tag)),
  };

  if (aad) {
    options.additionalData = uint8ToBinary(aad);
  }

  decipher.start(options);
  decipher.update(forge.util.createBuffer(uint8ToBinary(ciphertext)));

  if (!decipher.finish()) {
    throw new VaultError('vault_decrypt_failed');
  }

  return binaryToUint8(decipher.output.getBytes());
}

function storageError(error: unknown): VaultError {
  if (error instanceof VaultError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/cancel/i.test(message)) {
    return new VaultError('biometry_rejected');
  }

  if (/invalidated|no corresponding KeyStore key/i.test(message)) {
    return new VaultError('key_invalidated');
  }

  if (/decrypt|tag|padding/i.test(message)) {
    return new VaultError('vault_decrypt_failed');
  }

  if (/biometric|authentication|enrolled|hardware/i.test(message)) {
    return new VaultError('biometry_unavailable');
  }

  return new VaultError('vault_unavailable');
}

async function loadVaultKey(
  deps: VaultDeps,
  create: boolean,
  prompt?: string,
): Promise<Uint8Array | null> {
  const options = prompt
    ? { ...deps.keyStorageOptions, authenticationPrompt: prompt }
    : deps.keyStorageOptions;
  let stored: string | null;

  try {
    stored = await deps.storage.getItem(VAULT_KEY_ENTRY, options);
  } catch (error) {
    throw storageError(error);
  }

  if (stored) {
    return fromBase64(stored);
  }

  if (!create) {
    return null;
  }

  const raw = deps.crypto.randomBytes(32);

  try {
    await deps.storage.setItem(VAULT_KEY_ENTRY, toBase64(raw), options);
  } catch (error) {
    throw storageError(error);
  }

  return raw;
}

function parseStoredPayload(stored: string): StoredPayload {
  try {
    return JSON.parse(stored) as StoredPayload;
  } catch {
    throw new VaultError('vault_unavailable');
  }
}

async function readStoredPayload(deps: VaultDeps): Promise<StoredPayload | null> {
  let stored: string | null;

  try {
    stored = await deps.dataStorage.getItem(VAULT_DATA_FILE);
  } catch (error) {
    throw storageError(error);
  }

  return stored ? parseStoredPayload(stored) : null;
}

function aadFor(payload: StoredPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload.info));
}

// Import: dešifruje PKCS#12 heslem; veřejný cert a chain uloží nešifrovaně
// (posílají se serveru před odemčením klíče), privátní klíč přešifruje vault klíčem.
export async function importCertificate(
  deps: VaultDeps,
  p12Bytes: Uint8Array,
  password: string,
): Promise<StoredCertificateInfo> {
  const parsed = parseP12(p12Bytes, password);

  if (!parsed.canSign) {
    throw new VaultError('unsupported_certificate');
  }

  if ((await readStoredPayload(deps)) !== null) {
    const authenticated = await deps.biometrics.authenticate('Nahradit uložený klíč');

    if (!authenticated) {
      throw new VaultError('biometry_rejected');
    }
  }

  const vaultKey = await loadVaultKey(deps, true);

  if (!vaultKey) {
    throw new VaultError('vault_unavailable');
  }

  const iv = deps.crypto.randomBytes(IV_LENGTH);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ privateKeyPem: parsed.privateKeyPem }),
  );

  const info: StoredCertificateInfo = {
    subject: parsed.subject,
    issuer: parsed.issuer,
    serial: parsed.serial,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    qcStatements: parsed.qcStatements,
    level: parsed.level,
    keyType: parsed.keyType,
    keySize: parsed.keySize,
    certificatePem: parsed.certificatePem,
    chainPems: parsed.chainPems,
  };

  const aad = new TextEncoder().encode(JSON.stringify(info));
  const { ciphertext, tag } = encryptGcm(vaultKey, iv, plaintext, aad);

  const payload: StoredPayload = {
    iv: toBase64(iv),
    tag: toBase64(tag),
    ciphertext: toBase64(ciphertext),
    info,
  };

  try {
    await deps.dataStorage.setItem(VAULT_DATA_FILE, JSON.stringify(payload));
    await deps.storage.deleteItem(VAULT_DATA_ENTRY);
    await deps.storage.deleteItem(VAULT_KEY_ENTRY);
  } catch (error) {
    throw storageError(error);
  }

  return info;
}

// Podpis: biometrie → odemčení vault klíče → dešifrování privátního klíče.
export async function unlockCertificate(
  deps: VaultDeps,
  reason: string,
): Promise<{ privateKeyPem: string; info: StoredCertificateInfo }> {
  const payload = await readStoredPayload(deps);

  if (!payload) {
    throw new VaultError('certificate_missing');
  }

  const available = await deps.biometrics.isAvailable();

  if (!available) {
    throw new VaultError('biometry_unavailable');
  }

  const vaultKey = await loadVaultKey(deps, false, reason);

  if (!vaultKey) {
    throw new VaultError('key_invalidated');
  }

  const plaintext = decryptGcm(
    vaultKey,
    fromBase64(payload.iv),
    fromBase64(payload.ciphertext),
    fromBase64(payload.tag),
    aadFor(payload),
  );
  const material = parseKeyMaterial(plaintext);

  return { privateKeyPem: material.privateKeyPem, info: payload.info };
}

function parseKeyMaterial(plaintext: Uint8Array): KeyMaterial {
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as KeyMaterial;
  } catch {
    throw new VaultError('vault_decrypt_failed');
  }
}

export async function hasCertificate(deps: VaultDeps): Promise<boolean> {
  return (await readStoredPayload(deps)) !== null;
}

export async function certificateSummary(deps: VaultDeps): Promise<StoredCertificateInfo | null> {
  const payload = await readStoredPayload(deps);

  return payload ? payload.info : null;
}

export async function removeCertificate(deps: VaultDeps): Promise<void> {
  const authenticated = await deps.biometrics.authenticate('Smazat uložený klíč');

  if (!authenticated) {
    throw new VaultError('biometry_rejected');
  }

  try {
    await deps.dataStorage.deleteItem(VAULT_DATA_FILE);
  } catch (error) {
    throw storageError(error);
  }

  try {
    await deps.storage.deleteItem(VAULT_DATA_ENTRY);
    await deps.storage.deleteItem(VAULT_KEY_ENTRY, deps.keyStorageOptions);
    await deps.storage.deleteItem(VAULT_KEY_ENTRY);
  } catch {
    // Datový payload je pryč; osiřelý klíč už nejde použít.
  }
}
