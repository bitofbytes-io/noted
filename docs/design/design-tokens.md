# Noted: Design Tokens — "Title Page" (v2)

Status: Accepted 2026-07-18
Baseline concept: `concepts/noted-v2-title-page-baseline.png`
Supersedes the v1 white/cobalt palette for all UI work going forward.

## Design intent

The v2 direction is a typographic, placard-minimal interface inspired by the engraved
title page of a printed score:

- Content sits directly on a warm ivory background. No cards, no shadows; structure
  comes from whitespace and thin rules.
- Ink-black typography carries the hierarchy. The current work's title is set very
  large, centered, and framed by two horizontal rules like an engraved title page.
- A single deep forest-green accent is reserved for primary actions (Resume),
  progress indicators, and the active navigation item.
- Sheet music never appears as decoration. Notation is shown only inside the score
  player, where it owns the entire surface.

## Color tokens

| Token | Value | Usage |
| --- | --- | --- |
| `--paper` | `#F6F1E7` | App background. Content sits directly on it. |
| `--paper-raised` | `#FCFAF4` | Optional surface for modals/popovers only. |
| `--ink` | `#1A1A1A` | Primary text, icons, the two hero rules. |
| `--ink-muted` | `#6E6759` | Secondary text: composers, metadata, captions. |
| `--ink-faint` | `#948C7C` | Placeholder text, disabled labels. |
| `--line` | `#DDD6C6` | Hairline dividers between sections and list rows. |
| `--line-strong` | `#B9B09E` | Input underlines, emphasized borders. |
| `--green` | `#1E4D3B` | Accent: primary buttons, active nav, progress, links. |
| `--green-dark` | `#163B2D` | Hover/pressed state of `--green`. |
| `--green-soft` | `#E7EDE6` | Quiet green tint: selected rows, notices. |
| `--danger` | `#A63A2E` | Errors and destructive actions (warmed to sit on ivory). |
| `--danger-soft` | `#F5E4E0` | Error surfaces. |
| `--warning-soft` | `#F3EBD3` | Validation/warning surfaces (player validation bar). |
| `--focus-ring` | `rgba(30, 77, 59, 0.25)` | 3px focus ring on interactive elements. |

Rules:

- `--green` is the only accent. Do not reintroduce cobalt blue.
- White (`#FFFFFF`) is reserved for text/icons on green fills and for the score
  player's notation surface. It is not a general background.
- Contrast: `--ink` on `--paper` ≈ 14.9:1; `--green` on `--paper` ≈ 7.5:1; white on
  `--green` ≈ 8.0:1. Keep `--ink-muted` at 12px+ only.

## Typography tokens

