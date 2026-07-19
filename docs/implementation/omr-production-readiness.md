# OMR production-readiness record

Date: 2026-07-18

This record is the release ledger for the dual-engine OMR worker described by
[ADR 0002](../decisions/0002-audiveris-ocr-pipeline.md). It deliberately separates a
predeclared decision rule from the subsequently observed representative-score
results. This is separately authorized post-POC production-readiness work; it
does not add OMR or production deployment to the POC scope.

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

Evaluated local image:

- image: `sha256:36e453957ee292c8b55c96e7f81cb25dcb2a8a336f29be65f423b3972c62e927`
- uncompressed image size: 1,592,238,908 bytes;
- runtime: AMD64, UID/GID 10001, read-only root filesystem, all capabilities
  dropped, no-new-privileges, two CPUs, 4 GiB memory with no swap headroom,
  512 PID ceiling, 1-GiB executable tmpfs, and an internal Docker network; and
- embedded tests: 12 Python repair/fusion tests and three alphaTab tests pass.

The review-hardening rebuild is
`sha256:0750ec50ff7268327f3dd1e0e55cccff7e671cdeb7b14c4545e038d0847a8a64`
(1,592,239,285 bytes). Its worker binary, pipeline files, and every ONNX byte
are identical to the evaluated image; the rebuild adds the checked-in manifest
and build-time filename/hash enforcement. All embedded tests pass again.

A subsequent review found that restoring source time signatures after
probabilistic repair also removed a useful inferred meter when the source had
no explicit signature in that later measure. Candidate 5 restores only meters
that were explicit in the recognizer output, preserves inferred later changes,
and adds a focused regression test. The final reviewed local image is:

- image: `sha256:829e0a50f101f3a2757bebc7eb5cbef9709b8a8da6feb6e76ec46692d90a9295`;
- uncompressed image size: 1,592,240,630 bytes; and
- embedded tests: 13 Python repair/fusion tests and three alphaTab tests pass.

Candidate 5 is the post-POC OMR promotion artifact. The representative corpus
was rerun from the frozen input hashes after that review fix. Its activation
remains governed by the production gates in this record rather than the POC
acceptance criteria.

### Representative result

Every input produced parseable MusicXML and passed alphaTab 1.8.4 with valid
bar timing. Runtime is recorded but was not used to choose or tune the
candidate.

| Input | Result | Selected output | Measures | Stable ticks | Elapsed | Peak memory | Peak request scratch |
|---|---|---|---:|---:|---:|---:|---:|
| Private real scan A | Pass | Audiveris | 43 | 165,120 | 318 s | 1,444.9 MiB | 20,340,977 B |
| Private real scan B | Pass | Fusion | 67 | 257,280 | 356 s | 1,035.3 MiB | 21,024,080 B |
| Greensleeves | Pass | Fusion | 33 | 95,040 | 114 s | 1,237.0 MiB | 16,235,520 B |
| Bach Invention 12 | Pass | Fusion | 21 | 120,960 | 392 s | 1,419.3 MiB | 18,750,716 B |
| Chopin Prelude Op. 28 No. 4 | Pass | Fusion | 26 | 99,840 | 150 s | 1,280.0 MiB | 17,358,604 B |

The fixed-corpus structural/playability gate is therefore 5/5 (100%) on the
final candidate. Candidate-5 peak memory was 1,444.9 MiB of 4 GiB. The scratch
figures shown are the candidate-3 per-request trace; candidate 5 completed every
item inside the same hard 1-GiB tmpfs bound, and its only runtime change occurs
after engine scratch artifacts are produced. The highest measured request
scratch remains 21,024,080 bytes. The longest candidate-5 observation was 392
seconds. No speed optimization was performed or used as a selection signal.

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
  ONNX checksums on a container with no network. The checked-in model manifest
  also rejects a changed filename set or hash during the image build.
- AlphaTab fonts and soundfonts are absent, and music21's encoded corpus data
  is absent; required runtime modules and license files remain.

## NAS production deployment and acceptance

The reviewed worker is active for private use on `bahamut`, a Synology DS920+
with an Intel J4125 (`linux/amd64`), 8 GiB of RAM, DSM 7.3.2, and more than
6.8 TiB free on `volume1`. The private registry reference is immutable:

- image: `registry.tail209cfc.ts.net/noted-omr:00656dc`;
- manifest digest: `sha256:c8bce4a5410abaea8551043acab782f0d4f4150fe5af790d152474eb3b143905`;
- image-config digest: `sha256:5de0a6634f55a935bb37e98409cf444b0b36bfdea2881d2cb4673c861ab817fb`;
  and
