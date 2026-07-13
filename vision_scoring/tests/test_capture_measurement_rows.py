from __future__ import annotations

from dataclasses import replace
import json
import unittest

from vision_scoring.capture_contracts import (
    MAX_FINALIZED_FRAMES,
    MAX_FINALIZED_SOURCE_BYTES,
)
from vision_scoring.capture_measurement_commands import (
    CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
)
from vision_scoring.capture_measurement_contracts import (
    MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS,
    DecodedCadenceStatusV1,
    DecodedInterlaceObservationV1,
    DecodedMeasurementAnalysisStatusV1,
)
from vision_scoring.capture_measurement_rows import (
    DecodedFrameContentDigestBasisV1,
    DecodedFrameContentRowV1,
    DecodedFrameInterlaceFactV1,
    DecodedMeasurementRecipeV1,
    PairedPresentationFrameAggregationV1,
    PresentationTimingAggregationV1,
    PresentationTimingRowV1,
    SelectedVideoPacketAggregationV1,
    SelectedVideoPacketPayloadRowV1,
    aggregate_decoded_frame_rows_v1,
    aggregate_paired_presentation_and_frame_rows_v1,
    aggregate_presentation_timing_rows_v1,
    aggregate_selected_video_packet_rows_v1,
    build_decoded_capture_measurement_receipt_v1,
)
from vision_scoring.capture_profile_contracts import VideoCodecV1
from vision_scoring.contract_wire import canonical_json_bytes


def _digest(value: int) -> str:
    return f"{value:064x}"


def _recipe(
    *, identical_minimum: int = 2, freeze_minimum: int = 4
) -> DecodedMeasurementRecipeV1:
    return DecodedMeasurementRecipeV1(
        content_digest_basis=(
            DecodedFrameContentDigestBasisV1.BITEXACT_NOAUTOROTATE_BT709_LIMITED_RGB24_FRAME_BYTES_SHA256
        ),
        capture_measurement_command_recipe_sha256=(
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1
        ),
        identical_frame_run_minimum_frames=identical_minimum,
        freeze_candidate_minimum_frames=freeze_minimum,
    )


def _timing_rows(
    pts: tuple[int | None, ...],
    *,
    stream: int = 0,
    time_base: tuple[int, int] = (1, 90_000),
) -> tuple[PresentationTimingRowV1, ...]:
    return tuple(
        PresentationTimingRowV1(
            decoded_frame_ordinal=ordinal,
            selected_video_stream_index=stream,
            presentation_pts=value,
            source_time_base_numerator=time_base[0],
            source_time_base_denominator=time_base[1],
        )
        for ordinal, value in enumerate(pts)
    )


def _frame_rows(
    digests: tuple[str, ...],
    *,
    presentation_pts: tuple[int | None, ...] | None = None,
    stream: int = 0,
    time_base: tuple[int, int] = (1, 90_000),
    width: int = 1920,
    height: int = 1080,
    sample_aspect_ratio: tuple[int, int] = (1, 1),
    interlace: DecodedFrameInterlaceFactV1 = DecodedFrameInterlaceFactV1.PROGRESSIVE,
) -> tuple[DecodedFrameContentRowV1, ...]:
    if presentation_pts is None:
        presentation_pts = tuple(ordinal * 3_000 for ordinal in range(len(digests)))
    if len(presentation_pts) != len(digests):
        raise ValueError("test frame PTS and digest counts differ")
    return tuple(
        DecodedFrameContentRowV1(
            decoded_frame_ordinal=ordinal,
            selected_video_stream_index=stream,
            presentation_pts=presentation_pts[ordinal],
            decoded_pixel_sha256=value,
            decoded_width_px=width,
            decoded_height_px=height,
            sample_aspect_ratio_numerator=sample_aspect_ratio[0],
            sample_aspect_ratio_denominator=sample_aspect_ratio[1],
            display_rotation_degrees=0,
            interlace_fact=interlace,
            source_time_base_numerator=time_base[0],
            source_time_base_denominator=time_base[1],
        )
        for ordinal, value in enumerate(digests)
    )


