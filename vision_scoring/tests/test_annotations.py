from __future__ import annotations

import json
import unittest
from dataclasses import FrozenInstanceError

from vision_scoring.annotations import (
    AttributionState,
    AutorotationPolicy,
    BallFrameAnnotation,
    BallState,
    BlurEllipse,
    DecodedColorRange,
    DecodedColorSpace,
    DecodedFrameIdentity,
    DecodedFrameHashBasis,
    DecodedPixelFormat,
    EventType,
    FrameDecodeContract,
    FrameDuplicateKind,
    FrameReference,
    PixelCoordinateSpace,
    PixelPoint,
    PlayerAttributionRole,
    ReviewState,
    TeamAttributionRole,
    TemporalEventAnnotation,
    TimestampBasis,
)
from vision_scoring.contracts import Team


SHA = "a" * 64
EVIDENCE_A = "sha256:" + "a" * 64
EVIDENCE_B = "sha256:" + "b" * 64
EVIDENCE_C = "sha256:" + "c" * 64
EVIDENCE_D = "sha256:" + "d" * 64
TEAM_ATTRIBUTION_EVENTS = {
    EventType.SERVE_PREPARATION,
    EventType.SERVE_CONTACT,
    EventType.RALLY_END,
    EventType.CANDIDATE_CONTACT,
    EventType.NEXT_AUTHORIZED_SERVE,
    EventType.CHALLENGE,
    EventType.REPORTED_ADMINISTRATIVE_POINT,
    EventType.TERMINAL_POINT,
}
PLAYER_ATTRIBUTION_EVENTS = {
    EventType.SERVE_PREPARATION,
    EventType.SERVE_CONTACT,
    EventType.CANDIDATE_CONTACT,
    EventType.NEXT_AUTHORIZED_SERVE,
}


def _decode_contract(**overrides: object) -> FrameDecodeContract:
    values: dict[str, object] = {
        "decoder_artifact_sha256": "f" * 64,
        "decoder_build_id": "ffmpeg-8.1-arm64",
        "autorotation_policy": AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        "color_space": DecodedColorSpace.BT709,
        "color_range": DecodedColorRange.LIMITED,
        "output_pixel_format": DecodedPixelFormat.RGB24,
        "output_width": 1920,
        "output_height": 1080,
    }
    values.update(overrides)
    return FrameDecodeContract(**values)  # type: ignore[arg-type]


def _frame(**overrides: object) -> FrameReference:
    duplicate_values: dict[str, object] = {
        "duplicate_kind": overrides.pop("duplicate_kind", FrameDuplicateKind.NONE),
        "duplicate_of_frame_index": overrides.pop("duplicate_of_frame_index", None),
        "capture_integrity_attestation_refs": overrides.pop(
            "capture_integrity_attestation_refs",
            (),
        ),
    }
    width = overrides.pop("width", 1920)
    height = overrides.pop("height", 1080)
    decode_contract = overrides.pop("decode_contract", None)
    if decode_contract is None:
        decode_contract = _decode_contract(output_width=width, output_height=height)
    identity_values: dict[str, object] = {
        "source_sha256": SHA,
        "selected_video_stream_index": 0,
        "frame_index": 7,
        "timestamp_ns": 233_333_333,
        "timestamp_basis": TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        "pixel_coordinate_space": (
            PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
        ),
        "decode_contract": decode_contract,
        "decoded_frame_sha256": "d" * 64,
        "decoded_frame_hash_basis": (
            DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
        ),
    }
    identity_values.update(overrides)
    return FrameReference(
        identity=DecodedFrameIdentity(**identity_values),  # type: ignore[arg-type]
        **duplicate_values,  # type: ignore[arg-type]
    )


def _visible(**overrides: object) -> BallFrameAnnotation:
    values: dict[str, object] = {
        "annotation_id": "ball-7",
        "frame": _frame(),
        "state": BallState.VISIBLE,
        "center": PixelPoint(960, 540),
        "apparent_minor_axis_diameter_px": 12,
        "uncertainty_radius_px": 2,
        "track_segment_id": "track-3",
    }
    values.update(overrides)
    return BallFrameAnnotation(**values)  # type: ignore[arg-type]


