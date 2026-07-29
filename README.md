# Noted

Noted is a private digital sheet-music binder. Approved users keep separate PDF
score libraries, search by title or composer, and read them in a full-screen
iPad-friendly reader with keyboard/pedal page turns or adjustable auto-scroll.

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

Local development defaults to `AUTH_MODE=development` and resolves
`DEV_USER_EMAIL` to a seeded learner. Production requires `AUTH_MODE=google`,
`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`,
`AUTH_GOOGLE_REDIRECT_URL`, `AUTH_GOOGLE_ALLOWED_EMAILS`, and `FRONTEND_URL`.
Client credentials support the corresponding `_FILE` variables. Browser
sessions are opaque, database-backed, and default to a 12-hour lifetime.

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

Automated reader coverage checks PDF canvas rendering, mode controls, screen
wake-lock lifecycle, and the iPad-sized viewport. Final acceptance still
requires opening representative large scans on the physical 13-inch iPad in
Safari and confirming that:

- A short Auto-Lock interval does not sleep the display on a static page, during
  active auto-scroll, or while auto-scroll is paused.
- Backgrounding and returning to Safari restores the keep-awake behavior, and
  returning to the library restores normal Auto-Lock behavior.
- Low Power Mode or another wake-lock denial leaves the reader usable.
- The actual Bluetooth pedal emits a supported key (`PageDown`, `ArrowRight`,
  Space, or Enter) and continues to control the reader.

## API

- `GET/POST /api/pieces/`
- `GET/PATCH/DELETE /api/pieces/{id}/`
- `POST/GET/HEAD /api/pieces/{id}/pdf`
- `GET/HEAD /api/pieces/{id}/pdf/download`
- `GET/PUT /api/pieces/{id}/reader-state`
- `GET /api/health`
- `GET /api/session`
- `DELETE /api/session`
- `GET /api/auth/google`
- `GET /api/auth/google/callback`

PDF responses use `http.ServeContent`, including byte-range support required by
PDF.js on Safari. The `/pdf` route displays inline, while `/pdf/download` sends
the current file as an attachment using its safe original filename. The storage
implementation is behind `assets.Store` so a future NFS-backed production
deployment does not change handlers.
All piece, PDF, and reader-state routes resolve the authenticated user
server-side; another user's identifier is returned as not found.

## Deployment

Merges to `main` use GitHub Actions to verify the app, publish the ARM64 API and
UI images to the private registry, and trigger the Crystal deployment
repository through its SSH hook. This follows the same Tailscale, registry, and
deployment-ref flow as the other bitofbytes-io applications.

The API image reads PostgreSQL and Google credentials from the external
`noted_database_url`, `noted_google_client_id`, and
`noted_google_client_secret` secrets and stores PDFs under `/data/assets`,
which must be mounted from persistent storage. NAS PostgreSQL/NFS provisioning,
backups, Traefik configuration, and monitoring remain deployment-environment
work.
