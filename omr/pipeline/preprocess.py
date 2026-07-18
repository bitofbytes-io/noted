#!/usr/bin/env python3
"""Assemble deterministically rendered score pages into one multi-page TIFF."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from PIL import Image

VERSION = "1"


def assemble_tiff(inputs: list[Path], output: Path) -> None:
    if not inputs:
        raise ValueError("at least one rendered page is required")
    pages: list[Image.Image] = []
    try:
        for path in inputs:
            with Image.open(path) as image:
                image.load()
                if image.format != "PNG":
                    raise ValueError(f"rendered page is not PNG: {path.name}")
                pages.append(image.convert("L"))
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(output.name + ".tmp")
        pages[0].save(
            temporary,
            format="TIFF",
            save_all=True,
            append_images=pages[1:],
            compression="tiff_deflate",
            dpi=(300, 300),
        )
        os.chmod(temporary, 0o600)
        os.replace(temporary, output)
    finally:
        for page in pages:
            page.close()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("inputs", nargs="*", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.version:
        print(VERSION)
        return 0
    if args.output is None:
        raise ValueError("--output is required")
    assemble_tiff(args.inputs, args.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # worker logs are bounded and never returned verbatim
        print(f"pre-processing failed: {error}", file=sys.stderr)
        raise SystemExit(1)
