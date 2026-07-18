#!/usr/bin/env python3
"""Evaluate precomputed or configured-engine OMR output against the Noted corpus."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "testdata" / "omr" / "manifest.json"
DEFAULT_OUTPUTS_ROOT = REPO_ROOT / ".local" / "omr-eval" / "outputs"
DEFAULT_REPORT_DIR = REPO_ROOT / ".local" / "omr-eval" / "report"
ALPHATAB_CHECK = SCRIPT_DIR / "alphatab-check.mjs"
SCORE_EXTENSIONS = (".musicxml", ".mxl", ".xml")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

sys.path.insert(0, str(SCRIPT_DIR))
from musicxml_metrics import analyze_musicxml, compare_scores, score_summary  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--outputs-root",
        type=Path,
        default=DEFAULT_OUTPUTS_ROOT,
        help="Precomputed outputs as ENGINE/FIXTURE_ID.musicxml (also .mxl/.xml).",
    )
    parser.add_argument(
        "--candidate",
        action="append",
        default=[],
        metavar="ENGINE:FIXTURE=PATH",
        help="Add an individual precomputed candidate; may be repeated.",
    )
    parser.add_argument(
        "--engine",
        action="append",
        default=[],
        metavar="NAME=COMMAND",
        help="Run a configured argv command per fixture. Available placeholders: {input}, {reference}, {output}, {output_dir}, {fixture_id}.",
    )
    parser.add_argument("--engine-timeout-seconds", type=int, default=600)
    parser.add_argument("--include-reference-baseline", action="store_true")
    parser.add_argument("--skip-alphatab", action="store_true")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> tuple[dict, list[dict]]:
    manifest = json.loads(path.read_text())
    if manifest.get("schemaVersion") != 1:
        raise ValueError("unsupported corpus manifest schema")
    fixtures = manifest.get("fixtures", [])
    if not fixtures:
        raise ValueError("corpus manifest contains no fixtures")
    base = path.parent
    seen: set[str] = set()
    verified: list[dict] = []
    for fixture in fixtures:
        fixture_id = fixture.get("id", "")
        if not SAFE_NAME.fullmatch(fixture_id) or fixture_id in seen:
            raise ValueError(f"invalid or duplicate fixture id: {fixture_id!r}")
        seen.add(fixture_id)
        item = dict(fixture)
        item["inputPath"] = (base / fixture["input"]).resolve()
        item["referencePath"] = (base / fixture["reference"]).resolve()
        for kind in ("input", "reference"):
            source_path = item[f"{kind}Path"]
            if not source_path.is_file():
                raise ValueError(f"fixture {fixture_id} is missing {kind}: {source_path}")
            expected_hash = fixture.get("sha256", {}).get(kind)
            actual_hash = sha256(source_path)
            if expected_hash != actual_hash:
                raise ValueError(f"fixture {fixture_id} {kind} checksum mismatch")
        verified.append(item)
    return manifest, verified


def relative_display(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def parse_candidate(specification: str) -> tuple[str, str, Path]:
    identity, separator, filename = specification.partition("=")
    engine, fixture_separator, fixture_id = identity.partition(":")
    if not separator or not fixture_separator or not SAFE_NAME.fullmatch(engine) or not SAFE_NAME.fullmatch(fixture_id):
        raise ValueError(f"invalid candidate specification: {specification!r}")
    path = Path(filename).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"candidate does not exist: {path}")
    return engine, fixture_id, path


def discover_precomputed(outputs_root: Path, fixtures: list[dict]) -> dict[tuple[str, str], Path]:
    candidates: dict[tuple[str, str], Path] = {}
    if not outputs_root.is_dir():
        return candidates
    fixture_ids = {fixture["id"] for fixture in fixtures}
    for engine_directory in sorted(item for item in outputs_root.iterdir() if item.is_dir()):
        engine = engine_directory.name
        if not SAFE_NAME.fullmatch(engine):
            continue
        for fixture_id in fixture_ids:
            matches = [engine_directory / f"{fixture_id}{extension}" for extension in SCORE_EXTENSIONS]
            matches = [item for item in matches if item.is_file()]
            if len(matches) > 1:
                raise ValueError(f"multiple precomputed outputs for {engine}:{fixture_id}")
            if matches:
                candidates[(engine, fixture_id)] = matches[0].resolve()
    return candidates


def parse_engine(specification: str) -> tuple[str, list[str]]:
    name, separator, command = specification.partition("=")
    if not separator or not SAFE_NAME.fullmatch(name) or not command.strip():
        raise ValueError(f"invalid engine specification: {specification!r}")
    argv = shlex.split(command)
    if not argv:
        raise ValueError(f"engine {name} has an empty command")
    return name, argv


def discover_engine_score(output_directory: Path, requested_output: Path) -> Path:
    if requested_output.is_file():
        return requested_output
    matches = sorted(
        item
        for item in output_directory.rglob("*")
        if item.is_file() and item.suffix.lower() in SCORE_EXTENSIONS
    )
    if len(matches) != 1:
        raise ValueError(f"engine produced {len(matches)} MusicXML candidates under {output_directory}")
    return matches[0]


def run_engines(
    specifications: list[str], fixtures: list[dict], outputs_root: Path, timeout_seconds: int
) -> tuple[dict[tuple[str, str], Path], dict[tuple[str, str], dict]]:
    candidates: dict[tuple[str, str], Path] = {}
    invocations: dict[tuple[str, str], dict] = {}
    for specification in specifications:
        engine, template = parse_engine(specification)
        for fixture in fixtures:
            fixture_id = fixture["id"]
            output_directory = outputs_root / engine / ".runs" / f"{fixture_id}-{time.time_ns()}"
            output_directory.mkdir(parents=True, exist_ok=True)
            requested_output = output_directory / "candidate.musicxml"
            normalized_output = outputs_root / engine / f"{fixture_id}.musicxml"
            placeholders = {
                "input": str(fixture["inputPath"]),
                "reference": str(fixture["referencePath"]),
                "output": str(requested_output),
                "output_dir": str(output_directory),
                "fixture_id": fixture_id,
            }
            try:
                argv = [argument.format_map(placeholders) for argument in template]
            except KeyError as error:
                raise ValueError(f"engine {engine} uses unknown placeholder {error}") from error
            started = time.monotonic()
            invocation = {"attempted": True, "succeeded": False, "runtimeSeconds": None}
            try:
                completed = subprocess.run(
                    argv,
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                    check=False,
                )
                runtime = time.monotonic() - started
                invocation["runtimeSeconds"] = runtime
                (output_directory / "stdout.log").write_text(completed.stdout)
                (output_directory / "stderr.log").write_text(completed.stderr)
                if completed.returncode != 0:
                    invocation["error"] = f"engine exited with status {completed.returncode}"
                else:
                    candidate = discover_engine_score(output_directory, requested_output)
                    normalized_output = normalized_output.with_suffix(candidate.suffix.lower())
                    shutil.copyfile(candidate, normalized_output)
                    candidates[(engine, fixture_id)] = normalized_output.resolve()
                    invocation["succeeded"] = True
            except subprocess.TimeoutExpired:
                invocation["runtimeSeconds"] = time.monotonic() - started
                invocation["error"] = f"engine exceeded {timeout_seconds} seconds"
            except (OSError, ValueError) as error:
                invocation["runtimeSeconds"] = time.monotonic() - started
                invocation["error"] = str(error)
            invocations[(engine, fixture_id)] = invocation
    return candidates, invocations


def run_alphatab(path: Path) -> dict:
    completed = subprocess.run(
        ["node", str(ALPHATAB_CHECK), str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "parseSuccess": False,
            "saneTickTotals": False,
            "error": (completed.stderr or completed.stdout or "alphaTab check emitted no JSON").strip()[:500],
        }
    if completed.returncode != 0 and not result.get("error"):
        result["error"] = f"alphaTab check exited with status {completed.returncode}"
    return result


def evaluate_candidate(fixture: dict, engine: str, path: Path, skip_alphatab: bool, invocation: dict | None) -> dict:
    result = {
        "fixtureId": fixture["id"],
        "fixtureTitle": fixture["title"],
        "traits": fixture["traits"],
        "engine": engine,
        "candidatePath": relative_display(path),
        "referencePath": relative_display(fixture["referencePath"]),
        "parse": {"success": False},
        "invocation": invocation,
    }
    try:
        reference = analyze_musicxml(fixture["referencePath"])
        candidate = analyze_musicxml(path)
        result["parse"] = {"success": True}
        result["score"] = score_summary(candidate)
        result["comparison"] = compare_scores(reference, candidate)
    except Exception as error:  # The report must retain failures from arbitrary recognizer output.
        result["parse"] = {"success": False, "error": str(error)[:500]}
    result["alphaTab"] = {"skipped": True} if skip_alphatab else run_alphatab(path)
    return result


def mean(values: list[float | None]) -> float | None:
    usable = [value for value in values if value is not None]
    return sum(usable) / len(usable) if usable else None


def alphatab_playable(result: dict) -> bool:
    return bool(
        result.get("parseSuccess")
        and result.get("saneTickTotals")
        and result.get("saneStaffTiming")
        and result.get("playablePitchedNotes")
    )


def aggregate_results(results: list[dict], fixture_count: int, invocations: dict[tuple[str, str], dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for result in results:
        grouped[result["engine"]].append(result)
    aggregates: list[dict] = []
    for engine, items in sorted(grouped.items()):
        successful = [item for item in items if item["parse"]["success"]]
        alpha_successful = [item for item in items if alphatab_playable(item["alphaTab"])]
        engine_invocations = [value for (name, _), value in invocations.items() if name == engine]
        aggregates.append(
            {
                "engine": engine,
                "evaluatedFixtures": len(items),
                "corpusFixtures": fixture_count,
                "parseSuccessRate": len(successful) / fixture_count,
                "alphaTabSuccessRate": len(alpha_successful) / fixture_count if items and "skipped" not in items[0]["alphaTab"] else None,
                "measureCountSimilarityMean": mean([item.get("comparison", {}).get("measureCountSimilarity") for item in successful]),
                "durationValidMeasureRateMean": mean([item.get("score", {}).get("durationIntegrity", {}).get("validMeasureRate") for item in successful]),
                "pitchF1Mean": mean([item.get("comparison", {}).get("pitch", {}).get("f1") for item in successful]),
                "rhythmF1Mean": mean([item.get("comparison", {}).get("rhythm", {}).get("f1") for item in successful]),
                "eventF1Mean": mean([item.get("comparison", {}).get("event", {}).get("f1") for item in successful]),
                "engineInvocationSuccessRate": (
                    sum(1 for invocation in engine_invocations if invocation.get("succeeded")) / len(engine_invocations)
                    if engine_invocations
                    else None
                ),
                "engineRuntimeSecondsMean": mean([invocation.get("runtimeSeconds") for invocation in engine_invocations]),
            }
        )
    return aggregates


def percent(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def render_markdown(report: dict) -> str:
    lines = [
        "# Noted OMR evaluation scorecard",
        "",
        f"Generated: {report['generatedAt']}",
        "",
        "## Aggregate",
        "",
        "| Engine/pipeline | Parse | alphaTab | Measure count | Duration valid | Pitch F1 | Rhythm F1 | Event F1 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in report["aggregate"]:
        lines.append(
            f"| {item['engine']} | {percent(item['parseSuccessRate'])} | {percent(item['alphaTabSuccessRate'])} | "
            f"{percent(item['measureCountSimilarityMean'])} | {percent(item['durationValidMeasureRateMean'])} | "
            f"{percent(item['pitchF1Mean'])} | {percent(item['rhythmF1Mean'])} | {percent(item['eventF1Mean'])} |"
        )
    lines.extend(
        [
            "",
            "## Fixture results",
            "",
            "| Fixture | Engine/pipeline | Parsed | alphaTab | Measures | Duration valid | Pitch F1 | Rhythm F1 | Event F1 |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for item in report["results"]:
        comparison = item.get("comparison", {})
        score = item.get("score", {})
        lines.append(
            f"| {item['fixtureId']} | {item['engine']} | {'yes' if item['parse']['success'] else 'no'} | "
            f"{'yes' if alphatab_playable(item['alphaTab']) else ('skipped' if item['alphaTab'].get('skipped') else 'no')} | "
            f"{comparison.get('candidateMeasureCount', '—')} | {percent(score.get('durationIntegrity', {}).get('validMeasureRate'))} | "
            f"{percent(comparison.get('pitch', {}).get('f1'))} | {percent(comparison.get('rhythm', {}).get('f1'))} | "
            f"{percent(comparison.get('event', {}).get('f1'))} |"
        )
    lines.extend(
        [
            "",
            "Metrics align measures by index and pool parts within each measure. They compare MIDI-equivalent pitch multisets, onset/duration/rest rhythm multisets, and combined event multisets. They are diagnostics, not a claim of perceptual or engraving equivalence.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    arguments = parse_args()
    manifest, fixtures = load_manifest(arguments.manifest.resolve())
    fixture_ids = {fixture["id"] for fixture in fixtures}
    candidates = discover_precomputed(arguments.outputs_root.resolve(), fixtures)
    invocations: dict[tuple[str, str], dict] = {}

    for specification in arguments.candidate:
        engine, fixture_id, path = parse_candidate(specification)
        if fixture_id not in fixture_ids:
            raise ValueError(f"candidate refers to unknown fixture: {fixture_id}")
        candidates[(engine, fixture_id)] = path

    engine_candidates, engine_invocations = run_engines(
        arguments.engine,
        fixtures,
        arguments.outputs_root.resolve(),
        arguments.engine_timeout_seconds,
    )
    for identity, invocation in engine_invocations.items():
        if not invocation.get("succeeded"):
            candidates.pop(identity, None)
    candidates.update(engine_candidates)
    invocations.update(engine_invocations)
    if arguments.include_reference_baseline:
        for fixture in fixtures:
            candidates[("reference", fixture["id"])] = fixture["referencePath"]

    if not candidates and not invocations:
        raise ValueError(
            "no candidate outputs found; add --include-reference-baseline, --candidate, --engine, or files under --outputs-root"
        )

    fixture_map = {fixture["id"]: fixture for fixture in fixtures}
    results = [
        evaluate_candidate(
            fixture_map[fixture_id],
            engine,
            path,
            arguments.skip_alphatab,
            invocations.get((engine, fixture_id)),
        )
        for (engine, fixture_id), path in sorted(candidates.items())
    ]
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "manifest": relative_display(arguments.manifest),
        "corpus": manifest["corpus"],
        "fixtureCount": len(fixtures),
        "results": results,
        "aggregate": aggregate_results(results, len(fixtures), invocations),
        "engineInvocationFailures": [
            {"engine": engine, "fixtureId": fixture, **details}
            for (engine, fixture), details in sorted(invocations.items())
            if not details.get("succeeded")
        ],
    }
    arguments.report_dir.mkdir(parents=True, exist_ok=True)
    json_path = arguments.report_dir / "report.json"
    markdown_path = arguments.report_dir / "report.md"
    json_path.write_text(f"{json.dumps(report, indent=2)}\n")
    markdown_path.write_text(render_markdown(report))
    print(json_path)
    print(markdown_path)
    return 0 if not report["engineInvocationFailures"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"omr-eval: {error}", file=sys.stderr)
        raise SystemExit(1) from error
