# OMR production-readiness record

Date: 2026-07-18

This record is the release ledger for the dual-engine OMR worker described by
[ADR 0002](../decisions/0002-audiveris-ocr-pipeline.md). It deliberately separates a
predeclared decision rule from the subsequently observed representative-score
results.

## Owner decision recorded before representative evaluation

On 2026-07-18, before the representative private/public-domain score run, the
product and production owner:

- authorized evaluation of a small rights-cleared private score set from
  `.local/` and of downloaded public-domain scores, with no private input,
  output, title, or notation committed;
- approved running production OMR computation on the AMD64 `bahamut` NAS, not
  on the Raspberry Pi Crystal Swarm;
- approved the quality, runtime, memory, cancellation, and cleanup thresholds
  below; and
- approved proceeding to the concrete dependency/model inventory and final
  informed activation decision.

The representative-score results were not available when this decision rule
was recorded.

## Acceptance rule and owner amendment

The candidate is accepted only if all of these conditions hold:

1. Every representative input produces final MusicXML that parses, passes the
   exact alphaTab 1.8.4 gate, and has valid measure timing.
2. On every score with an independently sourced structured reference, aggregate
   event F1 is not worse than the raw Audiveris baseline and no individual score
   regresses by more than 5.0 F1 points.
3. Each score runs with a two-CPU, 4-GiB container limit; peak memory remains
   below 4 GiB and bounded scratch remains below 1 GiB. The worker retains a
   ten-minute runaway deadline as a safety boundary.
4. Cancellation terminates child recognizers, leaves no partial response or
   imported asset, and removes the request directory. Startup cleanup removes a
   deliberately planted stale request directory.
5. Readiness verifies the exact direct component versions and all six ONNX
   checksums without runtime network access.

Reference-free scores can prove structural/playability/resource behavior but
cannot satisfy or fail the F1 rule. Synthetic project-authored fixtures remain
the reference-qualified accuracy set unless a rights-cleared independent
MusicXML reference is available for a representative score.

During the representative run, after candidate 2 exposed two remaining
correctness defects, the owner amended the priority: elapsed time is
observational and must not drive recognition shortcuts or release tuning until
correctness is established. A slower candidate is preferred when it produces a
better score. The CPU, memory, scratch, cancellation, and runaway limits remain
safety controls, not speed targets. In this record, "100% correctness" means
that every item in the fixed corpus passes parsing, meter/timing, and exact
alphaTab playability checks. Reference-free scans do not prove note-for-note
accuracy, so performance optimization remains deferred even after that
structural gate passes.

## Representative corpus fixed before execution

Private inputs are recorded only by non-identifying hash and page count:

