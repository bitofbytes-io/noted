# Noted Digital Binder v1 Requirements

Status: Authoritative implementation scope
Last updated: 2026-10-21

## Product outcome

A pianist can scan or download a PDF, add it to Noted, find it quickly at the
piano, and read it on a 13-inch iPad with hands-free page advancement.

## Requirements

### Library

- BND-001: The first screen is a search-first library.
- BND-002: A user can create, edit, and delete a piece with title, composer,
  favorite, optional opus/catalogue number, optional musical key, optional source URL,
  optional listening URL, and optional notes. Opus and key are free text, trimmed
  and bounded to 100 UTF-8 bytes each; an empty value clears them. They are edited
  in Details, preserved during PDF preparation, and included in JSON/CSV exports.
- BND-003: Choosing a PDF prefills its filename as the editable title.
- BND-004: A user can search title and composer and filter favorites.
- BND-037: Search ignores accents, case and punctuation, so "dvorak" finds
  Dvořák, "op 28 4" finds Op.28/4 and "C#" finds C♯. Every word of a search
  must appear, in any order, in the piece's title, composer, notes or "Also
  known as" names (aliases such as "Moonlight Sonata", set in the details
  dialog and not shown on the library row). `%` and `_` are ordinary
  punctuation, never wildcards. Catalogue numbers and keys match however
  either side wrote them: "op 28 no 4", "op28/4" and "Opus 28, Nr. 4" are
  all op28 no4; "BWV 846" is bwv846; "K. 545" and "KV 545" are k545; "Hob.
  XVI:52" is hobxvi52 (D., L., S., HWV, RV, BB, WoO and Sz. likewise); and
  "c# minor", "c-sharp minor" and "cis-moll" are all csharpminor. "es-dur"
  means eflatmajor; bare keys such as "Eb", "E♭" and "C#" match either major
  or minor mode. Key terms match as a whole,
  preventing "c# minor" from matching F♯ minor plus Chopin. Explicit opus and
  music_key columns supplement title, composer, aliases and notes; old pieces
  start with empty values, without inferring metadata from titles. Each field is
  parsed separately. S/D/L catalogues require a dot or the start of a field,
  and N°/Nº mean No. The API and web app share one fold and these
  search terms, tested against `testdata/search-fold-vectors.json`; the API
  stores each piece's folded text followed by the search terms it lacks, so
  exact search needs no database extension. The library loads the
  user's pieces once, as summaries carrying that folded text instead of the
  notes, and filters, searches and sorts them on the device as the user types;
  it reloads them after a save or delete. Whole-term matches rank above prefixes (Op. 10 before Op. 101). Within
  each group, a search lists titles that start with it first, then pieces where every word starts a word, then the rest,
  each group in the chosen sort, and only ever matches the searcher's own
  pieces. The API and web app share the composer surname rule too, tested
  against `testdata/composer-surname-vectors.json`.
- BND-040: Eligible searches also request **Similar matches**, even when exact
  local matches exist. The separate section never rewrites the query or changes
  exact filtering, ranking, highlighting, saved URLs or reader behavior. Each
  original term must match exactly or (alphabetic terms of at least four letters)
  by word similarity. Short, numeric, catalogue and joined musical-key terms remain exact. Full exact
  matches are excluded before the eight-result limit; owner, status and favorite
  filters apply before that limit. Default-view searches include Shelved pieces.
  Suggestions use the existing folded search text with a pg_trgm GIN index and
  a transaction-local 0.6 word-similarity threshold. Rachmaninov/Rachmaninoff/
  Rachmaninow work directly. Tchaikovsky/Tschaikowsky have raw scores 0.4 and
  0.3888889, so only that named pair receives explicit bidirectional query-token
  expansion, with each alternative still tested at 0.6. This is not an identity
  merge, a display-name change or a change to stored/exact search text.
  Requests debounce for 250 ms, cancel on query/filter/session changes, and
  ignore superseded responses. Errors leave local results usable. Queries are
  limited to 200 UTF-8 bytes/eight terms, with a two-second request deadline and
  local database statement/lock timeouts. Each API process permits four requests
  per second per user with an eight-request burst; throttling is retriable.
  Migration 13 bounds index-build lock/time waits; rollback removes only the
  index and retains the potentially shared pg_trgm extension.
