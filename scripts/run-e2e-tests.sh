#!/bin/sh
set -eu
project=noted
compose_file="$PWD/compose.local.yml"
database="noted_e2e_test_$$"
database_url="postgres://noted:noted@localhost:5434/${database}?sslmode=disable"
runtime="$PWD/.local/e2e-$$"
if curl -fsS http://127.0.0.1:8088/api/health >/dev/null 2>&1;then echo 'Port 8088 is already in use; stop the prior intake test server first.' >&2;exit 1;fi
mkdir -p "$runtime"
api_pid=''
cleanup(){
 if [ -n "$api_pid" ]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
 docker compose -p "$project" -f "$compose_file" exec -T postgres psql -v ON_ERROR_STOP=1 -U noted -d postgres -c "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" >/dev/null
}
trap cleanup EXIT INT TERM
docker compose -p "$project" -f "$compose_file" exec -T postgres psql -v ON_ERROR_STOP=1 -U noted -d postgres -c "CREATE DATABASE \"$database\"" >/dev/null
DATABASE_URL="$database_url" go run ./cmd/migrate
go build -o "$runtime/api" ./cmd/api
DATABASE_URL="$database_url" ASSET_ROOT="$runtime/assets" PORT=8088 AUTH_MODE=development DEV_USER_EMAIL=e2e@noted.local ALLOWED_ORIGIN=http://127.0.0.1:4208 FRONTEND_URL=http://127.0.0.1:4208 MAX_UPLOAD_BYTES=52428800 "$runtime/api" >"$runtime/api.log" 2>&1 &
api_pid=$!
for attempt in $(seq 1 50); do if curl -fsS http://127.0.0.1:8088/api/health >/dev/null 2>&1;then break;fi;sleep .2;done
kill -0 "$api_pid"
printf '%s\n' '{"/api":{"target":"http://127.0.0.1:8088","secure":false,"changeOrigin":true}}' > "$runtime/proxy.json"
cd web
NOTED_E2E_REAL_API=1 NOTED_E2E_BASE_URL=http://127.0.0.1:4208 NOTED_E2E_COMMAND="npm start -- --host 127.0.0.1 --port 4208 --proxy-config $runtime/proxy.json" npx playwright test --workers=2 "$@"
