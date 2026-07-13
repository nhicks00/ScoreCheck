from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import inspect
from itertools import product
import json
import unittest

from vision_scoring.capture_contracts import (
    MAX_FINALIZED_FRAMES,
    MAX_FINALIZED_SOURCE_BYTES,
)
from vision_scoring.capture_measurement_contracts import (
    DECODED_CAPTURE_MEASUREMENT_RECEIPT_DOMAIN,
    MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS,
    DecodedCadenceDerivationV1,
    DecodedCadenceStatusV1,
    DecodedCaptureMeasurementReceiptV1,
    DecodedInterlaceObservationV1,
    DecodedMeasurementAnalysisStatusV1,
    average_payload_bitrate_rational_v1,
    derive_exact_decoded_cadence_v1,
)
from vision_scoring.capture_profile_contracts import VideoCodecV1
from vision_scoring.contract_wire import CanonicalWireError
from vision_scoring.contract_wire import MAX_SIGNED_64, MIN_SIGNED_64


def _digest(value: int) -> str:
    return f"{value:064x}"


def _measurement(
    *,
    presentation_pts: tuple[int | None, ...] = (0, 3_000, 6_000, 9_000),
    source_time_base_numerator: int = 1,
    source_time_base_denominator: int = 90_000,
    payload_bytes: int = 37_500,
    **changes: object,
) -> DecodedCaptureMeasurementReceiptV1:
    derivation = derive_exact_decoded_cadence_v1(
        presentation_pts,
        source_time_base_numerator=source_time_base_numerator,
        source_time_base_denominator=source_time_base_denominator,
    )
    bitrate = average_payload_bitrate_rational_v1(
        selected_video_payload_bytes=payload_bytes,
        first_presentation_pts=derivation.first_presentation_pts,
        last_presentation_pts=derivation.last_presentation_pts,
        source_time_base_numerator=source_time_base_numerator,
        source_time_base_denominator=source_time_base_denominator,
    )
    values: dict[str, object] = {
        "source_id": "denver-open-court-1",
        "source_asset_sha256": _digest(1),
        "source_asset_byte_length": 1_000_000,
        "artifact_generation_id": _digest(2),
        "selected_video_stream_index": 0,
        "decoder_runtime_manifest_sha256": _digest(3),
        "measurement_recipe_sha256": _digest(4),
        "measurement_analysis_status": (
            DecodedMeasurementAnalysisStatusV1.RECIPE_BOUND_COMPLETE_BOUNDED_SOURCE_SEGMENT_CLAIMS_UNVERIFIED
        ),
        "observed_codec": VideoCodecV1.AVC_H264,
        "decoded_width_px": 1920,
        "decoded_height_px": 1080,
        "sample_aspect_ratio_numerator": 1,
        "sample_aspect_ratio_denominator": 1,
        "display_rotation_degrees": 0,
        "interlace_observation": (DecodedInterlaceObservationV1.PROGRESSIVE_ONLY),
        "source_time_base_numerator": source_time_base_numerator,
        "source_time_base_denominator": source_time_base_denominator,
        "decoded_frame_count": derivation.decoded_frame_count,
        "first_presentation_pts": derivation.first_presentation_pts,
        "last_presentation_pts": derivation.last_presentation_pts,
        "presentation_timing_rows_sha256": _digest(5),
        "selected_video_packet_count": 30,
        "selected_video_packet_rows_sha256": _digest(6),
        "decoded_frame_rows_sha256": _digest(7),
        "missing_presentation_pts_count": (derivation.missing_presentation_pts_count),
        "duplicate_presentation_pts_count": (
            derivation.duplicate_presentation_pts_count
        ),
        "regressing_presentation_pts_count": (
            derivation.regressing_presentation_pts_count
        ),
        "cadence_status": derivation.cadence_status,
        "constant_presentation_pts_delta": (derivation.constant_presentation_pts_delta),
        "cadence_numerator": derivation.cadence_numerator,
        "cadence_denominator": derivation.cadence_denominator,
        "selected_video_payload_bytes": payload_bytes,
        "average_payload_bitrate_numerator": bitrate[0],
        "average_payload_bitrate_denominator": bitrate[1],
        "identical_frame_run_count": 1,
        "freeze_candidate_count": 1,
    }
    values.update(changes)
    return DecodedCaptureMeasurementReceiptV1(**values)


