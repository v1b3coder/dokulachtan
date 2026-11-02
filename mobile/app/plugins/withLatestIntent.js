// Config plugin: `onNewIntent` musí předat intent do `getIntent()`.
//
// `singleTask` při teplém odkazu zavolá `onNewIntent`, ale `Activity.intent`
// zůstane původní. Expo Router na Androidu čte `Linking.getInitialURL()`
// z `Activity.intent`, takže by při startu otevřel starý odkaz. `setIntent`
// ho před `super.onNewIntent` aktualizuje na poslední dorazivší URL.
//
// `android/` je generovaný `expo prebuild`, takže přímá úprava MainActivity.kt
// by se při dalším prebuildu ztratila — proto plugin.
const { withMainActivity } = require('expo/config-plugins');

const INTENT_IMPORT = 'import android.content.Intent\n';
const ON_NEW_INTENT = `
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`;

module.exports = function withLatestIntent(config) {
  return withMainActivity(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('override fun onNewIntent(intent: Intent)')) {
      if (!contents.includes(INTENT_IMPORT)) {
        contents = contents.replace('import android.os.Build', `${INTENT_IMPORT}import android.os.Build`);
      }

      const anchor = '  override fun getMainComponentName(): String = "main"';

      if (!contents.includes(anchor)) {
        throw new Error('withLatestIntent: v MainActivity.kt chybí getMainComponentName');
      }

      contents = contents.replace(anchor, `${anchor}\n${ON_NEW_INTENT}`);
    }

    config.modResults.contents = contents;

    return config;
  });
};
