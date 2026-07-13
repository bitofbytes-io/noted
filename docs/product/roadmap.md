# Noted: Provisional Product Roadmap

Status: Product sequence selected; scope details remain provisional
Last updated: 2026-07-13

## Phase 1: Store and Play

Goal: create one searchable place to find, import, view, and hear piano music.

Success outcomes:

- Find and import public scores.
- View PDF scores.
- Play scores backed by trusted structured notation.

Supporting capabilities include Google sign-in, learner-private libraries, work and edition modeling, source provenance, personal repertoire status, favorites, tags, iPad score reading, and deliberate household sharing.

The local POC is a subset of this phase and is defined separately in `poc-requirements.md`.

### Phase 1 follow-up: OCR-assisted upload

Add an asynchronous, resource-limited [Audiveris](https://github.com/Audiveris/audiveris) worker so a learner can request printed PDF/image recognition and receive a derived MusicXML asset. Preserve the original, link every derived result to its source and engine version, and label playback as `Unverified OCR`.

This increment uses batch recognition only. It does not build correction tools into Noted. Retaining the Audiveris `.omr` artifact keeps later Audiveris/external-editor correction possible, while handwritten-score recognition remains out of scope. Complete the representative-score quality spike and AGPL-3.0 compliance review before implementation.

## Phase 2: Tracking, Lessons, and Progress

Goal: connect repertoire to the real weekly learning workflow.

Capabilities include practice timers, manual logs, a configurable weekly calendar, summaries and metrics, dated lessons, free notes, teacher feedback, assignments, and passage and tempo targets. Music in physical books remains trackable even without a scanned score.

## Phase 3: Annotation

Goal: let each learner add private, paper-like markings without changing the shared score.

Capabilities include an explicit Apple Pencil annotation mode, a minimal pencil/eraser palette, score-specific annotation layers, and deliberate annotation sharing.

## Phase 4: Learn

Goal: connect music theory and guided learning to repertoire and demonstrated experience.

Capabilities may include built-in lessons, exercises, external learning references, theory and musicianship topics, level-aware recommendations, and practice guidance based on current repertoire.

## Deferred possibilities

- Teacher accounts and direct assignment.
- Shared practice summaries.
- Bluetooth page-turn pedals.
- Offline score access.
- MIDI-keyboard listening and performance assessment.
- Playlists and collections beyond tags and saved filters.
- Advanced semantic annotation tools.
- Built-in notation correction/editor tools; use Audiveris or a compatible external editor in a later increment if correction becomes a priority.
- Social or community features.
