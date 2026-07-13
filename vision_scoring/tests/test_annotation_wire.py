from __future__ import annotations

import base64
from dataclasses import replace
import json
import unittest
from unittest.mock import patch

from vision_scoring.annotation_trust import (
    AnnotationAttestation,
    AnnotationAttestationRole,
)
from vision_scoring.annotations import (
    AnnotationType,
    AutorotationPolicy,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    BlurEllipse,
    CaptureUnavailabilityReason,
    DecodedColorRange,
    DecodedColorSpace,
    DecodedFrameHashBasis,
    DecodedFrameIdentity,
    DecodedPixelFormat,
    FrameDecodeContract,
    FrameDuplicateKind,
    FrameReference,
    PixelCoordinateSpace,
    PixelPoint,
    PixelRegion,
    ReviewState,
    SearchRegionObservabilityAttestation,
    SearchRegionScope,
    SearchRegionVisibility,
    TimestampBasis,
    UnavailableFrameReference,
)
from vision_scoring.contract_wire import (
    CanonicalWireError,
    canonical_finite_json_bytes,
    parse_canonical_finite_json_object,
    parse_canonical_json_object,
)


SOURCE = "a" * 64
ONTOLOGY = "b" * 64
DECODED = "d" * 64
CAPTURE_SEGMENT = "sha256:" + "c" * 64
CAPTURE_ATTESTATION = "sha256:" + "d" * 64
REVIEW_EVIDENCE = "sha256:" + "e" * 64
GAP_EVIDENCE = "sha256:" + "f" * 64
ALT_EVIDENCE_A = "sha256:" + "1" * 64
ALT_EVIDENCE_B = "sha256:" + "2" * 64


def _frame() -> FrameReference:
    decode_contract = FrameDecodeContract(
        decoder_artifact_sha256="f" * 64,
        decoder_build_id="ffmpeg-8.1-arm64",
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=640,
        output_height=360,
    )
    return FrameReference(
        identity=DecodedFrameIdentity(
            source_sha256=SOURCE,
            selected_video_stream_index=0,
            frame_index=7,
            timestamp_ns=233_333_333,
            timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
            pixel_coordinate_space=(
                PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
            ),
            decode_contract=decode_contract,
            decoded_frame_sha256=DECODED,
            decoded_frame_hash_basis=(
                DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            ),
        ),
        duplicate_kind=FrameDuplicateKind.NONE,
    )


def _unavailable_frame() -> UnavailableFrameReference:
    return UnavailableFrameReference(
        source_sha256=SOURCE,
        selected_video_stream_index=0,
        frame_index=7,
        expected_interval_start_ns=230_000_000,
        expected_interval_end_ns=240_000_000,
        timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        capture_segment_ref=CAPTURE_SEGMENT,
        unavailability_reason=CaptureUnavailabilityReason.PRESENTATION_GAP,
        capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
        gap_evidence_refs=(GAP_EVIDENCE,),
    )


def _sharp(*, center: PixelPoint = PixelPoint(100.0, 120.0)) -> BallFrameAnnotationV2:
    return BallFrameAnnotationV2(
        annotation_id="ball-7",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="match-ball",
        frame=_frame(),
        visibility=BallVisibility.VISIBLE,
        appearance=BallAppearance.SHARP,
        role=BallRole.MATCH_BALL,
        play_state=BallPlayState.IN_PLAY,
        center=center,
        apparent_minor_axis_diameter_px=12.0,
        uncertainty_radius_px=2.0,
        track_segment_id="track-3",
    )


def _motion_endpoints() -> BallFrameAnnotationV2:
    return BallFrameAnnotationV2(
        annotation_id="ball-endpoints",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="match-ball",
        frame=_frame(),
        visibility=BallVisibility.PARTIALLY_OCCLUDED,
        appearance=BallAppearance.MOTION_BLURRED,
        role=BallRole.MATCH_BALL,
        play_state=BallPlayState.IN_PLAY,
        center=PixelPoint(100.0, 120.0),
        blur_start=PixelPoint(90.0, 120.0),
        blur_end=PixelPoint(110.0, 120.0),
        apparent_minor_axis_diameter_px=10.0,
        uncertainty_radius_px=3.0,
        track_segment_id="track-3",
    )


