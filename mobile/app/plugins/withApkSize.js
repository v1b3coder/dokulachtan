// Config plugin: velikost release APK a volba ABI.
//
// `android/` je generovaný `expo prebuild`, takže přímé úpravy `gradle.properties`
// nebo `app/build.gradle` by se při dalším prebuildu ztratily — proto plugin.
//
// - Lokální buildy (emulátor, testy) = jen x86_64, release pro telefony = arm64-v8a.
//   CI ho předává přes `-PreactNativeArchitectures=arm64-v8a`; release build bez
//   arm64 spadne, aby se nevydal APK, který na telefon nejde nainstalovat.
// - Komprimované `.so` (deflate) + shrinkResources: 91,7 MB → 14,1 MB.
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const PROPERTIES = {
  reactNativeArchitectures: 'x86_64',
  'expo.useLegacyPackaging': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

const RELEASE_GUARD = `// Release APK jde na telefony (arm64-v8a); x86_64 je jen pro emulátor a testy.
if (gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") && it.toLowerCase().contains("assemble") } &&
    !(findProperty("reactNativeArchitectures") ?: "").toString().contains("arm64-v8a")) {
  throw new GradleException("Release build potřebuje -PreactNativeArchitectures=arm64-v8a (x86_64 je jen pro emulátor).")
}

android {`;

function setGradleProperties(config) {
  return withGradleProperties(config, (config) => {
    for (const [key, value] of Object.entries(PROPERTIES)) {
      const existing = config.modResults.find((item) => item.type === 'property' && item.key === key);

      if (existing) {
        existing.value = value;
      } else {
        config.modResults.push({ type: 'property', key, value });
      }
    }

    return config;
  });
}

function addReleaseGuard(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('Release build potřebuje')) {
      config.modResults.contents = config.modResults.contents.replace(/^android \{/m, RELEASE_GUARD);
    }

    return config;
  });
}

module.exports = function withApkSize(config) {
  return addReleaseGuard(setGradleProperties(config));
};
