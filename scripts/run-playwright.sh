#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(dirname "$script_dir")
cd "$repo_root"

if [ -z "${TEST_DATABASE_NAME:-}" ]; then
	exec ./scripts/with-test-database.sh e2e ./scripts/run-playwright.sh "$@"
fi

cd web
exec npx playwright test "$@"
