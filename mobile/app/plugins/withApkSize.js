// Config plugin: velikost APK a volba ABI.
//
// `android/` je generovaný `expo prebuild`, takže přímé úpravy `gradle.properties`
// nebo `app/build.gradle` by se při dalším prebuildu ztratily — proto plugin.
//
// Tři explicitní targety (agent volí target, ne ABI):
// - `make debug-phone` = debug build, arm64-v8a, `.debug` (telefon),
// - `make emulator`    = debug build, x86_64, `.emulator` (emulátor),
// - `make release`     = release build, arm64-v8a, jen CI.
//
// - Výchozí ABI je arm64-v8a (debug-phone); emulátor si vynutí x86_64.
// - Release build bez arm64-v8a spadne, aby se nevydal APK, který na telefon nejde nainstalovat.
// - Komprimované `.so` (deflate) + shrinkResources: 91,7 MB → 14,1 MB.
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const PROPERTIES = {
  reactNativeArchitectures: 'arm64-v8a',
  'expo.useLegacyPackaging': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

const BUILD_GUARD = `// Tři explicitní targety: debug-phone (arm64), emulator (x86_64), release (CI, arm64).
if (gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") && it.toLowerCase().contains("assemble") } &&
    (findProperty("reactNativeArchitectures") ?: "").toString() != "arm64-v8a") {
  throw new GradleException("Release build potřebuje -PreactNativeArchitectures=arm64-v8a.")
}

def qesTarget = System.getenv("APP_TARGET") ?: "phone"
def qesAbis = (findProperty("reactNativeArchitectures") ?: "").toString()
def qesDebugTask = gradle.startParameter.taskNames.any { it.toLowerCase().contains("assemble") && it.toLowerCase().contains("debug") }
if (qesDebugTask && qesTarget == "emulator" && qesAbis != "x86_64") {
  throw new GradleException("Emulator build potřebuje -PreactNativeArchitectures=x86_64 (make emulator).")
}
if (qesDebugTask && qesTarget != "emulator" && qesAbis != "arm64-v8a") {
  throw new GradleException("Debug na telefon potřebuje -PreactNativeArchitectures=arm64-v8a (make debug-phone).")
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

function addBuildGuard(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('Tři explicitní targety')) {
      config.modResults.contents = config.modResults.contents.replace(/^android \{/m, BUILD_GUARD);
    }

    return config;
  });
}

module.exports = function withApkSize(config) {
  return addBuildGuard(setGradleProperties(config));
};
