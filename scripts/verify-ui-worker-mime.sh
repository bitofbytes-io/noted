#!/bin/sh
set -eu

image=${1:-noted-ui-mime-test:local}
container=""
scratch=$(mktemp -d)

cleanup() {
	if [ -n "$container" ]; then
		docker rm -f "$container" >/dev/null 2>&1 || true
	fi
	rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

# Exercise the actual image without a user override or privileged fallback.
# The only writable runtime location is /tmp; no capability is required.
[ "$(docker image inspect --format '{{.Config.User}}' "$image")" = nginx ] || { echo "UI image must default to USER nginx" >&2; exit 1; }
container=$(docker run -d --read-only --cap-drop=ALL --security-opt no-new-privileges:true \
	--tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 -p 127.0.0.1::8080 "$image")

header() {
	printf '%s\n' "$headers" | awk -v name="$1" 'tolower($1) == tolower(name) ":" { sub(/^[^:]*:[ \t]*/, ""); print }'
}

security_headers() {
	[ "$(header X-Content-Type-Options)" = "nosniff" ] || { echo "$port $path is missing X-Content-Type-Options" >&2; exit 1; }
	[ "$(header Referrer-Policy)" = "same-origin" ] || { echo "$port $path is missing Referrer-Policy" >&2; exit 1; }
}

asset_bytes() {
	# A SPA fallback can return 200 for a missing asset. Compare actual bytes
	# with this image, and fail on curl/docker errors before hashing output.
	expected_output=$(docker exec "$container" sha256sum "/usr/share/nginx/html$1")
	expected=$(printf '%s\n' "$expected_output" | awk '{print $1}')
	curl --max-time 10 -fsS "$base_url$path" -o "$scratch/body"
	actual=$(shasum -a 256 "$scratch/body" | awk '{print $1}')
	[ "$expected" = "$actual" ] || { echo "$port $path bytes did not match $1" >&2; exit 1; }
}

# The Angular build names the score processing worker after its content hash.
worker=$(docker exec "$container" sh -c 'cd /usr/share/nginx/html && ls worker-*.js 2>/dev/null' || true)
if [ -z "$worker" ] || [ "$(printf '%s\n' "$worker" | wc -l)" -ne 1 ]; then
	echo "Expected exactly one built processing worker, found: ${worker:-none}" >&2
	exit 1
fi

port=8080
addresses=$(docker port "$container" "$port/tcp")
address=$(printf '%s\n' "$addresses" | awk 'NR == 1 { print $1 }')
[ -n "$address" ] || { echo "UI container port $port was not published" >&2; exit 1; }
base_url="http://$address"

attempt=0
until curl --max-time 2 -fsS "$base_url/health" -o "$scratch/health"; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 30 ]; then
		echo "UI container port $port did not become healthy" >&2
		exit 1
	fi
	sleep 1
done
[ "$(cat "$scratch/health")" = '{"status":"ok"}' ] || { echo "$port /health returned unexpected JSON" >&2; exit 1; }

# Inspect the running master, not just the Dockerfile's USER declaration.
docker exec "$container" sh -ec '
	uid=$(id -u)
	test "$uid" -ne 0
	test "$(id -un)" = nginx
	test "$(cat /proc/1/comm)" = nginx
	awk -v uid="$uid" "
		/^Uid:/ { found=1; for (i=2; i<=5; i++) if (\$i != uid) bad=1 }
		END { exit (!found || bad) }
	" /proc/1/status
	awk "
		/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { found++; if (\$2 !~ /^0+$/) bad=1 }
		/^NoNewPrivs:/ { locked=(\$2 == 1) }
		END { exit (found != 5 || bad || !locked) }
	" /proc/1/status
	test ! -w /etc/nginx/nginx.conf
	test ! -w /etc/nginx/conf.d/default.conf
	test ! -w /usr/share/nginx/html
	test ! -w /usr/share/nginx/html/index.html
	test "$(stat -c %u /usr/share/nginx/html/index.html)" = 0
	test "$(cat /tmp/nginx.pid)" = 1
	for directory in client_temp proxy_temp fastcgi_temp uwsgi_temp scgi_temp; do
		test -w "/tmp/$directory"
		test "$(stat -c %u "/tmp/$directory")" = "$uid"
	done
	# Inspect both address families; inherited EXPOSE metadata is not a listener.
	awk "
		\$4 == \"0A\" && \$2 ~ /:0050$/ { bad=1 }
		END { exit bad }
	" /proc/net/tcp /proc/net/tcp6
