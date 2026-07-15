#!/bin/sh
set -eu

go run ./cmd/migrate
expected=$(find migrations -name '*.up.sql' -type f | wc -l | tr -d ' ')
rolled_back=0
while [ "$rolled_back" -lt "$expected" ]; do
	go run ./cmd/migrate down
	rolled_back=$((rolled_back + 1))
done

remaining=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$remaining" -ne 0 ]; then
	echo "expected every migration to roll back; $remaining remain" >&2
	exit 1
fi

go run ./cmd/migrate
applied=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$applied" -ne "$expected" ]; then
	echo "expected $expected reapplied migrations; found $applied" >&2
	exit 1
fi
