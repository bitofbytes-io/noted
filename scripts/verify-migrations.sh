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
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
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
search_index_state
shortcut_tokens
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
000005_reader_scroll_speed
000006_imslp_catalog
000007_drop_imslp_catalog
000008_shortcut_tokens
000009_library_metadata
000010_library_sort
000011_library_search
000012_composer_keys
000013_search_suggestions
000014_musical_metadata" ]; then
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

# Existing pieces start as Playing and users on the default library filter;
# both columns accept only their known values.
library_defaults=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT p.status || '|' || u.library_filter FROM pieces p JOIN users u ON u.id=p.user_id
     WHERE p.id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$library_defaults" != "playing|current" ]; then
  printf 'unexpected piece status or library filter default: %s\n' "$library_defaults" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE pieces SET status='archived'" >/dev/null 2>&1; then
  echo "piece status constraint unexpectedly accepted archived" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE users SET library_filter='archived'" >/dev/null 2>&1; then
  echo "library filter constraint unexpectedly accepted archived" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE pieces SET status='shelved'; UPDATE users SET library_filter='favorites'" >/dev/null

# Existing users start on the Title sort, which accepts only the known sorts.
library_sort=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT library_sort FROM users WHERE id='db53bb2a-b720-407a-8941-cd4459f69e79'"
)
if [ "$library_sort" != "title" ]; then
  printf 'unexpected library sort default: %s\n' "$library_sort" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE users SET library_sort='played'" >/dev/null 2>&1; then
  echo "library sort constraint unexpectedly accepted played" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE users SET library_sort='fresh'" >/dev/null

# Pieces start with no aliases and searchable text; the API refolds it on start
# because the fold version starts at 0. Aliases are at most 1000 characters.
library_search=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT p.aliases || '|' || (SELECT fold_version FROM search_index_state WHERE id)
     FROM pieces p WHERE p.id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$library_search" != "|0" ]; then
  printf 'unexpected piece aliases or fold version: %s\n' "$library_search" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE pieces SET aliases=repeat('a', 1001)" >/dev/null 2>&1; then
  echo "piece aliases constraint unexpectedly accepted 1001 characters" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "INSERT INTO search_index_state (id, fold_version) VALUES (FALSE, 1)" >/dev/null 2>&1; then
  echo "search_index_state unexpectedly accepted a second row" >&2
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE pieces SET aliases='Nickname', search_text='owned piece nickname'" >/dev/null

# Musical metadata starts empty and is bounded; rollback removes only these fields.
musical_defaults=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT bool_and(opus='' AND music_key='') FROM pieces"
)
if [ "$musical_defaults" != "t" ]; then
  echo "unexpected musical metadata defaults" >&2
  exit 1
fi
for column in opus music_key; do
  if docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
    -c "UPDATE pieces SET $column=repeat('a',101)" >/dev/null 2>&1; then
    echo "musical metadata constraint accepted an oversized value" >&2
    exit 1
  fi
done
DATABASE_URL="$database_url" go run ./cmd/migrate down
musical_removed=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='pieces' AND column_name IN ('opus','music_key')) || '|' || (SELECT aliases FROM pieces WHERE id='4f607127-fb97-4b22-90f5-1b9bec77b739')"
)
if [ "$musical_removed" != "0|Nickname" ]; then
  echo "musical metadata rollback changed unrelated fields or retained columns" >&2
  exit 1
fi

# The typo index is additive; rollback retains the potentially shared extension.
trgm_ready=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT (to_regclass('pieces_search_trgm_idx') IS NOT NULL) AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm')"
)
if [ "$trgm_ready" != "t" ]; then
  echo "missing typo suggestion index or extension" >&2
  exit 1
fi
DATABASE_URL="$database_url" go run ./cmd/migrate down
trgm_retained=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT (to_regclass('pieces_search_trgm_idx') IS NULL) AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AND to_regclass('pieces_composer_sort_idx') IS NOT NULL"
)
if [ "$trgm_retained" != "t" ]; then
  echo "typo rollback removed shared structures or retained index" >&2
  exit 1
fi

# The additive composer migration preserves display names and starts stale until
# Go computes the keys. Its down removes only derived columns and their index.
composer_keys=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT composer_sort || '|' || composer_sort_source || '|' || composer_sort_version || '|' ||
       (to_regclass('pieces_composer_sort_idx') IS NOT NULL)
     FROM pieces WHERE id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$composer_keys" != "||0|true" ]; then
  echo "unexpected composer key defaults or missing index" >&2
  exit 1
fi
DATABASE_URL="$database_url" go run ./cmd/migrate down
composer_removed=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='pieces' AND column_name LIKE 'composer_sort%') || '|' ||
       (to_regclass('pieces_composer_sort_idx') IS NULL) || '|' ||
       (SELECT aliases FROM pieces WHERE id='4f607127-fb97-4b22-90f5-1b9bec77b739')"
)
if [ "$composer_removed" != "0|true|Nickname" ]; then
  echo "composer rollback changed unrelated metadata or retained derived structures" >&2
  exit 1
