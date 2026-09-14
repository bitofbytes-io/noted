#!/bin/sh
set -eu

preview_tmp=$(mktemp -d /tmp/noted-photo-preview.XXXXXX)
cleanup() {
	case "$preview_tmp" in
	/tmp/noted-photo-preview.*) find "$preview_tmp" -depth -delete ;;
	esac
}
trap cleanup EXIT INT TERM

npm install --prefix "$preview_tmp" --no-save --ignore-scripts playwright@1.61.1 >/dev/null
"$preview_tmp/node_modules/.bin/playwright" install chromium >/dev/null
cp scripts/verify-photo-preview.mjs "$preview_tmp/verify-photo-preview.mjs"
NOTED_REPOSITORY_ROOT="$(pwd)" node "$preview_tmp/verify-photo-preview.mjs"
