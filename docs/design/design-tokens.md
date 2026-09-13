# Noted Binder Design Tokens

Status: Accepted “Title Page” tokens adapted for binder v1
Last updated: 2026-07-23

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#F6F1E7` | Library background |
| `--paper-raised` | `#FCFAF4` | Modal surface |
| `--ink` | `#1A1A1A` | Primary type and icons |
| `--ink-muted` | `#6E6759` | Composer and secondary metadata |
| `--ink-faint` | `#948C7C` | Placeholders and tertiary metadata |
| `--line` | `#DDD6C6` | Row and section hairlines |
| `--line-strong` | `#B9B09E` | Inputs, PDF marks, modal border |
| `--green` | `#1E4D3B` | Primary action and selected reader mode |
| `--green-dark` | `#163B2D` | Hover and pressed action |
| `--green-soft` | `#E7EDE6` | Selected or hovered library row |
| `--danger` | `#A63A2E` | Destructive action and errors |
| `--danger-soft` | `#F5E4E0` | Error surface |
| `--focus-ring` | `rgba(30, 77, 59, 0.25)` | Focus outline |

White is reserved for PDF pages and text/icons on green. Forest green is the
only product accent. The reader surround and chrome use neutral near-black
rather than a second accent family.

## Typography

Font stack:

```css
'Inter Variable', Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
```

Inter is self-hosted through the `@fontsource-variable/inter` package and
imported once in `web/src/styles.scss`. No font is fetched from a third-party
CDN. The variable font is what makes the 550 and 600 weights render exactly.

| Role | Specification |
| --- | --- |
| Library title | `clamp(42px, 7vw, 72px)`, weight 550, line-height 1 |
| Page heading (Prepare) | `clamp(30px, 4vw, 40px)`, weight 600 |
| Section heading | `22–26px`, weight 600 |
| Piece title | `19px`, weight 600, line-height 1.25 |
| Body | `15px`, weight 400, line-height 1.6 |
| Metadata and field labels | `13px`, weight 500–600, sentence case |

Letter spacing is zero everywhere. No interface text is uppercase, and there are
no eyebrow or overline labels above headings. Counters (page numbers, zoom, result
counts) use tabular numerals. Long titles wrap; compact reader titles truncate
with an ellipsis.

## Space and shape

| Token | Value |
| --- | --- |
| `--space-1…7` | `4, 8, 12, 16, 24, 40, 64px` |
| `--page-max-wide` | `1100px` |
| `--page-pad` | `clamp(20px, 5vw, 48px)` |
| `--tap-min` | `44px` |

- Inputs, rows, dialogs, toolbars, and secondary buttons have square corners.
- The one primary command may use a `999px` pill.
- Main-app structure uses whitespace and rules, not shadows or floating cards.
- Dialogs use `--paper-raised` and a `--line-strong` border.

## Interaction

- Color and opacity transitions use `150ms ease`.
- Reader chrome reveal/hide uses `250ms ease`.
- `prefers-reduced-motion` removes movement while retaining immediate state
  changes and all position feedback.
- Focus uses a 3px `--focus-ring` with 2px offset.
- Pointer and keyboard interactions must expose the same commands.

## Component recipes

### Search

Transparent background, search icon, 17px input text, and one
`--line-strong` bottom rule. The filter sits beside it on wide layouts and
below it on phones.

### Piece row

At least 112px high on large screens, with a small white document mark that
carries the page count, title, composer, and 44px favorite and edit icon buttons
in `--ink-muted` that turn `--green` on hover. A labeled Listen link appears
only when a listening URL exists. Rows use `--line`; hover/focus uses
`--green-soft`. Unfinished drafts use the same row with a dashed mark and a
Resume button.

### Buttons

Shared recipes live in `web/src/styles.scss` and are used by every screen:

| Class | Recipe |
| --- | --- |
| `.btn-primary` | Green fill, white label, 48px, pill radius, `--green-dark` hover |
| `.btn-secondary` | Transparent, 1px `--ink` border, square, `--green-soft` hover |
| `.btn-quiet` | Transparent, no border, `--ink-muted` text; `.accent` for green, `.danger` for red |
| `.icon-button` | 44px square, icon only, requires `aria-label` |

Only one `.btn-primary` is visible per screen.

### Fields

`.field` wraps a 13px/600 sentence-case label above a square input on
`--paper-raised` with a `--line-strong` border that turns `--green` on focus.

### Reader

Near-black full viewport, white page canvases, fixed top bar, and bottom toolbar
with 44px controls. Active mode and play use `--green`. Reader bars use
translucent neutral black and subtle white borders. On phone widths the toolbar
wraps so zoom remains visible without horizontal scrolling.
