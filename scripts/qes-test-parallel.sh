#!/usr/bin/env bash
# Paralelní běh RSpec sady forku (paralelní runner).
#
#   ./scripts/qes-test-parallel.sh [-g qes|fast|full] [-n 4] [--dry-run] [-- rspec argy…]
#   ./scripts/qes-test-parallel.sh --write-timings
#
# Každý worker je vlastní kontejner s vlastní SQLite DB a vlastním SCHEMA dumpem,
# takže se mezi workery nic nesdílí. `QesHelpers.with_crl_server` binduje
# 127.0.0.1:8765 a Capybara svůj Puma port, ale každý kontejner má vlastní
# network namespace → nekolidují (ověřeno).
#
# Bez `parallel_tests` gemu: ten by přidal řádek do Gemfile/Gemfile.lock, což je
# dotek upstreamu (docs/08). Dělení souborů dělá
# `scripts/qes_test_groups.py` podle naměřených časů z `test/qes/timings.txt`.
#
# Skupiny:
#   qes   QES vrstva (rychlé, bez Chromia) — výchozí
#   fast  vše kromě spec/system (bez Chromia)
#   full  celá sada kromě spec/system/dashboard_spec.rb (se Chromiem)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

REPO=vendor/docuseal
GROUP=${QES_PARALLEL_GROUP:-qes}
WORKERS=${QES_PARALLEL_WORKERS:-4}
SPLIT_THRESHOLD=${QES_PARALLEL_SPLIT_THRESHOLD:-45}
TIMINGS=test/qes/timings.txt
DRY_RUN=0
WRITE_TIMINGS=0
EXTRA=()

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -g|--group) GROUP=$2; shift 2 ;;
    -n|--workers) WORKERS=$2; shift 2 ;;
    -t|--split-threshold) SPLIT_THRESHOLD=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --write-timings) WRITE_TIMINGS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [ "$WRITE_TIMINGS" = 1 ]; then
  json="$REPO/tmp/rspec.json"
  if [ ! -f "$json" ]; then
    echo "chybí $json — nejdřív pusť: make qes-test-timings" >&2
    exit 1
  fi
  python3 - "$json" "$TIMINGS" <<'PY'
import collections
import json
import sys

source, target = sys.argv[1], sys.argv[2]
examples = json.load(open(source))['examples']
times = collections.defaultdict(float)
for example in examples:
    times[example['file_path'].lstrip('./')] += example['run_time']

with open(target, 'w') as handle:
    handle.write('# Naměřené časy spec souborů pro scripts/qes_test_groups.py\n')
    handle.write('# Formát: <sekundy>\t<cesta>. Generuje: make qes-test-timings\n')
    for path, seconds in sorted(times.items(), key=lambda item: -item[1]):
        handle.write(f'{seconds:.3f}\t{path}\n')

print(f'{target}: {len(times)} souborů, {sum(times.values()):.0f} s')
PY
  exit 0
fi

group_files() {
  local group=$1
  (
    cd "$REPO"
    case "$group" in
      qes)
        find spec/lib/qes -name '*_spec.rb'
        echo spec/models/qes_session_spec.rb
        echo spec/models/template_spec.rb
        echo spec/models/submission_spec.rb
        find spec/jobs/qes -name '*_spec.rb'
        find spec/requests -maxdepth 1 -name 'qes_*_spec.rb'
        echo spec/requests/doc_ts_verification_spec.rb
        ;;
      fast)
        find spec/models spec/lib spec/requests spec/jobs -name '*_spec.rb'
        ;;
      full)
        find spec -name '*_spec.rb' | grep -v '^spec/system/dashboard_spec\.rb$'
        ;;
      *)
        echo "neznámá skupina: $group (qes|fast|full)" >&2
        return 1
        ;;
    esac
  ) | sort -u
}

case "$GROUP" in
  full) IMAGE=${QES_SYSTEM_IMAGE:-dokulachtan-qes-system-test} ;;
  qes|fast) IMAGE=${QES_IMAGE:-dokulachtan-qes-test} ;;
  *)
    echo "neznámá skupina: $GROUP (qes|fast|full)" >&2
    exit 1
    ;;
esac

LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT
group_files "$GROUP" > "$LIST"

if [ ! -s "$LIST" ]; then
  echo "skupina $GROUP je prázdná — nic k běhu" >&2
  exit 1
fi

mapfile -t BINS < <(
  python3 scripts/qes_test_groups.py \
    --timings "$TIMINGS" --workers "$WORKERS" \
    --split-threshold "$SPLIT_THRESHOLD" --repo "$REPO" "$LIST"
)

if [ "$DRY_RUN" = 1 ]; then
  for index in "${!BINS[@]}"; do
    printf 'worker %d: %s\n' "$((index + 1))" "${BINS[$index]}"
  done
  exit 0
fi

mkdir -p test/out

run_worker() {
  local index=$1
  shift
  local log="test/out/qes-parallel-${index}.txt"
  podman run --rm \
    -v "$ROOT/$REPO:/app" -v "$ROOT/test:/qes-test:ro" -w /app \
    -e RAILS_ENV=test -e BUNDLE_WITHOUT= -e BUNDLE_GEMFILE=/app/Gemfile \
    -e PRIMARY_DATABASE_URL="sqlite3:/app/db/qes-parallel-${index}.sqlite3" \
    -e SCHEMA="/app/tmp/qes-parallel-${index}.rb" \
    -e HOME=/tmp -e TZ=UTC -e QES_TEST_DIR=/qes-test \
    "$IMAGE" \
    sh -c 'bundle exec rake db:create db:migrate >/dev/null 2>&1; bundle exec rspec "$@"' \
    _ "$@" "${EXTRA[@]}" > "$log" 2>&1
}

echo "== $GROUP, $WORKERS workerů, obrázek $IMAGE =="
start=$(date +%s)
pids=()
for index in "${!BINS[@]}"; do
  read -r -a specs <<< "${BINS[$index]}"
  if [ ${#specs[@]} -eq 0 ]; then
    continue
  fi
  run_worker "$((index + 1))" "${specs[@]}" &
  pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do
  wait "$pid" || status=1
done
end=$(date +%s)

for index in "${!BINS[@]}"; do
  log="test/out/qes-parallel-$((index + 1)).txt"
  [ -f "$log" ] || continue
  echo "--- worker $((index + 1)) ---"
  grep -E '^(Finished in|[0-9]+ examples)' "$log" || tail -3 "$log"
done

echo "== hotovo za $((end - start)) s (skupina $GROUP, $WORKERS workerů) =="
if [ "$status" -ne 0 ]; then
  echo "NĚKTERÝ WORKER SELHAL — detaily v test/out/qes-parallel-*.txt" >&2
fi
exit "$status"
