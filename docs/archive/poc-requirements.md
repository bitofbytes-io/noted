# Noted: Proof-of-Concept Requirements

Status: Authoritative scope for implementation planning
Last updated: 2026-07-13

## Purpose

The proof of concept must demonstrate that Noted can provide one useful path through the product: keep a piano work in a personal library, open its score, play a structured representation, loop measures at an adjustable tempo, record a practice session, and see that activity on the dashboard.

The POC is intentionally local-first. It should use the same architectural boundaries planned for production without requiring Crystal, Synology NFS, production OAuth, external public-score integration, or a complete visual implementation.

## Product goals

1. Prove browser-based piano-score rendering and playback on desktop and a 13-inch portrait iPad.
2. Prove the work/edition/asset model using both PDF and MusicXML representations.
3. Prove measure-aware playback, tempo adjustment, and looping.
4. Prove the explicit practice timer and Monday-first weekly summary.
5. Establish an Angular/Go/PostgreSQL codebase that can evolve into the deployed first version.

## POC users

The POC may operate as one seeded development learner so it can start without external credentials. The application must still scope learner-owned records by `user_id`; a production build must not permit the development authentication mode.

Before the application is deployed outside a trusted local environment, Google OAuth and the production email allow-list are required.

## Authoritative terminology

- **Work:** the composition that the learner recognizes as the piece, regardless of edition.
- **Movement:** an optional subdivision of a work.
- **Edition:** a publication, engraving, arrangement, or revision of a work.
- **Score asset:** a stored PDF, MusicXML, or later supported file associated with an edition.
- **Learner-work state:** one learner's relationship to a work, including status, favorite, tags, and progress.
- **Practice session:** timed or manually entered activity associated with a work and optionally a movement, score asset, measures, hand/part, and BPM.
- **Playable score:** a trusted structured score that can be rendered with measure identities and synthesized.

## POC scope

### Application shell and navigation

- POC-001: The application provides Home, Library, Metronome, Practice, and Settings destinations.
- POC-002: The Play mode is active. Learn may appear as disabled or “coming later,” but contains no POC functionality.
- POC-003: The interface uses the selected light, cobalt-blue, black, and white visual direction.
- POC-004: Navigation and controls remain usable on desktop and a 13-inch iPad in portrait orientation.

### Home dashboard

- POC-010: Home shows Continue Practicing before secondary content.
- POC-011: Each current work shows title, composer, learner status, last-practiced date, most recent BPM when available, PDF availability, and playback availability.
- POC-012: Selecting a current work opens its work-details view.
- POC-013: Home shows a Monday-first seven-day practice summary with daily duration, total time, and session count.
- POC-014: Home shows recently imported score assets.
- POC-015: The accepted visual baseline includes a dashboard search field. In the POC it may either search immediately or navigate to Library with the query applied; it must not create a separate search destination.

### Library and work details

- POC-020: Library lists works rather than treating every edition or file as a separate piece.
- POC-021: A learner can search locally stored works by title or composer.
- POC-022: A learner can filter by personal status, favorite, and tag.
- POC-023: Work details show core work metadata, movements, available editions, assets, provenance, learner status, favorite, tags, and practice summary.
- POC-024: A work can have more than one edition and each edition can have more than one asset.
- POC-025: A learner can set one of these statuses: Interested, Assigned, Learning, Playable, Polished, Memorized, Paused, or Archived.
- POC-026: Tags and favorites belong to the learner, not the global work.

### Local asset import and storage

- POC-030: A learner can upload a PDF score.
- POC-031: A learner can upload MusicXML using supported `.musicxml`, `.xml`, or compressed format if the chosen playback library supports it.
- POC-032: An upload is attached to a selected work and edition or to a newly created work/edition.
- POC-033: The upload record captures original filename, detected format, size, checksum, source URL when supplied, rights note, and creation time.
- POC-034: Binary assets are stored through a backend storage interface.
- POC-035: The POC storage implementation writes beneath a configurable local root, defaulting to a gitignored project directory such as `.local/noted-assets`.
- POC-036: User filenames never become trusted filesystem paths; final storage keys use generated opaque identifiers.
- POC-037: PostgreSQL stores asset metadata and storage keys, not full PDF/MusicXML binary contents.

### PDF reading

- POC-040: A learner can open an uploaded PDF from work details.
- POC-041: The PDF reader supports page navigation and fit-to-width or fit-to-page behavior.
- POC-042: The score receives most of the available reading area and nonessential controls can be hidden.
- POC-043: The POC records enough asset and page identity to support a future annotation coordinate layer, but annotation is not implemented.

### Structured score and playback