def _packet_rows(
    payloads: tuple[int, ...] = (1_000, 2_000, 3_000),
    *,
    stream: int = 0,
    packet_pts: tuple[int | None, ...] | None = None,
    packet_dts: tuple[int | None, ...] | None = None,
) -> tuple[SelectedVideoPacketPayloadRowV1, ...]:
    if packet_pts is None:
        packet_pts = tuple(ordinal * 3_000 for ordinal in range(len(payloads)))
    if packet_dts is None:
        packet_dts = tuple((ordinal - 1) * 3_000 for ordinal in range(len(payloads)))
    if len(packet_pts) != len(payloads) or len(packet_dts) != len(payloads):
        raise ValueError("test packet diagnostic counts differ")
    return tuple(
        SelectedVideoPacketPayloadRowV1(
            packet_ordinal=ordinal,
            selected_video_stream_index=stream,
            payload_byte_length=payload,
            packet_pts=packet_pts[ordinal],
            packet_dts=packet_dts[ordinal],
        )
        for ordinal, payload in enumerate(payloads)
    )


def _receipt(
    *,
    pts: tuple[int | None, ...] = (0, 3_000, 6_000, 9_000),
    time_base: tuple[int, int] = (1, 90_000),
    pixel_digests: tuple[str, ...] | None = None,
    packets: tuple[SelectedVideoPacketPayloadRowV1, ...] | None = None,
    recipe: DecodedMeasurementRecipeV1 | None = None,
):
    if pixel_digests is None:
        pixel_digests = tuple(_digest(100 + index) for index in range(len(pts)))
    return build_decoded_capture_measurement_receipt_v1(
        source_id="denver-open-court-1",
        source_asset_sha256=_digest(1),
        source_asset_byte_length=1_000_000,
        artifact_generation_id=_digest(2),
        selected_video_stream_index=0,
        decoder_runtime_manifest_sha256=_digest(3),
        observed_codec=VideoCodecV1.AVC_H264,
        recipe=recipe or _recipe(),
        presentation_timing_rows=_timing_rows(pts, time_base=time_base),
        selected_video_packet_rows=packets or _packet_rows(),
        decoded_frame_rows=_frame_rows(
            pixel_digests,
            presentation_pts=pts,
            time_base=time_base,
        ),
    )


class _IteratorAcquisitionFailure:
    def __iter__(self):
        raise RuntimeError("hostile iterator acquisition")


def _iterator_midstream_failure(first):
    yield first
    raise RuntimeError("hostile iterator next")


class CanonicalMeasurementRowTests(unittest.TestCase):
    def test_round_trips_all_rows_and_recipe(self) -> None:
        values = (
            _timing_rows((0,))[0],
            _packet_rows((17,))[0],
            _frame_rows((_digest(7),))[0],
            _recipe(),
        )
        for value in values:
            with self.subTest(contract=type(value).__name__):
                self.assertEqual(
                    type(value).from_json_bytes(value.to_json_bytes()), value
                )
                self.assertEqual(len(value.fingerprint()), 64)

    def test_wire_rejects_extra_fields_noncanonical_bytes_and_authority(self) -> None:
        row = _timing_rows((0,))[0]
        extra = row.to_dict()
        extra["path"] = "/private/source.mp4"
        with self.assertRaisesRegex(ValueError, "unsupported path"):
            PresentationTimingRowV1.from_json_bytes(
                canonical_json_bytes(extra, label="bad row", maximum_bytes=4_096)
            )
        authority = row.to_dict()
        authority["admissible_for_training"] = True
        with self.assertRaisesRegex(ValueError, "must be exactly false"):
            PresentationTimingRowV1.from_json_bytes(
                canonical_json_bytes(authority, label="bad row", maximum_bytes=4_096)
            )
        noncanonical = json.dumps(row.to_dict(), indent=2).encode("ascii")
        with self.assertRaises(ValueError):
            PresentationTimingRowV1.from_json_bytes(noncanonical)

    def test_rows_exclude_source_profile_transport_and_readiness_claims(self) -> None:
        forbidden = {
            "source_id",
            "source_asset_sha256",
            "capture_profile",
            "capture_profile_sha256",
            "path",
            "transport",
            "provenance",
            "ready",
        }
        for row in (
            _timing_rows((0,))[0],
            _packet_rows((1,))[0],
            _frame_rows((_digest(9),))[0],
        ):
            self.assertTrue(forbidden.isdisjoint(row.to_dict()))

    def test_direct_contracts_reject_wrong_types_and_invalid_recipe(self) -> None:
        with self.assertRaises(ValueError):
            replace(_timing_rows((0,))[0], decoded_frame_ordinal=True)
        with self.assertRaises(ValueError):
            replace(_packet_rows((1,))[0], payload_byte_length=0)
        with self.assertRaises(ValueError):
            replace(_frame_rows((_digest(1),))[0], display_rotation_degrees=180.0)
        with self.assertRaises(ValueError):
            _recipe(identical_minimum=5, freeze_minimum=4)
        with self.assertRaisesRegex(ValueError, "fixed V1 recipe"):
            replace(
                _recipe(),
                capture_measurement_command_recipe_sha256=_digest(999),
            )

    def test_object_setattr_mutation_is_revalidated_before_aggregation(self) -> None:
        timing = _timing_rows((0,))[0]
        object.__setattr__(timing, "admissible_for_training", True)
        with self.assertRaisesRegex(ValueError, "valid canonical contract"):
            aggregate_presentation_timing_rows_v1(
                (timing,), selected_video_stream_index=0
            )

        packet = _packet_rows((10,))[0]
        object.__setattr__(packet, "payload_byte_length", 0)
        with self.assertRaisesRegex(ValueError, "valid canonical contract"):
            aggregate_selected_video_packet_rows_v1(
                (packet,), selected_video_stream_index=0
            )

        frame = _frame_rows((_digest(8),))[0]
        object.__setattr__(frame, "decoded_width_px", 0)
        with self.assertRaisesRegex(ValueError, "valid canonical contract"):
            aggregate_decoded_frame_rows_v1(
                (frame,), selected_video_stream_index=0, recipe=_recipe()
            )

        recipe = _recipe()
        object.__setattr__(recipe, "freeze_candidate_minimum_frames", 1)
        with self.assertRaisesRegex(ValueError, "valid canonical contract"):
            aggregate_decoded_frame_rows_v1(
                _frame_rows((_digest(9),)),
                selected_video_stream_index=0,
                recipe=recipe,
            )


