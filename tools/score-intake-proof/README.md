# Score intake: tool-only proof

This package runs separately from the app. It does not read production assets,
write database records, or modify application code. Its output is evidence for a
manual review checkpoint, not a production scanner implementation.

## Reproduce

Requirements: Node 22, npm, `pdftoppm` on PATH, and Python with Pillow 12.3.0.
Set `PYTHON` to the selected interpreter when it is not `python3`.

```sh
python3 -m venv .local/score-intake-proof-venv
.local/score-intake-proof-venv/bin/pip install -r tools/score-intake-proof/requirements.txt
export PYTHON="$PWD/.local/score-intake-proof-venv/bin/python"
npm ci --prefix tools/score-intake-proof
npm test --prefix tools/score-intake-proof
npm run proof --prefix tools/score-intake-proof
```

Open `.local/score-intake-proof/index.html`, `review.pdf`, and
`corrected-score.pdf`. All generated inputs, outputs, pixel images, ground truth,
and measurements stay under this ignored directory. The harness preserves its
`external/` subdirectory. It neither fetches URLs nor accepts arbitrary filesystem
paths from a manifest.

The optional `.local/score-intake-proof/external/imslp-02206-bach-bwv846.pdf`
is the public-domain Kroll/Breitkopf 1866 edition from the BWV 846 IMSLP work page.
It must be obtained through the ordinary IMSLP browser flow. Its page 1 is a title
page, page 2 blank, and page 3 starts the music. Missing this file skips the real
edition test explicitly. `external/provenance.json`, when present, documents the
coordinator's exact retrieval evidence; it is not a generalized download API.

## What is measured

`processor.mjs` receives original bytes, manifests, or pixels. It never reads
`ground-truth.json` or imports the fixture generator. Automatic deskew uses
OpenCV line detection; alignment measures detected staff extents against a clean
reference, while conservative all-ink bounds protect titles and footers from crops. Transform values used to generate defects stay in the runner only.
Residual angles and alignment errors are measured from newly rendered outputs.

PDF transformations embed original pages as Form XObjects. Recursive indirect
stream inspection establishes that vector inputs acquire no raster images and
CCITT image compression streams retain their bytes. Both PDF.js and Poppler
render every generated PDF page, including the review booklet. The unchanged
path returns the original bytes after validating the whole manifest.

Phone correction is a manual four-corner operation. Synthetic distortion uses
those corners, so it demonstrates applying a specified correction, **not**
finding page boundaries automatically. Shadow is deliberately retained. No AI
or notation reconstruction is used. PDF ink bounds are supplied by the tool
caller and conservatively padded; production code must never trust a client
claim that cropping cannot clip notation.

`report.json` records results and remaining gates. The CPU/memory figures reflect
the complete Node review-pack generation, not a phone benchmark. Playwright is
pinned for the future browser-runtime gate; this Node proof does not establish
camera behavior, a browser worker, or real iPhone memory use.

## Provenance and review

`fixtures.mjs` is original synthetic score-like artwork created for Noted and
released under CC0-1.0. It includes distinct page IDs, dots, accidentals, ledger
lines, fingering, slurs, and lower-edge marks. It is not copied from a musical
work. The existing repository vector/CCITT fixtures are exercised as regression
inputs; their generators are under `testdata/fixtures/generate/`.

Human review must inspect dots, accidentals, slurs, ledger lines and fingering at
playing size, especially the phone result. Reject an output that clips notation,
softens small marks too far, or changes the apparent music size unexpectedly.
Compare the booklet and actual corrected PDF on the iPad. Do not integrate into
the application until Daniel approves this checkpoint. Real scanner pages and
phone captures can then be added privately under `.local/` if needed.

## Independent review findings

The original repository CCITT fixture is malformed. Its generator concatenates
four independently encoded TIFF Group4 strips (436 rows per strip by default)
into one PDF image stream. PDF.js produces black blocks; Poppler stops early.
Retaining those encoded bytes does **not** establish valid rendering or fidelity.
The source fixture is unchanged and now serves as an explicitly detected known
baseline defect. `generate-ccitt.py` generates a separate proof-local single-strip
version with `RowsPerStrip=1600` and asserts exactly one strip. Its four staves are
checked spatially against the source PNG and across both PDF renderers. The
booklet uses this valid fixture. Stale Poppler page outputs are removed each run.

The processor rejects editing a source page with nonzero `/Rotate`, a nonzero
MediaBox origin, or a CropBox different from its MediaBox. Normalizing those
geometries remains required before broader PDF editing can ship. Unchanged
pass-through preserves all such source bytes. Tests prove explicit rejection
instead of silently losing the source orientation or crop.

`correction-manifests.json` records processing manifests, input/output hashes,
and output filenames, including intermediate operations needed to reconstruct
an export. Photo perspective records manual corners separately. This is proof
provenance, not an application persistence schema.
