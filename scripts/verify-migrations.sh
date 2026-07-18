#!/bin/sh
set -eu

go run ./cmd/migrate

# Exercise the production-auth upgrade from the immediately preceding schema. The
# migration must reject case-colliding legacy accounts before changing either row.
go run ./cmd/migrate down
go run ./cmd/migrate down
go run ./cmd/migrate down
go run ./cmd/migrate down
docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (email, display_name) VALUES
    ('Migration.Collision@example.test', 'Migration collision upper'),
    ('migration.collision@example.test', 'Migration collision lower');
SQL
if collision_error=$(go run ./cmd/migrate 2>&1); then
	echo "expected migration 000004 to reject case-colliding emails" >&2
	exit 1
fi
case "$collision_error" in
	*"case-colliding accounts exist"*) ;;
	*)
		echo "migration 000004 failed without the expected case-collision diagnostic" >&2
		exit 1
		;;
esac
unchanged=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM users WHERE email = 'Migration.Collision@example.test'")
if [ "$unchanged" -ne 1 ]; then
	echo "migration 000004 changed a colliding email before rejecting the upgrade" >&2
	exit 1
fi
docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -v ON_ERROR_STOP=1 -c "DELETE FROM users WHERE lower(email) = 'migration.collision@example.test'" >/dev/null
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
