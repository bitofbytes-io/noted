from __future__ import annotations

import copy
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import numpy as np
from music21 import dynamics, meter, note, stream

PIPELINE = Path(__file__).resolve().parents[1] / "pipeline"
sys.path.insert(0, str(PIPELINE))

import fuse  # noqa: E402
import measure_map  # noqa: E402
import repair  # noqa: E402


def score_with_durations(durations: list[float], pitches: list[str] | None = None) -> stream.Score:
    score = stream.Score()
    part = stream.Part(id="P1")
    for index, duration in enumerate(durations, start=1):
        measure = stream.Measure(number=index)
        if index == 1:
            measure.insert(0, meter.TimeSignature("4/4"))
        pitch = pitches[index - 1] if pitches else "C4"
        measure.append(note.Note(pitch, quarterLength=duration))
        part.append(measure)
    score.insert(0, part)
    return score


def score_without_meter(durations: list[float], pitches: list[str] | None = None) -> stream.Score:
    score = score_with_durations(durations, pitches)
    first = list(score.parts[0].getElementsByClass(stream.Measure))[0]
    for signature in list(first.getElementsByClass(meter.TimeSignature)):
        first.remove(signature)
    return score


class RepairTests(unittest.TestCase):
    def test_implicit_tuplet_candidate_requires_three_to_two_overflow_and_beams(self) -> None:
        measure = stream.Measure(number=1)
        measure.insert(0, meter.TimeSignature("4/4"))
        for index in range(12):
            event = note.Note("C4", quarterLength=0.5)
            event.beams.fill(1, "continue")
            measure.append(event)
        self.assertTrue(repair._implicit_tuplet_candidate(measure))
        unbeamed = stream.Measure(number=1)
        unbeamed.insert(0, meter.TimeSignature("4/4"))
        for _ in range(12):
            unbeamed.append(note.Note("C4", quarterLength=0.5))
        self.assertFalse(repair._implicit_tuplet_candidate(unbeamed))

    def test_missing_initial_meter_is_made_explicit_and_reported(self) -> None:
        score = score_without_meter([4])
        with mock.patch.object(repair.correctors.ScoreCorrector, "run", return_value=score):
            repaired, report = repair.repair_score(score, "test")
        first = list(repaired.parts[0].getElementsByClass(stream.Measure))[0]
        self.assertEqual(first.timeSignature.ratioString, "4/4")
        self.assertEqual(report["flagged"], [{"partId": "P1", "measureIndex": 1}])
        self.assertEqual(report["corrected"], [{"partId": "P1", "measureIndex": 1}])
        self.assertIn("missing_time_signature_defaulted", report["issues"]["P1|1"])

    def test_missing_meter_uses_alphatab_common_time_default(self) -> None:
        score = score_without_meter([4, 8])
        measures = list(score.parts[0].getElementsByClass(stream.Measure))
        self.assertEqual(repair._measure_issues(measures[0], 1), [])
        self.assertEqual(repair._measure_issues(measures[1], 2), ["measure_duration_overflow"])

    def test_non_rhythmic_direction_beyond_bar_does_not_create_overflow(self) -> None:
        score = score_with_durations([4])
        measure = list(score.parts[0].getElementsByClass(stream.Measure))[0]
        measure.insert(6, dynamics.Dynamic("p"))
        self.assertEqual(float(measure.highestTime), 6.0)
        self.assertEqual(repair._actual_duration(measure), 4)
        self.assertEqual(repair._measure_issues(measure, 1), ["non_rhythmic_offset_overflow"])
        with mock.patch.object(repair.correctors.ScoreCorrector, "run", return_value=score):
            repaired, report = repair.repair_score(score, "test")
        repaired_measure = list(repaired.parts[0].getElementsByClass(stream.Measure))[0]
        repaired_dynamic = repaired_measure.getElementsByClass(dynamics.Dynamic)[0]
        self.assertEqual(float(repaired_dynamic.getOffsetBySite(repaired_measure)), 0.0)
        self.assertIn("non_rhythmic_offset_rebased", report["issues"]["P1|1"])
        self.assertEqual(report["suspect"], [])

    def test_probabilistic_correction_cannot_rewrite_source_meter(self) -> None:
        score = score_with_durations([6, 5])
        first = list(score.parts[0].getElementsByClass(stream.Measure))[0]
        first.timeSignature = meter.TimeSignature("12/8")

        def rewrite_meter() -> stream.Score:
            first.timeSignature = meter.TimeSignature("4/4")
            return score

        with mock.patch.object(
            repair.correctors.ScoreCorrector, "run", side_effect=rewrite_meter
        ):
            repaired, report = repair.repair_score(score, "test")
        measures = list(repaired.parts[0].getElementsByClass(stream.Measure))
        self.assertEqual(measures[0].timeSignature.ratioString, "12/8")
        self.assertEqual(repair._expected_duration(measures[1]), 6)
        self.assertEqual(report["suspect"], [])

    def test_probabilistic_correction_can_infer_missing_later_meter(self) -> None:
        score = score_with_durations([4, 3])
        second = list(score.parts[0].getElementsByClass(stream.Measure))[1]

        def infer_meter() -> stream.Score:
            second.timeSignature = meter.TimeSignature("3/4")
            return score

        with mock.patch.object(
            repair.correctors.ScoreCorrector, "run", side_effect=infer_meter
        ):
            repaired, report = repair.repair_score(score, "test")
        measures = list(repaired.parts[0].getElementsByClass(stream.Measure))
        self.assertEqual(measures[1].timeSignature.ratioString, "3/4")
        self.assertEqual(repair._actual_duration(measures[1]), 3)
        self.assertEqual(report["suspect"], [])

    def test_pickup_is_preserved_and_regular_underflow_is_padded(self) -> None:
        score = score_with_durations([1, 3])
        with mock.patch.object(repair.correctors.ScoreCorrector, "run", return_value=score):
            repaired, report = repair.repair_score(score, "test")
        measures = list(repaired.parts[0].getElementsByClass(stream.Measure))
        self.assertEqual(float(measures[0].highestTime), 1.0)
        self.assertEqual(float(measures[1].highestTime), 4.0)
        self.assertEqual(report["flagged"], [{"partId": "P1", "measureIndex": 2}])
        self.assertEqual(report["corrected"], [{"partId": "P1", "measureIndex": 2}])

    def test_combines_page_outputs_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths: list[Path] = []
            for index, pitch in enumerate(["C4", "D4"], start=1):
                path = root / f"page-{index}.musicxml"
                score_with_durations([4], [pitch]).write("musicxml", fp=path)
                paths.append(path)
            combined = repair.combine_pages(paths)
            measures = list(combined.parts[0].getElementsByClass(stream.Measure))
            self.assertEqual([measure.number for measure in measures], [1, 2])
            self.assertEqual([measure.notes[0].pitch.nameWithOctave for measure in measures], ["C4", "D4"])

    def test_duplicate_source_part_ids_are_made_stable_and_unique(self) -> None:
        score = stream.Score()
        first = list(score_with_durations([4]).parts)[0]
        second = list(score_with_durations([4, 2]).parts)[0]
        first.id = "Voice"
        second.id = "Voice"
        score.insert(0, first)
        score.insert(0, second)
        with mock.patch.object(repair.correctors.ScoreCorrector, "run", return_value=score):
            repaired, report = repair.repair_score(score, "test")
        self.assertEqual([part.id for part in repaired.parts], ["P1", "P2"])
        self.assertEqual(report["flagged"], [{"partId": "P2", "measureIndex": 2}])


