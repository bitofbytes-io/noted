#!/usr/bin/env python3
"""Normalize one recognizer's MusicXML and report conservative rhythmic repairs."""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any

import music21
from music21 import converter, meter, note, stream
from music21.omr import correctors

VERSION = "1"


def _fraction(value: Any) -> Fraction:
    return Fraction(value).limit_denominator(4096)


def _score_from_path(path: Path) -> stream.Score:
    parsed = converter.parse(path, forceSource=True)
    if isinstance(parsed, stream.Opus):
        scores = list(parsed.scores)
        if not scores:
            raise ValueError(f"no score in {path.name}")
        parsed = scores[0]
    if not isinstance(parsed, stream.Score):
        wrapped = stream.Score()
        wrapped.insert(0, parsed)
        parsed = wrapped
    if not list(parsed.parts):
        raise ValueError(f"no parts in {path.name}")
    return parsed


def combine_pages(paths: list[Path]) -> stream.Score:
    if not paths:
        raise ValueError("at least one engine output is required")
    result = copy.deepcopy(_score_from_path(paths[0]))
    result_parts = list(result.parts)
    for path in paths[1:]:
        page = _score_from_path(path)
        page_parts = list(page.parts)
        if len(page_parts) != len(result_parts):
            raise ValueError("page outputs disagree on part count")
        for target, source in zip(result_parts, page_parts, strict=True):
            next_number = len(list(target.getElementsByClass(stream.Measure))) + 1
            for measure in source.getElementsByClass(stream.Measure):
                appended = copy.deepcopy(measure)
                appended.number = next_number
                next_number += 1
                target.append(appended)
    return result


def _assign_unique_part_ids(score: stream.Score, preferred: list[str] | None = None) -> list[str]:
    """Assign stable report-safe IDs, retaining source IDs only when unique."""
    parts = list(score.parts)
    source_ids = [str(part.id or "").strip()[:100] for part in parts]
    counts = {part_id: source_ids.count(part_id) for part_id in set(source_ids) if part_id}
    assigned: list[str] = []
    used: set[str] = set()
    for index, part in enumerate(parts, start=1):
        preferred_id = preferred[index - 1] if preferred is not None and index <= len(preferred) else ""
        source_id = source_ids[index - 1]
        candidate = preferred_id or (source_id if source_id and counts.get(source_id) == 1 else f"P{index}")
        if not candidate or candidate in used:
            candidate = f"P{index}"
        suffix = 2
        base = candidate[:96]
        while candidate in used:
            candidate = f"{base}-{suffix}"[:100]
            suffix += 1
        part.id = candidate
        assigned.append(candidate)
        used.add(candidate)
    return assigned


def _measure_hash(measure: stream.Measure) -> str:
    """Return music21's rhythm-oriented hash for measure alignment."""
    try:
        return correctors.MeasureHash(measure).getHashString()
    except Exception:
        events: list[str] = []
        for event in measure.recurse().notesAndRests:
            pitch = "R" if event.isRest else ".".join(p.nameWithOctave for p in event.pitches)
            events.append(f"{pitch}:{_fraction(event.duration.quarterLength)}")
        return "|".join(events)


def _measure_signature(measure: stream.Measure) -> str:
    """Return a stable semantic signature for cross-engine agreement checks."""
    events: list[str] = []
    for event in measure.recurse().notesAndRests:
        pitch = "R" if event.isRest else ".".join(p.nameWithOctave for p in event.pitches)
        try:
            offset = _fraction(event.getOffsetInHierarchy(measure))
        except Exception:
            offset = _fraction(event.offset)
        events.append(f"{offset}:{pitch}:{_fraction(event.duration.quarterLength)}")
    return f"{_measure_hash(measure)}||{'|'.join(events)}"