class StreamingAggregationTests(unittest.TestCase):
    def test_public_aggregators_enforce_exact_segment_row_caps(self) -> None:
        timing_at_cap = aggregate_presentation_timing_rows_v1(
            (
                PresentationTimingRowV1(
                    decoded_frame_ordinal=ordinal,
                    selected_video_stream_index=0,
                    presentation_pts=ordinal * 3_000,
                    source_time_base_numerator=1,
                    source_time_base_denominator=90_000,
                )
                for ordinal in range(MAX_FINALIZED_FRAMES)
            ),
            selected_video_stream_index=0,
        )
        self.assertEqual(
            timing_at_cap.cadence.decoded_frame_count, MAX_FINALIZED_FRAMES
        )
        with self.assertRaisesRegex(ValueError, "finalized-segment limit"):
            aggregate_presentation_timing_rows_v1(
                (
                    PresentationTimingRowV1(
                        decoded_frame_ordinal=ordinal,
                        selected_video_stream_index=0,
                        presentation_pts=ordinal * 3_000,
                        source_time_base_numerator=1,
                        source_time_base_denominator=90_000,
                    )
                    for ordinal in range(MAX_FINALIZED_FRAMES + 1)
                ),
                selected_video_stream_index=0,
            )

        base_frame = _frame_rows((_digest(1),))[0]
        frame_at_cap = aggregate_decoded_frame_rows_v1(
            (
                replace(
                    base_frame,
                    decoded_frame_ordinal=ordinal,
                    presentation_pts=ordinal * 3_000,
                )
                for ordinal in range(MAX_FINALIZED_FRAMES)
            ),
            selected_video_stream_index=0,
            recipe=_recipe(),
        )
        self.assertEqual(frame_at_cap.frame_count, MAX_FINALIZED_FRAMES)
        with self.assertRaisesRegex(ValueError, "finalized-segment limit"):
            aggregate_decoded_frame_rows_v1(
                (
                    replace(
                        base_frame,
                        decoded_frame_ordinal=ordinal,
                        presentation_pts=ordinal * 3_000,
                    )
                    for ordinal in range(MAX_FINALIZED_FRAMES + 1)
                ),
                selected_video_stream_index=0,
                recipe=_recipe(),
            )

        def packet_rows(count: int):
            for ordinal in range(count):
                yield SelectedVideoPacketPayloadRowV1(
                    packet_ordinal=ordinal,
                    selected_video_stream_index=0,
                    payload_byte_length=1,
                    packet_pts=ordinal,
                    packet_dts=ordinal,
                )

        packets_at_cap = aggregate_selected_video_packet_rows_v1(
            packet_rows(MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS),
            selected_video_stream_index=0,
        )
        self.assertEqual(
            packets_at_cap.packet_count, MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS
        )
        with self.assertRaisesRegex(ValueError, "bounded segment limit"):
            aggregate_selected_video_packet_rows_v1(
                packet_rows(MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS + 1),
                selected_video_stream_index=0,
            )

    def test_hostile_iterators_are_normalized_at_every_public_boundary(self) -> None:
        failure = _IteratorAcquisitionFailure()
        calls = (
            lambda rows: aggregate_presentation_timing_rows_v1(
                rows, selected_video_stream_index=0
            ),
            lambda rows: aggregate_selected_video_packet_rows_v1(
                rows, selected_video_stream_index=0
            ),
            lambda rows: aggregate_decoded_frame_rows_v1(
                rows, selected_video_stream_index=0, recipe=_recipe()
            ),
        )
        for call in calls:
            with self.subTest(call=call):
                with self.assertRaisesRegex(ValueError, "iteration failed"):
                    call(failure)

        timing = _timing_rows((0, 3_000))
        packets = _packet_rows((10, 20))
        frames = _frame_rows((_digest(1), _digest(2)), presentation_pts=(0, 3_000))
        for call, rows in zip(calls, (timing, packets, frames), strict=True):
            with self.subTest(call=call, phase="midstream"):
                with self.assertRaisesRegex(ValueError, "iteration failed"):
                    call(_iterator_midstream_failure(rows[0]))

        with self.assertRaisesRegex(ValueError, "iteration failed"):
            aggregate_paired_presentation_and_frame_rows_v1(
                failure,
                frames,
                selected_video_stream_index=0,
                recipe=_recipe(),
            )
        with self.assertRaisesRegex(ValueError, "iteration failed"):
            aggregate_paired_presentation_and_frame_rows_v1(
                _iterator_midstream_failure(timing[0]),
                frames,
                selected_video_stream_index=0,
                recipe=_recipe(),
            )
        with self.assertRaisesRegex(ValueError, "iteration failed"):
            aggregate_paired_presentation_and_frame_rows_v1(
                timing,
                _iterator_midstream_failure(frames[0]),
                selected_video_stream_index=0,
                recipe=_recipe(),
            )

    def test_exact_30_and_60_cadences(self) -> None:
        cases = (
            ((0, 3_000, 6_000), (1, 90_000), (30, 1)),
            ((0, 1, 2), (1_001, 30_000), (30_000, 1_001)),
            ((0, 1_500, 3_000), (1, 90_000), (60, 1)),
            ((0, 1, 2), (1_001, 60_000), (60_000, 1_001)),
        )
        for pts, time_base, expected_rate in cases:
            with self.subTest(expected_rate=expected_rate):
                result = aggregate_presentation_timing_rows_v1(
                    (row for row in _timing_rows(pts, time_base=time_base)),
                    selected_video_stream_index=0,
                )
                self.assertIs(
                    result.cadence.cadence_status,
                    DecodedCadenceStatusV1.EXACT_SUPPORTED_CFR,
                )
                self.assertEqual(
                    (
                        result.cadence.cadence_numerator,
                        result.cadence.cadence_denominator,
                    ),
                    expected_rate,
                )

    def test_vfr_missing_duplicate_and_regression_are_not_interpolated(self) -> None:
        cases = (
            ((0, 3_000, 6_100), DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA),
            ((0, None, 6_000), DecodedCadenceStatusV1.ABSTAINED_MISSING_PTS),
            ((0, 0, 3_000), DecodedCadenceStatusV1.ABSTAINED_DUPLICATE_PTS),
            ((3_000, 0, 6_000), DecodedCadenceStatusV1.ABSTAINED_REGRESSING_PTS),
        )
        for pts, status in cases:
            with self.subTest(status=status):
                result = aggregate_presentation_timing_rows_v1(
                    _timing_rows(pts),
                    selected_video_stream_index=0,
                )
                self.assertIs(result.cadence.cadence_status, status)
                self.assertEqual(
                    (
                        result.cadence.cadence_numerator,
                        result.cadence.cadence_denominator,
                    ),
                    (0, 0),
                )

    def test_reordered_or_duplicate_ordinals_are_rejected(self) -> None:
        timing = _timing_rows((0, 3_000))
        with self.assertRaisesRegex(ValueError, "contiguous from zero"):
            aggregate_presentation_timing_rows_v1(
                (timing[1], timing[0]), selected_video_stream_index=0
            )
        packets = _packet_rows((10, 20))
        with self.assertRaisesRegex(ValueError, "contiguous from zero"):
            aggregate_selected_video_packet_rows_v1(
                (packets[0], packets[0]), selected_video_stream_index=0
            )
        frames = _frame_rows((_digest(1), _digest(2)))
        with self.assertRaisesRegex(ValueError, "contiguous from zero"):
            aggregate_decoded_frame_rows_v1(
                (frames[1], frames[0]),
                selected_video_stream_index=0,
                recipe=_recipe(),
            )

    def test_cross_stream_geometry_and_time_base_changes_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "another stream"):
            aggregate_selected_video_packet_rows_v1(
                _packet_rows((10,), stream=1), selected_video_stream_index=0
            )
        frames = _frame_rows((_digest(1), _digest(2)))
        with self.assertRaisesRegex(ValueError, "geometry"):
            aggregate_decoded_frame_rows_v1(
                (frames[0], replace(frames[1], decoded_width_px=1280)),
                selected_video_stream_index=0,
                recipe=_recipe(),
            )
        with self.assertRaisesRegex(ValueError, "sample aspect ratio"):
            aggregate_decoded_frame_rows_v1(
                (
                    frames[0],
                    replace(
                        frames[1],
                        sample_aspect_ratio_numerator=2,
                        sample_aspect_ratio_denominator=1,
                    ),
                ),
                selected_video_stream_index=0,
                recipe=_recipe(),
            )
        timing = _timing_rows((0, 3_000))
        with self.assertRaisesRegex(ValueError, "time base changed"):
            aggregate_presentation_timing_rows_v1(
                (
                    timing[0],
                    replace(
                        timing[1],
                        source_time_base_numerator=1,
                        source_time_base_denominator=1_000,
                    ),
                ),
                selected_video_stream_index=0,
            )

    def test_row_digest_is_sensitive_to_mutation_and_order(self) -> None:
        original = aggregate_selected_video_packet_rows_v1(
            _packet_rows((10, 20, 30)), selected_video_stream_index=0
        )
        mutated = aggregate_selected_video_packet_rows_v1(
            _packet_rows((10, 21, 29)), selected_video_stream_index=0
        )
        reordered_values = aggregate_selected_video_packet_rows_v1(
            _packet_rows((30, 20, 10)), selected_video_stream_index=0
        )
        self.assertEqual(original.payload_bytes, mutated.payload_bytes)
        self.assertEqual(original.payload_bytes, reordered_values.payload_bytes)
        self.assertNotEqual(original.rows_sha256, mutated.rows_sha256)
        self.assertNotEqual(original.rows_sha256, reordered_values.rows_sha256)

        diagnostic_mutation = aggregate_selected_video_packet_rows_v1(
            _packet_rows(
                (10, 20, 30),
                packet_pts=(0, 3_000, 6_000),
                packet_dts=(-3_000, 3_000, 0),
            ),
            selected_video_stream_index=0,
        )
        self.assertEqual(original.payload_bytes, diagnostic_mutation.payload_bytes)
        self.assertNotEqual(original.rows_sha256, diagnostic_mutation.rows_sha256)

    def test_identical_pixel_runs_are_only_recipe_bound_candidates(self) -> None:
        a, b, c = _digest(10), _digest(11), _digest(12)
        result = aggregate_decoded_frame_rows_v1(
            _frame_rows((a, a, b, b, b, b, c, a, a)),
            selected_video_stream_index=0,
            recipe=_recipe(identical_minimum=2, freeze_minimum=4),
        )
        self.assertEqual(result.identical_frame_run_count, 3)
        self.assertEqual(result.freeze_candidate_count, 1)

        stricter = aggregate_decoded_frame_rows_v1(
            _frame_rows((a, a, b, b, b, b, c, a, a)),
            selected_video_stream_index=0,
            recipe=_recipe(identical_minimum=3, freeze_minimum=5),
        )
        self.assertEqual(stricter.identical_frame_run_count, 1)
        self.assertEqual(stricter.freeze_candidate_count, 0)

    def test_interlace_facts_reduce_without_claiming_verification(self) -> None:
        progressive = _frame_rows((_digest(1),))
        interlaced = replace(
            progressive[0], interlace_fact=DecodedFrameInterlaceFactV1.INTERLACED
        )
        mixed = aggregate_decoded_frame_rows_v1(
            (progressive[0], replace(interlaced, decoded_frame_ordinal=1)),
            selected_video_stream_index=0,
            recipe=_recipe(),
        )
        self.assertIs(mixed.interlace_observation, DecodedInterlaceObservationV1.MIXED)


