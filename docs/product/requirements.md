# Noted Digital Binder v1 Requirements

Status: Authoritative implementation scope
Last updated: 2026-07-28

## Product outcome

A pianist can scan or download a PDF, add it to Noted, find it quickly at the
piano, and read it on a 13-inch iPad with hands-free page advancement.

## Requirements

### Library

- BND-001: The first screen is a search-first library.
- BND-002: A user can create, edit, and delete a piece with title, composer,
  favorite, optional source URL, optional listening URL, and optional notes.
- BND-003: Choosing a PDF prefills its filename as the editable title.
- BND-004: A user can search title and composer and filter favorites.
- BND-005: Selecting a piece with a PDF opens its reader directly.
- BND-006: A user can upload or replace the one PDF attached to a piece.
- BND-007: Production users sign in with one of the explicitly allow-listed,
  verified Google accounts.
- BND-008: Each piece, its PDF, notes, source and listening URLs, favorite state,
  and reader state are private to its owning user.
- BND-019: When a listening URL is present, the library exposes a safe outbound
  Listen action that opens the recording in a new tab without opening the reader.
- BND-009: A user cannot discover, fetch, or mutate another user's piece by
  guessing its identifier.

### PDF storage and delivery

- BND-010: Only PDFs with a valid PDF signature are accepted.
- BND-011: Upload size is bounded by configuration.
- BND-012: Files are stored behind `AssetStore` using generated opaque keys
  beneath a configured, gitignored root.
- BND-013: PostgreSQL stores metadata, checksum, size, original filename, page
  count, and the opaque storage key, not file bytes.
- BND-014: PDF responses support HTTP byte ranges and inline display.
- BND-015: Replacing or deleting a PDF cleans up the old stored object without
  leaving the database pointing at a missing replacement.
- BND-016: A user can download the current PDF attached to their own piece using
  its safe original filename, so they can edit it outside Noted before replacing it.

### Reader

- BND-020: The reader is an immersive, safe-area-aware full-viewport route with
  an explicit back action. After the full header and toolbar auto-hide, a score
  tap or genuine fine-pointer movement reveals only a compact lower-right
  controls bubble; activating that bubble opens the full chrome for three
  seconds of true inactivity. Scrolling, touch-panning, and auto-scroll content
  motion do not reveal or prolong the full chrome.
- BND-021: Page mode fits a page, supports zoom, and turns pages using tap zones,
  horizontal swipes, Arrow keys, PageUp, PageDown, Space, and Enter.
- BND-022: Page mode never turns while focus is in a form control.
- BND-023: Auto-scroll mode lays pages vertically, renders nearby canvases on
  demand, exposes speed and zoom controls, and toggles pause on score tap.
- BND-024: Reader state persists per piece: mode, page, scroll position, zoom,
  scroll speed, and auto-scroll pause state.
- BND-025: Returning to a piece restores its saved reading position and settings.
- BND-026: While a score is open, supported browsers keep the display awake in
  page and auto-scroll modes. The wake lock is released when the reader is
  hidden, closed, or fails to load, and reacquired when the visible reader
  resumes; unsupported or denied wake locks do not interrupt reading.

### Quality and operations

- BND-030: The interface follows the “Title Page” ivory, ink, and forest-green
  design tokens with no dashboard cards or decorative notation.
- BND-031: Touch targets are at least 44px and the library and reader work at
  1024x1366 portrait and common phone/desktop sizes.
- BND-032: A clean checkout starts with the documented setup commands.
- BND-033: API tests cover validation, storage path safety, search filters, range
  delivery, and reader-state validation; browser tests cover core library and
  reader interactions.
- BND-034: Local development data persists across restarts.

## Deferred

Practice tracking, weekly summaries, metronome, learning, OMR, MusicXML,
synthesized or in-app/reference playback, playback synchronization, annotations,
IMSLP fetching, photo stitching, sharing, and offline mode are not part of v1.

## Acceptance flow

1. Add a piece from a phone or desktop, using the filename-prefilled title.
2. Optionally add a listening URL, upload its PDF, and find it by title or composer.
3. Download the current PDF from the edit dialog and verify the original filename.
4. Favorite it and verify the favorites filter.
5. Open it directly from the library.
6. Turn pages with taps, a swipe, and PageDown/ArrowRight.
7. Switch to auto-scroll, adjust speed and zoom, pause, leave, and return.
8. Verify the prior mode, position, zoom, and speed are restored.

## Approved score intake extension (2026-09-13)