fi

# Rolling back 000011 removes only the search columns and state table.
DATABASE_URL="$database_url" go run ./cmd/migrate down
library_after_search=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT p.title || '|' || (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='pieces'
         AND column_name IN ('aliases', 'search_text'))
       || '|' || (SELECT count(*) FROM information_schema.tables
       WHERE table_schema='public' AND table_name='search_index_state')
     FROM pieces p WHERE p.id='4f607127-fb97-4b22-90f5-1b9bec77b739'"
)
if [ "$library_after_search" != "Owned piece|0|0" ]; then
  printf 'unexpected pieces after rolling back 000011: %s\n' "$library_after_search" >&2
  exit 1
fi

# Rolling back 000010 removes only the sort and keeps the filter.
DATABASE_URL="$database_url" go run ./cmd/migrate down
library_after_sort=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT u.library_filter || '|' || (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='library_sort')
     FROM users u WHERE u.id='db53bb2a-b720-407a-8941-cd4459f69e79'"
)
if [ "$library_after_sort" != "favorites|0" ]; then
  printf 'unexpected users after rolling back 000010: %s\n' "$library_after_sort" >&2
  exit 1
fi

# Rolling back 000009 removes only its two columns and index.
DATABASE_URL="$database_url" go run ./cmd/migrate down
library_columns=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public'
       AND ((table_name='pieces' AND column_name='status')
         OR (table_name='users' AND column_name='library_filter'))"
)
if [ "$library_columns" != "0" ]; then
  echo "library metadata columns survived rolling back 000009" >&2
  exit 1
fi

# A shortcut token is a 32-byte hash, unique, one per user, and leaves with
# its user.
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "INSERT INTO shortcut_tokens (user_id, token_hash)
      VALUES ('db53bb2a-b720-407a-8941-cd4459f69e79', decode(repeat('ab', 32), 'hex'))" >/dev/null
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "UPDATE shortcut_tokens SET token_hash=decode(repeat('ab', 31), 'hex')" >/dev/null 2>&1; then
  echo "shortcut token hash length constraint unexpectedly accepted 31 bytes" >&2
  exit 1
fi
if docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "INSERT INTO shortcut_tokens (user_id, token_hash)
      VALUES ('db53bb2a-b720-407a-8941-cd4459f69e79', decode(repeat('cd', 32), 'hex'))" >/dev/null 2>&1; then
  echo "a second shortcut token for one user was unexpectedly accepted" >&2
  exit 1
fi

# Rolling back 000008 removes only the token table; reapplying restores it.
DATABASE_URL="$database_url" go run ./cmd/migrate down
token_table=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public' AND table_name='shortcut_tokens'"
)
if [ "$token_table" != "0" ]; then
  echo "shortcut_tokens survived rolling back 000008" >&2
  exit 1
fi
DATABASE_URL="$database_url" go run ./cmd/migrate
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "INSERT INTO shortcut_tokens (user_id, token_hash)
      VALUES ('db53bb2a-b720-407a-8941-cd4459f69e79', decode(repeat('ef', 32), 'hex'))" >/dev/null
docker compose -p "$project" -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U noted -d "$database" \
  -c "DELETE FROM pieces; DELETE FROM users;" >/dev/null
remaining_tokens=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT count(*) FROM shortcut_tokens"
)
if [ "$remaining_tokens" != "0" ]; then
  echo "deleting a user did not remove its shortcut token" >&2
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
INSERT INTO reader_states (piece_id, scroll_speed)
VALUES ('4f607127-fb97-4b22-90f5-1b9bec77b739', 5);
SQL
# Roll back 000014, 000013, 000012, 000011, 000010, 000009, then 000008.
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down
DATABASE_URL="$database_url" go run ./cmd/migrate down

# Rolling back the catalogue removal restores both tables and the single
# state row exactly as 000006 created them.
DATABASE_URL="$database_url" go run ./cmd/migrate down
catalogue=$(
  docker compose -p "$project" -f "$compose_file" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U noted -d "$database" -Atc \
    "SELECT (SELECT count(*) FROM imslp_catalog_state WHERE id AND active_generation IS NULL),
            (SELECT count(*) FROM imslp_catalog_works)"
)
if [ "$catalogue" != "1|0" ]; then
  printf 'unexpected IMSLP catalogue after rolling back 000007: %s\n' "$catalogue" >&2
  exit 1
fi

# Roll back the work cache, reader speed, score intake and listening URL
# before exercising the ownership guard.
DATABASE_URL="$database_url" go run ./cmd/migrate down
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
