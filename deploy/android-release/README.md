# Android release keystore

Release APK se podepisuje **vlastním release keystorem**, který není v gitu.
Lokální buildy bez `ANDROID_KEYSTORE_PATH` dál používají standardní debug
keystore z `expo prebuild`.

## Kde klíč žije

Lokální kopie v repu **nejsou** — po nahrání do CI secrets byly smazány.
Zůstává jen tento README s otiskem certifikátu.

| Kde | Co | Poznámka |
|---|---|---|
| password manager (záloha uživatele) | `dokulachtan-release.jks`, obě hesla, alias `dokulachtan` | jediná trvalá kopie klíče |
| CI secrets (GitHub i Gitea) | stejné hodnoty + `ANDROID_RELEASE_CERT_SHA256` | write-only, klíč z nich stáhnout nelze |
| repo | jen tento README a `.gitignore` | klíč nikdy nebyl v gitu |

**Release certifikát (SHA-256):**

```text
80:DC:86:EF:10:A7:15:96:1A:CF:49:59:D1:1F:56:C9:44:A9:14:76:A3:99:55:8D:E1:7C:13:89:59:5E:C3:E0
```

Bez dvojteček: `80dc86ef10a715961acf4959d11f56c944a91476a399558de17c1389595ec3e0`.

## GitHub / Gitea secrets

Do repozitáře nastav tyto secrets (nikdy je necommituj):

| Secret | Hodnota (z password manageru) |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 dokulachtan-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | heslo keystore |
| `ANDROID_KEY_ALIAS` | `dokulachtan` |
| `ANDROID_KEY_PASSWORD` | heslo klíče |
| `ANDROID_RELEASE_CERT_SHA256` | SHA-256 otisk výše |

Příklad pro GitHub CLI (spusť z kořene repa s obnoveným `.jks`; bez hodnoty se
`gh` zeptá interaktivně):

```bash
base64 -w0 dokulachtan-release.jks | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body dokulachtan
gh secret set ANDROID_KEY_PASSWORD
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

- Android App Links (`assetlinks.json`) **zrušeny** (#18.1): odkaz jde přes custom scheme
  `dokulachtan://sign` a systémový chooser, takže na Fly už není co nastavovat.
- iOS Universal Links (`apple-app-site-association`) zůstávají; `QES_IOS_TEAM_ID` se nastavuje v DocuSealu.
- Stávající instalace s debug podpisem **nepůjde aktualizovat** release APK.
  Je potřeba odinstalovat, nainstalovat novou verzi a znovu importovat `.p12`
  (klíč se v telefonu neuchovává mimo aplikaci).
- Starý debug podpis už nikdy nepoužívej pro distribuci; testovací APK se
  podepisuje debug keystoorem **tohoto počítače** a předává se přímo, ne přes
  veřejnou download stránku (zrušena 2026-10-30). Podpis je vázaný na stroj, takže
  po přestavbě jinde je potřeba testovací appku odinstalovat.

## Lokální build

```bash
cd mobile/app/android
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
# bez ANDROID_KEYSTORE_PATH → debug keystore
```

Bez `-PreactNativeArchitectures=arm64-v8a` release build spadne — výchozí ABI je
`x86_64` (emulátor a testy). Pro emulátor stačí `./gradlew assembleDebug` nebo
`npx expo run:android`.

Podepsaný lokální build potřebuje klíč ze zálohy — obnov ho z password
manageru, ověř otisk a nastav proměnné:

```bash
cd mobile/app/android
keytool -list -keystore /cesta/k/dokulachtan-release.jks -alias dokulachtan  # SHA256 musí sedět výše
export ANDROID_KEYSTORE_PATH=/cesta/k/dokulachtan-release.jks
export ANDROID_KEY_ALIAS=dokulachtan
export ANDROID_KEYSTORE_PASSWORD='…'
export ANDROID_KEY_PASSWORD='…'
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
```

Obnovený `.jks` z pracovního adresáře po buildu zase smaž.

## Bezpečnost

- Klíč a hesla jsou jen v password manageru a v CI secrets; nikdy je
  necommituj ani nedávej do issue/PR.
- `.jks`, `.b64` a `release.properties` zůstávají v `.gitignore` pro případ,
  že si při obnově ze zálohy položíš klíč do `deploy/android-release/`.
- Ztráta klíče znamená, že další verze už nepůjde aktualizovat; obnovu ze
  zálohy si předem vyzkoušej (`keytool -list` + otisk výše).
