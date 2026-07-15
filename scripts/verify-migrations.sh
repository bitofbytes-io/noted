#!/bin/sh
set -eu

go run ./cmd/migrate
go run ./cmd/migrate down
go run ./cmd/migrate down

remaining=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$remaining" -ne 0 ]; then
	echo "expected every migration to roll back; $remaining remain" >&2
	exit 1
fi

go run ./cmd/migrate
expected=$(find migrations -name '*.up.sql' -type f | wc -l | tr -d ' ')
applied=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$applied" -ne "$expected" ]; then
	echo "expected $expected reapplied migrations; found $applied" >&2
	exit 1
fi
