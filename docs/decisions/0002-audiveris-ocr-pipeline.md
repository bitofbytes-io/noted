# ADR 0002: Dual-engine OMR and automatic MusicXML correction

Status: Implemented direction; production release acceptance pending
Date: 2026-07-13
Last updated: 2026-07-18

## Context

Noted preserves and reads source PDFs and renders/plays structured MusicXML. The completed POC intentionally required users to supply those representations separately. Active post-POC development now adds an explicit path from an eligible printed PDF to a separate, machine-generated MusicXML asset without moving recognition into the Go API or Angular application.

No recognizer is reliable enough to make its output trusted notation. Audiveris is strong at score structure and produces a private `.omr` correction project; homr has a different, learned recognition path and different failure modes. A useful result must also have coherent measure timing and load in the exact alphaTab importer used by Noted. XML well-formedness alone is insufficient.

The earlier form of this ADR selected only Audiveris and gated all implementation on a future spike. That direction has been superseded. The worker and application integration are implemented as a dual-engine, repair, fusion, and playability pipeline. Benchmark evidence and legal/operational owner acceptance still gate production promotion.

## Decision

Use a private, resource-limited OMR worker with this pipeline:

```text
authorized PDF
  -> render each page at 300 DPI
  -> Audiveris + homr recognition (sequential, CPU-bounded)
  -> music21 repair of each usable engine result
  -> measure alignment and conservative arbitration
  -> worker MusicXML structure/size validation
  -> alphaTab 1.8.4 headless import/timing gate
  -> Go API MusicXML structure/rhythm validation
  -> derived Unverified OCR asset + schema-v1 quality report
```

- OCR begins only after an explicit learner request. Normal upload persists the original first.
- Audiveris is the backbone when its output survives validation and repair. homr becomes the score fallback when Audiveris fails. When both results exist, measures are aligned with Needleman-Wunsch scoring over measure hashes/numbers.
- When both aligned measures agree and have valid timing, confidence is `high`. When the Audiveris measure is invalid and the homr measure is valid, homr replaces it and the correction is recorded. Valid disagreement is retained from the backbone at `medium` confidence; two invalid results are retained only as `low`/suspect input to the final gate.
- A single surviving engine is usable as a score-level fallback, but its measures cannot receive agreement-based `high` confidence. Both engines failing is `conversion_failed`.
- `music21.omr.correctors.ScoreCorrector` is attempted for flagged measures. Underfull non-pickup measures are padded with rests, notation is rebuilt when possible, and the score is re-exported through music21. Repair is conservative and remains `Unverified OCR`; it is not a claim that the source has been reconstructed note-for-note.
- MusicXML `<backup>` and `<forward>` are valid cursor controls used for polyphonic voices. The old blanket claim that alphaTab cannot handle `backup` is incorrect. The actual hazards are cursor movement before a measure, overfull/underfull timing, inconsistent staff/master-bar counts, and other importer-specific failures. The Go validator models `backup`/`forward` timing, and the worker loads the final bytes with alphaTab and checks positive master-bar durations, bounded beat positions, consistent measure counts, and timed beats.
- A final alphaTab failure is returned as stable code `unplayable_output` (`422` at the worker boundary). No derived MusicXML asset is imported for that attempt; the original remains available and the job can be retried.
- Successful output is a separate immutable derived asset linked to the source and job, labeled `Unverified OCR`, and accompanied by a bounded schema-v1 quality report. The UI shows corrected/suspect totals and marks medium/low-confidence measures for review against the PDF.
- The Audiveris `.omr` artifact remains private, optional, bounded, and available only through an authenticated learner-scoped download.
- Noted still does not contain a notation editor and does not promise handwritten-score recognition or guaranteed accuracy.

## Versions and release obligations

The production worker image pins runtime dependencies and fails readiness on version or homr-model checksum drift.