class AggregationContractValidationTests(unittest.TestCase):
    def test_presentation_aggregation_reconstructs_cadence_and_digest(self) -> None:
        valid = aggregate_presentation_timing_rows_v1(
            _timing_rows((0, 3_000)), selected_video_stream_index=0
        )
        self.assertEqual(
            PresentationTimingAggregationV1(
                cadence=valid.cadence,
                rows_sha256=valid.rows_sha256,
            ),
            valid,
        )
        with self.assertRaisesRegex(ValueError, "exact DecodedCadenceDerivationV1"):
            PresentationTimingAggregationV1(  # type: ignore[arg-type]
                cadence="arbitrary",
                rows_sha256=valid.rows_sha256,
            )
        with self.assertRaisesRegex(ValueError, "rows_sha256"):
            replace(valid, rows_sha256="not-a-digest")

        mutated = aggregate_presentation_timing_rows_v1(
            _timing_rows((0, 3_000)), selected_video_stream_index=0
        )
        object.__setattr__(
            mutated.cadence, "decoded_frame_count", MAX_FINALIZED_FRAMES + 1
        )
        with self.assertRaisesRegex(ValueError, "valid canonical derivation"):
            PresentationTimingAggregationV1(
                cadence=mutated.cadence,
                rows_sha256=mutated.rows_sha256,
            )

    def test_frame_aggregation_validates_every_public_coordinate(self) -> None:
        valid = aggregate_decoded_frame_rows_v1(
            _frame_rows((_digest(1), _digest(2))),
            selected_video_stream_index=0,
            recipe=_recipe(),
        )
        invalid_changes = (
            ({"frame_count": MAX_FINALIZED_FRAMES + 1}, "frame_count"),
            ({"decoded_width_px": 0}, "decoded_width_px"),
            ({"decoded_height_px": 0}, "decoded_height_px"),
            (
                {
                    "sample_aspect_ratio_numerator": 2,
                    "sample_aspect_ratio_denominator": 2,
                },
                "sample aspect ratio",
            ),
            ({"display_rotation_degrees": 45}, "display_rotation_degrees"),
            (
                {
                    "source_time_base_numerator": 2,
                    "source_time_base_denominator": 2_000,
                },
                "source time base",
            ),
            ({"interlace_observation": "PROGRESSIVE_ONLY"}, "exact"),
            ({"identical_frame_run_count": 3}, "identical_frame_run_count"),
            ({"freeze_candidate_count": 1}, "freeze candidates"),
            ({"rows_sha256": "not-a-digest"}, "rows_sha256"),
        )
        for changes, message in invalid_changes:
            with (
                self.subTest(changes=changes),
                self.assertRaisesRegex(ValueError, message),
            ):
                replace(valid, **changes)

        for frame_count, identical_runs in ((1, 1), (2, 2), (3, 2)):
            with (
                self.subTest(frame_count=frame_count, identical_runs=identical_runs),
                self.assertRaisesRegex(ValueError, "identical_frame_run_count"),
            ):
                replace(
                    valid,
                    frame_count=frame_count,
                    identical_frame_run_count=identical_runs,
                    freeze_candidate_count=0,
                )
        for frame_count, identical_runs in ((1, 0), (2, 1), (3, 1), (4, 2)):
            with self.subTest(frame_count=frame_count, identical_runs=identical_runs):
                boundary = replace(
                    valid,
                    frame_count=frame_count,
                    identical_frame_run_count=identical_runs,
                    freeze_candidate_count=identical_runs,
                )
                self.assertEqual(boundary.identical_frame_run_count, identical_runs)

    def test_packet_aggregation_validates_cap_payload_and_digest(self) -> None:
        valid = aggregate_selected_video_packet_rows_v1(
            _packet_rows((2, 3)), selected_video_stream_index=0
        )
        self.assertEqual(
            SelectedVideoPacketAggregationV1(
                packet_count=valid.packet_count,
                payload_bytes=valid.payload_bytes,
                rows_sha256=valid.rows_sha256,
            ),
            valid,
        )
        invalid_changes = (
            (
                {"packet_count": MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS + 1},
                "packet_count",
            ),
            ({"payload_bytes": 0}, "payload_bytes"),
            ({"packet_count": 6}, "exceeds payload_bytes"),
            ({"rows_sha256": "not-a-digest"}, "rows_sha256"),
        )
        for changes, message in invalid_changes:
            with (
                self.subTest(changes=changes),
                self.assertRaisesRegex(ValueError, message),
            ):
                replace(valid, **changes)
        object.__setattr__(
            valid,
            "packet_count",
            MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS + 1,
        )
        with self.assertRaisesRegex(ValueError, "packet_count"):
            SelectedVideoPacketAggregationV1(
                packet_count=valid.packet_count,
                payload_bytes=valid.payload_bytes,
                rows_sha256=valid.rows_sha256,
            )

    def test_paired_aggregation_revalidates_nested_values_and_joins(self) -> None:
        valid = aggregate_paired_presentation_and_frame_rows_v1(
            _timing_rows((0, 3_000)),
            _frame_rows((_digest(1), _digest(2))),
            selected_video_stream_index=0,
            recipe=_recipe(),
        )
        self.assertEqual(
            PairedPresentationFrameAggregationV1(
                presentation_timing=valid.presentation_timing,
                decoded_frames=valid.decoded_frames,
            ),
            valid,
        )
        with self.assertRaisesRegex(ValueError, "exact PresentationTiming"):
            PairedPresentationFrameAggregationV1(  # type: ignore[arg-type]
                presentation_timing="arbitrary",
                decoded_frames=valid.decoded_frames,
            )
        with self.assertRaisesRegex(ValueError, "counts differ"):
            PairedPresentationFrameAggregationV1(
                presentation_timing=valid.presentation_timing,
                decoded_frames=replace(valid.decoded_frames, frame_count=1),
            )
        with self.assertRaisesRegex(ValueError, "time bases differ"):
            PairedPresentationFrameAggregationV1(
                presentation_timing=valid.presentation_timing,
                decoded_frames=replace(
                    valid.decoded_frames,
                    source_time_base_numerator=1,
                    source_time_base_denominator=1_000,
                ),
            )

        tampered_timing = aggregate_presentation_timing_rows_v1(
            _timing_rows((0, 3_000)), selected_video_stream_index=0
        )
        object.__setattr__(tampered_timing, "rows_sha256", "not-a-digest")
        with self.assertRaisesRegex(ValueError, "valid canonical aggregation"):
            PairedPresentationFrameAggregationV1(
                presentation_timing=tampered_timing,
                decoded_frames=valid.decoded_frames,
            )

        tampered_frames = valid.decoded_frames
        object.__setattr__(tampered_frames, "decoded_width_px", 0)
        with self.assertRaisesRegex(ValueError, "valid canonical aggregation"):
            PairedPresentationFrameAggregationV1(
                presentation_timing=valid.presentation_timing,
                decoded_frames=tampered_frames,
            )


