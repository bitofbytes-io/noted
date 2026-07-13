# Noted: First-Version Stand-Up Plan

Status: Production-oriented follow-up; local POC scope is defined in `poc-requirements.md`
Last updated: 2026-07-13

## Objective

Stand up a private, deployable web application that lets two learners sign in separately, maintain personal repertoire, upload and view scores, play structured scores, use a metronome, and record basic practice activity.

This plan deliberately avoids requiring automatic PDF-to-notation conversion for the first usable build.

## Recommended first-version boundary

### Included

- Separate Google-authenticated accounts.
- Home dashboard following the selected visual direction.
- Personal library with search and filters.
- Musical works with multiple editions and score assets.
- PDF upload, storage, and iPad-friendly viewing.
- MusicXML upload/import for structured playback.
- Structured-score rendering with measure numbers.
- Play, pause, BPM adjustment, measure-range playback, and looping.
- Standalone metronome with basic sound/configuration preferences.
- Per-user status, favorites, and tags.
- Explicit Start Practice timer plus manual practice entry.
- Monday-first weekly practice summary.
- Work-details screen with editions, source/provenance, and learner statistics.
- Responsive desktop support and primary optimization for a 13-inch portrait iPad.

### Excluded from the first stand-up

- Automatic optical music recognition from arbitrary PDFs.
- A built-in notation correction editor.
- Guaranteed automated IMSLP download/import.
- ISBN table-of-contents recognition.
- Apple Pencil annotation.
- Lessons and assignments.
- Learn mode content.
- Offline support.
- Teacher accounts, parent dashboards, or social features.
- Listening to the learner through a microphone or MIDI keyboard.

The data model should leave room for these excluded capabilities without requiring their implementation.

## Thin vertical slice

The first engineering milestone should prove the entire architecture with one piece:

1. Sign in with Google.
2. Open Home and see one current work.
3. Open its work-details page.
4. View an attached PDF.
5. Open an attached MusicXML representation.
6. Render the notation with visible measure numbers.
7. Play it at an adjustable BPM.
8. Set and loop a numeric measure range.
9. Tap Start Practice, stop the timer, and save the session.
10. Return Home and see the weekly metric update.

Completing this slice before building broad catalog features will expose the highest-risk architectural and interaction problems early.

## Proposed application shape

The current preferred direction is a repository containing separate frontend and backend applications:

```text
noted/
├── frontend/          Angular web application
├── backend/           Go API and background jobs
├── docs/              Product, design, and technical documentation
├── deploy/            Deployment configuration
└── testdata/          Rights-safe sample PDF and MusicXML fixtures
```

### Frontend responsibilities

- Google sign-in initiation and authenticated app shell.
- Home, Library, Metronome, Practice, Settings, and account views.
- Work-details and edition/asset selection.
- PDF viewing.
- Structured notation rendering and playback controls.
- Practice timer state and summaries.
- iPad touch interaction and responsive layout.

### Backend responsibilities

- OAuth session validation and user records.
- Work, edition, asset, learner-state, tag, and practice APIs.
- File upload authorization and metadata.
- Provenance and rights metadata.
- Search over the private catalog.
- Signed access to private score assets.
- Background import/normalization jobs where needed.

### Persistence

- PostgreSQL on the NAS for identities, catalog metadata, learner state, and practice history.
- A dedicated Synology NFS shared folder mounted into the Go API for PDFs, MusicXML, and derived assets.
- Database migrations committed with the backend.
- Local-development equivalents that do not require production cloud services.

## Confirmed deployment target

Noted will follow the established Anthology/home-swarm application pattern:

- Angular UI and Go API built as separate container images.
- Images published to the private `registry.tail209cfc.ts.net` registry.
- API and UI deployed as separate services in the Crystal Docker Swarm.
- Services join the existing external `proxy` overlay network.
- Traefik routes `/api` to the API service and other application traffic to the UI service.
- PostgreSQL runs on the NAS and remains private on the existing LAN path/port 8432.
- Production secrets are pre-created Docker Swarm secrets and exposed through `_FILE` configuration.
- Google OAuth uses an allow-list for the initial users.
- The UI uses runtime API configuration so the same image can be pointed at the production API without rebuilding.
- API and UI expose health checks and use rolling updates with rollback behavior.
- Images carry source, revision, version, and deployment metadata labels.
- Existing monitoring/log collection and service inspection conventions should be extended to Noted.

The expected public application host is provisionally `noted.bitofbytes.io`, subject to confirmation and Google OAuth configuration.

### Proposed service and secret names

- Swarm services: `proxy_noted-api`, `proxy_noted-ui`.
- Image repositories: `noted-api`, `noted-ui`.
- Required initial secrets:
  - `noted_database_url`
  - `noted_google_client_id`
  - `noted_google_client_secret`
  - no asset credential secret is required for the initial NFS implementation; NAS export permissions and the container service identity form the storage boundary
- Likely production configuration:
  - `APP_ENV=production`
  - `DATA_STORE=postgres`
  - `AUTH_GOOGLE_REDIRECT_URL=https://noted.bitofbytes.io/api/auth/google/callback`
  - `FRONTEND_URL=https://noted.bitofbytes.io`
  - `ALLOWED_ORIGINS=https://noted.bitofbytes.io`
  - an email allow-list for the initial two users

No real secret values belong in this repository.