- POC-050: A learner can open a MusicXML-backed score and see rendered notation.
- POC-051: Rendered notation exposes visible measure numbers or a reliable displayed measure identity.
- POC-052: Playback supports play, pause, restart/seek to beginning, and adjustable BPM.
- POC-053: Playback supports a numeric inclusive measure range shown as `Measures #-#`.
- POC-054: Tapping the range opens a minimal editor for start and end measure numbers.
- POC-055: The selected measure range can loop until the learner stops playback or disables looping.
- POC-056: Invalid ranges are rejected with clear feedback; start must be at least 1, end cannot precede start, and both must exist in the score.
- POC-057: The score player has a compact floating control bar and a separate lower-left pencil affordance that is disabled or labeled for a later annotation phase.
- POC-058: A PDF-only work is still readable and practiceable but is clearly marked as not currently playable.
- POC-059: The structured-score route is an immersive `100dvh` reading surface. It hides Noted's global header and bottom navigation while active, provides an explicit back action, respects safe-area insets, and restores the application shell after exit.
- POC-059a: Player controls appear after a score tap/click or keyboard activity, auto-hide after three seconds of inactivity, and remain visible while notation is loading, an error is shown, a control has focus, or the measure-range editor is open.
- POC-059b: Playback always shows a high-contrast cobalt vertical beat cursor plus current-beat/note highlighting. Reduced-motion mode keeps a stepped cursor and disables cursor animation rather than removing position feedback.

Count-in, part isolation, automatic page turning, and hand isolation are desirable experiments but are not required for POC acceptance.

### Metronome

- POC-060: The standalone Metronome view starts and stops an audible beat.
- POC-061: The learner can set BPM within a safe supported range.
- POC-062: The metronome preserves the learner's last local BPM setting for the browser session or persisted preference.
- POC-063: The POC may use one sound; multiple sound choices and advanced subdivisions are later work.

### Practice tracking

- POC-070: Playback does not automatically create a practice record.
- POC-071: A learner explicitly taps Start Practice to begin a timer.
- POC-072: Only one running practice timer may exist for a learner.
- POC-073: Stopping the timer opens or saves a practice record with work, start time, duration, and optional notes.
- POC-074: A learner can manually enter a practice session.
- POC-075: Optional practice fields include movement, asset, start/end measure, hand/part, starting BPM, ending BPM, and free notes.
- POC-076: The Practice view lists recent sessions and allows a learner to correct or delete their own entries.
- POC-077: Saved sessions update Home and work-level statistics.

### Settings and account

- POC-080: Settings includes Monday as the default week start and leaves room for later configurability.
- POC-081: Settings exposes basic metronome preference and application/about information.
- POC-082: Development mode clearly identifies the seeded local learner.
- POC-083: Production-mode configuration refuses to start without valid OAuth and session configuration.

## Core user flows

### Flow A: Open and hear a seeded piece

1. Start the local application.
2. Home shows a seeded current work.
3. Open work details.
4. Open the PDF and confirm it is readable.
5. Open the MusicXML asset.
6. Set BPM.
7. Set a measure range and loop it.

### Flow B: Import a work and assets

1. Open Library.
2. Create a work and edition.
3. Upload a PDF with source/rights notes.
4. Upload a MusicXML representation.
5. Reopen the work and access both assets.

### Flow C: Record practice

1. Open a work and tap Start Practice.
2. Practice while optionally using playback or the standalone metronome.
3. Stop the timer and add free notes/BPM/measure details.
4. Return Home and see Monday-first metrics updated.

## POC acceptance criteria

The POC is successful when all three core flows work locally and:

- A clean checkout can be started using documented commands.
- Local PostgreSQL and local asset storage persist across application restarts.
- A PDF and representative piano MusicXML file can be uploaded and reopened.
- MusicXML renders and plays in current desktop Chrome and target iPad Safari.
- BPM and measure-range loop behavior are demonstrably correct on a representative score.
- Practice timing/manual entry changes dashboard and work statistics.
- Tests cover domain validation, authorization scoping, asset path safety, and practice aggregation.
- No production secret or uploaded asset is committed to Git.

## POC non-goals

- IMSLP or other public-source automation.
- PDF-to-MusicXML optical recognition. Audiveris is now the selected post-POC direction, but recognition remains outside this completed POC.
- Music notation editing or recognition correction.
- Apple Pencil annotations.
- Google OAuth during the first local vertical slice.
- Household sharing UI.
- Physical-book/ISBN ingestion.
- Lesson and assignment tracking.
- Learn-mode lessons or theory exercises.
- Offline operation.
- MIDI input, microphone listening, or performance grading.
- Production Swarm deployment.

## Production follow-ups already decided

These are not POC blockers and must remain in deployment documentation for later setup:

- `noted.bitofbytes.io` routing through Traefik, pending final hostname confirmation.
- Separate `noted-api` and `noted-ui` Swarm services and images.
- Google OAuth with allowed-email configuration.
- PostgreSQL database/role on the Synology NAS.
- Dedicated Synology `noted-assets` shared folder exported through NFS.
- Swarm-managed NFS volume mounted only into the Go API.
- Dedicated NAS permissions/UID/GID, Crystal-node allow-list, backups, restore drill, monitoring, and logs.
