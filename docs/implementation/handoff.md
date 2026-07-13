# Noted: Implementation Planning Handoff

Status: Ready for an implementation-planning pass
Last updated: 2026-07-13

## Handoff objective

Use this documentation set to create a sequenced implementation plan and concrete goals for a locally runnable Noted POC. Do not expand the POC to include deferred production integrations or later product phases unless a prerequisite genuinely requires it.

Repository-wide instructions for future Codex sessions are in the root `AGENTS.md`.

## Read in this order

1. [POC requirements](../product/poc-requirements.md) — authoritative POC scope and acceptance.
2. [System design](../architecture/system-design.md) — intended application boundaries and local/production substitutions.
3. [Data model](../architecture/data-model.md) — logical entities and ownership.
4. [API contract](../architecture/api-contract.md) — initial HTTP surface and contract tests.
5. [Visual direction](../design/visual-direction.md) — accepted visual baseline and interaction character.
6. [Deployment architecture](../architecture/deployment.md) — production work recorded for later.
7. [Roadmap](../product/roadmap.md) — post-POC sequence.
8. [Discovery brief](../product/discovery-brief.md) — historical rationale, not authoritative POC scope.

## Resolved decisions

- Working name: Noted.
- One repository with separate Angular UI and Go API applications.
- PostgreSQL from the beginning.
- POC binary assets on a configurable local filesystem.
- Production binary assets on a dedicated Synology NFS share.
- Work is the primary learner-facing identity; editions/assets remain distinct.
- MusicXML is the initial structured playback input; PDF remains the faithful visual score.
- No automatic PDF-to-MusicXML conversion in the POC.
- Explicit practice start; playback does not imply tracked practice.
- Monday-first weekly summaries.
- Primary navigation: Home, Library, Metronome, Practice, Settings.
- Store/play first, tracking second, annotation third, learning fourth.
- POC can use a development learner; Google OAuth is mandatory before deployment.
- Accepted version-one palette/layout is recorded in the visual-direction document.

## Decisions the implementation planner should make

The planner should research, prototype, and recommend:

1. Angular notation/PDF/playback libraries based on representative piano MusicXML and iPad Safari tests.
2. Whether playback synthesis is handled by one integrated notation library or a notation-to-MIDI/audio pipeline.
3. Whether the earliest practice timer persists server-side while running or saves only when stopped.
4. Exact Go HTTP/router, migration, query, and testing libraries, preferably aligned with Anthology conventions where appropriate.
5. Exact local Docker Compose/PostgreSQL workflow.
6. Initial database migration boundaries and seed-fixture strategy.
7. How the UI proxy and runtime API configuration mirror Anthology without copying unrelated features.

## Suggested goal sequence

### Goal 1: Repository and local foundation

- Scaffold Go API, Angular UI, migrations, local PostgreSQL, ignored local asset root, configuration, health endpoints, tests, lint, and Make targets.

### Goal 2: Identity and catalog skeleton

- Add development user resolution, users/composers/works/editions schema, seeded work, Library, and work-details read flow.

### Goal 3: Asset upload and PDF reading

- Implement filesystem storage adapter, secure upload/streaming, PDF metadata, PDF reader, and path-safety tests.

### Goal 4: MusicXML technical spike

- Evaluate rendering/playback candidates on representative fixtures and target iPad; record the decision and risks before broad UI integration.

### Goal 5: Structured score player

- Render notation, show measure identities, play/pause, set BPM, edit `Measures #-#`, and loop the chosen range.

### Goal 6: Practice and dashboard slice

- Explicit timer/manual entry, Monday-first aggregation, Continue Practicing, recent imports, and work statistics.

### Goal 7: POC hardening

- Responsive iPad pass, error/capability states, end-to-end flows, clean-checkout verification, fixture/license review, and POC demonstration notes.

### Goal 8: Production-readiness plan only

- Produce—not execute—the follow-up plan for Google OAuth, NAS PostgreSQL, NFS, containers, registry, Swarm, Traefik, backups, monitoring, and deployment.

## Planning constraints

- Each goal should end in a demonstrable vertical result, not only infrastructure.
- Schedule the MusicXML spike before committing the full player architecture.
- Do not build OMR, annotations, lessons, ISBN ingestion, IMSLP automation, or sharing in the POC.
- Keep local filesystem behavior behind `AssetStore`; do not scatter paths through handlers.
- Keep development authentication impossible in production configuration.
- Use rights-safe fixtures and record their source/license.
- Validate on the real iPad before declaring score rendering/playback complete.

## Definition of planning complete

The implementation plan is ready when it contains:

- Ordered goals and tasks with dependencies.
- Acceptance criteria mapped back to POC requirement IDs.
- Named technical spikes and decision records.
- Database migration sequence.
- API/UI test strategy.
- Local setup and clean-checkout verification steps.
- Risks, fallbacks, and explicit non-goals.
- A final POC demonstration checklist covering all three core flows.
