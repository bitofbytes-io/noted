# OMR auto-correction benchmark

Date: 2026-07-18

This record evaluates the implemented OMR pipeline against the four committed, project-authored
CC0-1.0 fixtures in `testdata/omr/`. It answers whether the automatic pipeline improved
OCR-to-playable-MusicXML quality relative to the Audiveris-only baseline; it is not production
acceptance evidence for arbitrary or private scores.

## Method

- Inputs cover a clean score, a noisy/skewed score, dense piano polyphony, and a two-page score.
- Every final pipeline run used the production `linux/amd64` worker image with 300-DPI shared
  preprocessing, Audiveris 5.10.2, homr 0.7.0, music21 10.3.0, and alphaTab 1.8.4.
- The Audiveris-only baseline used the official native 5.10.2 release on the same source PDFs. The
  homr-only row used homr 0.7.0 in CPU mode against the pipeline's 300-DPI page images. These
  single-engine runs isolate engine behavior but are not a claim of bit-identical container
  execution.
- `audiveris-repaired` runs the same music21 repair stage over every usable Audiveris result.
- Parse and alphaTab percentages use all four fixtures as the denominator. Fidelity and duration
  means include only parsed candidates. Measure-index alignment pools parts within a measure, so
  equivalent one-part and two-part piano encodings remain comparable without allowing events to
  drift between measures.
- The ignored machine-readable result is regenerated with
  `python3 scripts/omr-eval/evaluate.py --outputs-root <outputs> --report-dir <report>`.

## Aggregate result

| Engine/pipeline | Parse | alphaTab | Measure count | Duration valid | Pitch F1 | Rhythm F1 | Event F1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Audiveris raw | 75.0% | 50.0% | 100.0% | 97.9% | 99.2% | 97.0% | 94.7% |
| Audiveris + repair | 75.0% | 75.0% | 100.0% | 100.0% | 98.3% | 97.4% | 94.2% |
| homr + repair | 100.0% | 100.0% | 100.0% | 100.0% | 97.8% | 98.4% | 93.5% |
| Final fused pipeline | 100.0% | 100.0% | 100.0% | 100.0% | 99.1% | 97.9% | 95.9% |

The final pipeline improved the measured outcome overall: parse coverage rose from 75% to 100%,
alphaTab playability rose from 50% to 100%, duration integrity rose from 97.9% to 100%, rhythm F1
rose by 0.9 points, and event F1 rose by 1.2 points. Aggregate pitch F1 fell by 0.1 point, so this is
not a universal no-regression result. homr's score-level fallback is what recovered the noisy
fixture after Audiveris failed; repair made the parseable dense Audiveris result pass the stricter
playability check.

## Important fixture-level result

| Dense-polyphony stage | Duration valid | Pitch F1 | Rhythm F1 | Event F1 |
|---|---:|---:|---:|---:|
| Audiveris raw | 93.8% | 97.7% | 91.1% | 84.0% |
| Audiveris + repair | 100.0% | 94.9% | 92.2% | 82.6% |
| Final fused pipeline | 100.0% | 96.4% | 91.6% | 83.6% |

Repair and fusion made this fixture duration-valid but slightly reduced pitch and event fidelity.
The final pipeline correctly leaves all eight measures flagged because the engines disagree. This
tradeoff is why results remain `Unverified OCR`. The product-owner threshold and rights-cleared
representative real-score corpus were subsequently completed before private production acceptance.

The clean, noisy, and corrected two-page final outputs each scored 100% on the reported parse,
alphaTab, measure-count, duration, pitch, rhythm, and event checks. The two-page run returned 40
measures; its report marked four as suspect and none as auto-corrected.

## Resource observation

The two-page production-image run completed in 198.41 seconds under `linux/amd64` emulation on an
Apple-silicon development host with the requested two-CPU and 4-GiB container limits. Observed
peak memory was 1.214 GiB. A point-in-time scratch sample was about 16.5 MiB and container block
writes were 64.9 MB. This demonstrates headroom for this fixture. The subsequent exact-digest
NAS-native representative, resource, cancellation, cleanup, and production-application acceptance
run is recorded separately in the [production-readiness record](omr-production-readiness.md).

## Conclusion

On the committed synthetic corpus, automatic correction and fallback improve OCR-to-playable
MusicXML overall, primarily by eliminating the single-engine failure and duration defect. They do
not improve every fidelity metric on every fixture. The predeclared threshold, rights-cleared
real-score set, NAS-native resource/failure evidence, model/license inventory, and private-use
owner decision were subsequently completed and are recorded in the production-readiness ledger.