def _event(**overrides: object) -> TemporalEventAnnotation:
    values: dict[str, object] = {
        "annotation_id": "event-1",
        "source_sha256": SHA,
        "event_type": EventType.SERVE_CONTACT,
        "interval_start_ns": 100,
        "interval_end_ns": 120,
        "timestamp_basis": TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        "evidence_refs": (EVIDENCE_A,),
        "team": Team.A,
        "player_id": "a1",
    }
    values.update(overrides)
    event_type = values["event_type"]
    if "team_attribution_state" not in overrides:
        values["team_attribution_state"] = (
            AttributionState.KNOWN
            if event_type in TEAM_ATTRIBUTION_EVENTS and isinstance(values.get("team"), Team)
            else AttributionState.UNKNOWN
            if event_type in TEAM_ATTRIBUTION_EVENTS
            else AttributionState.NOT_APPLICABLE
        )
    if "player_attribution_state" not in overrides:
        values["player_attribution_state"] = (
            AttributionState.KNOWN
            if event_type in PLAYER_ATTRIBUTION_EVENTS
            and isinstance(values.get("player_id"), str)
            else AttributionState.UNKNOWN
            if event_type in PLAYER_ATTRIBUTION_EVENTS
            else AttributionState.NOT_APPLICABLE
        )
    if (
        AttributionState.UNKNOWN
        in (
            values["team_attribution_state"],
            values["player_attribution_state"],
        )
        and "ambiguity_reason" not in overrides
    ):
        values["ambiguity_reason"] = "attribution unresolved"
    return TemporalEventAnnotation(**values)  # type: ignore[arg-type]


