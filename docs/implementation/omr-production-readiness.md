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

## Frozen acceptance rule

The candidate is accepted only if all of these conditions hold:

1. Every representative input produces final MusicXML that parses, passes the
   exact alphaTab 1.8.4 gate, and has valid measure timing.
2. On every score with an independently sourced structured reference, aggregate
   event F1 is not worse than the raw Audiveris baseline and no individual score
   regresses by more than 5.0 F1 points.
3. Each score completes within the worker's ten-minute deadline with a two-CPU,
   4-GiB container limit; peak memory remains below 4 GiB and bounded scratch
   remains below 1 GiB.
4. Cancellation terminates child recognizers, leaves no partial response or
   imported asset, and removes the request directory. Startup cleanup removes a
   deliberately planted stale request directory.
5. Readiness verifies the exact direct component versions and all six ONNX
   checksums without runtime network access.

Reference-free scores can prove structural/playability/resource behavior but
cannot satisfy or fail the F1 rule. Synthetic project-authored fixtures remain
the reference-qualified accuracy set unless a rights-cleared independent
MusicXML reference is available for a representative score.

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

Pending execution against the final locked candidate image.

## License and activation decision

Pending review of the concrete inventory in `omr/THIRD_PARTY_NOTICES.md`. The
inventory is an engineering record rather than legal advice. Activation is
limited to the private, non-public worker topology; public/commercial image
distribution is outside this approval.
