# ADR 0003: Decoupled practice score and playback sources

Status: Accepted and implemented
Date: 2026-07-20

## Context

A PDF or phone photo is often the edition the learner actually reads, but it cannot provide reliable note-level synthesis. Requiring full optical transcription before passage selection or external playback makes the least reliable operation the gateway to ordinary practice. Audio, MIDI, and public YouTube performances can already be useful even when they are not derived from the visual score.

## Decision

Keep PDF/JPEG/PNG as the visual practice score and attach playback sources independently at the edition level:

- MusicXML remains the notation-aware `Score` source and opens the alphaTab score player.
- MIDI is parsed in the browser and loaded into alphaSynth with the existing bundled SoundFont.
- MP3, M4A/MP4, and Ogg use the browser audio element.
- YouTube stores only a validated video ID/title and uses the official IFrame Player API. Noted does not scrape or download video/audio.

Every PDF/image upload automatically receives a lightweight measure-map job. The private OMR worker runs Audiveris only through `MEASURES`, extracts system-level stack rectangles from `.omr` sheet XML, and falls back to a bounded OpenCV staff/barline detector. Coordinates are retained in deterministic 300-DPI page space. The reader scales them as percentages over the rendered page.

Taps select an inclusive measure range. Practice starts retain that range. For audio, MIDI, and YouTube, learner-owned `(measure, position_ms)` anchors support exact seeks, linear interpolation between anchors, bounded extrapolation at either end, and looping from the selected start through the interpolated next-measure boundary. Sync mode records the current playback position when a measure is tapped; bulk replacement makes an edit atomic.

## Spike evidence

The native Audiveris 5.10.2 `MEASURES` pass and the checked-in extractor were run on the rights-safe corpus before accepting the representation:

| Fixture | Pages | Extracted boxes by page | MEASURES runtime |
|---|---:|---:|---:|
| `clean-simple` | 1 | 8 | 29 s |
| `dense-polyphony` | 1 | 8 | 54 s |
| `multipage-study` | 2 | 21, 19 | 34 s |

The count matches the known measure count for each fixture. The same rendered pages were also run without an `.omr` project to exercise the image-only failure path; the OpenCV detector returned `8`, `8`, and `21, 19` boxes respectively. Its geometry comes from long-horizontal staff detection and multi-staff vertical barline evidence. These synthetic results verify the bounded fallback mechanics, not accuracy on arbitrary scans or photographs.

## Boundaries and failure behavior

- Full OMR stays opt-in and never blocks reading, range selection, playback from another source, or practice logging.
- A pending/processing map is polled in the reader; failed/unavailable geometry leaves the score fully readable without hit boxes.
- Anchors and links are learner-scoped and cascade on source deletion. Uploaded bytes stay behind authenticated asset routes and the storage abstraction.
- YouTube playback depends on embed permission, the network, and the provider API. Failure affects only that source.
- Two anchors are recommended for meaningful interpolation; one anchor degrades to a fixed seek point and loop controls require at least two.
- This design does not infer semantic correspondence between editions, repeats, cuts, or performances. The learner owns the synchronization judgment.

## Consequences

The practice desk is immediately useful for visual scores, and a real performance can be synchronized with only a few taps. Playback adapters and external-provider lifecycle add browser complexity, while measure maps and anchors add small user-specific data sets. Full transcription is now an optional way to create another playback source rather than the system's critical path.
