// Config plugin: release APK podepisuje release keystorem z CI, lokální buildy
// zůstávají na debug keystore. `android/` je generovaný `expo prebuild`,
// takže přímá úprava build.gradle by se při dalším prebuildu ztratila.
//
// CI nastaví ANDROID_KEYSTORE_PATH (dekódovaný secret) a hesla; když proměnná
// chybí, `release` použije debug config — to je jen pro lokální buildy.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING = `        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "debug.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "android"
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "androiddebugkey"
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: "android"
        }
`;

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

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = addReleaseSigning(config.modResults.contents);

    return config;
  });
};
