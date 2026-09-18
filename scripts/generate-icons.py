#!/usr/bin/env python3
"""Export the simple rect/polygon icon source. Requires Pillow for development only."""

from pathlib import Path
import shutil
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "web" / "public"
SOURCE = PUBLIC / "noted-favicon-v3.svg"


def render(size):
    # Supersample each target independently so the small favicon stays crisp.
    scale = size * 8 / 64
    canvas = Image.new("RGB", (size * 8, size * 8))
    draw = ImageDraw.Draw(canvas)
    for shape in ET.parse(SOURCE).getroot():
        tag = shape.tag.rsplit("}", 1)[-1]
        if tag == "rect":
            x = float(shape.get("x", "0")) * scale
            y = float(shape.get("y", "0")) * scale
            width = float(shape.attrib["width"]) * scale
            height = float(shape.attrib["height"]) * scale
            draw.rectangle((x, y, x + width - 1, y + height - 1), fill=shape.attrib["fill"])
        elif tag == "polygon":
            points = [tuple(float(n) * scale for n in point.split(","))
                      for point in shape.attrib["points"].split()]
            draw.polygon(points, fill=shape.attrib["fill"])
        else:
            raise ValueError(f"Unsupported icon shape: {tag}")
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main():
    render(180).save(PUBLIC / "noted-apple-touch-icon-v3.png")
    render(32).save(PUBLIC / "noted-favicon-v3-32.png")
    render(48).save(PUBLIC / "noted-favicon-v3.ico", format="ICO",
                    sizes=[(16, 16), (32, 32), (48, 48)],
                    append_images=[render(16), render(32)])
    for source, fallback in [
        (SOURCE.name, "favicon.svg"),
        ("noted-favicon-v3.ico", "favicon.ico"),
        ("noted-apple-touch-icon-v3.png", "apple-touch-icon.png"),
    ]:
        shutil.copyfile(PUBLIC / source, PUBLIC / fallback)


if __name__ == "__main__":
    main()
