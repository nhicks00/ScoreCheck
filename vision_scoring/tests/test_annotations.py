from __future__ import annotations

import json
import unittest
from dataclasses import FrozenInstanceError

import vision_scoring.annotations as annotations_module
from vision_scoring.annotations import (
    AnnotationType,
    AttributionState,
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
    ObservedTemporalEventAnnotation,
    ObservedTemporalEventType,
    PixelRegion,
    PhysicalEventAdjudication,
    PhysicalEventType,
    PhysicalLandingRegion,
    PixelCoordinateSpace,
    PixelPoint,
    ReportedOfficialEventAnnotation,
    ReportedOfficialEventType,
    ReviewState,
    SearchRegionObservabilityAttestation,
    SearchRegionScope,
    SearchRegionVisibility,
    TeamAttributionRole,
    TimestampBasis,
    TruthLayer,
    UnavailableFrameReference,
)
from vision_scoring.domain_events import Team


SHA = "a" * 64
ONTOLOGY = "b" * 64
RULESET = "c" * 64
EVIDENCE_A = "sha256:" + "a" * 64
EVIDENCE_B = "sha256:" + "b" * 64
EVIDENCE_C = "sha256:" + "c" * 64
EVIDENCE_D = "sha256:" + "d" * 64


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
    duplicate_values = {
        "duplicate_kind": overrides.pop("duplicate_kind", FrameDuplicateKind.NONE),
        "duplicate_of_frame_index": overrides.pop("duplicate_of_frame_index", None),
        "capture_integrity_attestation_refs": overrides.pop(
            "capture_integrity_attestation_refs", ()
        ),
    }
    width = overrides.pop("width", 1920)
    height = overrides.pop("height", 1080)
    decode_contract = overrides.pop(
        "decode_contract",
        _decode_contract(output_width=width, output_height=height),
    )
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


def _ball(**overrides: object) -> BallFrameAnnotationV2:
    values: dict[str, object] = {
        "annotation_id": "ball-7",
        "ontology_sha256": ONTOLOGY,
        "ball_instance_id": "match-ball",
        "frame": _frame(),
        "visibility": BallVisibility.VISIBLE,
        "appearance": BallAppearance.SHARP,
        "role": BallRole.MATCH_BALL,
        "play_state": BallPlayState.IN_PLAY,
        "center": PixelPoint(960, 540),
        "apparent_minor_axis_diameter_px": 12,
        "uncertainty_radius_px": 2,
        "track_segment_id": "track-3",
    }
    values.update(overrides)
    return BallFrameAnnotationV2(**values)  # type: ignore[arg-type]


def _unavailable_frame(**overrides: object) -> UnavailableFrameReference:
    values: dict[str, object] = {
        "source_sha256": SHA,
        "selected_video_stream_index": 0,
        "frame_index": 7,
        "expected_interval_start_ns": 230_000_000,
        "expected_interval_end_ns": 240_000_000,
        "timestamp_basis": TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        "capture_segment_ref": EVIDENCE_C,
        "unavailability_reason": CaptureUnavailabilityReason.PRESENTATION_GAP,
        "capture_integrity_attestation_refs": (EVIDENCE_D,),
        "gap_evidence_refs": (EVIDENCE_B,),
    }
    values.update(overrides)
    return UnavailableFrameReference(**values)  # type: ignore[arg-type]


def _search_attestation(
    frame: FrameReference,
    *,
    reviewer_ids: tuple[str, ...] = ("reviewer-1",),
    review_evidence_refs: tuple[str, ...] = (EVIDENCE_A,),
    **overrides: object,
) -> SearchRegionObservabilityAttestation:
    values: dict[str, object] = {
        "source_sha256": frame.source_sha256,
        "selected_video_stream_index": frame.selected_video_stream_index,
        "frame_index": frame.frame_index,
        "decoded_frame_sha256": frame.decoded_frame_sha256,
        "frame_identity_sha256": frame.identity.fingerprint(),
        "target_role": BallRole.MATCH_BALL,
        "region_scope": SearchRegionScope.FULL_DECODED_FRAME,
        "searched_region": PixelRegion(0, 0, frame.width - 1, frame.height - 1),
        "region_visibility": SearchRegionVisibility.FULLY_OBSERVABLE,
        "capture_integrity_attestation_refs": (EVIDENCE_D,),
        "reviewer_ids": reviewer_ids,
        "review_evidence_refs": review_evidence_refs,
    }
    values.update(overrides)
    return SearchRegionObservabilityAttestation(**values)  # type: ignore[arg-type]


