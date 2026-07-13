# Noted: Provisional Product Requirements

Status: Long-term working requirements; POC scope is defined in `poc-requirements.md`
Last updated: 2026-07-13

This document translates product discovery into testable requirements. Everything remains subject to prioritization and technical research.

## Product objective

Noted will provide a searchable home for a household's piano repertoire and connect each learner's scores to personal annotations, assignments, practice activity, and progress. It will later connect repertoire with interactive music learning.

## Primary experience

The initial product center is **Play**: find, import, catalog, view, annotate, play back, and practice music. **Learn** is a second mode within the same application and may be delivered after the core Play experience.

Delivery priority:

1. Store/find pieces and play them back.
2. Practice tracking, weekly metrics, lessons, and progress.
3. Score annotation.
4. Built-in lessons, external learning references, and music theory.

The first personally useful release centers on public-score search/import and structured-score playback. Practice tracking is the next priority, followed by PDF freehand annotation.

## Actors

- **Learner:** signs in with a personal Google account and owns private repertoire state, notes, annotations, assignments, and practice history.
- **Household member:** another learner with whom selected score assets and related context may be shared.
- **External repertoire source:** a public-domain music source such as IMSLP, subject to verified integration and rights constraints.

Teacher accounts are not initially required.

## Provisional functional requirements

### Identity and privacy

- FR-001: A learner can sign in with a separate Google account and return to persistent data.
- FR-002: A learner's annotations, notes, repertoire state, and practice history are private by default.
- FR-003: A learner can deliberately share an eligible score with another household member.
- FR-004: Sharing a score does not merge the learners' annotations, notes, statuses, or practice histories.
- FR-005: Practice information remains private unless a learner deliberately shares it. Summary sharing is deferred.

### Search and catalog

- FR-010: A learner can search works available through configured public-domain sources and the household's cataloged physical books.
- FR-011: Results are grouped by musical work, with available editions nested beneath the work.
- FR-012: A work can reference multiple editions and each edition can reference multiple score assets.
- FR-013: Imported assets retain relevant provenance, source links, attribution, edition, and rights information.
- FR-014: A learner can import an eligible edition or score asset into a private library.
- FR-015: A learner can upload a score from common iPad-accessible sources.
- FR-016: A learner can find music by composer, title, period, form, key, difficulty, activity, book, and tags when metadata is available.
- FR-017: Search and filtering, built-in status views, and personal tags provide initial organization; playlists and collections are not required.

### Physical books

- FR-020: A household member can add a physical book, including by ISBN where available.
- FR-021: Noted can store a book edition's metadata and contents.
- FR-022: Noted can match book contents to known works and allow the user to correct matches.
- FR-023: When electronic contents are unavailable, a user can provide contents by scanned image or manual entry.
- FR-024: A work found in an owned book can be searched and located by book and page even without a digital score.
- FR-025: A learner can assign and log practice for a physical-book work without scanning or uploading its pages.

### Score viewing and annotation

- FR-030: A learner can view PDF scores on a 13-inch iPad in portrait orientation.
- FR-031: A learner can navigate using touch taps and swipes.
- FR-032: A learner can annotate a score using Apple Pencil freehand input.
- FR-033: An annotation layer is attached to a specific score asset and learner without modifying the original.
- FR-034: A learner can choose to share annotations separately from the clean score.
- FR-035: Noted can display or hide the original and recognized score representations when both exist.
- FR-036: Reading mode prioritizes the score and hides nonessential interface chrome until requested.
- FR-037: Annotation is an explicit mode with a compact floating palette containing freehand write and erase controls initially.

### Structured notation and playback

- FR-040: Noted can associate an industry-standard open structured notation asset, such as MusicXML or MEI, with an edition.
- FR-041: When structured notation is available, a learner can play, pause, and change playback tempo.
- FR-042: A learner can select and loop a measure range using a compact `Measures #-#` control.
- FR-043: Playback can provide a count-in and metronome.
- FR-044: Playback can isolate available hands or parts.
- FR-045: A learner can review and correct automatically recognized notation before treating playback as trusted.
- FR-046: The original source file remains preserved alongside recognized notation.
- FR-047: Tapping in reading mode can reveal a compact floating playback bar.
- FR-048: Structured playback can turn pages automatically.
- FR-049: Playback-position indicators and note highlighting are optional behaviors that can be disabled to reduce distraction.
- FR-049a: Structured scores display measure numbers or otherwise expose a reliable measure identity.
- FR-049b: Tapping the displayed measure range opens a minimal popover for editing the numeric start and end measures.
- FR-049c: Measure-range editing stays hidden when not in use so the score player remains uncluttered.

