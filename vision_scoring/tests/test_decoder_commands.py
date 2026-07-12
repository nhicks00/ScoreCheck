from __future__ import annotations

from pathlib import Path
import unittest

from vision_scoring.decoder_commands import (
    DECODER_COMMAND_SCHEMA_VERSION,
    PROBE_SHOW_ENTRIES_V1,
    RGB24_FILTER_GRAPH_V1,
    decoder_decode_argv_v1,
    decoder_probe_argv_v1,
)


class DecoderCommandTests(unittest.TestCase):
    def test_probe_argv_is_exact_and_immutable(self) -> None:
        executable = Path("/immutable/runtime/ffprobe")
        actual = decoder_probe_argv_v1(
            executable,
            input_fd=17,
            selected_video_stream_index=2,
        )
        self.assertEqual(DECODER_COMMAND_SCHEMA_VERSION, "1.0")
        self.assertEqual(
            actual,
            (
                "/immutable/runtime/ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "17",
                "-select_streams",
                "2",
                "-show_frames",
                "-show_entries",
                (
                    "stream=index,codec_type,time_base,width,height,pix_fmt,"
                    "color_space,color_range,start_pts:"
                    "stream_side_data=rotation:"
                    "frame=stream_index,pts,width,height,pix_fmt,color_space,"
                    "color_range"
                ),
                "-of",
                "json",
                "fd:",
            ),
        )
        self.assertIs(type(actual), tuple)
        self.assertEqual(actual[11], PROBE_SHOW_ENTRIES_V1)

    def test_decode_argv_is_exact_and_immutable(self) -> None:
        executable = Path("/immutable/runtime/ffmpeg")
        actual = decoder_decode_argv_v1(
            executable,
            input_fd=17,
            framehash_output_fd=23,
            selected_video_stream_index=4,
        )
        self.assertEqual(
            actual,
            (
                "/immutable/runtime/ffmpeg",
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
                "17",
                "-i",
                "fd:",
                "-filter_complex",
                f"[0:4]{RGB24_FILTER_GRAPH_V1}",
                "-map",
                "[raw]",
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
                "rawvideo",
                "-protocol_whitelist",
                "pipe",
                "pipe:1",
                "-map",
                "[hash]",
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
                "23",
                "fd:",
            ),
        )
        self.assertIs(type(actual), tuple)

    def test_invalid_executables_fail_closed(self) -> None:
        for value in (
            "/immutable/runtime/ffprobe",
            Path("relative/ffprobe"),
            Path("/immutable/runtime/\x00ffprobe"),
        ):
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "executable"):
                    decoder_probe_argv_v1(  # type: ignore[arg-type]
                        value,
                        input_fd=3,
                        selected_video_stream_index=0,
                    )

    def test_descriptors_and_stream_index_are_exact_bounded_integers(self) -> None:
        executable = Path("/immutable/runtime/ffmpeg")
        invalid_values = (True, False, -1, 1 << 63, 1.0, "1", None)
        for field_name in (
            "input_fd",
            "framehash_output_fd",
            "selected_video_stream_index",
        ):
            for value in invalid_values:
                kwargs: dict[str, object] = {
                    "input_fd": 17,
                    "framehash_output_fd": 23,
                    "selected_video_stream_index": 4,
                }
                kwargs[field_name] = value
                with self.subTest(field_name=field_name, value=value):
                    with self.assertRaisesRegex(ValueError, field_name):
                        decoder_decode_argv_v1(  # type: ignore[arg-type]
                            executable,
                            **kwargs,
                        )

    def test_probe_rejects_invalid_descriptor_and_stream_types(self) -> None:
        executable = Path("/immutable/runtime/ffprobe")
        for field_name in ("input_fd", "selected_video_stream_index"):
            for value in (True, -1, 1 << 63, 1.0, "1", None):
                kwargs: dict[str, object] = {
                    "input_fd": 17,
                    "selected_video_stream_index": 4,
                }
                kwargs[field_name] = value
                with self.subTest(field_name=field_name, value=value):
                    with self.assertRaisesRegex(ValueError, field_name):
                        decoder_probe_argv_v1(  # type: ignore[arg-type]
                            executable,
                            **kwargs,
                        )

    def test_decode_requires_distinct_descriptors(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be distinct"):
            decoder_decode_argv_v1(
                Path("/immutable/runtime/ffmpeg"),
                input_fd=17,
                framehash_output_fd=17,
                selected_video_stream_index=0,
            )


if __name__ == "__main__":
    unittest.main()