class FuseTests(unittest.TestCase):
    def test_missing_meter_overflow_uses_valid_homr_measure(self) -> None:
        audiveris = score_without_meter([4, 8], ["C4", "D4"])
        homr = score_without_meter([4, 4], ["C4", "E4"])
        selected, report = fuse.fuse(audiveris, homr, {}, {}, {})
        self.assertEqual(report["measures"][1]["sourceEngine"], "homr")
        self.assertIn("measure_replaced_by_valid_engine", report["measures"][1]["issues"])
        replacement = list(selected.parts[0].getElementsByClass(stream.Measure))[1]
        self.assertEqual(float(replacement.highestTime), 4.0)

    def test_agreement_and_valid_disagreement_are_reported(self) -> None:
        audiveris = score_with_durations([4, 4], ["C4", "D4"])
        homr = score_with_durations([4, 4], ["C4", "E4"])
        status = {
            "audiveris": {"version": "5.10.2", "status": "succeeded"},
            "homr": {"version": "0.7.0", "status": "succeeded"},
        }
        _, report = fuse.fuse(audiveris, homr, status, {}, {})
        self.assertEqual(report["selectedEngine"], "fusion")
        self.assertTrue(report["measures"][0]["agreement"])
        self.assertEqual(report["measures"][0]["confidence"], "high")
        self.assertEqual(report["measures"][1]["confidence"], "medium")
        self.assertIn("engine_disagreement", report["measures"][1]["issues"])

    def test_invalid_backbone_measure_uses_valid_homr_measure(self) -> None:
        audiveris = score_with_durations([4, 2], ["C4", "D4"])
        homr = score_with_durations([4, 4], ["C4", "E4"])
        status = {
            "audiveris": {"version": "5.10.2", "status": "succeeded"},
            "homr": {"version": "0.7.0", "status": "succeeded"},
        }
        selected, report = fuse.fuse(audiveris, homr, status, {}, {})
        self.assertEqual(report["measures"][1]["sourceEngine"], "homr")
        self.assertTrue(report["measures"][1]["corrected"])
        replacement = list(selected.parts[0].getElementsByClass(stream.Measure))[1]
        self.assertEqual(replacement.notes[0].pitch.nameWithOctave, "E4")

    def test_duplicate_backbone_part_ids_produce_distinct_report_rows(self) -> None:
        audiveris = stream.Score()
        homr = stream.Score()
        for target in [audiveris, homr]:
            first = list(score_with_durations([4]).parts)[0]
            second = list(score_with_durations([4]).parts)[0]
            first.id = "Voice"
            second.id = "Voice"
            target.insert(0, first)
            target.insert(0, second)
        _, report = fuse.fuse(audiveris, homr, {}, {}, {})
        self.assertEqual([row["partId"] for row in report["measures"]], ["P1", "P2"])

    def test_extra_alternate_measure_prevents_false_high_confidence(self) -> None:
        audiveris = score_with_durations([4, 4], ["C4", "E4"])
        homr = score_with_durations([4, 4, 4], ["C4", "D4", "E4"])
        _, report = fuse.fuse(audiveris, homr, {}, {}, {})
        self.assertEqual(report["totalMeasures"], 2)
        self.assertTrue(all(row["confidence"] != "high" for row in report["measures"]))
        self.assertTrue(
            all("engine_measure_count_mismatch" in row["issues"] for row in report["measures"])
        )


