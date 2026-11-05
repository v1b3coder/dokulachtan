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
| Kartový APDU protokol | ✅ odposlechnutý (níže, § 2) | shim nad `libeop2v1czep11.so` |
| Podpisový tok přes SM | ✅ odposlechnutý (níže, § 8) | shim nad `libeop2v1czep11.so` |
| BLE GATT profil čtečky | ✅ vyenumerovaný (níže) | BlueZ `busctl` nad D-Bus |
| BLE framing (obal APDU) | ✅ uvnitř ACS EVK | AES-128 + XOR checksum, knihovna dává `javax.smartcardio` |
| Podpisový protokol | ✅ ověřeno 2026-11-05 | PIN + QPIN dialog, `C_Sign` na DER podepsaných atributů (§ 7) |

## 2. Kartový APDU protokol

Ověřeno 2026-11-05 na kartě `eOP2v1 CZE 210910093` (ATR
`3B 7E 94 00 00 80 25 D2 03 10 01 00 56 00 00 00 02 02 00`).

### 2.1 Aktivní cesta: standardní ISO 7816-4, AID `A0000000288010370202`

Modul `libeop2v1czep11.so` (ten používá `scripts/eop_card_sign.py`) mluví
**standardní ISO 7816-4** s `CLA 0x00`. Žádná proprietární třída, žádné logické
kanály. Karta se hlásí jako **IAS Classic v4** (`GET DATA 7F30`).

```
SELECT AID     00 A4 04 0C 0A A0 00 00 00 28 80 10 37 02 02   -> 9000
GET DATA 9F7F  00 CA 9F 7F            -> 6C 2D
               00 CA 9F 7F 2D         -> 9F 7F 2A <card capabilities>
SELECT DF      00 A4 00 00 02 <fid>    -> 61 xx
GET RESPONSE   00 C0 00 00 <len>
SELECT EF      00 A4 02 00 02 <fid>    -> 61 xx
GET RESPONSE   00 C0 00 00 <len>
READ BINARY    00 B0 <off hi> <off lo> <len>   (0xDC = 220 B chunků)
```

Čtení je **plaintext** (žádné secure messaging), takže `READ BINARY` jde
přímo. Struktura (ověřeno čtením certifikátu, bajtově shodné s middlewarem):

| DF | název | EF | obsah |
|---|---|---|---|
| `0x0202` | `mscp` | `0x0004` | jméno kontejneru (UTF-16) |
| `0x0202` | `mscp` | `0x000B` | certifikát, **zlib** (`78 9C`) → 2068 B DER |
| `0x0203` | `mp_p11` | `0x000A` | certifikát |

`GET DATA 7F30` → `IAS Classic v4` (card OS). EF `0x0005` nese seznam PIN
referencí (`0x81`–`0x87`, `0x55`–`0x5C`), EF `0x0007` file layout
(`mscp`, `mp_p11`, `cardid`, `cardcf`, `cardapps`, `cmapfile`, `NFO`, `rdcf`,
`cont`, `ksc`).

### 2.2 Starší cesta: `libsa2v1czep11.so`, `CLA 0x81`