' || { echo "UI runtime UID, capabilities, permissions or port checks failed" >&2; exit 1; }
[ "$(docker inspect --format '{{index .Config.Healthcheck.Test 0}}' "$container")" = CMD-SHELL ] || { echo "Unexpected UI healthcheck type" >&2; exit 1; }
healthcheck=$(docker inspect --format '{{index .Config.Healthcheck.Test 1}}' "$container")
case "$healthcheck" in
	*http://127.0.0.1:8080/health*) ;;
	*) echo "UI healthcheck must use port 8080" >&2; exit 1 ;;
esac
docker exec "$container" sh -ec "$healthcheck"
echo "Runtime: nginx UID and PID 1, zero capabilities, read-only assets, /tmp writes, healthcheck and no port 80 verified"

for path in /pdfjs/pdf.worker.min.mjs /pdfjs/pdf.min.mjs "/$worker" /intake/pdf-lib.min.js /intake/opencv.js; do
	curl --max-time 10 -fsSI "$base_url$path" -o "$scratch/headers"
	headers=$(tr -d '\r' < "$scratch/headers")
	case "$(header Content-Type)" in
		application/javascript* | text/javascript*) ;;
		*) echo "$port $path returned unexpected Content-Type: $(header Content-Type)" >&2; exit 1 ;;
	esac
	security_headers
	asset_bytes "$path"
	echo "$port $path: JavaScript MIME, security headers and asset checksum verified"
done

# Real deep links must receive the application shell.
for path in / /reader/runtime-check /prepare/runtime-check; do
	curl --max-time 10 -fsSI "$base_url$path" -o "$scratch/headers"
	headers=$(tr -d '\r' < "$scratch/headers")
	case "$(header Content-Type)" in
		text/html*) ;;
		*) echo "$port $path returned unexpected HTML Content-Type" >&2; exit 1 ;;
	esac
	security_headers
	asset_bytes /index.html
done

# A directory redirect must stay relative behind the public HTTPS proxy.
path=/pdfjs
curl --max-time 10 -fsSI -H 'Host: noted.example.test' -H 'X-Forwarded-Proto: https' "$base_url$path" -o "$scratch/headers"
headers=$(tr -d '\r' < "$scratch/headers")
[ "$(header Location)" = "/pdfjs/" ] || { echo "$port directory redirect exposed an unexpected location: $(header Location)" >&2; exit 1; }
security_headers

# A missing module must remain a 404, never the SPA shell.
path=/pdfjs/missing-runtime-check.mjs
status=$(curl --max-time 10 -sS -D "$scratch/headers" -o /dev/null -w '%{http_code}' "$base_url$path")
[ "$status" = 404 ] || { echo "$port missing module returned $status" >&2; exit 1; }
headers=$(tr -d '\r' < "$scratch/headers")
security_headers

# The signed template retains its exact bytes, download name and headers.
path=/send-to-noted.shortcut
curl --max-time 10 -fsSI "$base_url$path" -o "$scratch/headers"
headers=$(tr -d '\r' < "$scratch/headers")
[ "$(header Content-Type)" = "application/octet-stream" ] || { echo "$port $path returned unexpected Content-Type: $(header Content-Type)" >&2; exit 1; }
[ "$(header Content-Disposition)" = 'attachment; filename="Send to Noted.shortcut"' ] || { echo "$port $path returned unexpected Content-Disposition: $(header Content-Disposition)" >&2; exit 1; }
security_headers
asset_bytes "$path"
echo "$port: health, SPA routes, relative redirects, missing modules and signed Shortcut verified"
