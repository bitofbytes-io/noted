# Noted Digital Binder v1 Requirements

Status: Authoritative implementation scope
Last updated: 2026-07-25

## Product outcome

A pianist can scan or download a PDF, add it to Noted, find it quickly at the
piano, and read it on a 13-inch iPad with hands-free page advancement.

## Requirements

### Library

- BND-001: The first screen is a search-first library.
- BND-002: A user can create, edit, and delete a piece with title, composer,
  favorite, optional source URL, and optional notes.
- BND-003: Choosing a PDF prefills its filename as the editable title.
- BND-004: A user can search title and composer and filter favorites.
- BND-005: Selecting a piece with a PDF opens its reader directly.
- BND-006: A user can upload or replace the one PDF attached to a piece.
- BND-007: Production users sign in with one of the explicitly allow-listed,
  verified Google accounts.
- BND-008: Each piece, its PDF, notes, favorite state, and reader state are
  private to its owning user.
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
synthesized or reference playback, annotations, IMSLP fetching, photo
stitching, sharing, and offline mode are not part of v1.

## Acceptance flow

1. Add a piece from a phone or desktop, using the filename-prefilled title.
2. Upload its PDF and find it by title or composer.
3. Favorite it and verify the favorites filter.
4. Open it directly from the library.
5. Turn pages with taps, a swipe, and PageDown/ArrowRight.
6. Switch to auto-scroll, adjust speed and zoom, pause, leave, and return.
7. Verify the prior mode, position, zoom, and speed are restored.
