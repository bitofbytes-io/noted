# Synthetic OMR benchmark corpus

This directory contains only original, project-authored score material. The MusicXML references,
rendered notation, and deterministic scan-like transformations are dedicated to the public domain
under CC0-1.0. No IMSLP file, commercial engraving, personal upload, or third-party scan is used.

`manifest.json` is the authoritative fixture index. It records each input/reference pair, traits,
expected structure, SHA-256 checksums, generation tooling, and provenance. The corpus covers:

- a clean grand-staff piano engraving;
- a rasterized, skewed, low-contrast scan simulation with synthetic marks;
- dense three-voice piano notation with chords, rests, accidentals, and 16th notes;
- a forty-measure multi-page score.

The corpus is intentionally synthetic. It is safe and reproducible, but it cannot replace private,
developer-local evaluation on legally held real scans. Put such material under the ignored
`.local/omr-corpus/` directory and never commit the inputs or derived recognition output.

## Rebuild

Install the repository's pinned web dependencies and Playwright Chromium, then run:

```sh
make setup
cd web && npx playwright install chromium && cd ..
node testdata/omr/generate.mjs
```

The generator asserts alphaTab `1.8.4` and Playwright `1.55.1`. It creates the reference MusicXML,
renders genuine notation through alphaTab in a headless browser, prints the score PDFs, applies the
deterministic noisy-scan transformation, normalizes volatile PDF timestamps, and refreshes hashes
and observed page counts in `manifest.json`.

The score content is generated algorithmically by `generate.mjs`; changing that file changes the
musical ground truth. Browser/PDF rendering can still vary across browser builds, so checksum drift
must be reviewed rather than updated blindly.
