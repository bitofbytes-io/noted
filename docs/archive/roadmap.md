# Noted: Provisional Product Roadmap

Status: Product sequence selected; decoupled practice playback implemented
Last updated: 2026-07-20

## Phase 1: Store and Play

Goal: create one searchable place to find, import, view, and hear piano music.

Success outcomes:

- Find and import public scores.
- View PDF scores.
- Play scores backed by trusted structured notation.

Supporting capabilities include Google sign-in, learner-private libraries, work and edition modeling, source provenance, personal repertoire status, favorites, tags, iPad score reading, and deliberate household sharing.

The local POC is a subset of this phase and is defined separately in `poc-requirements.md`.

### Phase 1 follow-up: decoupled practice playback

PDFs and phone photos are now first-class interactive practice scores. An automatic structure-only job adds tappable measure geometry without attempting note transcription. The reader supports passage selection, measure-aware practice starts, and a dock of independent MusicXML, MIDI, audio, and YouTube playback sources. Learner-created timestamp anchors connect visual measures to media for seeking and looping. Full OMR is therefore optional rather than the gateway to hearing a work.

### Phase 1 follow-up: OCR-assisted upload

The repository implements an asynchronous, resource-limited routed worker so a learner can explicitly request recognition of an eligible PDF/image and receive a derived MusicXML asset. PDFs use Audiveris 5.10.2 first; images use homr 0.7.0 first; the secondary engine runs only if the primary fails. music21 10.3.0 repairs the surviving result, the existing fusion path arbitrates only after fallback, and alphaTab 1.8.4 gates final playability. An explicit implicit-tuplet hint and a strict-majority 3:2/beamed-pattern retry address unmarked triplet textures. The original is preserved, every result is linked to its source/job/engine provenance, and playback remains labeled `Unverified OCR`.

This increment uses batch recognition and automatic conservative repair only. It does not build a notation editor into Noted. Retaining the private Audiveris `.omr` artifact keeps later Audiveris/external-editor correction possible. Printed phone-photo input is supported; handwritten-score recognition remains out of scope.

Implementation is not the production release gate. The committed rights-safe corpus has recorded
Audiveris-only, homr/repaired, and fused results: playability and aggregate event accuracy improve,
with a disclosed dense-polyphony fidelity tradeoff. Rights-cleared representative real scans also
pass the fixed structural/playability gate. The exact published digest passed NAS-native resource,
cancellation, cleanup, Crystal-only network, and production PDF-to-alphaTab checks. On 2026-07-18
the owner explicitly accepted the residual model-provenance risk and AGPL/corresponding-source
duties for private use only; public or commercial distribution requires a fresh review.

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
