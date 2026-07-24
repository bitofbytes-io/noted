# ADR 0001: Browser score rendering and synthesized playback

Status: Accepted for the POC
Date: 2026-07-13

## Decision

Use:

- Mozilla PDF.js `6.1.200` behind `PdfScoreAdapter` for authenticated PDF display, page navigation, fit-to-width, fit-to-page, HiDPI canvas rendering, cancellation, and cleanup.
- alphaTab `1.8.4` behind `NotationPlaybackAdapter` for MusicXML import, responsive notation engraving, stable master-bar identities, MIDI generation, SoundFont synthesis, tempo scaling, inclusive tick ranges, and looping.
- A small Noted-owned Web Audio adapter for the standalone metronome.

The Angular routes for the two large score engines are lazy-loaded. Library APIs do not leak into the other feature components.

## Focused spike evidence

The spike used the committed original two-staff, eight-measure piano fixture at `testdata/fixtures/noted-exercise.musicxml` and its generated PDF counterpart.

| Candidate | PDF / notation | Real audio | Measure/range support | Browser and mobile considerations | Result |
|---|---|---|---|---|---|
| [PDF.js](https://mozilla.github.io/pdf.js/examples/) | PDF display-layer API renders individual pages to canvas and supports deliberate scaling | N/A | Page identity is explicit | The [PDF.js compatibility FAQ](https://github.com/mozilla/pdf.js/wiki/frequently-asked-questions) reports Safari 16.4+ as generally usable, with some feature defects | Selected for PDF |
| [alphaTab](https://www.alphatab.net/docs/introduction) | Imports and engraves MusicXML; the [MusicXML compatibility table](https://alphatab.net/docs/formats/musicxml/) calls support mature but documents incomplete advanced-element coverage | Built-in TinySoundFont-based synthesis using a SoundFont; no fake transport | Score master bars expose indexes/start ticks/durations, while the API exposes `playbackRange`, looping, restart, pause, and playback speed | Uses Web Audio and documents Safari support. Audio must begin after a user gesture on iOS. The API exposes `destroy()` for cleanup | Selected for MusicXML/playback |
| [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) | Strong browser MusicXML-to-SVG renderer | Public release describes playback as work in progress/early access | Its parsed model exposes measures, but a separate timing/synth pipeline would be required | More moving parts and two sources of measure identity | Rejected for this POC |
| [Verovio](https://www.verovio.org/) | Strong SVG engraving, with MusicXML conversion/import and MIDI output | The [Verovio reference](https://book.verovio.org/verovio-reference-book.pdf) notes that browser MIDI playback is not built in | Time maps/MIDI can support ranges after additional mapping | WASM plus a separate browser synth and lifecycle would expand the spike | Rejected for this POC |

The alphaTab docs recommend bundler plugins for workers and audio worklets, but current Angular's application builder does not expose the required Vite/webpack plugin hook. The verified POC configuration therefore sets `core.useWorkers=false` and uses alphaTab's documented `WebAudioScriptProcessor` output fallback. Font and SoundFont files are copied from the pinned npm package into the Angular build. This trades some long-score responsiveness for a small, working and isolated Angular integration.

## Validation and limitations

- Current desktop Chrome: the checked-in fixture must render eight identifiable measures, load the bundled SONiVOX SoundFont, produce audible piano synthesis after a click, change effective tempo, restart, and loop numeric ranges. Results are recorded in `docs/implementation/verification.md`.
- Portrait iPad-sized browser viewport: layout, range editor, compact controls, and resource cleanup are exercised in browser verification.
- Physical iPad Safari was not available to this overnight build and is not claimed. Real-device audio unlock, interruption recovery, memory pressure on long scores, and page relayout remain a release follow-up.
- alphaTab's own compatibility table reports partial MusicXML coverage. Imported files with unsupported notation may render imperfectly even when playback succeeds.
- Worker-free operation can block the main thread on long or dense scores. The POC fixture is intentionally small; before broad catalog use, either move the Angular build to a supported alphaTab bundler integration or test a supported worker asset arrangement.
- Tempo is implemented as playback-speed scaling relative to the imported score's base tempo. The displayed BPM is the requested effective pulse.
- The bundled SoundFont is used only from the pinned alphaTab distribution; uploaded scores never include or select arbitrary SoundFonts.

## Failure behavior and fallback

PDF-only works remain first-class: they are readable, can be associated with explicit practice, and are labeled as lacking playback. If MusicXML import, font loading, SoundFont loading, or audio initialization fails, the player shows the real error and a raw authenticated MusicXML download instead of pretending to play. The smallest next fallback would pair OpenSheetMusicDisplay with a separately verified MusicXML-to-MIDI/Web Audio pipeline while preserving the existing adapters.

Every reader/player component cancels active rendering and destroys its adapter on route teardown. The standalone metronome stops its interval and closes its `AudioContext` on teardown.
