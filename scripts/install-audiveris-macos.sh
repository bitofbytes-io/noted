#!/bin/sh
set -eu

version=5.10.2
tools_dir=.local/tools
app="$tools_dir/Audiveris.app"

if [ -x "$app/Contents/MacOS/Audiveris" ]; then
  exit 0
fi

mkdir -p "$tools_dir"
download=$(mktemp -d "${TMPDIR:-/tmp}/noted-audiveris.XXXXXX")
mount=$(mktemp -d "${TMPDIR:-/tmp}/noted-audiveris-mount.XXXXXX")
trap 'hdiutil detach "$mount" -quiet 2>/dev/null || true; rm -rf "$download" "$mount"' EXIT INT TERM

curl -fsSL -o "$download/audiveris.dmg" \
  "https://github.com/Audiveris/audiveris/releases/download/$version/Audiveris-$version-macosx-arm64.dmg"
printf 'Y\n' | hdiutil attach "$download/audiveris.dmg" -nobrowse -readonly -mountpoint "$mount" >/dev/null
cp -R "$mount/Audiveris.app" "$app"

"$app/Contents/MacOS/Audiveris" -version >/dev/null