- BND-035: Each piece is Learning, Playing or Shelved (new and existing pieces
  start as Playing), separate from Favorite, and its status can be changed from
  the library row or the details dialog. One library menu, the same quiet
  menu as the Sort (green check on the current choice), filters by
  Learning & Playing (the first-time default), All, Favorites, Learning,
  Playing or Shelved. A search never hides a Shelved piece in the default view.
  The library opens on the filter the user last chose, stored on the server so
  it follows them across devices.
- BND-036: A quiet "Sort" menu on the piece-count line orders the library by
  Title (the first-time default), Composer (by surname), Recently played,
  Recently added or Fresh (least recently played first, never-played pieces
  leading). Favorites are not pinned. A piece's last play is its reader
  state's last save. Under Recently played and Fresh each row says when it was
  last played. With the search empty, a Continue row offers the piece with a
  PDF played most recently in the whole library, whatever the filter or its
  status, if that was within the last 14 days. It has the usual row actions
  (Listen, status, favorite, edit), and the list below leaves that piece out so
  it never shows twice; while searching there is no Continue row and the piece
  shows among the results. The sort is remembered per user on the server, like
  the filter.
- BND-005: Selecting a piece with a PDF opens its reader directly.
- BND-006: A user can add or replace the one PDF attached to a piece through
  Prepare (Add PDF, or Edit or replace PDF, in the details dialog). There is no
  direct upload.
- BND-007: Production users sign in with one of the explicitly allow-listed,
  verified Google accounts.
- BND-008: Each piece, its PDF, notes, source and listening URLs, favorite state,
  and reader state are private to its owning user.
- BND-019: When a listening URL is present, the library exposes a safe outbound
  Listen action that opens the recording in a new tab without opening the reader.
- BND-009: A user cannot discover, fetch, or mutate another user's piece by
  guessing its identifier.

### Composer browsing and explicit spelling merges

Browse composers files owned pieces by the first token of a surname-first Go
key: “Chopin, Frédéric” and “Frédéric Chopin” both file as “chopin frederic”,
while “Chopin” files as “chopin”. Exact display spellings remain distinct;
IMSLP names are not rewritten. A shared surname is a filing aid, not proof of
identity: C. P. E. Bach and J. S. Bach remain separate choices. Empty composer
values have a “Composer unknown” group. The details field suggests existing
owned spellings and counts, with keyboard selection and unrestricted free text.

Merge composer spellings starts with nothing selected. The user chooses exact
spellings, types a target display name, reviews the affected owned pieces, then
explicitly confirms “Merge N pieces”. A changed matching set or composer value
invalidates that preview; the user must review again. A successful atomic merge
changes composer, derived keys/search text and metadata modification time only.
PDFs, aliases, notes, status, favorites, preparation revisions and reader state
are preserved. A failure keeps both existing data and the user's selections.

Derived composer keys retain their exact source name and a version marker.
During a mixed-version deployment, new readers compute a correct key for stale
rows written by older replicas. Bounded, resumable background repair updates
only derived columns, never display names or modification times. The additive
schema stays in place when rolling back API images; destructive down migrations
are not a production rollback procedure.

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
  its safe stored filename, so they can edit it outside Noted before replacing it
  through Prepare. A PDF saved by Prepare is named after the piece title; pieces
  uploaded before Prepare keep their original filename.

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
2. Optionally add a listening URL, add its PDF through Prepare, and find it by title or composer.
3. Download the current PDF from the edit dialog and verify its filename (the piece title).
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
backend download proxy is included. Work search queries IMSLP directly through
the API as the user types; there is no local catalogue. Choosing a work stores
its link, prefills title and composer and opens it on IMSLP, and the downloaded
PDF can be added with the file picker or dropped onto the IMSLP panel. See
`imslp-live-search-plan.md`. On an iPad, the Send to Noted iOS Shortcut shares a
PDF from Safari's PDF viewer or Files straight into Noted. Send to Noted creates
a new draft from a shared PDF, prefilled from the work when IMSLP names one; it
never fills an existing draft. Noted serves the signed Shortcut template at
`/send-to-noted.shortcut`. See `send-to-noted-shortcut-plan.md`,
`send-to-noted-simplifications-plan.md` and `send-to-noted-shortcut.md`.

