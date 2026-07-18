# Noted

Noted is a personal piano library and practice desk. It keeps works, editions, PDF/MusicXML assets, measure-aware synthesized playback, and explicit practice history together in an Angular, Go, and PostgreSQL application.

Local development uses one clearly identified learner. Every learner-owned query is still scoped by user ID, and the API refuses to run development authentication outside development/test configuration. Production uses Google OAuth, an explicit email allowlist, opaque database-backed sessions, external secret files, and the API/UI container workflow. Crystal Swarm, Traefik, NAS PostgreSQL/NFS, and NAS-worker operations are maintained in the companion `home_swarm` repository.

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

`make setup` creates the gitignored asset directories, copies `.env.example` to `.env` when needed, and installs pinned dependencies. `make local` starts PostgreSQL, applies migrations, inserts the rights-safe sample only on the first initialization, then runs the API and Angular development server together. Open <http://localhost:4200>. Stop the foreground command with Ctrl-C; PostgreSQL remains available so local data persists. Use `make db-down` when you want to stop it.

PDF-to-MusicXML conversion is an optional, heavyweight service. To enable it locally, install the pinned Audiveris worker once before starting the app:

```sh
make omr-build
AUDIVERIS_COMMAND=scripts/run-audiveris-docker.sh make local
```

On Apple-silicon Macs this installs the native release under ignored `.local/tools`; elsewhere it builds the isolated container. The normal `make local` path deliberately does not download or distribute Audiveris.

For separate terminals instead:

```sh
make db-up
make migrate
make seed
make revalidate-musicxml
make api-run
make web-start
```

The API is at <http://localhost:8080>; readiness is at <http://localhost:8080/api/ready>. The UI development server proxies `/api` to the API. Re-running `make seed` ensures the development learner exists; the sample is deliberately not recreated after it has been deleted. Run `make revalidate-musicxml` after introducing the playback-validation migration or whenever stored MusicXML needs to be checked again; the production image provides the same operation as `/app/noted-revalidate-musicxml`.

## Configuration and local data

Copy-safe defaults live in `.env.example`. Important values are:

- `DATABASE_URL`: local PostgreSQL connection string (Compose exposes port 5434).
- `ASSET_ROOT`: filesystem storage root, default `.local/noted-assets`.
- `MAX_UPLOAD_BYTES`: maximum accepted PDF or MusicXML size, default 25 MiB.
- `AUTH_MODE=development` and `DEV_USER_EMAIL`: local identity only.
- `AUTH_MODE=google`: production Google OAuth using `AUTH_GOOGLE_CLIENT_ID`,
  `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GOOGLE_REDIRECT_URL`, and
  `AUTH_GOOGLE_ALLOWED_EMAILS`; secret values also support the documented `_FILE` form.
- `SESSION_TTL`: opaque database-backed production session lifetime, default `12h`.
- `ALLOWED_ORIGINS`: allowed browser origins for the API.
- `AUDIVERIS_COMMAND`: optional conversion runner. It is empty by default so recognition is inactive in the standard local runtime. Set it to `scripts/run-audiveris-docker.sh` after `make omr-build` to enable local OCR.
- `OMR_BASE_URL`: private base URL for the production HTTP worker. Configure it together with `OMR_TOKEN` or `OMR_TOKEN_FILE`; it is mutually exclusive with `AUDIVERIS_COMMAND`.

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
make test-ui-container-mime # built-image worker MIME check for PDF.js and alphaTab
```

`make test-e2e` creates a dedicated temporary PostgreSQL database and asset root, then removes
both when Playwright exits. It never writes to the regular development learner data. Migration
apply/rollback/reapply coverage is included in `make test` and can be run alone with
`make test-migrations`. To repeat the browser suite visibly, run
`./scripts/with-test-database.sh headed-e2e ./scripts/run-playwright-headed.sh`.

Playwright installs its browser engines separately. If this machine has not run the E2E suite before, install the required WebKit engine once with `cd web && npx playwright install webkit`; desktop coverage uses the installed Chrome channel.

The [verification record](docs/implementation/verification.md) maps requirements to implementation/tests and records the exact final checks. The [browser score ADR](docs/decisions/0001-browser-score-rendering-and-playback.md) explains the PDF.js/alphaTab decision and browser constraints.

## Capabilities

- Home dashboard, Library search/filtering, work/edition/asset edit/replace/archive/delete management, Metronome, Practice, and Settings.
- Authenticated PDF/MusicXML upload, download, and streaming through opaque filesystem keys with content validation, checksums, provenance, and cleanup.
- Immersive PDF.js reading and alphaTab MusicXML playback with score zoom, a beat cursor, both-staff note highlighting, synthesized playback, BPM control, validated measure ranges, and looping.
- Explicit PDF-to-MusicXML conversion through a pinned Audiveris 5.10.2 worker. Results remain separate assets and pass through a rhythmic playback-quality gate; blocked output stays downloadable for correction.
- A Web Audio-clock metronome with one-to-four-beat meters, three synthesized click profiles, and a shared scheduler for audio, beat dots, accent, and pendulum.
- A durable one-at-a-time practice timer with confirmed discard recovery, complete manual entries/corrections, deletion, and Monday-first summaries.
- Responsive cobalt/white interface exercised at a 1024×1366 portrait viewport.
- Production Google OAuth, database-backed sessions, `_FILE` secrets, API/UI containers, and commit-tagged deployment workflows for the Crystal Swarm.

Built-in notation correction is not included. Annotations, lessons, sharing, offline support, and performance assessment are also deferred. Production infrastructure provisioning and operations live in `home_swarm`; promotion of the private Audiveris worker remains subject to the quality and AGPL acceptance gate in [ADR 0002](docs/decisions/0002-audiveris-ocr-pipeline.md).

## Design and architecture

- [Product requirements](docs/product/poc-requirements.md)
- [System design](docs/architecture/system-design.md)
- [Data model](docs/architecture/data-model.md)
- [API contract](docs/architecture/api-contract.md)
- [Visual direction](docs/design/visual-direction.md)
- [Implementation handoff](docs/implementation/handoff.md)
- [Audiveris OCR decision](docs/decisions/0002-audiveris-ocr-pipeline.md)
- [Production deployment architecture](docs/architecture/deployment.md)
