# Noted Rebuild: Digital Sheet-Music Binder

Status: Authoritative plan for the next implementation pass
Last updated: 2026-07-23

## Overview

Rebuild Noted from scratch as a focused digital sheet-music binder: upload PDF scores, find them fast, and play from them on an iPad at the piano with hands-free page advancement. Practice tracking, learning mode, OMR, and MusicXML playback are all removed from scope.

## Product definition

One job: sit at the piano, pull up the iPad, search your digitized pieces, open one, and play from it without touching the screen mid-piece.

### In scope (v1)

- Upload PDF scores (from iPhone document scan, flatbed scanner, or manually downloaded IMSLP PDFs — all arrive as PDFs, no photo stitching).
- Piece metadata: title, composer, favorite, optional source URL and notes. Manual entry with smart defaults (e.g., prefill title from filename); automated metadata is a later enhancement.
- Library: list, search by title/composer, filter favorites.
- Reader optimized for 13-inch iPad Safari: full-screen score, two modes:
  - **Page mode**: fit-to-page, turn via tap zones, swipe, and keyboard PageDown/arrows — Bluetooth page-turn pedals emulate keyboards, so pedal support comes free.
  - **Auto-scroll mode**: continuous vertical scroll at an adjustable speed (lets you zoom wider than one page), tap to pause/resume.
- Per-piece resume: remember last page/position, mode, zoom, and scroll speed.

### Explicitly deferred

Documented, not built: practice tracking and weekly summaries, metronome, learning/lessons, OMR/MusicXML/playback, measure selection, YouTube references, annotations, automated IMSLP fetching (bot-blocked), photo-to-piece stitching, sharing, authentication.

## Codebase reset (same repo, fresh build)

- Move current `docs/` content to `docs/archive/` for reference; write a new concise requirements doc and rewrite `AGENTS.md` to reflect the new scope and invariants.
- Delete old application code: `cmd/`, `internal/`, `web/`, `omr/`, `migrations/`, `scripts/`, old Docker/compose/Makefile targets. Rebuild with the same stack: Angular frontend, Go API, PostgreSQL.
- Keep the safety invariants that still apply: filesystem asset storage behind a Go interface under gitignored `.local/`, opaque storage keys (never user filenames as paths), no committed scores or secrets, rights-safe fixtures in `testdata/`.
- Keep the "Title Page" visual direction and design tokens (`docs/design/design-tokens.md`) — carry those docs forward rather than archiving them.
- v1 is single-user with no auth; production deployment (NAS, Traefik, OAuth) stays a documented follow-up, not a blocker.

## Database

- Local dev keeps the `compose.local.yml` Postgres (user/db `noted`). Reset = drop and recreate only the `noted` database's tables (or simply remove the local `noted-postgres` Docker volume, which contains nothing else). No other databases or roles are touched — same rule applies if pointing at the shared Postgres later.
- New minimal schema (fresh migration 000001):
  - `pieces`: id, title, composer, favorite, source_url, notes, timestamps.
  - `piece_pdfs`: piece_id (unique — one PDF per piece in v1), storage_key, original_filename, size, checksum, page_count, uploaded_at.
  - `reader_states`: piece_id, mode, last_page/scroll_position, zoom, scroll_speed, updated_at.

## API (Go)

Small JSON API: CRUD for pieces, multipart PDF upload attached to a piece, PDF streaming with range-request support (needed for pdf.js on Safari), reader-state get/put, and search (`?q=` on title/composer, `?favorite=true`).

## Frontend (Angular)

- Navigation collapses to Library (home) and the Reader; Settings only if needed.
- Library: search-first layout, favorites surfaced, tap a piece to open the reader directly (piano-side speed is the point — no intermediate detail page unless editing metadata).
- Reader renders with `pdfjs-dist` directly (canvas control needed for auto-scroll and custom chrome): immersive full-viewport route, controls appear on tap and auto-hide, explicit back action — same interaction pattern already validated in the old score player.

## Sequenced goals

1. **Reset**: archive docs, write new requirements + AGENTS.md, delete old code, wipe local DB.
2. **Scaffold**: Go API skeleton, migration 000001, storage interface, Angular shell with design tokens, trimmed Makefile/compose; clean checkout starts with documented commands.
3. **Pieces + upload**: create/edit pieces, upload PDF from phone or desktop browser, list in library.
4. **Find**: search, favorites, library UX tuned for iPad.
5. **Play — page mode**: full-screen reader, tap/swipe/keyboard page turns, fit modes, resume last page.
6. **Play — auto-scroll**: adjustable-speed scroll, pause/resume, per-piece speed memory.
7. **Validate**: real scores on iPad Safari at the piano; API tests (upload safety, search) and reader e2e; verify a Bluetooth pedal or keyboard turns pages.

## Implementation checklist

- [ ] Archive old docs, write new requirements doc, rewrite AGENTS.md
- [ ] Delete old app code and reset local noted database only
- [ ] Scaffold Go API, migration 000001, storage interface, Angular shell, Makefile
- [ ] Piece CRUD and PDF upload with safe filesystem storage
- [ ] Library UI: search, favorites, iPad-friendly layout
- [ ] Full-screen reader with tap/swipe/keyboard page turns and resume
- [ ] Auto-scroll mode with adjustable speed and per-piece memory
- [ ] Tests plus iPad Safari and pedal/keyboard validation, clean-checkout check

## Risks

- iPad Safari PDF rendering performance on large scans — mitigate with page-level canvas virtualization; the old POC already proved pdf.js viable on iPad.
- Auto-scroll "feel" is subjective — ship with a manual speed control and easy pause rather than trying to be clever; smarter scrolling (e.g., per-line) can come later.