def _observed(**overrides: object) -> ObservedTemporalEventAnnotation:
    values: dict[str, object] = {
        "annotation_id": "observed-1",
        "source_sha256": SHA,
        "ontology_sha256": ONTOLOGY,
        "event_type": ObservedTemporalEventType.SERVE_CONTACT,
        "interval_start_ns": 100,
        "interval_end_ns": 120,
        "timestamp_basis": TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        "evidence_refs": (EVIDENCE_A,),
        "team_attribution_state": AttributionState.KNOWN,
        "player_attribution_state": AttributionState.KNOWN,
        "team": Team.A,
        "player_id": "a1",
    }
    values.update(overrides)
    return ObservedTemporalEventAnnotation(**values)  # type: ignore[arg-type]


def _physical(**overrides: object) -> PhysicalEventAdjudication:
    values: dict[str, object] = {
        "annotation_id": "physical-1",
        "source_sha256": SHA,
        "ontology_sha256": ONTOLOGY,
        "event_type": PhysicalEventType.ORDINARY_RALLY_WINNER,
        "interval_start_ns": 100,
        "interval_end_ns": 140,
        "timestamp_basis": TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        "observational_annotations": (
            _observed(annotation_id="observed-1"),
            _observed(annotation_id="observed-2"),
        ),
        "team_attribution_state": AttributionState.KNOWN,
        "player_attribution_state": AttributionState.NOT_APPLICABLE,
        "team": Team.A,
        "review_state": ReviewState.ADJUDICATED,
        "reviewer_ids": ("reviewer-1",),
        "review_evidence_refs": (EVIDENCE_A,),
        "adjudicator_id": "adjudicator-1",
        "adjudication_evidence_refs": (EVIDENCE_B,),
    }
    values.update(overrides)
    return PhysicalEventAdjudication(**values)  # type: ignore[arg-type]


def _official(**overrides: object) -> ReportedOfficialEventAnnotation:
    values: dict[str, object] = {
        "annotation_id": "official-1",
        "match_id": "match-1",
        "ontology_sha256": ONTOLOGY,
        "ruleset_sha256": RULESET,
        "event_type": ReportedOfficialEventType.ORDINARY_POINT,
        "reported_source_label": "venue scoresheet",
        "reported_authority_label": "first referee",
        "reported_record_ref": EVIDENCE_A,
        "source_match_revision": 9,
        "evidence_refs": (EVIDENCE_A,),
        "team_attribution_state": AttributionState.KNOWN,
        "team": Team.A,
        "review_state": ReviewState.REVIEWED,
        "reviewer_ids": ("reviewer-1",),
        "review_evidence_refs": (EVIDENCE_B,),
    }
    values.update(overrides)
    return ReportedOfficialEventAnnotation(**values)  # type: ignore[arg-type]