class AnnotationContractTests(unittest.TestCase):
    def test_contract_bounds_accept_boundaries_and_reject_amplification(self) -> None:
        max_id = "a" * 128
        self.assertEqual(_visible(annotation_id=max_id).annotation_id, max_id)
        with self.assertRaisesRegex(ValueError, "ASCII-stable"):
            _visible(annotation_id="a" * 129)

        max_text = "a" * 2_048
        self.assertEqual(
            _visible(ambiguity_reason=max_text).ambiguity_reason,
            max_text,
        )
        with self.assertRaisesRegex(ValueError, "2048 UTF-8 bytes"):
            _visible(ambiguity_reason="a" * 2_049)

        reviewers = tuple(f"reviewer-{index}" for index in range(16))
        reviewed = _visible(
            review_state=ReviewState.REVIEWED,
            reviewer_ids=reviewers,
            review_evidence_refs=(EVIDENCE_A,),
        )
        self.assertEqual(len(reviewed.reviewer_ids), 16)
        with self.assertRaisesRegex(ValueError, "reviewer_ids cannot exceed 16"):
            _visible(
                review_state=ReviewState.REVIEWED,
                reviewer_ids=reviewers + ("reviewer-over",),
                review_evidence_refs=(EVIDENCE_A,),
            )

        evidence_refs = tuple(
            "sha256:" + f"{index:064x}" for index in range(64)
        )
        bounded_evidence = _visible(
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=evidence_refs,
        )
        self.assertEqual(len(bounded_evidence.review_evidence_refs), 64)
        with self.assertRaisesRegex(ValueError, "cannot exceed 64"):
            _visible(
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=evidence_refs
                + ("sha256:" + f"{64:064x}",),
            )

        capture_refs = tuple(
            "sha256:" + f"{index + 100:064x}" for index in range(16)
        )
        duplicate = _frame(
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=3,
            capture_integrity_attestation_refs=capture_refs,
        )
        self.assertEqual(len(duplicate.capture_integrity_attestation_refs), 16)
        with self.assertRaisesRegex(ValueError, "cannot exceed 16"):
            _frame(
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=3,
                capture_integrity_attestation_refs=capture_refs
                + ("sha256:" + f"{999:064x}",),
            )

        event = _event(evidence_refs=evidence_refs)
        self.assertEqual(len(event.evidence_refs), 64)
        with self.assertRaisesRegex(ValueError, "cannot exceed 64"):
            _event(
                evidence_refs=evidence_refs
                + ("sha256:" + f"{64:064x}",)
            )

        self.assertEqual(
            _frame(frame_index=(1 << 63) - 1).frame_index,
            (1 << 63) - 1,
        )
        with self.assertRaisesRegex(ValueError, "frame_index"):
            _frame(frame_index=1 << 63)
        with self.assertRaisesRegex(ValueError, "no greater than 65536"):
            _decode_contract(output_width=65_537)

    def test_frame_reference_is_strict_and_immutable(self) -> None:
        frame = _frame(
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=3,
            capture_integrity_attestation_refs=(EVIDENCE_D,),
        )
        self.assertEqual(frame.frame_index, 7)
        self.assertIs(
            frame.timestamp_basis,
            TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        )
        self.assertIs(
            frame.pixel_coordinate_space,
            PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN,
        )
        self.assertEqual(frame.decoded_frame_sha256, "d" * 64)
        self.assertIs(
            frame.decoded_frame_hash_basis,
            DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING,
        )
        self.assertEqual(frame.duplicate_of_frame_index, 3)
        self.assertTrue(frame.is_excludable_capture_duplicate)
        self.assertEqual(frame.selected_video_stream_index, 0)
        self.assertEqual(frame.decode_contract.decoder_build_id, "ffmpeg-8.1-arm64")
        self.assertFalse(hasattr(frame, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            frame.identity = _frame(width=1280).identity  # type: ignore[misc]

        invalid = (
            {"source_sha256": "A" * 64},
            {"frame_index": True},
            {"timestamp_ns": False},
            {"width": 0},
            {"height": 1.5},
            {"decoded_frame_sha256": "D" * 64},
            {"decoded_frame_hash_basis": "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"},
            {"selected_video_stream_index": True},
            {"duplicate_kind": "PIXEL_EQUIVALENT"},
            {
                "duplicate_kind": FrameDuplicateKind.PIXEL_EQUIVALENT,
                "duplicate_of_frame_index": True,
            },
            {
                "duplicate_kind": FrameDuplicateKind.PIXEL_EQUIVALENT,
                "duplicate_of_frame_index": -1,
            },
            {
                "duplicate_kind": FrameDuplicateKind.PIXEL_EQUIVALENT,
                "duplicate_of_frame_index": 7,
            },
            {
                "duplicate_kind": FrameDuplicateKind.PIXEL_EQUIVALENT,
                "duplicate_of_frame_index": 8,
            },
            {
                "duplicate_kind": FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                "duplicate_of_frame_index": 3,
            },
            {
                "duplicate_kind": FrameDuplicateKind.PIXEL_EQUIVALENT,
                "duplicate_of_frame_index": 3,
                "capture_integrity_attestation_refs": (EVIDENCE_D,),
            },
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                _frame(**overrides)

    def test_pixel_geometry_rejects_bool_nonfinite_and_out_of_bounds(self) -> None:
        for x, y in ((True, 1), (float("nan"), 1), (1, float("inf"))):
            with self.subTest(x=x, y=y), self.assertRaisesRegex(ValueError, "finite number"):
                PixelPoint(x, y)

        for center in (PixelPoint(-0.1, 1), PixelPoint(1920, 1), PixelPoint(1, 1080)):
            with self.subTest(center=center), self.assertRaisesRegex(ValueError, "pixel bounds"):
                _visible(center=center)

    def test_independently_fingerprintable_payloads_carry_schema_version(self) -> None:
        point = PixelPoint(12, 34)
        ellipse = BlurEllipse(12, 3, 45)
        frame = _frame()
        identity = frame.identity
        decode_contract = identity.decode_contract

        for contract in (point, ellipse, decode_contract, identity, frame):
            with self.subTest(contract=type(contract).__name__):
                payload = json.loads(contract.canonical_json())
                self.assertEqual(payload["schema_version"], "1.0")
                self.assertEqual(len(contract.fingerprint()), 64)

        self.assertNotEqual(point.fingerprint(), PixelPoint(13, 34).fingerprint())
        self.assertNotEqual(ellipse.fingerprint(), BlurEllipse(12, 3, 46).fingerprint())
        self.assertNotEqual(frame.fingerprint(), _frame(frame_index=8).fingerprint())
        frame_payload = frame.to_canonical_dict()
        self.assertEqual(
            frame_payload["identity"]["pixel_coordinate_space"],
            "SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN",
        )
        self.assertEqual(
            frame_payload["identity"]["timestamp_basis"],
            "SOURCE_PRESENTATION_OFFSET_NS",
        )
        self.assertEqual(
            frame_payload["identity"]["decoded_frame_hash_basis"],
            "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING",
        )
        self.assertEqual(frame_payload["identity"]["decoded_frame_sha256"], "d" * 64)
        self.assertIsNone(frame_payload["duplicate_of_frame_index"])
        self.assertEqual(
            frame_payload["identity"]["decode_contract"]["decoder_artifact_sha256"],
            "f" * 64,
        )

    def test_visible_requires_center_apparent_size_and_track(self) -> None:
        annotation = _visible()
        self.assertEqual(annotation.center, PixelPoint(960.0, 540.0))
        self.assertEqual(annotation.apparent_minor_axis_diameter_px, 12.0)
        self.assertEqual(annotation.uncertainty_radius_px, 2.0)

        with self.assertRaisesRegex(ValueError, "exact center"):
            _visible(center=None)
        with self.assertRaisesRegex(ValueError, "apparent_minor_axis_diameter_px"):
            _visible(apparent_minor_axis_diameter_px=None)
        with self.assertRaisesRegex(ValueError, "finite number"):
            _visible(apparent_minor_axis_diameter_px=True)
        with self.assertRaisesRegex(ValueError, "positive and fit"):
            _visible(apparent_minor_axis_diameter_px=1081)
        with self.assertRaisesRegex(ValueError, "blur geometry"):
            _visible(blur_start=PixelPoint(950, 540), blur_end=PixelPoint(970, 540))
        with self.assertRaisesRegex(ValueError, "track_segment_id"):
            _visible(track_segment_id=None)
        with self.assertRaisesRegex(ValueError, "finite number"):
            _visible(uncertainty_radius_px=True)

    def test_blur_accepts_exactly_endpoints_or_ellipse(self) -> None:
        endpoints = BallFrameAnnotation(
            annotation_id="blur-1",
            frame=_frame(),
            state=BallState.BLUR,
            center=PixelPoint(100, 100),
            blur_start=PixelPoint(90, 100),
            blur_end=PixelPoint(110, 100),
            apparent_minor_axis_diameter_px=6,
            track_segment_id="track-1",
        )
        ellipse = BallFrameAnnotation(
            annotation_id="blur-2",
            frame=_frame(),
            state=BallState.BLUR,
            center=PixelPoint(100, 100),
            blur_ellipse=BlurEllipse(12, 3, 45),
            apparent_minor_axis_diameter_px=6,
            track_segment_id="track-1",
        )
        self.assertIsNone(endpoints.blur_ellipse)
        self.assertIsNotNone(ellipse.blur_ellipse)

    def test_blur_rejects_incomplete_or_contradictory_geometry(self) -> None:
        base = {
            "annotation_id": "blur-1",
            "frame": _frame(),
            "state": BallState.BLUR,
            "center": PixelPoint(100, 100),
            "apparent_minor_axis_diameter_px": 6,
            "track_segment_id": "track-1",
        }
        invalid = (
            ({}, "exactly one geometry representation"),
            ({"blur_start": PixelPoint(90, 100)}, "provided together"),
            (
                {
                    "blur_start": PixelPoint(90, 100),
                    "blur_end": PixelPoint(110, 100),
                    "blur_ellipse": BlurEllipse(12, 3, 0),
                },
                "exactly one geometry representation",
            ),
            (
                {"blur_start": PixelPoint(90, 100), "blur_end": PixelPoint(120, 100)},
                "endpoint midpoint",
            ),
            (
                {"blur_start": PixelPoint(100, 100), "blur_end": PixelPoint(100, 100)},
                "distinct",
            ),
            ({"blur_ellipse": BlurEllipse(20, 3, 0), "center": PixelPoint(5, 5)}, "pixel bounds"),
        )
        for overrides, message in invalid:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, message):
                BallFrameAnnotation(**{**base, **overrides})

        with self.assertRaisesRegex(ValueError, "major_radius"):
            BlurEllipse(2, 3, 0)
        with self.assertRaisesRegex(ValueError, r"\[0, 180\)"):
            BlurEllipse(3, 2, 180)

    def test_blur_apparent_minor_axis_must_match_geometry(self) -> None:
        center = PixelPoint(100, 100)
        with self.assertRaisesRegex(ValueError, "major-axis length"):
            BallFrameAnnotation(
                annotation_id="blur-endpoint-mismatch",
                frame=_frame(),
                state=BallState.BLUR,
                center=center,
                blur_start=PixelPoint(95, 100),
                blur_end=PixelPoint(105, 100),
                apparent_minor_axis_diameter_px=10.000002,
                track_segment_id="track-1",
            )
        with self.assertRaisesRegex(ValueError, "twice.*minor radius"):
            BallFrameAnnotation(
                annotation_id="blur-ellipse-mismatch",
                frame=_frame(),
                state=BallState.BLUR,
                center=center,
                blur_ellipse=BlurEllipse(8, 3, 0),
                apparent_minor_axis_diameter_px=6.000002,
                track_segment_id="track-1",
            )

        endpoint_blur = BallFrameAnnotation(
            annotation_id="blur-endpoint-tolerance",
            frame=_frame(),
            state=BallState.BLUR,
            center=center,
            blur_start=PixelPoint(95, 100),
            blur_end=PixelPoint(105, 100),
            apparent_minor_axis_diameter_px=10.0000005,
            track_segment_id="track-1",
        )
        ellipse_blur = BallFrameAnnotation(
            annotation_id="blur-ellipse-tolerance",
            frame=_frame(),
            state=BallState.BLUR,
            center=center,
            blur_ellipse=BlurEllipse(8, 3, 0),
            apparent_minor_axis_diameter_px=6.0000005,
            track_segment_id="track-1",
        )
        self.assertEqual(endpoint_blur.state, BallState.BLUR)
        self.assertEqual(ellipse_blur.state, BallState.BLUR)

    def test_non_visible_states_forbid_invented_geometry(self) -> None:
        for state in (BallState.OCCLUDED, BallState.OUT_OF_FRAME):
            annotation = BallFrameAnnotation(
                annotation_id=f"ball-{state.value}",
                frame=_frame(),
                state=state,
                track_segment_id="track-1",
                ambiguity_reason="trajectory supports this state",
            )
            self.assertIsNone(annotation.center)
            with self.assertRaisesRegex(ValueError, "invented exact geometry"):
                BallFrameAnnotation(
                    annotation_id="bad",
                    frame=_frame(),
                    state=state,
                    center=PixelPoint(100, 100),
                    track_segment_id="track-1",
                )

        absent = BallFrameAnnotation(
            annotation_id="absent",
            frame=_frame(),
            state=BallState.ABSENT,
        )
        self.assertIsNone(absent.track_segment_id)
        with self.assertRaisesRegex(ValueError, "ABSENT cannot belong"):
            BallFrameAnnotation(
                annotation_id="bad-absent",
                frame=_frame(),
                state=BallState.ABSENT,
                track_segment_id="track-1",
            )

    def test_raw_enum_strings_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "BallState"):
            _visible(state="VISIBLE")
        with self.assertRaisesRegex(ValueError, "ReviewState"):
            _visible(review_state="DRAFT")
        with self.assertRaisesRegex(ValueError, "EventType"):
            _event(event_type="SERVE_CONTACT")
        with self.assertRaisesRegex(ValueError, "TimestampBasis"):
            _frame(timestamp_basis="SOURCE_PRESENTATION_OFFSET_NS")
        with self.assertRaisesRegex(ValueError, "PixelCoordinateSpace"):
            _frame(
                pixel_coordinate_space=(
                    "SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN"
                )
            )
        with self.assertRaisesRegex(ValueError, "DecodedFrameHashBasis"):
            _frame(
                decoded_frame_hash_basis=(
                    "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
                )
            )
        with self.assertRaisesRegex(ValueError, "AutorotationPolicy"):
            _decode_contract(autorotation_policy="IGNORE_CONTAINER_DISPLAY_TRANSFORM")
        with self.assertRaisesRegex(ValueError, "DecodedColorSpace"):
            _decode_contract(color_space="BT709")
        with self.assertRaisesRegex(ValueError, "DecodedColorRange"):
            _decode_contract(color_range="LIMITED")
        with self.assertRaisesRegex(ValueError, "DecodedPixelFormat"):
            _decode_contract(output_pixel_format="RGB24")
        with self.assertRaisesRegex(ValueError, "TimestampBasis"):
            _event(timestamp_basis="SOURCE_PRESENTATION_OFFSET_NS")
        with self.assertRaisesRegex(ValueError, "team must be a Team"):
            _event(team="A", player_id=None)
        with self.assertRaisesRegex(ValueError, "AttributionState"):
            _event(team_attribution_state="KNOWN")

    def test_review_states_require_consistent_people_and_evidence(self) -> None:
        with self.assertRaisesRegex(ValueError, "DRAFT cannot claim"):
            _visible(reviewer_ids=("reviewer-1",))
        with self.assertRaisesRegex(ValueError, "reviewer IDs and review evidence"):
            _visible(review_state=ReviewState.REVIEWED, reviewer_ids=("reviewer-1",))

        reviewed = _visible(
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(EVIDENCE_A,),
        )
        self.assertEqual(reviewed.review_state, ReviewState.REVIEWED)

        with self.assertRaisesRegex(ValueError, "requires an adjudicator"):
            _visible(
                review_state=ReviewState.ADJUDICATED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "independent"):
            _visible(
                review_state=ReviewState.ADJUDICATED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
                adjudicator_id="reviewer-1",
                adjudication_evidence_refs=(EVIDENCE_B,),
            )

        adjudicated = _visible(
            review_state=ReviewState.ADJUDICATED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(EVIDENCE_A,),
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(EVIDENCE_B,),
        )
        self.assertEqual(adjudicated.adjudicator_id, "adjudicator-1")

    def test_every_evidence_reference_is_an_exact_sha256_content_address(self) -> None:
        invalid_refs = (
            "decision:1",
            "a" * 64,
            "sha256:" + "A" * 64,
            "sha256:" + "a" * 63,
            "sha512:" + "a" * 64,
        )
        for invalid_ref in invalid_refs:
            with self.subTest(field="event evidence", invalid_ref=invalid_ref):
                with self.assertRaisesRegex(ValueError, "exact sha256"):
                    _event(evidence_refs=(invalid_ref,))
            with self.subTest(field="ball review evidence", invalid_ref=invalid_ref):
                with self.assertRaisesRegex(ValueError, "exact sha256"):
                    _visible(
                        review_state=ReviewState.REVIEWED,
                        reviewer_ids=("reviewer-1",),
                        review_evidence_refs=(invalid_ref,),
                    )
            with self.subTest(field="ball adjudication evidence", invalid_ref=invalid_ref):
                with self.assertRaisesRegex(ValueError, "exact sha256"):
                    _visible(
                        review_state=ReviewState.ADJUDICATED,
                        reviewer_ids=("reviewer-1",),
                        review_evidence_refs=(EVIDENCE_A,),
                        adjudicator_id="adjudicator-1",
                        adjudication_evidence_refs=(invalid_ref,),
                    )
            with self.subTest(field="event review evidence", invalid_ref=invalid_ref):
                with self.assertRaisesRegex(ValueError, "exact sha256"):
                    _event(
                        review_state=ReviewState.REVIEWED,
                        reviewer_ids=("reviewer-1",),
                        review_evidence_refs=(invalid_ref,),
                    )
            with self.subTest(field="event adjudication evidence", invalid_ref=invalid_ref):
                with self.assertRaisesRegex(ValueError, "exact sha256"):
                    _event(
                        review_state=ReviewState.ADJUDICATED,
                        reviewer_ids=("reviewer-1",),
                        review_evidence_refs=(EVIDENCE_A,),
                        adjudicator_id="adjudicator-1",
                        adjudication_evidence_refs=(invalid_ref,),
                    )

        with self.assertRaisesRegex(ValueError, "tuple"):
            _event(evidence_refs=[EVIDENCE_A])
        with self.assertRaisesRegex(ValueError, "duplicates"):
            _event(evidence_refs=(EVIDENCE_A, EVIDENCE_A))
        with self.assertRaisesRegex(ValueError, "ASCII-stable"):
            _visible(
                review_state=ReviewState.REVIEWED,
                reviewer_ids=(" reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )

    def test_ids_are_ascii_stable_and_free_text_is_valid_utf8_nfc(self) -> None:
        invalid_ids = (
            {"annotation_id": "báll-7"},
            {"track_segment_id": "track-α"},
            {
                "review_state": ReviewState.REVIEWED,
                "reviewer_ids": ("réviewer-1",),
                "review_evidence_refs": (EVIDENCE_A,),
            },
        )
        for overrides in invalid_ids:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(
                ValueError,
                "ASCII-stable",
            ):
                _visible(**overrides)
        with self.assertRaisesRegex(ValueError, "ASCII-stable"):
            _event(player_id="pláyer")

        with self.assertRaisesRegex(ValueError, "valid UTF-8"):
            _visible(ambiguity_reason="bad\ud800text")
        with self.assertRaisesRegex(ValueError, "NFC"):
            _visible(ambiguity_reason="Cafe\u0301")
        accepted = _visible(ambiguity_reason="Café")
        self.assertEqual(accepted.ambiguity_reason, "Café")

    def test_fingerprint_is_stable_normalized_and_content_sensitive(self) -> None:
        first = _visible(
            review_state=ReviewState.ADJUDICATED,
            reviewer_ids=("reviewer-2", "reviewer-1"),
            review_evidence_refs=(EVIDENCE_B, EVIDENCE_A),
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(EVIDENCE_D, EVIDENCE_C),
        )
        reordered = _visible(
            review_state=ReviewState.ADJUDICATED,
            reviewer_ids=("reviewer-1", "reviewer-2"),
            review_evidence_refs=(EVIDENCE_A, EVIDENCE_B),
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(EVIDENCE_C, EVIDENCE_D),
        )
        changed = _visible(center=PixelPoint(961, 540))

        self.assertEqual(first.fingerprint(), reordered.fingerprint())
        self.assertNotEqual(first.fingerprint(), changed.fingerprint())
        self.assertEqual(len(first.fingerprint()), 64)
        payload = json.loads(first.canonical_json())
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertEqual(
            payload["center"],
            {"schema_version": "1.0", "x": 960.0, "y": 540.0},
        )

    def test_ball_annotation_is_immutable(self) -> None:
        annotation = _visible()
        self.assertFalse(hasattr(annotation, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            annotation.state = BallState.ABSENT  # type: ignore[misc]

    def test_temporal_interval_is_inclusive_and_may_be_exact(self) -> None:
        exact = _event(interval_start_ns=100, interval_end_ns=100)
        uncertain = _event(interval_start_ns=100, interval_end_ns=140)
        self.assertEqual(exact.interval_start_ns, exact.interval_end_ns)
        self.assertIs(
            exact.timestamp_basis,
            TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        )
        self.assertEqual(uncertain.interval_end_ns - uncertain.interval_start_ns, 40)
        with self.assertRaisesRegex(ValueError, "inverted"):
            _event(interval_start_ns=101, interval_end_ns=100)
        with self.assertRaisesRegex(ValueError, "integers"):
            _event(interval_start_ns=True)
        with self.assertRaisesRegex(ValueError, "evidence_refs cannot be empty"):
            _event(evidence_refs=())

    def test_temporal_attribution_is_event_specific(self) -> None:
        serve = _event()
        self.assertEqual(serve.player_id, "a1")
        self.assertEqual(serve.team_role, TeamAttributionRole.SERVING_TEAM)
        self.assertEqual(serve.player_role, PlayerAttributionRole.SERVING_PLAYER)
        team_only = _event(
            event_type=EventType.REPORTED_ADMINISTRATIVE_POINT,
            team=Team.B,
            player_id=None,
        )
        self.assertEqual(team_only.team, Team.B)
        self.assertEqual(team_only.team_role, TeamAttributionRole.POINT_AWARDED_TEAM)
        self.assertIsNone(team_only.player_role)

        with self.assertRaisesRegex(ValueError, "does not allow team attribution"):
            _event(event_type=EventType.SET_START, team=Team.A, player_id=None)
        with self.assertRaisesRegex(ValueError, "does not allow player attribution"):
            _event(
                event_type=EventType.REPORTED_ADMINISTRATIVE_POINT,
                team=Team.A,
                player_id="a1",
            )
        with self.assertRaisesRegex(ValueError, "requires known team attribution"):
            _event(team=None, player_id="a1")

    def test_every_allowed_attribution_has_an_exact_role(self) -> None:
        team_roles = {
            EventType.SERVE_PREPARATION: TeamAttributionRole.SERVING_TEAM,
            EventType.SERVE_CONTACT: TeamAttributionRole.SERVING_TEAM,
            EventType.RALLY_END: TeamAttributionRole.RALLY_WINNER,
            EventType.CANDIDATE_CONTACT: TeamAttributionRole.CONTACT_TEAM,
            EventType.NEXT_AUTHORIZED_SERVE: TeamAttributionRole.SERVING_TEAM,
            EventType.CHALLENGE: TeamAttributionRole.CHALLENGING_TEAM,
            EventType.REPORTED_ADMINISTRATIVE_POINT: TeamAttributionRole.POINT_AWARDED_TEAM,
            EventType.TERMINAL_POINT: TeamAttributionRole.POINT_AWARDED_TEAM,
        }
        player_roles = {
            EventType.SERVE_PREPARATION: PlayerAttributionRole.SERVING_PLAYER,
            EventType.SERVE_CONTACT: PlayerAttributionRole.SERVING_PLAYER,
            EventType.CANDIDATE_CONTACT: PlayerAttributionRole.CONTACTING_PLAYER,
            EventType.NEXT_AUTHORIZED_SERVE: PlayerAttributionRole.SERVING_PLAYER,
        }
        for event_type, expected_team_role in team_roles.items():
            player_id = "a1" if event_type in player_roles else None
            annotation = _event(event_type=event_type, player_id=player_id)
            with self.subTest(event_type=event_type):
                self.assertEqual(annotation.team_role, expected_team_role)
                self.assertEqual(annotation.player_role, player_roles.get(event_type))
                payload = annotation.to_canonical_dict()
                self.assertEqual(payload["team_role"], expected_team_role.value)
                self.assertEqual(
                    payload["player_role"],
                    player_roles[event_type].value if event_type in player_roles else None,
                )

        unattributed = _event(team=None, player_id=None)
        self.assertIs(
            unattributed.team_attribution_state,
            AttributionState.UNKNOWN,
        )
        self.assertIs(
            unattributed.player_attribution_state,
            AttributionState.UNKNOWN,
        )
        self.assertIs(unattributed.team_role, TeamAttributionRole.SERVING_TEAM)
        self.assertIs(unattributed.player_role, PlayerAttributionRole.SERVING_PLAYER)
        self.assertEqual(unattributed.ambiguity_reason, "attribution unresolved")

        with self.assertRaisesRegex(ValueError, "ambiguity_reason"):
            _event(
                team=None,
                player_id=None,
                ambiguity_reason=None,
            )
        with self.assertRaisesRegex(ValueError, "requires a team"):
            _event(
                team=None,
                player_id=None,
                team_attribution_state=AttributionState.KNOWN,
                player_attribution_state=AttributionState.UNKNOWN,
                ambiguity_reason="team unresolved",
            )

    def test_temporal_review_and_fingerprint_are_strict(self) -> None:
        adjudicated = _event(
            review_state=ReviewState.ADJUDICATED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(EVIDENCE_A,),
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(EVIDENCE_B,),
        )
        same = _event(
            review_state=ReviewState.ADJUDICATED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(EVIDENCE_A,),
            adjudicator_id="adjudicator-1",
            adjudication_evidence_refs=(EVIDENCE_B,),
        )
        changed = _event(interval_end_ns=121)
        self.assertEqual(adjudicated.fingerprint(), same.fingerprint())
        self.assertNotEqual(adjudicated.fingerprint(), changed.fingerprint())
        self.assertFalse(hasattr(adjudicated, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            adjudicated.interval_end_ns = 999  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
