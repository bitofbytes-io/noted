# Noted: POC System Design

Status: Implemented POC architecture with active post-POC extensions
Last updated: 2026-07-18

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

## Active post-POC OMR extension

The historical POC remains PDF/MusicXML upload-only. Active development after that boundary implements OCR as a separate derived-asset pipeline using Audiveris 5.10.2, homr 0.7.0, music21 10.3.0, and the same alphaTab 1.8.4 importer pinned by the web player. See [ADR 0002](../decisions/0002-audiveris-ocr-pipeline.md) for arbitration, benchmark, and release-acceptance details.

### Component boundary

Use a private `omr-worker` process rather than embedding Java, Python/ONNX, or alphaTab APIs into the Go request process:

```text
Angular UI
    |
    | request/status
    v
Go API ---- PostgreSQL recognition_jobs + quality report
    |
    | authenticated bounded PDF request
    v
OMR worker on bahamut NAS (AMD64) ---- isolated temporary storage
    |
    `---- MusicXML + report + optional private .omr artifact
```

- The Go API authenticates the learner, verifies access to the source asset, creates job state, and imports validated results.
- The Raspberry Pi Crystal Swarm runs the API/UI and job orchestration only. The CPU- and memory-heavy Audiveris, homr, music21, and alphaTab worker runs separately on the `bahamut` NAS through Synology Container Manager and is never scheduled as a Crystal Swarm service.
- The API owns the PostgreSQL claim/lease loop and sends one PDF to the internal worker over a bearer-authenticated private HTTP route. The worker has no public route, database credentials, OAuth/session secrets, NFS credentials, or authorization role.
- The worker accepts one request at a time. Inputs/outputs are capped at 25 MiB and 25 pages; upload and conversion deadlines are two and ten minutes; logs and archive expansion are bounded; the post-conversion job footprint is capped at 512 MiB. The container supplies the two-CPU, 4-GiB, and scratch-volume ceilings.
- Each job receives private HOME/XDG/cache/temp directories, bounded native-library thread counts, process-group cancellation, and cleanup on every terminal state. Stale job directories are removed on worker startup.
- Production runtime has no outbound network access. The image build pre-fetches engines, Python/Node dependencies, and model weights, then readiness checks exact Python/npm versions and the generated ONNX checksum manifest.
- The worker invokes Audiveris with fixed arguments (`-batch -transcribe -save -export -output ... -- input`) and homr with a fixed CPU command; no user-controlled value is shell-interpolated.
- Only validated plain MusicXML becomes a `score_asset`. Compressed MusicXML and `.omr` projects are treated as untrusted archives with entry/count/expanded-size/path checks. The `.omr` book remains a private job artifact exposed only through an authenticated owner download; logs and intermediates are never browser-addressable.

### Recognition pipeline

1. Render each authorized PDF page to PNG at controlled 300 DPI, validate the PNG signature, and assemble a grayscale multi-page TIFF for Audiveris. homr receives the same rendered pages individually.
2. Run Audiveris and homr sequentially to stay within the CPU/memory budget. A non-cancellation failure of one engine is recorded and the other may continue; both failing returns `conversion_failed`.
3. Parse each surviving output through music21. Attempt `ScoreCorrector` on duration-flagged measures, pad underfull non-pickup measures with rests, rebuild notation when possible, combine homr page outputs, and re-export normalized MusicXML with a bounded repair report.
4. Prefer Audiveris as the structural backbone when available, otherwise use homr. Align measures by Needleman-Wunsch scoring over measure hashes/numbers. Keep agreement as high confidence; replace an invalid backbone measure with an aligned valid homr measure; retain valid disagreement as medium confidence; mark invalid disagreement low/suspect.
5. In the worker, validate final XML structure/size and archive rules before loading the bytes headlessly with alphaTab 1.8.4. Require tracks, master bars with positive safe tick durations, equal bar counts across staves, bounded beat timing, and at least one timed beat. A failure is `unplayable_output`, and the API imports no derived asset.
6. Complete and validate the schema-v1 quality report and return score/report/optional `.omr` as bounded multipart artifacts. At the API trust boundary, validate MusicXML again, including playable notes, divisions, `backup`/`forward` cursor motion, and measure durations. `<backup>` and `<forward>` are supported MusicXML timing constructs; only invalid cursor/timing behavior is a recognition blocker.
7. Calculate checksums, persist opaque objects, and link the successful MusicXML to the source and job as `Unverified OCR`.
8. Surface corrected/suspect totals and medium/low measure confidence in work details and the score-player measure strip. Playback never upgrades OCR to trusted or corrected notation.

The implemented increment targets printed Common Western Music Notation in PDF form. Handwritten recognition, guaranteed accuracy, and an in-app notation editor remain out of scope.

### Production release gate

Implementation does not equal production acceptance. The committed synthetic-corpus before/after
result is recorded in the [OMR benchmark](../implementation/omr-benchmark.md). Promotion still
requires the gates in the [production-readiness record](../implementation/omr-production-readiness.md).
The rights-cleared representative run and dependency/model inventory are recorded; NAS-native
resource/cancellation evidence and final informed owner acceptance remain outstanding. Acceptance
must cover the exact Audiveris/homr AGPL packaging and network interaction, residual homr model
provenance limitations, RapidOCR terms, music21 BSD/corpus notices, and alphaTab MPL/package-asset
notices. Keeping the worker separate is an architectural and security boundary, not a conclusion
about license obligations.

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
- `SESSION_TTL` (defaults to `12h`)
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- `AUDIVERIS_COMMAND` for the optional local command runner
- `OMR_BASE_URL`
- `OMR_TOKEN` / `OMR_TOKEN_FILE`

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

The `omr-worker` is an implemented but not yet production-accepted private component. It must not be exposed through Traefik or receive database/OAuth/NFS credentials; production promotion follows ADR 0002's benchmark, resource, model-license, and owner-acceptance gates.
