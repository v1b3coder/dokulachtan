#!/usr/bin/env bash
# Test spouštěče paralelních testů (#23.2): prázdný nebo neplatný plán nesmí
# projít jako úspěch. Běží jen `--dry-run`, takže nespouští žádný kontejner.
set -euo pipefail

cd "$(dirname "$0")/.."

script="./scripts/qes-test-parallel.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Neplatný počet workerů: dřív plánovač spadl, `mapfile` to zahodil a skript
# skončil exit 0 s „hotovo za 0 s“.
for bad in 0 x -1 ''; do
  if "$script" -n "$bad" --dry-run >/dev/null 2>&1; then
    fail "-n '$bad' prošlo jako úspěch"
  fi
  echo "ok: -n '$bad' odmítnuto"
done

# Platný plán: přesně tolik řádků, kolik je workerů.
for workers in 1 4; do
  got=$("$script" -n "$workers" -g qes --dry-run | wc -l)
  [ "$got" -eq "$workers" ] || fail "-n $workers vrátilo $got řádků"
  echo "ok: -n $workers naplánovalo $workers skupin"
done

echo "ok: paralelní spouštěč odmítá prázdný plán"
