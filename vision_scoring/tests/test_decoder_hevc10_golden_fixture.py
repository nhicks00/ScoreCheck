from __future__ import annotations

import hashlib
import json
from pathlib import Path
import unittest


FIXTURE_DIRECTORY = Path(__file__).resolve().parent / "fixtures"
MEDIA_PATH = FIXTURE_DIRECTORY / "deterministic_decoder_hevc10_v1.mp4"
EXPECTED_PATH = (
    FIXTURE_DIRECTORY / "deterministic_decoder_hevc10_v1.expected.json"
)
MEDIA_SHA256 = (
    "380fc82506dc596f572e5535c99713ee676f7c37e5682506e994d93df1cd3aa0"
)
EXPECTED_SHA256 = (
    "d7faaa382018313c5c49f3e02d53915b389f53dc6a026fecdaef02929ea31fa7"
)


class DecoderHevc10GoldenFixtureTests(unittest.TestCase):
    """Verify the checked HEVC decoder oracle without invoking ambient tools."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.media = MEDIA_PATH.read_bytes()
        cls.expected_raw = EXPECTED_PATH.read_bytes()
        cls.expected = json.loads(cls.expected_raw)

    def test_media_and_expected_oracle_are_immutable(self) -> None:
        self.assertEqual(len(self.media), 2_218)
        self.assertEqual(hashlib.sha256(self.media).hexdigest(), MEDIA_SHA256)
        self.assertEqual(
            hashlib.sha256(self.expected_raw).hexdigest(), EXPECTED_SHA256
        )
        self.assertEqual(
            self.expected_raw,
            (
                json.dumps(
                    self.expected,
                    ensure_ascii=True,
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            ).encode("ascii"),
        )

    def test_codec_geometry_color_and_time_base_are_exact(self) -> None:
        self.assertEqual(
            self.expected["domain"],
            "multicourt-vision-scoring:decoder-hevc10-golden:v1",
        )
        self.assertEqual(self.expected["schema_version"], "1.0")
        self.assertEqual(
            self.expected["fixture"],
            {
                "filename": MEDIA_PATH.name,
                "sha256": MEDIA_SHA256,
                "size_bytes": 2_218,
            },
        )
        selected = self.expected["selected_video"]
        self.assertEqual(selected["codec_name"], "hevc")
        self.assertEqual(selected["codec_tag"], "hvc1")
        self.assertEqual(selected["source_pixel_format"], "yuv420p10le")
        self.assertEqual((selected["width"], selected["height"]), (64, 64))
        self.assertEqual((selected["color_space"], selected["color_range"]), ("bt709", "tv"))
        self.assertEqual(
            (
                selected["time_base_numerator"],
                selected["time_base_denominator"],
            ),
            (1, 1000),
        )

    def test_vfr_b_frames_and_rgb_hashes_are_fully_pinned(self) -> None:
        frames = self.expected["presentation_frames"]
        self.assertEqual([row["frame_index"] for row in frames], list(range(5)))
        self.assertEqual([row["pts"] for row in frames], [103, 149, 211, 307, 467])
        self.assertEqual(
            [row["pict_type"] for row in frames], ["I", "B", "B", "P", "P"]
        )
        self.assertEqual(len({row["rgb24_sha256"] for row in frames}), 5)
        packets = self.expected["demux_packets"]
        self.assertEqual([row["pts"] for row in packets], [103, 307, 211, 149, 467])
        self.assertEqual([row["dts"] for row in packets], [-5, 41, 103, 149, 211])
        self.assertNotEqual(
            [row["pts"] for row in packets], [row["pts"] for row in frames]
        )

    def test_generator_is_explicitly_development_only(self) -> None:
        generator = self.expected["development_generator"]
        self.assertIs(generator["production_approved"], False)
        self.assertIs(generator["license_reviewed_for_production"], False)
        self.assertIs(generator["decoder_acceptance_requires_external_encoder"], False)
        self.assertEqual(generator["compressed_encoder"], "libx265")
        self.assertEqual(
            generator["ffmpeg_executable_sha256"],
            "8d97d0745b0d1d8f6296c026c426c263f509306b8f81c9ffe4e93e95890ca8be",
        )
        self.assertEqual(
            generator["ffprobe_executable_sha256"],
            "94da026e33f8c684ab2a449d25611bb808222f7f08a7d3a6233665a63fbab47a",
        )


if __name__ == "__main__":
    unittest.main()