def _motion_ellipse() -> BallFrameAnnotationV2:
    return BallFrameAnnotationV2(
        annotation_id="ball-ellipse",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="match-ball",
        frame=_frame(),
        visibility=BallVisibility.VISIBLE,
        appearance=BallAppearance.MOTION_BLURRED,
        role=BallRole.MATCH_BALL,
        play_state=BallPlayState.IN_PLAY,
        center=PixelPoint(100.0, 120.0),
        blur_ellipse=BlurEllipse(
            major_radius_px=10.0,
            minor_radius_px=5.0,
            angle_degrees=45.0,
        ),
        apparent_minor_axis_diameter_px=10.0,
        uncertainty_radius_px=3.0,
        track_segment_id="track-3",
    )


def _not_present() -> BallFrameAnnotationV2:
    frame = _frame()
    search = SearchRegionObservabilityAttestation(
        source_sha256=frame.source_sha256,
        selected_video_stream_index=frame.selected_video_stream_index,
        frame_index=frame.frame_index,
        decoded_frame_sha256=frame.decoded_frame_sha256,
        frame_identity_sha256=frame.identity.fingerprint(),
        target_role=BallRole.MATCH_BALL,
        region_scope=SearchRegionScope.FULL_DECODED_FRAME,
        searched_region=PixelRegion(0.0, 0.0, 639.0, 359.0),
        region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
        capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
        reviewer_ids=("reviewer-1",),
        review_evidence_refs=(REVIEW_EVIDENCE,),
    )
    return BallFrameAnnotationV2(
        annotation_id="ball-not-present",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="match-ball",
        frame=frame,
        visibility=BallVisibility.NOT_PRESENT,
        appearance=BallAppearance.NOT_OBSERVABLE,
        role=BallRole.MATCH_BALL,
        play_state=BallPlayState.NOT_APPLICABLE,
        search_region_observability_attestation=search,
        review_state=ReviewState.REVIEWED,
        reviewer_ids=("reviewer-1",),
        review_evidence_refs=(REVIEW_EVIDENCE,),
    )


def _indistinguishable(*, reason: str = "Two overlapping balls") -> BallFrameAnnotationV2:
    return BallFrameAnnotationV2(
        annotation_id="ball-indistinguishable",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="unresolved-ball",
        frame=_frame(),
        visibility=BallVisibility.INDISTINGUISHABLE,
        appearance=BallAppearance.NOT_OBSERVABLE,
        role=BallRole.UNKNOWN,
        play_state=BallPlayState.UNKNOWN,
        ambiguity_reason=reason,
    )


def _capture_unknown() -> BallFrameAnnotationV2:
    return BallFrameAnnotationV2(
        annotation_id="ball-capture-unknown",
        ontology_sha256=ONTOLOGY,
        ball_instance_id="match-ball",
        frame=_unavailable_frame(),
        visibility=BallVisibility.CAPTURE_UNKNOWN,
        appearance=BallAppearance.NOT_OBSERVABLE,
        role=BallRole.MATCH_BALL,
        play_state=BallPlayState.UNKNOWN,
        ambiguity_reason="Decoded pixels are unavailable",
    )


def _attestation(annotation: BallFrameAnnotationV2) -> AnnotationAttestation:
    return AnnotationAttestation(
        annotation_type=AnnotationType.BALL_FRAME_OBSERVATION,
        annotation_sha256=annotation.fingerprint(),
        role=AnnotationAttestationRole.REVIEWER,
        principal_id="reviewer-1",
        key_id="review-key-1",
        trust_domain_id="annotation-trust-v2",
        signed_on="2026-07-12",
        signature_base64=base64.b64encode(b"\x11" * 64).decode("ascii"),
    )


def _canonical_mutation(annotation: BallFrameAnnotationV2, mutate: object) -> bytes:
    payload = json.loads(annotation.to_json_bytes().decode("utf-8"))
    assert callable(mutate)
    mutate(payload)
    return canonical_finite_json_bytes(payload, label="test mutation")


class _WireAssertions:
    def assert_wire_code(self, expected: str, callable_: object) -> None:
        assert callable(callable_)
        with self.assertRaises(CanonicalWireError) as caught:
            callable_()
        self.assertEqual(caught.exception.code, expected)


