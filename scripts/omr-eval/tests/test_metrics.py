from __future__ import annotations

import hashlib
import json
from fractions import Fraction
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
EVAL_ROOT = REPO_ROOT / "scripts" / "omr-eval"
CORPUS_ROOT = REPO_ROOT / "testdata" / "omr"
sys.path.insert(0, str(EVAL_ROOT))

from musicxml_metrics import Event, MeasureAnalysis, ScoreAnalysis, analyze_musicxml, compare_scores, score_summary  # noqa: E402


class MusicXMLMetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.reference = CORPUS_ROOT / "references" / "clean-simple.musicxml"

    def test_reference_identity_scores_are_exact(self) -> None:
        score = analyze_musicxml(self.reference)
        summary = score_summary(score)
        comparison = compare_scores(score, score)

        self.assertEqual(summary["measureCount"], 8)
        self.assertEqual(summary["partCount"], 1)
        self.assertEqual(summary["durationIntegrity"]["validMeasureRate"], 1.0)
        self.assertEqual(summary["durationIntegrity"]["flaggedMeasures"], [])
        self.assertEqual(comparison["measureCountSimilarity"], 1.0)
        self.assertEqual(comparison["pitch"]["f1"], 1.0)
        self.assertEqual(comparison["rhythm"]["f1"], 1.0)
        self.assertEqual(comparison["event"]["f1"], 1.0)

    def test_underfull_and_rhythm_difference_are_detected(self) -> None:
        changed = self.reference.read_text().replace("<duration>4</duration>", "<duration>2</duration>", 1)
        with tempfile.TemporaryDirectory() as directory:
            candidate_path = Path(directory) / "candidate.musicxml"
            candidate_path.write_text(changed)
            reference = analyze_musicxml(self.reference)
            candidate = analyze_musicxml(candidate_path)
            summary = score_summary(candidate)
            comparison = compare_scores(reference, candidate)

        self.assertGreater(summary["durationIntegrity"]["underfullMeasures"], 0)
        self.assertGreater(summary["durationIntegrity"]["cursorBeforeStartMeasures"], 0)
        self.assertLess(comparison["rhythm"]["f1"], 1.0)
        self.assertLess(comparison["event"]["f1"], 1.0)

    def test_events_moved_between_measures_do_not_match(self) -> None:
        def score(pitches: list[int]) -> ScoreAnalysis:
            return ScoreAnalysis(
                part_ids=["P1"],
                measures=[
                    [
                        MeasureAnalysis(
                            number=str(index + 1), implicit=False, expected=Fraction(4), actual=Fraction(4),
                            cursor_before_start=False,
                            events=[Event(onset=Fraction(0), duration=Fraction(1), pitch=pitch)],
                        )
                        for index, pitch in enumerate(pitches)
                    ]
                ],
            )

        comparison = compare_scores(score([60, 62]), score([62, 60]))
        self.assertEqual(comparison["pitch"]["f1"], 0.0)
        self.assertEqual(comparison["event"]["f1"], 0.0)

    def test_manifest_files_match_hashes_and_expected_pages(self) -> None:
        manifest = json.loads((CORPUS_ROOT / "manifest.json").read_text())
        self.assertEqual(manifest["license"], "CC0-1.0")
        self.assertEqual(len(manifest["fixtures"]), 4)
        for fixture in manifest["fixtures"]:
            input_path = CORPUS_ROOT / fixture["input"]
            reference_path = CORPUS_ROOT / fixture["reference"]
            self.assertEqual(hashlib.sha256(input_path.read_bytes()).hexdigest(), fixture["sha256"]["input"])
            self.assertEqual(hashlib.sha256(reference_path.read_bytes()).hexdigest(), fixture["sha256"]["reference"])
            pages = input_path.read_bytes().count(b"/Type /Page\n")
            self.assertEqual(pages, fixture["expected"]["pages"])
        multipage = next(item for item in manifest["fixtures"] if item["id"] == "multipage-study")
        self.assertGreaterEqual(multipage["expected"]["pages"], multipage["expected"]["minimumPages"])

    def test_exact_alphatab_importer_loads_reference(self) -> None:
        completed = subprocess.run(
            ["node", str(EVAL_ROOT / "alphatab-check.mjs"), str(self.reference)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["alphaTabVersion"], "1.8.4")
        self.assertEqual(result["measureCount"], 8)
        self.assertTrue(result["saneTickTotals"])
        self.assertTrue(result["saneStaffTiming"])
        self.assertTrue(result["playablePitchedNotes"])
        self.assertTrue(result["playabilitySuccess"])
        self.assertEqual(result["tickTotals"], [3840] * 8)

    def test_alphatab_check_does_not_treat_rest_only_score_as_playable(self) -> None:
        rests = b'''<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Rest</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>4</duration><type>whole</type></note></measure></part></score-partwise>'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rests.musicxml"
            path.write_bytes(rests)
            completed = subprocess.run(
                ["node", str(EVAL_ROOT / "alphatab-check.mjs"), str(path)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        result = json.loads(completed.stdout)
        self.assertTrue(result["parseSuccess"])
        self.assertFalse(result["playablePitchedNotes"])
        self.assertFalse(result["playabilitySuccess"])


class EvaluationCLITests(unittest.TestCase):
    def test_precomputed_output_directory_is_evaluated_without_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine_directory = root / "outputs" / "precomputed"
            engine_directory.mkdir(parents=True)
            (engine_directory / "clean-simple.musicxml").write_bytes(
                (CORPUS_ROOT / "references" / "clean-simple.musicxml").read_bytes()
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVAL_ROOT / "evaluate.py"),
                    "--skip-alphatab",
                    "--outputs-root",
                    str(root / "outputs"),
                    "--report-dir",
                    str(root / "report"),
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            report = json.loads((root / "report" / "report.json").read_text())

        self.assertEqual(len(report["results"]), 1)
        self.assertEqual(report["results"][0]["engine"], "precomputed")
        self.assertEqual(report["results"][0]["comparison"]["event"]["f1"], 1.0)
        self.assertIsNone(report["aggregate"][0]["engineInvocationSuccessRate"])

    def test_configured_engine_and_report_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVAL_ROOT / "evaluate.py"),
                    "--skip-alphatab",
                    "--outputs-root",
                    str(root / "outputs"),
                    "--report-dir",
                    str(root / "report"),
                    "--engine",
                    "reference-copy=cp {reference} {output}",
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            report = json.loads((root / "report" / "report.json").read_text())
            markdown = (root / "report" / "report.md").read_text()

        self.assertEqual(len(report["results"]), 4)
        self.assertEqual(report["aggregate"][0]["engine"], "reference-copy")
        self.assertEqual(report["aggregate"][0]["parseSuccessRate"], 1.0)
        self.assertEqual(report["aggregate"][0]["eventF1Mean"], 1.0)
        self.assertEqual(report["aggregate"][0]["engineInvocationSuccessRate"], 1.0)
        self.assertIn("Noted OMR evaluation scorecard", markdown)


if __name__ == "__main__":
    unittest.main()