def _expected_duration(measure: stream.Measure) -> Fraction | None:
    # music21 derives ``Measure.barDuration`` from the measure's own contents
    # when no time signature is present. That makes an overfull OMR measure
    # appear valid by definition. alphaTab instead applies common time to a
    # MusicXML score without an explicit meter, so use the effective inherited
    # signature and the same 4/4 default here.
    try:
        signature = measure.timeSignature or measure.getContextByClass(meter.TimeSignature)
        duration = _fraction(signature.barDuration.quarterLength) if signature is not None else Fraction(4)
    except Exception:
        return None
    return duration if duration > 0 else None


def _actual_duration(measure: stream.Measure) -> Fraction:
    # ``Measure.highestTime`` includes directions and other non-rhythmic
    # objects. OMR engines occasionally place a dynamic or expression beyond
    # the barline; that must not make an otherwise valid voice look overfull
    # or cause fusion to replace its notes with an inferior engine result.
    event_ends: list[Fraction] = []
    for event in measure.recurse().notesAndRests:
        try:
            offset = _fraction(event.getOffsetInHierarchy(measure))
        except Exception:
            offset = _fraction(event.offset)
        event_ends.append(offset + _fraction(event.duration.quarterLength))
    return max(event_ends, default=Fraction(0))


def _non_rhythmic_overflow(measure: stream.Measure, expected: Fraction) -> bool:
    for element in measure.elements:
        if isinstance(element, (note.GeneralNote, stream.Stream)):
            continue
        try:
            if _fraction(element.getOffsetBySite(measure)) > expected:
                return True
        except Exception:
            continue
    return False


def _rebase_non_rhythmic_overflow(measure: stream.Measure) -> bool:
    """Move out-of-bar directions to the nearest valid musical onset."""
    expected = _expected_duration(measure)
    if expected is None:
        return False
    onsets: set[Fraction] = set()
    for event in measure.recurse().notesAndRests:
        try:
            offset = _fraction(event.getOffsetInHierarchy(measure))
        except Exception:
            offset = _fraction(event.offset)
        if 0 <= offset < expected:
            onsets.add(offset)
    valid_onsets = sorted(onsets) or [Fraction(0)]
    changed = False
    for element in list(measure.elements):
        if isinstance(element, (note.GeneralNote, stream.Stream)):
            continue
        try:
            offset = _fraction(element.getOffsetBySite(measure))
        except Exception:
            continue
        if offset <= expected:
            continue
        target = min(valid_onsets, key=lambda onset: abs(offset - onset))
        measure.setElementOffset(element, float(target))
        changed = True
    return changed


def _is_pickup(measure: stream.Measure, measure_index: int, actual: Fraction, expected: Fraction) -> bool:
    if actual <= 0 or actual >= expected:
        return False
    if measure_index != 1:
        return False
    try:
        if _fraction(measure.paddingLeft) > 0:
            return True
    except Exception:
        pass
    # OMR exporters often omit the implicit/pickup marker. A short first measure
    # is treated as an anacrusis instead of inventing notes before the downbeat.
    return True


def _measure_issues(measure: stream.Measure, measure_index: int) -> list[str]:
    expected = _expected_duration(measure)
    if expected is None:
        return ["missing_time_signature"]
    issues: list[str] = []
    if _non_rhythmic_overflow(measure, expected):
        issues.append("non_rhythmic_offset_overflow")
    actual = _actual_duration(measure)
    if actual > expected:
        issues.append("measure_duration_overflow")
    if actual < expected and not _is_pickup(measure, measure_index, actual, expected):
        issues.append("measure_duration_underflow")
    return issues


def _implicit_tuplet_candidate(measure: stream.Measure) -> bool:
    expected = _expected_duration(measure)
    if expected is None or _actual_duration(measure) * 2 != expected * 3:
        return False
    events = list(measure.recurse().notes)
    if len(events) < 3:
        return False
    beamed = 0
    for event in events:
        beams = getattr(event, "beams", None)
        if beams is not None and len(beams) > 0:
            beamed += 1
    return beamed >= 3


