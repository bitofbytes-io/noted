# Noted

Noted is a private digital sheet-music binder. Approved users keep separate PDF
score libraries, search by title or composer, and read them in a full-screen
iPad-friendly reader with keyboard/pedal page turns or adjustable auto-scroll.

The current scope is defined by
[`docs/product/requirements.md`](docs/product/requirements.md). The previous
practice, MusicXML, playback, and OMR product docs survive only in git history.

## Local setup

Prerequisites:

- Go 1.27.2 or newer
- Node.js 22 or newer and npm 11
- Docker with Compose v2

From a clean checkout:

```sh
make setup
make local
```

Open <http://localhost:4200>. `make local` starts the dedicated local PostgreSQL
service, applies the binder migration, runs the API on port 8080, and runs the
Angular development server on port 4200. Stop the foreground command with
Ctrl-C. PostgreSQL and uploaded PDFs persist across restarts.

For separate terminals:

```sh
make db-up
make migrate
make api-run
make web-start
```

Configuration defaults are in `.env.example`. Uploaded PDFs use opaque storage
keys beneath `.local/noted-assets`; both `.env` and `.local/` are ignored.

Local services listen on loopback only: PostgreSQL is published on
`127.0.0.1:5434`, and outside production the API listens on `127.0.0.1:8080`.
To reach the API directly from a phone or another device, set
`LISTEN_HOST=0.0.0.0` (and point `ALLOWED_ORIGIN`/`FRONTEND_URL` at the address
the device uses) for that session only: development authentication treats every
request as the seeded learner. Production images listen on all interfaces inside
the container (`LISTEN_HOST=0.0.0.0`).

Local development defaults to `AUTH_MODE=development` and resolves
`DEV_USER_EMAIL` to a seeded learner. Production requires `AUTH_MODE=google`,
`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`,
`AUTH_GOOGLE_REDIRECT_URL`, `AUTH_GOOGLE_ALLOWED_EMAILS`, `ALLOWED_ORIGIN`, and
`FRONTEND_URL`. Both browser URLs must be explicit HTTPS, non-local URLs;
`ALLOWED_ORIGIN` contains only the frontend scheme and host.
Client credentials support the corresponding `_FILE` variables. Browser
sessions are opaque, database-backed, fixed at sign-in, and default to a
90-day lifetime. Set `SESSION_TTL=12h` to roll back to the former 12-hour
duration; a configured positive `SESSION_TTL` overrides the default.

Session IPs default to the immediate socket peer, including the deployment proxy
when running behind one. Forwarding headers are ignored unless
`TRUSTED_PROXY_CIDRS` explicitly lists the proxies permitted to provide
`X-Forwarded-For` (comma-separated IPv4/IPv6 CIDRs). Invalid entries and trust-all
prefixes (`0.0.0.0/0`, `::/0`, including mapped IPv4 equivalents) stop startup.
Configure only narrow ranges for proxies you control that overwrite or append
an accurate client address. Do not trust a whole overlay network or all clients.
For a trusted peer, Noted walks the complete header chain from right to left,
skipping trusted proxies and recording the first untrusted address. Missing,
malformed, or all-trusted chains fall back to the socket peer. Repeated header
lines are combined in order, and IPv4-mapped IPv6 addresses are normalized.
`X-Real-IP`, `True-Client-IP`, and `Forwarded` are never used. No proxy ranges
are enabled by default; this setting changes session metadata, not authorization.

Send to Noted needs no configuration. The UI serves the signed Shortcut
template, `web/public/send-to-noted.shortcut`, at `/send-to-noted.shortcut`;
it holds a placeholder token and asks for the user's own on import. See
[`docs/product/send-to-noted-shortcut.md`](docs/product/send-to-noted-shortcut.md).

The ownership migration intentionally refuses to run while pre-authentication
pieces remain. Delete those pieces through the current UI first so `AssetStore`
also removes their PDF objects; for disposable local data, `make db-reset`
provides the narrower clean-start alternative.

`make db-reset` is intentionally narrow: it removes only the Docker Compose
project named `noted`, including its dedicated `noted-postgres` volume, then
recreates and migrates it. It does not drop other databases or roles.

## Verify

