# Android release keystore

Release APK se podepisuje **vlastním release keystorem**, který není v gitu.
Lokální buildy bez `ANDROID_KEYSTORE_PATH` dál používají standardní debug
keystore z `expo prebuild`.

## Soubory

| Soubor | Význam | V gitu |
|---|---|---|
| `dokulachtan-release.jks` | privátní klíč release podpisu | **ne** (gitignored) |
| `dokulachtan-release.jks.b64` | stejný soubor v base64 pro CI secret | **ne** (gitignored) |
| `release.properties` | hesla a alias pro lokální/CI použití | **ne** (gitignored) |

**Release certifikát (SHA-256):**

```text
80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0
```

Bez dvojteček: `80dc86ef10a715961acf4959d11f56c944a91476a399558de17c1389595ec3e0`.

## GitHub / Gitea secrets

Do repozitáře nastav tyto secrets (nikdy je necommituj):

| Secret | Hodnota |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | obsah `dokulachtan-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | `ANDROID_KEYSTORE_PASSWORD` z `release.properties` |
| `ANDROID_KEY_ALIAS` | `dokulachtan` |
| `ANDROID_KEY_PASSWORD` | `ANDROID_KEY_PASSWORD` z `release.properties` |
| `ANDROID_RELEASE_CERT_SHA256` | SHA-256 otisk výše |

Příklad pro GitHub CLI (spusť z kořene repa):

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < deploy/android-release/dokulachtan-release.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --body "$(sed -n 's/^ANDROID_KEYSTORE_PASSWORD=//p' deploy/android-release/release.properties)"
gh secret set ANDROID_KEY_ALIAS --body dokulachtan
gh secret set ANDROID_KEY_PASSWORD --body "$(sed -n 's/^ANDROID_KEY_PASSWORD=//p' deploy/android-release/release.properties)"
gh secret set ANDROID_RELEASE_CERT_SHA256 --body "80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0"
```

Pro Gitea použij webové UI → *Settings → Secrets and variables → Actions* se
stejnými názvy.

## Jak to funguje

1. `mobile/app/plugins/withReleaseSigning.js` při `expo prebuild` přidá do
   `android/app/build.gradle` `signingConfigs.release` a v `release` buildu použije
   release config, jen když je `ANDROID_KEYSTORE_PATH` nastavená.
2. Workflow `.github/workflows/android-release.yml` dekóduje
   `ANDROID_KEYSTORE_BASE64` do `$RUNNER_TEMP/release.keystore`, nastaví
   `ANDROID_KEYSTORE_PATH` a předá hesla do Gradle.
3. Po buildu workflow ověří `apksigner verify --print-certs` proti
   `ANDROID_RELEASE_CERT_SHA256`; když otisk nesedí, release se nevytvoří.
4. Lokální `./gradlew assembleRelease` bez těchto proměnných použije debug
   keystore — to je záměr, ne produkční podpis.
5. `mobile/app/plugins/withApkSize.js` při prebuildu nastaví velikost APK: komprimované
   `.so` (`expo.useLegacyPackaging=true`), `shrinkResources` a výchozí ABI `x86_64` pro
   emulátor a testy. Release APK pro telefony je jen `arm64-v8a` (`-PreactNativeArchitectures=arm64-v8a`,
   v CI to dělá workflow); release build bez `arm64-v8a` spadne, aby se nevydal APK,
   který na telefon nejde nainstalovat. Výsledek: ~14 MB místo ~92 MB univerzálního buildu.

## Nasazení a migrace

- Obě privátní instance na Fly (staging i produkce) mají `QES_ANDROID_CERT_SHA256` nastavený na **debug** fingerprint
  `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`,
  protože prostředí používají lokální bleeding-edge debug build.
- Pokud na Fly nasadíš release APK z CI, přepni `QES_ANDROID_CERT_SHA256` na release fingerprint
  `80:DC:...:E0`; jinak App Links nebudou fungovat.
- Stávající instalace s debug podpisem **nepůjde aktualizovat** release APK.
  Je potřeba odinstalovat, nainstalovat novou verzi a znovu importovat `.p12`
  (klíč se v telefonu neuchovává mimo aplikaci).
- Starý debug podpis už nikdy nepoužívej pro distribuci; testovací APK na
  `dokulachtan-download.fly.dev` může zůstat debug, ale nesmí se vydávat za
  produkci.

## Lokální build

```bash
cd mobile/app/android
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
# bez ANDROID_KEYSTORE_PATH → debug keystore
```

Bez `-PreactNativeArchitectures=arm64-v8a` release build spadne — výchozí ABI je
`x86_64` (emulátor a testy). Pro emulátor stačí `./gradlew assembleDebug` nebo
`npx expo run:android`.

Pro ověření release podpisu lokálně:

```bash
set -a
. ../../deploy/android-release/release.properties
set +a
export ANDROID_KEYSTORE_PATH="$PWD/../../deploy/android-release/dokulachtan-release.jks"
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
```

## Bezpečnost

- `release.properties`, `.jks` a `.b64` jsou v `.gitignore`; nikdy je
  necommituj ani nedávej do issue/PR.
- Hesla a keystore jsou jen v CI secrets a v lokálním gitignored souboru.
- Release keystore zálohuj mimo repo (password manager / šifrovaný trezor);
  ztráta klíče znamená, že další verze už nepůjde aktualizovat.
