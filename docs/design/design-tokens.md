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
Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
```

| Role | Specification |
| --- | --- |
| Library title | `clamp(42px, 7vw, 72px)`, weight 550, line-height 1 |
| Section heading | `26px`, weight 650 |
| Piece title | `19px`, weight 650, line-height 1.25 |
| Body | `15px`, weight 400, line-height 1.6 |
| Metadata | `11–12px`, weight 600 |
| Overline | `11px`, weight 700, `0.16em` spacing, uppercase |

Letter spacing is zero except for uppercase overlines and metadata labels.
Long titles wrap; compact reader titles truncate with an ellipsis.

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

At least 112px high on large screens, with a small white document mark, title,
composer, page metadata, and 44px favorite/edit icon buttons. Rows use
`--line`; hover/focus uses `--green-soft`.

### Primary action

Green fill, white icon and label, 48px minimum height, pill radius, and
`--green-dark` hover/pressed state.

### Reader

Near-black full viewport, white page canvases, fixed top bar, and bottom toolbar
with 44px controls. Active mode and play use `--green`. Reader bars use
translucent neutral black and subtle white borders. On phone widths the toolbar
wraps so zoom remains visible without horizontal scrolling.