```sh
make test            # Go and Angular unit tests
make lint            # API lint, Prettier, and strict TypeScript
make lint-api        # gofmt, go vet, and pinned golangci-lint (no Node.js required)
make build           # Go and production Angular builds
make test-migrations # isolated apply/rollback/reapply check (requires Docker)
make docker-build    # build the production API and UI images
```

`make lint-api` runs golangci-lint v2.15.0 through the Go module cache, so local
checks and CI use the same version without a separate installation. The first
run may download the tool. `.golangci.yml` enables staticcheck, errcheck
(including blank assignments), gosec, bodyclose, ineffassign, and unused for
production and test code. Intentional best-effort cleanup and verified security
false positives are explained at the affected lines; there are no blanket
path or rule exclusions.

There is no browser end-to-end suite. Final acceptance requires opening
representative large scans on the physical 13-inch iPad in Safari and confirming
that:

- A short Auto-Lock interval does not sleep the display on a static page, during
  active auto-scroll, or while auto-scroll is paused.
- Backgrounding and returning to Safari restores the keep-awake behavior, and
  returning to the library restores normal Auto-Lock behavior.
- Low Power Mode or another wake-lock denial leaves the reader usable.
- The actual Bluetooth pedal emits a supported key (`PageDown`, `ArrowRight`,
  Space, or Enter) and continues to control the reader.

## API

- `GET/POST /api/imports/`
- `GET/PATCH/DELETE /api/imports/{draftID}/`
- `POST /api/imports/{draftID}/sources`
- `GET/HEAD /api/imports/{draftID}/sources/{assetID}`
- `POST /api/imports/{draftID}/finalize`
- `GET/POST /api/pieces/` (`q`, `favorite=true`, `status=learning,playing,shelved|all`,
  `sort=title|composer|recent|added|fresh`; without `status` it lists Learning and
  Playing, or every status when `q` is set; without `sort` it lists by title. Each
  piece carries `lastPlayedAt`, its reader state's last save. `fields=summary`
  lists the same pieces without `notes`, `sourceUrl` or PDF file details, adding
  `searchText`, the folded title, composer, aliases and notes, with catalogue
  numbers and keys in one form such as `op28 no4`, `k545` or `c sharp minor`,
  that the library filters by)
- `GET /api/pieces/continue` (`{"piece": …}`: the most recently played piece with
  a PDF from the whole library, whatever its status, if played in the last 14
  days; otherwise `{"piece": null}`)
- `GET/PATCH/DELETE /api/pieces/{id}/`
- `GET/HEAD /api/pieces/{id}/pdf`
- `GET/HEAD /api/pieces/{id}/pdf/download`
- `GET/PUT /api/pieces/{id}/reader-state`
- `GET /api/health`
- `GET /api/ready`
- `GET/POST/DELETE /api/account/shortcut-token`
- `GET/PUT /api/account/preferences` (the remembered library filter and sort;
  a `PUT` changes only the fields it sends)
- `POST /api/shortcut/import` (shortcut bearer token only)
- `GET /api/session`
- `DELETE /api/session`
- `GET /api/auth/google`
- `GET /api/auth/google/callback`

PDF responses use `http.ServeContent`, including byte-range support required by
PDF.js on Safari. The `/pdf` route displays inline, while `/pdf/download` sends
the current file as an attachment using its safe stored filename (the piece title
for PDFs saved by Prepare). The storage implementation is behind `assets.Store`
so a future NFS-backed production deployment does not change handlers.
All piece, PDF, and reader-state routes resolve the authenticated user
server-side; another user's identifier is returned as not found.
`POST /api/shortcut/import` is the only route that takes a Send to Noted
bearer token. It accepts no session cookie, and no other route accepts the
token.

`/api/health` and `/api/ready` need no session. `/api/health` always returns
200 `{"status":"ok"}` while the process is up, and the image `HEALTHCHECK` uses
it. `/api/ready` pings the database and checks the asset store's `objects`
directory within 2 seconds. It returns 200
`{"assets":"ok","db":"ok","status":"ok"}`, or 503 with `"status":"degraded"`
and `"error"` for each failing dependency. Error details go only to the API log.
Point stack healthchecks and uptime monitors at `/api/ready`.

