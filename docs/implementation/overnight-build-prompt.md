# Noted: Overnight Codex Build Instruction

## Goal

Build, verify, and publish a locally runnable Noted proof of concept from the authoritative repository documents, completing the three core POC flows on a review-ready branch without expanding into deferred features or production deployment.

## Prompt

Work autonomously until the Noted POC is genuinely complete and verified. Do not stop after producing a plan. Implement the application, test it, document it, commit the work, push a branch, and open a review-ready pull request.

### Workspace and repository

- Use `/Users/daniel/Documents/noted` as the workspace. It contains the authoritative product and architecture documents.
- The GitHub repository is `bitofbytes-io/noted` at `https://github.com/bitofbytes-io/noted`.
- The remote repository currently begins with only `LICENSE`. Preserve all existing local documentation and visual assets.
- Safely connect this workspace to the remote `main` branch without deleting or overwriting local files.
- Create and work on a branch named `codex/noted-poc` or a close collision-free variant. Do not push implementation commits directly to `main`.
- Commit in coherent checkpoints. At completion, push the branch and open a non-draft, review-ready pull request. Request `clawford-bot` as reviewer if repository permissions allow it.

### Read before implementing

Read `/Users/daniel/Documents/noted/AGENTS.md` completely and follow it. Then read the linked documents in this order:

1. `docs/product/poc-requirements.md`
2. `docs/architecture/system-design.md`
3. `docs/architecture/data-model.md`
4. `docs/architecture/api-contract.md`
5. `docs/implementation/handoff.md`
6. `docs/design/visual-direction.md`
7. `docs/architecture/deployment.md`

Treat `poc-requirements.md` as authoritative for POC scope. Discovery and long-term requirements provide context but must not expand the POC.

You may inspect `/Users/daniel/projects/anthology` and `/Users/daniel/projects/home_swarm` for established Angular, Go, PostgreSQL, Docker, runtime configuration, testing, and repository conventions. Reuse patterns deliberately; do not copy unrelated Anthology features or modify those repositories.

### Required outcome

Build one repository containing:

- An Angular frontend.
- A Go backend API.
- PostgreSQL migrations and a local PostgreSQL development workflow.
- Local binary asset storage under a configurable, gitignored `.local/noted-assets` root, accessed only through a Go storage interface that can later point at the Synology NFS mount.
- Rights-safe seeded PDF and MusicXML fixtures with documented source/license.
- Development-user authentication mode that is allowed only in development, scopes all learner-owned data by user ID, and fails closed in production configuration.

### Required POC functionality

Implement the POC requirement IDs and three core flows defined in `poc-requirements.md`, including:

- Home, Library, Metronome, Practice, and Settings navigation.
- Accepted light, cobalt-blue, black, and white visual direction.
- Dashboard with Continue Practicing, recently imported assets, dashboard/library search behavior, and Monday-first weekly metrics.
- Library search and filters for status, favorite, and personal tags.
- Work details with composer, movements, editions, PDF/MusicXML assets, provenance, learner status, favorite, tags, and practice summary.
- Secure PDF and MusicXML upload to local asset storage with opaque keys, checksums, metadata, type/size validation, cleanup on failure, and authenticated streaming through the API.
- iPad-friendly PDF score viewing.
- MusicXML notation rendering with visible/reliable measure identities.
- Structured playback with play, pause, restart, adjustable BPM, `Measures #-#` editing, validation, and looping.
- Clear PDF-only/no-playback capability state.
- Standalone audible metronome with BPM adjustment.
- Explicit Start Practice behavior, timed and manual practice entries, optional work/passage/BPM/notes fields, editing/deletion, and dashboard/work-stat updates.
- Settings with Monday as the default week start and basic metronome preference.

### Required technical spike

Before committing the complete player architecture, run and document a focused comparison of viable open-source browser libraries for:

- PDF display.
- MusicXML notation rendering.
- Synthesized playback.
- Stable measure identity and numeric range looping.
- Current desktop Chrome behavior.
- Mobile Safari/iPad constraints, including audio unlock and resource cleanup.

Use representative piano MusicXML fixtures. Record the selected approach, rejected alternatives, known limitations, and fallback in an architecture decision document. Then implement the best verified approach behind the frontend adapter boundaries described in `system-design.md`.

If the ideal library combination fails, do not abandon the POC. Choose the smallest working alternative that provides real notation rendering and real audible playback, document the limitation, and keep library-specific code isolated. Do not fake playback or claim unverified behavior.

### Local developer experience

Provide and verify discoverable commands equivalent to:

- `make setup`
- `make db-up`
- `make migrate`
- `make seed`
- `make api-run`
- `make web-start`
- `make local`
- `make test`
- `make lint`
- `make build`

A clean checkout must be runnable from documentation without hidden manual steps. Supply safe example configuration files; never commit credentials, database passwords, OAuth secrets, browser sessions, or uploaded personal scores.

### Verification requirements

- Map implementation and tests back to POC requirement IDs.
- Add backend tests for validation, ownership scoping, practice aggregation, path safety, upload cleanup, and asset authorization.
- Add frontend tests for navigation, dashboard states, Library/work details, measure-range validation, practice flow, and capability/error states.
- Add integration or end-to-end coverage for the three core POC flows.
- Run formatting, lint, backend tests, frontend tests, integration/end-to-end tests, and production builds.
- Start the application and verify the primary flows in a real browser. Capture screenshots of the dashboard, work details, PDF reader, score player, and practice summary for the pull request.
- Use a portrait iPad-sized responsive viewport during browser verification. Do not claim physical-iPad verification unless it was actually performed; record real-device verification as a follow-up when unavailable.
- Perform a clean-checkout or equivalent clean-environment startup verification before declaring completion.
- Review the final diff for accidentally committed runtime data, secrets, personal score files, or generated dependency/build output.

### Scope and safety constraints

Do not implement these deferred features:

- IMSLP automation.
- Optical music recognition or PDF-to-MusicXML conversion.
- Apple Pencil annotations.
- Lessons, assignments, or Learn-mode curriculum.
- Physical-book/ISBN ingestion.
- Household sharing UI.
- Offline support.
- MIDI keyboard input, microphone listening, or performance grading.
- Crystal Docker Swarm, NAS PostgreSQL, Synology NFS, Traefik, production OAuth, production backups, or deployment changes.

Keep those production items documented for later. Do not modify `home_swarm`, Anthology, the NAS, Crystal, DNS, OAuth configuration, or any deployed service.

### Autonomous-working instructions

- Begin by writing a concise implementation plan, then execute it completely.
- Make reasonable in-scope decisions without waiting for clarification. Record material decisions and assumptions in the repository.
- When blocked by one dependency, pursue a viable fallback and continue other independent work.
- Keep progress visible through plan updates and coherent commits.
- Preserve existing documentation unless implementation evidence requires a correction; document any correction explicitly.
- Do not weaken tests, disable security checks, add production auth bypasses, or substitute mock UI for required working behavior merely to report completion.
- Continue until the completion criteria are met or a genuine external blocker remains after safe alternatives have been exhausted.

### Completion criteria

The task is complete only when:

1. All required POC flows work locally.
2. Tests, lint, and builds pass.
3. Local setup is reproducible from a clean checkout.
4. The MusicXML/player decision and limitations are documented.
5. Browser verification and screenshots are complete.
6. The branch is committed and pushed.
7. A review-ready pull request summarizes functionality, architecture decisions, verification commands/results, screenshots, known limitations, and deferred production work.

If an external blocker prevents any criterion, complete everything else, preserve working commits, and report the exact blocker with evidence and the smallest next action required.