class AnnotationWireRoundTripTests(_WireAssertions, unittest.TestCase):

    def test_all_supported_ball_shapes_round_trip_exactly(self) -> None:
        annotations = (
            _sharp(),
            _motion_endpoints(),
            _motion_ellipse(),
            _not_present(),
            _indistinguishable(),
            _capture_unknown(),
        )
        for annotation in annotations:
            with self.subTest(annotation=annotation.annotation_id):
                fingerprint_before = annotation.fingerprint()
                raw = annotation.to_json_bytes()
                self.assertEqual(raw, annotation.canonical_json().encode("utf-8"))
                restored = BallFrameAnnotationV2.from_json_bytes(raw)
                self.assertEqual(restored, annotation)
                self.assertEqual(restored.to_json_bytes(), raw)
                self.assertEqual(restored.fingerprint(), fingerprint_before)

    def test_set_like_tuples_normalize_for_semantic_round_trip(self) -> None:
        reviewed = replace(
            _sharp(),
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-2", "reviewer-1"),
            review_evidence_refs=(REVIEW_EVIDENCE, ALT_EVIDENCE_A),
        )
        self.assertEqual(reviewed.reviewer_ids, ("reviewer-1", "reviewer-2"))
        self.assertEqual(
            reviewed.review_evidence_refs,
            (ALT_EVIDENCE_A, REVIEW_EVIDENCE),
        )
        self.assertEqual(
            BallFrameAnnotationV2.from_json_bytes(reviewed.to_json_bytes()),
            reviewed,
        )

        adjudicated = replace(
            reviewed,
            review_state=ReviewState.ADJUDICATED,
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(ALT_EVIDENCE_B, ALT_EVIDENCE_A),
        )
        self.assertEqual(
            adjudicated.adjudication_evidence_refs,
            (ALT_EVIDENCE_A, ALT_EVIDENCE_B),
        )
        self.assertEqual(
            BallFrameAnnotationV2.from_json_bytes(adjudicated.to_json_bytes()),
            adjudicated,
        )

        base_frame = _frame()
        duplicate_frame = FrameReference(
            identity=base_frame.identity,
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=6,
            capture_integrity_attestation_refs=(
                CAPTURE_ATTESTATION,
                ALT_EVIDENCE_A,
            ),
        )
        self.assertEqual(
            duplicate_frame.capture_integrity_attestation_refs,
            (ALT_EVIDENCE_A, CAPTURE_ATTESTATION),
        )
        duplicate_annotation = replace(_sharp(), frame=duplicate_frame)
        self.assertEqual(
            BallFrameAnnotationV2.from_json_bytes(
                duplicate_annotation.to_json_bytes()
            ),
            duplicate_annotation,
        )

        unavailable = replace(
            _unavailable_frame(),
            capture_integrity_attestation_refs=(
                CAPTURE_ATTESTATION,
                ALT_EVIDENCE_A,
            ),
            gap_evidence_refs=(GAP_EVIDENCE, ALT_EVIDENCE_B),
        )
        self.assertEqual(
            unavailable.capture_integrity_attestation_refs,
            (ALT_EVIDENCE_A, CAPTURE_ATTESTATION),
        )
        self.assertEqual(
            unavailable.gap_evidence_refs,
            (ALT_EVIDENCE_B, GAP_EVIDENCE),
        )
        unavailable_annotation = replace(_capture_unknown(), frame=unavailable)
        self.assertEqual(
            BallFrameAnnotationV2.from_json_bytes(
                unavailable_annotation.to_json_bytes()
            ),
            unavailable_annotation,
        )

        search_frame = _frame()
        search = SearchRegionObservabilityAttestation(
            source_sha256=search_frame.source_sha256,
            selected_video_stream_index=search_frame.selected_video_stream_index,
            frame_index=search_frame.frame_index,
            decoded_frame_sha256=search_frame.decoded_frame_sha256,
            frame_identity_sha256=search_frame.identity.fingerprint(),
            target_role=BallRole.MATCH_BALL,
            region_scope=SearchRegionScope.FULL_DECODED_FRAME,
            searched_region=PixelRegion(0.0, 0.0, 639.0, 359.0),
            region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
            capture_integrity_attestation_refs=(
                CAPTURE_ATTESTATION,
                ALT_EVIDENCE_A,
            ),
            reviewer_ids=("reviewer-2", "reviewer-1"),
            review_evidence_refs=(REVIEW_EVIDENCE, ALT_EVIDENCE_B),
        )
        not_present = BallFrameAnnotationV2(
            annotation_id="ball-not-present-unsorted",
            ontology_sha256=ONTOLOGY,
            ball_instance_id="match-ball",
            frame=search_frame,
            visibility=BallVisibility.NOT_PRESENT,
            appearance=BallAppearance.NOT_OBSERVABLE,
            role=BallRole.MATCH_BALL,
            play_state=BallPlayState.NOT_APPLICABLE,
            search_region_observability_attestation=search,
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-2", "reviewer-1"),
            review_evidence_refs=(REVIEW_EVIDENCE, ALT_EVIDENCE_B),
        )
        self.assertEqual(
            BallFrameAnnotationV2.from_json_bytes(not_present.to_json_bytes()),
            not_present,
        )

    def test_attestation_round_trip_is_exact_and_fingerprint_stable(self) -> None:
        annotation = _sharp()
        self.assertEqual(
            annotation.fingerprint(),
            "fb6bef77cea9293163bd387c6b8d8ffee78bb7a0d0edbac6fdbfa24478940d58",
        )
        attestation = _attestation(annotation)
        fingerprint_before = attestation.fingerprint()
        self.assertEqual(
            fingerprint_before,
            "a69c4d05622439a03b9e095a34984d8c4d8323a2f2748b3452f1b4fc100940e9",
        )
        raw = attestation.to_json_bytes()
        restored = AnnotationAttestation.from_json_bytes(raw)
        self.assertEqual(restored, attestation)
        self.assertEqual(restored.to_json_bytes(), raw)
        self.assertEqual(restored.fingerprint(), fingerprint_before)

    def test_integer_only_parser_remains_integer_only(self) -> None:
        self.assert_wire_code(
            "INVALID_JSON_NUMBER",
            lambda: parse_canonical_json_object(b'{"x":1.0}', label="integer only"),
        )
        self.assertEqual(
            parse_canonical_finite_json_object(b'{"x":1.0}', label="finite"),
            {"x": 1.0},
        )


