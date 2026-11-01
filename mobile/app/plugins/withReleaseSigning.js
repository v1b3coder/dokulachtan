// Config plugin: release APK podepisuje release keystorem z CI. Lokální buildy
// mají dva explicitní targety a oba používají debug keystore tohoto počítače:
// - `make debug-phone` = `.debug` / „Dokulachtan (debug)“, arm64,
// - `make emulator`    = `.emulator` / „Dokulachtan (emulator)“, x86_64.
// `release` = release build s CI keystorem, bez suffixu; lokálně se nebuildí
// (`assembleRelease` bez `ANDROID_KEYSTORE_PATH` selže).
//
// `android/` je generovaný `expo prebuild`, takže přímá úprava build.gradle by se
// při dalším prebuildu ztratila — proto plugin.
const { withAppBuildGradle } = require('expo/config-plugins');

const LOCAL_DEBUG_KEYSTORE = 'file(System.getProperty("user.home") + "/.android/debug.keystore")';

const RELEASE_SIGNING = `        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: (System.getProperty("user.home") + "/.android/debug.keystore"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "android"
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "androiddebugkey"
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: "android"
        }
`;

const PHONE_IDENTITY = [
  'applicationIdSuffix ".debug"',
  'versionNameSuffix "-debug"',
  'resValue "string", "app_name", "Dokulachtan (debug)"',
  'resValue "string", "share_pdf_label", "Podepsat PDF (debug)"',
  'resValue "string", "open_pdf_label", "Ověřit PDF (debug)"',
];

const EMULATOR_IDENTITY = [
  'applicationIdSuffix ".emulator"',
  'versionNameSuffix "-emulator"',
  'resValue "string", "app_name", "Dokulachtan (emulator)"',
  'resValue "string", "share_pdf_label", "Podepsat PDF (emulator)"',
  'resValue "string", "open_pdf_label", "Ověřit PDF (emulator)"',
];

const RELEASE_KEY_GUARD = `// Release APK se podepisuje jen v CI release keystorem.
if (gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") } && !System.getenv("ANDROID_KEYSTORE_PATH")) {
    throw new GradleException("Release build vyžaduje ANDROID_KEYSTORE_PATH (CI). Lokálně použij make debug-phone nebo make emulator.")
}

android {`;

function indent(lines, spaces) {
  return lines.map((line) => `${' '.repeat(spaces)}${line}`).join('\n');
}

function addReleaseSigning(contents) {
  if (contents.includes('signingConfigs.release')) {
    return contents;
  }

  const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\n        \}\n)/;

  if (!debugConfig.test(contents)) {
    throw new Error('withReleaseSigning: v build.gradle chybí signingConfigs.debug');
  }

  contents = contents.replace(debugConfig, `$1${RELEASE_SIGNING}`);

  const releaseBuild = /(release\s*\{\s*(?:\/\/[^\n]*\n\s*)*)signingConfig signingConfigs\.debug/;

  if (!releaseBuild.test(contents)) {
    throw new Error('withReleaseSigning: v build.gradle chybí release.signingConfig');
  }

  return contents.replace(releaseBuild, '$1signingConfig signingConfigs.release');
}

function useLocalDebugKeystore(contents) {
  if (!contents.includes("storeFile file('debug.keystore')")) {
    return contents;
  }

  return contents.replace("storeFile file('debug.keystore')", `storeFile ${LOCAL_DEBUG_KEYSTORE}`);
}

function addDebugIdentity(contents) {
  if (contents.includes('applicationIdSuffix ".emulator"')) {
    return contents;
  }

  const debugBlock = /(debug\s*\{\s*\n)(\s*signingConfig signingConfigs\.debug\n)/;

  if (!debugBlock.test(contents)) {
    throw new Error('withReleaseSigning: v build.gradle chybí debug block');
  }

  const identity = `            if (System.getenv("APP_TARGET") == "emulator") {
${indent(EMULATOR_IDENTITY, 16)}
            } else {
${indent(PHONE_IDENTITY, 16)}
            }
`;

  return contents.replace(debugBlock, `$1${identity}\n$2`);
}

function addReleaseKeyGuard(contents) {
  if (contents.includes('Release build vyžaduje ANDROID_KEYSTORE_PATH')) {
    return contents;
  }

  return contents.replace(/^android \{/m, RELEASE_KEY_GUARD);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = useLocalDebugKeystore(config.modResults.contents);

    contents = addReleaseSigning(contents);
    contents = addDebugIdentity(contents);
    contents = addReleaseKeyGuard(contents);
    config.modResults.contents = contents;

    return config;
  });
};