| Component | Pin | License recorded upstream | Release obligation |
|---|---|---|---|
| [Audiveris](https://github.com/Audiveris/audiveris/tree/5.10.2) | `5.10.2` official Ubuntu package; pinned package SHA-256 `9470d15e79dd4fe45f817b8545ba9f8e57ddaebff3b3a1031f21218647602068` | AGPL-3.0 | Preserve license/notices; record the exact package and the launcher heap change from 8 GiB to 2560 MiB; provide the applicable corresponding source and modification information; have the owner review the private-network interaction model. |
| [homr](https://github.com/liebharc/homr/tree/v0.7.0) | `0.7.0` | AGPL-3.0 | Preserve license/notices and provide applicable corresponding source/modification information. Do not assume process or Python-package separation removes AGPL obligations. |
| homr/RapidOCR model weights | downloaded during `homr --init`; six exact ONNX files are enforced by the checked-in build/readiness manifest | Separate artifacts whose provenance and terms must be verified independently | The completed inventory records every weight's filename, source URL, SHA-256, available license/provenance, and citation context. The three homr weights still lack per-weight model cards, licenses, and immutable training-data manifests; private-use acceptance of that residual risk is an explicit owner decision. |
| [music21](https://github.com/cuthbertLab/music21/tree/v10.3.0) | `10.3.0` | BSD-3-Clause for music21 code; bundled corpora/data can have separate terms | Retain the BSD notice. Inventory or remove unused corpus/data rather than treating all package contents as uniformly BSD. The worker uses parsing, OMR correction, notation, and export code only. |
| [alphaTab](https://github.com/CoderLine/alphaTab/tree/v1.8.4) | `1.8.4` in worker and web application | MPL-2.0; package subcomponents/assets can carry their own terms | Preserve MPL notices and make source for any modified MPL-covered files available as required. Record that the worker uses the unmodified npm package; inventory bundled font/SoundFont and package notices separately. |

These are engineering release requirements, not a legal conclusion. The production owner must record an actual review and acceptance for the shipped image. The private worker boundary is a security/operations boundary and is not treated as a substitute for license compliance.

## Quality and release gates

The committed corpus is generated from original project-authored notation under CC0-1.0 and covers clean, noisy/skewed, dense polyphonic, and multi-page inputs. Private real-world scans may be evaluated only from ignored local storage when the operator has the right to use them. Neither inputs nor outputs from private scores may be committed.

The harness reports parse success, alphaTab load/timing success, measure-count similarity, duration-integrity rate, and pitch/rhythm/event F1 against a reference. It must compare, at minimum, Audiveris-only baseline, homr-only, repaired engine outputs, and final fused output. Metrics are diagnostics, not a claim of perceptual or engraving equivalence.

The implemented pipeline was run across the complete four-fixture synthetic corpus on 2026-07-18.
The final pipeline used the production `linux/amd64` image; engine-isolation rows used the same
pinned versions as described in the [benchmark record](../implementation/omr-benchmark.md). A
reference self-check separately proved the manifest and alphaTab/metric plumbing.

| Harness input | Fixtures | Parse | alphaTab | Measure count | Duration valid | Pitch F1 | Rhythm F1 | Event F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Reference self-check | 4/4 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| Audiveris 5.10.2 baseline | 3/4 parsed | 75.0% | 50.0% | 100.0% | 97.9% | 99.2% | 97.0% | 94.7% |
| Audiveris + music21 repair | 3/4 parsed | 75.0% | 75.0% | 100.0% | 100.0% | 98.3% | 97.4% | 94.2% |
| homr 0.7.0 + music21 repair | 4/4 | 100.0% | 100.0% | 100.0% | 100.0% | 97.8% | 98.4% | 93.5% |
| Final fused pipeline | 4/4 | 100.0% | 100.0% | 100.0% | 100.0% | 99.1% | 97.9% | 95.9% |

On this corpus, the final pipeline improves parse coverage by 25 points, alphaTab playability by 50
points, duration integrity by 2.1 points, rhythm F1 by 0.9 points, and event F1 by 1.2 points
relative to raw Audiveris. Pitch F1 falls by 0.1 point. Dense polyphony remains a known tradeoff:
timing becomes valid but pitch/event fidelity is slightly below raw Audiveris, and all eight
measures are flagged for review. The evidence supports an overall improvement claim on this
synthetic corpus, not a universal no-regression or production-quality claim.

Production promotion requires all of the following to be attached to a release candidate. The
current evidence and remaining gates are tracked in the
[production-readiness record](../implementation/omr-production-readiness.md):

1. Actual before/after harness output from the pinned worker image, including every committed fixture and a rights-cleared representative real-score set. Both sets are now recorded; the real-score set is structural/playability evidence because it has no independently sourced MusicXML references.
2. A recorded acceptance threshold chosen by the product/production owner before reviewing the candidate results, plus no regression relative to the Audiveris-only baseline on the reference-qualified measures. The predeclared rule and candidate result are recorded.
3. Resource evidence for the two-CPU, 4-GiB, one-job topology: runtime, peak memory, scratch use, timeout/cancellation, and cleanup on representative multi-page scores. Constrained exact-image evidence exists locally; NAS-native confirmation remains outstanding.
4. Failure-path evidence for one-engine fallback, both-engine failure, malformed/oversized output, report rejection, and `unplayable_output`. Automated coverage and a real local client-disconnect cancellation pass are recorded; NAS-native cancellation/cleanup confirmation remains outstanding.
5. Completed dependency/model license inventory and owner acceptance of AGPL, model-weight, notice, corresponding-source, and distribution/network obligations. The inventory is complete; final informed private-use owner acceptance remains outstanding.

The pipeline is implemented, reviewed, merged, and published as a private AMD64 image. It is not
approved for production activation until the remaining NAS-native resource/cancellation checks and
the final informed owner acceptance are recorded.

## Security and operational invariants

- The worker is private: no Traefik/browser route, bearer authentication from the Go API, no PostgreSQL/OAuth/session credentials, and no authority to select learner assets.
- The worker runs on the AMD64 `bahamut` NAS, not on the ARM Raspberry Pi Crystal Swarm. Crystal hosts the API/UI and database-backed queue orchestration; only the NAS performs recognition, repair, fusion, and the playability gate.
- The worker accepts only bounded PDFs, processes one job at a time, and enforces 25 MiB input/output limits, 25 pages, a two-minute upload deadline, a ten-minute recognition deadline, bounded logs, archive checks, and a 512 MiB post-conversion job-footprint limit. The container runtime supplies the two-CPU, 4-GiB, and scratch-storage ceilings.
- Every job uses isolated HOME/XDG/temp paths with thread counts capped for native math libraries. Temporary job state is removed on terminal requests and stale job directories are removed at startup.
- Runtime outbound networking is denied. All engines, Python dependencies, npm packages, and model weights must be present and checksum-verified in the built image before deployment.
- The Go API owns authorization, database leases, retries/cancellation, source/output lineage, import validation, and opaque asset storage. Failed or cancelled jobs do not import partial output.
- Original PDFs, derived MusicXML, optional `.omr` projects, recognition rows, and quality reports follow coordinated private backup, restore, retention, deletion, and reconciliation policy.

## Consequences

- Recognition can improve or fail independently of the original PDF and the rest of Noted.
- Two engines plus preprocessing, Python repair, Node import validation, and model artifacts make the image larger and the operational/license surface broader.
- Agreement and timing validity provide useful review signals, but confidence is heuristic and remains visibly unverified.
- The pipeline can degrade to a single surviving engine, while the final alphaTab gate prevents a known-unplayable result from being delivered as a playable asset.
- A future manual correction workflow can use the retained Audiveris project or an external MusicXML editor without committing Noted to a full notation editor.
