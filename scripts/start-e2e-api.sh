#!/bin/sh
set -eu

go run ./cmd/migrate
go run ./cmd/seed
api_binary="$ASSET_ROOT/noted-e2e-api"
go build -o "$api_binary" ./cmd/api
exec "$api_binary"