## Metrics

The API serves Prometheus metrics at `GET /metrics` on a separate internal
listener, never on the public API port, so public Traefik routers cannot expose
it (`/metrics` on the API port is a 404). Set the address with `METRICS_ADDR`
(optional). Like the API, it defaults to loopback outside production
(`127.0.0.1:9464`) and to all interfaces in production (`:9464`);
`METRICS_ADDR=off` disables the listener. A listener that cannot bind is logged
and the API keeps running. The image does not `EXPOSE` the port; Prometheus
scrapes it over the overlay network.

- `http_requests_total` and `http_request_duration_seconds` by `method`,
  `route` (the chi route pattern such as `/api/pieces/{pieceID}`; requests that
  match no route, including CORS preflights, are `unmatched`), and `status`.
  `/api/health` and `/api/ready` are not recorded.
- `pgxpool_*`: the PostgreSQL pool's acquired, idle, constructing, total, and
  maximum connections, plus acquire counts, acquire time, and waits for an
  empty pool.
- `noted_uploads_total{kind,result}`: `kind` is `source` (a Prepare page or
  scan), `finalize` (the PDF that creates a piece), or `shortcut` (Send to
  Noted); `result` is `success`, `rejected` (4xx), or `error` (5xx).
- `noted_oauth_failures_total{provider="google",reason}`: Google callbacks that
  failed before a user was identified (`provider_error`, `invalid_state`,
  `missing_code`, `exchange`, `internal`).
- `noted_login_failures_total{reason}`: identified users Noted rejected
  (`not_allowed`, `identity_conflict`) and rejected shortcut tokens
  (`shortcut_token`).
- `noted_jobs_total{job="import_cleanup",result}`: each run of the draft and
  orphaned-file cleanup.
- Go runtime (`go_*`) and process (`process_*`) metrics.

## Deployment

Merges to `main` use GitHub Actions to verify the app, publish the ARM64 API and
UI images to the private registry, and trigger the Crystal deployment
repository through its SSH hook. This follows the same Tailscale, registry, and
deployment-ref flow as the other bitofbytes-io applications. The push passes
each image's digest as an `image-digest` push option, so the hook deploys
exactly the images that run built.

The UI image retains `nginx:1.29-alpine` and runs Nginx directly as the `nginx`
user, including its master process. It listens only on container port 8080;
the image healthcheck uses `http://127.0.0.1:8080/health`. Nginx configuration
and static assets are read-only, and PID and temporary files live under `/tmp`.
The base image's configuration-generating entrypoint is disabled.
For a local image check, publish `127.0.0.1:4200:8080` and open
`http://localhost:4200`. Directory redirects remain relative.
Docker inherits the base image's `EXPOSE 80` metadata, but nothing listens on
port 80; deployment routing and healthchecks must use 8080.
`make test-ui-container-mime` builds and runs the actual UI image with all
capabilities dropped, a read-only root filesystem, and writable `/tmp`. It
checks the runtime UID, PID 1, capabilities, absence of a port-80 listener,
health, routes, asset bytes, MIME, and security headers.
The preceding bridge release served both ports while deployment healthchecks
and routing moved to 8080. If an image rollback is needed, keep routing and
healthchecks on 8080 while returning to that bridge image.

The API image reads PostgreSQL and Google credentials from the external
`noted_database_url`, `noted_google_client_id`, and
`noted_google_client_secret` secrets and stores PDFs under `/data/assets`,
which must be mounted from persistent storage. NAS PostgreSQL/NFS provisioning,
backups, Traefik configuration, and monitoring remain deployment-environment
work.

## Dependency updates (Renovate)

The Mend Renovate GitHub app, installed for the organization, reads
`renovate.json` and opens update PRs on Thursdays. All non-major updates (Go
modules, npm packages, Dockerfile base images) land in one "all non-major
dependencies" PR, GitHub Actions updates land in one "GitHub Actions" PR, and
each major update gets its own PR. Renovate pins Dockerfile base images by
digest. The repository does not use Dependabot, and no secrets or environment
variables are needed.

Validate config changes with
`npx --yes --package renovate -- renovate-config-validator`.