`libsa2v1czep11.so` (karta „SA 2v1") používá **logické kanály** a
proprietární třídu `CLA 0x81`; AID je odvozené z ATR
(`D2 03 10 01 00 01 00 02 02`). Naše karta tuhle cestu nepoužívá —
proto se `SELECT MF` s `CLA 0x00` **nerozbije** (vrací `9000`, viz § 2.1).

**Bezpečný dotaz na pokusy** (žádné snižování počítadla): `VERIFY` **bez
dat** (`00 20 00 <P2>`) vrátí `63 Cx`, kde `x` = zbývající pokusy.
Ověřeno: `P2 0x81` (MRZ) = 2, `0x82` (CAN) = 5, `0x83` (PIN) = 3,
`0x84`–`0x87` = `6A 88` (neexistuje). `scripts/eop_apdu.py --attempts`
tenhle dotaz dělá a nikdy neposílá `VERIFY` s daty.

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
a během `C_Sign` zadáš QPIN do dialogu. Dialog je **samostatný forkovaný proces**
`eop2v1czep11 --caller=<pid>` (nativní Qt okno s jedním polem `QPIN`
a textem `Number of attempts : N`), ne okno `eopcardman`. Na reálné X session se do
něj `xdotool` nedostane (ověřeno 2026-11-05); **zrušení dialogu počítadlo
nesnižuje** — po timeoutu zůstalo PIN 3/3.

Ověřeno 2026-11-05: PDF podepsané reálným čipem, `valid=True`,
`intact=True`, `coverage=ENTIRE_FILE`, podepsal `Ing. Marek Palatinus`,
`adbe.pkcs7.detached`, SHA-256. Po podpisu zůstala počítadla PIN i QPIN na 0/3.

## 8. Podpisový tok přes secure messaging (odposlechnuto 2026-11-05)

Čtení certifikátu je plaintext (§ 2.1), ale **podpis přepne kartu do secure
messaging** (ISO 7816-4 SM). To je jediná část, která v čtecí cestě není.

### 8.1 Nastavení SM

```
MSE:Set AT      00 22 C1 A4 09 80 01 8C 83 01 01 95 01 80      -> 9000
GET CHALLENGE    00 84 00 00 08                                   -> <8 B>
EXTERNAL AUTH    00 82 00 00 50 <80 B>                             -> 61 50
GET RESPONSE     00 C0 00 00 50                                      -> <80 B>
```

`MSE:Set AT` (`P1 0xC1`, `P2 0xA4`) samo o sobě nechá kartu čekat na
`GENERAL AUTHENTICATE`; bez něj další plaintext APDU skončí `6B 00` a je
potřeba cold reset. `MSE:Set DST` (`00 22 41 A4`) je bezpečný.

### 8.2 Formát SM zpráv

Po nastavení SM jdou příkazy i odpovědi obalené:

```
command   0C <INS> <P1> <P2> <Lc> [87 <len> <encrypted>] 8E 10 <16 B MAC>
response  99 02 <SW> [87 <len> <encrypted>] 8E 10 <16 B MAC>
```

`CLA 0x0C` = SM bit; `8E` = MAC (počítá se i přes `87` data); `87` = padding
pro šifrovaná data; `99` = status word uvnitř SM. Tohle je přesně to, co
implementuje jmrtd (`SecureMessagingWrapper`) nad `javax.smartcardio` z ACS EVK.

### 8.3 Podpis

```
VERIFY QPIN   0C 20 00 83 <Lc> [87 <len> <encrypted QPIN>] 8E 10 <MAC>
PSO:CDS       0C 2A 9E 9A <Lc> [87 <len> <encrypted digest>] 8E 10 <MAC>
```

`PSO:Compute Digital Signature` je `00 2A 9E 9A` — karta ho zná (bez PINu vrátí
`69 85`, „conditions of use not satisfied“), takže struktura příkazu je ověřená
bez rizika pokusů.

### 8.4 Co zůstává

Odvození SM klíče (ECDH + KDF) z `EXTERNAL AUTHENTICATE` je poslední
card-specific část; `MSE:Set AT` data i formát zpráv jsou výše. Do té doby je
jediná funkční cesta na desktopu middleware (`scripts/eop_card_sign.py --sign`)
a na Androidu jmrtd + ACS EVK.

## 9. Mapa applet API (z middlewaru, 2026-11-05)

`libeop2v1czep11.so` je self-contained (jen `libpcsclite`, `libstdc++`, `libc`),
stripped, ale nese vlastní trace stringy `c_ias_applet::<metoda>(...)`. Z nich je
čitelná celá applet API — to je kostra, kterou je potřeba implementovat:

| Skupina | Metody |
|---|---|
| PIN | `pin_verify`, `pin_verify_status`, `pin_change`, `pin_unblock`, `pin_unverify` |
| **PIN session** | `pin_session_verify_init`, `_do`, `_final` |
| MSE | `mse_set`, `mse_set_external_auth`, `mse_set_mutual_auth`, `mse_restore` |
| Autentizace | `general_authenticate`, `mutual_authenticate`, `mutual_authenticate_status` |
| ECDH | `ecdh_external_authenticate`, `ecdh_internal_authenticate` |
| 3DES (legacy) | `ms_3des3_authenticate`, `_key`, `_status`, `_reset` |
| SM | `get_sm_provider`, `set_sm_provider` |
| Klíče | `generate_key_pair`, `gen_random` |
| Podpis | `pso_sign`, `pso_hash`, `_set`, `_finalize`, `pso_verify_certificate`, `pso_decipher_rsa`, `pso_decipher_ecc` |
| Soubory | `select_file`, `select_file_df`, `select_file_name`, `select_file_path`, `read_binary`, `create_file`, `delete_file`, `activate_file`, `deactivate_file`, `get_data`, `put_data`, `resize`, `erase_binary` |

**SM je AES, ne 3DES.** Provider `c_ias_aes_provider` (vedle `c_ias_sm_provider`),
stringy `AES 16-byte challenge parameter`, `AES challenge`; 16bajtové MAC
v trace (`8E 10 …`) tomu odpovídá. `ms_3des3_*` je legacy cesta
(`3DES3 Microsoft authentication key`) pro starší karty.

**QPIN není plain `VERIFY`.** Middleware má `pin_verify` (plain, P2 `0x83`)
a vedle `pin_session_verify_init/do/final` — QPIN jde **tříapduovým sezením**.
To je důvod, proč v trace před otevřením dialogu nejsou žádná data
(`0C 20 00 83 12 8E 10 …` je jen dotaz na počet pokusů) a proč se QPIN
nedá poslat jako `C_Login`.

### 9.1 Co blokovalo dokončení podpisu (vyřešeno)

1. **QPIN dialog jde ovládat — ale jen pod Xvfb.** Dialog je forkovaný
   `eop2v1czep11 --caller=<pid>` (Qt/X11, `WM_CLASS=Eop2v1czep11`).
   Na reálné session (`:0`) do něj `xdotool` přes XTEST ani XSendEvent
   nedostane — window manager (Muffin) brání focus-stealing a pole zůstane
   prázdné. Pod **`xvfb-run`** (bez WM) dialog dostane fokus sám a `xdotool type`
   funguje. **Ověřeno 2026-11-05: podpis prošel** (`valid=True`,
   `intact=True`, `coverage=ENTIRE_FILE`), PIN i QPIN zůstaly 3/3.
   Recept: `xvfb-run -a --server-args="-screen 0 1400x1000x24"` + skript,
   který počká na okno `Verification of signature PIN`, udělá
   `windowactivate --sync` + `windowfocus --sync`, vpíše QPIN, ověří počet
   teček a odešle `Return`.
2. **SM klíč** z `EXTERNAL AUTHENTICATE` (80 B = 64 B ECDH veřejný klíč +
   16 B AES-MAC) není odvozený. Chybí KDF — to je poslední kus pro
   clean-room implementaci.

### 9.2 Jak to dokončit

- **Nejrychlejší:** dokončit jeden podpis ručně (člověk u klávesnice) a odposlechnout
  celý trace včetně `pin_session_verify_*` a `PSO:CDS`. Z něj je vidět přesný tvar
  QPIN sezení a pořadí příkazů.
- **Self-contained:** doanalyzovat KDF z `ecdh_external_authenticate` v Ghidře
  (analýza proběhla, `-import` + `-process` funguje; skriptování v
  `analyzeHeadless` v tomto prostředí padá na `JavaScriptProvider`, chce to
  PyGhidra nebo GUI).
- **Ověřeno bez rizika:** `PSO:CDS` (`00 2A 9E 9A`) karta zná (`6985`),
  `MSE:Set DST` (`00 22 41 A4`) i `MSE:Set AT` (`00 22 C1 A4`) vrací `9000`.
  `MSE:Set AT` ale nechá kartu čekat na `GENERAL AUTHENTICATE`; bez něj
  plaintext příkaz skončí `6B00` a pomůže jen cold reset.

## 10. Kompletní podpisový tok (ověřeno 2026-11-05, reálný podpis)

Referenční trace celého úspěšného podpisu: `docs/26-eop-trace-sign.log`
(374 APDU, 44 KB, **bez cleartext PINu** — QPIN je v `87` šifrovaný).

### 10.1 Sestavení SM

```
MSE:Set AT      00 22 C1 A4 09 80 01 8C 83 01 01 95 01 80   -> 9000
GET CHALLENGE    00 84 00 00 08                                 -> <8 B>
EXTERNAL AUTH    00 82 00 00 50 <80 B>                            -> 6150
GET RESPONSE     00 C0 00 00 50                                       -> <80 B>
```

`EXTERNAL AUTHENTICATE` (plaintext, 80 B) nese ECDH veřejný klíč (64 B)
a AES-MAC (16 B); odpověď karty je její ECDH veřejný klíč + MAC.
Z toho obě strany odvodí sdílené tajemství a SM klíč.

### 10.2 Podpis (celé v SM)

```
VERIFY QPIN    0C 20 00 83 <Lc> 87 11 01 <16 B> 8E 10 <MAC>   -> 6116
MSE:Set DST    0C 22 41 B6 <Lc> 87 11 01 <16 B> 8E 10 <MAC>   -> 6116
PSO:Hash       0C 2A 90 A0 <Lc> 87 31 01 <48 B> 8E 10 <MAC>   -> 6149
PSO:CDS        0C 2A 9E 9A 12 8E 10 <MAC>                        -> 6100
GET RESPONSE   00 C0 00 00 FF                                          -> 256 B = podpis
```

`87 <len> 01 <data>` = padding indicator `01` + šifrovaná data (QPIN 6 číslic
→ 16 B blok; hash → 48 B). `99 02 <SW>` je status word uvnitř SM.

### 10.3 Co z toho plyne pro implementaci

- QPIN **není** `VERIFY` s daty v plaintextu: je to `0C 20 00 83` se
  šifrovaným QPINem v `87` a MACem v `8E`.
- `MSE:Set DST` pro podpis má **P1 `0x41`, P2 `0xB6`** (ne `0xA4`);
  `PSO:Hash` je `0x90 0xA0`, `PSO:CDS` je `0x9E 0x9A`.
- `00 A6 00 00 12 <8 B> <AID>` je MSE se **session hodnotou** —
  v rámci jednoho sezení je konstantní (v trace 58× stejná), mezi
  sezeními jiná. Není to PIN ani klíč v cleartextu.
- **Riziko PINů:** špatný MAC se odmítne **před** kontrolou PINu, takže
  chybný SM klíč nespotřebuje pokus. Ověřeno: po celém podpisu PIN 3/3.

### 10.4 Zbývá pro clean-room

Odvodit KDF ze `EXTERNAL AUTHENTICATE` (ECDH → AES klíč + MAC klíč).
Až to bude, je možné celý tok výše implementovat v appce přes jmrtd
(`SecureMessagingWrapper`) a `javax.smartcardio` z ACS EVK, bez middleware.

## 11. Revers middlewaru: stavěče APDU (2026-11-05)

`libeop2v1czep11.so` je stripped, ale jeho trace stringy (`c_ias_applet::<metoda>(
...)`) referencují kód. Přes PyGhidra (Java skripty v `analyzeHeadless` padají,
Python přes PyGhidra funguje) se dají dohledat a dekompilovat stavače:

| Metoda | APDU | Poznámka |
|---|---|---|
| `pso_sign` | `00 2A 9E 9A <Lc> <data>` | `FUN_002218a4` |
| `pin_verify` | `00 20 00 <P2> <Lc> <data>` | SM varianta `0C 20 00 <P2>` |
| `pin_session_verify_init` | `00 20 FB <P2> 08 <8 B>` | `FUN_00217a3e` |
| `ecdh_external_authenticate` | `00 82 00 00 <Lc> [8 B][payload]` | `FUN_00215cb2` |
| `ms_3des3_authenticate` | `00 82 00 31 08 <8 B>` | `FUN_0021251c`, legacy 3DES |
| `general_authenticate` | `00 86 00 00 <Lc> <TLV>` | `FUN_002154de`, ECDH/BSI |
| `mse_set` | `00 22 <P1> <P2> <Lc> <data>` | `mse_set_external_auth` staví tag `0x81` s veřejným klíčem |

SM provider je AES (`c_ias_aes_provider`, 16B MAC) vedle `c_ias_sm_provider`;
3DES (`ms_3des3_*`, `3DES3 Microsoft authentication key`) je legacy větev pro
starší karty. KDF třída (`FUN_00243a50`..`FUN_00243e54`) je ve skutečnosti
**cipher context** (key schedule): `malloc(0x80)` + DES pro 8B klíč,
`malloc(0x180)` + AES pro 16B, `malloc(0x180)` + 3DES pro 24B — žádný KDF
tam není.

### 11.1 Co je ověřené a co chybí

- **Ověřené bez rizika:** `00 A6 00 00 12 <8 B> <AID>` s **čerstvou** hodnotou
  → `9000`; se **zastaralou** hodnotou ze starší session karta **resetuje**
  (`SCARD_E_NOT_TRANSACTED`) — hodnota je tedy session klíč, který karta validuje.
  `GET CHALLENGE` (`00 84 00 00 08`) → 8 B, `MSE:Set AT`
  (`00 22 C1 A4 09 80 01 8C 83 01 01 95 01 80`) → `9000`, `PSO:CDS`
  (`00 2A 9E 9A`) → `6985`.
- **Chybí:** jak middleware odvodí 8bajtovou session hodnotu do `00 A6`
  a SM klíč z ECDH (`EXTERNAL AUTHENTICATE` 80 B = 8 B + 72 B, kde
  72 B = 64 B veřejný klíč + 8 B MAC). Stavače příkazů jsou výše, odvození
  klíče ne — to je poslední kus pro clean-room podpis v appce.

## 12. `mutual_authenticate`: celé sestavení SM (dekompilováno)

`c_ias_applet::mutual_authenticate` (`FUN_002137fc`) je funkce, která SM
skutečně staví. Dekompilace dává celý sled kroků:

```c
typ = key_type(key)                     // 2 = AES, 1 = 3DES
alg = (typ == 2) ? 0x9C : 0x1C        // 0x9C = AES, 0x1C = 3DES

gen_keypair(eph, 1)                     // vtable+0xA0: ephemerální pár
export_pubkey(eph, 0x13, &ptr, &len)   // 0x13 = DER veřejný klíč
append(apdu, ptr, len)                  // -> EXTERNAL AUTHENTICATE data

// tři 8bajtové bloky z 32bajtového bufferu (challenge / nonce)
store_8(vtable+0x178, buf8,      8)
store_8(vtable+0x178, buf8,      8)
store_8(vtable+0x178, buf32 + 8, 8)
store_8(vtable+0x178, buf32 + 16, 8)
store_8(vtable+0x178, buf32 + 24, 8)

// MSE:Set AT (TLV)
tlv(0xCA, param_2 & 0xFF)               // algoritmus
tlv(0xC8, (alg == 0x9C) ? 0x8C : 0x1C)
tlv(0xCD, 0x80)
send_mse_set_at(vtable+0x168, tlv)
store_8(vtable+0x180, challenge, 8)       // 8B prefix do EXTERNAL AUTHENTICATE

// ECDH s veřejným klíčem karty
ecdh_init(key + 0x48, param_2, 0, 0)
ecdh_feed(key + 0x50, card_pubkey, len)
ecdh_derive(key + 0x58, 0, &len)

// výsledek: 32bajtový sdílený secret (16 + 16)
get_secret(key + 0x90, &local_48, 0x10)
get_secret(key + 0x98, buf + 0x10, 0x10)

// odvození SM klíče z 32B secretu
derive_sm_key(vtable+0x1A8, 0x9C, secret, len, ...)
```

**Co z toho plyne:**

- Sdílený secret je **32 bajtů** (dvě 16bajtové poloviny).
- Odvození SM klíče je volání `vtable+0x1A8` s argumentem `0x9C` (AES) nebo
  `0x1C` (3DES) a 32bajtovým secretem. To je poslední virtuální metoda,
  kterou je potřeba dohledat (její tělo není v `mutual_authenticate`).
- `0x9C` v `MSE:Set AT` odpovídá `80 01 8C` z reálného trace (`0x8C` = AES-128
  bez MAC-only varianty).
- 8bajtový prefix v `EXTERNAL AUTHENTICATE` je **challenge** uložený
  `vtable+0x180`, ne náhodné číslo — proto se stará hodnota po resetu nehodí
  a karta se resetuje.

### 12.1 Poslední krok

Dohledat tělo `vtable+0x1A8` (KDF). Vzhledem k tomu, že vstup je 32 B a výstup
se dělí na dvě 16bajtové poloviny, jde s vysokou pravděpodobností o
**AES-256 klíč = sdílený secret** nebo **SHA-256(secret)** rozdělený na
K_enc/K_mac. Ověřit to jde na kartě bez rizika: špatný MAC karta odmítne
**před** kontrolou PINu, takže chybný klíč nespotřebuje pokus.
