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
| BLE framing (obal APDU) | ❌ neznámý | 5 hypotéz bez odpovědi |
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

## 4. Co chybí

1. **BLE framing** — jak se APDU obaluje do zápisu na `ae448003`. Zkoušené hypotézy
   (raw, 1bajtová délka, 2bajtová BE/LE, command byte + délka) nevrátily
   notifikaci. Potřebné vzít z ACS BLE EVK (`acssmcio`) nebo odposlechnout
   oficiální Android appku (HCI snoop log).
2. **Podpisový protokol** — karta v tomto stavu nemá žádný objekt
   (`C_FindObjects` = 0 pro cert/privkey/pubkey/data), takže `C_Sign` se nikdy
   nezavolá. Bez karty s podpisovým certifikátem ho nezachytíme.

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

## 6. Důsledek pro projekt

- **Varianta A přes USB OTG** je plně podložená: CCID spec je veřejná a kartový
  protokol výše je odposlechnutý. Chybí jen CCID implementace pro Android.
- **Varianta A přes BLE** potřebuje navíc BLE framing (odstavec 4.1).
- MOI Podpisové SDK zůstává nejkratší cestou (`PLAN.md` 5.2); tento dokument je
  záložní cesta a zároveň důkaz, že protokol není veřejně dokumentovaný.
