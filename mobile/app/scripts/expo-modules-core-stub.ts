// E2E běží mimo React Native (tsx/esbuild): `expo-modules-core` i `react-native`
// jsou pro esbuild nečitelný Flow zdroják. E2E žádný nativní modul nepoužívá
// (`FakeCardSigner`), takže `requireNativeModule` stačí, aby selhal jako v appce
// bez nativního modulu — `isCardReaderAvailable()` pak vrátí `false`.
export function requireNativeModule(name: string): never {
  throw new Error(`native module ${name} is not available in e2e`);
}

export const NativeModulesProxy = {};
