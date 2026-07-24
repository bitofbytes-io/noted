# Noted

Noted is a single-user digital sheet-music binder. Add PDF scores, search by
title or composer, and read them in a full-screen iPad-friendly reader with
keyboard/pedal page turns or adjustable auto-scroll.

The current scope is defined by
[`docs/product/requirements.md`](docs/product/requirements.md). The previous
practice, MusicXML, playback, and OMR product is preserved only under
`docs/archive/`.

## Local setup

Prerequisites:

- Go 1.25 or newer
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

`make db-reset` is intentionally narrow: it removes only the Docker Compose
project named `noted`, including its dedicated `noted-postgres` volume, then
recreates and migrates it. It does not drop other databases or roles.

## Verify

```sh
make test            # Go and Angular unit tests
make lint            # gofmt, go vet, Prettier, and strict TypeScript
make build           # Go and production Angular builds
make test-migrations # isolated apply/rollback/reapply check (requires Docker)
make test-e2e        # mocked desktop Chromium and 1024x1366 WebKit flows
make docker-build    # build the production API and UI images
```

Install Playwright engines once when needed:

```sh
cd web
npx playwright install chromium webkit
```

Automated reader coverage checks PDF canvas rendering, mode controls, and the
iPad-sized viewport. Final acceptance still requires opening representative
large scans on the physical 13-inch iPad in Safari and confirming that the
actual Bluetooth pedal emits a supported key (`PageDown`, `ArrowRight`, Space,
or Enter).

## API

- `GET/POST /api/pieces/`
- `GET/PATCH/DELETE /api/pieces/{id}/`
- `POST/GET /api/pieces/{id}/pdf`
- `GET/PUT /api/pieces/{id}/reader-state`
- `GET /api/health`

PDF responses use `http.ServeContent`, including byte-range support required by
PDF.js on Safari. The storage implementation is behind `assets.Store` so a
future NFS-backed production deployment does not change handlers.

## Deployment

Merges to `main` use GitHub Actions to verify the app, publish the ARM64 API and
UI images to the private registry, and trigger the Crystal deployment
repository through its SSH hook. This follows the same Tailscale, registry, and
deployment-ref flow as the other bitofbytes-io applications.

The API image reads PostgreSQL credentials from the external
`noted_database_url` secret and stores PDFs under `/data/assets`, which must be
mounted from persistent storage. Authentication, NAS PostgreSQL and NFS
provisioning, backups, Traefik configuration, and monitoring remain deployment
environment work. The current unauthenticated single-user build must not be
exposed publicly.