class BallAnnotationV2Tests(unittest.TestCase):
    def test_hard_cut_removes_ambiguous_v1_surface(self) -> None:
        self.assertFalse(hasattr(annotations_module, "BallState"))
        self.assertFalse(hasattr(annotations_module, "EventType"))
        self.assertFalse(hasattr(annotations_module, "BallFrameAnnotation"))
        self.assertFalse(hasattr(annotations_module, "TemporalEventAnnotation"))
        self.assertFalse(hasattr(annotations_module, "OfficialEventAnnotation"))
        self.assertFalse(hasattr(annotations_module, "OfficialEventType"))
        self.assertNotIn("NOT_APPLICABLE", {role.value for role in BallRole})
        payload = _ball().to_canonical_dict()
        self.assertEqual(payload["schema_version"], "2.0")
        self.assertEqual(payload["annotation_type"], "BALL_FRAME_OBSERVATION")
        self.assertEqual(payload["truth_layer"], "OBSERVATIONAL")
        self.assertNotIn("state", payload)

    def test_visible_and_partial_are_localizable_with_independent_roles(self) -> None:
        visible = _ball()
        partial = _ball(
            annotation_id="partial",
            visibility=BallVisibility.PARTIALLY_OCCLUDED,
            role=BallRole.ADJACENT_COURT_BALL,
            play_state=BallPlayState.NOT_IN_PLAY,
        )
        for annotation in (visible, partial):
            self.assertTrue(annotation.is_localizable_observation)
            self.assertFalse(
                annotation.confident_negative_claim_structurally_complete
            )
            self.assertIsNotNone(annotation.center)
        self.assertIs(partial.role, BallRole.ADJACENT_COURT_BALL)

    def test_localizable_truth_requires_real_geometry_track_and_appearance(self) -> None:
        invalid = (
            ({"center": None}, "observed center"),
            ({"apparent_minor_axis_diameter_px": None}, "apparent_minor"),
            ({"track_segment_id": None}, "track_segment_id"),
            ({"appearance": BallAppearance.NOT_OBSERVABLE}, "observable appearance"),
            ({"visibility": "VISIBLE"}, "BallVisibility"),
            ({"appearance": "SHARP"}, "BallAppearance"),
            ({"role": "MATCH_BALL"}, "BallRole"),
            ({"play_state": "IN_PLAY"}, "BallPlayState"),
        )
        for overrides, message in invalid:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(
                ValueError, message
            ):
                _ball(**overrides)

    def test_sharp_and_motion_blur_are_appearance_not_visibility(self) -> None:
        sharp = _ball()
        blurred = _ball(
            annotation_id="blurred",
            appearance=BallAppearance.MOTION_BLURRED,
            center=PixelPoint(100, 100),
            blur_start=PixelPoint(90, 100),
            blur_end=PixelPoint(110, 100),
            apparent_minor_axis_diameter_px=6,
        )
        ellipse = _ball(
            annotation_id="blurred-ellipse",
            appearance=BallAppearance.MOTION_BLURRED,
            center=PixelPoint(100, 100),
            blur_ellipse=BlurEllipse(12, 3, 45),
            apparent_minor_axis_diameter_px=6,
        )
        self.assertIs(sharp.visibility, BallVisibility.VISIBLE)
        self.assertIs(blurred.visibility, BallVisibility.VISIBLE)
        self.assertIs(ellipse.appearance, BallAppearance.MOTION_BLURRED)
        invalid = (
            ({"blur_start": PixelPoint(90, 100), "blur_end": PixelPoint(110, 100)}, "SHARP"),
            ({"appearance": BallAppearance.MOTION_BLURRED}, "exactly one"),
            (
                {
                    "appearance": BallAppearance.MOTION_BLURRED,
                    "blur_start": PixelPoint(90, 100),
                    "blur_end": PixelPoint(110, 100),
                    "blur_ellipse": BlurEllipse(12, 3, 0),
                },
                "exactly one",
            ),
        )
        for overrides, message in invalid:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(
                ValueError, message
            ):
                _ball(**overrides)

    def test_motion_blur_geometry_is_bounded_and_consistent(self) -> None:
        with self.assertRaisesRegex(ValueError, "endpoint midpoint"):
            _ball(
                appearance=BallAppearance.MOTION_BLURRED,
                center=PixelPoint(100, 100),
                blur_start=PixelPoint(90, 100),
                blur_end=PixelPoint(120, 100),
                apparent_minor_axis_diameter_px=6,
            )
        with self.assertRaisesRegex(ValueError, "major-axis length"):
            _ball(
                appearance=BallAppearance.MOTION_BLURRED,
                center=PixelPoint(100, 100),
                blur_start=PixelPoint(95, 100),
                blur_end=PixelPoint(105, 100),
                apparent_minor_axis_diameter_px=11,
            )
        with self.assertRaisesRegex(ValueError, "twice.*minor radius"):
            _ball(
                appearance=BallAppearance.MOTION_BLURRED,
                center=PixelPoint(100, 100),
                blur_ellipse=BlurEllipse(8, 3, 0),
                apparent_minor_axis_diameter_px=7,
            )
        with self.assertRaisesRegex(ValueError, "pixel bounds"):
            _ball(center=PixelPoint(1920, 10))
        with self.assertRaisesRegex(ValueError, "source-frame diagonal"):
            _ball(uncertainty_radius_px=3_000)

    def test_occlusion_out_of_frame_and_unknown_never_accept_geometry(self) -> None:
        for visibility in (
            BallVisibility.FULLY_OCCLUDED,
            BallVisibility.OUT_OF_FRAME,
        ):
            annotation = _ball(
                annotation_id=visibility.value,
                visibility=visibility,
                appearance=BallAppearance.NOT_OBSERVABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
            )
            self.assertFalse(annotation.is_localizable_observation)
            with self.assertRaisesRegex(ValueError, "invented observation geometry"):
                _ball(
                    visibility=visibility,
                    appearance=BallAppearance.NOT_OBSERVABLE,
                    apparent_minor_axis_diameter_px=None,
                    uncertainty_radius_px=None,
                )
        with self.assertRaisesRegex(ValueError, "track_segment_id"):
            _ball(
                visibility=BallVisibility.FULLY_OCCLUDED,
                appearance=BallAppearance.NOT_OBSERVABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
            )

    def test_not_present_is_the_only_confident_negative_and_is_attested(self) -> None:
        frame = _frame()
        search_attestation = _search_attestation(frame)
        not_present = _ball(
            annotation_id="not-present",
            frame=frame,
            visibility=BallVisibility.NOT_PRESENT,
            appearance=BallAppearance.NOT_OBSERVABLE,
            role=BallRole.MATCH_BALL,
            play_state=BallPlayState.NOT_APPLICABLE,
            center=None,
            apparent_minor_axis_diameter_px=None,
            uncertainty_radius_px=None,
            track_segment_id=None,
            search_region_observability_attestation=search_attestation,
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(EVIDENCE_A,),
        )
        self.assertTrue(
            not_present.confident_negative_claim_structurally_complete
        )
        with self.assertRaisesRegex(ValueError, "SearchRegionObservabilityAttestation"):
            _ball(
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "role=MATCH_BALL"):
            _ball(
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.SPARE_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                search_region_observability_attestation=search_attestation,
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "exact full decoded frame"):
            _ball(
                frame=frame,
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                search_region_observability_attestation=_search_attestation(
                    frame,
                    frame_index=frame.frame_index + 1,
                ),
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "reviewer authority"):
            _ball(
                frame=frame,
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                search_region_observability_attestation=_search_attestation(
                    frame,
                    reviewer_ids=("reviewer-2",),
                ),
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "exact full decoded frame"):
            _ball(
                frame=frame,
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                search_region_observability_attestation=_search_attestation(
                    frame,
                    searched_region=PixelRegion(0, 0, 100, 100),
                ),
                review_state=ReviewState.REVIEWED,
                reviewer_ids=("reviewer-1",),
                review_evidence_refs=(EVIDENCE_A,),
            )
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            _search_attestation(
                frame,
                capture_integrity_attestation_refs=(),
            )

    def test_indistinguishable_and_capture_unknown_are_not_negatives(self) -> None:
        for visibility in (BallVisibility.INDISTINGUISHABLE,):
            annotation = _ball(
                annotation_id=visibility.value,
                visibility=visibility,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.UNKNOWN,
                play_state=BallPlayState.UNKNOWN,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                ambiguity_reason="capture or candidate identity cannot be established",
            )
            self.assertFalse(
                annotation.confident_negative_claim_structurally_complete
            )
            self.assertFalse(annotation.is_localizable_observation)
        capture_unknown = _ball(
            annotation_id="CAPTURE_UNKNOWN",
            frame=_unavailable_frame(),
            visibility=BallVisibility.CAPTURE_UNKNOWN,
            appearance=BallAppearance.NOT_OBSERVABLE,
            role=BallRole.MATCH_BALL,
            play_state=BallPlayState.UNKNOWN,
            center=None,
            apparent_minor_axis_diameter_px=None,
            uncertainty_radius_px=None,
            track_segment_id=None,
            ambiguity_reason="capture presentation gap prevents decoded pixels",
        )
        self.assertFalse(
            capture_unknown.confident_negative_claim_structurally_complete
        )
        self.assertFalse(capture_unknown.is_localizable_observation)
        self.assertFalse(
            capture_unknown.frame.to_canonical_dict()["decoded_pixels_available"]
        )
        with self.assertRaisesRegex(ValueError, "gap_evidence_refs cannot be empty"):
            _unavailable_frame(gap_evidence_refs=())
        with self.assertRaisesRegex(ValueError, "ambiguity_reason"):
            _ball(
                frame=_unavailable_frame(),
                visibility=BallVisibility.CAPTURE_UNKNOWN,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.UNKNOWN,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
            )
        with self.assertRaisesRegex(ValueError, "UnavailableFrameReference"):
            _ball(
                visibility=BallVisibility.CAPTURE_UNKNOWN,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.UNKNOWN,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                ambiguity_reason="decoded pixels are unavailable",
            )
        with self.assertRaisesRegex(ValueError, "UNKNOWN role"):
            _ball(
                visibility=BallVisibility.INDISTINGUISHABLE,
                appearance=BallAppearance.NOT_OBSERVABLE,
                center=None,
                apparent_minor_axis_diameter_px=None,
                uncertainty_radius_px=None,
                track_segment_id=None,
                ambiguity_reason="multiple candidates overlap",
            )

    def test_contracts_reject_str_and_tuple_subclasses(self) -> None:
        class StrSubclass(str):
            pass

        class TupleSubclass(tuple):
            pass

        with self.assertRaisesRegex(ValueError, "ontology_sha256"):
            _ball(ontology_sha256=StrSubclass(ONTOLOGY))
        with self.assertRaisesRegex(ValueError, "reviewer_ids"):
            _ball(reviewer_ids=TupleSubclass())
        with self.assertRaisesRegex(ValueError, "observational_annotations"):
            _physical(
                observational_annotations=TupleSubclass((_observed(),)),
            )

    def test_any_unknown_role_or_play_state_requires_a_reason(self) -> None:
        for overrides in (
            {"role": BallRole.UNKNOWN},
            {"play_state": BallPlayState.UNKNOWN},
        ):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(
                ValueError, "ambiguity_reason"
            ):
                _ball(**overrides)
        self.assertIs(
            _ball(role=BallRole.UNKNOWN, ambiguity_reason="role unresolved").role,
            BallRole.UNKNOWN,
        )

    def test_review_bounds_fingerprints_and_immutability_remain_strict(self) -> None:
        reviewed = _ball(
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-2", "reviewer-1"),
            review_evidence_refs=(EVIDENCE_B, EVIDENCE_A),
        )
        reordered = _ball(
            review_state=ReviewState.REVIEWED,
            reviewer_ids=("reviewer-1", "reviewer-2"),
            review_evidence_refs=(EVIDENCE_A, EVIDENCE_B),
        )
        self.assertEqual(reviewed.fingerprint(), reordered.fingerprint())
        self.assertNotEqual(reviewed.fingerprint(), _ball().fingerprint())
        self.assertFalse(hasattr(reviewed, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            reviewed.visibility = BallVisibility.NOT_PRESENT  # type: ignore[misc]
        with self.assertRaisesRegex(ValueError, "reviewer IDs and review evidence"):
            _ball(review_state=ReviewState.REVIEWED)
        with self.assertRaisesRegex(ValueError, "2048 UTF-8 bytes"):
            _ball(role=BallRole.UNKNOWN, ambiguity_reason="a" * 2049)


class LayeredTemporalAnnotationTests(unittest.TestCase):
    def test_observation_is_signal_only_and_has_observational_type_tag(self) -> None:
        observed = _observed()
        self.assertIs(observed.annotation_type, AnnotationType.OBSERVED_TEMPORAL_EVENT)
        self.assertIs(observed.truth_layer, TruthLayer.OBSERVATIONAL)
        self.assertIs(observed.team_role, TeamAttributionRole.SERVING_TEAM)
        payload = observed.to_canonical_dict()
        self.assertEqual(payload["event_type"], "SERVE_CONTACT")
        self.assertNotIn("ruleset_sha256", payload)
        self.assertNotIn("official_mutation_permitted", payload)

    def test_observed_attribution_and_interval_fail_closed(self) -> None:
        no_attribution = _observed(
            event_type=ObservedTemporalEventType.WHISTLE,
            team_attribution_state=AttributionState.NOT_APPLICABLE,
            player_attribution_state=AttributionState.NOT_APPLICABLE,
            team=None,
            player_id=None,
        )
        self.assertIsNone(no_attribution.team_role)
        with self.assertRaisesRegex(ValueError, "does not allow team attribution"):
            _observed(
                event_type=ObservedTemporalEventType.WHISTLE,
                team_attribution_state=AttributionState.NOT_APPLICABLE,
                player_attribution_state=AttributionState.NOT_APPLICABLE,
                player_id=None,
            )
        with self.assertRaisesRegex(ValueError, "inverted"):
            _observed(interval_start_ns=121, interval_end_ns=120)
        with self.assertRaisesRegex(ValueError, "integers"):
            _observed(interval_start_ns=True)
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            _observed(evidence_refs=())

    def test_physical_adjudication_binds_observation_set_and_no_score_authority(self) -> None:
        first = _physical()
        reordered = _physical(
            observational_annotations=tuple(
                reversed(first.observational_annotations)
            )
        )
        self.assertEqual(first.fingerprint(), reordered.fingerprint())
        payload = first.to_canonical_dict()
        self.assertEqual(payload["truth_layer"], "PHYSICAL_ADJUDICATION")
        self.assertFalse(payload["score_authority"])
        self.assertEqual(len(payload["observational_evidence_set_sha256"]), 64)
        with self.assertRaisesRegex(ValueError, "ADJUDICATED"):
            _physical(
                review_state=ReviewState.REVIEWED,
                adjudicator_id=None,
                adjudication_evidence_refs=(),
            )
        with self.assertRaisesRegex(ValueError, "non-empty bounded tuple"):
            _physical(observational_annotations=())
        with self.assertRaisesRegex(ValueError, "duplicate logical annotation_id"):
            _physical(
                observational_annotations=(
                    _observed(annotation_id="same-observation"),
                    _observed(
                        annotation_id="same-observation",
                        interval_end_ns=119,
                    ),
                )
            )
        with self.assertRaisesRegex(ValueError, "non-empty bounded tuple"):
            _physical(
                observational_annotations=tuple(
                    _observed(annotation_id=f"observed-{index}")
                    for index in range(65)
                )
            )
        with self.assertRaisesRegex(ValueError, "same source"):
            _physical(
                observational_annotations=(
                    _observed(source_sha256="d" * 64),
                )
            )
        with self.assertRaisesRegex(ValueError, "same ontology"):
            _physical(
                observational_annotations=(
                    _observed(ontology_sha256="d" * 64),
                )
            )
        with self.assertRaisesRegex(ValueError, "within the physical"):
            _physical(
                observational_annotations=(
                    _observed(interval_start_ns=90, interval_end_ns=120),
                )
            )
        self.assertNotIn("REPLAY", {event.value for event in PhysicalEventType})

    def test_physical_landing_and_unresolved_have_explicit_semantics(self) -> None:
        landing = _physical(
            event_type=PhysicalEventType.LANDING_REGION,
            landing_region=PhysicalLandingRegion.OUT_OF_BOUNDS,
            team_attribution_state=AttributionState.NOT_APPLICABLE,
            player_attribution_state=AttributionState.NOT_APPLICABLE,
            team=None,
        )
        self.assertIs(landing.landing_region, PhysicalLandingRegion.OUT_OF_BOUNDS)
        with self.assertRaisesRegex(ValueError, "requires a landing_region"):
            _physical(
                event_type=PhysicalEventType.LANDING_REGION,
                team_attribution_state=AttributionState.NOT_APPLICABLE,
                player_attribution_state=AttributionState.NOT_APPLICABLE,
                team=None,
            )
        unresolved = _physical(
            event_type=PhysicalEventType.UNRESOLVED,
            team_attribution_state=AttributionState.NOT_APPLICABLE,
            player_attribution_state=AttributionState.NOT_APPLICABLE,
            team=None,
            ambiguity_reason="contact and landing cannot be established",
        )
        self.assertIs(unresolved.event_type, PhysicalEventType.UNRESOLVED)
        with self.assertRaisesRegex(ValueError, "ambiguity_reason"):
            _physical(
                event_type=PhysicalEventType.UNRESOLVED,
                team_attribution_state=AttributionState.NOT_APPLICABLE,
                player_attribution_state=AttributionState.NOT_APPLICABLE,
                team=None,
            )

    def test_reported_official_truth_is_explicitly_unverified_and_annotation_only(self) -> None:
        official = _official()
        changed_ruleset = _official(ruleset_sha256="d" * 64)
        payload = official.to_canonical_dict()
        self.assertIs(
            official.annotation_type,
            AnnotationType.REPORTED_OFFICIAL_EVENT,
        )
        self.assertIs(
            official.truth_layer,
            TruthLayer.REPORTED_OFFICIAL_UNVERIFIED,
        )
        self.assertTrue(payload["annotation_only"])
        self.assertFalse(payload["official_mutation_permitted"])
        self.assertFalse(payload["official_source_authenticated"])
        self.assertFalse(payload["score_authority"])
        self.assertNotIn("official_source_id", payload)
        self.assertNotIn("official_authority_id", payload)
        self.assertEqual(
            payload["reported_official_verification_state"],
            "UNVERIFIED",
        )
        self.assertEqual(payload["ruleset_sha256"], RULESET)
        self.assertNotEqual(official.fingerprint(), changed_ruleset.fingerprint())
        with self.assertRaisesRegex(ValueError, "ruleset_sha256"):
            _official(ruleset_sha256="D" * 64)
        with self.assertRaisesRegex(ValueError, "include reported_record_ref"):
            _official(evidence_refs=(EVIDENCE_B,))
        with self.assertRaisesRegex(ValueError, "source_match_revision"):
            _official(source_match_revision=True)
        with self.assertRaisesRegex(ValueError, "cannot be DRAFT"):
            _official(
                review_state=ReviewState.DRAFT,
                reviewer_ids=(),
                review_evidence_refs=(),
            )
        self.assertFalse(hasattr(annotations_module, "OfficialEventAnnotation"))

    def test_identical_time_and_evidence_do_not_merge_truth_layers(self) -> None:
        observed = _observed()
        physical = _physical()
        official = _official()
        fingerprints = {
            observed.fingerprint(),
            physical.fingerprint(),
            official.fingerprint(),
        }
        self.assertEqual(len(fingerprints), 3)
        self.assertEqual(
            {
                observed.to_canonical_dict()["truth_layer"],
                physical.to_canonical_dict()["truth_layer"],
                official.to_canonical_dict()["truth_layer"],
            },
            {
                "OBSERVATIONAL",
                "PHYSICAL_ADJUDICATION",
                "REPORTED_OFFICIAL_UNVERIFIED",
            },
        )


class MediaIdentityV2Tests(unittest.TestCase):
    def test_nested_media_contracts_are_v2_and_content_sensitive(self) -> None:
        frame = _frame()
        for contract in (
            PixelPoint(1, 2),
            BlurEllipse(12, 3, 45),
            frame.decode_contract,
            frame.identity,
            frame,
        ):
            self.assertEqual(json.loads(contract.canonical_json())["schema_version"], "2.0")
            self.assertEqual(len(contract.fingerprint()), 64)
        self.assertNotEqual(frame.fingerprint(), _frame(frame_index=8).fingerprint())

    def test_frame_and_decode_bounds_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "frame_index"):
            _frame(frame_index=1 << 63)
        with self.assertRaisesRegex(ValueError, "no greater than 65536"):
            _decode_contract(output_width=65_537)
        with self.assertRaisesRegex(ValueError, "earlier frame"):
            _frame(
                duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                duplicate_of_frame_index=7,
            )
        with self.assertRaisesRegex(ValueError, "capture-integrity"):
            _frame(
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=3,
            )
        duplicate = _frame(
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=3,
            capture_integrity_attestation_refs=(EVIDENCE_D,),
        )
        self.assertTrue(duplicate.is_excludable_capture_duplicate)


if __name__ == "__main__":
    unittest.main()
