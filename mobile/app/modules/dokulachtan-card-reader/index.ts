// Expo obal nad ACS BLE EVK (`acssmcio`): jen transport.
// Framing i AES-128 řeší ACS knihovna, appka posílá jen APDU.
import { requireNativeModule } from 'expo-modules-core';

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

export async function scanCardReaders(timeoutMs = 15000): Promise<CardReader[]> {
  return native ? native.scan(timeoutMs) : [];
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
