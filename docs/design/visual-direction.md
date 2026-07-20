# Noted: Visual Direction

Status: Version-two "Title Page" direction selected
Last updated: 2026-07-18

## Version-two visual baseline — "Title Page"

The following concept is accepted as the visual baseline for the UI rebuild:

![Noted version-two Title Page baseline](concepts/noted-v2-title-page-baseline.png)

It was selected on 2026-07-18 after three rounds of dashboard exploration. The
authoritative token specification and component recipes live in
`design-tokens.md`; that document controls colors, typography, spacing, and
component treatments for implementation.

### What defines v2

- Warm ivory background (`#F6F1E7`) with ink-black typography and a single deep
  forest-green accent (`#1E4D3B`). Cobalt blue is retired.
- Typographic, placard-minimal dashboard: the current work's title is the hero,
  set very large and framed by two thin horizontal rules like the engraved title
  page of a printed score. No sheet-music preview on the dashboard.
- No cards and no shadows; structure comes from whitespace and hairline rules.
- One primary action on Home: a green "Resume practice" pill below the hero.
- A short "Up next" queue as quiet text rows with small green progress dots.
- A single understated search field on Home (delegating to Library search).
- Weekly metrics compressed to one line with seven Monday-first day markers;
  fuller charts live on the Practice page.
- The "Recently imported" panel and the multi-column repertoire table are removed
  from Home; that information lives in Library.
- Bottom navigation unchanged: Home, Library, Metronome, Practice, Settings.
- The score player keeps its immersive structure and white notation surface,
  re-accented from cobalt to forest green.

### Exploration history

- Round 1 tested score-preview heroes in five palettes; the notation-as-decoration
  approach was rejected for the dashboard.
- Round 2 tested typographic heroes; the centered placard-minimal option was
  preferred.
- Round 3 refined the placard direction; the "Title Page" variant (framed hero
  rules, ivory/ink/forest green) was selected.

The v1 material below is retained for history. Where v1 and v2 conflict, v2 and
`design-tokens.md` control.

## Version-one visual baseline (superseded)

The following refined concept was the visual baseline for the first version:

![Noted version-one visual baseline](concepts/noted-v1-visual-baseline.png)

It establishes the intended palette, spacing, typography, navigation, dashboard hierarchy, and score-player character. It does not lock exact dimensions, data fields, icons, or interaction behavior; those will be validated through functional wireframes and implementation.

## Selected baseline

The first generated concept—utilitarian black, white, and cobalt blue—is the current preferred direction.

Later generated refinements drifted too far from this baseline. Future visual edits should begin with the first concept and preserve its layout unless a specific element is being tested.

![Noted utilitarian blue concept](concepts/noted-concept-01-utilitarian-blue.png)

This is a direction-setting mockup rather than an approved screen design. Labels, navigation, data, proportions, and individual controls remain open to revision.

## Elements to preserve

- Clear, practical hierarchy.
- Predominantly white interface with black typography, crisp boundaries, and the selected cobalt-blue accent.
- A familiar mobile-app structure with recognizable icon-based bottom navigation.
- An information-rich dashboard that preserves generous whitespace and does not feel cramped.
- Prominent search.
- Current repertoire at the top of the dashboard so the learner can resume quickly.
- Repertoire presented as a table rather than a cover grid.
- Immediate visibility of recent practice and imports.
- Weekly practice metrics that can be understood at a glance.
- Score notation occupying nearly the entire reading surface.
- Compact floating playback controls.
- A separate, unobtrusive entry into annotation mode.
- Practical typography and hard-edged controls.

## Elements requiring reconsideration

- Bottom navigation includes Playlists, which is not a current requirement and should be removed.
- The final bottom-navigation destinations need to be chosen while preserving the familiar mobile-app feel.
- Work status and progress percentages have not yet been defined.
- The score reader needs explicit behavior for hiding and revealing controls.
- Measure-range selection and loop configuration in the playback bar need a clearer interaction design.
- The exact relationship among Library, dashboard, search, tags, composers, and settings needs an information-architecture pass.
- The mockup uses two landscape-style devices in the comparison board; the actual score experience must be validated specifically for a 13-inch iPad in portrait orientation.
- Weekly metrics must support a configurable week start or a clearly defined Monday default.

## Next design pass

The next iteration should retain the visual language while testing:

1. A simplified phase-one dashboard focused on resume, search, and recent imports.
2. A portrait score reader with both controls-hidden and controls-visible states.
3. An annotation-active state with only pencil and eraser.
4. A work-details screen showing the work, editions, score assets, source information, and learner status.

The immediate refinement will show dashboard and score player together and apply these interaction decisions:

- Bottom navigation: Home, Library, Metronome, Practice, Settings.
- Monday-first weekly metrics.
- Work-details-first behavior as the current hypothesis.
- Explicit Start Practice action.
- Measure numbers visible in structured scores.
- A single compact measure-range control, such as `Measures 9–16`. Tapping it opens a small popover containing only start and end measure numbers.
- A standalone pencil button in the lower-left corner enters markup mode, following familiar document-editing conventions.

An intermediate refinement proposed removing dashboard search and keeping search only in Library. The accepted baseline later restored the original dashboard search. For the POC, the dashboard field may delegate to the same Library search behavior; there is no separate Search navigation destination. The Metronome destination provides quick access to a basic metronome and its sound/configuration settings.

## Refinement feedback

- Dashboard and Library search should share one search behavior rather than become independent implementations.
- The center bottom-navigation destination should be Metronome rather than Search.
- The score player should use fewer visible controls and preserve more visual calm.
- The separate unexplained `m. 9` numeric control should be removed.
- Loop endpoints should not appear as two large Set Start/Set End buttons in the persistent bar.
- The compact playback bar should show the current range as `Measures #-#`; range editing is disclosed only after tapping it.
- The pencil should remain visually independent in the bottom-left corner rather than being absorbed into the playback bar.

## Baseline correction

The next accepted revision returns to the first concept and changes only:

- Weekly metrics begin on Monday.
- Bottom navigation is Home, Library, Metronome, Practice, Settings.
- The duplicate top-right settings gear is removed because Settings already exists in bottom navigation.
- The top-right account/profile control remains.

The original dashboard search, Play/Learn switch, Continue Practicing table, whitespace, metrics, recently imported list, score layout, floating playback bar, and independent lower-left pencil are preserved.

This correction was accepted as a good first-version direction on 2026-07-13.

## Current feature priority reflected in design

1. Store/find pieces and play them back.
2. Track practice and show useful weekly metrics.
3. Annotate scores.

Annotation entry should remain visible as a future-capable affordance, but it should not dominate the initial score-player design.

## Immersive structured-score behavior

The structured score player is a full-viewport `100dvh` reading surface rather than a page inside the normal application frame. Only `/player/:assetId` hides the global Noted header and bottom navigation. The player keeps an explicit safe-area-aware back action, and the normal shell returns immediately after navigation away from the route.

The score is the primary interaction surface. A tap/click on notation or keyboard activity reveals the compact controls; they fade after three seconds without activity. Controls remain visible while notation is loading, an error needs attention, focus is within the controls, or the measure-range editor is open. Interacting with a control restarts the inactivity period rather than dismissing the controls.

Playback position is always legible: a cobalt vertical beat cursor is paired with current-beat/note highlighting. The cursor freezes on pause, returns to the applied range start on restart, and follows range/loop changes. Reduced-motion mode retains this information with stepped cursor movement and no cursor animation. The persistent `Measures #-#` label always reflects the applied range; unvalidated draft edits never replace it.
