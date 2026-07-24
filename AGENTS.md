# Repository Guidance

## Product

Noted is a single-user digital sheet-music binder. Its v1 job is to let a pianist
upload PDF scores, find them quickly, and read them on a 13-inch iPad without
touching the screen mid-piece.

Read these before changing scope or behavior:

1. `docs/product/requirements.md`
2. `docs/product/piece-binder-rebuild-plan.md`
3. `docs/design/visual-direction.md`
4. `docs/design/design-tokens.md`

The material under `docs/archive/` describes the superseded practice and
MusicXML product. It is historical context only.

## v1 boundaries

- Angular frontend and Go API are separate applications in one repository.
- PostgreSQL is required from the start.
- PDF binaries use the Go `AssetStore` interface and the local filesystem
  implementation under `.local/noted-assets`.
- A piece has exactly one PDF in v1.
- The app is single-user and has no authentication in v1.
- Library search covers title and composer; favorites are a filter.
- The reader has page and auto-scroll modes and persists per-piece state.
- Practice, metronome, lessons, OMR, MusicXML, playback, annotations, IMSLP
  automation, photo stitching, sharing, and offline mode are deferred.

## Safety

- Never commit uploaded scores, credentials, database URLs, browser state, or
  local runtime data.
- Never use a user filename as a filesystem path. Storage keys are opaque.
- Keep rights-safe fixtures under `testdata/` and document their provenance.
- A local reset may touch only the `noted` database or its dedicated Compose
  volume. Never drop other databases or roles.
- Keep future NFS storage behind `AssetStore`; do not expose local paths in
  handlers or database records.
- Production authentication and deployment remain explicit follow-up work.

## Verification

Run `make test`, `make lint`, and `make build` for code changes. Reader changes
also require `make test-e2e`. Physical iPad Safari and Bluetooth pedal checks
must be recorded separately because automated tests cannot replace them.
