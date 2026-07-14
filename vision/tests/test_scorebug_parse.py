"""Parser tests using OCR token fixtures captured from the real bWK VOD.

Token geometry mirrors Apple Vision output on scorebug crops
(top-left-origin normalized coordinates). Crops are synthetic: current-score
reading requires real gold digit glyphs, so it is covered by the integration
run on real footage; these tests cover token clustering, meta parsing, seed
variants, finals extraction, and the color-based serve indicator.
"""

from __future__ import annotations

import unittest

import numpy as np

from scorevision.ocr_apple import OcrToken
from scorevision.scorebug import parse_scorebug

GOLD = (216, 192, 96)  # sampled from the real overlay's gradient midpoint


def token(text: str, x: float, y_top: float, w: float, h: float = 0.18) -> OcrToken:
    return OcrToken(text=text, confidence=1.0, x=x, y=y_top, width=w, height=h)


def blank_crop() -> np.ndarray:
    return np.zeros((124, 626, 3), dtype=np.uint8)


def crop_with_serve_icon(row: str) -> np.ndarray:
    crop = blank_crop()
    band = slice(10, 40) if row == "one" else slice(60, 92)
    crop[band, 8:26] = GOLD
    return crop


class ParseTest(unittest.TestCase):
    def _tokens_set1(self) -> list[OcrToken]:
        # From the real frame at t=3600: set 1 (digit tokens read by the
        # generic pass become finals candidates; gold-cell reads need pixels).
        return [
            token("7 THEO BRUNNER / RYAN WILCOX", 0.093, 0.097, 0.508, 0.145),
            token("18 ALEXANDER HARTHALLER / DIEGO PEREZ", 0.086, 0.484, 0.658, 0.145),
            token("COURT 14 SET 1 MATCH 14", 0.058, 0.790, 0.323, 0.113),
        ]

    def test_set1_reading(self) -> None:
        reading = parse_scorebug(blank_crop(), 3600.0, tokens=self._tokens_set1())
        assert reading is not None
        self.assertEqual(reading.court, 14)
        self.assertEqual(reading.set_number, 1)
        self.assertEqual(reading.match_number, 14)
        self.assertFalse(reading.is_final)
        self.assertEqual(reading.row_a.seed, 7)
        self.assertEqual(reading.row_a.name, "THEO BRUNNER / RYAN WILCOX")
        self.assertEqual(reading.row_b.seed, 18)
        self.assertIsNone(reading.row_a.current_score)  # no gold pixels
        self.assertFalse(reading.has_scores)

    def test_separate_seed_token(self) -> None:
        # At 3x OCR scale the seed can split into its own token.
        tokens = [
            token("18", 0.089, 0.504, 0.030, 0.12),
            token("ALEXANDER HARTHALLER / DIEGO PEREZ", 0.124, 0.481, 0.60, 0.145),
            token("7 THEO BRUNNER / RYAN WILCOX", 0.093, 0.094, 0.508, 0.145),
            token("COURT 14 SET 1 MATCH 14", 0.054, 0.792, 0.323, 0.113),
        ]
        reading = parse_scorebug(blank_crop(), 0.0, tokens=tokens)
        assert reading is not None
        self.assertEqual(reading.row_b.seed, 18)
        self.assertEqual(reading.row_b.name, "ALEXANDER HARTHALLER / DIEGO PEREZ")

    def test_finals_digits_from_white_cells(self) -> None:
        tokens = [
            token("1 ELLA CONNOR / MARINE KINNA", 0.112, 0.15, 0.504, 0.145),
            token("21", 0.842, 0.15, 0.05, 0.16),
            token("8 MEGAN RICE / KENDRA VANZWIETEN", 0.108, 0.47, 0.608, 0.145),
            token("19", 0.842, 0.47, 0.05, 0.16),
            token("COURT 14 SET 2 MATCH 11", 0.069, 0.79, 0.323, 0.113),
        ]
        reading = parse_scorebug(blank_crop(), 1800.0, tokens=tokens)
        assert reading is not None
        self.assertEqual(reading.set_number, 2)
        self.assertEqual(reading.match_number, 11)
        self.assertEqual(reading.row_a.finals_digits, "21")
        self.assertEqual(reading.row_b.finals_digits, "19")

    def test_final_reading(self) -> None:
        # From the real frame at t=7000: meta splits into two tokens and
        # FINAL replaces SET.
        tokens = [
            token("7 THEO BRUNNER / RYAN WILCOX", 0.093, 0.10, 0.508, 0.145),
            token("10", 0.78, 0.10, 0.05, 0.16),
            token("18 ALEXANDER HARTHALLER / DIEGO PEREZ", 0.086, 0.48, 0.658, 0.145),
            token("21", 0.78, 0.48, 0.05, 0.16),
            token("COURT 14 |", 0.058, 0.79, 0.12, 0.113),
            token("FINAL MATCH 14", 0.19, 0.79, 0.20, 0.113),
        ]
        reading = parse_scorebug(blank_crop(), 7000.0, tokens=tokens)
        assert reading is not None
        self.assertTrue(reading.is_final)
        self.assertIsNone(reading.set_number)
        self.assertEqual(reading.match_number, 14)

    def test_serving_detection_row_one(self) -> None:
        reading = parse_scorebug(
            crop_with_serve_icon("one"), 0.0, tokens=self._tokens_set1()
        )
        assert reading is not None
        self.assertTrue(reading.row_a.serving)
        self.assertFalse(reading.row_b.serving)

    def test_serving_detection_row_two(self) -> None:
        reading = parse_scorebug(
            crop_with_serve_icon("two"), 0.0, tokens=self._tokens_set1()
        )
        assert reading is not None
        self.assertFalse(reading.row_a.serving)
        self.assertTrue(reading.row_b.serving)

    def test_gold_current_score_read_from_pixels(self) -> None:
        # Paint a gold block where a score digit would be: the gold-cell
        # reader OCRs a tiled line; a solid block yields no digits, so the
        # reading reports no current score rather than a hallucination.
        crop = blank_crop()
        crop[10:40, 480:500] = GOLD
        reading = parse_scorebug(crop, 0.0, tokens=self._tokens_set1())
        assert reading is not None
        self.assertIsNone(reading.row_a.current_score)

    def test_no_meta_returns_none(self) -> None:
        tokens = [token("SOME RANDOM SIGN", 0.2, 0.4, 0.4)]
        self.assertIsNone(parse_scorebug(blank_crop(), 0.0, tokens=tokens))

    def test_prematch_rows_without_digits(self) -> None:
        reading = parse_scorebug(blank_crop(), 0.0, tokens=self._tokens_set1())
        assert reading is not None
        self.assertIsNone(reading.row_a.finals_digits)
        self.assertFalse(reading.has_scores)


