// Config plugin: `debug` build se chová jako release — JS bundle je vložený v APK
// a appka se nepřipojuje k Metru, takže nemá DevTools, LogBox ani CDP inspector.
// Inspector je cesta, jak z běžící appky přečíst klíč při podpisu (vault klíč
// v SecureStore je za biometrií, ale `privateKeyPem` jde při podpisu do JS).
//
// `android/` je generovaný `expo prebuild`, takže přímé úpravy `build.gradle`
// nebo `MainApplication.kt` by se při dalším prebuildu ztratily — proto plugin.
//
// - `debuggableVariants = []` — RN plugin jinak bundle pro `debug` přeskočí
//   a appka čeká na Metro; s prázdným seznamem ho vloží (dev = false).
// - `debuggable false` — žádné `run-as` ani JDWP připojení k procesu.
// - `useDevSupport = false` — Expo by jinak dev support zapnulo podle
//   `ReactBuildConfig.DEBUG`: knihovna `react-android` má debug variantu
//   debuggable i tehdy, když appka sama debuggable není.
const { withAppBuildGradle, withMainApplication } = require('expo/config-plugins');

const BUNDLE_COMMAND = '    bundleCommand = "export:embed"\n';
const DEBUGGABLE_VARIANTS = '    debuggableVariants = []\n';
const DEBUG_BUILD_TYPE = /(buildTypes\s*\{\s*\n\s*debug\s*\{)([\s\S]*?)(\n\s*\})/;
const NOT_DEBUGGABLE = '            debuggable false';
const REACT_HOST = '      context = applicationContext,\n';
const NO_DEV_SUPPORT = '      useDevSupport = false,\n';

function addEmbeddedBundle(contents) {
  if (contents.includes('debuggableVariants = []')) {
    return contents;
  }

  if (!contents.includes(BUNDLE_COMMAND)) {
    throw new Error('withReleaseLikeDebug: v build.gradle chybí bundleCommand');
  }

  return contents.replace(BUNDLE_COMMAND, `${BUNDLE_COMMAND}\n${DEBUGGABLE_VARIANTS}`);
}

function addNotDebuggable(contents) {
  if (contents.includes('debuggable false')) {
    return contents;
  }

  if (!DEBUG_BUILD_TYPE.test(contents)) {
    throw new Error('withReleaseLikeDebug: v build.gradle chybí buildTypes.debug');
  }

  return contents.replace(DEBUG_BUILD_TYPE, `$1$2\n${NOT_DEBUGGABLE}$3`);
}

function addNoDevSupport(contents) {
  if (contents.includes('useDevSupport = false')) {
    return contents;
  }

  if (!contents.includes(REACT_HOST)) {
    throw new Error('withReleaseLikeDebug: v MainApplication.kt chybí getDefaultReactHost');
  }

  return contents.replace(REACT_HOST, `${REACT_HOST}${NO_DEV_SUPPORT}`);
}

module.exports = function withReleaseLikeDebug(config) {
  config = withAppBuildGradle(config, (config) => {
    config.modResults.contents = addNotDebuggable(addEmbeddedBundle(config.modResults.contents));

    return config;
  });

  return withMainApplication(config, (config) => {
    config.modResults.contents = addNoDevSupport(config.modResults.contents);

    return config;
  });
};
