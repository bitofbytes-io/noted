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

docker build -f Docker/Dockerfile.ui -t "$image" .
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

for path in /alphaTab.worker.mjs /alphaTab.worklet.mjs /alphaTab.core.mjs /pdfjs/pdf.worker.min.mjs; do
	content_type=$(curl -fsSI "$base_url$path" | awk 'tolower($1) == "content-type:" { gsub("\r", "", $2); print tolower($2) }')
	case "$content_type" in
		application/javascript* | text/javascript*) ;;
		*)
			echo "$path returned unexpected Content-Type: ${content_type:-missing}" >&2
			exit 1
			;;
	esac
done

echo "alphaTab and PDF.js module workers use a JavaScript MIME type"
