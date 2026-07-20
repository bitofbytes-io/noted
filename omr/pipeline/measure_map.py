#!/usr/bin/env python3
"""Extract page-relative measure boxes, with classical-CV fallback."""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import cv2

VERSION = "1"


def number(attributes: dict[str, str], *names: str) -> float | None:
    for name in names:
        value = attributes.get(name)
        if value is not None:
            try:
                return float(value)
            except ValueError:
                pass
    return None


def boxes_from_omr(path: Path) -> dict[int, list[dict[str, float | int]]]:
    """Read geometry when Audiveris exposes explicit measure bounds in sheet XML."""
    result: dict[int, list[dict[str, float | int]]] = {}
    if not path.exists():
        return result
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            if not entry.filename.lower().endswith(".xml") or entry.file_size > 32 << 20:
                continue
            match = re.search(r"sheet[^0-9]*([0-9]+)", entry.filename, re.IGNORECASE)
            page = int(match.group(1)) if match else 1
            try:
                root = ElementTree.fromstring(archive.read(entry))
            except ElementTree.ParseError:
                continue
            # Audiveris persists horizontal measure bounds on ``stack`` nodes.
            # A stack spans every staff in its system, so combine its left/right
            # values with the staff-line points for a reader-sized rectangle.
            for system in (item for item in root.iter() if item.tag.rsplit("}", 1)[-1].lower() == "system"):
                y_values: list[float] = []
                for item in system.iter():
                    if item.tag.rsplit("}", 1)[-1].lower() != "point":
                        continue
                    y = number({key.lower(): value for key, value in item.attrib.items()}, "y")
                    if y is not None:
                        y_values.append(y)
                if not y_values:
                    continue
                unique_y = sorted(set(y_values))
                gaps = [right - left for left, right in zip(unique_y, unique_y[1:]) if 2 <= right - left <= 100]
                interline = sorted(gaps)[len(gaps) // 2] if gaps else 20
                top = max(0.0, min(y_values) - interline * 1.5)
                bottom = max(y_values) + interline * 1.5
                for stack in system:
                    if stack.tag.rsplit("}", 1)[-1].lower() != "stack":
                        continue
                    attrs = {key.lower(): value for key, value in stack.attrib.items()}
                    left = number(attrs, "left")
                    right = number(attrs, "right")
                    if left is None or right is None or right <= left:
                        continue
                    result.setdefault(page, []).append(
                        {"x": left, "y": top, "width": right - left, "height": bottom - top}
                    )
            if result.get(page):
                continue
            for element in root.iter():
                tag = element.tag.rsplit("}", 1)[-1].lower()
                if tag not in {"measure", "measurestack", "measure-stack"}:
                    continue
                attrs = {key.lower(): value for key, value in element.attrib.items()}
                x = number(attrs, "x", "left")
                y = number(attrs, "y", "top")
                width = number(attrs, "width")
                height = number(attrs, "height")
                right = number(attrs, "right")
                bottom = number(attrs, "bottom")
                if width is None and x is not None and right is not None:
                    width = right - x
                if height is None and y is not None and bottom is not None:
                    height = bottom - y
                if x is None or y is None or width is None or height is None or width <= 0 or height <= 0:
                    continue
                result.setdefault(page, []).append({"x": x, "y": y, "width": width, "height": height})
    return result


def clustered(values: list[int], tolerance: int) -> list[int]:
    if not values:
        return []
    groups: list[list[int]] = [[values[0]]]
    for value in values[1:]:
        if value - groups[-1][-1] <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [round(sum(group) / len(group)) for group in groups]


def cv_boxes(path: Path) -> tuple[int, int, list[dict[str, float | int]]]:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"cannot read {path.name}")
    height, width = image.shape
    binary = cv2.threshold(image, 240, 255, cv2.THRESH_BINARY_INV)[1]
    # Long horizontal morphology removes stems, beams, text, and note heads before
    # staff detection. A raw row projection mistakes dense beaming for staff lines
    # and splits a grand staff into several false systems.
    horizontal = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (max(50, width // 8), 1)),
    )
    row_ink = (horizontal > 0).sum(axis=1)
    line_rows = [int(y) for y, ink in enumerate(row_ink) if ink >= width * 0.1]
    lines = clustered(line_rows, 4)
    staffs: list[tuple[int, int, int]] = []
    index = 0
    while index + 4 < len(lines):
        candidate = lines[index : index + 5]
        gaps = [candidate[i + 1] - candidate[i] for i in range(4)]
        median_gap = sorted(gaps)[len(gaps) // 2]
        if min(gaps) >= 2 and max(gaps) - min(gaps) <= max(4, median_gap * 0.35):
            staffs.append((candidate[0], candidate[-1], median_gap))
            index += 5
        else:
            index += 1
    if not staffs:
        return width, height, []
    groups: list[list[tuple[int, int, int]]] = [[staffs[0]]]
    for staff in staffs[1:]:
        previous = groups[-1][-1]
        if staff[0] - previous[1] <= max(previous[2], staff[2]) * 8:
            groups[-1].append(staff)
        else:
            groups.append([staff])
    systems: list[tuple[int, int]] = []
    for group in groups:
        interline = round(sum(staff[2] for staff in group) / len(group))
        systems.append((max(0, group[0][0] - interline * 2), min(height, group[-1][1] + interline * 2)))
    result: list[dict[str, float | int]] = []
    for group, (top, bottom) in zip(groups, systems, strict=True):
        interline = round(sum(staff[2] for staff in group) / len(group))
        vertical = cv2.morphologyEx(
            binary[top:bottom, :],
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(4, round(interline * 3.8)))),
        )
        candidate_columns: list[int] = []
        for x in range(width):
            # A barline crosses the full height of every staff in a system. Requiring
            # that evidence on each staff rejects note stems, clefs, and braces.
            if all(
                (
                    vertical[
                        staff_top - top : staff_bottom - top + 1,
                        max(0, x - 1) : min(width, x + 2),
                    ]
                    > 0
                ).sum()
                >= (staff_bottom - staff_top) * 0.7
                for staff_top, staff_bottom, _ in group
            ):
                candidate_columns.append(x)
        xs = clustered(candidate_columns, max(8, round(interline * 1.4)))
        if len(xs) < 2:
            continue
        for left, right in zip(xs, xs[1:]):
            if right - left < max(20, width // 100):
                continue
            result.append({"x": left, "y": top, "width": right - left, "height": bottom - top})
    return width, height, result


def build_map(images: list[Path], omr: Path | None, dpi: int) -> dict[str, object]:
    omr_boxes = boxes_from_omr(omr) if omr else {}
    pages: list[dict[str, object]] = []
    measure = 1
    used_omr = False
    for page_number, image in enumerate(images, 1):
        width, height, fallback = cv_boxes(image)
        boxes = omr_boxes.get(page_number) or fallback
        used_omr = used_omr or bool(omr_boxes.get(page_number))
        measures = []
        for box in sorted(boxes, key=lambda item: (float(item["y"]), float(item["x"]))):
            measures.append({"measureNumber": measure, **box})
            measure += 1
        pages.append({"pageNumber": page_number, "width": width, "height": height, "dpi": dpi, "measures": measures})
    if measure == 1:
        raise ValueError("no measure geometry was detected")
    return {"pages": pages, "engineVersion": f"audiveris-5.10.2-measures+measure-map-{VERSION}-{'omr' if used_omr else 'opencv'}"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--omr", type=Path)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("images", nargs="*", type=Path)
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.version:
        print(VERSION)
        return 0
    if args.output is None or not args.images:
        raise ValueError("--output and at least one image are required")
    value = build_map(args.images, args.omr, args.dpi)
    args.output.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"measure-map extraction failed: {error}", file=sys.stderr)
        raise SystemExit(1)