| Class | Pages | SHA-256 | Rights/evaluation role |
|---|---:|---|---|
| Private real scan A | 3 | `998da5dd1aa082aedba7171c88247a1d33cfd2c9289fdce68f6126d982f71517` | Operator-authorized, ignored local input; structural/resource evidence only |
| Private real scan B | 3 | `588dec347aed8ab85793d2cc466f6a3f048a6bee7c7fc9e83d4888183c5715d4` | Operator-authorized, ignored local input; structural/resource evidence only |
| [Mutopia Greensleeves](https://www.mutopiaproject.org/ftp/Traditional/GreensleevesAcc/GreensleevesAcc-let.pdf) | 1 | `d4c66022a48451239698e067500361355b3a8d321bfc4ec34178414e5573b39c` | Public-domain typesetter statement in PDF; simple accompanied score |
| [Mutopia Bach Invention 12](https://www.mutopiaproject.org/ftp/BachJS/BWV783/bach-invention-12/bach-invention-12-a4.pdf) | 4 | `d19f089c57e3cb3055bacf04eb1549037c4ccf19283b764b7d42d127709a3320` | Public-domain typesetter statement in PDF; multi-page polyphony |
| [Mutopia Chopin Prelude Op. 28 No. 4](https://www.mutopiaproject.org/ftp/ChopinFF/O28/Chop-28-4a/Chop-28-4a-let.pdf) | 1 | `fe0282a45168aa0ca484a79feddf6570c27cbf123c74a557d8a210a2f882ee11` | Public-domain typesetter statement in PDF; chordal piano texture |

Downloaded files, worker responses, reports, and resource traces live only
under ignored `.local/omr-production-eval/` paths.

## Candidate result

Candidate 1 passed two of five representative inputs. Candidate 2 fixed the
meterless common-time case and passed three of five. Its remaining failures
were independently reproduced from captured recognizer output:

- a dynamic marking placed outside a valid 4/4 bar caused the validator to
  reject the bar's notes and substitute a genuinely overfull alternate; and
- music21's probabilistic corrector rewrote a correctly recognized 12/8 source
  meter to 4/4 while correcting unrelated measures.

Candidate 3 counts only notes and rests when measuring rhythmic duration,
repositions out-of-bar non-rhythmic directions to the nearest valid musical
onset, and restores every explicit source meter after probabilistic repair.
Focused replays passed before the complete from-PDF rerun.

Locked local image:

- image: `sha256:36e453957ee292c8b55c96e7f81cb25dcb2a8a336f29be65f423b3972c62e927`
- uncompressed image size: 1,592,238,908 bytes;
- runtime: AMD64, UID/GID 10001, read-only root filesystem, all capabilities
  dropped, no-new-privileges, two CPUs, 4 GiB memory with no swap headroom,
  512 PID ceiling, 1-GiB executable tmpfs, and an internal Docker network; and
- embedded tests: 12 Python repair/fusion tests and three alphaTab tests pass.

### Representative result

Every input produced parseable MusicXML and passed alphaTab 1.8.4 with valid
bar timing. Runtime is recorded but was not used to choose or tune the
candidate.

| Input | Result | Selected output | Measures | Stable ticks | Elapsed | Peak memory | Peak request scratch |
|---|---|---|---:|---:|---:|---:|---:|
| Private real scan A | Pass | Audiveris | 43 | 165,120 | 320 s | 1,345.5 MiB | 20,340,977 B |
| Private real scan B | Pass | Fusion | 67 | 257,280 | 349 s | 1,184.8 MiB | 21,024,080 B |
| Greensleeves | Pass | Fusion | 33 | 95,040 | 110 s | 1,181.7 MiB | 16,235,520 B |
| Bach Invention 12 | Pass | Fusion | 21 | 120,960 | 386 s | 1,484.8 MiB | 18,750,716 B |
| Chopin Prelude Op. 28 No. 4 | Pass | Fusion | 26 | 99,840 | 154 s | 1,303.6 MiB | 17,358,604 B |

The fixed-corpus structural/playability gate is therefore 5/5 (100%). Peak
memory was 1,484.8 MiB of 4 GiB and peak request scratch was 21,024,080 bytes
of 1 GiB. The longest observation was 386 seconds. No speed optimization was
performed.

The reference-qualified synthetic benchmark remains the accuracy evidence:
aggregate event F1 improved from 94.7% for raw Audiveris to 95.9% for the final
pipeline, rhythm F1 from 97.0% to 97.9%, and duration validity from 97.9% to
100%. Pitch F1 changed from 99.2% to 99.1%; the 0.1-point difference is within
the predeclared five-point individual-regression ceiling. Reference-free real
scores are not represented as note-perfect.

### Safety and reproducibility result

- A real client disconnect during active preprocessing cancelled the worker
  context, terminated the child recognizer, removed the request directory on
  the first post-cancellation check, emitted no partial score/report, and
  logged `code=cancelled`.
- Startup stale-directory cleanup and deadline termination are covered by the
  worker tests and were also exercised against the candidate runtime.
- Offline readiness verified Audiveris 5.10.2, HOMR 0.7.0, music21 10.3.0,
  alphaTab 1.8.4, a clean constrained Python environment, and all six recorded
  ONNX checksums on a container with no network.
- AlphaTab fonts and soundfonts are absent, and music21's encoded corpus data
  is absent; required runtime modules and license files remain.

## License and activation decision

The concrete inventory is in `omr/THIRD_PARTY_NOTICES.md`. It records the direct
runtime licenses and exact model files/checksums, plus the upstream gaps in
model-card/training-data provenance. The inventory is an engineering record,
not legal advice. Final activation remains limited to the private, non-public
worker topology; public/commercial image distribution requires a fresh review.
