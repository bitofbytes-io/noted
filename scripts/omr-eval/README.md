# OMR evaluation harness

This harness compares MusicXML produced by an engine or processing stage against the committed,
CC0 references in `testdata/omr/manifest.json`. Detailed output is written beneath the globally
ignored `.local/omr-eval/` tree.

It reports:

- XML/container parse success and score/part/measure/event counts;
- per-part, per-measure duration integrity using active divisions and time signatures;
- underfull, overfull, implicit-underfull, and cursor-before-start measures;
- measure-count similarity;
- per-measure multiset precision/recall/F1 for MIDI-equivalent pitch, rhythm
  `(onset, duration, rest)`, and combined pitch/rhythm events (parts are pooled so equivalent
  one-part/two-part piano encodings remain comparable);
- a DOM-free alphaTab `1.8.4` import check with master-bar start/duration ticks, consistent
  staff timing, and at least one timed pitched note;
- aggregate JSON and Markdown scorecards.

Pitch/rhythm comparison currently aligns measures by index and pools parts within each measure. It
is intentionally simpler than the pipeline's measure-alignment algorithm and will penalize every
later measure after an inserted or omitted measure. The metrics compare playable structure, not
engraving layout, articulation fidelity, dynamics, lyrics, or perceptual musical quality.

## Evaluate precomputed output

Place files under `.local/omr-eval/outputs/<engine>/<fixture-id>.musicxml` (or `.mxl`/`.xml`), then:

```sh
python3 scripts/omr-eval/evaluate.py
```

Individual candidates can be supplied explicitly:

```sh
python3 scripts/omr-eval/evaluate.py \
  --candidate audiveris:clean-simple=/path/to/result.musicxml
```

Use the references themselves to smoke-test the full evaluator and alphaTab gate:

```sh
python3 scripts/omr-eval/evaluate.py --include-reference-baseline
```

## Optionally invoke an engine

`--engine` accepts a name and an argv template. It does not invoke a shell. Available placeholders
are `{input}`, `{reference}`, `{output}`, `{output_dir}`, and `{fixture_id}`.

```sh
python3 scripts/omr-eval/evaluate.py \
  --engine 'audiveris=scripts/run-audiveris-docker.sh {input} {output_dir}'
```

If an engine writes exactly one MusicXML file beneath `{output_dir}`, the harness discovers it. A
wrapper may instead write directly to `{output}`. Standard output/error and generated scores remain
under `.local/omr-eval/outputs/`. Commands time out after ten minutes by default.

This hook is deliberately generic: Audiveris, homr, repaired output, and fused output should each
have a distinct engine/pipeline name so before/after reports stay comparable.

The committed `moonlight-style-implicit-tuplets` fixture is the focused input for comparing default Audiveris output, the `ProcessingSwitches.implicitTuplets=true` run, and the routed worker. Use distinct candidate names so the report retains all three results.

## Tests

After `make setup`, run:

```sh
python3 -m unittest discover -s scripts/omr-eval/tests -v
```

The tests use only Python's standard library plus the repository's exact pinned alphaTab Node
dependency. No recognizer or downloaded scan is required.
