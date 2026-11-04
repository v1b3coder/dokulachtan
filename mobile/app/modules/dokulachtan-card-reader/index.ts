// Expo obal nad ACS BLE EVK (`acssmcio`): jen transport.
// Framing i AES-128 řeší ACS knihovna, appka posílá jen APDU.
import { requireNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

export interface CardReader {
  name: string;
}

export interface CardDeviceInfo {
  model: string;
  serial: string;
  firmware: string;
  manufacturer: string;
  battery: number;
}

interface NativeCardReaderModule {
  scan(timeoutMs: number): Promise<CardReader[]>;
  connect(name: string): Promise<CardReader>;
  deviceInfo(): Promise<CardDeviceInfo>;
  transmit(apduHex: string): Promise<string>;
  disconnect(): Promise<void>;
}

let native: NativeCardReaderModule | null = null;

try {
  native = requireNativeModule<NativeCardReaderModule>('DokulachtanCardReader');
} catch {
  native = null;
}

export function isCardReaderAvailable(): boolean {
  return native !== null;
}

// Android 12+ vyžaduje BLUETOOTH_SCAN/CONNECT, starší ACCESS_FINE_LOCATION.
// Bez oprávnění startScan selže a UI by hlásilo reader_error místo reader_not_found.
async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const needed =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const result = await PermissionsAndroid.requestMultiple(needed);

  return needed.every((perm) => result[perm] === PermissionsAndroid.RESULTS.GRANTED);
}

export async function scanCardReaders(timeoutMs = 15000): Promise<CardReader[]> {
  if (!native) {
    return [];
  }

  if (!(await ensurePermissions())) {
    throw new Error('reader_permission_denied');
  }

  return native.scan(timeoutMs);
}

export async function connectCardReader(name: string): Promise<CardReader> {
  if (!native) {
    throw new Error('reader_not_found');
  }

  return native.connect(name);
}

export async function cardDeviceInfo(): Promise<CardDeviceInfo> {
  if (!native) {
    throw new Error('reader_not_connected');
  }

  return native.deviceInfo();
}

export async function transmitApdu(apduHex: string): Promise<string> {
  if (!native) {
    throw new Error('reader_not_connected');
  }

  return native.transmit(apduHex);
}

export async function disconnectCardReader(): Promise<void> {
  return native ? native.disconnect() : undefined;
}
