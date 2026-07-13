# Noted POC implementation plan

Status: Executing on `codex/noted-poc`
Last updated: 2026-07-13

## Decisions and assumptions

- The repository documentation branch is the implementation base because `main` contains only the license.
- PostgreSQL 17 runs locally through Docker Compose on port 5434; migrations remain compatible with supported PostgreSQL releases.
- The timer is server-persisted so refresh and device sleep do not silently lose an active session.
- The frontend uses explicit adapters for PDF, notation/playback, and metronome resources.
- Development identity is resolved server-side and rejected whenever `APP_ENV` is not `development`.
- iPad verification means a portrait responsive browser viewport in this build; physical-device verification remains a named follow-up.

## Vertical build sequence

1. **Foundation** — configuration, PostgreSQL, migrations, health/session endpoints, Angular shell, Make targets. Covers POC-001–004 and POC-082–083.
2. **Catalog and repertoire** — seeded learner/work, Library/search/filter, work details, personal learner state and tags. Covers POC-010–025.
3. **Asset safety and reading** — storage interface, PDF/MusicXML validation, opaque keys, checksums, authorized streaming, PDF reader. Covers POC-030–043.
4. **Player spike and implementation** — compare libraries, isolate selected adapters, render measures, synthesize audio, tempo/range/loop controls, capability states. Covers POC-050–058.
5. **Practice and preferences** — audible metronome, durable one-at-a-time timer, manual/correct/delete flows, Monday-first summaries, settings. Covers POC-060–083.
6. **Hardening** — ownership/path/upload cleanup tests, frontend state tests, three-flow browser coverage, responsive pass, clean-checkout run, secret/artifact review.

## Migration sequence

- `000001_initial.up.sql`: identity, catalog, editions/assets, learner state/tags, practice sessions, indexes and constraints.
- Seed data is deliberately separate from migrations and is idempotently loaded by `make seed`.

## Verification mapping

- Go unit/integration tests cover configuration fail-closed behavior, storage path safety and cleanup, file validation, ownership scoping, timer conflict, practice validation, and Monday-first aggregation.
- Angular unit tests cover navigation, dashboard states, Library/work details, measure validation, capability/error states, and practice behavior.
- Playwright covers the seeded open/read/play flow, import flow, and practice-summary flow in desktop Chrome and a portrait iPad-sized WebKit viewport where available.
- Final verification runs formatting, vet/lint, all tests, production builds, runtime browser checks, and a clean-copy startup.

## Explicit non-goals

OMR, PDF conversion, annotations, lessons, sharing, offline support, MIDI/microphone assessment, production OAuth, NAS/NFS provisioning, Swarm, Traefik, and production deployment remain deferred exactly as specified by the authoritative POC requirements.
