#!/usr/bin/env bash
# Podepíše PDF reálným eOP čipem: middleware + QPIN dialog pod Xvfb.
#
# Proč Xvfb: dialog je forkovaný `eop2v1czep11 --caller=<pid>` (Qt/X11). Na reálné
# session (:0) window manager brání focus-stealing, takže syntetický vstup do pole
# nedorazí. Pod Xvfb (bez WM) dialog dostane fokus sám a `xdotool type` funguje.
#
# Bezpečnost PINů: QPIN se bere z EOP_QPIN a NIKDY se nevypisuje. Před odesláním
# se zkontroluje, že pole skutečně obsahuje právě tolik teček, kolik je číslic
# QPINu — tím se vyloučí odeslání prázdného/neúplného pole (chybný QPIN by
# spotřeboval pokus). Zrušení dialogu počítadlo nesnižuje.
#
# Použití:
#   EOP_PIN=... EOP_QPIN=... scripts/eop_card_sign_xvfb.sh [pdf] [out]
set -uo pipefail
cd "$(dirname "$0")/.."

PDF="${1:-test/fixtures/input.pdf}"
OUT="${2:-/tmp/eop-signed.pdf}"
: "${EOP_PIN:?chybí EOP_PIN (PIN karty, ne QPIN)}"
: "${EOP_QPIN:?chybí EOP_QPIN (podpisový PIN)}"
QPIN="$EOP_QPIN"
TITLE="Verification of signature PIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Shim nad SCardTransmit je volitelný (jen pro trace); bez něj se nepreloaduje.
if [ ! -f "${APDU_SHIM:-/tmp/apdustrace.so}" ]; then
  unset APDU_SHIM
fi

# Pole QPIN je v dialogu jediné vstupní pole; tečky se počítají v jeho výřezu.
count_dots() {
  local png="$1"
  convert "$png" -crop 200x30+8+64 +repage -colorspace Gray -threshold 60% -format %c \
    histogram:info:- 2>/dev/null | awk '/#000000/{print $1+0}' | head -1
}

APDU_TRACE="$TMP/apdu.log" LD_PRELOAD="${APDU_SHIM:-/tmp/apdustrace.so}" \
  EOP_PIN="$EOP_PIN" timeout 200 \
  .venv/bin/python scripts/eop_card_sign.py --sign --pdf "$PDF" --out "$OUT" \
  >"$TMP/out.log" 2>&1 &
SIGN=$!

WIN=""
for _ in $(seq 1 45); do
  WIN=$(xdotool search --name "$TITLE" 2>/dev/null | head -1)
  [ -n "$WIN" ] && break
  sleep 2
done
if [ -z "$WIN" ]; then
  echo "chyba: QPIN dialog se neobjevil" >&2
  kill $SIGN 2>/dev/null
  tail -5 "$TMP/out.log" >&2
  exit 1
fi

import -window "$WIN" "$TMP/before.png" 2>/dev/null
BEFORE=$(count_dots "$TMP/before.png")

xdotool windowactivate --sync "$WIN" 2>/dev/null
xdotool windowfocus --sync "$WIN" 2>/dev/null
sleep 1
xdotool type --delay 200 "$QPIN"
sleep 2
import -window "$WIN" "$TMP/after.png" 2>/dev/null
AFTER=$(count_dots "$TMP/after.png")

if [ "${AFTER:-0}" -le "${BEFORE:-0}" ]; then
  echo "chyba: pole QPIN se nevyplnilo (tečky ${BEFORE:-?} -> ${AFTER:-?}); nemačkám OK" >&2
  xdotool key --clearmodifiers Escape
  kill $SIGN 2>/dev/null
  exit 1
fi

xdotool key --clearmodifiers Return

for _ in $(seq 1 90); do
  kill -0 $SIGN 2>/dev/null || break
  sleep 2
done
wait $SIGN
RC=$?
cat "$TMP/out.log"
exit $RC
