from __future__ import annotations

import hashlib
from pathlib import Path
import unittest

from vision_scoring.capture_measurement_commands import (
    CAPTURE_MEASUREMENT_COMMAND_SCHEMA_VERSION,
    CAPTURE_MEASUREMENT_RECIPE_DOMAIN,
    CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
    FFPROBE_JSON_OUTPUT_FORMAT_V1,
    MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1,
    PRESENTATION_METADATA_SHOW_ENTRIES_V1,
    SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1,
    capture_measurement_presentation_metadata_argv_v1,
    capture_measurement_recipe_descriptor_v1,
    capture_measurement_recipe_sha256_v1,
    capture_measurement_rgb24_framehash_argv_v1,
    capture_measurement_selected_video_packets_argv_v1,
)
from vision_scoring.contract_wire import canonical_json_bytes
from vision_scoring.decoder_commands import RGB24_FILTER_GRAPH_V1


class CaptureMeasurementCommandTests(unittest.TestCase):
    def test_presentation_metadata_argv_is_exact_and_immutable(self) -> None:
        actual = capture_measurement_presentation_metadata_argv_v1(
            Path("/pinned/runtime/ffprobe"),
            input_fd=17,
            selected_video_stream_index=2,
        )
        self.assertEqual(
            actual,
            (
                "/pinned/runtime/ffprobe",
                "-v",
                "error",
                "-bitexact",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "17",
                "-i",
                "fd:",
                "-select_streams",
                "2",
                "-show_streams",
                "-show_frames",
                "-show_entries",
                (
                    "stream=index,codec_name,codec_type,time_base,width,height,"
                    "field_order:stream_side_data=rotation:frame=media_type,"
                    "stream_index,pts,pkt_dts,duration,pkt_pos,pkt_size,width,"
                    "height,pix_fmt,interlaced_frame,top_field_first,repeat_pict,"
                    "coded_picture_number,display_picture_number"
                ),
                "-of",
                "json=compact=1",
            ),
        )
        self.assertIs(type(actual), tuple)
        self.assertEqual(actual[15], PRESENTATION_METADATA_SHOW_ENTRIES_V1)
        self.assertEqual(actual[17], FFPROBE_JSON_OUTPUT_FORMAT_V1)
        self.assertNotIn("-o", actual)

    def test_selected_video_packet_argv_is_exact_and_audio_excluding(self) -> None:
        actual = capture_measurement_selected_video_packets_argv_v1(
            Path("/pinned/runtime/ffprobe"),
            input_fd=23,
            selected_video_stream_index=4,
        )
        self.assertEqual(
            actual,
            (
                "/pinned/runtime/ffprobe",
                "-v",
                "error",
                "-bitexact",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "23",
                "-i",
                "fd:",
                "-select_streams",
                "4",
                "-show_streams",
                "-show_packets",
                "-show_entries",
                (
                    "stream=index,codec_type,time_base:packet=stream_index,pts,"
                    "dts,duration,pos,size,flags"
                ),
                "-of",
                "json=compact=1",
            ),
        )
        self.assertIs(type(actual), tuple)
        self.assertEqual(actual[15], SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1)
        self.assertEqual(actual[10:12], ("-select_streams", "4"))
        self.assertNotIn("-show_data", actual)
        self.assertNotIn("-o", actual)

    def test_rgb24_framehash_argv_is_exact_bitexact_and_single_threaded(self) -> None:
        actual = capture_measurement_rgb24_framehash_argv_v1(
            Path("/pinned/runtime/ffmpeg"),
            input_fd=31,
            framehash_output_fd=37,
            selected_video_stream_index=6,
        )
        self.assertEqual(
            actual,
            (
                "/pinned/runtime/ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-bitexact",
                "-filter_threads",
                "1",
                "-filter_complex_threads",
                "1",
                "-copyts",
                "-threads",
                "1",
                "-hwaccel",
                "none",
                "-noautorotate",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "31",
                "-i",
                "fd:",
                "-filter_complex",
                f"[0:6]{MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1}",
                "-map",
                "[hash]",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-an",
                "-sn",
                "-dn",
                "-c:v",
                "rawvideo",
                "-threads:v",
                "1",
                "-pix_fmt",
                "rgb24",
                "-fps_mode",
                "passthrough",
                "-enc_time_base",
                "-1",
                "-f",
                "framehash",
                "-hash",
                "sha256",
                "-format_version",
                "2",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "37",
                "fd:",
            ),
        )
        self.assertIs(type(actual), tuple)
        self.assertEqual(actual[22:26], ("-filter_complex", f"[0:6]{MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1}", "-map", "[hash]"))
        self.assertIn("-noautorotate", actual)
        self.assertEqual(actual.count("1"), 4)
        self.assertNotIn("pipe:1", actual)

    def test_measurement_filter_reuses_fixed_decoder_rgb24_semantics(self) -> None:
        self.assertTrue(
            RGB24_FILTER_GRAPH_V1.startswith(
                MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1.removesuffix("[hash]")
            )
        )
        self.assertIn("bitexact", MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1)
        self.assertIn("sws_dither=none", MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1)
        self.assertIn("format=pix_fmts=rgb24", MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1)

    def test_selected_stream_is_absolute_and_unambiguous_in_every_command(self) -> None:
        metadata = capture_measurement_presentation_metadata_argv_v1(
            Path("/pinned/ffprobe"),
            input_fd=3,
            selected_video_stream_index=9,
        )
        packets = capture_measurement_selected_video_packets_argv_v1(
            Path("/pinned/ffprobe"),
            input_fd=5,
            selected_video_stream_index=9,
        )
        framehash = capture_measurement_rgb24_framehash_argv_v1(
            Path("/pinned/ffmpeg"),
            input_fd=7,
            framehash_output_fd=8,
            selected_video_stream_index=9,
        )
        for argv in (metadata, packets):
            index = argv.index("-select_streams")
            self.assertEqual(argv[index + 1], "9")
            self.assertEqual(argv.count("-select_streams"), 1)
        self.assertIn(f"[0:9]{MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1}", framehash)
        self.assertEqual(framehash[framehash.index("-map") + 1], "[hash]")
        for token in ("-an", "-sn", "-dn"):
            self.assertIn(token, framehash)

    def test_exact_absolute_path_and_subclass_attacks_fail_closed(self) -> None:
        exact_path_type = type(Path("/"))

        class PathSubclass(exact_path_type):
            pass

        invalid_paths: tuple[object, ...] = (
            "/pinned/ffprobe",
            Path("relative/ffprobe"),
            Path("/pinned/\x00ffprobe"),
            PathSubclass("/pinned/ffprobe"),
        )
        for value in invalid_paths:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "ffprobe_executable"):
                    capture_measurement_presentation_metadata_argv_v1(
                        value,  # type: ignore[arg-type]
                        input_fd=3,
                        selected_video_stream_index=0,
                    )

    def test_fds_and_stream_index_reject_bool_subclasses_and_signed_64_overflow(self) -> None:
        probe_functions = (
            capture_measurement_presentation_metadata_argv_v1,
            capture_measurement_selected_video_packets_argv_v1,
        )
        for function in probe_functions:
            for field_name in ("input_fd", "selected_video_stream_index"):
                invalid_values = (
                    (True, False, -1, 0, 1, 2, 1 << 63, 1.0, "3", None)
                    if field_name == "input_fd"
                    else (True, False, -1, 1 << 63, 1.0, "3", None)
                )
                for invalid in invalid_values:
                    kwargs: dict[str, object] = {
                        "input_fd": 3,
                        "selected_video_stream_index": 0,
                    }
                    kwargs[field_name] = invalid
                    with self.subTest(
                        function=function.__name__, field_name=field_name, invalid=invalid
                    ):
                        with self.assertRaisesRegex(ValueError, field_name):
                            function(Path("/pinned/tool"), **kwargs)  # type: ignore[arg-type]

        for field_name in (
            "input_fd",
            "framehash_output_fd",
            "selected_video_stream_index",
        ):
            invalid_values = (
                (True, False, -1, 0, 1, 2, 1 << 63, 1.0, "3", None)
                if field_name != "selected_video_stream_index"
                else (True, False, -1, 1 << 63, 1.0, "3", None)
            )
            for invalid in invalid_values:
                kwargs = {
                    "input_fd": 3,
                    "framehash_output_fd": 4,
                    "selected_video_stream_index": 0,
                }
                kwargs[field_name] = invalid
                with self.subTest(field_name=field_name, invalid=invalid):
                    with self.assertRaisesRegex(ValueError, field_name):
                        capture_measurement_rgb24_framehash_argv_v1(
                            Path("/pinned/tool"), **kwargs  # type: ignore[arg-type]
                        )

    def test_framehash_requires_distinct_preopened_descriptors(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be distinct"):
            capture_measurement_rgb24_framehash_argv_v1(
                Path("/pinned/runtime/tool"),
                input_fd=11,
                framehash_output_fd=11,
                selected_video_stream_index=0,
            )

    def test_commands_have_no_ambient_network_shell_or_source_path_surface(self) -> None:
        commands = (
            capture_measurement_presentation_metadata_argv_v1(
                Path("/pinned/ffprobe"),
                input_fd=3,
                selected_video_stream_index=0,
            ),
            capture_measurement_selected_video_packets_argv_v1(
                Path("/pinned/ffprobe"),
                input_fd=5,
                selected_video_stream_index=0,
            ),
            capture_measurement_rgb24_framehash_argv_v1(
                Path("/pinned/ffmpeg"),
                input_fd=7,
                framehash_output_fd=8,
                selected_video_stream_index=0,
            ),
        )
        forbidden_protocols = ("file:", "http:", "https:", "rtmp:", "srt:", "tcp:", "udp:")
        for argv in commands:
            self.assertIs(type(argv), tuple)
            self.assertNotIn("-y", argv)
            self.assertNotIn("-f", argv[:2])
            self.assertNotIn("-r", argv)
            self.assertNotIn("-vf", argv)
            self.assertNotIn("-filter:v", argv)
            self.assertFalse(any(token in {"sh", "bash", "zsh", "shell"} for token in argv))
            self.assertFalse(any(any(protocol in token for protocol in forbidden_protocols) for token in argv))
            for index, token in enumerate(argv[:-1]):
                if token == "-protocol_whitelist":
                    self.assertEqual(argv[index + 1], "fd")
            self.assertTrue(all(token == argv[0] or "/" not in token for token in argv))

    def test_b_frame_packet_timing_is_collected_but_separate_from_cadence(self) -> None:
        self.assertIn("frame=media_type,stream_index,pts,pkt_dts", PRESENTATION_METADATA_SHOW_ENTRIES_V1)
        self.assertIn("packet=stream_index,pts,dts", SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1)
        descriptor = capture_measurement_recipe_descriptor_v1()
        self.assertEqual(
            descriptor["presentation_cadence_basis"],
            "FRAME_PTS_IN_JSON_ARRAY_ORDER_ONLY",
        )
        self.assertEqual(
            descriptor["packet_timing_role"],
            "DIAGNOSTIC_ONLY_NOT_PRESENTATION_CADENCE",
        )
        self.assertEqual(
            descriptor["frame_ordinal"],
            "ZERO_BASED_PRESENTATION_FRAMES_JSON_ARRAY_ORDER",
        )

    def test_recipe_domain_fingerprint_is_fixed_fresh_and_semantic_sensitive(self) -> None:
        self.assertEqual(CAPTURE_MEASUREMENT_COMMAND_SCHEMA_VERSION, "1.0")
        self.assertEqual(
            CAPTURE_MEASUREMENT_RECIPE_DOMAIN,
            "multicourt-vision-scoring:capture-measurement-command-recipe:v1",
        )
        self.assertEqual(
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
            "38cdf53aa9692b49441135d57849404539769f4ab85786511a5886580c9eaea3",
        )
        self.assertEqual(
            capture_measurement_recipe_sha256_v1(),
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
        )

        first = capture_measurement_recipe_descriptor_v1()
        second = capture_measurement_recipe_descriptor_v1()
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertIsNot(first["metadata_argv_template"], second["metadata_argv_template"])
        first["metadata_argv_template"][1] = "-changed-semantic"
        changed = hashlib.sha256(
            canonical_json_bytes(
                first,
                label="changed recipe",
                maximum_bytes=64 * 1024,
            )
        ).hexdigest()
        self.assertNotEqual(changed, CAPTURE_MEASUREMENT_RECIPE_SHA256_V1)
        self.assertEqual(
            capture_measurement_recipe_sha256_v1(),
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
        )


if __name__ == "__main__":
    unittest.main()
