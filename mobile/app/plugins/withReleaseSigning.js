// Config plugin: release APK podepisuje release keystorem z CI, lokální buildy
// zůstávají na debug keystore. `android/` je generovaný `expo prebuild`,
// takže přímá úprava build.gradle by se při dalším prebuildu ztratila.
//
// CI nastaví ANDROID_KEYSTORE_PATH (dekódovaný secret) a hesla; když proměnná
// chybí, `release` použije debug config — to je jen pro lokální buildy.
//
// Lokální buildy mají vlastní identitu, aby se vešly vedle produkce:
// - `debug` = `.debug` / „Dokulachtan (debug)“,
// - `release` bez ANDROID_KEYSTORE_PATH (testovací APK) = `.test` /
//   „Dokulachtan (test)“,
// - `release` s ANDROID_KEYSTORE_PATH (produkce) = bez suffixu.
// Share/open aliasy mají stejný suffix v `share_pdf_label` a `open_pdf_label`.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING = `        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "debug.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "android"
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "androiddebugkey"
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: "android"
        }
`;

const DEBUG_IDENTITY = [
  'applicationIdSuffix ".debug"',
  'versionNameSuffix "-debug"',
  'resValue "string", "app_name", "Dokulachtan (debug)"',
  'resValue "string", "share_pdf_label", "Podepsat PDF (debug)"',
  'resValue "string", "open_pdf_label", "Ověřit PDF (debug)"',
];

const TEST_IDENTITY = [
  'applicationIdSuffix ".test"',
  'versionNameSuffix "-test"',
  'resValue "string", "app_name", "Dokulachtan (test)"',
  'resValue "string", "share_pdf_label", "Podepsat PDF (test)"',
  'resValue "string", "open_pdf_label", "Ověřit PDF (test)"',
];

function indent(lines, spaces) {
  return lines.map((line) => `${' '.repeat(spaces)}${line}`).join('\n');
}

function addReleaseSigning(contents) {
  if (contents.includes('ANDROID_KEYSTORE_PATH')) {
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

  return contents.replace(
    releaseBuild,
    '$1signingConfig System.getenv("ANDROID_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug',
  );
}

function addDebugIdentity(contents) {
  if (contents.includes('applicationIdSuffix ".debug"')) {
    return contents;
  }

  const debugBlock = /(debug\s*\{\s*\n)(\s*signingConfig signingConfigs\.debug\n)/;

  if (!debugBlock.test(contents)) {
    throw new Error('withReleaseSigning: v build.gradle chybí debug block');
  }

  return contents.replace(debugBlock, `$1${indent(DEBUG_IDENTITY, 12)}\n$2`);
}

function addTestIdentity(contents) {
  if (contents.includes('applicationIdSuffix ".test"')) {
    return contents;
  }

  const releaseSigning = /(\n)(\s*)(signingConfig System\.getenv\("ANDROID_KEYSTORE_PATH"\) \? signingConfigs\.release : signingConfigs\.debug)/;

  if (!releaseSigning.test(contents)) {
    throw new Error('withReleaseSigning: v build.gradle chybí buildTypes.release signingConfig');
  }

  return contents.replace(
    releaseSigning,
    `$1            if (!System.getenv("ANDROID_KEYSTORE_PATH")) {\n${indent(TEST_IDENTITY, 16)}\n            }$1$2$3`,
  );
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = addReleaseSigning(config.modResults.contents);

    contents = addDebugIdentity(contents);
    contents = addTestIdentity(contents);
    config.modResults.contents = contents;

    return config;
  });
};
