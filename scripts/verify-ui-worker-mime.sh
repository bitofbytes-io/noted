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
