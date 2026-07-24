# Noted Binder Visual Direction

Status: Accepted “Title Page” direction adapted for the digital binder
Last updated: 2026-07-23

## Baseline

The selected visual baseline remains the version-two “Title Page” concept:

![Noted Title Page baseline](concepts/noted-v2-title-page-baseline.png)

The binder carries forward its ivory paper, ink typography, forest-green accent,
hairline rules, typographic hierarchy, and absence of card chrome. The baseline
sets the visual language, not the archived dashboard information architecture.

## Library

- The Library is the first screen and the product’s primary working surface.
- “Noted” is a quiet wordmark; “Library” is the page’s strongest type.
- Search by title or composer is prominent and underlined rather than boxed.
- Favorites are a compact filter next to search.
- Pieces are hairline-separated rows, not covers or cards.
- Each row prioritizes title, composer, PDF availability, and page count.
- Add is the single green pill action. Edit, favorite, and delete use familiar
  line icons with accessible labels.
- Metadata and PDF upload use one square-edged modal with a bordered drop zone.

## Reader

- The reader is an immersive `100dvh` route with a dark neutral surround and a
  white PDF page. The actual score is the visual asset.
- A safe-area-aware top bar holds back, title/composer, and page position.
- A compact dark toolbar floats above the bottom safe area and auto-hides after
  inactivity. It wraps into stable rows on narrow phones.
- Page mode uses left/right tap zones, horizontal swipes, and keyboard/pedal
  input. Auto-scroll mode uses a green play/pause control, speed slider, and
  zoom controls.
- Forest green indicates the active mode and primary action. There is no
  playback cursor, notation highlighting, annotation entry, or practice UI.
- Auto-scroll pages retain clear gaps and render only near the viewport.

## Responsive behavior

- Primary touch targets are at least 44px.
- The target is a 13-inch iPad in portrait, with desktop and phone layouts also
  remaining complete and non-overlapping.
- The library search/filter row stacks on phones.
- Reader controls may wrap but must never hide a required control off-screen.
- Safe-area insets are applied to the reader bars, modal footer, and page shell.

## Excluded visual patterns

- No dashboards, weekly metrics, practice progress, bottom navigation, or
  intermediate piece-detail page.
- No decorative sheet music, cover-art grid, gradient illustration, or floating
  page-section cards.
- No shadows in the library. Modals use a border and raised paper tone.
