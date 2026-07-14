"""Harvest scorebug digit templates from a VOD with known score timestamps.

Usage:
    uv run python scripts/harvest_digit_templates.py VOD.mp4 \
        --bug-rect 0,20,626,124 --spec harvest_spec.json \
        --out src/scorevision/data/scorebug_digit_templates.json

The spec is a JSON list of [t_seconds, score_a, score_b] entries whose values
are known to be on screen at that time (e.g. from a prior labeler run's
events.jsonl, offset a couple of seconds after each commit). Each cell's gold
mask is segmented into glyphs; glyph counts must match the digit count of the
expected value or the sample is skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from scorevision.digit_templates import (  # noqa: E402
    GLYPH_HEIGHT,
    GLYPH_WIDTH,
    normalize_glyph,
    segment_glyphs,
)
from scorevision.ocr_apple import recognize_text  # noqa: E402
from scorevision.scorebug import BugRect, _gold_mask  # noqa: E402
from scorevision.vod_labeler import stream_crops  # noqa: E402


def row_bands(crop: np.ndarray) -> list[tuple[int, int, int]] | None:
    """Locate (y0, y1, x_min) for both team rows via the name tokens."""
    tokens = recognize_text(crop)
    height, width, _ = crop.shape
    names = [
        t
        for t in tokens
        if len(t.text) > 12 and t.width > 0.3 and t.y + t.height < 0.75
    ]
    if len(names) < 2:
        return None
    names.sort(key=lambda t: t.y)
    bands = []
    for token in names[:2]:
        y0 = max(0, int((token.y - 0.06) * height))
        y1 = min(height, int((token.y + token.height + 0.06) * height))
        x_min = int((token.x + token.width + 0.005) * width)
        bands.append((y0, y1, x_min))
    return bands


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--bug-rect", required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    x, y, w, h = (int(v) for v in args.bug_rect.split(","))
    rect = BugRect(x=x, y=y, width=w, height=h)
    spec = json.loads(args.spec.read_text())

    collected: dict[str, list[np.ndarray]] = {}
    used = skipped = 0
    for t_seconds, score_a, score_b in spec:
        crops = list(
            stream_crops(
                args.source, rect, fps=1.0, start_seconds=float(t_seconds), max_seconds=1.0
            )
        )
        if not crops:
            skipped += 1
            continue
        crop = crops[0][1]
        bands = row_bands(crop)
        if bands is None:
            skipped += 1
            continue
        for expected, (y0, y1, x_min) in zip((score_a, score_b), bands):
            band = crop[y0:y1, x_min:]
            mask = _gold_mask(band)
            ys, xs = np.nonzero(mask)
            if xs.size < 20:
                skipped += 1
                continue
            cell = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
            glyphs = segment_glyphs(cell)
            expected_str = str(expected)
            if len(glyphs) != len(expected_str):
                skipped += 1
                continue
            for digit, glyph_mask in zip(expected_str, glyphs):
                glyph = normalize_glyph(glyph_mask)
                if glyph is None:
                    continue
                collected.setdefault(digit, []).append(glyph)
                used += 1

    print(f"samples used: {used}, skipped: {skipped}")
    print({k: len(v) for k, v in sorted(collected.items())})
    missing = [str(d) for d in range(10) if str(d) not in collected]
    if missing:
        print(f"WARNING: no templates for digits: {missing}")

    templates = []
    for digit, glyphs in sorted(collected.items()):
        # Keep up to 3 diverse exemplars per digit: first, middle, last.
        picks = {0, len(glyphs) // 2, len(glyphs) - 1}
        for index in sorted(picks):
            templates.append(
                {
                    "label": digit,
                    "grid": [[int(v) for v in row] for row in glyphs[index]],
                }
            )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "glyph_width": GLYPH_WIDTH,
                "glyph_height": GLYPH_HEIGHT,
                "source": str(args.source.name),
                "templates": templates,
            },
            indent=1,
        )
    )
    print(f"wrote {len(templates)} templates -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
