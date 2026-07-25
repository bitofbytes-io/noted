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
expected='oauth_login_states
piece_pdfs
pieces
reader_states
schema_migrations
user_sessions
users'
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
if [ "$version" != "000001_binder
000002_users_and_ownership" ]; then
  printf 'unexpected migration version after legacy reset: %s\n' "$version" >&2
  exit 1
fi

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
INSERT INTO users (id,email,display_name,auth_provider)
VALUES ('db53bb2a-b720-407a-8941-cd4459f69e79','owner@example.test','Owner','development');
INSERT INTO pieces (id,user_id,title)
VALUES (
  '4f607127-fb97-4b22-90f5-1b9bec77b739',
  'db53bb2a-b720-407a-8941-cd4459f69e79',
  'Owned piece'
);
SQL

if DATABASE_URL="$database_url" go run ./cmd/migrate down >/dev/null 2>&1; then
  echo "ownership rollback unexpectedly succeeded with private pieces present" >&2
  exit 1
fi

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DELETE FROM pieces; DELETE FROM users;" >/dev/null

DATABASE_URL="$database_url" go run ./cmd/migrate down

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "INSERT INTO pieces (id,title) VALUES ('4f607127-fb97-4b22-90f5-1b9bec77b739','Legacy piece');" >/dev/null

if DATABASE_URL="$database_url" go run ./cmd/migrate >/dev/null 2>&1; then
  echo "ownership migration unexpectedly succeeded with unowned pieces present" >&2
  exit 1
fi

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DELETE FROM pieces;" >/dev/null

DATABASE_URL="$database_url" go run ./cmd/migrate