class AnnotationWireCanonicalityTests(_WireAssertions, unittest.TestCase):
    def test_number_aliases_are_rejected(self) -> None:
        raw = _sharp().to_json_bytes()
        aliases = {
            "float_as_integer": raw.replace(b'"x":100.0', b'"x":100', 1),
            "extra_fraction_zero": raw.replace(b'"x":100.0', b'"x":100.00', 1),
            "exponent": raw.replace(b'"x":100.0', b'"x":1e2', 1),
            "integer_as_float": raw.replace(b'"frame_index":7', b'"frame_index":7.0', 1),
            "negative_zero": _sharp(center=PixelPoint(0.0, 120.0))
            .to_json_bytes()
            .replace(b'"x":0.0', b'"x":-0.0', 1),
        }
        expected = {
            "float_as_integer": "NONCANONICAL_CONTRACT",
            "extra_fraction_zero": "NONCANONICAL_JSON",
            "exponent": "NONCANONICAL_JSON",
            "integer_as_float": "ANNOTATION_SHAPE",
            "negative_zero": "NONCANONICAL_CONTRACT",
        }
        for name, mutated in aliases.items():
            with self.subTest(alias=name):
                self.assert_wire_code(
                    expected[name],
                    lambda mutated=mutated: BallFrameAnnotationV2.from_json_bytes(
                        mutated
                    ),
                )

    def test_nonfinite_numbers_and_signed64_overflow_are_rejected(self) -> None:
        raw = _sharp().to_json_bytes()
        for token in (b"NaN", b"Infinity", b"-Infinity", b"1e999"):
            mutated = raw.replace(b'"x":100.0', b'"x":' + token, 1)
            with self.subTest(token=token):
                self.assert_wire_code(
                    "NONFINITE_JSON_NUMBER",
                    lambda mutated=mutated: BallFrameAnnotationV2.from_json_bytes(
                        mutated
                    ),
                )
        overflow = raw.replace(
            b'"frame_index":7',
            b'"frame_index":9223372036854775808',
            1,
        )
        self.assert_wire_code(
            "JSON_INTEGER_RANGE",
            lambda: BallFrameAnnotationV2.from_json_bytes(overflow),
        )

    def test_unicode_is_exact_utf8_nfc_and_not_escape_aliases(self) -> None:
        annotation = _indistinguishable(reason="café 🏐")
        raw = annotation.to_json_bytes()
        self.assertIn("café 🏐".encode("utf-8"), raw)
        self.assertNotIn(b"\\u", raw)
        self.assertEqual(BallFrameAnnotationV2.from_json_bytes(raw), annotation)

        nfd = raw.replace("café".encode("utf-8"), "cafe\u0301".encode("utf-8"), 1)
        self.assert_wire_code(
            "ANNOTATION_SHAPE",
            lambda: BallFrameAnnotationV2.from_json_bytes(nfd),
        )
        escaped = raw.replace("é".encode("utf-8"), b"\\u00e9", 1)
        self.assert_wire_code(
            "NONCANONICAL_JSON",
            lambda: BallFrameAnnotationV2.from_json_bytes(escaped),
        )

    def test_unknown_fields_schema_enums_and_nested_types_fail_closed(self) -> None:
        cases = {
            "unknown_root": _canonical_mutation(
                _sharp(), lambda payload: payload.__setitem__("future", None)
            ),
            "unknown_nested": _canonical_mutation(
                _sharp(),
                lambda payload: payload["center"].__setitem__("z", 1.0),
            ),
            "schema": _canonical_mutation(
                _sharp(), lambda payload: payload.__setitem__("schema_version", "2.1")
            ),
            "nested_schema": _canonical_mutation(
                _sharp(),
                lambda payload: payload["frame"]["identity"]["decode_contract"].__setitem__(
                    "schema_version", "2.1"
                ),
            ),
            "enum": _canonical_mutation(
                _sharp(), lambda payload: payload.__setitem__("visibility", "SEEN")
            ),
            "bool_integer": _canonical_mutation(
                _sharp(),
                lambda payload: payload["frame"]["identity"].__setitem__(
                    "frame_index", True
                ),
            ),
        }
        for name, raw in cases.items():
            with self.subTest(case=name):
                self.assert_wire_code(
                    "ANNOTATION_SHAPE",
                    lambda raw=raw: BallFrameAnnotationV2.from_json_bytes(raw),
                )

    def test_unsorted_set_like_wire_arrays_are_noncanonical(self) -> None:
        reviewed = replace(
            _sharp(),
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-1", "reviewer-2"),
            review_evidence_refs=(ALT_EVIDENCE_A, REVIEW_EVIDENCE),
        )
        raw = _canonical_mutation(
            reviewed,
            lambda payload: (
                payload.__setitem__(
                    "reviewer_ids", list(reversed(payload["reviewer_ids"]))
                ),
                payload.__setitem__(
                    "review_evidence_refs",
                    list(reversed(payload["review_evidence_refs"])),
                ),
            ),
        )
        self.assert_wire_code(
            "NONCANONICAL_CONTRACT",
            lambda: BallFrameAnnotationV2.from_json_bytes(raw),
        )

    def test_duplicate_depth_node_container_and_size_limits_precede_construction(
        self,
    ) -> None:
        raw = _sharp().to_json_bytes()
        duplicate = raw.replace(
            b'"annotation_id":"ball-7"',
            b'"annotation_id":"ball-7","annotation_id":"ball-7"',
            1,
        )

        nested: object = 0
        for _ in range(12):
            nested = [nested]
        depth = canonical_finite_json_bytes({"x": nested}, label="depth test")
        nodes = canonical_finite_json_bytes(
            {"x": [0] * 4_095}, label="node test"
        )
        containers = canonical_finite_json_bytes(
            {"x": [[] for _ in range(512)]}, label="container test"
        )
        oversized = b"x" * (64 * 1024 + 1)
        cases = (
            ("DUPLICATE_JSON_KEY", duplicate),
            ("JSON_DEPTH_EXCEEDED", depth),
            ("JSON_NODE_LIMIT_EXCEEDED", nodes),
            ("JSON_CONTAINER_LIMIT_EXCEEDED", containers),
            ("JSON_SIZE", oversized),
        )
        for expected, candidate in cases:
            with self.subTest(expected=expected), patch(
                "vision_scoring.annotations._ball_frame_annotation_from_wire_dict"
            ) as constructor:
                self.assert_wire_code(
                    expected,
                    lambda candidate=candidate: BallFrameAnnotationV2.from_json_bytes(
                        candidate
                    ),
                )
                constructor.assert_not_called()

    def test_attestation_unknown_duplicate_and_bounds_fail_closed(self) -> None:
        attestation = _attestation(_sharp())
        raw = attestation.to_json_bytes()
        duplicate = raw.replace(
            b'"key_id":"review-key-1"',
            b'"key_id":"review-key-1","key_id":"review-key-1"',
            1,
        )
        self.assert_wire_code(
            "DUPLICATE_JSON_KEY",
            lambda: AnnotationAttestation.from_json_bytes(duplicate),
        )
        payload = json.loads(raw.decode("utf-8"))
        payload["future"] = None
        unknown = canonical_finite_json_bytes(payload, label="attestation mutation")
        self.assert_wire_code(
            "ATTESTATION_SHAPE",
            lambda: AnnotationAttestation.from_json_bytes(unknown),
        )
        self.assert_wire_code(
            "JSON_SIZE",
            lambda: AnnotationAttestation.from_json_bytes(b"x" * (4 * 1024 + 1)),
        )


if __name__ == "__main__":
    unittest.main()