class ExactCadenceDerivationTests(unittest.TestCase):
    def test_cadence_derivation_enforces_exact_finalized_frame_cap(self) -> None:
        at_cap = derive_exact_decoded_cadence_v1(
            (ordinal * 3_000 for ordinal in range(MAX_FINALIZED_FRAMES)),
            source_time_base_numerator=1,
            source_time_base_denominator=90_000,
        )
        self.assertEqual(at_cap.decoded_frame_count, MAX_FINALIZED_FRAMES)
        with self.assertRaisesRegex(ValueError, "decoded_frame_count"):
            replace(at_cap, decoded_frame_count=MAX_FINALIZED_FRAMES + 1)
        with self.assertRaisesRegex(ValueError, "finalized-segment limit"):
            derive_exact_decoded_cadence_v1(
                (ordinal * 3_000 for ordinal in range(MAX_FINALIZED_FRAMES + 1)),
                source_time_base_numerator=1,
                source_time_base_denominator=90_000,
            )

    def test_accepts_only_four_exact_supported_cadences(self) -> None:
        cases = (
            ((0, 3_000, 6_000), 1, 90_000, (30, 1)),
            ((0, 1, 2), 1_001, 30_000, (30_000, 1_001)),
            ((0, 1_500, 3_000), 1, 90_000, (60, 1)),
            ((0, 1, 2), 1_001, 60_000, (60_000, 1_001)),
        )
        for pts, time_base_numerator, time_base_denominator, expected in cases:
            with self.subTest(expected=expected):
                result = derive_exact_decoded_cadence_v1(
                    pts,
                    source_time_base_numerator=time_base_numerator,
                    source_time_base_denominator=time_base_denominator,
                )
                self.assertIs(
                    result.cadence_status,
                    DecodedCadenceStatusV1.EXACT_SUPPORTED_CFR,
                )
                self.assertEqual(
                    (result.cadence_numerator, result.cadence_denominator),
                    expected,
                )

    def test_near_rate_abstains_without_rounding(self) -> None:
        result = derive_exact_decoded_cadence_v1(
            (0, 3_337, 6_674),
            source_time_base_numerator=1,
            source_time_base_denominator=100_000,
        )
        self.assertIs(
            result.cadence_status,
            DecodedCadenceStatusV1.ABSTAINED_UNSUPPORTED_RATE,
        )
        self.assertEqual(result.constant_presentation_pts_delta, 3_337)
        self.assertEqual((result.cadence_numerator, result.cadence_denominator), (0, 0))

    def test_vfr_missing_duplicate_regression_and_single_frame_abstain(self) -> None:
        cases = (
            (
                (0, 3_000, 6_100),
                DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA,
                (0, 0, 0),
            ),
            (
                (0, None, 6_000),
                DecodedCadenceStatusV1.ABSTAINED_MISSING_PTS,
                (1, 0, 0),
            ),
            (
                (0, 0, 3_000),
                DecodedCadenceStatusV1.ABSTAINED_DUPLICATE_PTS,
                (0, 1, 0),
            ),
            (
                (3_000, 0, 6_000),
                DecodedCadenceStatusV1.ABSTAINED_REGRESSING_PTS,
                (0, 0, 1),
            ),
            (
                (0,),
                DecodedCadenceStatusV1.ABSTAINED_SINGLE_FRAME,
                (0, 0, 0),
            ),
        )
        for pts, expected_status, expected_counts in cases:
            with self.subTest(pts=pts):
                result = derive_exact_decoded_cadence_v1(
                    pts,
                    source_time_base_numerator=1,
                    source_time_base_denominator=90_000,
                )
                self.assertIs(result.cadence_status, expected_status)
                self.assertEqual(
                    (
                        result.missing_presentation_pts_count,
                        result.duplicate_presentation_pts_count,
                        result.regressing_presentation_pts_count,
                    ),
                    expected_counts,
                )
                self.assertEqual(
                    (result.cadence_numerator, result.cadence_denominator),
                    (0, 0),
                )

    def test_multiple_timing_anomaly_kinds_are_ambiguous(self) -> None:
        result = derive_exact_decoded_cadence_v1(
            (0, 0, -1),
            source_time_base_numerator=1,
            source_time_base_denominator=90_000,
        )
        self.assertIs(
            result.cadence_status,
            DecodedCadenceStatusV1.ABSTAINED_AMBIGUOUS_TIMING,
        )
        self.assertEqual(result.duplicate_presentation_pts_count, 1)
        self.assertEqual(result.regressing_presentation_pts_count, 1)

    def test_api_accepts_only_presentation_pts_not_packet_or_decode_order(self) -> None:
        signature = inspect.signature(derive_exact_decoded_cadence_v1)
        self.assertEqual(
            tuple(signature.parameters),
            (
                "presentation_pts",
                "source_time_base_numerator",
                "source_time_base_denominator",
            ),
        )
        with self.assertRaisesRegex(TypeError, "packet_dts"):
            derive_exact_decoded_cadence_v1(
                (0, 3_000, 6_000),
                source_time_base_numerator=1,
                source_time_base_denominator=90_000,
                packet_dts=(0, 6_000, 3_000),  # type: ignore[call-arg]
            )

    def test_millisecond_rtmp_alternation_remains_variable(self) -> None:
        for pts in ((0, 33, 67, 100), (0, 17, 33, 50)):
            with self.subTest(pts=pts):
                result = derive_exact_decoded_cadence_v1(
                    pts,
                    source_time_base_numerator=1,
                    source_time_base_denominator=1_000,
                )
                self.assertIs(
                    result.cadence_status,
                    DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA,
                )
                self.assertEqual(
                    (result.cadence_numerator, result.cadence_denominator),
                    (0, 0),
                )

    def test_missing_pts_breaks_adjacency_without_making_derivation_invalid(
        self,
    ) -> None:
        result = derive_exact_decoded_cadence_v1(
            (1, None, 0),
            source_time_base_numerator=1,
            source_time_base_denominator=1_000,
        )
        self.assertIs(
            result.cadence_status,
            DecodedCadenceStatusV1.ABSTAINED_MISSING_PTS,
        )
        self.assertEqual(result.regressing_presentation_pts_count, 0)

    def test_all_small_valid_pts_iterables_produce_valid_derivations(self) -> None:
        for frame_count in range(1, 5):
            for pts in product((None, -1, 0, 1), repeat=frame_count):
                with self.subTest(pts=pts):
                    result = derive_exact_decoded_cadence_v1(
                        pts,
                        source_time_base_numerator=1,
                        source_time_base_denominator=1_000,
                    )
                    self.assertIs(type(result), DecodedCadenceDerivationV1)

    def test_signed_64_pts_and_time_base_boundaries_fail_closed(self) -> None:
        result = derive_exact_decoded_cadence_v1(
            (MIN_SIGNED_64, MIN_SIGNED_64 + 1),
            source_time_base_numerator=MAX_SIGNED_64,
            source_time_base_denominator=MAX_SIGNED_64 - 1,
        )
        self.assertIs(
            result.cadence_status,
            DecodedCadenceStatusV1.ABSTAINED_UNSUPPORTED_RATE,
        )
        with self.assertRaisesRegex(ValueError, "delta exceeds"):
            derive_exact_decoded_cadence_v1(
                (MIN_SIGNED_64, MAX_SIGNED_64),
                source_time_base_numerator=1,
                source_time_base_denominator=1,
            )
        with self.assertRaisesRegex(ValueError, "source_time_base_numerator"):
            derive_exact_decoded_cadence_v1(
                (0, 1),
                source_time_base_numerator=MAX_SIGNED_64 + 1,
                source_time_base_denominator=1,
            )

    def test_empty_or_noncanonical_inputs_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least one"):
            derive_exact_decoded_cadence_v1(
                (),
                source_time_base_numerator=1,
                source_time_base_denominator=90_000,
            )
        with self.assertRaisesRegex(ValueError, "exact integer"):
            derive_exact_decoded_cadence_v1(
                (0, True),
                source_time_base_numerator=1,
                source_time_base_denominator=90_000,
            )
        with self.assertRaisesRegex(ValueError, "reduced"):
            derive_exact_decoded_cadence_v1(
                (0, 1),
                source_time_base_numerator=2,
                source_time_base_denominator=180_000,
            )

    def test_exported_derivation_rejects_inconsistent_direct_construction(self) -> None:
        exact = derive_exact_decoded_cadence_v1(
            (0, 3_000, 6_000),
            source_time_base_numerator=1,
            source_time_base_denominator=90_000,
        )
        with self.assertRaisesRegex(ValueError, "cadence rational"):
            replace(exact, cadence_numerator=60)
        with self.assertRaisesRegex(ValueError, "exact DecodedCadenceStatusV1"):
            replace(exact, cadence_status="EXACT_SUPPORTED_CFR")  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "single decoded frame"):
            DecodedCadenceDerivationV1(
                source_time_base_numerator=1,
                source_time_base_denominator=1_000,
                decoded_frame_count=1,
                first_presentation_pts=1,
                last_presentation_pts=2,
                missing_presentation_pts_count=0,
                duplicate_presentation_pts_count=0,
                regressing_presentation_pts_count=0,
                cadence_status=DecodedCadenceStatusV1.ABSTAINED_SINGLE_FRAME,
                constant_presentation_pts_delta=0,
                cadence_numerator=0,
                cadence_denominator=0,
            )


