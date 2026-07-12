from __future__ import annotations

from contextlib import redirect_stdout
from copy import deepcopy
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from vision_scoring import media_preflight
from vision_scoring.media_preflight import (
    ExplicitSourceContext,
    MediaPreflight,
    OfflinePlaceholderError,
    ProbeError,
    SubprocessProbeBackend,
    UnverifiedRightsClaim,
    canonical_json_bytes,
    main,
)


def probe_fixture() -> dict[str, object]:
    return {
        "programs": [],
        "format": {
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "format_long_name": "QuickTime / MOV",
            "start_time": "0.000000",
            "duration": "10.100000",
            "bit_rate": "9000000",
            "probe_score": 100,
            "nb_streams": 4,
            "nb_programs": 0,
        },
        "streams": [
            {
                "index": 4,
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "pix_fmt": "yuv420p",
                "r_frame_rate": "30/1",
                "avg_frame_rate": "30/1",
                "time_base": "1/30000",
                "duration": "10.000000",
                "duration_ts": 300000,
                "disposition": {"default": 0, "attached_pic": 0},
            },
            {
                "index": 2,
                "codec_type": "video",
                "codec_name": "hevc",
                "profile": "Main",
                "width": 3840,
                "height": 2160,
                "pix_fmt": "yuv420p10le",
                "r_frame_rate": "60/1",
                "avg_frame_rate": "60000/1001",
                "time_base": "1/60000",
                "duration": "10.000000",
                "duration_ts": 600000,
                "disposition": {"default": 1, "attached_pic": 0},
                "side_data_list": [{"rotation": 0}],
            },
            {
                "index": 7,
                "codec_type": "video",
                "codec_name": "mjpeg",
                "width": 600,
                "height": 600,
                "time_base": "1/90000",
                "disposition": {"default": 1, "attached_pic": 1},
            },
            {
                "index": 8,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
                "channel_layout": "stereo",
                "time_base": "1/48000",
                "duration": "10.100000",
                "duration_ts": 484800,
                "disposition": {"default": 1, "attached_pic": 0},
            },
        ],
    }


class FixtureProbe:
    def __init__(
        self,
        *,
        metadata: dict[str, object] | None = None,
        packet_lines: tuple[str, ...] = (
            "pts=0|dts=-2",
            "pts=1|dts=-1",
            "pts=1|dts=N/A",
            "pts=N/A|dts=0",
            "pts=0|dts=0",
        ),
        identity_error: Exception | None = None,
        metadata_error: Exception | None = None,
        packet_error: Exception | None = None,
        metadata_hook=None,
    ) -> None:
        self.metadata = metadata if metadata is not None else probe_fixture()
        self.packet_rows = packet_lines
        self.identity_error = identity_error
        self.metadata_error = metadata_error
        self.packet_error = packet_error
        self.metadata_hook = metadata_hook
        self.selected_stream_indices: list[int] = []
        self.metadata_calls = 0
        self.packet_iterator_closed = False
        self.metadata_source_paths: list[Path] = []
        self.packet_source_paths: list[Path] = []
        self.metadata_source_bytes: list[bytes] = []
        self.packet_source_bytes: list[bytes] = []

    def identity(self) -> dict[str, str]:
        if self.identity_error is not None:
            raise self.identity_error
        return {
            "backend": "fixture-ffprobe",
            "version_line": "fixture-ffprobe version 1.0",
            "version_output_sha256": "f" * 64,
        }

    def read_metadata(self, source: Path) -> dict[str, object]:
        self.metadata_calls += 1
        self.metadata_source_paths.append(source)
        self.metadata_source_bytes.append(source.read_bytes())
        if self.metadata_hook is not None:
            self.metadata_hook(source)
        if self.metadata_error is not None:
            raise self.metadata_error
        return deepcopy(self.metadata)

    def iter_packet_lines(self, source: Path, stream_index: int):
        self.selected_stream_indices.append(stream_index)
        self.packet_source_paths.append(source)
        self.packet_source_bytes.append(source.read_bytes())
        try:
            for line in self.packet_rows:
                yield line
            if self.packet_error is not None:
                raise self.packet_error
        finally:
            self.packet_iterator_closed = True


class MediaPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.source = Path(self.temporary_directory.name) / "fixture.mov"
        self.source.write_bytes(b"deterministic media fixture bytes")

    def test_successful_report_hashes_source_and_scans_exact_timestamps(self) -> None:
        backend = FixtureProbe()
        report = MediaPreflight(backend).inspect_sources([self.source])

        self.assertTrue(report["technical_preflight_complete"])
        self.assertEqual(report["probe_backend_identity"]["backend"], "fixture-ffprobe")
        item = report["items"][0]
        self.assertEqual(item["status"], "QUARANTINED")
        self.assertNotIn("rights", item)
        self.assertEqual(item["rights_claim"]["claim"], "NO_CLAIM")
        self.assertEqual(item["rights_claim"]["verification"], "UNVERIFIED")
        self.assertNotIn("status", item["rights_claim"])
        self.assertEqual(
            item["file"]["sha256"],
            hashlib.sha256(self.source.read_bytes()).hexdigest(),
        )
        self.assertEqual(item["file"]["size_bytes"], self.source.stat().st_size)
        self.assertEqual(item["probe"]["primary_video_stream_index"], 2)
        self.assertEqual(backend.selected_stream_indices, [2])

        scan = item["probe"]["primary_video_packet_timestamps"]
        self.assertEqual(scan["packet_count"], 5)
        self.assertEqual(scan["pts"]["present_count"], 4)
        self.assertEqual(scan["pts"]["missing_count"], 1)
        self.assertEqual(
            scan["pts"]["missing_packet_ranges"],
            [{"start_packet_index": 3, "end_packet_index": 3}],
        )
        self.assertEqual(scan["pts"]["equal_previous_in_demux_order_count"], 1)
        self.assertEqual(
            scan["pts"]["equal_previous_in_demux_order"][0]["packet_index"], 2
        )
        self.assertEqual(scan["pts"]["demux_order_regression_count"], 1)
        self.assertEqual(
            scan["pts"]["demux_order_regressions"][0]["packet_index"], 4
        )
        self.assertEqual(scan["dts"]["missing_count"], 1)
        self.assertEqual(scan["dts"]["equal_previous_in_demux_order_count"], 1)
        self.assertEqual(scan["dts"]["demux_order_regression_count"], 0)
        self.assertIn("normal codec/B-frame", scan["interpretation"]["pts"])
        self.assertIn("not proof of capture health", scan["interpretation"]["dts"])

        delta = item["probe"]["av_duration_delta"]
        self.assertTrue(delta["available"])
        self.assertEqual(delta["audio_minus_video_seconds"]["exact_fraction"], "1/10")
        self.assertEqual(delta["audio_minus_video_seconds"]["exact_decimal"], "0.1")

        unhashed = dict(report)
        checksum = unhashed.pop("report_sha256")
        self.assertEqual(
            checksum,
            hashlib.sha256(canonical_json_bytes(unhashed)).hexdigest(),
        )
        self.assertEqual(report, MediaPreflight(FixtureProbe()).inspect_sources([self.source]))

    def test_packet_failure_discards_partial_scan_and_fails_closed(self) -> None:
        backend = FixtureProbe(packet_error=ProbeError("fixture packet failure"))
        report = MediaPreflight(backend).inspect_sources([self.source])

        item = report["items"][0]
        self.assertFalse(report["technical_preflight_complete"])
        self.assertFalse(item["technical_preflight_complete"])
        self.assertIsNone(item["probe"])
        self.assertIsNotNone(item["file"])
        self.assertEqual(item["errors"][0]["code"], "FFPROBE_FAILED")
        self.assertIn("fixture packet failure", item["errors"][0]["message"])

    def test_malformed_packet_row_fails_closed(self) -> None:
        backend = FixtureProbe(packet_lines=("pts=1|dts=not-an-integer",))
        report = MediaPreflight(backend).inspect_sources([self.source])
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIn("not an integer", report["items"][0]["errors"][0]["message"])
        self.assertTrue(backend.packet_iterator_closed)

    def test_no_video_stream_fails_closed_without_packet_scan(self) -> None:
        metadata = probe_fixture()
        metadata["streams"] = [
            stream
            for stream in metadata["streams"]
            if stream["codec_type"] != "video"
        ]
        backend = FixtureProbe(metadata=metadata)
        report = MediaPreflight(backend).inspect_sources([self.source])
        self.assertFalse(report["technical_preflight_complete"])
        self.assertEqual(backend.selected_stream_indices, [])
        self.assertIn("no non-attached-picture video", report["items"][0]["errors"][0]["message"])

    def test_stream_count_is_bounded(self) -> None:
        metadata = probe_fixture()
        metadata["streams"] = [
            {
                "index": index,
                "codec_type": "video",
                "disposition": {"default": 0, "attached_pic": 0},
            }
            for index in range(129)
        ]
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIn("more than 128 streams", report["items"][0]["errors"][0]["message"])

    def test_probe_scalar_and_normalized_item_sizes_are_bounded(self) -> None:
        metadata = probe_fixture()
        metadata["format"]["format_long_name"] = "x" * 4097
        scalar_report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        self.assertFalse(scalar_report["technical_preflight_complete"])
        self.assertIn(
            "4096-character ffprobe scalar limit",
            scalar_report["items"][0]["errors"][0]["message"],
        )

        with patch.object(
            media_preflight,
            "_MAX_ITEM_CANONICAL_JSON_BYTES",
            1000,
        ):
            item_report = MediaPreflight(FixtureProbe()).inspect_sources([self.source])
        item = item_report["items"][0]
        self.assertFalse(item["technical_preflight_complete"])
        self.assertIsNone(item["probe"])
        self.assertIn(
            "ITEM_REPORT_SIZE_EXCEEDED",
            {error["code"] for error in item["errors"]},
        )

    def test_total_normalized_report_size_is_bounded(self) -> None:
        second_source = Path(self.temporary_directory.name) / "second.mov"
        second_source.write_bytes(b"second source")
        with patch.object(
            media_preflight,
            "_MAX_REPORT_CANONICAL_JSON_BYTES",
            8000,
        ):
            report = MediaPreflight(FixtureProbe()).inspect_sources(
                [self.source, second_source]
            )
            self.assertLessEqual(len(canonical_json_bytes(report)), 8000)
        self.assertFalse(report["technical_preflight_complete"])
        size_error_codes = {
            error["code"] for item in report["items"] for error in item["errors"]
        }
        self.assertTrue(
            size_error_codes
            & {"REPORT_ITEM_BUDGET_EXCEEDED", "TOTAL_REPORT_SIZE_EXCEEDED"}
        )

    def test_probe_identity_failure_marks_otherwise_scanned_item_incomplete(self) -> None:
        backend = FixtureProbe(identity_error=ProbeError("identity unavailable"))
        report = MediaPreflight(backend).inspect_sources([self.source])
        item = report["items"][0]
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIsNone(item["probe"])
        self.assertEqual(backend.metadata_calls, 0)
        self.assertEqual(item["errors"][-1]["code"], "PROBE_IDENTITY_FAILED")

    def test_duration_fallback_preserves_nonterminating_exact_fraction(self) -> None:
        metadata = probe_fixture()
        video = next(stream for stream in metadata["streams"] if stream["index"] == 2)
        audio = next(stream for stream in metadata["streams"] if stream["index"] == 8)
        video.pop("duration")
        audio.pop("duration")
        video.update({"duration_ts": 1, "time_base": "1/3"})
        audio.update({"duration_ts": 2, "time_base": "1/3"})
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources([self.source])
        delta = report["items"][0]["probe"]["av_duration_delta"]
        self.assertEqual(delta["audio_minus_video_seconds"]["exact_fraction"], "1/3")
        self.assertIsNone(delta["audio_minus_video_seconds"]["exact_decimal"])

    def test_terminating_decimal_is_exact_and_decimal_context_independent(self) -> None:
        tiny = Fraction(1, 2**100)
        rendered = media_preflight._terminating_decimal(tiny)
        self.assertIsNotNone(rendered)
        self.assertEqual(Fraction(Decimal(rendered)), tiny)

        metadata = probe_fixture()
        video = next(stream for stream in metadata["streams"] if stream["index"] == 2)
        audio = next(stream for stream in metadata["streams"] if stream["index"] == 8)
        video["duration"] = "0"
        audio["duration"] = rendered
        with localcontext() as context:
            context.prec = 6
            low_precision_report = MediaPreflight(
                FixtureProbe(metadata=metadata)
            ).inspect_sources([self.source])
        with localcontext() as context:
            context.prec = 200
            high_precision_report = MediaPreflight(
                FixtureProbe(metadata=metadata)
            ).inspect_sources([self.source])
        self.assertEqual(low_precision_report, high_precision_report)
        self.assertEqual(
            low_precision_report["items"][0]["probe"]["av_duration_delta"][
                "audio_minus_video_seconds"
            ]["exact_fraction"],
            f"1/{2**100}",
        )

    def test_adversarial_duration_numbers_fail_before_unbounded_exact_arithmetic(self) -> None:
        for value in ("1e1000000", "1e-1000000", "9" * 78):
            with self.subTest(value=value[:20]):
                metadata = probe_fixture()
                video = next(
                    stream for stream in metadata["streams"] if stream["index"] == 2
                )
                video["duration"] = value
                report = MediaPreflight(
                    FixtureProbe(metadata=metadata)
                ).inspect_sources([self.source])
                self.assertFalse(report["technical_preflight_complete"])
                self.assertIn(
                    "limit",
                    report["items"][0]["errors"][0]["message"],
                )

        metadata = probe_fixture()
        video = next(stream for stream in metadata["streams"] if stream["index"] == 2)
        video.pop("duration")
        video["time_base"] = "1/" + "9" * 78
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIn("component magnitude", report["items"][0]["errors"][0]["message"])

        with self.assertRaisesRegex(ProbeError, "scale exceeded"):
            media_preflight._terminating_decimal(Fraction(1, 2**300))

    def test_av_duration_pairing_never_crosses_programs(self) -> None:
        metadata = probe_fixture()
        metadata["programs"] = [
            {"program_id": 100, "streams": [{"index": 2}]},
            {"program_id": 200, "streams": [{"index": 4}, {"index": 8}]},
        ]
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        probe = report["items"][0]["probe"]
        self.assertIsNone(probe["primary_audio_stream_index"])
        self.assertEqual(
            probe["av_duration_delta"]["reason"],
            "NO_AUDIO_STREAM_IN_PRIMARY_VIDEO_PROGRAM",
        )
        self.assertEqual(
            probe["stream_selection"]["primary_video"]["program_ids"], [100]
        )
        self.assertEqual(
            probe["stream_selection"]["primary_audio"]["candidate_stream_indices"],
            [],
        )

    def test_av_duration_uses_audio_from_unique_primary_video_program(self) -> None:
        metadata = probe_fixture()
        audio_in_video_program = deepcopy(
            next(stream for stream in metadata["streams"] if stream["index"] == 8)
        )
        audio_in_video_program.update(
            {
                "index": 9,
                "duration": "10.200000",
                "duration_ts": 489600,
                "disposition": {"default": 0, "attached_pic": 0},
            }
        )
        metadata["streams"].append(audio_in_video_program)
        metadata["programs"] = [
            {"program_id": 100, "streams": [{"index": 2}, {"index": 9}]},
            {"program_id": 200, "streams": [{"index": 4}, {"index": 8}]},
        ]
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        probe = report["items"][0]["probe"]
        self.assertEqual(probe["primary_audio_stream_index"], 9)
        self.assertEqual(
            probe["av_duration_delta"]["audio_minus_video_seconds"][
                "exact_fraction"
            ],
            "1/5",
        )
        self.assertEqual(
            probe["stream_selection"]["primary_audio"]["basis"],
            "UNIQUE_PRIMARY_VIDEO_PROGRAM_DEFAULT_DISPOSITION_THEN_LOWEST_STREAM_INDEX",
        )

    def test_ambiguous_primary_video_program_membership_blocks_duration_pairing(self) -> None:
        metadata = probe_fixture()
        metadata["programs"] = [
            {"program_id": 100, "streams": [{"index": 2}, {"index": 8}]},
            {"program_id": 200, "streams": [{"index": 2}, {"index": 8}]},
        ]
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources(
            [self.source]
        )
        probe = report["items"][0]["probe"]
        self.assertIsNone(probe["primary_audio_stream_index"])
        self.assertEqual(
            probe["av_duration_delta"]["reason"],
            "PRIMARY_VIDEO_PROGRAM_MEMBERSHIP_AMBIGUOUS",
        )

    def test_anomaly_details_are_bounded_but_counts_remain_exact(self) -> None:
        detail_limit = media_preflight._MAX_TIMESTAMP_DETAILS_PER_KIND
        rows = tuple("pts=7|dts=N/A" for _ in range(detail_limit + 5))
        report = MediaPreflight(FixtureProbe(packet_lines=rows)).inspect_sources([self.source])
        scan = report["items"][0]["probe"]["primary_video_packet_timestamps"]

        self.assertEqual(
            scan["pts"]["equal_previous_in_demux_order_count"], detail_limit + 4
        )
        self.assertEqual(
            len(scan["pts"]["equal_previous_in_demux_order"]), detail_limit
        )
        self.assertTrue(scan["pts"]["equal_previous_details_truncated"])
        self.assertEqual(scan["dts"]["missing_count"], detail_limit + 5)
        self.assertEqual(scan["dts"]["missing_range_count"], 1)
        self.assertFalse(scan["dts"]["missing_details_truncated"])

        alternating_rows: list[str] = []
        for index in range(detail_limit + 5):
            alternating_rows.extend(("pts=N/A|dts=0", f"pts={index}|dts=1"))
        range_report = MediaPreflight(
            FixtureProbe(packet_lines=tuple(alternating_rows))
        ).inspect_sources([self.source])
        range_stats = range_report["items"][0]["probe"][
            "primary_video_packet_timestamps"
        ]["pts"]
        self.assertEqual(range_stats["missing_count"], detail_limit + 5)
        self.assertEqual(range_stats["missing_range_count"], detail_limit + 5)
        self.assertEqual(len(range_stats["missing_packet_ranges"]), detail_limit)
        self.assertTrue(range_stats["missing_details_truncated"])

    def test_nonfinite_metadata_and_invalid_timeouts_are_rejected(self) -> None:
        metadata = probe_fixture()
        metadata["format"]["probe_score"] = math.nan
        report = MediaPreflight(FixtureProbe(metadata=metadata)).inspect_sources([self.source])
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIn("not a finite", report["items"][0]["errors"][0]["message"])

        for invalid in (True, 0, -1, math.nan, math.inf):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    SubprocessProbeBackend(metadata_timeout_seconds=invalid)
                with self.assertRaises(ValueError):
                    SubprocessProbeBackend(packet_timeout_seconds=invalid)
        defaults = SubprocessProbeBackend()
        self.assertEqual(defaults.metadata_timeout_seconds, 60.0)
        self.assertEqual(defaults.packet_timeout_seconds, 300.0)

    def test_malformed_disposition_objects_and_values_fail_closed(self) -> None:
        malformed_values = (
            None,
            [],
            {"default": True, "attached_pic": 0},
            {"default": 1, "attached_pic": 2},
            {"default": 1},
        )
        for malformed in malformed_values:
            with self.subTest(malformed=malformed):
                metadata = probe_fixture()
                metadata["streams"][0]["disposition"] = malformed
                report = MediaPreflight(
                    FixtureProbe(metadata=metadata)
                ).inspect_sources([self.source])
                self.assertFalse(report["technical_preflight_complete"])
                self.assertIn(
                    "disposition",
                    report["items"][0]["errors"][0]["message"],
                )

    def test_subprocess_backend_reports_bounded_probe_timeouts_cleanly(self) -> None:
        backend = SubprocessProbeBackend(
            metadata_timeout_seconds=0.05,
            packet_timeout_seconds=0.05,
        )
        sleeper = [sys.executable, "-c", "import time; time.sleep(5)"]
        with self.assertRaisesRegex(ProbeError, "metadata inspection timed out"):
            media_preflight._run_bounded_capture(
                sleeper,
                timeout_seconds=0.05,
                stdout_limit=1024,
                stderr_limit=1024,
                stage="metadata inspection",
            )

        with self.assertRaisesRegex(ProbeError, "packet scan timed out"):
            list(backend._stream_stdout_lines(sleeper))

        noisy = [
            sys.executable,
            "-c",
            "import sys; sys.stdout.buffer.write(b'x' * 4096)",
        ]
        with self.assertRaisesRegex(ProbeError, "stdout exceeded"):
            media_preflight._run_bounded_capture(
                noisy,
                timeout_seconds=1,
                stdout_limit=32,
                stderr_limit=32,
                stage="metadata inspection",
            )

    def test_deadline_survives_pipe_eof_and_kills_descendant_group(self) -> None:
        marker = Path(self.temporary_directory.name) / "descendant-survived"
        descendant = (
            "import pathlib,time; time.sleep(0.4); "
            f"pathlib.Path({str(marker)!r}).write_text('survived')"
        )
        parent = (
            "import os,subprocess,sys,time; "
            f"subprocess.Popen([sys.executable,'-c',{descendant!r}],"
            "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
            "os.close(1); os.close(2); time.sleep(5)"
        )
        started = time.monotonic()
        with self.assertRaisesRegex(ProbeError, "timed out"):
            media_preflight._run_bounded_capture(
                [sys.executable, "-c", parent],
                timeout_seconds=0.05,
                stdout_limit=1024,
                stderr_limit=1024,
                stage="closed-pipe reproducer",
            )
        self.assertLess(time.monotonic() - started, 1.5)
        time.sleep(0.5)
        self.assertFalse(marker.exists())

    def test_source_count_is_bounded_before_files_or_probe_are_touched(self) -> None:
        too_many = [Path(f"fixture-{index}.mov") for index in range(257)]
        backend = FixtureProbe()
        with self.assertRaisesRegex(ValueError, "at most 256 sources"):
            MediaPreflight(backend).inspect_sources(too_many)
        self.assertEqual(backend.metadata_calls, 0)

    def test_darwin_fallback_detects_dataless_flag_without_python_constant(self) -> None:
        fake_stat = SimpleNamespace(st_flags=0x40000060)
        self.assertTrue(media_preflight._stat_is_dataless(fake_stat, platform="darwin"))
        self.assertFalse(media_preflight._stat_is_dataless(fake_stat, platform="linux"))

    def test_offline_placeholder_fails_before_hashing_or_ffprobe(self) -> None:
        backend = FixtureProbe()
        with patch.object(
            media_preflight,
            "_stage_source_snapshot",
            side_effect=OfflinePlaceholderError("offline placeholder"),
        ):
            report = MediaPreflight(backend).inspect_sources([self.source])
        item = report["items"][0]
        self.assertFalse(report["technical_preflight_complete"])
        self.assertIsNone(item["file"])
        self.assertEqual(item["errors"][0]["code"], "SOURCE_OFFLINE_PLACEHOLDER")
        self.assertEqual(backend.metadata_calls, 0)

    def test_hashing_has_a_logical_size_ceiling_and_timeout_policy(self) -> None:
        backend = FixtureProbe()
        report = MediaPreflight(backend, max_source_bytes=3).inspect_sources(
            [self.source]
        )
        item = report["items"][0]
        self.assertFalse(report["technical_preflight_complete"])
        self.assertEqual(item["errors"][0]["code"], "SOURCE_TOO_LARGE")
        self.assertEqual(backend.metadata_calls, 0)

        for invalid_size in (True, 0, -1):
            with self.subTest(invalid_size=invalid_size):
                with self.assertRaises(ValueError):
                    MediaPreflight(FixtureProbe(), max_source_bytes=invalid_size)
        with self.assertRaises(ValueError):
            MediaPreflight(FixtureProbe(), max_source_bytes=1024**4 + 1)
        for invalid_timeout in (True, 0, -1, math.nan, math.inf):
            with self.subTest(invalid_timeout=invalid_timeout):
                with self.assertRaises(ValueError):
                    MediaPreflight(
                        FixtureProbe(), hash_timeout_seconds=invalid_timeout
                    )
        with self.assertRaises(ValueError):
            MediaPreflight(FixtureProbe(), hash_timeout_seconds=3600.1)

        timeout_report = MediaPreflight(
            FixtureProbe(), hash_timeout_seconds=1e-9
        ).inspect_sources([self.source])
        self.assertEqual(
            timeout_report["items"][0]["errors"][0]["code"],
            "SOURCE_SNAPSHOT_FAILED",
        )
        self.assertIn(
            "timed out", timeout_report["items"][0]["errors"][0]["message"]
        )

    def test_fixed_length_snapshot_detects_truncation_growth_and_change(self) -> None:
        original_read = media_preflight.os.read

        truncated_destination = Path(self.temporary_directory.name) / "truncated.partial"
        with patch.object(media_preflight.os, "read", return_value=b""):
            with self.assertRaisesRegex(
                media_preflight.SourceSnapshotError, "EOF before"
            ):
                media_preflight._copy_source_to_snapshot(
                    self.source,
                    truncated_destination,
                    1024,
                )

        growth_destination = Path(self.temporary_directory.name) / "growth.partial"
        growth_calls = 0

        def grow_on_extra_read(file_descriptor, byte_count):
            nonlocal growth_calls
            growth_calls += 1
            if growth_calls == 2:
                with self.source.open("ab") as handle:
                    handle.write(b"x")
            return original_read(file_descriptor, byte_count)

        with patch.object(media_preflight.os, "read", side_effect=grow_on_extra_read):
            with self.assertRaisesRegex(
                media_preflight.SourceSnapshotError, "grew beyond"
            ):
                media_preflight._copy_source_to_snapshot(
                    self.source,
                    growth_destination,
                    1024,
                )

        self.source.write_bytes(b"deterministic media fixture bytes")
        changed_destination = Path(self.temporary_directory.name) / "changed.partial"
        change_calls = 0

        def change_metadata_on_extra_read(file_descriptor, byte_count):
            nonlocal change_calls
            change_calls += 1
            if change_calls == 2:
                source_stat = self.source.stat()
                os.utime(
                    self.source,
                    ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000),
                )
            return original_read(file_descriptor, byte_count)

        with patch.object(
            media_preflight.os,
            "read",
            side_effect=change_metadata_on_extra_read,
        ):
            with self.assertRaisesRegex(
                media_preflight.SourceSnapshotError, "changed while"
            ):
                media_preflight._copy_source_to_snapshot(
                    self.source,
                    changed_destination,
                    1024,
                )

    def test_source_symlinks_are_rejected_before_probe(self) -> None:
        symlink = Path(self.temporary_directory.name) / "source-link.mov"
        symlink.symlink_to(self.source)
        backend = FixtureProbe()
        report = MediaPreflight(backend).inspect_sources([symlink])
        self.assertFalse(report["technical_preflight_complete"])
        self.assertEqual(report["items"][0]["errors"][0]["code"], "SOURCE_SNAPSHOT_FAILED")
        self.assertEqual(backend.metadata_calls, 0)

    def test_probe_is_bound_to_private_snapshot_when_original_path_is_replaced(self) -> None:
        original_bytes = self.source.read_bytes()

        def replace_original(_snapshot_path):
            replacement = Path(self.temporary_directory.name) / "replacement.mov"
            replacement.write_bytes(b"different bytes at original pathname")
            os.replace(replacement, self.source)

        backend = FixtureProbe(metadata_hook=replace_original)
        report = MediaPreflight(backend).inspect_sources([self.source])
        item = report["items"][0]
        self.assertTrue(report["technical_preflight_complete"])
        self.assertEqual(
            item["file"]["sha256"], hashlib.sha256(original_bytes).hexdigest()
        )
        self.assertEqual(
            item["file"]["probe_binding"],
            "PRIVATE_CONTENT_ADDRESSED_LOCAL_SNAPSHOT",
        )
        self.assertEqual(backend.metadata_source_bytes, [original_bytes])
        self.assertEqual(backend.packet_source_bytes, [original_bytes])
        self.assertEqual(
            backend.metadata_source_paths,
            backend.packet_source_paths,
        )
        self.assertNotEqual(backend.metadata_source_paths[0], self.source)
        self.assertFalse(backend.metadata_source_paths[0].exists())

    def test_cli_records_explicit_single_source_context_without_verifying_it(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(
                [
                    str(self.source),
                    "--rights-claim",
                    "CLAIMED_OWNED",
                    "--rights-ref",
                    "contract:fixture",
                    "--provenance-ref",
                    "camera-export:fixture",
                ],
                probe_backend=FixtureProbe(),
            )
        self.assertEqual(exit_code, 0)
        item = json.loads(output.getvalue())["items"][0]
        self.assertEqual(item["rights_claim"]["claim"], "CLAIMED_OWNED")
        self.assertEqual(item["rights_claim"]["verification"], "UNVERIFIED")
        self.assertEqual(
            item["rights_claim"]["basis"], "USER_SUPPLIED_CLI_UNVERIFIED"
        )
        self.assertEqual(
            item["provenance_claim"]["basis"], "USER_SUPPLIED_CLI_UNVERIFIED"
        )
        self.assertEqual(item["provenance_claim"]["verification"], "UNVERIFIED")

    def test_rights_context_requires_evidence_and_cannot_span_sources(self) -> None:
        with self.assertRaises(ValueError):
            ExplicitSourceContext(rights_claim=UnverifiedRightsClaim.CLAIMED_OWNED)
        with self.assertRaises(ValueError):
            ExplicitSourceContext(rights_ref="contract:fixture")

        second_source = Path(self.temporary_directory.name) / "second.mov"
        second_source.write_bytes(b"second")
        context = ExplicitSourceContext(
            rights_claim=UnverifiedRightsClaim.CLAIMED_OWNED,
            rights_ref="contract:fixture",
        )
        with self.assertRaises(ValueError):
            MediaPreflight(FixtureProbe()).inspect_sources(
                [self.source, second_source], explicit_context=context
            )

    def test_missing_source_is_quarantined_without_invoking_ffprobe(self) -> None:
        missing = Path(self.temporary_directory.name) / "missing.mov"
        backend = FixtureProbe()
        report = MediaPreflight(backend).inspect_sources([missing])
        self.assertFalse(report["technical_preflight_complete"])
        self.assertEqual(backend.metadata_calls, 0)
        self.assertEqual(
            report["items"][0]["errors"][0]["code"], "SOURCE_SNAPSHOT_FAILED"
        )


if __name__ == "__main__":
    unittest.main()