def _pad_measure(measure: stream.Measure, measure_index: int) -> bool:
    expected = _expected_duration(measure)
    if expected is None:
        return False
    actual = _actual_duration(measure)
    if actual >= expected or _is_pickup(measure, measure_index, actual, expected):
        return False
    try:
        measure.makeRests(fillGaps=True, inPlace=True, timeRangeFromBarDuration=True)
    except (TypeError, music21.exceptions21.Music21Exception):
        try:
            measure.makeRests(fillGaps=True, inPlace=True)
        except Exception:
            pass
    actual = _actual_duration(measure)
    gap = expected - actual
    if gap <= 0:
        return True
    voices = list(measure.voices)
    if voices:
        for voice in voices:
            voice_end = _fraction(voice.highestTime)
            if voice_end < expected:
                voice.insert(float(voice_end), note.Rest(quarterLength=float(expected - voice_end)))
    else:
        measure.insert(float(actual), note.Rest(quarterLength=float(gap)))
    return True


def _measure_rows(score: stream.Score) -> list[tuple[str, int, stream.Measure]]:
    rows: list[tuple[str, int, stream.Measure]] = []
    for part_index, part in enumerate(score.parts):
        part_id = str(part.id or f"P{part_index + 1}")[:100]
        for measure_index, measure in enumerate(part.getElementsByClass(stream.Measure), start=1):
            rows.append((part_id, measure_index, measure))
    return rows


def _ensure_initial_meters(score: stream.Score) -> set[tuple[str, int]]:
    """Make alphaTab's common-time fallback explicit for meterless OMR output."""
    defaulted: set[tuple[str, int]] = set()
    for part_index, part in enumerate(score.parts, start=1):
        measures = list(part.getElementsByClass(stream.Measure))
        if not measures:
            continue
        first = measures[0]
        if first.timeSignature is None and first.getContextByClass(meter.TimeSignature) is None:
            first.insert(0, meter.TimeSignature("4/4"))
            defaulted.add((str(part.id or f"P{part_index}")[:100], 1))
    return defaulted


def _capture_explicit_meters(
    score: stream.Score,
) -> dict[tuple[str, int], list[tuple[Fraction, meter.TimeSignature]]]:
    captured: dict[tuple[str, int], list[tuple[Fraction, meter.TimeSignature]]] = {}
    for part_id, index, measure in _measure_rows(score):
        signatures: list[tuple[Fraction, meter.TimeSignature]] = []
        for signature in measure.getElementsByClass(meter.TimeSignature):
            signatures.append(
                (_fraction(signature.getOffsetBySite(measure)), copy.deepcopy(signature))
            )
        captured[(part_id, index)] = signatures
    return captured


def _restore_explicit_meters(
    score: stream.Score,
    captured: dict[tuple[str, int], list[tuple[Fraction, meter.TimeSignature]]],
) -> None:
    """Prevent probabilistic note repair from rewriting the source meter."""
    for part_id, index, measure in _measure_rows(score):
        source_signatures = captured.get((part_id, index), [])
        if not source_signatures:
            # A corrector may infer a missing later meter change. Only source
            # signatures are authoritative enough to overwrite that result.
            continue
        for signature in list(measure.getElementsByClass(meter.TimeSignature)):
            measure.remove(signature)
        for offset, signature in source_signatures:
            measure.insert(float(offset), copy.deepcopy(signature))


