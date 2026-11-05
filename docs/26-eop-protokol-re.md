# 26 — eOP: reverzní inženýrství protokolu (Linux middleware)

Cíl: zjistit, jak mluvit s českou eObčankou (eOP) bez MOI Podpisového SDK, aby šla
čtečka zapojit do appky. Metoda: odposlech oficiálního Linux middleware
(`eobcanka.deb`) přes `LD_PRELOAD` shim nad `SCardTransmit`, plus enumerace BLE GATT
přes BlueZ.

Datum: 2026-11-03, podpisový protokol ověřen 2026-11-05. Prostředí: Linux Mint 22,
BlueZ 5.72, `eobcanka 3.5.2`.

## 1. Co je hotové a ověřené

| Vrstva | Stav | Zdroj |
|---|---|---|
| Čtečka přes USB (CCID) | ✅ funguje | `pcscd` + `libccid`, ATR přečten |
| Identifikace karty | ✅ eOP vydaná po 7/2018 | ATR v pcsc-tools DB |
| Kartový APDU protokol | ✅ odposlechnutý (níže) | shim nad `libsa2v1czep11.so` |
| BLE GATT profil čtečky | ✅ vyenumerovaný (níže) | BlueZ `busctl` nad D-Bus |
| BLE framing (obal APDU) | ✅ uvnitř ACS EVK | AES-128 + XOR checksum, knihovna dává `javax.smartcardio` |
| Podpisový protokol | ✅ ověřeno 2026-11-05 | PIN + QPIN dialog, `C_Sign` na DER podepsaných atributů (§ 7) |

## 2. Kartový APDU protokol

Karta používá **logické kanály** a proprietární třídu `CLA 0x81`. Standardní ISO
`SELECT MF` (`CLA 0x00`) karta odmítá `6D00`/`6E00` — proto generic OpenSC
nefunguje.

**AID je odvozené z ATR**, ne pevná konstanta: IIN z historických bajtů + issuer
data. Pro tuto kartu:

```
ATR: 3B 7E 94 00 00 80 25 D2 03 10 01 00 56 00 00 00 02 02 00
AID: D2 03 10 01 00 01 00 02 02   (9 bajtů)
```

**SELECT appletu** (na logickém kanálu 2, resp. 1, `P2 0x0C` = bez FCI):

```
02 A4 04 0C 09 D2 03 10 01 00 01 00 02 02
01 A4 04 0C 09 D2 03 10 01 00 01 00 02 02
```

**GET DATA** (`CLA 0x81`, `INS 0xCA`, `P1 0x00`/`0x01`, `P2` = tag):

```
81 CA 00 <tag> <Le>
81 CA 01 <tag> <Le>
```

