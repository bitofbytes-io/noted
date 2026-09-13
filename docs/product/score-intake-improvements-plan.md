# Score intake improvements, round one

Status: Mockups and corrected tool-proof PDFs accepted. Application candidate implemented; independent review and physical-device checks pending.
Date: 2026-09-13

## Outcome and context

Bring one or two scores into Noted with less manual preparation. The user already
gets good scanner images, but pages can be crooked or the music can shift between
pages. Phone capture is the preferred convenient alternative. IMSLP is attractive
because the selected PDFs are often already in good condition. Curved pages have
not been a material problem.

The finished score remains one PDF attached to one private, user-owned piece.
The library remains search-first and opening a piece still opens the reader.

The approved extension is recorded in `requirements.md` and
`piece-binder-rebuild-plan.md`. It does not reactivate archived practice,
learning, MusicXML, or playback features.

## Accepted checkpoint: image mockups

The user accepted the image concepts before application integration.
The concepts use the accepted Title Page theme: ivory, ink, forest green,
Inter-style type, thin dividers, square secondary controls, and a green primary pill.
Use the old baseline image for visual language only; its practice navigation is
superseded by the current library and reader.

The concept set covers:

1. Library entry choices and IMSLP edition selection on desktop.
2. Page thumbnails, straightening, cropping, alignment, and original comparison
   in the tablet/desktop preparation screen.
3. Phone capture, page review, and saving the finished piece.

Mockups and exact generation prompts live in
[`../design/concepts/score-intake-v1/`](../design/concepts/score-intake-v1/).
All illustrated score content and edition details are placeholders. Generated
images convey layout and workflow, not verified notation or implemented controls.

Review entry-point clarity, how much cleanup should be visible initially, alignment
controls, page organization, and phone comfort. Revise the concepts from feedback.
User acceptance of the design is required before proceeding with implementation,
as requested in this conversation.

## Accepted checkpoint: working tool proof

The implementation sequence began with the isolated
[`../../tools/score-intake-proof/`](../../tools/score-intake-proof/) harness.
It uses pinned pdf-lib, OpenCV.js, PDF.js and canvas dependencies to generate
rights-safe fixtures, introduce reproducible defects, apply corrections, and
render actual output PDFs through PDF.js and Poppler. It does not alter app code,
API handlers, storage or schemas. Outputs remain under `.local/score-intake-proof/`.

Acceptance requires rendered tilt residuals within 0.25 degrees, controlled
alignment/scale errors within 1%, unchanged-input checksums, retained vectors
and CCITT streams, correct page IDs after organization, explicit processing
failures, and readable musical details. The report distinguishes measured results
from manual, device and browser gates that remain untested.

Review `review.pdf` alongside `corrected-score.pdf` on the iPad. Daniel must
approve the actual musical-detail quality before application integration.
Additional real scans or phone photographs can remain private under `.local/`.
Automatic perspective boundary detection is not proven by known-corner synthetic
tests. Direct IMSLP backend fetching is not established by obtaining a file
through the ordinary browser disclaimer and wait flow.

After this acceptance gate, proceed with shared preparation UI and private
source/draft retention, then IMSLP and phone integration, application checks and
physical iPhone/iPad/pedal validation. Preserve original source bytes for reset;
repeated processing always starts from sources, never from a previous export.

## Agreed feature scope

| Feature | Round-one behavior |
| --- | --- |
| IMSLP intake | Paste an HTTPS work link, open IMSLP to choose and download an edition, then upload its PDF into the same draft. Retain editable source metadata; no automated download or edition resolver. |
| Suggested metadata | Prefill editable title and composer when available; retain the source link and selected edition identity. Filename-derived titles remain available for ordinary uploads. |
| Phone photos | Capture successive pages or select existing photos, then assemble one score. Keep scanner-PDF upload equally accessible. |
| Straightening | Suggest a small rotation, allow manual correction, and support four-corner perspective correction for photos. |
| Cropping and alignment | Adjust page edges and align the printed music's position and apparent size across selected pages, with individual overrides. |
| Page organization | Preview, select, reorder, rotate, remove, and replace pages; add pages and extract a chosen subset from a larger PDF. |
| Review | Zoom into the result and compare original and adjusted views before saving. Cleanup is optional for good PDFs. |
| Re-editing | Retain source files and editable correction settings so users can undo cleanup without importing again. |

