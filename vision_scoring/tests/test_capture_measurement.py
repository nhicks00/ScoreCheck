from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, replace
import hashlib
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import vision_scoring.capture_measurement as measurement
from vision_scoring.capture_measurement import (
    CaptureMeasurementError,
    replay_protected_capture_measurement_v1,
)
from vision_scoring.capture_measurement_parsers import (
    MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES,
    MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
    MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES,
)
from vision_scoring.capture_measurement_rows import DecodedMeasurementRecipeV1
from vision_scoring.decoder_runtime import DecoderRuntimeManifestV1
from vision_scoring.immutable_store import generation_id_for
from vision_scoring.protected_process import (
    PROTECTED_PROCESS_CLEANUP,
    PROTECTED_PROCESS_START,
    PROTECTED_PROCESS_TIMEOUT,
    ProtectedProcessError,
    ProtectedProcessResult,
)
from vision_scoring.staged_media import StagedMediaError

from tests.test_capture_measurement_parsers import (
    _framehash,
    _json_bytes,
    _metadata_document,
    _packet_document,
)
from tests.test_capture_measurement_rows import _recipe


FIXTURES = Path(__file__).parent / "fixtures"


def _digest(value: int) -> str:
    return f"{value:064x}"


def _manifest() -> DecoderRuntimeManifestV1:
    value = DecoderRuntimeManifestV1.from_json_bytes(
        (FIXTURES / "decoder_runtime_v1.development-manifest.json").read_bytes().strip()
    )
    return replace(
        value,
        ffprobe_version_output_sha256=(
            measurement.normalized_decoder_version_output_sha256(
                b"ffprobe version protected-test\n"
            )
        ),
        ffmpeg_version_output_sha256=(
            measurement.normalized_decoder_version_output_sha256(
                b"ffmpeg version protected-test\n"
            )
        ),
    )


class _FakeRuntime:
    admissible_for_training = False
    admissible_for_evaluation = False
    admissible_for_test = False
    admissible_for_deployment = False
    admissible_for_live_scoring = False

    def __init__(self, manifest: DecoderRuntimeManifestV1) -> None:
        self._manifest = manifest
        self.runtime_id = manifest.runtime_id
        self.generation_id = _digest(90)
        self.manifest_sha256 = manifest.fingerprint()
        self.decoder_recipe_sha256 = manifest.decoder_recipe_sha256
        self.executable_calls: list[str] = []

    def _runtime_manifest(self) -> DecoderRuntimeManifestV1:
        return self._manifest

    def _executable_path(self, tool: str) -> Path:
        self.executable_calls.append(tool)
        return Path(f"/protected-runtime/{tool}")


class _FakeMedia:
    admissible_for_training = False
    admissible_for_evaluation = False
    admissible_for_test = False
    admissible_for_deployment = False
    admissible_for_live_scoring = False

    def __init__(
        self,
        *,
        artifact_generation_id: str,
        artifact_sha256s: tuple[str, ...],
        source_sha256: str,
        source_byte_length: int,
    ) -> None:
        self.artifact_generation_id = artifact_generation_id
        self.artifact_sha256s = artifact_sha256s
        self.source_sha256 = source_sha256
        self.source_byte_length = source_byte_length
        self.reader_count = 0
        self.active_readers = 0

    @contextmanager
    def _open_immediate_child_reader(self):
        if self.active_readers:
            raise RuntimeError("readers overlapped")
        descriptor = os.open(os.devnull, os.O_RDONLY)
        self.active_readers += 1
        self.reader_count += 1
        try:
            yield descriptor
        finally:
            self.active_readers -= 1
            os.close(descriptor)


class CaptureMeasurementExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store_root = Path(temporary.name)
        self.artifact_store_root = self.store_root / "artifacts"
        self.runtime_store_root = self.store_root / "runtime"
        self.artifact_store_root.mkdir()
        self.runtime_store_root.mkdir()
        self.manifest = _manifest()
        self.runtime = _FakeRuntime(self.manifest)
        self.source_sha256 = _digest(1)
        self.artifact_sha256s = (self.source_sha256,)
        self.artifact_generation_id = generation_id_for(self.artifact_sha256s)
        self.source_byte_length = 10_000
        self.media = _FakeMedia(
            artifact_generation_id=self.artifact_generation_id,
            artifact_sha256s=self.artifact_sha256s,
            source_sha256=self.source_sha256,
            source_byte_length=self.source_byte_length,
        )
        self.metadata_raw = _json_bytes(_metadata_document())
        self.packet_raw = _json_bytes(_packet_document())
        self.framehash_raw = _framehash()
        self.context_events: list[str] = []
        self.process_calls: list[dict[str, object]] = []

    def _coordinates(self) -> dict[str, object]:
        return {
            "source_id": "denver-open-court-1-segment-0001",
            "artifact_store_root": self.artifact_store_root,
            "artifact_generation_id": self.artifact_generation_id,
            "artifact_sha256s": self.artifact_sha256s,
            "source_asset_sha256": self.source_sha256,
            "source_asset_byte_length": self.source_byte_length,
            "selected_video_stream_index": 2,
            "runtime_store_root": self.runtime_store_root,
            "runtime_generation_id": self.runtime.generation_id,
            "runtime_manifest_sha256": self.runtime.manifest_sha256,
            "expected_runtime_manifest_sha256": self.runtime.manifest_sha256,
            "expected_platform": self.manifest.platform,
            "expected_architecture": self.manifest.architecture,
            "expected_abi": self.manifest.abi,
            "expected_system_runtime_id": (
                self.manifest.system_runtime_measurement.runtime_id
            ),
            "expected_system_runtime_measurement_sha256": (
                self.manifest.system_runtime_measurement.measurement_sha256
            ),
            "recipe": _recipe(),
        }

    @contextmanager
    def _runtime_loader(self, **kwargs: object):
        del kwargs
        self.context_events.append("runtime-enter")
        try:
            yield self.runtime
        finally:
            self.context_events.append("runtime-exit")

    @contextmanager
    def _media_loader(self, *args: object):
        del args
        self.context_events.append("media-enter")
        try:
            yield self.media
        finally:
            self.context_events.append("media-exit")

    def _runner(
        self, argv: tuple[str, ...], **kwargs: object
    ) -> ProtectedProcessResult:
        call = {"argv": argv, **kwargs}
        self.process_calls.append(call)
        ordinal = len(self.process_calls)
        if ordinal == 1:
            return ProtectedProcessResult(
                0, b"ffprobe version protected-test\n", b"", b""
            )
        if ordinal == 2:
            return ProtectedProcessResult(
                0, b"ffmpeg version protected-test\n", b"", b""
            )
        if ordinal == 3:
            return ProtectedProcessResult(0, self.metadata_raw, b"", b"")
        if ordinal == 4:
            return ProtectedProcessResult(0, self.packet_raw, b"", b"")
        if ordinal == 5:
            read_fd = kwargs["auxiliary_read_fd"]
            write_fd = kwargs["auxiliary_write_fd"]
            assert type(read_fd) is int and type(write_fd) is int
            os.close(write_fd)
            os.close(read_fd)
            return ProtectedProcessResult(0, b"", b"", self.framehash_raw)
        raise AssertionError("unexpected protected process call")

    def _replay(self, *, runner: object | None = None, **changes: object):
        coordinates = {**self._coordinates(), **changes}
        with (
            patch.object(
                measurement,
                "_VerifiedDecoderRuntimeLease",
                _FakeRuntime,
            ),
            patch.object(
                measurement,
                "_StagedVerifiedArtifactMediaV1",
                _FakeMedia,
            ),
            patch.object(
                measurement,
                "load_verified_decoder_runtime",
                self._runtime_loader,
            ),
            patch.object(
                measurement,
                "stage_verified_artifact_media_v1",
                self._media_loader,
            ),
            patch.object(
                measurement,
                "run_protected_process",
                self._runner if runner is None else runner,
            ),
        ):
            return replay_protected_capture_measurement_v1(**coordinates)

    def assert_measurement_error(
        self,
        expected_code: str,
        operation: object,
    ) -> CaptureMeasurementError:
        self.assertTrue(callable(operation))
        with self.assertRaises(CaptureMeasurementError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        return caught.exception

    def test_exact_replay_binds_commands_channels_receipt_and_no_authority(
        self,
    ) -> None:
        before = time.monotonic()
        replay = self._replay()
        self.assertEqual(
            self.context_events,
            ["runtime-enter", "media-enter", "media-exit", "runtime-exit"],
        )
        self.assertEqual(self.media.reader_count, 3)
        self.assertEqual(self.media.active_readers, 0)
        self.assertEqual(
            self.runtime.executable_calls,
            ["ffprobe", "ffmpeg", "ffprobe", "ffprobe", "ffmpeg"],
        )
        self.assertEqual(len(self.process_calls), 5)
        for call in self.process_calls:
            self.assertGreater(call["deadline"], before)  # type: ignore[operator]
            self.assertEqual(
                call["stderr_limit"],
                measurement.MAX_CAPTURE_MEASUREMENT_PROCESS_STDERR_BYTES,
            )
        self.assertEqual(
            self.process_calls[2]["stdout_limit"],
            MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
        )
        self.assertEqual(
            self.process_calls[3]["stdout_limit"],
            MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES,
        )
        frame_call = self.process_calls[4]
        self.assertEqual(frame_call["stdout_limit"], 1)
        self.assertEqual(
            frame_call["auxiliary_limit"],
            MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES,
        )
        pass_fds = frame_call["pass_fds"]
        self.assertIs(type(pass_fds), tuple)
        self.assertEqual(len(pass_fds), 2)  # type: ignore[arg-type]
        self.assertNotIn(frame_call["auxiliary_read_fd"], pass_fds)

        receipt = replay.receipt
        self.assertEqual(receipt.source_asset_sha256, self.source_sha256)
        self.assertEqual(receipt.artifact_generation_id, self.artifact_generation_id)
        self.assertEqual(
            receipt.decoder_runtime_manifest_sha256,
            self.runtime.manifest_sha256,
        )
        self.assertEqual(receipt.selected_video_stream_index, 2)
        self.assertEqual(receipt.decoded_frame_count, 5)
        self.assertEqual(receipt.sample_aspect_ratio_numerator, 1)
        self.assertEqual(receipt.sample_aspect_ratio_denominator, 1)
        self.assertFalse(replay.admissible_for_training)
        self.assertFalse(replay.admissible_for_live_scoring)
        self.assertIn("remains unverified", replay.non_authority_statement)
        self.assertEqual(
            replay.metadata_output_sha256,
            hashlib.sha256(self.metadata_raw).hexdigest(),
        )
        self.assertEqual(
            asdict(replay)["metadata_output_sha256"],
            replay.metadata_output_sha256,
        )
        self.assertIn("fabricable structural evidence", replay.non_authority_statement)

    def test_invalid_inputs_fail_before_runtime_or_rows(self) -> None:
        cases = (
            {"artifact_store_root": Path("relative")},
            {"runtime_store_root": self.artifact_store_root},
            {"source_asset_byte_length": 0},
            {"selected_video_stream_index": True},
            {"runtime_manifest_sha256": _digest(71)},
            {"artifact_generation_id": _digest(72)},
        )
        for changes in cases:
            with self.subTest(changes=changes):
                self.assert_measurement_error(
                    "CAPTURE_MEASUREMENT_INPUT",
                    lambda changes=changes: self._replay(**changes),
                )
        self.assertEqual(self.context_events, [])
        self.assertEqual(self.process_calls, [])

        recipe = _recipe()
        object.__setattr__(recipe, "freeze_candidate_minimum_frames", 1)
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_RECIPE",
            lambda: self._replay(recipe=recipe),
        )

    def test_audio_or_nonexistent_rc_zero_is_parser_rejection(self) -> None:
        self.metadata_raw = _json_bytes(
            {
                "frames": [],
                "programs": [],
                "stream_groups": [],
                "streams": [],
            }
        )
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_METADATA",
            self._replay,
        )
        self.assertEqual(len(self.process_calls), 3)
        self.assertEqual(
            self.context_events[-2:],
            ["media-exit", "runtime-exit"],
        )

    def test_process_error_and_protocol_channels_fail_closed(self) -> None:
        def timed_out(argv: tuple[str, ...], **kwargs: object):
            del argv, kwargs
            raise ProtectedProcessError(PROTECTED_PROCESS_TIMEOUT, "synthetic")

        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_PROCESS_TIMEOUT",
            lambda: self._replay(runner=timed_out),
        )

        real_runner = self._runner

        def metadata_stderr(argv: tuple[str, ...], **kwargs: object):
            result = real_runner(argv, **kwargs)
            if len(self.process_calls) == 3:
                return ProtectedProcessResult(0, result.stdout, b"warning", b"")
            return result

        self.process_calls.clear()
        self.runtime.executable_calls.clear()
        self.context_events.clear()
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_METADATA",
            lambda: self._replay(runner=metadata_stderr),
        )

    def test_media_cleanup_overrides_a_deferred_body_error(self) -> None:
        self.metadata_raw = b"{}"

        @contextmanager
        def cleanup_fails(*args: object):
            del args
            self.context_events.append("media-enter")
            yield self.media
            self.context_events.append("media-cleanup-failed")
            raise StagedMediaError("MEDIA_CLEANUP", "synthetic cleanup failure")

        coordinates = self._coordinates()
        with (
            patch.object(measurement, "_VerifiedDecoderRuntimeLease", _FakeRuntime),
            patch.object(measurement, "_StagedVerifiedArtifactMediaV1", _FakeMedia),
            patch.object(
                measurement,
                "load_verified_decoder_runtime",
                self._runtime_loader,
            ),
            patch.object(
                measurement,
                "stage_verified_artifact_media_v1",
                cleanup_fails,
            ),
            patch.object(measurement, "run_protected_process", self._runner),
        ):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                lambda: replay_protected_capture_measurement_v1(**coordinates),
            )
        self.assertIn("media-cleanup-failed", self.context_events)
        self.assertEqual(self.context_events[-1], "runtime-exit")

    def test_framehash_pipe_setup_failure_stops_before_ffmpeg(self) -> None:
        with patch.object(measurement.os, "pipe", side_effect=OSError("synthetic")):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_FRAMEHASH",
                self._replay,
            )
        self.assertEqual(len(self.process_calls), 4)
        self.assertEqual(self.media.reader_count, 2)

    def test_clock_failure_still_transfers_and_closes_framehash_pipe(self) -> None:
        transferred: list[tuple[int, int]] = []

        def recording_runner(argv: tuple[str, ...], **kwargs: object):
            if len(self.process_calls) == 4:
                transferred.append(
                    (
                        kwargs["auxiliary_read_fd"],  # type: ignore[arg-type]
                        kwargs["auxiliary_write_fd"],  # type: ignore[arg-type]
                    )
                )
            return self._runner(argv, **kwargs)

        with patch.object(
            measurement.time,
            "monotonic",
            side_effect=[100.0, 100.0, 100.0, 100.0, RuntimeError("clock")],
        ):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                lambda: self._replay(runner=recording_runner),
            )
        self.assertEqual(len(self.process_calls), 5)
        self.assertEqual(len(transferred), 1)
        for descriptor in transferred[0]:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_clock_interrupt_propagates_only_after_transferred_cleanup(self) -> None:
        transferred: list[tuple[int, int]] = []

        def rejecting_runner(argv: tuple[str, ...], **kwargs: object):
            if len(self.process_calls) == 4:
                transferred.append(
                    (
                        kwargs["auxiliary_read_fd"],  # type: ignore[arg-type]
                        kwargs["auxiliary_write_fd"],  # type: ignore[arg-type]
                    )
                )
                os.close(transferred[-1][1])
                os.close(transferred[-1][0])
                self.process_calls.append({"argv": argv, **kwargs})
                raise ProtectedProcessError(PROTECTED_PROCESS_START, "sentinel")
            return self._runner(argv, **kwargs)

        with patch.object(
            measurement.time,
            "monotonic",
            side_effect=[100.0, 100.0, 100.0, 100.0, KeyboardInterrupt()],
        ):
            with self.assertRaises(KeyboardInterrupt):
                self._replay(runner=rejecting_runner)
        self.assertEqual(len(self.process_calls), 5)
        for descriptor in transferred[0]:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_clock_interrupt_yields_to_transferred_cleanup_failure(self) -> None:
        def cleanup_failing_runner(argv: tuple[str, ...], **kwargs: object):
            if len(self.process_calls) == 4:
                os.close(kwargs["auxiliary_write_fd"])  # type: ignore[arg-type]
                os.close(kwargs["auxiliary_read_fd"])  # type: ignore[arg-type]
                self.process_calls.append({"argv": argv, **kwargs})
                raise ProtectedProcessError(PROTECTED_PROCESS_CLEANUP, "synthetic")
            return self._runner(argv, **kwargs)

        with patch.object(
            measurement.time,
            "monotonic",
            side_effect=[100.0, 100.0, 100.0, 100.0, KeyboardInterrupt()],
        ):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                lambda: self._replay(runner=cleanup_failing_runner),
            )

    def test_local_pipe_cleanup_attempts_both_ends_and_overrides_setup(self) -> None:
        real_pipe = os.pipe
        real_close = os.close
        pipe_fds: list[int] = []
        close_attempts: list[int] = []
        inheritable_calls = 0

        def recording_pipe() -> tuple[int, int]:
            descriptors = real_pipe()
            pipe_fds.extend(descriptors)
            return descriptors

        def failing_inheritable(descriptor: int, inheritable: bool) -> None:
            nonlocal inheritable_calls
            del descriptor, inheritable
            inheritable_calls += 1
            if inheritable_calls == 2:
                raise OSError("synthetic inheritable failure")

        def ambiguous_close(descriptor: int) -> None:
            close_attempts.append(descriptor)
            if pipe_fds and descriptor == pipe_fds[1]:
                raise OSError("synthetic ambiguous close")
            real_close(descriptor)

        try:
            with (
                patch.object(measurement.os, "pipe", recording_pipe),
                patch.object(
                    measurement.os,
                    "set_inheritable",
                    failing_inheritable,
                ),
                patch.object(measurement.os, "close", ambiguous_close),
            ):
                self.assert_measurement_error(
                    "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                    self._replay,
                )
            self.assertEqual(set(close_attempts[-2:]), set(pipe_fds))
        finally:
            if pipe_fds:
                try:
                    real_close(pipe_fds[1])
                except OSError:
                    pass

    def test_mutated_runtime_coordinates_are_rejected_after_commands(self) -> None:
        original = self._runner

        def mutate_runtime(argv: tuple[str, ...], **kwargs: object):
            result = original(argv, **kwargs)
            if len(self.process_calls) == 3:
                self.runtime.generation_id = _digest(92)
                self.runtime.manifest_sha256 = _digest(93)
            return result

        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_RUNTIME",
            lambda: self._replay(runner=mutate_runtime),
        )

    def test_mutated_media_coordinates_are_rejected_after_commands(self) -> None:
        original = self._runner

        def mutate_media(argv: tuple[str, ...], **kwargs: object):
            result = original(argv, **kwargs)
            if len(self.process_calls) == 3:
                self.media.source_sha256 = _digest(94)
                self.media.source_byte_length += 1
            return result

        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_MEDIA",
            lambda: self._replay(runner=mutate_media),
        )

    def test_reader_cleanup_error_maps_to_process_cleanup(self) -> None:
        @contextmanager
        def cleanup_failing_reader():
            descriptor = os.open(os.devnull, os.O_RDONLY)
            try:
                yield descriptor
            finally:
                os.close(descriptor)
                raise StagedMediaError("MEDIA_CLEANUP", "synthetic")

        self.media._open_immediate_child_reader = cleanup_failing_reader  # type: ignore[method-assign]
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
            self._replay,
        )

    def test_untyped_media_cleanup_overrides_body_error(self) -> None:
        self.metadata_raw = b"{}"

        @contextmanager
        def cleanup_fails(*args: object):
            del args
            self.context_events.append("media-enter")
            yield self.media
            self.context_events.append("media-raw-cleanup-failed")
            raise RuntimeError("synthetic cleanup failure")

        coordinates = self._coordinates()
        with (
            patch.object(measurement, "_VerifiedDecoderRuntimeLease", _FakeRuntime),
            patch.object(measurement, "_StagedVerifiedArtifactMediaV1", _FakeMedia),
            patch.object(
                measurement,
                "load_verified_decoder_runtime",
                self._runtime_loader,
            ),
            patch.object(
                measurement,
                "stage_verified_artifact_media_v1",
                cleanup_fails,
            ),
            patch.object(measurement, "run_protected_process", self._runner),
        ):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                lambda: replay_protected_capture_measurement_v1(**coordinates),
            )
        self.assertIn("media-raw-cleanup-failed", self.context_events)

    def test_untyped_runtime_cleanup_has_finite_cleanup_surface(self) -> None:
        @contextmanager
        def runtime_cleanup_fails(**kwargs: object):
            del kwargs
            self.context_events.append("runtime-enter")
            yield self.runtime
            self.context_events.append("runtime-raw-cleanup-failed")
            raise RuntimeError("synthetic cleanup failure")

        coordinates = self._coordinates()
        with (
            patch.object(measurement, "_VerifiedDecoderRuntimeLease", _FakeRuntime),
            patch.object(measurement, "_StagedVerifiedArtifactMediaV1", _FakeMedia),
            patch.object(
                measurement,
                "load_verified_decoder_runtime",
                runtime_cleanup_fails,
            ),
            patch.object(
                measurement,
                "stage_verified_artifact_media_v1",
                self._media_loader,
            ),
            patch.object(measurement, "run_protected_process", self._runner),
        ):
            self.assert_measurement_error(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                lambda: replay_protected_capture_measurement_v1(**coordinates),
            )
        self.assertIn("runtime-raw-cleanup-failed", self.context_events)

    def test_store_namespace_and_full_digest_roles_are_disjoint(self) -> None:
        alias = self.store_root / "runtime-alias"
        alias.symlink_to(self.artifact_store_root, target_is_directory=True)
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_INPUT",
            lambda: self._replay(runtime_store_root=alias),
        )
        self.assertEqual(self.context_events, [])

        aliased = self.manifest.ffmpeg_version_output_sha256
        artifact_sha256s = (aliased,)
        artifact_generation_id = generation_id_for(artifact_sha256s)
        self.media = _FakeMedia(
            artifact_generation_id=artifact_generation_id,
            artifact_sha256s=artifact_sha256s,
            source_sha256=aliased,
            source_byte_length=self.source_byte_length,
        )
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_RUNTIME",
            lambda: self._replay(
                artifact_generation_id=artifact_generation_id,
                artifact_sha256s=artifact_sha256s,
                source_asset_sha256=aliased,
            ),
        )

    def test_finite_error_surface_and_recipe_type(self) -> None:
        self.assertIn(
            "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
            measurement.CAPTURE_MEASUREMENT_ERROR_CODES,
        )
        with self.assertRaises(ValueError):
            CaptureMeasurementError("UNKNOWN", "invalid")
        self.assert_measurement_error(
            "CAPTURE_MEASUREMENT_RECIPE",
            lambda: self._replay(recipe=object()),
        )
        self.assertIsInstance(self._coordinates()["recipe"], DecodedMeasurementRecipeV1)


if __name__ == "__main__":
    unittest.main()