The user approved the tool-generated corrected PDFs before application work.
Private draft preparation now precedes publishing one active PDF per piece.
Inputs are PDFs and JPEG/PNG photos, including phone captures. Drafts support
page extraction/order/replacement, one applied edge selection with natural-aspect
fitting, manual straightening, paper strength, optional margins, original comparison and reset.
Assisted IMSLP intake retains an HTTPS work link and lets the user choose and
download the edition on IMSLP before uploading; no automatic edition list or
backend download proxy is included.

Originals needed by the current saved manifest or an open draft remain private.
Superseded, unreferenced files enter a durable deletion queue; drafts expire after
seven inactive days. Limits are the configured file limit, 200 MiB per draft,
100 prepared pages, 20 active drafts per owner, and 20 megapixels per photo.
Revision checks prevent stale saves; repeat finalization returns the same piece.
Unchanged preparation preserves original output bytes and reader state; content
changes reset position/page/zoom while retaining reading mode and scroll speed.

Editing pre-cropped or pre-rotated PDF geometry requires normalization and is
explicitly rejected for now. Page copying, extraction and quarter turns preserve
that source geometry. HEIC requires JPEG export. Curved-page correction, image
reconstruction, OMR, whole-book processing and direct IMSLP fetching remain
outside this extension. Physical iPhone capture, iPad reading and pedal checks
remain a separate release checkpoint.

Preparation transforms use a fixed output canvas. Scale changes notation size;
position is a fraction of that canvas. Optional manifest `outputWidth` and
`outputHeight` in legacy manifests are PDF points (72 points per inch), defaulting to source/cropped
page dimensions. Legacy matching measures the adjusted reference and saves its physical
canvas dimensions on targets. Preview and export use the same worker
PDF transformations. A rendered ink check rejects unintended content clipping;
explicit manual crop removes only content outside the selected rectangle.
Upload cancellation waits for the in-flight file to settle and retains it, while
cancelling later files. Controls remain busy until the draft is reconciled.

Photo preparation also offers an optional Lighten paper setting. Its boolean
`paperCleanup` manifest flag applies only to photos. Low-frequency illumination
normalization preserves continuous color and faint strokes; it does not threshold,
erase, reconstruct, or identify notation. Corrected pixels are encoded once as
high-quality JPEG. Unchanged JPEG photos keep their original compressed image
bytes, with all eight EXIF orientations applied as PDF placement transforms.
Original files remain immutable and the setting can be reset or compared.
Pixel corrections use at most 4 megapixels and 2800 pixels per edge before OpenCV;
working and rectified images share that bound. This trades some fine texture for
lower peak memory during correction. Unchanged JPEG embedding retains the full
original resolution. Each RGBA correction surface is at most 16 MB; that is not
a bound on total browser memory, which also includes decoding and the wasm heap.

Preparation saves conservatively conflict when the saved piece changes, including
title or favorite edits made while a draft is open. The newer piece metadata and
the draft are both retained. The error directs the user to start a new preparation
from the current piece; reloading the stale draft cannot update its base revision.


The local preparation controls now use one **Adjust page edges** editor on the
orientation-correct original: a connected outline and shaded excluded area, with
44-pixel handles, Apply edges and Cancel. Holding Shift while dragging (or using
arrow keys) constrains a photo selection to a rectangle anchored at the opposite corner. Edits stay local until Apply and form
one Undo step. Photos use convex four-corner selections; PDFs use rectangles.
Applying replaces earlier crop, scale, position and fixed canvas settings. A
legacy page combining crop and perspective requires an explicit start-from-original
choice before replacing its edges; opening or cancelling the editor changes nothing.
`fitEdges` opts into natural selected-region aspect and the complete rotated
bounding box. Existing manifests without the flag retain their prior output.

The visible controls are page edges, Lighten paper strength, manual straightening,
quarter-turn rotation, and optional Top/Right/Bottom/Left margins. Position, scale,
reference matching and automatic straightening suggestions are no longer shown.
`paperCleanupStrength` (0–1) overrides the legacy boolean (`true` means 1). Zero
keeps original JPEG bytes when no pixel correction is needed; rectified photos
are encoded once as high-quality JPEG. Slider gestures make one Undo step and
preview updates are debounced. `margins` stores four additive PDF-point values,
in top/right/bottom/left order, shown as 0–50 mm per edge. Zero adds no border:
the selected area itself defines the finished page. Rotation may expose the
geometric white wedges around a tilted selection.

Add piece opens Source directly with PDF, phone-photo and assisted IMSLP choices.
There is no source-choice dialog. The secondary details-without-PDF action removes
its empty draft before opening the existing metadata form. Library rows expose
Listen, favorite and an Edit details action with accessible labels; Edit pages
lives inside the details dialog, and unfinished drafts appear as rows with a
Resume action. PDF pages, including IMSLP downloads, retain removal, reordering
and extraction controls.