class MeasureMapTests(unittest.TestCase):
    def test_opencv_fallback_finds_grand_staff_barlines_without_note_stems(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "score.png"
            pixels = np.full((500, 1000), 255, dtype=np.uint8)
            for staff_top in (120, 240):
                for line in range(5):
                    measure_map.cv2.line(
                        pixels, (100, staff_top + line * 12), (900, staff_top + line * 12), 0, 2
                    )
            for x in (100, 370, 640, 900):
                for staff_top in (120, 240):
                    measure_map.cv2.line(pixels, (x, staff_top), (x, staff_top + 48), 0, 2)
            # Long note stems on only one staff must not become boundaries.
            for x in (220, 500, 760):
                measure_map.cv2.line(pixels, (x, 112), (x, 165), 0, 3)
            measure_map.cv2.imwrite(str(path), pixels)
            _, _, boxes = measure_map.cv_boxes(path)
        self.assertEqual(len(boxes), 3)
        self.assertEqual([round(box["x"]) for box in boxes], [100, 370, 640])

    def test_audiveris_stack_geometry_is_extracted(self) -> None:
        sheet = b'''<sheet><picture width="2550" height="3300"/><page id="1"><system id="1">
          <stack id="1" left="100" right="600"/><stack id="2" left="600" right="1100"/>
          <part><staff><lines>
            <line><point x="100" y="200"/><point x="1100" y="200"/></line>
            <line><point x="100" y="220"/><point x="1100" y="220"/></line>
            <line><point x="100" y="240"/><point x="1100" y="240"/></line>
            <line><point x="100" y="260"/><point x="1100" y="260"/></line>
            <line><point x="100" y="280"/><point x="1100" y="280"/></line>
          </lines></staff></part></system></page></sheet>'''
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "score.omr"
            with zipfile.ZipFile(project, "w") as archive:
                archive.writestr("sheet#1/sheet#1.xml", sheet)
            boxes = measure_map.boxes_from_omr(project)
        self.assertEqual(len(boxes[1]), 2)
        self.assertEqual(boxes[1][0]["x"], 100)
        self.assertEqual(boxes[1][0]["width"], 500)


if __name__ == "__main__":
    unittest.main()
