# Repository Guidance

## Current repository purpose

This repository is in product-definition and implementation-planning mode. Do not begin broad implementation unless the user explicitly asks to scaffold or build it.

## Authoritative planning sources

Read these before creating an implementation plan or goals:

1. `docs/product/poc-requirements.md`
2. `docs/architecture/system-design.md`
3. `docs/architecture/data-model.md`
4. `docs/architecture/api-contract.md`
5. `docs/implementation/handoff.md`
6. `docs/design/visual-direction.md`
7. `docs/design/design-tokens.md`

Use `docs/product/discovery-brief.md` for rationale and future ideas, not as POC scope. Use `docs/product/requirements-v0.md` as longer-term requirements. When they differ, the POC requirements control POC planning.

## POC boundaries

- Angular frontend and Go backend in one repository as separate applications.
- PostgreSQL from the start.
- Local filesystem asset storage behind a Go interface for the POC.
- Google OAuth, NAS PostgreSQL, NFS, Docker Swarm, Traefik, and production backups are later production-readiness work.
- Do not include OMR, annotations, lessons, IMSLP automation, physical-book ingestion, sharing, offline use, or MIDI/microphone assessment in the POC.
- Run a MusicXML rendering/playback technical spike before committing the full player implementation.

## Product invariants

- Work is the learner-facing identity; editions and score assets remain distinct.
- Learner status, favorites, tags, and practice history are user-specific.
- PDF is a visual score asset; rich playback requires a structured score such as MusicXML.
- Playback does not automatically record practice.
- Practice summaries begin on Monday.
- Primary navigation is Home, Library, Metronome, Practice, Settings.
- The selected visual baseline is `docs/design/concepts/noted-v2-title-page-baseline.png` ("Title Page": ivory background, ink typography, forest-green accent, no dashboard sheet-music preview); tokens are specified in `docs/design/design-tokens.md`.

## Planning expectations

An implementation plan should:

- Sequence demonstrable vertical goals.
- Map acceptance criteria to POC requirement IDs.
- Identify spikes, dependencies, risks, and fallbacks.
- Include schema migrations, API/UI tests, and clean-checkout validation.
- Preserve the filesystem/NFS storage abstraction and production-safe authentication boundary.
- Keep deferred production setup visible without making it a POC blocker.

## File and secret safety

- Never commit uploaded scores, credentials, OAuth secrets, database URLs, browser session state, or local runtime data.
- Use `.local/` for ignored POC asset storage.
- Use rights-safe test fixtures under `testdata/` and document their provenance/license.
- Production secrets must use external Swarm secrets and `_FILE` configuration.
