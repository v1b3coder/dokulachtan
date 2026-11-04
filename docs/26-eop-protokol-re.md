# 26 — eOP: reverzní inženýrství protokolu (Linux middleware)

Cíl: zjistit, jak mluvit s českou eObčankou (eOP) bez MOI Podpisového SDK, aby šla
čtečka zapojit do appky. Metoda: odposlech oficiálního Linux middleware
(`eobcanka.deb`) přes `LD_PRELOAD` shim nad `SCardTransmit`, plus enumerace BLE GATT
přes BlueZ.

Datum: 2026-11-03. Prostředí: Linux Mint 22, BlueZ 5.72, `eobcanka 3.5.2`.

## 1. Co je hotové a ověřené

| Vrstva | Stav | Zdroj |
|---|---|---|
| Čtečka přes USB (CCID) | ✅ funguje | `pcscd` + `libccid`, ATR přečten |
| Identifikace karty | ✅ eOP vydaná po 7/2018 | ATR v pcsc-tools DB |
| Kartový APDU protokol | ✅ odposlechnutý (níže) | shim nad `libsa2v1czep11.so` |
| BLE GATT profil čtečky | ✅ vyenumerovaný (níže) | BlueZ `busctl` nad D-Bus |
| BLE framing (obal APDU) | ✅ uvnitř ACS EVK | AES-128 + XOR checksum, knihovna dává `javax.smartcardio` |
| Podpisový protokol | ❌ nezachytitelný | karta nemá klíč/cert (`C_FindObjects` = 0) |

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

**Round-trip ověřen 2026-11-04** přes BlueZ na počítači: zápis na `AE448003`
(notify na `AE448002` i `AE448004`) vrátil notifikaci

```
9F 02 00 06 9B        9F ^ 02 ^ 00 ^ 06 = 9B  (checksum sedí)
```

Tím je potvrzené, že **checksum je XOR předchozích bajtů** a reader na zápis
odpovídá. Vrácená hodnota je ale *status*, ne výsledek APDU — karta v readeru
nebyla napájená/vybraná (protokol má navíc escape/control vrstvu,
`BluetoothTerminalManager.IOCTL_ESCAPE` = `3500`).

**Aplikace framing neimplementuje:** knihovna vystavuje standardní
`javax.smartcardio` (`Card`, `CardChannel`, `CommandAPDU`) a framing i AES řeší
uvnitř. Demo (`BLETest`) volá jen `card.getATR()` a `channel.transmit(new CommandAPDU(...))`.

Pro náš případ to znamená: přidat `acssmcio-0.6.2.aar` + `smartcardio-0.1.7.aar`
do `android/app/libs/`, přes `BluetoothTerminalManager` vyhledat/spojit čtečku a
pak posílat APDU přes `CardChannel` — přesně jak to dělá demo.

**Co zůstává neznámé:** přesný bajtový layout 3bajtové hlavičky (pořadí
command/length) a režim AES (ECB/CBC) — knihovna to má v `internal/o.class`,
co je pravděpodobně JNI wrapper nad nativní `.so` v `smartcardio` AAR. Pro
použití AAR to není potřeba znát.

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
- **Podpisový protokol** je jediné, co zůstává otevřené: karta bez klíče/certu
  (`C_FindObjects` = 0) ho neodemkne. Řeší ho eOP SDK od **Monet+ (ProID)**,
  který eObčanka veze (`com.aheaditec.eopsdk`).
- **Nejkratší cesta k podpisu** je licencovat eOP SDK od Monet+ (ProID) — stejný
  vendord jako `com.aheaditec:ccid` v `PLAN.md` 5.2, ne jen MOI/SZR. RE + reimplementace
  je možná (native libs jsou pro x86_64), ale je to staticky linkované OpenSSL.
- **USB OTG** zůstává plně podložené: CCID spec je veřejná a kartový protokol výše
  je odposlechnutý. Chybí jen CCID implementace pro Android.
