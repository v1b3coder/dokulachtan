#!/usr/bin/env bash
# Vygeneruje db/schema.rb z migrací forku na Postgresu 18 a při změně schématu
# přidá no-op migraci s verzí o jedna vyšší.
#
#   ./scripts/qes-schema-regen.sh <klon forku>
#
# Proč: db/schema.rb je generovaný artefakt, ne ručně slučovaný soubor. Po rebase
# na upstream se konflikt v db/schema.rb řeší tak, že se vezme upstream strana
# (fork delta se zahodí, migrace zůstávají) a sem se pak schéma vygeneruje
# z migrací. Když se obsah schematu změnil, přidá se no-op migrace s verzí
# o jedna vyšší, aby se na existujícím deploymentu provedla migrace a
# schema_migrations se srovnalo se schematem (boot běží `DatabaseTasks.migrate`).
#
# Klon forku se tím nemění commitem — commit dělá volající (job) zvlášť.
set -euo pipefail

FORK=${1:?použití: $0 <klon forku>}
IMAGE=${QES_IMAGE:-dokulachtan-qes-system-test}
NET=qes-schema-net
DB_IP=10.89.97.2
DB_NAME=qes_schema_db
DB_URL="postgresql://postgres:postgres@${DB_IP}:5432/${DB_NAME}"
CONTAINER=qes-schema-db
TMP_DUMP=tmp/qes-schema-regen.rb

[ -d "$FORK/db/migrate" ] || { echo "chybí $FORK/db/migrate" >&2; exit 1; }

cleanup() {
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
  rm -f "$FORK/$TMP_DUMP"
}
trap cleanup EXIT

max_migration() {
  ls "$FORK/db/migrate" | sed -n 's/^\([0-9]\{14\}\)_.*/\1/p' | sort | tail -1
}

# No-op migrace, která jen posune verzi (žádná změna tabulek).
write_bump() {
  cat > "$FORK/db/migrate/${1}_qes_schema_bump.rb" <<'RB'
# frozen_string_literal: true

# No-op migrace: po rebase/merge schematu posune verzi o jedna vys, aby se
# na existujicim deploymentu provedla migrace a schema_migrations se srovnalo
# se schematem. Nemění žádnou tabulku.
class QesSchemaBump < ActiveRecord::Migration[8.1]
  def change; end
end
RB
}

MAX=$(max_migration)
[ -n "$MAX" ] || { echo "v db/migrate není žádná migrace" >&2; exit 1; }

podman network exists "$NET" || podman network create --subnet 10.89.97.0/24 "$NET" >/dev/null
podman run -d --rm --name "$CONTAINER" --network "$NET" --ip "$DB_IP" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB_NAME" \
  docker.io/library/postgres:18 >/dev/null

echo "== čekám na Postgres 18 na ${DB_IP} =="
for _ in $(seq 1 60); do
  podman exec "$CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done

migrate() {
  podman run --rm --network "$NET" -v "$FORK:/app" -w /app \
    -e RAILS_ENV=test -e BUNDLE_WITHOUT= -e BUNDLE_GEMFILE=/app/Gemfile \
    -e PRIMARY_DATABASE_URL="$DB_URL" -e SCHEMA="$1" -e HOME=/tmp -e TZ=UTC \
    "$IMAGE" sh -c 'bundle exec rake db:create db:migrate' >/dev/null
}

echo "== generuji schéma z migrací =="
migrate "/app/$TMP_DUMP"

# Rozhoduje obsah bez řádku s verzí, ne verze: bump se dělá jen při změně schématu.
strip_version() { grep -v 'ActiveRecord::Schema\[' "$1"; }
if strip_version "$FORK/db/schema.rb" | diff -q - <(strip_version "$FORK/$TMP_DUMP") >/dev/null; then
  echo "== obsah schématu se nezměnil, jen srovnávám verzi na $MAX =="
  cp "$FORK/$TMP_DUMP" "$FORK/db/schema.rb"
else
  NEW=$(date -u -d "$(echo "$MAX" | sed 's/\(....\)\(..\)\(..\)\(..\)\(..\)\(..\)/\1-\2-\3 \4:\5:\6/') UTC +1 second" +%Y%m%d%H%M%S)
  echo "== schéma se změnilo, bumpuji verzi na $NEW =="
  for f in "$FORK"/db/migrate/*_qes_schema_bump.rb; do
    [ -e "$f" ] || continue
    git -C "$FORK" rm -q -f --ignore-unmatch "$f" 2>/dev/null || true
    rm -f "$f"
  done
  write_bump "$NEW"
  migrate /app/db/schema.rb
fi

# Verze v dumpu musí být ta, kterou jsme nastavili (bump i bez bumpu).
GOT=$(sed -n 's/^ActiveRecord::Schema\[[0-9.]*\]\.define(version: \([0-9_]*\)) do$/\1/p' "$FORK/db/schema.rb")
GOT=${GOT//_/}
[ "$GOT" = "$MAX" ] || [ "$GOT" = "${NEW:-$MAX}" ] || {
  echo "verze v db/schema.rb ($GOT) nesedí na max migraci ($MAX)" >&2; exit 1; }
ruby -c "$FORK/db/schema.rb" >/dev/null 2>&1 || {
  podman run --rm -v "$FORK:/app" -w /app "$IMAGE" ruby -c db/schema.rb >/dev/null || exit 1; }

echo "== db/schema.rb: version $GOT, max migrace $(max_migration) =="
