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
DATABASE_URL="$database_url" go run ./cmd/migrate

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
  "SELECT table_name FROM information_schema.tables
   WHERE table_schema='public'
   AND table_name IN ('pieces','piece_pdfs','reader_states')
   ORDER BY table_name" |
  diff -u - <<'EOF'
piece_pdfs
pieces
reader_states
EOF
