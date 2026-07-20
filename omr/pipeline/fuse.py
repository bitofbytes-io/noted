#!/usr/bin/env python3
"""Align repaired engine results and conservatively arbitrate at measure level."""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from pathlib import Path
from typing import Any

from music21 import converter, stream

import repair

VERSION = "1"


def load_score(path: Path) -> stream.Score:
    parsed = converter.parse(path, forceSource=True)
    if isinstance(parsed, stream.Opus):
        scores = list(parsed.scores)
        if not scores:
            raise ValueError(f"no score in {path.name}")
        parsed = scores[0]
    if not isinstance(parsed, stream.Score) or not list(parsed.parts):
        raise ValueError(f"no parts in {path.name}")
    return parsed


def load_json(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    data = path.read_bytes()
    if not data or len(data) > 1 << 20:
        raise ValueError(f"invalid bounded JSON input: {path.name}")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError(f"JSON input is not an object: {path.name}")
    return value


def _measure_number(measure: stream.Measure) -> str:
    value = getattr(measure, "numberWithSuffix", None)
    if value is None:
        value = getattr(measure, "number", "")
    return str(value)[:100]


def _alignment(
    left: list[stream.Measure], right: list[stream.Measure]
) -> list[tuple[int | None, int | None]]:
    """Needleman-Wunsch alignment biased toward rhythm hashes and XML numbers."""
    rows, columns = len(left), len(right)
    scores = [[0] * (columns + 1) for _ in range(rows + 1)]
    moves = [[""] * (columns + 1) for _ in range(rows + 1)]
    for row in range(1, rows + 1):
        scores[row][0] = -2 * row
        moves[row][0] = "up"
    for column in range(1, columns + 1):
        scores[0][column] = -2 * column
        moves[0][column] = "left"
    left_hashes = [repair._measure_hash(measure) for measure in left]
    right_hashes = [repair._measure_hash(measure) for measure in right]
    for row in range(1, rows + 1):
        for column in range(1, columns + 1):
            same_hash = left_hashes[row - 1] == right_hashes[column - 1]
            same_number = _measure_number(left[row - 1]) == _measure_number(right[column - 1])
            diagonal_score = scores[row - 1][column - 1] + (4 if same_hash else (1 if same_number else -1))
            candidates = [
                (diagonal_score, "diag"),
                (scores[row - 1][column] - 2, "up"),
                (scores[row][column - 1] - 2, "left"),
            ]
            scores[row][column], moves[row][column] = max(candidates, key=lambda item: item[0])
    alignment: list[tuple[int | None, int | None]] = []
    row, column = rows, columns
    while row > 0 or column > 0:
        move = moves[row][column]
        if move == "diag":
            alignment.append((row - 1, column - 1))
            row -= 1
            column -= 1
        elif move == "up":
            alignment.append((row - 1, None))
            row -= 1
        else:
            alignment.append((None, column - 1))
            column -= 1
    alignment.reverse()
    return alignment


def _repair_keys(report: dict[str, Any], field: str) -> set[tuple[str, int]]:
    result: set[tuple[str, int]] = set()
    values = report.get(field, [])
    if not isinstance(values, list):
        return result
    for value in values:
        if not isinstance(value, dict):
            continue
        part_id = str(value.get("partId", ""))[:100]
        try:
            index = int(value.get("measureIndex", 0))
        except (TypeError, ValueError):
            continue
        if index > 0:
            result.add((part_id, index))
    return result


def _repair_issues(report: dict[str, Any], part_id: str, index: int) -> list[str]:
    values = report.get("issues", {})
    if not isinstance(values, dict):
        return []
    issues = values.get(f"{part_id}|{index}", [])
    if not isinstance(issues, list):
        return []
    return [str(issue)[:200] for issue in issues if str(issue).strip()][:32]


def _engine_summary(state: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    flagged = _repair_keys(report, "flagged")
    corrected = _repair_keys(report, "corrected")
    suspect = _repair_keys(report, "suspect")
    summary: dict[str, Any] = {
        "version": str(state.get("version", ""))[:100],
        "status": str(state.get("status", "failed"))[:20],
        "measureCount": int(report.get("measureCount", 0) or 0),
        "flaggedMeasures": len({index for _, index in flagged}),
        "correctedMeasures": len({index for _, index in corrected}),
        "suspectMeasures": len({index for _, index in suspect}),
    }
    if state.get("error"):
        summary["error"] = str(state["error"])[:500]
    if state.get("warning"):
        summary["routingWarning"] = str(state["warning"])[:200]
    if report.get("correctorWarning"):
        summary["repairWarning"] = str(report["correctorWarning"])[:200]
    return summary


def fuse(
    audiveris: stream.Score | None,
    homr: stream.Score | None,
    status: dict[str, Any],
    audiveris_report: dict[str, Any],
    homr_report: dict[str, Any],
) -> tuple[stream.Score, dict[str, Any]]:
    if audiveris is None and homr is None:
        raise ValueError("both repaired engine outputs are unavailable")
    both = audiveris is not None and homr is not None
    backbone_name = "audiveris" if audiveris is not None else "homr"
    backbone_report = audiveris_report if audiveris is not None else homr_report
    selected = copy.deepcopy(audiveris if audiveris is not None else homr)
    repair._assign_unique_part_ids(selected)
    selected_engine = "fusion" if both else backbone_name
    other = homr if audiveris is not None else None

    backbone_flagged = _repair_keys(backbone_report, "flagged")
    backbone_corrected = _repair_keys(backbone_report, "corrected")
    measure_rows: list[dict[str, Any]] = []
    flagged_indexes: set[int] = {index for _, index in backbone_flagged}
    corrected_indexes: set[int] = {index for _, index in backbone_corrected}
    suspect_indexes: set[int] = set()

    selected_parts = list(selected.parts)
    other_parts = list(other.parts) if other is not None else []
    for part_position, selected_part in enumerate(selected_parts):
        part_id = str(selected_part.id or f"P{part_position + 1}")[:100]
        selected_measures = list(selected_part.getElementsByClass(stream.Measure))
        other_measures = (
            list(other_parts[part_position].getElementsByClass(stream.Measure))
            if part_position < len(other_parts)
            else []
        )
        alignments = _alignment(selected_measures, other_measures) if other_measures else [
            (index, None) for index in range(len(selected_measures))
        ]
        alternate_has_extra_measures = any(selected_index is None for selected_index, _ in alignments)
        part_count_mismatch = both and len(selected_parts) != len(other_parts)
        for selected_index, other_index in alignments:
            if selected_index is None:
                continue
            measure = selected_measures[selected_index]
            measure_index = selected_index + 1
            source_engine = backbone_name
            agreement = False
            confidence = "low" if not both else "medium"
            corrected = (part_id, measure_index) in backbone_corrected
            issues = _repair_issues(backbone_report, part_id, measure_index)
            selected_issues = repair._measure_issues(measure, measure_index)
            issues.extend(selected_issues)
            if other_index is None:
                issues.append("engine_measure_missing")
            else:
                candidate = other_measures[other_index]
                candidate_issues = repair._measure_issues(candidate, other_index + 1)
                agreement = repair._measure_signature(measure) == repair._measure_signature(candidate)
                if agreement and not selected_issues and not candidate_issues:
                    confidence = "high"
                elif selected_issues and not candidate_issues:
                    replacement = copy.deepcopy(candidate)
                    replacement.number = measure.number
                    selected_part.replace(measure, replacement)
                    selected_measures[selected_index] = replacement
                    source_engine = "homr" if backbone_name == "audiveris" else "audiveris"
                    confidence = "medium"
                    corrected = True
                    issues.append("measure_replaced_by_valid_engine")
                elif not selected_issues and candidate_issues:
                    confidence = "medium"
                    issues.append("alternate_engine_invalid")
                elif selected_issues and candidate_issues:
                    confidence = "low"
                    issues.append("both_engines_invalid")
                else:
                    confidence = "medium"
                    issues.append("engine_disagreement")
            if alternate_has_extra_measures:
                confidence = "medium" if confidence == "high" else confidence
                issues.append("engine_measure_count_mismatch")
            if part_count_mismatch:
                confidence = "medium" if confidence == "high" else confidence
                issues.append("engine_part_count_mismatch")
            issues = sorted(set(issue for issue in issues if issue))[:32]
            if issues:
                flagged_indexes.add(measure_index)
            if corrected:
                flagged_indexes.add(measure_index)
                corrected_indexes.add(measure_index)
            if confidence != "high" or issues:
                suspect_indexes.add(measure_index)
            measure_rows.append(
                {
                    "partId": part_id,
                    "number": _measure_number(measure),
                    "measureIndex": measure_index,
                    "sourceEngine": source_engine,
                    "agreement": agreement,
                    "confidence": confidence,
                    "corrected": corrected,
                    "issues": issues,
                }
            )

    total_measures = max((row["measureIndex"] for row in measure_rows), default=0)
    if total_measures < 1:
        raise ValueError("fused score has no measures")
    engines = {
        "audiveris": _engine_summary(status.get("audiveris", {}), audiveris_report),
        "homr": _engine_summary(status.get("homr", {}), homr_report),
    }
    report = {
        "schemaVersion": 1,
        "totalMeasures": total_measures,
        "flaggedMeasures": len(flagged_indexes),
        "correctedMeasures": len(corrected_indexes.intersection(flagged_indexes)),
        "suspectMeasures": len(suspect_indexes),
        "selectedEngine": selected_engine,
        "engines": engines,
        "measures": measure_rows,
        "playability": {"status": "", "measureCount": 0},
    }
    return selected, report


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    data = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(data) > 1 << 20:
        raise ValueError("quality report exceeds 1 MiB")
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def run(args: argparse.Namespace) -> None:
    status = load_json(args.status)
    audiveris_report = load_json(args.audiveris_report)
    homr_report = load_json(args.homr_report)
    audiveris = load_score(args.audiveris) if args.audiveris else None
    homr = load_score(args.homr) if args.homr else None
    score, report = fuse(audiveris, homr, status, audiveris_report, homr_report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.stem + ".tmp.musicxml")
    score.write("musicxml", fp=temporary)
    os.chmod(temporary, 0o600)
    os.replace(temporary, args.output)
    atomic_write_json(args.report, report)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--status", type=Path)
    parser.add_argument("--audiveris", type=Path)
    parser.add_argument("--homr", type=Path)
    parser.add_argument("--audiveris-report", type=Path)
    parser.add_argument("--homr-report", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.version:
        print(VERSION)
        return 0
    if args.status is None or args.output is None or args.report is None:
        raise ValueError("--status, --output, and --report are required")
    run(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"MusicXML fusion failed: {error}", file=sys.stderr)
        raise SystemExit(1)
