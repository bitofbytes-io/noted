#!/bin/sh
set -eu

api_pid=""
web_pid=""
cleanup() {
	trap - EXIT INT TERM
	if [ -n "$web_pid" ]; then
		kill "$web_pid" 2>/dev/null || true
		wait "$web_pid" 2>/dev/null || true
	fi
	if [ -n "$api_pid" ]; then
		kill "$api_pid" 2>/dev/null || true
		wait "$api_pid" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

go run ./cmd/migrate
go run ./cmd/seed
api_binary="$ASSET_ROOT/noted-test-api"
go build -o "$api_binary" ./cmd/api
"$api_binary" &
api_pid=$!
(cd web && npm start -- --host 127.0.0.1) &
web_pid=$!
wait "$web_pid"
