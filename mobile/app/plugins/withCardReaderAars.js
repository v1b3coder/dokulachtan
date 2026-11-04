// Config plugin: lokální AAR čtečky patří do APK, ne do AAR knihovny.
//
// `android/` je generovaný `expo prebuild`, takže přímé úpravy `app/build.gradle`
// by se při dalším prebuildu ztratily — proto plugin.
//
// AGP 8 neumí zabalit lokální `.aar` do AAR knihovny (`bundleReleaseAar`
// spadne: „Direct local .aar file dependencies are not supported when building
// an AAR“). `modules/dokulachtan-card-reader` proto proti AAR jen kompiluje
// (`compileOnly`) a appka je zabalí do APK, kde jsou potřeba za běhu.
const { withAppBuildGradle } = require('expo/config-plugins');

const MODULE = ':dokulachtan-card-reader';
const AARS = ['smartcardio-0.1.7.aar', 'acssmcio-0.6.2.aar'];

function addCardReaderAars(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('Lokální AAR čtečky')) {
      const libs = AARS.map(
        (aar) => `    implementation files("\${rootProject.project('${MODULE}').projectDir}/libs/${aar}")`,
      ).join('\n');

      config.modResults.contents = config.modResults.contents.replace(
        /^dependencies \{/m,
        `dependencies {\n    // Lokální AAR čtečky (AGP 8 je neumí zabalit do AAR knihovny).\n${libs}`,
      );
    }

    return config;
  });
}

module.exports = (config) => addCardReaderAars(config);