## Minimum domain model

- User
- Household or sharing boundary
- Composer
- Work
- Work movement/part
- Edition
- Score asset
- Asset source/provenance
- Learner-work state
- Personal tag
- Practice session
- Playback preference or last-used state

Annotation, lesson, assignment, physical-book, and recognition-job records can be designed later unless a small placeholder is needed to prevent a known migration problem.

## Decisions required before scaffolding

Confirmed or strongly established:

1. The UI and API run on the Crystal Docker Swarm.
2. PostgreSQL runs on the NAS using the existing private database path.
3. The application follows the Anthology-style Angular/Go split and Swarm deployment conventions.
4. The first build is private to allow-listed Google accounts.

Still to decide:

1. Whether the repository remains one repository with two applications or becomes two repositories. One repository is recommended to match Anthology.
2. Whether imported score assets are private per learner or live in a shared household catalog with private learner state. A shared household catalog is recommended.
3. Which rights-safe PDF and MusicXML pieces will serve as development fixtures.
4. Whether the initial public-score workflow is a source link plus manual upload, or must include automated external search in the first deployment. Manual upload is recommended initially.
5. The exact Synology shared-folder name, NFS export path, allowed Crystal node addresses, and service UID/GID. NFS is the selected initial mechanism.
6. The backup and restore strategy for both the Noted database and score assets.
7. Confirmation of the `noted.bitofbytes.io` hostname.

## Technical research required before committing dependencies

### Structured score rendering and playback

Build small browser prototypes using candidate open-source notation renderers and playback engines. Validate:

- MusicXML coverage for real piano scores.
- Measure numbering and stable measure identifiers.
- Tempo control.
- Numeric range playback and looping.
- Hand/part isolation.
- Page or system layout on a 13-inch portrait iPad.
- Mobile Safari audio restrictions and resume behavior.
- Performance on long or complex scores.

### PDF viewing

Validate:

- Large score performance on iPad Safari.
- Page fitting, zoom, and touch navigation.
- Restoration of last page and zoom.
- Future coordinate stability for an annotation overlay.

### Public-score integration

Investigate IMSLP and alternatives for:

- Search access.
- Metadata and edition identifiers.
- Download mechanics.
- Attribution and rights obligations.
- Caching and redistribution constraints.
- Geographic public-domain differences.

Until this research is complete, the safe first workflow is to retain a source URL and let the user upload an eligible file.

## Build milestones

### M0: Foundation

- Confirm the seven pre-scaffolding decisions.
- Choose deployment and persistence services.
- Establish repository structure, local configuration, secret handling, formatting, linting, tests, and continuous integration.
- Create technical architecture and threat-model notes.

### M1: Vertical slice

- Google sign-in and account allow-list.
- Core schema and migrations.
- One seeded work, edition, PDF, and MusicXML asset.
- Work details, PDF viewing, notation rendering, playback, measure loop, practice timer, and dashboard update.

### M2: Personal library

- Upload PDF and MusicXML assets.
- Create and edit works/editions.
- Private asset access.
- Library search, filters, status, favorites, and tags.
- Source and rights metadata.

### M3: Productized playback

- Playback state handling across navigation and device sleep/wake.
- BPM, loop, metronome, count-in, and part controls.
- Error and capability messaging when a work has only a PDF.
- iPad usability and performance pass.

### M4: Practice and dashboard

- Explicit practice start/stop and manual entry.
- Current repertoire and resume flow.
- Monday-first weekly calendar and totals.
- Work-level practice history and basic statistics.

### M5: Deployment readiness

- Production deployment.
- Database and asset backups.
- Restore drill.
- Logging, error reporting, health checks, and basic operational alerts.
- Privacy, account deletion, and data export behavior appropriate for the initial audience.
- End-to-end tests for sign-in, upload, playback, and practice logging.

## First-version definition of done

The first version is stood up when:

- Both intended learners can sign in with separate Google accounts.
- Each learner sees private status, tags, and practice history.
- Eligible scores can be uploaded with source and rights information.
- PDFs are comfortably readable on the target iPad.
- At least a representative set of MusicXML piano scores render and play reliably.
- BPM and numeric measure-range looping work.
- The standalone metronome works on iPad Safari.
- Practice can be timed or entered manually and appears in Monday-first summaries.
- One learner cannot access another learner's private assets or data without an explicit sharing path.
- The application is deployed, monitored, backed up, and restorable.

## Principal risks

1. **External catalog integration:** IMSLP access and redistribution may not support the imagined seamless flow.
2. **Score-format mismatch:** most owned scores are PDFs, while rich playback requires trusted structured notation.
3. **Rendering/playback fidelity:** complex piano MusicXML can expose library limitations.
4. **iPad browser constraints:** audio, large documents, touch interaction, and memory behavior must be tested on the real device.
5. **Scope pressure:** OMR, annotations, lessons, book recognition, and learning content can each become substantial products of their own.
6. **Rights and privacy:** uploaded scans and separate family accounts require clear storage, access, deletion, and provenance rules.

## Recommended immediate next step

Make the seven pre-scaffolding decisions, then run two short technical prototypes in parallel conceptually:

1. MusicXML rendering/playback/looping on the target iPad.
2. PDF viewing plus private upload/storage through the proposed backend.

If both prototypes succeed, scaffold the full application around the thin vertical slice.
