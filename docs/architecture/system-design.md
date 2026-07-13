# Noted: POC System Design

Status: Architecture input for implementation planning
Last updated: 2026-07-13

## Architecture goals

- Match the proven Anthology-style Angular/Go split.
- Keep the POC easy to run locally.
- Preserve production boundaries for authentication, PostgreSQL, asset storage, and container deployment.
- Isolate score-rendering/playback dependencies behind frontend services.
- Isolate local/NFS/S3 asset persistence behind a backend storage interface.

## Proposed repository structure

```text
noted/
├── cmd/api/                     Go API entrypoint
├── internal/
│   ├── assets/                  asset metadata, validation, storage interface
│   ├── auth/                    development and Google authentication modes
│   ├── catalog/                 works, movements, editions
│   ├── config/                  env and _FILE configuration
│   ├── database/                connection and transaction helpers
│   ├── health/                  liveness/readiness
│   ├── practice/                timers, sessions, aggregates
│   ├── repertoire/              learner-work status, favorites, tags
│   └── transport/http/          router, middleware, handlers
├── migrations/                  versioned PostgreSQL migrations
├── web/                         Angular workspace
│   └── src/app/
│       ├── core/                auth, API, config, errors
│       ├── layout/              shell and bottom navigation
│       ├── features/
│       │   ├── home/
│       │   ├── library/
│       │   ├── metronome/
│       │   ├── practice/
│       │   ├── score-reader/
│       │   ├── settings/
│       │   └── work-details/
│       └── shared/
├── Docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.ui
│   └── ui/
├── testdata/                    rights-safe test fixtures
├── docs/
├── .local/                      gitignored local assets/runtime data
├── compose.local.yml            local PostgreSQL and optional app services
├── Makefile
└── README.md
```

The implementation planner may adjust package boundaries, but should preserve separation among catalog metadata, learner state, practice, authentication, and binary asset storage.

## Runtime components

### Angular UI

Responsibilities:

- Render the accepted application shell and responsive layouts.
- Call the authenticated Go API.
- Display PDFs without granting direct filesystem access.
- Parse/render MusicXML through the selected notation adapter.
- Synthesize playback and control BPM/ranges/looping through the selected playback adapter.
- Run the standalone metronome using browser audio.
- Maintain transient practice-timer UX while the server remains authoritative for saved sessions.

### Go API

Responsibilities:

- Resolve the current authenticated/development user.
- Enforce per-user authorization.
- Own catalog, repertoire, asset metadata, and practice APIs.
- Validate and persist uploads through `AssetStore`.
- Stream authorized assets with safe response headers.
- Compute dashboard and work-level summaries.
- Expose liveness and readiness endpoints.

### PostgreSQL

The POC uses PostgreSQL locally so production does not require a datastore rewrite. Local development may run PostgreSQL through Docker Compose. Migrations are the only supported schema-management mechanism.

### Asset storage

Define a backend interface similar to:

```go
type AssetStore interface {
    Put(ctx context.Context, key string, src io.Reader) (StoredObject, error)
    Open(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error)
    Delete(ctx context.Context, key string) error
    Exists(ctx context.Context, key string) (bool, error)
}
```

Required implementations:

- `FilesystemStore` for the POC, rooted at `ASSET_ROOT`.
- `NFS FilesystemStore` in production, using the same interface and a mounted `/data/assets` root.

An S3 implementation is not required but must remain possible without changing HTTP or domain contracts.

## Local authentication mode

- `AUTH_MODE=development` resolves requests to a configured seeded user.
- It is accepted only when `APP_ENV=development`.
- It must fail closed if selected in production.
- Authorization code must still use the resolved user ID rather than bypassing ownership filters.
- `AUTH_MODE=google` becomes required before production deployment.

This is a convenience for the local POC, not an authentication bypass route.

## Upload pipeline

1. Authenticate/resolve user.
2. Enforce request and configured size limit.
3. Stream to a temporary file beneath the asset root; do not load large PDFs into memory.
4. Detect and validate supported file format.
5. Calculate checksum and size while streaming.
6. Create or validate work/edition association.
7. Move the temporary object atomically to an opaque final key.
8. Commit asset metadata in PostgreSQL.
9. Remove temporary files on failure.

If database commit fails after finalization, compensate by deleting the orphaned object or record it for reconciliation.

## Frontend score adapters

The implementation plan must include a spike that compares candidate libraries using the representative POC fixtures. The application should depend on internal abstractions, not library-specific APIs throughout components:

- `PdfScoreAdapter`: load, page, zoom/fit, dispose.
- `NotationAdapter`: load MusicXML, render, expose measures/layout.
- `PlaybackAdapter`: play, pause, stop, tempo, range, loop, current measure, dispose.
- `MetronomeService`: start, stop, BPM, accent pattern.

The spike decides actual dependencies only after testing iPad Safari, representative piano MusicXML, measure identity, audio unlock, and cleanup behavior.

## Configuration contract

Initial configuration categories:

- `APP_ENV`
- `PORT`
- `LOG_LEVEL`
- `DATABASE_URL` / `DATABASE_URL_FILE`
- `ASSET_ROOT`
- `MAX_UPLOAD_BYTES`
- `AUTH_MODE`
- `DEV_USER_EMAIL`
- `AUTH_GOOGLE_CLIENT_ID` / `_FILE`
- `AUTH_GOOGLE_CLIENT_SECRET` / `_FILE`
- `AUTH_GOOGLE_REDIRECT_URL`
- `AUTH_GOOGLE_ALLOWED_EMAILS`
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`

Secrets may be read through `_FILE` variants in production. Local values belong in an ignored local configuration file.

## Local operational contract

The eventual scaffold should provide these discoverable commands:

- `make setup`: install dependencies and prepare ignored local configuration/directories.
- `make db-up`: start local PostgreSQL.
- `make migrate`: apply migrations.
- `make seed`: load the development learner and rights-safe fixtures.
- `make api-run`: run the Go API.
- `make web-start`: run Angular with the local API proxy.
- `make local`: start the documented local development workflow.
- `make test`: run backend and frontend tests.
- `make lint`: run backend and frontend lint/format checks.
- `make build`: produce verified application builds.

Exact command implementation belongs to the implementation plan, but a clean checkout must not require undocumented manual steps.

## Security and reliability baseline

- Parameterized SQL and explicit transaction boundaries.
- Ownership filtering in repository/service APIs.
- Random opaque asset keys; no path traversal from filenames.
- File signature/type validation and upload size limits.
- Safe `Content-Disposition`, `Content-Type`, and cache headers.
- No public filesystem route.
- Same-site, secure, HTTP-only production sessions.
- Structured logging without score contents or credentials.
- API liveness independent of dependencies; readiness checks PostgreSQL and writable asset storage.
- Graceful shutdown for API and cleanup/disposal for browser audio/render resources.

## Production substitution map

| POC | Production |
|---|---|
| Local PostgreSQL container | PostgreSQL on Synology NAS |
| `.local/noted-assets` | Synology NFS mounted at `/data/assets` |
| Development seeded user | Google OAuth and allowed emails |
| Local Angular dev server | `noted-ui` Nginx container |
| Local Go process | `noted-api` Swarm service |
| Direct local ports | Traefik at `noted.bitofbytes.io` |