Exclude curved-page flattening, full-book batch digitization, stitching overlapping
photos of one page, notation recognition, automatic musical-error checking,
generative reconstruction of notation, sharing, and offline mode. One photo per
page is the initial capture model. Two-page spread splitting is deferred; users can
capture pages separately or crop source pages through a later explicit extension.

## Proposed user flow

Keep the existing Add piece action. It opens Source directly, with Upload PDF,
From IMSLP, and Add photos visible together. No intermediate chooser dialog.

All sources lead through Source, Pages, and Details in a dedicated preparation screen. On phones, use the viewport and a persistent, safe-area-aware footer.

Clean PDFs should have a quick path through Pages: review thumbnails and continue
without processing. Do not force automatic correction on imported PDFs.

The Pages step uses actual document previews. Desktop and iPad expose a thumbnail
rail and editing panel. Phones use a thumbnail strip, a selected-page preview, and
controls beneath it. Provide buttons to move pages as an accessible alternative to
dragging. Replace or retake affects only the selected page.

The user-approved simplified controls replace manual position/scale and reference
matching with a single selected-edge outline. Apply fits that selected area to its
natural aspect without implicit margins. Straightening remains manual. Optional
margins add blank space only when requested; paper strength can be adjusted on photos.

Details keeps the existing title, composer, source, listening link, notes, and
favorite fields. Secondary optional fields may collapse. Save and open publishes
the completed PDF to the piece and opens the existing reader. A failed save keeps
the draft available to retry without creating duplicate pieces.

## Investigation after mockup acceptance

Resolve these questions with bounded experiments before committing to libraries
or an implementation estimate:

| Question | Evidence needed | Decision |
| --- | --- | --- |
| IMSLP direct access | Representative work links, original/arranged editions, movement files, normal download interstitials and redirects; current access and reuse terms | Round one supports assisted download/upload only. The normal browser download flow was verified; no automated resolver or proxy is included. |
| PDF edits | Rights-safe scanned and vector PDFs with rotation, crop, extraction, and reordering | Choose an approach that preserves source PDF content where possible and does not rasterize untouched pages. |
| Phone capture | User's actual phone/browser, camera and photo-picker output, orientation, image formats, and memory use | Prefer browser capture if adequate. Compare a scanner toolkit only if needed; do not introduce a native app without a separate decision. |
| Music alignment | Clean but tilted scans and alternating binding margins | Determine whether manual adjustment plus suggestions is sufficient. Evaluate faint dots, accidentals, ledger lines, and page-edge content. |

The earlier exploration found that IMSLP's public API documentation describes work
and composer lists, not an established complete PDF-import contract. Treat that
integration as unresolved. Useful research starting points:

- [IMSLP API](https://imslp.org/wiki/IMSLP:API)
- [IMSLP example work and editions](https://imslp.org/wiki/Prelude_and_Fugue_in_C_major,_BWV_846_(Bach,_Johann_Sebastian))
- [Apple document scanning](https://support.apple.com/en-ie/108963)
- [Browser photo capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)
- [OpenCV perspective correction](https://docs.opencv.org/4.x/da/d6e/tutorial_py_geometric_transformations.html)

## Proposed implementation sequence

### 1. Source retention and import drafts

Introduce private, user-owned import drafts, original source assets, and a page edit
manifest behind AssetStore. A manifest maps each output page to its source asset
and page, with ordering, rotation, crop, perspective, position, and scale settings.
Multiple original assets may belong to one draft or piece; the reader still has one
active PDF. Original files remain immutable.

Existing pieces continue to work without a bulk migration of uploaded files. When
an existing PDF first enters the editor, retain it as the source before any derived
replacement. Change current replacement cleanup so it cannot delete a retained
original. Avoid unbounded version history: keep sources required for re-editing,
the saved edit manifest, and the active output. Undo within an editing session and
reset-to-source are sufficient for this round.

Publish a new output only after successful processing and validation. Failed or
cancelled work leaves the active score intact. Serialize or reject stale concurrent
saves. Delete unreferenced outputs and expired abandoned drafts using a documented
retention policy; select the draft expiry and storage limits before implementation.
Deleting a piece must remove its owned retained sources and derived assets safely.

### 2. Shared PDF page preparation

Build thumbnails, page selection and ordering, extraction, rotation, crop, zoom,
and original/adjusted comparison first. Add manual deskew, natural-aspect edge fitting,
and explicit optional margins. Preserve untouched original PDFs byte-for-byte
on the no-edit path; preserve vector content through supported edits where possible.
Document any transformation that requires rasterization and assess its output.

Define reading-position behavior when page order or count changes. Recommended:
reset position to the first output page after structural edits, keep reader mode
and speed, and ensure saved zoom/position remains valid after page geometry changes.
Make this behavior visible before replacing an existing score.

### 3. IMSLP intake

Implement the supported source-resolution path, edition selection, editable metadata,
source identity, preview, and download/upload fallback. Keep representative parser
fixtures rights-safe and clearly identify when metadata cannot be determined.
Do not infer that a PDF is musically correct or complete from its filename or size.

Bound remote fetching by approved hosts, redirect checks, public network addresses,
timeouts, and file-size limits. Never allow pasted URLs to reach private services.
Validate actual PDF structure and page count on the server rather than trusting
browser-provided values. Render page previews to expose individual rendering errors.
Keep per-file source and rights information with the selected edition when available.

### 4. Phone capture and photo assembly

Add camera capture and multi-photo selection to the same draft and page preparation
flow. Handle camera denial, supported image formats, orientation, retakes, partial
upload failure, and interrupted sessions. Persist received pages so a later failure
does not discard them. Process previews at bounded resolution while preserving
source quality for output. Do not load every full-resolution page into mobile memory
at once. Add photo perspective adjustment and assemble the final PDF.

### 5. Integration and release validation

Verify all source paths through Save and open, re-editing, download, replacement,
and deletion. Check owner authorization for drafts, originals, thumbnails, and output
as rigorously as for current pieces. Review relevant requirements and design docs
against the accepted implementation and update them in the implementation changes.

## Acceptance and verification

- Scanner PDF: correct a tilted page and inconsistent binding margins, keep all
  notation visible, and save a consistently positioned score.
- Phone: capture a short score, retake one page, reorder pages, and read the result
  on the iPad. Verify on the user's actual phone; desktop emulation is insufficient.
- IMSLP: select the intended edition, inspect pages and metadata, and save. Exercise
  assisted browser download/upload with recoverable failures.
- Clean PDF: import without edits and preserve the original bytes and visual quality.
- Collection: select a page subset and verify the exact output order and count.
- Re-edit: reset a correction from retained sources; failed processing leaves the
  published score and its originals available.
- Ownership and lifecycle: another user cannot access any import asset; retry,
  replacement, cancellation, draft expiry, and deletion leave consistent records.
- Accessibility: keyboard operation, non-drag ordering, 44px touch targets, readable
  controls, focus handling, and no clipped actions at phone and 1024x1366 layouts.
- Musical fidelity: human review at playing size and zoom, especially faint marks,
  ledger lines, slurs, and edges. Preview success does not prove note accuracy.

For implementation changes, run `make test`, `make lint`, and `make build`.
Run `make test-e2e` for reader changes and add meaningful browser coverage for the
new intake flow. Record physical iPad Safari and Bluetooth pedal checks separately,
including a saved prepared score in both reader modes. Generated mockups do not
satisfy browser, device, or musical-fidelity validation.

## Current stopping point

The user accepted the tool-proof outputs and authorized application integration.
The candidate now includes private retained originals/drafts, CAS publication,
durable deletion retries, assisted IMSLP intake, phone photos and a real browser
processing worker. It is being verified locally before independent review and a
physical iPhone/iPad/pedal checkpoint. Deployment is not part of this checkpoint.

Implementation choices are documented in `requirements.md`. Direct IMSLP fetching
remains assisted download/upload because only the normal browser flow was proven.
Existing PDF rotation/crop geometry is preserved by page copying and quarter turns;
fine geometry edits reject unsupported source geometry explicitly. The malformed
legacy CCITT fixture is rejected; the valid single-strip fixture is used for
positive rendering checks. HEIC-to-JPEG conversion remains explicit.


### Local usability revision — manual retry checkpoint

The user requested a simpler candidate before further PR review or updates.
Add piece now opens Source directly. Pages offers one pending edge outline with
Apply/Cancel and automatic natural-aspect fitting, a Lighten paper strength slider,
manual straightening, quarter turns and optional explicit margins. Scale, position,
match and automatic suggestions are removed from the visible controls. Zero margins
adds no border. Existing edit manifests remain compatible until an explicit change;
combined legacy perspective/crop has a clearly labelled start-over option.
Library rows keep Edit details; Edit pages moved into the details dialog during the
UI polish pass, and drafts are listed as rows with a Resume action.
PDF/IMSLP pages can still be removed, reordered or extracted without changing originals.

Stop after the working local preview and required checks so the user can retry the
controls. Do not update the PR or begin another review cycle before that checkpoint.
