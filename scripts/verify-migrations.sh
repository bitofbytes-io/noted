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
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down

# A works table alone is not enough to identify the historical Noted schema.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
CREATE TABLE works (id uuid PRIMARY KEY, marker text NOT NULL);
INSERT INTO works (id, marker)
VALUES ('4f607127-fb97-4b22-90f5-1b9bec77b739', 'works-only');
SQL

if DATABASE_URL="$database_url" go run ./cmd/migrate >/dev/null 2>&1; then
  echo "migration unexpectedly reset a works-only schema" >&2
  exit 1
fi
works_marker=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT marker FROM works WHERE id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$works_marker" != "works-only" ]; then
  echo "works-only schema changed during refused migration" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" -c "DROP TABLE works" >/dev/null

# Even a legacy migration name plus a partial table set must be refused intact.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
CREATE TABLE users (week_starts_on integer);
CREATE TABLE composers (canonical_name text);
CREATE TABLE works (
  id uuid PRIMARY KEY,
  composer_id uuid,
  created_by_user_id uuid,
  catalog_number text,
  marker text NOT NULL
);
INSERT INTO works (id, marker)
VALUES ('4f607127-fb97-4b22-90f5-1b9bec77b739', 'partial');
INSERT INTO schema_migrations (version) VALUES ('000001_initial');
SQL

if DATABASE_URL="$database_url" go run ./cmd/migrate >/dev/null 2>&1; then
  echo "migration unexpectedly reset a partial legacy schema" >&2
  exit 1
fi
partial_marker=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT marker FROM works WHERE id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$partial_marker" != "partial" ]; then
  echo "partial legacy schema changed during refused migration" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DROP TABLE works, composers, users; DELETE FROM schema_migrations" >/dev/null

# A lookalike using all of the old table names still needs Noted-specific columns.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
CREATE TABLE users (id integer);
CREATE TABLE composers (id integer);
CREATE TABLE works (id integer PRIMARY KEY, marker text NOT NULL);
CREATE TABLE movements (id integer);
CREATE TABLE editions (id integer);
CREATE TABLE score_assets (id integer);
CREATE TABLE learner_works (id integer);
CREATE TABLE tags (id integer);
CREATE TABLE learner_work_tags (id integer);
CREATE TABLE practice_sessions (id integer);
INSERT INTO works (id, marker) VALUES (1, 'lookalike');
INSERT INTO schema_migrations (version) VALUES ('000001_initial');
SQL

if DATABASE_URL="$database_url" go run ./cmd/migrate >/dev/null 2>&1; then
  echo "migration unexpectedly reset a lookalike schema" >&2
  exit 1
fi
lookalike_marker=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT marker FROM works WHERE id=1"
)
if [ "$lookalike_marker" != "lookalike" ]; then
  echo "lookalike schema changed during refused migration" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DROP TABLE works, composers, movements, editions, score_assets, learner_works, tags, learner_work_tags, practice_sessions, users; DELETE FROM schema_migrations" >/dev/null

# This is the minimum unambiguous fingerprint present after the historical
# 000001_initial Noted migration. The reset may proceed only for this shape.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" <<'SQL'
CREATE TABLE users (week_starts_on integer);
CREATE TABLE composers (canonical_name text);
CREATE TABLE works (
  composer_id uuid,
  created_by_user_id uuid,
  catalog_number text
);
CREATE TABLE movements (sequence_number integer);
CREATE TABLE editions (rights_note text);
CREATE TABLE score_assets (
  asset_type text,
  rights_note text,
  sha256 text
);
CREATE TABLE learner_works (
  last_score_asset_id uuid,
  personal_difficulty text
);
CREATE TABLE tags (normalized_name text);
CREATE TABLE learner_work_tags (
  learner_work_id uuid,
  tag_id uuid
);
CREATE TABLE practice_sessions (
  entry_method text,
  duration_seconds integer
);
CREATE TABLE unrelated_application_data (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO unrelated_application_data (id, value) VALUES (1, 'keep me');
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
expected='asset_deletion_queue
draft_sources
import_assets
import_drafts
oauth_login_states
piece_pdfs
piece_sources
pieces
reader_states
schema_migrations
unrelated_application_data
user_sessions
users'
if [ "$actual" != "$expected" ]; then
  printf 'unexpected tables after legacy reset\nexpected:\n%s\nactual:\n%s\n' \
    "$expected" "$actual" >&2
  exit 1
fi

unrelated_value=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT value FROM unrelated_application_data WHERE id = 1"
)
if [ "$unrelated_value" != "keep me" ]; then
  printf 'unrelated public table was not preserved by legacy reset\n' >&2
  exit 1
fi

version=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT version FROM schema_migrations ORDER BY version"
)
if [ "$version" != "000001_binder
000002_users_and_ownership
000003_piece_listening_url
000004_score_intake
000005_reader_scroll_speed" ]; then
  printf 'unexpected migration version after legacy reset: %s\n' "$version" >&2
  exit 1
fi

# A mixed legacy/binder schema is ambiguous and must still be refused without
# changing either generation.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "CREATE TABLE works (id uuid PRIMARY KEY)" >/dev/null

if DATABASE_URL="$database_url" go run ./cmd/migrate >/dev/null 2>&1; then
  echo "migration unexpectedly accepted coexisting legacy and binder schemas" >&2
  exit 1
fi

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DROP TABLE works" >/dev/null

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
INSERT INTO reader_states (piece_id)
VALUES ('4f607127-fb97-4b22-90f5-1b9bec77b739');
SQL

scroll_speed=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT scroll_speed FROM reader_states
     WHERE piece_id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$scroll_speed" != "5" ]; then
  printf 'unexpected reader scroll speed default: %s\n' "$scroll_speed" >&2
  exit 1
fi

if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE reader_states SET scroll_speed=11" >/dev/null 2>&1; then
  echo "reader scroll speed constraint unexpectedly accepted 11" >&2
  exit 1
fi

# Roll back reader speed, score intake and listening URL before exercising the ownership guard.
DATABASE_URL="$database_url" go run ./cmd/migrate down

docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE reader_states SET scroll_speed=120" >/dev/null
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE reader_states SET scroll_speed=4" >/dev/null 2>&1; then
  echo "rolled-back reader scroll speed constraint unexpectedly accepted 4" >&2
  exit 1
fi

DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down

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
