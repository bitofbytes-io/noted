#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
	echo "usage: $0 <scope> <command> [args...]" >&2
	exit 2
fi

scope=$(printf '%s' "$1" | tr -cd '[:alnum:]_')
shift
database="noted_${scope}_$$"
asset_root=$(mktemp -d "${TMPDIR:-/tmp}/noted-${scope}-assets.XXXXXX")
child=""

cleanup() {
	trap - EXIT INT TERM
	if [ -n "$child" ]; then
		kill "$child" 2>/dev/null || true
		wait "$child" 2>/dev/null || true
	fi
	docker compose -p noted -f compose.local.yml exec -T postgres dropdb --if-exists --force -U noted "$database" >/dev/null 2>&1 || true
	rm -rf "$asset_root"
}
trap cleanup EXIT INT TERM

docker compose -p noted -f compose.local.yml up -d --wait postgres
docker compose -p noted -f compose.local.yml exec -T postgres createdb -U noted "$database"

unset DATABASE_URL_FILE AUTH_GOOGLE_CLIENT_ID_FILE AUTH_GOOGLE_CLIENT_SECRET_FILE
export APP_ENV=test
export AUTH_MODE=development
export DATABASE_URL="postgres://noted:noted@localhost:5434/${database}?sslmode=disable"
export TEST_DATABASE_NAME="$database"
export ASSET_ROOT="$asset_root"
export PORT=8080
export FRONTEND_URL=http://127.0.0.1:4200
export ALLOWED_ORIGINS=http://127.0.0.1:4200

"$@" &
child=$!
wait "$child"
status=$?
child=""
exit "$status"
