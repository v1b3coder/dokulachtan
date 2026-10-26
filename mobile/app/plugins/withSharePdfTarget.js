// Config plugin (docs/15 § 6, docs/16): dvě cesty pro PDF.
//  - share sheet „Podepsat PDF“ (ACTION_SEND) → přímý podpis (jako dřív),
//  - „Otevřít v Dokulachtanu“ / „Ověřit PDF“ (ACTION_VIEW) → ověření
//    původního souboru, bez re-exportu z PDF editoru.
// Aliasy míří na MainActivity, takže intent převezme expo-share-intent
// (SEND) nebo vlastní OpenPdfModule (VIEW). Plugin je idempotentní.
const { withAndroidManifest } = require('expo/config-plugins');

const SHARE_ALIAS = '.SharePdfAlias';
const SHARE_LABEL = 'Podepsat PDF';
const OPEN_ALIAS = '.OpenPdfAlias';
const OPEN_LABEL = 'Ověřit PDF';

function alias(name, label, action, mimeType) {
  return {
    $: {
      'android:name': name,
      'android:targetActivity': '.MainActivity',
      'android:label': label,
      'android:exported': 'true',
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': action } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': mimeType } }],
      },
    ],
  };
}

function addPdfAliases(androidManifest) {
  const application = androidManifest.manifest.application?.[0];

  if (!application) {
    throw new Error('withSharePdfTarget: v manifestu chybí <application>');
  }

  const mainActivity = application.activity?.find(
    (activity) => activity.$['android:name'] === '.MainActivity',
  );

  if (mainActivity) {
    mainActivity.$['android:launchMode'] = 'singleTask';
  }

  const aliases = (application['activity-alias'] ?? []).filter(
    (item) => item.$['android:name'] !== SHARE_ALIAS && item.$['android:name'] !== OPEN_ALIAS,
  );

  application['activity-alias'] = [
    ...aliases,
    alias(SHARE_ALIAS, SHARE_LABEL, 'android.intent.action.SEND', 'application/pdf'),
    alias(OPEN_ALIAS, OPEN_LABEL, 'android.intent.action.VIEW', 'application/pdf'),
  ];

  return androidManifest;
}

module.exports = function withSharePdfTarget(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = addPdfAliases(config.modResults);

    return config;
  });
};
