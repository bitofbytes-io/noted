"""Dependency-free MusicXML metrics for the Noted OMR benchmark."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
import io
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET
import zipfile


MAX_SCORE_BYTES = 100 * 1024 * 1024
STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element if local_name(item.tag) == name), None)


def children(element: ET.Element, name: str) -> list[ET.Element]:
    return [item for item in element if local_name(item.tag) == name]


def child_text(element: ET.Element, name: str, default: str = "") -> str:
    item = child(element, name)
    return (item.text or "").strip() if item is not None else default


def safe_int(value: str, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def fraction_text(value: Fraction | None) -> str | None:
    if value is None:
        return None
    return str(value.numerator) if value.denominator == 1 else f"{value.numerator}/{value.denominator}"


def _read_mxl(data: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 256:
            raise ValueError("compressed MusicXML has too many entries")
        for item in archive.infolist():
            item_path = PurePosixPath(item.filename)
            if item_path.is_absolute() or ".." in item_path.parts or "\\" in item.filename:
                raise ValueError("compressed MusicXML contains an unsafe path")
            if item.file_size > MAX_SCORE_BYTES:
                raise ValueError("compressed MusicXML entry is too large")
        try:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
        except KeyError as error:
            raise ValueError("compressed MusicXML is missing META-INF/container.xml") from error
        rootfile = next((item for item in container.iter() if local_name(item.tag) == "rootfile"), None)
        root_path = rootfile.attrib.get("full-path", "") if rootfile is not None else ""
        if not root_path:
            raise ValueError("compressed MusicXML container has no rootfile")
        try:
            score = archive.read(root_path)
        except KeyError as error:
            raise ValueError("compressed MusicXML rootfile is missing") from error
        if len(score) > MAX_SCORE_BYTES:
            raise ValueError("MusicXML score is too large")
        return score


def read_musicxml(path: Path) -> bytes:
    data = path.read_bytes()
    if len(data) > MAX_SCORE_BYTES:
        raise ValueError("MusicXML input is too large")
    if path.suffix.lower() == ".mxl" or data.startswith(b"PK"):
        return _read_mxl(data)
    return data


def parse_beats(value: str) -> int:
    components = [safe_int(component.strip()) for component in value.split("+")]
    return sum(components) if components and all(component > 0 for component in components) else 0


def parse_meter(attributes: ET.Element) -> Fraction | None:
    total = Fraction(0)
    saw_time = False
    for time in children(attributes, "time"):
        if child(time, "senza-misura") is not None:
            return None
        beats = children(time, "beats")
        beat_types = children(time, "beat-type")
        for index, beats_item in enumerate(beats):
            if index >= len(beat_types):
                return None
            numerator = parse_beats((beats_item.text or "").strip())
            denominator = safe_int((beat_types[index].text or "").strip())
            if numerator <= 0 or denominator <= 0:
                return None
            total += Fraction(numerator * 4, denominator)
            saw_time = True
    return total if saw_time and total > 0 else None


@dataclass(frozen=True)
class Event:
    onset: Fraction
    duration: Fraction
    pitch: int | str


@dataclass
class MeasureAnalysis:
    number: str
    implicit: bool
    expected: Fraction | None
    actual: Fraction
    cursor_before_start: bool
    events: list[Event]


@dataclass
class ScoreAnalysis:
    part_ids: list[str]
    measures: list[list[MeasureAnalysis]]

    @property
    def measure_count(self) -> int:
        return max((len(part) for part in self.measures), default=0)


def pitch_token(note: ET.Element) -> int | str | None:
    if child(note, "rest") is not None:
        return "rest"
    pitch = child(note, "pitch")
    if pitch is None:
        return None
    step = child_text(pitch, "step")
    octave = safe_int(child_text(pitch, "octave"), -100)
    alter = safe_int(child_text(pitch, "alter"), 0)
    if step not in STEP_SEMITONES or octave < -1:
        return None
    return (octave + 1) * 12 + STEP_SEMITONES[step] + alter


def analyze_musicxml(path: Path) -> ScoreAnalysis:
    root = ET.fromstring(read_musicxml(path))
    if local_name(root.tag) != "score-partwise":
        raise ValueError("only score-partwise MusicXML is supported by the reference metrics")

    part_ids: list[str] = []
    all_measures: list[list[MeasureAnalysis]] = []
    for part_index, part in enumerate(children(root, "part")):
        part_ids.append(part.attrib.get("id", f"part-{part_index + 1}"))
        divisions = 0
        meter: Fraction | None = None
        part_measures: list[MeasureAnalysis] = []
        for measure in children(part, "measure"):
            measure_attributes = child(measure, "attributes")
            if measure_attributes is not None:
                divisions_value = child_text(measure_attributes, "divisions")
                if divisions_value:
                    divisions = safe_int(divisions_value)
                updated_meter = parse_meter(measure_attributes)
                if updated_meter is not None or child(measure_attributes, "time") is not None:
                    meter = updated_meter

            cursor = Fraction(0)
            maximum = Fraction(0)
            last_onset = Fraction(0)
            cursor_before_start = False
            events: list[Event] = []
            for item in measure:
                name = local_name(item.tag)
                if name == "note":
                    chord = child(item, "chord") is not None
                    grace = child(item, "grace") is not None
                    duration_value = safe_int(child_text(item, "duration"))
                    duration = Fraction(duration_value, divisions) if duration_value >= 0 and divisions > 0 else Fraction(0)
                    onset = last_onset if chord else cursor
                    if not chord:
                        last_onset = onset
                    token = pitch_token(item)
                    if not grace and token is not None:
                        events.append(Event(onset=onset, duration=duration, pitch=token))
                    if not chord and not grace and duration_value:
                        if divisions <= 0:
                            raise ValueError("note duration appears before valid divisions")
                        cursor += duration
                        maximum = max(maximum, cursor)
                elif name in {"backup", "forward"}:
                    duration_value = safe_int(child_text(item, "duration"))
                    if duration_value < 0 or divisions <= 0:
                        raise ValueError(f"{name} has an invalid duration or divisions value")
                    delta = Fraction(duration_value, divisions)
                    cursor = cursor - delta if name == "backup" else cursor + delta
                    if cursor < 0:
                        cursor_before_start = True
                    maximum = max(maximum, cursor)

            part_measures.append(
                MeasureAnalysis(
                    number=measure.attrib.get("number", str(len(part_measures) + 1)),
                    implicit=measure.attrib.get("implicit", "no").lower() == "yes",
                    expected=meter,
                    actual=maximum,
                    cursor_before_start=cursor_before_start,
                    events=events,
                )
            )
        all_measures.append(part_measures)

    if not all_measures or not any(all_measures):
        raise ValueError("MusicXML contains no parts with measures")
    return ScoreAnalysis(part_ids=part_ids, measures=all_measures)


def duration_integrity(score: ScoreAnalysis) -> dict:
    checked = 0
    valid = 0
    underfull = 0
    overfull = 0
    implicit_underfull = 0
    cursor_errors = 0
    flagged: list[dict] = []
    for part_index, measures in enumerate(score.measures):
        for measure_index, measure in enumerate(measures):
            status = "unchecked"
            if measure.expected is not None:
                checked += 1
                if measure.actual == measure.expected and not measure.cursor_before_start:
                    valid += 1
                    status = "valid"
                elif measure.actual < measure.expected:
                    status = "underfull"
                    underfull += 1
                    if measure.implicit:
                        implicit_underfull += 1
                elif measure.actual > measure.expected:
                    status = "overfull"
                    overfull += 1
            if measure.cursor_before_start:
                cursor_errors += 1
                if status == "valid":
                    status = "cursor-before-start"
            if status not in {"valid", "unchecked"} or measure.cursor_before_start:
                flagged.append(
                    {
                        "part": score.part_ids[part_index],
                        "measureIndex": measure_index + 1,
                        "measureNumber": measure.number,
                        "implicit": measure.implicit,
                        "status": status,
                        "expectedQuarterLength": fraction_text(measure.expected),
                        "actualQuarterLength": fraction_text(measure.actual),
                        "cursorBeforeStart": measure.cursor_before_start,
                    }
                )
    return {
        "checkedMeasures": checked,
        "validMeasures": valid,
        "validMeasureRate": valid / checked if checked else None,
        "underfullMeasures": underfull,
        "implicitUnderfullMeasures": implicit_underfull,
        "overfullMeasures": overfull,
        "cursorBeforeStartMeasures": cursor_errors,
        "flaggedMeasures": flagged,
    }


def score_summary(score: ScoreAnalysis) -> dict:
    return {
        "partCount": len(score.measures),
        "partMeasureCounts": [len(measures) for measures in score.measures],
        "measureCount": score.measure_count,
        "eventCount": sum(len(measure.events) for part in score.measures for measure in part),
        "durationIntegrity": duration_integrity(score),
    }


def _counter_f1(reference: Counter, candidate: Counter) -> dict:
    reference_count = sum(reference.values())
    candidate_count = sum(candidate.values())
    matched = sum((reference & candidate).values())
    precision = matched / candidate_count if candidate_count else (1.0 if reference_count == 0 else 0.0)
    recall = matched / reference_count if reference_count else (1.0 if candidate_count == 0 else 0.0)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "referenceCount": reference_count,
        "candidateCount": candidate_count,
        "matchedCount": matched,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def _measure_counters(measure: MeasureAnalysis | None) -> tuple[Counter, Counter, Counter]:
    if measure is None:
        return Counter(), Counter(), Counter()
    pitches: Counter = Counter()
    rhythms: Counter = Counter()
    events: Counter = Counter()
    for event in measure.events:
        if event.pitch != "rest":
            pitches[event.pitch] += 1
        rhythm = (fraction_text(event.onset), fraction_text(event.duration), event.pitch == "rest")
        rhythms[rhythm] += 1
        events[(event.pitch, *rhythm[:2])] += 1
    return pitches, rhythms, events


def compare_scores(reference: ScoreAnalysis, candidate: ScoreAnalysis) -> dict:
    reference_pitches: Counter = Counter()
    candidate_pitches: Counter = Counter()
    reference_rhythms: Counter = Counter()
    candidate_rhythms: Counter = Counter()
    reference_events: Counter = Counter()
    candidate_events: Counter = Counter()
    reference_measure_count = reference.measure_count
    candidate_measure_count = candidate.measure_count
    aligned = min(reference_measure_count, candidate_measure_count)
    for measure_index in range(max(reference_measure_count, candidate_measure_count)):
        for score, pitches, rhythms, events in (
            (reference, reference_pitches, reference_rhythms, reference_events),
            (candidate, candidate_pitches, candidate_rhythms, candidate_events),
        ):
            for part in score.measures:
                measure = part[measure_index] if measure_index < len(part) else None
                measure_pitches, measure_rhythms, measure_events = _measure_counters(measure)
                pitches.update({(measure_index, *key) if isinstance(key, tuple) else (measure_index, key): count for key, count in measure_pitches.items()})
                rhythms.update({(measure_index, *key): count for key, count in measure_rhythms.items()})
                events.update({(measure_index, *key): count for key, count in measure_events.items()})

    maximum_measures = max(reference_measure_count, candidate_measure_count)
    measure_similarity = min(reference_measure_count, candidate_measure_count) / maximum_measures if maximum_measures else 1.0
    maximum_parts = max(len(reference.measures), len(candidate.measures))
    part_similarity = min(len(reference.measures), len(candidate.measures)) / maximum_parts if maximum_parts else 1.0
    return {
        "referenceMeasureCount": reference_measure_count,
        "candidateMeasureCount": candidate_measure_count,
        "measureCountSimilarity": measure_similarity,
        "partCountSimilarity": part_similarity,
        "alignedMeasureInstances": aligned,
        "alignmentMethod": "measure-index-with-parts-pooled",
        "pitch": _counter_f1(reference_pitches, candidate_pitches),
        "rhythm": _counter_f1(reference_rhythms, candidate_rhythms),
        "event": _counter_f1(reference_events, candidate_events),
    }
