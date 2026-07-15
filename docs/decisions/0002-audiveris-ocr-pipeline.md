# ADR 0002: Audiveris for post-POC optical music recognition

Status: Accepted direction; implementation gated
Date: 2026-07-13

## Context

Noted can currently accept and read PDFs and can render/play user-supplied MusicXML. Many real uploads will contain only printed notation, so the product needs a future path from a source PDF/image to a structured score without turning the Go API or Angular application into an Optical Music Recognition engine.

[Audiveris](https://github.com/Audiveris/audiveris) is an established open-source OMR application. Its [handbook](https://audiveris.github.io/audiveris/_pages/handbook/) describes printed Common Western Music Notation recognition, MusicXML output, an internal `.omr` project format, and an interactive correction editor. Its [CLI](https://audiveris.github.io/audiveris/_pages/guides/advanced/cli/) supports headless batch transcription/export suitable for a worker. The repository reported release 5.11.0 as current when this decision was recorded and is licensed under AGPL-3.0.

Audiveris also explicitly warns that perfect recognition is not attainable for many inputs. It does not support handwritten scores, and its supported notation is a subset of the full range found in piano literature.

## Decision

Use a pinned Audiveris release as the engine for a post-POC OCR-assisted upload increment, with these boundaries:

- Keep the normal upload synchronous only through safe original-asset persistence. OCR begins only after an explicit learner request.
- Run Audiveris asynchronously in a private, resource-limited Java worker using batch transcription and MusicXML export.
- Keep authentication, authorization, job state, lineage, and final output validation in the Go API.
- Prefer plain MusicXML output for the first integration. If `.mxl` output is used, treat it as an untrusted archive with strict entry, path, and expanded-size validation.
- Preserve the original PDF/image. Store successful MusicXML as a separate derived asset with source/job/engine provenance and an `Unverified OCR` state.
- Permit explicit inspection/playback, retry, replacement by independently corrected MusicXML, and deletion of the derived result without deleting the original.
- Retain the private `.omr` project artifact when practical so a future correction workflow can open the recognition state in Audiveris instead of starting over.
- Do not build a correction editor in Noted's first OCR increment. Audiveris's editor or another MusicXML-compatible editor may provide a later correction path.
- Do not claim support for handwriting or guaranteed transcription accuracy.

## Required gates

Implementation cannot begin until both gates are recorded as accepted:

1. A spike runs representative clean, noisy, multi-page, dense, polyphonic, and marked-up piano scores through the intended deployment package and measures recognition usefulness, MusicXML/alphaTab compatibility, runtime, memory, temporary storage, cancellation, and failure cleanup.
2. An AGPL-3.0 review covers the exact pinned release, distribution/deployment approach, modifications, notices, corresponding-source delivery, and network interaction. A separate worker is not assumed to remove license obligations.

## Consequences

- OCR becomes an explicit derived-asset pipeline rather than a hidden side effect of upload.
- The existing work/edition/asset and storage boundaries remain useful; new job and lineage migrations are added only when the increment starts.
- Recognition can fail without making the original unreadable or blocking the rest of Noted.
- Users can hear a machine-generated result sooner, but the interface must continuously distinguish it from trusted/corrected MusicXML.
- Java/Audiveris adds a heavyweight operational component that requires separate packaging, resource limits, monitoring, cleanup, backups, and upgrade testing.
- Correction remains possible later without committing Noted to building a full notation editor.
