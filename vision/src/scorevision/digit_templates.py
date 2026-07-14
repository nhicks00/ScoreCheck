"""Fixed-font digit classification for the ScoreCheck scorebug gold cells.

Apple Vision's text detector is unreliable on isolated one/two-glyph regions
(a lone gold '0' returns nothing under most preprocessing), but the overlay
font is ours and fixed, so the robust reader is plain template correlation:

- segment the gold-masked cell into glyph columns,
- normalize each glyph mask to a fixed grid,
- classify against a harvested template bank by normalized correlation.

The bank ships with the package (harvested from real footage via
``scripts/harvest_digit_templates.py``) and can be re-harvested for a new
overlay theme in minutes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources

import numpy as np

GLYPH_WIDTH = 12
GLYPH_HEIGHT = 20
MIN_CORRELATION = 0.72
_MIN_GLYPH_COLUMNS = 2
_MIN_GLYPH_PIXELS = 12
_GAP_MAX_COLUMN_PIXELS = 0  # a column with any gold pixel is part of a glyph


def normalize_glyph(mask: np.ndarray) -> np.ndarray | None:
    """Tight-crop a boolean glyph mask and resample to the fixed grid."""
    ys, xs = np.nonzero(mask)
    if xs.size < _MIN_GLYPH_PIXELS:
        return None
    tight = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    height, width = tight.shape
    if height < 6 or width < _MIN_GLYPH_COLUMNS:
        return None
    row_idx = np.round(np.linspace(0, height - 1, GLYPH_HEIGHT)).astype(int)
    col_idx = np.round(np.linspace(0, width - 1, GLYPH_WIDTH)).astype(int)
    return tight[np.ix_(row_idx, col_idx)].astype(np.float32)


def segment_glyphs(mask: np.ndarray) -> list[np.ndarray]:
    """Split a cell's gold mask into per-glyph masks by column gaps."""
    column_counts = mask.sum(axis=0)
    glyphs: list[np.ndarray] = []
    start: int | None = None
    for x, count in enumerate(column_counts):
        filled = count > _GAP_MAX_COLUMN_PIXELS
        if filled and start is None:
            start = x
        elif not filled and start is not None:
            if x - start >= _MIN_GLYPH_COLUMNS:
                glyphs.append(mask[:, start:x])
            start = None
    if start is not None and mask.shape[1] - start >= _MIN_GLYPH_COLUMNS:
        glyphs.append(mask[:, start:])
    return glyphs


@dataclass(frozen=True)
class DigitBank:
    labels: list[str]
    matrix: np.ndarray  # one L2-normalized zero-mean row per template

    def classify(self, glyph: np.ndarray) -> tuple[str, float] | None:
        flat = glyph.flatten()
        flat = flat - flat.mean()
        norm = float(np.linalg.norm(flat))
        if norm < 1e-6:
            return None
        scores = self.matrix @ (flat / norm)
        best = int(np.argmax(scores))
        return self.labels[best], float(scores[best])


def bank_from_templates(templates: list[tuple[str, np.ndarray]]) -> DigitBank:
    rows = []
    labels = []
    for label, glyph in templates:
        flat = glyph.flatten().astype(np.float32)
        flat = flat - flat.mean()
        norm = float(np.linalg.norm(flat))
        if norm < 1e-6:
            continue
        rows.append(flat / norm)
        labels.append(label)
    if not rows:
        raise ValueError("no usable templates")
    return DigitBank(labels=labels, matrix=np.stack(rows))


def load_bank_json(payload: dict) -> DigitBank:
    templates = []
    for item in payload["templates"]:
        glyph = np.array(item["grid"], dtype=np.float32)
        if glyph.shape != (GLYPH_HEIGHT, GLYPH_WIDTH):
            raise ValueError("template grid has wrong shape")
        templates.append((str(item["label"]), glyph))
    return bank_from_templates(templates)


_DEFAULT_BANK: DigitBank | None = None


def default_bank() -> DigitBank | None:
    global _DEFAULT_BANK
    if _DEFAULT_BANK is None:
        try:
            text = (
                resources.files("scorevision")
                .joinpath("data/scorebug_digit_templates.json")
                .read_text()
            )
        except (FileNotFoundError, ModuleNotFoundError):
            return None
        _DEFAULT_BANK = load_bank_json(json.loads(text))
    return _DEFAULT_BANK


def read_digits(mask: np.ndarray, bank: DigitBank) -> int | None:
    """Classify a cell's gold mask into its digit value (None = unsure)."""
    glyphs = segment_glyphs(mask)
    if not 1 <= len(glyphs) <= 2:
        return None
    digits = []
    for glyph_mask in glyphs:
        glyph = normalize_glyph(glyph_mask)
        if glyph is None:
            return None
        result = bank.classify(glyph)
        if result is None or result[1] < MIN_CORRELATION:
            return None
        digits.append(result[0])
    return int("".join(digits))
