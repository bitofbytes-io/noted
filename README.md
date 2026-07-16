# Noted

Noted is a locally runnable proof of concept for a personal piano library and practice desk. It keeps works, editions, PDF/MusicXML assets, measure-aware synthesized playback, and explicit practice history together in an Angular, Go, and PostgreSQL application.

The POC uses one clearly identified development learner. Every learner-owned query is still scoped by user ID, and the API refuses to run development authentication outside development/test configuration. Production OAuth and deployment are intentionally not implemented.

## Run locally

Prerequisites:

- Go 1.25 or newer
- Node.js 22 and npm 10
- Docker with Compose v2
- Current desktop Chrome for the real-browser playback check

From a clean checkout:

```sh
make setup
make local
```

`make setup` creates the gitignored asset directories, copies `.env.example` to `.env` when needed, and installs pinned dependencies. `make local` starts PostgreSQL, applies migrations, inserts the rights-safe sample only on the first initialization, builds the pinned Audiveris worker image, then runs the API and Angular development server together. Open <http://localhost:4200>. Stop the foreground command with Ctrl-C; PostgreSQL remains available so local data persists. Use `make db-down` when you want to stop it.

For separate terminals instead:

```sh
make db-up
make migrate
make seed
make api-run
make web-start
```

The API is at <http://localhost:8080>; readiness is at <http://localhost:8080/api/ready>. The UI development server proxies `/api` to the API. Re-running `make seed` ensures the development learner exists; the sample is deliberately not recreated after it has been deleted.

## Configuration and local data

Copy-safe defaults live in `.env.example`. Important values are:

- `DATABASE_URL`: local PostgreSQL connection string (Compose exposes port 5434).
- `ASSET_ROOT`: filesystem storage root, default `.local/noted-assets`.
- `MAX_UPLOAD_BYTES`: maximum accepted PDF or MusicXML size, default 25 MiB.
- `AUTH_MODE=development` and `DEV_USER_EMAIL`: local identity only.
- `ALLOWED_ORIGINS`: allowed browser origins for the API.
- `AUDIVERIS_COMMAND`: conversion runner, default `scripts/run-audiveris-docker.sh`. `make omr-build` installs the native Apple-silicon release under ignored `.local/tools` on Apple-silicon Macs and builds the isolated container elsewhere.

Local catalog data, practice history, asset metadata, and recognition jobs live in the persistent
PostgreSQL Docker volume. Uploaded and generated score binaries live under `.local/noted-assets`.
Neither is in memory. Backups must include a PostgreSQL dump and the asset directory together. A
full local reset requires removing both the Compose volume and `.local/noted-assets` while the app
is stopped.

`.env`, PostgreSQL volume data, browser state, generated output, and `.local/` assets are ignored. The committed PDF and MusicXML under `testdata/fixtures/` are original project fixtures dedicated to CC0-1.0; see [testdata/README.md](testdata/README.md).

## Verify

```sh
make test       # PostgreSQL-backed Go tests plus Angular unit tests
make lint       # gofmt, go vet, Prettier check, and TypeScript check
make build      # Go and production Angular builds
make test-e2e   # isolated core flows in desktop Chrome and iPad-sized WebKit
```

`make test-e2e` creates a dedicated temporary PostgreSQL database and asset root, then removes
both when Playwright exits. It never writes to the regular development learner data. Migration
apply/rollback/reapply coverage is included in `make test` and can be run alone with
`make test-migrations`. To repeat the browser suite visibly, run
`./scripts/with-test-database.sh headed-e2e ./scripts/run-playwright-headed.sh`.

Playwright installs its browser engines separately. If this machine has not run the E2E suite before, install the required WebKit engine once with `cd web && npx playwright install webkit`; desktop coverage uses the installed Chrome channel.

The [verification record](docs/implementation/verification.md) maps requirements to implementation/tests and records the exact final checks. The [browser score ADR](docs/decisions/0001-browser-score-rendering-and-playback.md) explains the PDF.js/alphaTab decision and known Safari constraints.

## POC capabilities

- Home dashboard, Library search/filtering, work/edition/asset edit/replace/archive/delete management, Metronome, Practice, and Settings.
- Authenticated PDF/MusicXML upload and streaming through opaque filesystem keys with content validation, checksums, provenance, and cleanup.
- Immersive PDF.js reading and alphaTab MusicXML playback with score zoom, a beat cursor, both-staff note highlighting, synthesized playback, BPM control, validated measure ranges, and looping.
- Explicit PDF-to-MusicXML conversion through a pinned Audiveris 5.10.2 worker. Results are separate assets labeled `Unverified OCR`; conversion never changes or removes the source PDF.
- A Web Audio-clock metronome whose audible beat, beat dots, accent pattern, and pendulum share one scheduler.
- A durable one-at-a-time practice timer with confirmed discard recovery, complete manual entries/corrections, deletion, and Monday-first summaries.
- Responsive cobalt/white interface exercised at a 1024×1366 portrait viewport.

Built-in notation correction remains later work. Annotations, lessons, sharing, offline support, performance assessment, production OAuth, NAS/NFS provisioning, and deployment also remain deferred.

## Design and architecture

- [Authoritative POC requirements](docs/product/poc-requirements.md)
- [System design](docs/architecture/system-design.md)
- [Data model](docs/architecture/data-model.md)
- [API contract](docs/architecture/api-contract.md)
- [Visual direction](docs/design/visual-direction.md)
- [Implementation handoff](docs/implementation/handoff.md)
- [Audiveris OCR decision](docs/decisions/0002-audiveris-ocr-pipeline.md)
- [Deployment architecture (future)](docs/architecture/deployment.md)
