"""Scorebug location and per-frame reading parser.

The scorebug is ScoreCheck's own overlay (see
apps/web/src/app/overlay/court/[courtNumber]/OverlayClient.tsx): two team rows
(serve icon | gold seed | condensed uppercase name | per-set score cells with
the current set in gold) above a meta strip reading ``COURT n  SET n  MATCH n``
(``SET n`` becomes ``FINAL`` when the match ends).

Parsing is deliberately geometry-light: OCR tokens are clustered into the two
team rows and the meta strip by vertical position. The current-set score is
rendered in a gold gradient (#f9e29b -> #d4af37) while completed-set finals
are dim white, so the current score is located by a gold hue mask to the
right of the name and read with a dedicated tiled OCR pass (Apple Vision's
text detector reliably misses lone digits, but reads the same digit tiled
into a line at ~100% — measured on real footage). Completed-set finals come
from the generic OCR tokens right of the name. The serve indicator is the
same gold hue left of the name column of the serving team's row.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from .digit_templates import default_bank, read_digits
from .ocr_apple import OcrToken, recognize_text

_COURT_RE = re.compile(r"\bCOURT\s+(\d+)\b")
_SET_RE = re.compile(r"\bSET\s+(\d+)\b")
_MATCH_RE = re.compile(r"\bMATCH\s+(\d+)\b")
_FINAL_RE = re.compile(r"\bFINAL\b")
_SEED_NAME_RE = re.compile(r"^(\d{1,2})\s+(.+)$")
_DIGITS_RE = re.compile(r"^\d{1,6}$")

# The overlay's gold spans a gradient (#f9e29b bright to #d4af37 base) and a
# 0.8-alpha seed variant; a hue-style rule beats a single center+tolerance.
_MIN_GOLD_PIXELS = 25


@dataclass(frozen=True, slots=True)
class BugRect:
    """Pixel-space crop rectangle for the scorebug within the source frame."""

    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class RowReading:
    seed: int | None
    name: str
    current_score: int | None
    finals_digits: str | None
    serving: bool


@dataclass(frozen=True, slots=True)
class ScorebugReading:
    t_seconds: float
    court: int | None
    set_number: int | None
    match_number: int | None
    is_final: bool
    row_a: RowReading
    row_b: RowReading

    @property
    def has_scores(self) -> bool:
        return self.row_a.current_score is not None and self.row_b.current_score is not None


def locate_scorebug(
    probe_frames: list[np.ndarray],
    *,
    min_hits: int = 2,
) -> BugRect | None:
    """Find the scorebug rect by OCRing full probe frames.

    Anchors on the ``COURT n ... MATCH n`` meta strip, then unions the token
    boxes of the two team rows directly above it. Returns the padded union
    over all probe frames that contained the strip, or None when fewer than
    ``min_hits`` frames matched.
    """

    boxes: list[tuple[float, float, float, float]] = []
    for frame in probe_frames:
        height, width, _ = frame.shape
        tokens = recognize_text(frame)
        meta = [
            t
            for t in tokens
            if _COURT_RE.search(t.text.upper()) or _MATCH_RE.search(t.text.upper())
        ]
        if not meta:
            continue
        meta_top = min(t.y for t in meta)
        meta_bottom = max(t.y + t.height for t in meta)
        meta_height = meta_bottom - meta_top
        meta_left = min(t.x for t in meta)
        # Team rows sit within ~5 meta-strip heights above the strip and
        # start at roughly the same left edge.
        row_tokens = [
            t
            for t in tokens
            if t.y + t.height <= meta_top + meta_height * 0.5
            and t.y >= meta_top - meta_height * 6.0
            and t.x >= meta_left - 0.05
        ]
        group = row_tokens + meta
        left = min(t.x for t in group)
        right = max(t.x + t.width for t in group)
        top = min(t.y for t in group)
        bottom = max(t.y + t.height for t in group)
        # Pad: left for the serve-icon column, all sides for cell borders.
        pad_x = 0.14 * (right - left)
        pad_y = 0.10 * (bottom - top)
        boxes.append(
            (
                max(0.0, left - pad_x),
                max(0.0, top - pad_y),
                min(1.0, right + pad_x * 0.4),
                min(1.0, bottom + pad_y),
            )
        )
    if len(boxes) < min_hits:
        return None
    arr = np.array(boxes)
    left, top = arr[:, 0].min(), arr[:, 1].min()
    right, bottom = arr[:, 2].max(), arr[:, 3].max()
    height, width, _ = probe_frames[0].shape
    x = int(left * width)
    y = int(top * height)
    w = int(np.ceil((right - left) * width))
    h = int(np.ceil((bottom - top) * height))
    # Round out to even numbers for codec-friendly cropping.
    return BugRect(x=x & ~1, y=y & ~1, width=(w + 1) & ~1, height=(h + 1) & ~1)


def _gold_mask(region: np.ndarray) -> np.ndarray:
    """Boolean mask of overlay-gold pixels (gradient + brightness tolerant)."""
    r = region[..., 0].astype(np.int16)
    g = region[..., 1].astype(np.int16)
    b = region[..., 2].astype(np.int16)
    return (r > 140) & (g > 110) & (b < 175) & (r - b > 50) & (g - b > 30)


_CELL_SCALE = 4
_CELL_TILES = 7
_CELL_MIN_GAP_PX = 80
_BLUR_WINDOW = 5
_DIGIT_LOOKALIKES = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "|": "1", "S": "5", "B": "8"})


def _moving_average(arr: np.ndarray, window: int, axis: int) -> np.ndarray:
    pad_spec = [(0, 0)] * arr.ndim
    pad_spec[axis] = (window // 2, window // 2)
    padded = np.pad(arr, pad_spec, mode="edge")
    summed = np.cumsum(padded, axis=axis, dtype=np.float32)
    zero = np.zeros_like(np.take(summed, [0], axis=axis))
    summed = np.concatenate([zero, summed], axis=axis)
    upper = np.take(summed, range(window, padded.shape[axis] + 1), axis=axis)
    lower = np.take(summed, range(0, padded.shape[axis] + 1 - window), axis=axis)
    return (upper - lower) / window


def _box_blur(image: np.ndarray, window: int) -> np.ndarray:
    blurred = _moving_average(image, window, axis=0)
    blurred = _moving_average(blurred, window, axis=1)
    return np.clip(blurred, 0, 255).astype(np.uint8)


def _read_gold_cell(
    crop: np.ndarray,
    y0: int,
    y1: int,
    x_min: int,
) -> int | None:
    """Read the gold current-score digits in a row band right of ``x_min``.

    Vision's detector reliably skips isolated one/two-glyph regions (a lone
    tiled '0' returns nothing at all), so the cell is upscaled, tiled into a
    synthetic seven-copy text line, and lightly blurred to soften the
    nearest-neighbor blocks — measured on real footage, that combination
    reads lone digits at 1.00 confidence. The majority read wins.
    """

    band = crop[y0:y1, x_min:]
    if band.size == 0:
        return None
    mask = _gold_mask(band)
    ys, xs = np.nonzero(mask)
    if xs.size < _MIN_GOLD_PIXELS:
        return None
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    if by1 - by0 < 8 or bx1 - bx0 < 3:
        return None

    # Primary path: fixed-font template classification of the glyph masks —
    # deterministic and immune to Vision's lone-glyph detection gaps.
    bank = default_bank()
    if bank is not None:
        value = read_digits(mask[by0:by1, bx0:bx1], bank)
        if value is not None:
            return value

    # Fallback: tiled OCR (new overlay themes without a harvested bank).
    pad = 4
    cell = band[max(0, by0 - pad) : by1 + pad, max(0, bx0 - pad) : bx1 + pad]
    cell = np.repeat(np.repeat(cell, _CELL_SCALE, axis=0), _CELL_SCALE, axis=1)
    height, width, _ = cell.shape
    gap = np.zeros((height, max(width, _CELL_MIN_GAP_PX), 3), dtype=np.uint8)
    parts = [gap]
    for _ in range(_CELL_TILES):
        parts += [cell, gap]
    tiled = _box_blur(np.concatenate(parts, axis=1), _BLUR_WINDOW)
    # Scores are at most two digits; the wide gaps keep tiles as separate
    # tokens, so anything longer is a tile merge and simply doesn't vote.
    reads: list[str] = []
    for token in recognize_text(tiled):
        text = token.text.strip().translate(_DIGIT_LOOKALIKES).replace(" ", "")
        if _DIGITS_RE.match(text) and len(text) <= 2:
            reads.append(text)
    if not reads:
        return None
    counts: dict[str, int] = {}
    for read in reads:
        counts[read] = counts.get(read, 0) + 1
    best, best_count = max(counts.items(), key=lambda kv: kv[1])
    if best_count < 2:
        return None
    return int(best)


def _parse_row(
    row_tokens: list[OcrToken],
    crop: np.ndarray,
    *,
    serve_column_frac: float,
) -> RowReading | None:
    if not row_tokens:
        return None
    # Name token: the widest alphabetic token.
    name_tokens = [t for t in row_tokens if re.search(r"[A-Z]{2,}", t.text.upper())]
    if not name_tokens:
        return None
    name_token = max(name_tokens, key=lambda t: t.width)
    seed: int | None = None
    name = name_token.text.strip().upper()
    matched = _SEED_NAME_RE.match(name)
    if matched:
        seed = int(matched.group(1))
        name = matched.group(2).strip()
    else:
        # The seed may OCR as its own numeric token left of the name.
        seed_tokens = [
            t
            for t in row_tokens
            if t is not name_token
            and t.x < name_token.x
            and _DIGITS_RE.match(t.text.strip())
            and len(t.text.strip()) <= 2
        ]
        if seed_tokens:
            seed = int(max(seed_tokens, key=lambda t: t.x).text.strip())
    height, width, _ = crop.shape
    name_right = name_token.x + name_token.width
    # Row band in pixels, padded beyond the name token's extents because the
    # tall score cells overhang the text baseline.
    y0 = max(0, int((name_token.y - 0.06) * height))
    y1 = min(height, int((name_token.y + name_token.height + 0.06) * height))

    # Current-set score: gold digits right of the name (color-located OCR).
    current = _read_gold_cell(crop, y0, y1, int((name_right + 0.005) * width))

    # Completed-set finals: dim-white numeric tokens right of the name. The
    # gold current cell may bleed into the same tokens; strip trailing digits
    # that duplicate the current score when both were merged by the OCR line.
    digit_tokens = sorted(
        (
            t
            for t in row_tokens
            if t is not name_token
            and t.x >= name_right - 0.01
            and _DIGITS_RE.match(t.text.strip())
        ),
        key=lambda t: t.x,
    )
    finals: str | None = None
    if digit_tokens:
        merged = "".join(t.text.strip() for t in digit_tokens)
        if current is not None and merged.endswith(str(current)):
            merged = merged[: len(merged) - len(str(current))]
        finals = merged or None

    # Serve indicator: gold pixels in the icon column left of the seed/name.
    x1 = max(1, int(serve_column_frac * width))
    serving = bool(_gold_mask(crop[y0:y1, 0:x1]).sum() >= 12)

    return RowReading(
        seed=seed,
        name=name,
        current_score=current,
        finals_digits=finals,
        serving=serving,
    )


def parse_scorebug(
    crop: np.ndarray,
    t_seconds: float,
    *,
    tokens: list[OcrToken] | None = None,
) -> ScorebugReading | None:
    """Parse one scorebug crop into a reading; None when no bug is legible."""

    if tokens is None:
        tokens = recognize_text(crop)
    if not tokens:
        return None
    upper = [(t, t.text.upper()) for t in tokens]

    court = set_number = match_number = None
    is_final = False
    meta_tokens: list[OcrToken] = []
    for token, text in upper:
        c, s, m = _COURT_RE.search(text), _SET_RE.search(text), _MATCH_RE.search(text)
        f = _FINAL_RE.search(text)
        if c or s or m or f:
            meta_tokens.append(token)
            court = int(c.group(1)) if c else court
            set_number = int(s.group(1)) if s else set_number
            match_number = int(m.group(1)) if m else match_number
            is_final = is_final or bool(f)
    if not meta_tokens:
        return None
    meta_top = min(t.y for t in meta_tokens)

    row_candidates = [t for t, _ in upper if t.y + t.height <= meta_top + 0.02]
    if not row_candidates:
        return None
    # Cluster into two rows by center-y midpoint.
    centers = sorted(t.center_y for t in row_candidates)
    midpoint = (centers[0] + centers[-1]) / 2.0
    row_one = [t for t in row_candidates if t.center_y < midpoint]
    row_two = [t for t in row_candidates if t.center_y >= midpoint]

    parsed_one = _parse_row(row_one, crop, serve_column_frac=0.055)
    parsed_two = _parse_row(row_two, crop, serve_column_frac=0.055)
    if parsed_one is None or parsed_two is None:
        return None
    return ScorebugReading(
        t_seconds=t_seconds,
        court=court,
        set_number=set_number,
        match_number=match_number,
        is_final=is_final,
        row_a=parsed_one,
        row_b=parsed_two,
    )