- platform: AMD64 only. The Crystal Swarm deployment contains only the ARM64
  API and UI services; no recognizer image or OMR compute task is scheduled on
  a Raspberry Pi.

The NAS worker runs as UID 10001 with all capabilities dropped,
`no-new-privileges`, a read-only root filesystem, a 1-GiB executable tmpfs,
4 GiB of memory with no swap headroom, bounded logs, two BLAS threads, and CPU
affinity restricted to CPUs 0 and 1. DSM exposes neither the CPU nor PID cgroup
controller on this host, so the requested two-CPU and 512-process boundaries
are enforced by `sched_setaffinity` and `RLIMIT_NPROC=512`; readiness fails if
those fallback controls are absent. The worker receives only its dedicated
bearer secret and a fixed private address on an internal, no-egress Docker
network.

A separate 128-MiB host-network ingress relay is required because DSM suppresses
published host ports for containers attached only to an internal Docker
network. The relay uses Python's standard library from the same immutable image,
runs as UID 10001 with a 64-process rlimit, has no secret, no writable root, no
capabilities, and forwards only to the fixed worker address. DSM firewall rules
are ordered so `192.168.10.0/24` (the Crystal application network) may reach TCP
8788 and every other source is denied before broader NAS allow rules are
considered. A direct request from the Siren LAN host timed out after this policy
was applied, while a fresh production conversion submitted by the Crystal API
entered worker processing and could be cancelled normally.

### NAS-native representative result

The exact published digest reran the frozen five-score representative corpus on
`bahamut`. All five responses were HTTP 200, parseable, duration-valid, and
alphaTab 1.8.4 playable. Every request directory was removed.

| Input | Selected output | Measures | Stable ticks | Elapsed | Peak RSS | Peak request scratch | Corrected / suspect |
|---|---|---:|---:|---:|---:|---:|---:|
| Private real scan A | Audiveris | 43 | 165,120 | 431.8 s | 1,392.9 MiB | 6,276,876 B | 15 / 43 |
| Private real scan B | Fusion | 67 | 257,280 | 490.7 s | 1,087.7 MiB | 7,069,095 B | 63 / 67 |
| Greensleeves | Fusion | 33 | 95,040 | 158.2 s | 1,338.2 MiB | 2,094,847 B | 0 / 33 |
| Bach Invention 12 | Fusion | 21 | 120,960 | 500.4 s | 1,433.1 MiB | 5,140,693 B | 2 / 6 |
| Chopin Prelude Op. 28 No. 4 | Fusion | 26 | 99,840 | 228.6 s | 1,252.8 MiB | 2,944,987 B | — |

Worst-case peak RSS was 1,433.1 MiB of the 4-GiB boundary and maximum observed
request scratch was 7,069,095 bytes (6.74 MiB) of the 1-GiB tmpfs. Runtime is
observational only; none of these measurements was used to shorten or bypass a
recognition stage.

A NAS-native client disconnect was issued while preprocessing and a recognizer
job were both observed. The client was cancelled, the request directory was
gone on the first check 0.3 seconds later, and no job directory remained.
Startup cleanup of a deliberately stale directory also passed. The temporary
evaluation mount and corpus were removed after the run.

### Production application proof

The production Crystal API streamed the public-domain Greensleeves PDF to the
NAS worker and imported the returned 95.3-KiB MusicXML. The pinned version string
was `audiveris+homr audiveris-5.10.2+homr-0.7.0+music21-10.3.0+alphatab-1.8.4`.
The result contained 33 measures, loaded in the production alphaTab player, and
exposed playback controls. The UI retained the source PDF and correctly labeled
the result `Unverified OCR`, with 0 auto-corrected and all 33 measures suspect.
The production-only test work and its derived assets were deleted after this
verification.

The representative, resource, cancellation, cleanup, routing, and private-use
owner-decision gates are therefore satisfied. The worker is accepted for this
private production topology. Public or commercial distribution remains outside
that acceptance and requires a fresh dependency/model and legal review.

## License and activation decision

The concrete inventory is in `omr/THIRD_PARTY_NOTICES.md`. It records the direct
runtime licenses and exact model files/checksums, plus the upstream gaps in
model-card/training-data provenance. The inventory is an engineering record,
not legal advice. On 2026-07-18 the product/production owner explicitly accepted
the inventoried AGPL obligations and residual homr model-provenance risk for
private use only. This satisfies the informed owner-decision gate for the
private, non-public worker topology; public/commercial image distribution
requires a fresh review and owner decision.