Safety of the Send to Noted token:

- Each user has at most one shortcut token. It is created, replaced and turned
  off from the Account dialog. The token is shown once, and only its SHA-256
  is stored.
- The token authenticates exactly one route, `POST /api/shortcut/import`, which
  can only create a new draft for the token's owner. It cannot read, list,
  finalize or delete anything, and no other route accepts it. That route
  accepts no session cookie, and development mode still requires the token.
- The owner must still be allowed to use Noted (allow-listed in Google mode,
  the seeded learner in development). Signing out does not revoke the token;
  Turn off does, and deleting the user removes it.
- Imports are limited to 10 per user per minute. The log records one line per
  import (the user), never the filename or the token. The template file holds
  only a placeholder token; a personal Shortcut's iCloud link carries the
  token and must never be shared.

Originals needed by the current saved manifest or an open draft remain private.
Superseded, unreferenced files enter a durable deletion queue; drafts expire after
seven inactive days. Limits are the configured file limit, 200 MiB per draft,
10 prepared pages, 20 active drafts per owner, and 20 megapixels per photo.
A saved score longer than 10 pages cannot be opened for page editing, so its PDF
cannot be replaced in Noted; the details dialog says so instead of offering the
action. A draft never starts from a partial copy.
Revision checks prevent stale saves; repeat finalization returns the same piece.
Unchanged preparation preserves original output bytes and reader state; content
changes reset position/page/zoom while retaining reading mode and scroll speed.

Saving a PDF whose exact SHA-256 already belongs to another piece in the same
user's library still saves the requested copy. Prepare then says “Already in
your library as…” and offers Open saved copy and Open existing piece. Both
copies remain independently readable; the completed draft cannot be saved or
discarded again. Retrying finalization returns the same piece and resolves the
warning against current owned pieces, excluding the saved target. Unedited
single-PDF imports retain their original bytes; visually similar or re-encoded
files are not treated as identical. No warning reveals another user's library.
The details dialog also warns while typing a trimmed, folded title already in
the loaded library, excluding the piece being edited. This is advisory: the
user can still save the title.

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

Preparation saves conflict when the saved piece's content (its PDF or prepared
pages) changes while a draft is open. The newer piece and the draft are both
retained. The error directs the user to start a new preparation from the current
piece; reloading the stale draft cannot update its base revision. Metadata edits
made elsewhere, such as title or favorite, do not conflict: saving the draft
applies only the metadata fields the draft itself changed and keeps the others.


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
There is no source-choice dialog. The secondary details-without-PDF action,
offered only when starting a new piece, removes its empty draft before opening the
existing metadata form; the PDF is added later with Add PDF. Library rows expose
Listen, favorite and an Edit details action with accessible labels; Add PDF (Edit
or replace PDF once one exists) lives inside the details dialog and opens Prepare,
and unfinished drafts appear as rows with a Resume action. PDF pages, including
IMSLP downloads, retain removal, reordering and extraction controls.

### Musical search rollout (migration 14, fold version 3)

Migration 14 adds empty optional `opus` and `music_key` fields; it does not infer
metadata or change timestamps. Apply it before starting the new API. Startup
refolds derived search text before serving requests. During a rolling update,
old API replicas can still write the previous search representation after that
startup pass. After **all old API writers and in-flight writes have drained**,
run the new image's `/app/noted-migrate refold-search` command once through the existing
migration-job database credential path, then verify key search. This final job
is a rollout completion gate; it requires no application shutdown. The command
has a five-minute deadline and atomically recomputes only `search_text` and the
fold marker, never piece metadata, ownership or modification times. It rejects
a newer fold marker, and is safe to repeat after a timeout/failure or rollback.

Retain the additive columns when rolling an API image back. An older API can
again write old search text; after re-upgrading and draining those writers,
repeat the final refold job. Do not use the destructive down migration as an
image rollback procedure. Physical iPad Safari and pedal checks remain separate
from automated viewport checks.
