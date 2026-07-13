from __future__ import annotations

from copy import copy, deepcopy
from dataclasses import replace
import pickle
from pathlib import Path
import unittest
from unittest.mock import patch

from tests.test_capture_measurement_rows import _recipe
from tests.test_capture_segment import _prepared, _verify_arguments
import vision_scoring.capture_measurement_binding as binding_module
from vision_scoring.capture_measurement import (
    UnverifiedCaptureMeasurementReplayV1,
    _ProtectedCaptureMeasurementRowsV1,
)
from vision_scoring.capture_measurement_binding import (
    CaptureMeasurementBindingError,
    SelectedVideoStreamBindingV1,
    SelectedVideoStreamMappingStatusV1,
    _replay_and_bind_capture_measurement_v1,
    logical_stream_epoch_sha256_v1,
    ordered_selected_fragments_sha256_v1,
)
from vision_scoring.capture_measurement_rows import (
    DecodedFrameContentRowV1,
    DecodedFrameInterlaceFactV1,
    PresentationTimingRowV1,
    SelectedVideoPacketPayloadRowV1,
    build_decoded_capture_measurement_receipt_v1,
)
from vision_scoring.capture_profile_contracts import VideoCodecV1
from vision_scoring.capture_segment import (
    FinalizedCaptureSegmentStatement,
    verify_capture_segment_attestation,
)
from vision_scoring.immutable_store import generation_id_for


def _digest(value: int) -> str:
    return f"{value:064x}"


def _protected_rows(
    statement: FinalizedCaptureSegmentStatement,
    *,
    selected_stream: int = 2,
) -> _ProtectedCaptureMeasurementRowsV1:
    metadata = statement.capture_metadata
    recipe = _recipe()
    pts = tuple(range(metadata.source_start_pts, metadata.source_end_pts + 1))
    assert len(pts) == metadata.frame_count
    timing = tuple(
        PresentationTimingRowV1(
            decoded_frame_ordinal=ordinal,
            selected_video_stream_index=selected_stream,
            presentation_pts=value,
            source_time_base_numerator=metadata.source_time_base_numerator,
            source_time_base_denominator=metadata.source_time_base_denominator,
        )
        for ordinal, value in enumerate(pts)
    )
    packets = tuple(
        SelectedVideoPacketPayloadRowV1(
            packet_ordinal=ordinal,
            selected_video_stream_index=selected_stream,
            payload_byte_length=1,
            packet_pts=value,
            packet_dts=value,
        )
        for ordinal, value in enumerate(pts)
    )
    frames = tuple(
        DecodedFrameContentRowV1(
            decoded_frame_ordinal=ordinal,
            selected_video_stream_index=selected_stream,
            presentation_pts=value,
            decoded_pixel_sha256=_digest(100 + ordinal),
            decoded_width_px=2,
            decoded_height_px=2,
            sample_aspect_ratio_numerator=1,
            sample_aspect_ratio_denominator=1,
            display_rotation_degrees=0,
            interlace_fact=DecodedFrameInterlaceFactV1.PROGRESSIVE,
            source_time_base_numerator=metadata.source_time_base_numerator,
            source_time_base_denominator=metadata.source_time_base_denominator,
        )
        for ordinal, value in enumerate(pts)
    )
    artifact_generation_id = generation_id_for((metadata.asset_sha256,))
    runtime_manifest_sha256 = _digest(20)
    receipt = build_decoded_capture_measurement_receipt_v1(
        source_id=metadata.asset_id,
        source_asset_sha256=metadata.asset_sha256,
        source_asset_byte_length=metadata.asset_byte_length,
        artifact_generation_id=artifact_generation_id,
        selected_video_stream_index=selected_stream,
        decoder_runtime_manifest_sha256=runtime_manifest_sha256,
        observed_codec=VideoCodecV1.AVC_H264,
        recipe=recipe,
        presentation_timing_rows=timing,
        selected_video_packet_rows=packets,
        decoded_frame_rows=frames,
    )
    replay = UnverifiedCaptureMeasurementReplayV1(
        receipt=receipt,
        decoder_runtime_generation_id=_digest(21),
        decoder_runtime_manifest_sha256=runtime_manifest_sha256,
        decoder_runtime_id="runtime-test",
        capture_measurement_command_recipe_sha256=(
            recipe.capture_measurement_command_recipe_sha256
        ),
        metadata_output_sha256=_digest(22),
        packet_output_sha256=_digest(23),
        framehash_output_sha256=_digest(24),
    )
    return _ProtectedCaptureMeasurementRowsV1(
        replay=replay,
        measurement_recipe=recipe,
        observed_codec=VideoCodecV1.AVC_H264,
        presentation_timing_rows=timing,
        selected_video_packet_rows=packets,
        decoded_frame_rows=frames,
    )


class ProtectedCaptureMeasurementBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prepared = _prepared()
        statement = self.prepared["statement"]
        attestation = self.prepared["attestation"]
        trust_snapshot = self.prepared["trust_snapshot"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        self.statement = statement
        self.evidence = verify_capture_segment_attestation(
            statement,
            attestation,  # type: ignore[arg-type]
            trust_snapshot,  # type: ignore[arg-type]
            **_verify_arguments(self.prepared),  # type: ignore[arg-type]
        )
        self.rows = _protected_rows(statement)
        metadata = statement.capture_metadata
        self.stream_binding = SelectedVideoStreamBindingV1(
            binding_id="stream-binding-1",
            capture_segment_statement_sha256=statement.fingerprint(),
            capture_metadata_sha256=metadata.fingerprint(),
            source_asset_sha256=metadata.asset_sha256,
            logical_stream_id=metadata.stream_id,
            selected_video_stream_index=2,
        )

    def _coordinates(self) -> dict[str, object]:
        metadata = self.statement.capture_metadata
        return {
            "capture_segment_statement": self.statement,
            "capture_segment_evidence": self.evidence,
            "selected_video_stream_binding": self.stream_binding,
            "expected_capture_segment_statement_sha256": (
                self.evidence.statement_sha256
            ),
            "expected_capture_segment_attestation_sha256": (
                self.evidence.attestation_sha256
            ),
            "expected_capture_segment_trust_snapshot_sha256": (
                self.evidence.trust_snapshot_sha256
            ),
            "expected_capture_segment_trust_snapshot_generation": (
                self.evidence.trust_snapshot_generation
            ),
            "expected_capture_metadata_sha256": metadata.fingerprint(),
            "expected_selected_video_stream_binding_sha256": (
                self.stream_binding.fingerprint()
            ),
            "expected_selected_video_stream_index": 2,
            "expected_measurement_recipe_sha256": _recipe().fingerprint(),
            "artifact_store_root": Path("/protected/artifacts"),
            "artifact_generation_id": self.rows.replay.receipt.artifact_generation_id,
            "artifact_sha256s": (metadata.asset_sha256,),
            "runtime_store_root": Path("/protected/runtime"),
            "runtime_generation_id": self.rows.replay.decoder_runtime_generation_id,
            "runtime_manifest_sha256": (
                self.rows.replay.decoder_runtime_manifest_sha256
            ),
            "expected_runtime_manifest_sha256": (
                self.rows.replay.decoder_runtime_manifest_sha256
            ),
            "expected_platform": "macos",
            "expected_architecture": "arm64",
            "expected_abi": "darwin",
            "expected_system_runtime_id": "system-runtime",
            "expected_system_runtime_measurement_sha256": _digest(25),
            "recipe": _recipe(),
        }

    def _bind(self, **changes: object):
        coordinates = {**self._coordinates(), **changes}
        with patch.object(
            binding_module,
            "_replay_protected_capture_measurement_rows_v1",
            return_value=self.rows,
        ):
            return _replay_and_bind_capture_measurement_v1(**coordinates)  # type: ignore[arg-type]

    def assert_binding_error(
        self,
        expected_code: str,
        operation: object,
    ) -> CaptureMeasurementBindingError:
        self.assertTrue(callable(operation))
        with self.assertRaises(CaptureMeasurementBindingError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        return caught.exception

    def test_current_capture_protected_rows_and_independent_pins_bind(self) -> None:
        result = self._bind()
        self.assertEqual(
            result.capture_segment_statement_sha256,
            self.statement.fingerprint(),
        )
        self.assertEqual(
            result.capture_metadata_sha256,
            self.statement.capture_metadata.fingerprint(),
        )
        self.assertEqual(
            result.measurement_receipt_sha256,
            self.rows.replay.receipt.fingerprint(),
        )
        self.assertEqual(result.decoded_frame_count, 3)
        self.assertEqual(result._exact_presentation_pts(), (0, 1, 2))  # type: ignore[attr-defined]
        self.assertEqual(
            result.logical_stream_epoch_sha256,
            logical_stream_epoch_sha256_v1(self.statement),
        )
        self.assertEqual(
            ordered_selected_fragments_sha256_v1(self.statement),
            ordered_selected_fragments_sha256_v1(
                FinalizedCaptureSegmentStatement.from_json_bytes(
                    self.statement.to_json_bytes()
                )
            ),
        )
        self.assertFalse(result.admissible_for_training)
        self.assertFalse(result.admissible_for_live_scoring)
        for operation in (lambda: copy(result), lambda: deepcopy(result)):
            with self.assertRaises(TypeError):
                operation()
        with self.assertRaises(TypeError):
            pickle.dumps(result)

    def test_transient_binding_copies_rows_as_bytes_and_revalidates_them(self) -> None:
        result = self._bind()
        object.__setattr__(
            self.rows.presentation_timing_rows[1],
            "presentation_pts",
            True,
        )
        self.assertEqual(result._exact_presentation_pts(), (0, 1, 2))  # type: ignore[attr-defined]

        changed = replace(
            PresentationTimingRowV1.from_json_bytes(
                result._presentation_timing_row_bytes[1]  # type: ignore[attr-defined]
            ),
            presentation_pts=7,
        )
        row_bytes = list(
            result._presentation_timing_row_bytes  # type: ignore[attr-defined]
        )
        row_bytes[1] = changed.to_json_bytes()
        object.__setattr__(
            result,
            "_presentation_timing_row_bytes",
            tuple(row_bytes),
        )
        with self.assertRaises(ValueError):
            result._canonical_receipt()  # type: ignore[attr-defined]

    def test_transient_binding_still_rejects_public_replay_or_capture_substitution(
        self,
    ) -> None:
        self.assert_binding_error(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            lambda: self._bind(capture_segment_evidence=object()),
        )

    def test_capture_stream_and_independent_pin_substitution_fail_closed(self) -> None:
        self.assert_binding_error(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            lambda: self._bind(expected_capture_metadata_sha256=_digest(80)),
        )
        changed_stream = replace(
            self.stream_binding,
            logical_stream_id="other-stream",
        )
        self.assert_binding_error(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            lambda: self._bind(selected_video_stream_binding=changed_stream),
        )
        self.assert_binding_error(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            lambda: self._bind(expected_selected_video_stream_index=1),
        )

    def test_asset_count_pts_timebase_runtime_and_recipe_mismatch_reject(self) -> None:
        metadata = self.statement.capture_metadata
        cases = (
            ("source_id", "wrong-source"),
            ("source_asset_byte_length", metadata.asset_byte_length + 1),
            ("decoded_frame_count", 4),
            ("source_time_base_denominator", 2),
        )
        for field_name, field_value in cases:
            with self.subTest(field=field_name):
                receipt = object.__new__(type(self.rows.replay.receipt))
                for field in self.rows.replay.receipt.__dataclass_fields__:
                    if field.startswith("_"):
                        continue
                    object.__setattr__(
                        receipt,
                        field,
                        (
                            field_value
                            if field == field_name
                            else getattr(self.rows.replay.receipt, field)
                        ),
                    )
                replay = object.__new__(UnverifiedCaptureMeasurementReplayV1)
                for field in self.rows.replay.__dataclass_fields__:
                    if field.startswith("_"):
                        continue
                    object.__setattr__(
                        replay,
                        field,
                        receipt
                        if field == "receipt"
                        else getattr(self.rows.replay, field),
                    )
                forged = object.__new__(_ProtectedCaptureMeasurementRowsV1)
                object.__setattr__(forged, "replay", replay)
                object.__setattr__(
                    forged,
                    "measurement_recipe",
                    self.rows.measurement_recipe,
                )
                object.__setattr__(forged, "observed_codec", self.rows.observed_codec)
                object.__setattr__(
                    forged,
                    "presentation_timing_rows",
                    self.rows.presentation_timing_rows,
                )
                object.__setattr__(
                    forged,
                    "selected_video_packet_rows",
                    self.rows.selected_video_packet_rows,
                )
                object.__setattr__(
                    forged,
                    "decoded_frame_rows",
                    self.rows.decoded_frame_rows,
                )
                with patch.object(
                    binding_module,
                    "_replay_protected_capture_measurement_rows_v1",
                    return_value=forged,
                ):
                    self.assert_binding_error(
                        "CAPTURE_MEASUREMENT_BINDING_ROWS",
                        lambda: _replay_and_bind_capture_measurement_v1(
                            **self._coordinates()  # type: ignore[arg-type]
                        ),
                    )

        self.assert_binding_error(
            "CAPTURE_MEASUREMENT_BINDING_REPLAY",
            lambda: self._bind(runtime_generation_id=_digest(81)),
        )

    def test_missing_duplicate_or_regressing_protected_pts_reject(self) -> None:
        row = self.rows.presentation_timing_rows[1]
        for value in (None, 0, -1):
            with self.subTest(value=value):
                forged = object.__new__(_ProtectedCaptureMeasurementRowsV1)
                for field in (
                    "replay",
                    "measurement_recipe",
                    "observed_codec",
                    "selected_video_packet_rows",
                    "decoded_frame_rows",
                ):
                    object.__setattr__(forged, field, getattr(self.rows, field))
                object.__setattr__(
                    forged,
                    "presentation_timing_rows",
                    (
                        self.rows.presentation_timing_rows[0],
                        replace(row, presentation_pts=value),
                        self.rows.presentation_timing_rows[2],
                    ),
                )
                with patch.object(
                    binding_module,
                    "_replay_protected_capture_measurement_rows_v1",
                    return_value=forged,
                ):
                    self.assert_binding_error(
                        "CAPTURE_MEASUREMENT_BINDING_ROWS",
                        lambda: _replay_and_bind_capture_measurement_v1(
                            **self._coordinates()  # type: ignore[arg-type]
                        ),
                    )

    def test_stream_binding_wire_is_canonical_fabricable_and_non_authorizing(
        self,
    ) -> None:
        raw = self.stream_binding.to_json_bytes()
        self.assertEqual(
            SelectedVideoStreamBindingV1.from_json_bytes(raw), self.stream_binding
        )
        self.assertIs(
            self.stream_binding.mapping_status,
            SelectedVideoStreamMappingStatusV1.PINNED_CONTAINER_INDEX_MAPPING_CONTENT_EQUIVALENCE_NOT_PROVEN,
        )
        self.assertFalse(self.stream_binding.admissible_for_training)
        self.assertFalse(self.stream_binding.admissible_for_live_scoring)
        with self.assertRaises(ValueError):
            SelectedVideoStreamBindingV1.from_json_bytes(raw + b" ")


if __name__ == "__main__":
    unittest.main()