class MeasurementReceiptTests(unittest.TestCase):
    def test_identical_run_counts_fit_disjoint_minimum_two_frame_runs(self) -> None:
        invalid = ((1, 1), (2, 2), (3, 2))
        for frame_count, identical_runs in invalid:
            with (
                self.subTest(frame_count=frame_count, identical_runs=identical_runs),
                self.assertRaisesRegex(ValueError, "identical_frame_run_count"),
            ):
                _measurement(
                    presentation_pts=tuple(
                        ordinal * 3_000 for ordinal in range(frame_count)
                    ),
                    identical_frame_run_count=identical_runs,
                    freeze_candidate_count=0,
                )

        feasible = ((1, 0), (2, 1), (3, 1), (4, 2))
        for frame_count, identical_runs in feasible:
            with self.subTest(frame_count=frame_count, identical_runs=identical_runs):
                receipt = _measurement(
                    presentation_pts=tuple(
                        ordinal * 3_000 for ordinal in range(frame_count)
                    ),
                    identical_frame_run_count=identical_runs,
                    freeze_candidate_count=identical_runs,
                )
                self.assertEqual(receipt.identical_frame_run_count, identical_runs)

    def test_complete_segment_source_frame_and_packet_caps_are_exact(self) -> None:
        maximum_source = _measurement(
            source_asset_byte_length=MAX_FINALIZED_SOURCE_BYTES
        )
        self.assertEqual(
            maximum_source.source_asset_byte_length, MAX_FINALIZED_SOURCE_BYTES
        )
        with self.assertRaisesRegex(ValueError, "source_asset_byte_length"):
            _measurement(source_asset_byte_length=MAX_FINALIZED_SOURCE_BYTES + 1)

        maximum_frames = _measurement(
            presentation_pts=tuple(
                ordinal * 3_000 for ordinal in range(MAX_FINALIZED_FRAMES)
            )
        )
        self.assertEqual(maximum_frames.decoded_frame_count, MAX_FINALIZED_FRAMES)
        with self.assertRaisesRegex(ValueError, "decoded_frame_count"):
            replace(
                maximum_frames,
                decoded_frame_count=MAX_FINALIZED_FRAMES + 1,
            )

        maximum_packets = _measurement(
            payload_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS,
            selected_video_packet_count=MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS,
        )
        self.assertEqual(
            maximum_packets.selected_video_packet_count,
            MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS,
        )
        with self.assertRaisesRegex(ValueError, "selected_video_packet_count"):
            replace(
                maximum_packets,
                selected_video_packet_count=(
                    MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS + 1
                ),
            )

    def test_binds_full_decode_measurement_and_exact_payload_bitrate(self) -> None:
        receipt = _measurement()
        self.assertEqual(
            (
                receipt.average_payload_bitrate_numerator,
                receipt.average_payload_bitrate_denominator,
            ),
            (3_000_000, 1),
        )
        self.assertEqual(receipt.decoded_frame_count, 4)
        self.assertEqual(receipt.selected_video_packet_count, 30)
        self.assertIs(receipt.observed_codec, VideoCodecV1.AVC_H264)
        self.assertTrue(
            all(
                getattr(receipt, field_name) is False
                for field_name in (
                    "admissible_for_training",
                    "admissible_for_evaluation",
                    "admissible_for_test",
                    "admissible_for_deployment",
                    "admissible_for_live_scoring",
                )
            )
        )

    def test_single_frame_uses_unknown_bitrate_without_estimation(self) -> None:
        receipt = _measurement(
            presentation_pts=(12_345,),
            payload_bytes=2_000,
            selected_video_packet_count=2,
            identical_frame_run_count=0,
            freeze_candidate_count=0,
        )
        self.assertIs(
            receipt.cadence_status,
            DecodedCadenceStatusV1.ABSTAINED_SINGLE_FRAME,
        )
        self.assertEqual(
            (
                receipt.average_payload_bitrate_numerator,
                receipt.average_payload_bitrate_denominator,
            ),
            (0, 0),
        )

    def test_receipt_rejects_digest_role_aliases_and_subclasses(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not alias"):
            _measurement(measurement_recipe_sha256=_digest(3))

        class Digest(str):
            pass

        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            _measurement(source_asset_sha256=Digest(_digest(99)))

    def test_authority_flags_are_exactly_false(self) -> None:
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, "exactly false"):
                    _measurement(**{field_name: True})
        with self.assertRaisesRegex(ValueError, "exactly false"):
            _measurement(admissible_for_training=0)

    def test_cadence_and_bitrate_claims_are_self_consistent(self) -> None:
        receipt = _measurement()
        with self.assertRaisesRegex(ValueError, "constant delta"):
            replace(receipt, constant_presentation_pts_delta=3_001)
        with self.assertRaisesRegex(ValueError, "bitrate"):
            replace(receipt, average_payload_bitrate_numerator=2_999_999)
        with self.assertRaisesRegex(ValueError, "0/0"):
            _measurement(
                presentation_pts=(0, 3_000, 6_100),
                cadence_numerator=30,
                cadence_denominator=1,
            )

        with self.assertRaisesRegex(ValueError, "exactly one visible anomaly"):
            _measurement(
                presentation_pts=(0, 0, -1),
                cadence_status=DecodedCadenceStatusV1.ABSTAINED_DUPLICATE_PTS,
            )

    def test_impossible_abstained_summary_combinations_are_rejected(self) -> None:
        cases = (
            (
                "single decoded frame",
                {
                    "presentation_pts": (12_345,),
                    "first_presentation_pts": 12_345,
                    "last_presentation_pts": 12_346,
                },
            ),
            (
                "endpoints exceed",
                {
                    "presentation_pts": (0, None, None, None),
                    "last_presentation_pts": 0,
                },
            ),
            (
                "null PTS endpoints exceed",
                {
                    "presentation_pts": (None, 1, None),
                    "missing_presentation_pts_count": 1,
                },
            ),
            (
                "adjacent present pairs",
                {
                    "presentation_pts": (0, None, 6_000),
                    "duplicate_presentation_pts_count": 1,
                    "cadence_status": (
                        DecodedCadenceStatusV1.ABSTAINED_AMBIGUOUS_TIMING
                    ),
                },
            ),
            (
                "monotonic endpoints",
                {
                    "presentation_pts": (0, 0, 1),
                    "first_presentation_pts": 1,
                    "last_presentation_pts": 0,
                },
            ),
            (
                "three complete increasing",
                {
                    "presentation_pts": (0, 3_000),
                    "cadence_status": (DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA),
                    "constant_presentation_pts_delta": 0,
                    "cadence_numerator": 0,
                    "cadence_denominator": 0,
                },
            ),
            (
                "cannot contain unequal deltas",
                {
                    "presentation_pts": (0, 1, 2),
                    "source_time_base_numerator": 1,
                    "source_time_base_denominator": 30,
                    "cadence_status": (DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA),
                    "constant_presentation_pts_delta": 0,
                    "cadence_numerator": 0,
                    "cadence_denominator": 0,
                },
            ),
            (
                "all-duplicate",
                {
                    "presentation_pts": (0, 0, 0),
                    "last_presentation_pts": 1,
                },
            ),
            (
                "infeasible endpoint span",
                {
                    "presentation_pts": (0, 0, 1, 2),
                    "last_presentation_pts": 1,
                },
            ),
            (
                "infeasible",
                {
                    "presentation_pts": (0, -1, -2),
                    "last_presentation_pts": -1,
                },
            ),
            (
                "all-nonpositive",
                {
                    "presentation_pts": (0, 0, -1),
                    "last_presentation_pts": 100,
                },
            ),
        )
        for expected_error, arguments in cases:
            with self.subTest(expected_error=expected_error):
                with self.assertRaisesRegex(ValueError, expected_error):
                    _measurement(**arguments)

    def test_missing_breaks_bound_feasible_anomaly_comparisons(self) -> None:
        with self.assertRaisesRegex(ValueError, "adjacent present pairs"):
            _measurement(
                presentation_pts=(0, 0, None, -1, -2),
                duplicate_presentation_pts_count=2,
                regressing_presentation_pts_count=1,
            )

    def test_contract_is_immutable(self) -> None:
        receipt = _measurement()
        with self.assertRaises((FrozenInstanceError, AttributeError)):
            receipt.source_id = "changed"  # type: ignore[misc]
        with self.assertRaises((FrozenInstanceError, AttributeError)):
            del receipt.source_id

    def test_opaque_row_hashes_are_structural_claims_not_replayed_proof(self) -> None:
        receipt = _measurement(
            presentation_timing_rows_sha256=_digest(100),
            selected_video_packet_rows_sha256=_digest(101),
            decoded_frame_rows_sha256=_digest(102),
            identical_frame_run_count=0,
            freeze_candidate_count=0,
        )
        self.assertIs(
            receipt.measurement_analysis_status,
            DecodedMeasurementAnalysisStatusV1.RECIPE_BOUND_COMPLETE_BOUNDED_SOURCE_SEGMENT_CLAIMS_UNVERIFIED,
        )
        # Arbitrary distinct hashes are structurally valid by design.  A
        # future protected verifier must replay all committed rows under the
        # bound recipe before a separate admission contract can rely on them.
        self.assertFalse(receipt.admissible_for_training)
        self.assertEqual(receipt.identical_frame_run_count, 0)
        self.assertEqual(receipt.freeze_candidate_count, 0)

    def test_strict_canonical_wire_round_trip(self) -> None:
        receipt = _measurement()
        raw = receipt.to_json_bytes()
        self.assertEqual(
            DecodedCaptureMeasurementReceiptV1.from_json_bytes(raw), receipt
        )
        self.assertEqual(
            json.loads(raw)["domain"], DECODED_CAPTURE_MEASUREMENT_RECEIPT_DOMAIN
        )
        self.assertEqual(receipt.fingerprint(), receipt.fingerprint())

        extra = receipt.to_dict()
        extra["unsupported"] = 1
        with self.assertRaisesRegex(ValueError, "unsupported"):
            DecodedCaptureMeasurementReceiptV1.from_dict(extra)

        wrong_domain = json.loads(raw)
        wrong_domain["domain"] = "wrong"
        wrong_domain_raw = json.dumps(
            wrong_domain, sort_keys=True, separators=(",", ":")
        ).encode("ascii")
        with self.assertRaisesRegex(ValueError, "domain"):
            DecodedCaptureMeasurementReceiptV1.from_json_bytes(wrong_domain_raw)

        noncanonical = json.dumps(json.loads(raw), sort_keys=False).encode("ascii")
        with self.assertRaises(CanonicalWireError):
            DecodedCaptureMeasurementReceiptV1.from_json_bytes(noncanonical)

    def test_exact_enum_types_and_bounds_are_enforced(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact VideoCodecV1"):
            _measurement(observed_codec="AVC_H264")
        with self.assertRaisesRegex(ValueError, "display_rotation"):
            _measurement(display_rotation_degrees=45)
        with self.assertRaisesRegex(ValueError, "sample_aspect_ratio"):
            _measurement(
                sample_aspect_ratio_numerator=2,
                sample_aspect_ratio_denominator=2,
            )
        with self.assertRaisesRegex(
            ValueError, "exact DecodedMeasurementAnalysisStatusV1"
        ):
            _measurement(
                measurement_analysis_status=(
                    "RECIPE_BOUND_COMPLETE_BOUNDED_SOURCE_SEGMENT_CLAIMS_UNVERIFIED"
                )
            )
        with self.assertRaisesRegex(ValueError, "payload bytes"):
            _measurement(selected_video_packet_count=37_501)
        with self.assertRaisesRegex(ValueError, "freeze candidates"):
            _measurement(freeze_candidate_count=2)

    def test_derivation_result_is_a_bounded_immutable_value(self) -> None:
        value = derive_exact_decoded_cadence_v1(
            (0, 3_000),
            source_time_base_numerator=1,
            source_time_base_denominator=90_000,
        )
        self.assertIs(type(value), DecodedCadenceDerivationV1)
        with self.assertRaises((FrozenInstanceError, AttributeError)):
            value.cadence_numerator = 60  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
