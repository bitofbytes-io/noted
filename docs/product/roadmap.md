# Noted: Provisional Product Roadmap

Status: Product sequence selected; OCR follow-up in production validation
Last updated: 2026-07-18

## Phase 1: Store and Play

Goal: create one searchable place to find, import, view, and hear piano music.

Success outcomes:

- Find and import public scores.
- View PDF scores.
- Play scores backed by trusted structured notation.

Supporting capabilities include Google sign-in, learner-private libraries, work and edition modeling, source provenance, personal repertoire status, favorites, tags, iPad score reading, and deliberate household sharing.

The local POC is a subset of this phase and is defined separately in `poc-requirements.md`.

### Phase 1 follow-up: OCR-assisted upload (active development)

The repository now implements an asynchronous, resource-limited dual-engine worker so a learner can request recognition of an eligible printed PDF and receive a derived MusicXML asset. Audiveris 5.10.2 and homr 0.7.0 run against shared 300-DPI preprocessing, music21 10.3.0 repairs each surviving result, measure-level fusion records source/agreement/confidence, and alphaTab 1.8.4 gates final playability. The original is preserved, every result is linked to its source/job/engine provenance, and playback remains labeled `Unverified OCR` with corrected/suspect counts and per-measure review signals.

This increment uses batch recognition and automatic conservative repair only. It does not build a notation editor into Noted. Retaining the private Audiveris `.omr` artifact keeps later Audiveris/external-editor correction possible, while image-source uploads and handwritten-score recognition remain out of scope for the current route.

Implementation is not the production release gate. The committed rights-safe corpus has recorded
Audiveris-only, homr/repaired, and fused results: playability and aggregate event accuracy improve,
with a disclosed dense-polyphony fidelity tradeoff. Rights-cleared representative real scans also
pass the fixed structural/playability gate under production-like limits, and the exact dependency
and model inventory is recorded. Before activation, complete NAS-native resource/cancellation
verification and obtain final informed owner acceptance of the residual model provenance risk,
AGPL/corresponding-source duties, private-network boundary, backup, and operations obligations.

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
