from __future__ import annotations

import hashlib
import json
from pathlib import Path
import unittest


FIXTURE_DIRECTORY = Path(__file__).resolve().parent / "fixtures"
MEDIA_PATH = FIXTURE_DIRECTORY / "deterministic_decoder_v1.mp4"
EXPECTED_PATH = (
    FIXTURE_DIRECTORY / "deterministic_decoder_v1.expected.json"
)
MEDIA_SHA256 = (
    "3dcf5b3701577c1e49b450e4325dceaae20b2c16fc524cb2f0b925136e9860c1"
)
EXPECTED_SHA256 = (
    "1183c51a30a2398d06134669232c3283b253548367a38c184e51bf5e637eed11"
)
REPEATED_RGB_SHA256 = (
    "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827"
)


class DecoderGoldenFixtureTests(unittest.TestCase):
    """Verify the checked-in contract without invoking an ambient decoder."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.media = MEDIA_PATH.read_bytes()
        cls.expected_raw = EXPECTED_PATH.read_bytes()
        cls.expected = json.loads(cls.expected_raw)

    def test_fixture_bytes_and_expected_json_are_immutable(self) -> None:
        fixture = self.expected["fixture"]
        self.assertEqual(fixture["filename"], MEDIA_PATH.name)
        self.assertEqual(fixture["size_bytes"], 6_836)
        self.assertEqual(fixture["size_bytes"], len(self.media))
        self.assertEqual(fixture["sha256"], MEDIA_SHA256)
        self.assertEqual(hashlib.sha256(self.media).hexdigest(), MEDIA_SHA256)
        self.assertEqual(
            hashlib.sha256(self.expected_raw).hexdigest(),
            EXPECTED_SHA256,
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

    def test_selected_source_grid_contract_is_exact(self) -> None:
        self.assertEqual(self.expected["schema_version"], "1.0")
        self.assertEqual(
            self.expected["source_streams"],
            [
                {"codec_type": "audio", "stream_index": 0},
                {
                    "codec_type": "video",
                    "height": 8,
                    "stream_index": 1,
                    "width": 8,
                },
                {
                    "codec_type": "video",
                    "height": 12,
                    "stream_index": 2,
                    "width": 16,
                },
            ],
        )
        self.assertEqual(
            self.expected["selected_video"],
            {
                "autorotation_policy": "IGNORE_CONTAINER_DISPLAY_TRANSFORM",
                "color_range": "tv",
                "color_space": "bt709",
                "decoded_frame_hash_basis": (
                    "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
                ),
                "frame_size_bytes": 576,
                "height": 12,
                "output_pixel_format": "rgb24",
                "rotation_degrees": 90,
                "source_pts_are_absolute": True,
                "stream_index": 2,
                "time_base_denominator": 1000,
                "time_base_numerator": 1,
                "width": 16,
            },
        )

    def test_presentation_pts_and_b_frame_packet_reorder_are_fixed(self) -> None:
        frames = self.expected["presentation_frames"]
        self.assertEqual(
            [frame["frame_index"] for frame in frames], [0, 1, 2, 3, 4]
        )
        presentation_pts = [frame["pts"] for frame in frames]
        self.assertEqual(presentation_pts, [101, 137, 191, 263, 401])
        self.assertEqual(
            [frame["pict_type"] for frame in frames],
            ["I", "B", "B", "P", "P"],
        )
        self.assertEqual(
            [frame["framehash_duration"] for frame in frames],
            [36, 36, 54, 54, 40],
        )
        self.assertTrue(
            all(
                left < right
                for left, right in zip(
                    presentation_pts, presentation_pts[1:]
                )
            )
        )

        packets = self.expected["demux_packets"]
        packet_pts = [packet["pts"] for packet in packets]
        packet_dts = [packet["dts"] for packet in packets]
        self.assertEqual(packet_pts, [101, 263, 137, 191, 401])
        self.assertEqual(packet_dts, [11, 47, 101, 137, 191])
        self.assertNotEqual(packet_pts, presentation_pts)
        self.assertEqual(sorted(packet_pts), presentation_pts)
        self.assertTrue(
            all(left < right for left, right in zip(packet_dts, packet_dts[1:]))
        )

    def test_repeated_pixels_and_ignored_rotation(self) -> None:
        frames = self.expected["presentation_frames"]
        hashes = [frame["rgb24_sha256"] for frame in frames]
        self.assertEqual(
            self.expected["pixel_equivalent_frame_index_groups"], [[0, 1, 4]]
        )
        self.assertEqual(
            [hashes[index] for index in (0, 1, 4)],
            [REPEATED_RGB_SHA256] * 3,
        )
        self.assertEqual(len(set(hashes)), 3)

        rotated = self.expected["autorotate_negative_control"]
        self.assertEqual((rotated["width"], rotated["height"]), (12, 16))
        rotated_hashes = rotated["rgb24_sha256s"]
        self.assertEqual(len(rotated_hashes), len(hashes))
        self.assertEqual(rotated_hashes[0], hashes[0])
        self.assertNotEqual(rotated_hashes[2], hashes[2])
        self.assertNotEqual(rotated_hashes[3], hashes[3])

    def test_generator_identity_is_development_only_and_pinned(self) -> None:
        generator = self.expected["development_generator"]
        self.assertIs(generator["production_approved"], False)
        self.assertEqual(
            generator["ffmpeg_executable_sha256"],
            "8d97d0745b0d1d8f6296c026c426c263f509306b8f81c9ffe4e93e95890ca8be",
        )
        self.assertEqual(
            generator["ffprobe_executable_sha256"],
            "94da026e33f8c684ab2a449d25611bb808222f7f08a7d3a6233665a63fbab47a",
        )
        self.assertTrue(
            generator["ffmpeg_version_line"].startswith("ffmpeg version 8.1 ")
        )
        self.assertTrue(
            generator["ffprobe_version_line"].startswith("ffprobe version 8.1 ")
        )


if __name__ == "__main__":
    unittest.main()