Font stack (unchanged): `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.

| Token | Size / spec | Usage |
| --- | --- | --- |
| `--type-display` | `clamp(40px, 7vw, 72px)`, weight 500, tracking `-0.03em`, line-height 1.05 | Hero work title on Home. |
| `--type-h1` | `clamp(28px, 4vw, 40px)`, weight 600, tracking `-0.03em` | Page titles (Library, Practice…). |
| `--type-h2` | `clamp(19px, 2vw, 24px)`, weight 600, tracking `-0.02em` | Section titles. |
| `--type-h3` | `16px`, weight 650 | Subsection / list-item titles. |
| `--type-body` | `15px`, weight 400, line-height 1.6 | Body copy. |
| `--type-meta` | `12px`, weight 500 | Metadata, timestamps, percentages. |
| `--type-overline` | `11px`, weight 700, tracking `0.16em`, uppercase | Small-caps labels: “NOW PRACTICING”, field labels, composer bylines. |

Rules:

- Composer attribution under a work title is set as letterspaced uppercase
  (`--type-overline`) in `--ink` or `--ink-muted`, echoing engraved title pages.
- No serif faces; the engraved feel comes from spacing, small caps, and rules.

## Space, size, and shape tokens

| Token | Value | Usage |
| --- | --- | --- |
| `--space-1…7` | `4, 8, 12, 16, 24, 40, 64px` | Base spacing scale. |
| `--space-hero` | `clamp(48px, 9vh, 112px)` | Breathing room above/below the hero placard. |
| `--page-max` | `760px` | Max content width for placard pages (Home). |
| `--page-max-wide` | `1100px` | Max width for utility pages (Library, Settings). |
| `--page-pad` | `clamp(20px, 5vw, 48px)` | Horizontal page padding. |
| `--rule` | `1px solid var(--line)` | Section hairline. |
| `--rule-hero` | `1.5px solid var(--ink)` | The two rules framing the hero title. |
| `--radius-0` | `0` | Inputs, tables, chips, popovers — hard edges. |
| `--radius-pill` | `999px` | Primary action buttons only. |
| `--nav-height` | `64px` | Bottom navigation bar. |
| `--tap-min` | `44px` | Minimum touch target. |

## Elevation and motion

- No box shadows anywhere in the main app. Modals/popovers use `--paper-raised`
  plus a `--line-strong` border.
- Transitions: `150ms ease` for color/opacity; `250ms ease` for reveal/dismiss
  (e.g. player controls). Honor `prefers-reduced-motion` by disabling movement
  while keeping state changes instant.

## Component recipes

### Title-page hero (Home)

- Centered block, max-width `--page-max`, vertical margin `--space-hero`.
- Order: top rule (`--rule-hero`) → overline “NOW PRACTICING” → work title
  (`--type-display`) → composer in small caps → one metadata line
  (`--type-meta`, `--ink-muted`, e.g. `BWV 846 · 76% learned`) → bottom rule.
- Single primary pill button below the lower rule: `--green` fill, white text,
  play icon, `--radius-pill`, min-height 48px. Hover `--green-dark`.

### Quiet list rows (Up next, Library results)

- No card chrome: rows separated by `--rule`, vertical padding `--space-4`.
- Title in `--ink` weight 600; composer in `--ink-muted`; progress as small
  `--green` dots or a `--type-meta` percentage right-aligned.

### Inputs and search

- Transparent background on `--paper`, no box: a `--line-strong` bottom border
  only, `--radius-0`. Focus: border becomes `--green` with `--focus-ring`.
- Standard form inputs (Settings, dialogs) may use a full 1px border, still square.

### Bottom navigation

- Five destinations: Home, Library, Metronome, Practice, Settings.
- Thin line icons (1.5px stroke) with 11px labels; active item in `--green`
  (filled icon variant), inactive in `--ink`.
- Bar background `--paper` with a top `--rule`; height `--nav-height` plus safe area.

### Weekly metrics strip

- One line: `This week · 4h 35m · 5 of 7 days` in `--type-meta`, followed by seven
  Mon-first day markers (checkmarks or filled squares) in `--green` /`--line`.
- No bar charts on Home; fuller charts belong to the Practice page.

### Score player

- Unchanged in structure (immersive `100dvh`, white notation surface, compact
  floating controls, lower-left pencil), but re-accented: beat cursor, playback
  highlights, and primary controls move from cobalt to `--green`.

## Drop-in stylesheet block

Replace the `:root` block in `web/src/styles.scss` with:

```css
:root {
  --paper: #f6f1e7;
  --paper-raised: #fcfaf4;
  --ink: #1a1a1a;
  --ink-muted: #6e6759;
  --ink-faint: #948c7c;
  --line: #ddd6c6;
  --line-strong: #b9b09e;
  --green: #1e4d3b;
  --green-dark: #163b2d;
  --green-soft: #e7ede6;
  --danger: #a63a2e;
  --danger-soft: #f5e4e0;
  --warning-soft: #f3ebd3;
  --focus-ring: rgba(30, 77, 59, 0.25);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 40px;
  --space-7: 64px;
  --space-hero: clamp(48px, 9vh, 112px);
  --page-max: 760px;
  --page-max-wide: 1100px;
  --page-pad: clamp(20px, 5vw, 48px);
  --radius-0: 0;
  --radius-pill: 999px;
  --nav-height: 64px;
  --tap-min: 44px;

  color-scheme: light;
  font-family:
    Inter,
    ui-sans-serif,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}
```

## Migration map from v1 variables

| v1 (`styles.scss`) | v2 replacement | Notes |
| --- | --- | --- |
| `--blue` | `--green` | All accent uses. |
| `--blue-dark` | `--green-dark` | Hover/pressed. |
| `--blue-soft` | `--green-soft` | Notices, status chips, selected states. |
| `--ink` | `--ink` | Value warms from `#101217` to `#1A1A1A`. |
| `--muted` | `--ink-muted` | Warm gray replaces cool gray. |
| `--paper` | (delete) | White cards are removed; card chrome goes away. |
| `--canvas` | `--paper` | The ivory background is now the only canvas. |
| `--line` | `--line` | Warm hairline value. |
| `--line-strong` | `--line-strong` | Warm value. |
| `--danger` | `--danger` | Warmed value; add `--danger-soft` surface. |
| `--success` | `--green` | Success and accent intentionally share the green. |
| `.card` (border + shadow) | remove | Replace with hairline-separated sections. |
| `.button` (square cobalt) | pill green primary | Secondary buttons: transparent, 1px `--ink` border, square. |
| `.notice` (blue-left-border) | `--green-soft` + `--green` border | Same pattern, new palette. |

## Out of scope for this document

Exact iconography, the Learn-mode visual treatment, dark mode, and print styles.
Dark mode, if added later, must define a parallel token set rather than ad-hoc colors.