Karta vrací `6C 01`/`6C 02` („wrong length") — je potřeba poslat znovu
s přesným `Le`.

**Tagy:** `0x01`, `0x81`, `0x82`, `0x83`, `0x84`, `0x87`, `0x89`, `0x8B`,
`0x8C`, `0x8D`, `0x8E`.

Ověřené hodnoty: `81 CA 01 01 09` → ASCII `210910093` (číslo dokladu);
`81 CA 01 81 04` → `00 00 E4 98`; `81 CA 01 82 01` → `04`;
`81 CA 01 84 01` → `03`; `81 CA 01 8C 01` → `0A` (a další čítače).

## 3. BLE GATT profil čtečky

Čtečka (ACR3901U-S1) je BLE 4.0 periferie s AES-128. **V systémovém
Bluetooth seznamu se neobjeví** — DIA: „Párování probíhá vždy v aplikaci."
BlueZ ji vidí jen v LE-only scanu (`scan.transport le`), ne v dual režimu.

| Služba | UUID | Charakteristiky |
|---|---|---|
| **APDU transport** | `ae448001-6e87-df33-adb8-51dfd29be725` | `ae448002` **notify** (odpověď), `ae448003` **write-without-response** (příkaz), `ae448004` **notify** |
| Battery | `ae44180f-…` | `ae442a19` read+notify = Battery Level |
| Device Info | `ae44180a-…` | `ae442a29` Manufacturer, `ae442a26` Firmware, `ae442a24` Model, `ae442a25` Serial |

Ověřené čtení přes D-Bus (`busctl`): Manufacturer `ACS`, Model
`acr3901u-s1-016073`, Serial `RR305-016073`, Firmware `V1F23`, Battery 254.

## 4. BLE framing

ACS publikuje framing **uvnitř EVK knihovny** `acssmcio` (AAR), ne jako samostatný
spec. Z `acssmcio-0.6.2-android21` (`com/acs/smartcardio/internal/n.class`) je
odvozené:

- **AES-128** na datech (`internal/o.a`), klíč = 16bajtový master key; výchozí
  `FF × 16`, v demo appce se dá změnit (`MasterKeyDialogFragment`).
- **Frame** = 3bajtová hlavička s příkazem + data + **XOR checksum**;
  celkem `4 + len` bajtů. Checksum = XOR všech bajtů framu kromě posledního
  (`b.a(int,int,byte[])`).
- Zápis na `ae448003`, odpověď na `ae448002` (notify), druhá notify
  `ae448004`.

**Layout framu je definitivně z jadx (`internal/n.java`):**

```java
public static byte[] a(byte cmd, byte[] data, int len) {
    int payloadLen = 1;              // do délky se počítá i cmd bajt
    int totalLen = 4;
    if (data != null && len > 0) {
        payloadLen = len + 1;
        totalLen = 4 + len;
    }
    byte[] out = new byte[totalLen];
    out[0] = cmd;
    out[1] = (byte) (payloadLen & 255);       // délka low
    out[2] = (byte) ((payloadLen >> 8) & 255); // délka high
    if (data != null && len > 0) {
        System.arraycopy(data, 0, out, 3, len);
    }
    out[totalLen - 1] = b.a(0, totalLen - 1, out);  // XOR checksum
    return out;
}
```

Tedy **`[cmd][len_lo][len_hi][data][XOR]`**, kde **`len = 1 + len(data)`**.

| cmd | Význam |
|---|---|
| `0x00` | APDU na kartu |
| `0x14` | control/escape wrapper |
| `0x18` | card status (notifikace) |
| `0x65` | escape příkaz (power) |
| `0x72` | šifrovaný frame (AES) |

**AES:** `o.a(key, data)` nad 16bajtovým klíčem; default `FF × 16`, v demo
appce `MasterKeyDialog` (`a(byte[])` vyžaduje přesně 16 B).

**Round-trip ověřen 2026-11-04** přes BlueZ na počítači: zápis na `AE448003`
(notify na `AE448002` i `AE448004`) vrátil notifikaci

```
9F 02 00 06 9B        9F ^ 02 ^ 00 ^ 06 = 9B  (checksum sedí)
```

Tím je framing potvrzený. Vrácená hodnota `0x9F` je ale *status* (`0x9F & 0x7F`
= 31, ani APDU `0x00`, ani status `0x18`), ne výsledek APDU — karta nebyla
napájená/vybraná, proto se čeká na `0x18` a retry klesá.

**Aplikace framing neimplementuje:** knihovna vystavuje standardní
`javax.smartcardio` (`Card`, `CardChannel`, `CommandAPDU`) a framing i AES řeší
uvnitř. Demo (`BLETest`) volá jen `card.getATR()` a `channel.transmit(new CommandAPDU(...))`.

Pro náš případ to znamená: přidat `acssmcio-0.6.2.aar` + `smartcardio-0.1.7.aar`
do `android/app/libs/`, přes `BluetoothTerminalManager` vyhledat/spojit čtečku a
pak posílat APDU přes `CardChannel` — přesně jak to dělá demo.

**Typy volání (celé API `acssmcio`, standard `javax.smartcardio`):**

```
BluetoothTerminalManager
  TERMINAL_TYPE_ACR3901U_S1 | ACR1255U_J1 | AMR220_C | ACR1255U_J1_V2 | ACR1555U
  IOCTL_ESCAPE = 3500
  BATTERY_STATUS_NOT_SUPPORTED | NONE | LOW | FULL | USB_PLUGGED
  DEVICE_INFO_SYSTEM_ID | MODEL_NUMBER_STRING | SERIAL_NUMBER_STRING
    | FIRMWARE_REVISION_STRING | HARDWARE_REVISION_STRING
    | SOFTWARE_REVISION_STRING | MANUFACTURER_NAME_STRING
  scan(callback) / getTerminals()

CardTerminal
  connect(mode) -> Card        // "direct" = napájení karty
  isCardPresent() -> boolean
  getName() -> String

Card
  getATR() -> ATR
  transmitControlCommand(controlCode, command) -> byte[]
  disconnect(reset)

CardChannel
  transmit(CommandAPDU) -> ResponseAPDU

TransmitOptions
  isT0GetResponse / setT0GetResponse
  isT1GetResponse / setT1GetResponse
  isT1StripLe / setT1StripLe

CardStateMonitor
  CARD_STATE_UNKNOWN | ABSENT | PRESENT
```

**Co zůstává neznámé (a proč to appku neblokuje):**

1. **Odvození AID** — pravidlo `IIN + 0x01 + reverse(poslední 3 bajty ATR)` sedí na
   obě známé české ATR (druhé je z `pcsc-tools`, neověřené kartou), ale je to
   **hypotéza**: pravidlo samotné je v nativní `libclib.so`, ne v Java části AAR.
   Ověřit ho jde jen druhou kartou nebo disassembly nativní knihovny.
   V `eopCard.ts` je na jednom místě a test ho hlídá; když pravidlo nesedí,
   `selectApplet` zkusí oba kanály a vrátí `applet_not_found`, ne pád.
2. **Režim AES** (ECB/CBC) — `internal/o.class`, JNI wrapper nad nativní `.so`.
   Pro použití AAR to není potřeba znát.
3. **Escape payload** — `transmitControlCommand` bere payload od volajícího, v
   knihovně není konstanta. Pro APDU cestu (`CardChannel.transmit`) ho nepotřebujeme.

Pro appku to znamená: psát proti standardnímu `javax.smartcardio` a
`transmitControlCommand` volat jen pro escape příkazy, které stejně neznáme — APDU
cesta (`CardChannel.transmit`) je plně popsaná výše.

## 5. Reprodukce

Odposlech kartového protokolu (čtečka v USB režimu):

```bash
gcc -shared -fPIC -O2 -o /tmp/apdustrace.so /tmp/apdustrace.c -ldl
LD_PRELOAD=/tmp/apdustrace.so pkcs11-tool \
  --module /usr/lib/x86_64-linux-gnu/libsa2v1czep11.so -O
cat /tmp/apdu-trace.log
```

Shim (`apdustrace.c`) obaluje `SCardTransmit` přes `dlopen("libpcsclite.so.1")` —
`RTLD_NEXT` nestačí, modul má libpcsclite jako `RTLD_LOCAL`.

BLE GATT enumerace (čtečka v BT režimu, BlueZ):

```bash
bluetoothctl --timeout 25 scan on          # dual režim ji nenajde
# LE-only:
printf 'menu scan\ntransport le\nback\nscan on\n' | bluetoothctl
busctl tree org.bluez | grep -A20 dev_<MAC>
busctl introspect org.bluez /org/bluez/hci0/dev_<MAC>/service0009/char000a
```

## 5. Co je v eObčanka APK (cz.mvcr.eobcanka 1.8.0)

Aplikace (53 MB, APKPure) obsahuje SDK zkompilované dovnitř:

| Část | Co to je |
|---|---|
| `libclib.so` | kartová knihovna, jediný JNI vstup `com.aheaditec.talsec.security.Natives.d` |
| `libtmlib.so` | transport (T=1), JNI `...security.api.Natives.start/stop` |
| `libsecurity.so` | 15 JNI funkcí `com.aheaditec.talsec.security.Natives.a`–`q` |
| `libcryptog.so` | crypto, `...security.FullNatives.x/y/z` |
| `libspeProvider.so` | `com.aheaditec.eopsdk.plugins.KeyStore.getKEnc/getKMac` |
| `classes*.dex` | Java část je obfuskovaná (žádné `cz/mvcr` balíčky) |

Native libs jsou pro **arm64-v8a, armeabi-v7a, x86 i x86_64** a mají
staticky linkované OpenSSL (`AES_encrypt`, `ASN1_item_sign`, …).

**Vendor je AHEAD iTec = Monet+** (Brno, `monetplus.cz`), produkt **ProID**
(„kvalifikovaný podpis, digitální identita, řízení certifikátů“). To je stejný
vendord jako `com.aheaditec:ccid` z `PLAN.md` 5.2 — ne jen MOI/SZR.

## 6. Důsledek pro projekt

- **Varianta A přes BLE** je hlavní cesta (rozhodnutí 2026-11-04): ACS EVK
  (`acssmcio`) dává `javax.smartcardio`, framing i AES-128 řeší uvnitř, AAR jsou
  veřejně dostupné. Kartový protokol výše sedí na `CardChannel`.
- **Podpisový protokol** je ověřený (§ 7): kvalifikovaný certifikát je na kartě,
  PIN odemkne kartu (`CKU_USER`) a QPIN se zadává v dialogu ovladače při
  každém `C_Sign`. eOP SDK od **Monet+ (ProID)** (`com.aheaditec.eopsdk`)
  tedy není potřeba — stačí standardní PKCS#11 (`libeop2v1czep11.so`) a pyHanko.
- **Nejkratší cesta k podpisu** je hotová: `scripts/eop_card_sign.py` podepíše
  PDF reálným čipem (F4d). Zbývá jen zapojit čtečku do appky (BLE) a ověřit
  kombinaci Bluetooth + podpis.
- **USB OTG** zůstává plně podložené: CCID spec je veřejná a kartový protokol výše
  je odposlechnutý. Chybí jen CCID implementace pro Android.

## 7. Podpisový protokol (ověřeno 2026-11-05)

Na rozdíl od § 1 (karta bez certu) má reálná eObčanka s kvalifikovaným
certifikátem funkční podpis. Ověřeno na Linuxu s `eobcanka 3.5.2`, čtečka ACS
ACR3901U (USB CCID), karta `eOP2v1 CZE 210910093`.

### 7.1 Co karta hlásí

| Objekt | Hodnota |
|---|---|
| Applet Admin (slot 0x1) | PIN 4–10 (`IOK`), `CKU_USER` = IOK |
| Applet uživatele (slot 0x0) | PIN 5–15 (`PIN`), `CKU_USER` = PIN |
| Certifikát | `iSignum 20261104-143213`, issuer **PostSignum Qualified CA 4** |
| QCStatements | **QcCompliance + QcSSCD** → QES (ne AdES) |
| Klíč | RSA 2048, `keyUsage: nonRepudiation`, `CKA_ALWAYS_AUTHENTICATE` |
| Mechanismus | `SHA256-RSA-PKCS` (i `RSA-PKCS`, `SHA256-RSA-PKCS-PSS`) |

### 7.2 Tři kódy, tři pole

Karta má tři schvalovací kódy a PKCS#11 je mapuje na tři různá „pole“.
Jejich záměna je nejčastější chyba (potvrzuje i oficiální příručka)
a každá záměna decrementuje počítadlo — po 3 chybných zadáních kód
zablokuje (PIN/QPIN 3 pokusy; PIN lze resetovat PUKem, QPIN také).

| Kód | PKCS#11 | Applet / slot | Kdy |
|---|---|---|---|
| **IOK** (4–10) | `CKU_USER` | Admin, 0x1 | identifikace |
| **PIN** (5–15) | `CKU_USER` | uživatel, 0x0 | správa certů, jednorázově |
| **QPIN** (5–15) | **dialog ovladače** | uživatel, 0x0 | **při každém** podpisu |

`CKU_CONTEXT_SPECIFIC` modul **nepřijímá** (`CKR_USER_TYPE_INVALID`) a `C_Login`
s QPIN jako `CKU_USER` skončí `CKR_PIN_INCORRECT` (to je ta záměna polí).
QPIN se tedy **nezadává přes `C_Login`**, ale do dialogu
„Verification of signature PIN (QPIN)“, který modul otevře během `C_Sign`.
Dialog ukazuje „Number of attempts : N“; po úspěšném podpisu se počítadlo
nemění, po chybném se decrementuje.

### 7.3 Tok podpisu

```
C_Login(CKU_USER, PIN)                    # jednorázově odemkne kartu
C_SignInit(CKM_SHA256_RSA_PKCS, key)      # privátní klíč je viditelný
C_Sign(der_signed_attrs)                  # ovladač zobrazí dialog QPIN
                                          # → uživatel zadá QPIN
                                          # → raw RSA podpis
```

Podepisují se **DER podepsané atributy CMS**, ne digest PDF (rozhodnutí #5).
pyHanko je dodá v `Signer.async_sign_raw(data, digest_algorithm, dry_run)`:
`data` jsou DER podepsané atributy, `dry_run=True` vrací placeholder 256 B
(bez karty), `dry_run=False` volá `C_Sign` (a tím dialog QPIN). LTV/DSS
zůstává mimo CMS.

### 7.4 Reprodukce

```bash
.venv/bin/python scripts/eop_card_sign.py --probe        # jen čtení, bez PINu
EOP_PIN=... .venv/bin/python scripts/eop_card_sign.py --sign   # PIN + dialog QPIN
```

`--probe` přečte ATR, applety, certifikát, QCStatements a mechanismy bez PINu.
`--sign` otevře kartu (`C_Login(CKU_USER, PIN)`), nechá pyHanko postavit TBS
a během `C_Sign` zadáš QPIN do dialogu. V headless prostředí (dialog je okno
ovladače) se spouští přes `xvfb-run` a QPIN se do dialogu vpíše `xdotool`em.

Ověřeno 2026-11-05: PDF podepsané reálným čipem, `valid=True`,
`intact=True`, `coverage=ENTIRE_FILE`, podepsal `Ing. Marek Palatinus`,
`adbe.pkcs7.detached`, SHA-256. Po podpisu zůstala počítadla PIN i QPIN na 0/3.