if __name__ == "__main__":
    unittest.main()


class SportcamParseTest(unittest.TestCase):
    """Fixtures captured from a real SportCam-overlay VOD (5oeyVLTdwUc)."""

    def test_set1_current_only(self) -> None:
        tokens = [
            token("8", 0.718, 0.138, 0.046, 0.16),
            token("HURST/BASEY", 0.111, 0.123, 0.454, 0.16),
            token("PEREZ/HARTHALLER", 0.039, 0.415, 0.664, 0.16),
            token("9", 0.711, 0.446, 0.054, 0.16),
            token("1st 00:00", 0.543, 0.763, 0.226, 0.12),
            token("SPORTCAM", 0.025, 0.815, 0.182, 0.12),
        ]
        reading = parse_scorebug(blank_crop(), 600.0, tokens=tokens)
        assert reading is not None
        self.assertIsNone(reading.court)
        self.assertIsNone(reading.match_number)
        self.assertEqual(reading.set_number, 1)
        self.assertEqual(reading.row_a.name, "HURST/BASEY")
        self.assertEqual(reading.row_a.current_score, 8)
        self.assertIsNone(reading.row_a.finals_digits)
        self.assertEqual(reading.row_b.current_score, 9)

    def test_set2_finals_and_current(self) -> None:
        tokens = [
            token("HURST/BASEY", 0.111, 0.123, 0.454, 0.16),
            token("14", 0.825, 0.123, 0.093, 0.16),
            token("21", 0.729, 0.154, 0.071, 0.16),
            token("|PEREZ/HARTHALLER 15", 0.011, 0.431, 0.789, 0.16),
            token("14", 0.821, 0.415, 0.093, 0.16),
            token("2nd 00:00", 0.682, 0.769, 0.250, 0.12),
            token("SPORTCAM", 0.025, 0.800, 0.186, 0.12),
        ]
        reading = parse_scorebug(blank_crop(), 2400.0, tokens=tokens)
        assert reading is not None
        self.assertEqual(reading.set_number, 2)
        self.assertEqual(reading.row_a.finals_digits, "21")
        self.assertEqual(reading.row_a.current_score, 14)
        self.assertEqual(reading.row_b.name, "PEREZ/HARTHALLER")
        self.assertEqual(reading.row_b.finals_digits, "15")
        self.assertEqual(reading.row_b.current_score, 14)

    def test_missed_lone_current_reports_no_score(self) -> None:
        # Real failure at t=1500: row A's lone '1' was not detected; the set
        # final must not be promoted into the current slot.
        tokens = [
            token("HURST/BASEY", 0.111, 0.123, 0.454, 0.16),
            token("21", 0.729, 0.154, 0.071, 0.16),
            token("15", 0.725, 0.446, 0.071, 0.16),
            token("1", 0.821, 0.415, 0.061, 0.16),
            token("PEREZ/HARTHALLER", 0.032, 0.413, 0.673, 0.16),
            token("2nd 00:00", 0.629, 0.769, 0.254, 0.12),
            token("SPORTCAM", 0.025, 0.800, 0.186, 0.12),
        ]
        reading = parse_scorebug(blank_crop(), 1500.0, tokens=tokens)
        assert reading is not None
        self.assertIsNone(reading.row_a.current_score)
        self.assertEqual(reading.row_a.finals_digits, "21")
        self.assertEqual(reading.row_b.current_score, 1)
        self.assertFalse(reading.has_scores)