def repair_score(score: stream.Score, engine: str) -> tuple[stream.Score, dict[str, Any]]:
    part_ids = _assign_unique_part_ids(score)
    defaulted_meters = _ensure_initial_meters(score)
    explicit_meters = _capture_explicit_meters(score)
    before_rows = _measure_rows(score)
    before_hashes = {(part_id, index): _measure_signature(measure) for part_id, index, measure in before_rows}
    initial_issues: dict[tuple[str, int], list[str]] = {}
    implicit_tuplet_candidates = {
        (part_id, index)
        for part_id, index, measure in before_rows
        if _implicit_tuplet_candidate(measure)
    }
    for part_id, index, measure in before_rows:
        issues = _measure_issues(measure, index)
        if (part_id, index) in defaulted_meters:
            issues.append("missing_time_signature_defaulted")
        initial_issues[(part_id, index)] = issues
    flagged = {key for key, issues in initial_issues.items() if issues}

    corrector_error = ""
    if flagged:
        try:
            corrected = correctors.ScoreCorrector(score).run()
            if isinstance(corrected, stream.Score):
                score = corrected
        except Exception as error:
            # OMR correction is probabilistic and version-sensitive. Padding and
            # the final alphaTab gate remain available when the model declines.
            corrector_error = str(error)[:200]

    _assign_unique_part_ids(score, part_ids)
    _restore_explicit_meters(score, explicit_meters)

    rebased: set[tuple[str, int]] = set()
    padded: set[tuple[str, int]] = set()
    for part_id, index, measure in _measure_rows(score):
        if _rebase_non_rhythmic_overflow(measure):
            rebased.add((part_id, index))
            initial_issues.setdefault((part_id, index), []).append("non_rhythmic_offset_rebased")
        if _pad_measure(measure, index):
            padded.add((part_id, index))
    try:
        score.makeNotation(inPlace=True)
    except Exception:
        # Existing measure/voice notation is preferable to failing a usable
        # engine result; residual timing is caught below and by alphaTab.
        pass

    final_rows = _measure_rows(score)
    final_issues = {
        (part_id, index): _measure_issues(measure, index)
        for part_id, index, measure in final_rows
    }
    changed: set[tuple[str, int]] = set(padded).union(defaulted_meters).union(rebased)
    for part_id, index, measure in final_rows:
        key = (part_id, index)
        if key in before_hashes and before_hashes[key] != _measure_signature(measure):
            changed.add(key)
    corrected_keys = flagged.intersection(changed)
    suspect = {key for key, issues in final_issues.items() if issues}
    report_issues: dict[str, list[str]] = {}
    for key in sorted(set(initial_issues).union(final_issues)):
        issues = sorted(set(initial_issues.get(key, []) + final_issues.get(key, [])))
        if issues:
            report_issues[f"{key[0]}|{key[1]}"] = issues[:32]
    report: dict[str, Any] = {
        "engine": engine,
        "music21Version": music21.__version__,
        "measureCount": max((index for _, index, _ in final_rows), default=0),
        "flagged": [{"partId": part, "measureIndex": index} for part, index in sorted(flagged)],
        "corrected": [
            {"partId": part, "measureIndex": index} for part, index in sorted(corrected_keys)
        ],
        "suspect": [{"partId": part, "measureIndex": index} for part, index in sorted(suspect)],
        "issues": report_issues,
        "implicitTupletCandidates": [
            {"partId": part, "measureIndex": index}
            for part, index in sorted(implicit_tuplet_candidates)
        ],
    }
    if corrector_error:
        report["correctorWarning"] = corrector_error
    return score, report


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(encoded) > 1 << 20:
        raise ValueError("repair report exceeds 1 MiB")
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(encoded)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def run(engine: str, inputs: list[Path], output: Path, report_path: Path) -> None:
    score, report = repair_score(combine_pages(inputs), engine)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.stem + ".tmp.musicxml")
    score.write("musicxml", fp=temporary)
    os.chmod(temporary, 0o600)
    os.replace(temporary, output)
    atomic_write_json(report_path, report)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--engine")
    parser.add_argument("--input", action="append", type=Path, default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.version:
        print(VERSION)
        return 0
    if not args.engine or args.output is None or args.report is None or not args.input:
        raise ValueError("--engine, --input, --output, and --report are required")
    run(args.engine, args.input, args.output, args.report)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"MusicXML repair failed: {error}", file=sys.stderr)
        raise SystemExit(1)