class ReceiptConstructionTests(unittest.TestCase):
    def test_builder_rejects_oversized_source_before_consuming_rows(self) -> None:
        never_iterated = _IteratorAcquisitionFailure()
        with self.assertRaisesRegex(ValueError, "source_asset_byte_length"):
            build_decoded_capture_measurement_receipt_v1(
                source_id="source-1",
                source_asset_sha256=_digest(1),
                source_asset_byte_length=MAX_FINALIZED_SOURCE_BYTES + 1,
                artifact_generation_id=_digest(2),
                selected_video_stream_index=0,
                decoder_runtime_manifest_sha256=_digest(3),
                observed_codec=VideoCodecV1.AVC_H264,
                recipe=_recipe(),
                presentation_timing_rows=never_iterated,
                selected_video_packet_rows=never_iterated,
                decoded_frame_rows=never_iterated,
            )

    def test_constructs_complete_non_authorizing_unverified_receipt(self) -> None:
        a, b = _digest(20), _digest(21)
        receipt = _receipt(pixel_digests=(a, a, a, b))
        self.assertIs(
            receipt.measurement_analysis_status,
            DecodedMeasurementAnalysisStatusV1.RECIPE_BOUND_COMPLETE_BOUNDED_SOURCE_SEGMENT_CLAIMS_UNVERIFIED,
        )
        self.assertEqual(receipt.decoded_frame_count, 4)
        self.assertEqual(
            (
                receipt.sample_aspect_ratio_numerator,
                receipt.sample_aspect_ratio_denominator,
            ),
            (1, 1),
        )
        self.assertEqual(receipt.selected_video_packet_count, 3)
        self.assertEqual(receipt.selected_video_payload_bytes, 6_000)
        self.assertEqual(receipt.identical_frame_run_count, 1)
        self.assertEqual(receipt.freeze_candidate_count, 0)
        self.assertEqual(receipt.measurement_recipe_sha256, _recipe().fingerprint())
        self.assertEqual(
            _recipe().capture_measurement_command_recipe_sha256,
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
        )
        self.assertFalse(receipt.admissible_for_training)
        self.assertFalse(receipt.admissible_for_live_scoring)

    def test_b_frame_packet_order_does_not_influence_presentation_cadence(self) -> None:
        first = _receipt(
            packets=_packet_rows(
                (20, 20, 20),
                packet_pts=(0, 6_000, 3_000),
                packet_dts=(0, 3_000, 6_000),
            )
        )
        reordered = _receipt(
            packets=_packet_rows(
                (20, 20, 20),
                packet_pts=(3_000, 0, 6_000),
                packet_dts=(0, 3_000, 6_000),
            )
        )
        self.assertEqual(first.cadence_status, reordered.cadence_status)
        self.assertEqual(first.constant_presentation_pts_delta, 3_000)
        self.assertEqual(reordered.constant_presentation_pts_delta, 3_000)
        self.assertNotEqual(
            first.selected_video_packet_rows_sha256,
            reordered.selected_video_packet_rows_sha256,
        )

    def test_frame_content_is_joined_to_exact_presentation_pts_by_ordinal(self) -> None:
        timing = _timing_rows((0, 3_000))
        frames = _frame_rows((_digest(10), _digest(11)), presentation_pts=(0, 3_001))
        with self.assertRaisesRegex(ValueError, "frame PTS does not match"):
            aggregate_paired_presentation_and_frame_rows_v1(
                timing,
                frames,
                selected_video_stream_index=0,
                recipe=_recipe(),
            )

    def test_inconsistent_frame_pts_counts_and_time_bases_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "row counts differ"):
            build_decoded_capture_measurement_receipt_v1(
                source_id="source-1",
                source_asset_sha256=_digest(1),
                source_asset_byte_length=100_000,
                artifact_generation_id=_digest(2),
                selected_video_stream_index=0,
                decoder_runtime_manifest_sha256=_digest(3),
                observed_codec=VideoCodecV1.HEVC_H265,
                recipe=_recipe(),
                presentation_timing_rows=_timing_rows((0, 3_000)),
                selected_video_packet_rows=_packet_rows((10,)),
                decoded_frame_rows=_frame_rows((_digest(8),)),
            )
        with self.assertRaisesRegex(ValueError, "time bases differ"):
            build_decoded_capture_measurement_receipt_v1(
                source_id="source-1",
                source_asset_sha256=_digest(1),
                source_asset_byte_length=100_000,
                artifact_generation_id=_digest(2),
                selected_video_stream_index=0,
                decoder_runtime_manifest_sha256=_digest(3),
                observed_codec=VideoCodecV1.HEVC_H265,
                recipe=_recipe(),
                presentation_timing_rows=_timing_rows((0, 3_000)),
                selected_video_packet_rows=_packet_rows((10,)),
                decoded_frame_rows=_frame_rows(
                    (_digest(8), _digest(9)), time_base=(1, 1_000)
                ),
            )

    def test_empty_streams_and_absent_source_facts_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            aggregate_presentation_timing_rows_v1((), selected_video_stream_index=0)
        with self.assertRaises(ValueError):
            aggregate_selected_video_packet_rows_v1((), selected_video_stream_index=0)
        with self.assertRaises(ValueError):
            aggregate_decoded_frame_rows_v1(
                (), selected_video_stream_index=0, recipe=_recipe()
            )
        with self.assertRaises(ValueError):
            build_decoded_capture_measurement_receipt_v1(
                source_id=None,  # type: ignore[arg-type]
                source_asset_sha256=_digest(1),
                source_asset_byte_length=1_000,
                artifact_generation_id=_digest(2),
                selected_video_stream_index=0,
                decoder_runtime_manifest_sha256=_digest(3),
                observed_codec=VideoCodecV1.AVC_H264,
                recipe=_recipe(),
                presentation_timing_rows=_timing_rows((0,)),
                selected_video_packet_rows=_packet_rows((10,)),
                decoded_frame_rows=_frame_rows((_digest(7),)),
            )

    def test_packet_payload_must_fit_source_asset(self) -> None:
        with self.assertRaisesRegex(ValueError, "selected_video_payload_bytes"):
            build_decoded_capture_measurement_receipt_v1(
                source_id="source-1",
                source_asset_sha256=_digest(1),
                source_asset_byte_length=9,
                artifact_generation_id=_digest(2),
                selected_video_stream_index=0,
                decoder_runtime_manifest_sha256=_digest(3),
                observed_codec=VideoCodecV1.AVC_H264,
                recipe=_recipe(),
                presentation_timing_rows=_timing_rows((0,)),
                selected_video_packet_rows=_packet_rows((10,)),
                decoded_frame_rows=_frame_rows((_digest(7),)),
            )


if __name__ == "__main__":
    unittest.main()
