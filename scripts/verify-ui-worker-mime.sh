#!/bin/sh
set -eu

image=${1:-noted-ui-mime-test:local}
container=""

cleanup() {
	if [ -n "$container" ]; then
		docker rm -f "$container" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT INT TERM

container=$(docker run -d -p 127.0.0.1::80 "$image")
address=$(docker port "$container" 80/tcp | awk 'NR == 1 { print $1 }')
base_url="http://$address"

attempt=0
until curl -fsS "$base_url/health" >/dev/null; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 30 ]; then
		echo "UI container did not become healthy" >&2
		exit 1
	fi
	sleep 1
done

for asset in /pdfjs/pdf.worker.min.mjs /pdfjs/pdf.min.mjs /intake/processing-worker.js /intake/pdf-lib.min.js /intake/opencv.js; do
  content_type=$(curl -fsSI "$base_url$asset" | awk 'tolower($1) == "content-type:" { gsub("\r", "", $2); print tolower($2) }')
  case "$content_type" in
    application/javascript* | text/javascript*) ;;
    *) echo "$asset returned unexpected Content-Type: ${content_type:-missing}" >&2; exit 1 ;;
  esac
  # A SPA fallback can return 200 for a missing asset. Compare served bytes to
  # the built asset inside this container, in addition to checking MIME.
  expected=$(docker exec "$container" sha256sum "/usr/share/nginx/html$asset" | awk '{print $1}')
  actual=$(curl -fsS "$base_url$asset" | shasum -a 256 | awk '{print $1}')
  [ "$expected" = "$actual" ] || { echo "$asset bytes did not match" >&2; exit 1; }
  echo "$asset: JavaScript MIME and asset checksum verified"
done

# The Send to Noted template downloads as a file named for Shortcuts, with the
# security headers the server block sets everywhere else.
shortcut=/send-to-noted.shortcut
headers=$(curl -fsSI "$base_url$shortcut" | tr -d '\r')
header() {
  printf '%s\n' "$headers" | awk -v name="$1" 'tolower($1) == tolower(name) ":" { sub(/^[^:]*:[ \t]*/, ""); print }'
}
[ "$(header Content-Type)" = "application/octet-stream" ] || { echo "$shortcut returned unexpected Content-Type: $(header Content-Type)" >&2; exit 1; }
[ "$(header Content-Disposition)" = 'attachment; filename="Send to Noted.shortcut"' ] || { echo "$shortcut returned unexpected Content-Disposition: $(header Content-Disposition)" >&2; exit 1; }
[ "$(header X-Content-Type-Options)" = "nosniff" ] || { echo "$shortcut is missing X-Content-Type-Options" >&2; exit 1; }
[ "$(header Referrer-Policy)" = "same-origin" ] || { echo "$shortcut is missing Referrer-Policy" >&2; exit 1; }
expected=$(docker exec "$container" sha256sum "/usr/share/nginx/html$shortcut" | awk '{print $1}')
actual=$(curl -fsS "$base_url$shortcut" | shasum -a 256 | awk '{print $1}')
[ "$expected" = "$actual" ] || { echo "$shortcut bytes did not match" >&2; exit 1; }
echo "$shortcut: Content-Type, Content-Disposition, security headers and checksum verified"