Automatic performance listening, note highlighting, instrument-sound selection, and Bluetooth pedals are not initially required.

### Repertoire and assignments

- FR-050: Each learner has a separate relationship to a work.
- FR-051: That relationship can hold favorite state and a status such as Interested, Assigned, Learning, Playable, Polished, Memorized, Paused, or Archived.
- FR-052: Inactive works do not appear in the learner's current-practice view.
- FR-053: A lesson can record its date, next lesson date, free notes, and teacher feedback.
- FR-054: A lesson can contain multiple assignments and exercises.
- FR-055: An assignment can contain multiple practice targets with measure range, hand/part, target tempo, due date, and free instructions.
- FR-056: The work is the primary identity for learner status and aggregated progress even when several editions or score assets are used.
- FR-057: Tags belong to the individual learner rather than changing global work metadata.

### Practice and progress

- FR-060: A learner can record practice related to an assignment or as independent practice.
- FR-061: A practice record can include piece, date, duration, measure range, hand/part, starting tempo, ending tempo, completion, and free notes.
- FR-062: Noted provides a calendar view showing practice days and duration.
- FR-063: Noted shows the pieces a learner is currently working on.
- FR-064: Noted provides periodic summaries of practice activity.
- FR-065: A learner can record duration using either a running timer or manual entry.
- FR-066: A practice record can reference a passage within a work and optionally the exact score asset used.
- FR-067: Starting practice presents quick options to resume immediately or configure passage and tempo.
- FR-068: Weekly metrics use the learner's configured start-of-week preference; the product may default to Monday.
- FR-069: Playback does not automatically create practice history; the learner explicitly starts a practice session.

### Dashboard and navigation

- FR-070: After sign-in, a learner sees a dashboard designed for quickly resuming current repertoire.
- FR-071: Work details expose editions, score assets, learner status, and relevant activity.
- FR-072: Noted provides Play and Learn as modes within one application; Play is delivered first.
- FR-073: Search uses a structured, information-dense library catalog presentation rather than cover-led visual browsing.
- FR-074: The dashboard shows current repertoire before secondary summaries and recent activity.
- FR-075: Primary navigation uses a familiar mobile-app pattern with icon and text destinations.
- FR-076: Primary navigation destinations are Home, Library, Metronome, Practice, and Settings.
- FR-077: Monday is the default start of the practice week.
- FR-078: Search and filtering are available within Library. The accepted Home design may also provide a quick-search field that delegates to the same Library search behavior.
- FR-079: Metronome provides basic tempo, sound, and configuration controls independently of score playback.
- FR-080: Settings appears in primary bottom navigation and is not duplicated in the dashboard header.
- FR-081: The dashboard header retains access to the learner's account/profile.

## Provisional non-functional requirements

- NFR-001: The primary score-reading interface is optimized for a 13-inch portrait iPad at music-stand distance.
- NFR-002: Touch targets and core practice actions are usable without precise desktop-style interaction.
- NFR-003: Original score assets and user annotation layers are stored separately.
- NFR-004: Imported content retains sufficient provenance to review its origin and rights basis.
- NFR-005: The model distinguishes works, movements, editions, score assets, physical holdings, and learner-specific state.
- NFR-006: The architecture reserves a Learn mode without requiring it to ship alongside the first Play release.
- NFR-007: The initial interface uses a light theme and keeps score pages visually white.
- NFR-008: The visual language is simple, utilitarian, structured, and based on crisp boundaries rather than ornamental styling.
- NFR-009: Dashboard information density preserves intentional whitespace and avoids a cramped presentation.

Offline use is a potential later enhancement rather than an initial requirement.

## Research spikes required

- IMSLP and alternative catalog/search integration, rights, attribution, download, caching, and redistribution constraints.
- Bibliographic and table-of-contents sources available from ISBNs.
- Open-source optical music recognition quality and deployment options.
- MusicXML versus MEI as storage/interchange formats.
- Browser-based notation rendering and synthesized playback options.
- Apple Pencil annotation performance, persistence, coordinate mapping, and PDF compatibility on iPad browsers.
- Practical correction workflow for recognized piano scores without building a complete notation editor.

## POC boundary

The release sequence and local POC boundary are now established. See `poc-requirements.md` for the authoritative implementation-planning scope. Search/import automation, annotation, score recognition, lessons, and learning remain later work unless explicitly included by a future requirements revision.
