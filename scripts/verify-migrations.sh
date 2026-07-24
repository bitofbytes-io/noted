#!/bin/sh
set -eu

project=noted
compose_file=compose.local.yml
database="noted_migration_test_$$"
database_url="postgres://noted:noted@localhost:5434/${database}?sslmode=disable"

cleanup() {
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d postgres \
    -c "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" >/dev/null
}
trap cleanup EXIT INT TERM

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d postgres \
  -c "CREATE DATABASE \"$database\"" >/dev/null

DATABASE_URL="$database_url" go run ./cmd/migrate
DATABASE_URL="$database_url" go run ./cmd/migrate down

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
CREATE TABLE works (id uuid PRIMARY KEY);
INSERT INTO schema_migrations (version) VALUES ('000001_initial');
SQL

DATABASE_URL="$database_url" go run ./cmd/migrate

actual=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name"
)
expected='piece_pdfs
pieces
reader_states
schema_migrations'
if [ "$actual" != "$expected" ]; then
  printf 'unexpected tables after legacy reset\nexpected:\n%s\nactual:\n%s\n' \
    "$expected" "$actual" >&2
  exit 1
fi

version=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT version FROM schema_migrations ORDER BY version"
)
if [ "$version" != "000001_binder" ]; then
  printf 'unexpected migration version after legacy reset: %s\n' "$version" >&2
  exit 1
fi
