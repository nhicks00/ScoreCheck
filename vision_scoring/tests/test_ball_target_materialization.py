from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import inspect
import math
import unittest
from unittest.mock import patch

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training extras.
    torch = None  # type: ignore[assignment]

from vision_scoring.annotations import (
    AutorotationPolicy,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    BlurEllipse,
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
)
from vision_scoring.label_bundle import (
    CausalBallLabelBundleV1,
    LabelBundleSplit,
    build_causal_ball_label_bundle_v1,
)

if __package__:
    from .test_annotation_trust import CAPTURE_REF, REVIEW_REF, _attestations
else:
    from test_annotation_trust import (  # type: ignore[no-redef]
        CAPTURE_REF,
        REVIEW_REF,
        _attestations,
    )

if torch is not None:
    import vision_scoring.ball_target_materialization as materialization_module
    from vision_scoring.ball_model import (
        CausalBallInput,
        CausalBallModelConfig,
        CausalBallMultiTaskLoss,
        CausalBallPerceptionModel,
        MAX_CANDIDATES_PER_FRAME,
        ROLE_INDEX,
        VISIBILITY_INDEX,
    )
    from vision_scoring.ball_target_materialization import (
        TARGET_ENCODING_SHA256,
        TARGET_ENCODING_VERSION,
        MaterializationError,
        MaterializedCausalBallTargetsV1,
        materialize_causal_ball_targets_v1,
    )


SOURCE = "a" * 64
ONTOLOGY = "b" * 64
TRACE = "c" * 64
CAPTURE_POLICY = "d" * 64


def _frame(
    frame_index: int,
    *,
    width: int = 48,
    height: int = 32,
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE,
    duplicate_of_frame_index: int | None = None,
) -> FrameReference:
    decode_contract = FrameDecodeContract(
        decoder_artifact_sha256="f" * 64,
        decoder_build_id="fixture-decoder-v1",
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=width,
        output_height=height,
    )
    return FrameReference(
        identity=DecodedFrameIdentity(
            source_sha256=SOURCE,
            selected_video_stream_index=0,
            frame_index=frame_index,
            timestamp_ns=100 + frame_index * 10,
            timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
            pixel_coordinate_space=(
                PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
            ),
            decode_contract=decode_contract,
            decoded_frame_sha256=f"{frame_index + 1:064x}",
            decoded_frame_hash_basis=(
                DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            ),
        ),
        duplicate_kind=duplicate_kind,
        duplicate_of_frame_index=duplicate_of_frame_index,
    )


def _ball(
    frame_index: int,
    *,
    annotation_id: str | None = None,
    ball_instance_id: str = "match-ball",
    role: BallRole = BallRole.MATCH_BALL,
    visibility: BallVisibility = BallVisibility.VISIBLE,
    appearance: BallAppearance = BallAppearance.SHARP,
    center: PixelPoint | None = None,
    minor_diameter: float = 6.0,
    blur_start: PixelPoint | None = None,
    blur_end: PixelPoint | None = None,
    blur_ellipse: BlurEllipse | None = None,
    width: int = 48,
    height: int = 32,
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE,
    duplicate_of_frame_index: int | None = None,
    uncertainty_radius_px: float | None = None,
) -> BallFrameAnnotationV2:
    frame = _frame(
        frame_index,
        width=width,
        height=height,
        duplicate_kind=duplicate_kind,
        duplicate_of_frame_index=duplicate_of_frame_index,
    )
    selected_center = center or PixelPoint(8 + frame_index, 8 + frame_index)
    values: dict[str, object] = {
        "annotation_id": annotation_id or f"match-{frame_index}",
        "ontology_sha256": ONTOLOGY,
        "ball_instance_id": ball_instance_id,
        "frame": frame,
        "visibility": visibility,
        "appearance": appearance,
        "role": role,
        "play_state": BallPlayState.IN_PLAY,
        "center": selected_center,
        "blur_start": blur_start,
        "blur_end": blur_end,
        "blur_ellipse": blur_ellipse,
        "apparent_minor_axis_diameter_px": minor_diameter,
        "uncertainty_radius_px": uncertainty_radius_px,
        "track_segment_id": f"track-{ball_instance_id}",
        "review_state": ReviewState.REVIEWED,
        "reviewer_ids": ("reviewer-1",),
        "review_evidence_refs": (REVIEW_REF,),
    }
    if visibility in {BallVisibility.FULLY_OCCLUDED, BallVisibility.OUT_OF_FRAME}:
        values.update(
            appearance=BallAppearance.NOT_OBSERVABLE,
            center=None,
            blur_start=None,
            blur_end=None,
            blur_ellipse=None,
            apparent_minor_axis_diameter_px=None,
            uncertainty_radius_px=None,
        )
    elif visibility is BallVisibility.INDISTINGUISHABLE:
        values.update(
            appearance=BallAppearance.NOT_OBSERVABLE,
            role=BallRole.UNKNOWN,
            play_state=BallPlayState.UNKNOWN,
            center=None,
            blur_start=None,
            blur_end=None,
            blur_ellipse=None,
            apparent_minor_axis_diameter_px=None,
            uncertainty_radius_px=None,
            track_segment_id=None,
            ambiguity_reason="the match-ball role is visually indistinguishable",
        )
    elif visibility is BallVisibility.NOT_PRESENT:
        search = SearchRegionObservabilityAttestation(
            source_sha256=frame.source_sha256,
            selected_video_stream_index=frame.selected_video_stream_index,
            frame_index=frame.frame_index,
            decoded_frame_sha256=frame.decoded_frame_sha256,
            frame_identity_sha256=frame.identity.fingerprint(),
            target_role=BallRole.MATCH_BALL,
            region_scope=SearchRegionScope.FULL_DECODED_FRAME,
            searched_region=PixelRegion(0, 0, width - 1, height - 1),
            region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
            capture_integrity_attestation_refs=(CAPTURE_REF,),
            reviewer_ids=("reviewer-1",),
            review_evidence_refs=(REVIEW_REF,),
        )
        values.update(
            appearance=BallAppearance.NOT_OBSERVABLE,
            play_state=BallPlayState.NOT_APPLICABLE,
            center=None,
            blur_start=None,
            blur_end=None,
            blur_ellipse=None,
            apparent_minor_axis_diameter_px=None,
            uncertainty_radius_px=None,
            track_segment_id=None,
            search_region_observability_attestation=search,
        )
    elif role is BallRole.UNKNOWN:
        values["ambiguity_reason"] = "the localizable ball role is unknown"
    return BallFrameAnnotationV2(**values)  # type: ignore[arg-type]


def _bundle(
    annotations: tuple[BallFrameAnnotationV2, ...],
    *,
    split: LabelBundleSplit = LabelBundleSplit.TRAIN,
    bundle_id: str = "bundle-materialization-1",
) -> CausalBallLabelBundleV1:
    attestations = tuple(
        attestation
        for annotation in annotations
        for attestation in _attestations(annotation)
    )
    return build_causal_ball_label_bundle_v1(
        bundle_id=bundle_id,
        source_asset_sha256=SOURCE,
        finalized_trace_sha256=TRACE,
        capture_policy_sha256=CAPTURE_POLICY,
        capture_policy_generation=3,
        split=split,
        ontology_sha256=ONTOLOGY,
        ontology_version="ball-ontology-v2",
        match_ball_instance_id="match-ball",
        annotations=annotations,
        attestations=attestations,
        annotation_trust_store_sha256="e" * 64,
        annotation_verification_policy_sha256="f" * 64,
    )


if torch is not None:

    def _model_config(**overrides: object) -> CausalBallModelConfig:
        values: dict[str, object] = {
            "spatial_channels": 8,
            "temporal_channels": 8,
            "residual_blocks": 1,
            "max_batch_size": 1,
            "max_frames": 32,
            "max_height": 128,
            "max_width": 256,
            "max_total_input_pixels": 1_000_000,
            "max_blur_extent_heatmap_px": 32.0,
        }
        values.update(overrides)
        return CausalBallModelConfig(**values)  # type: ignore[arg-type]


    def _tensor_equal(first: torch.Tensor, second: torch.Tensor) -> bool:
        if first.dtype.is_floating_point:
            return bool(
                torch.allclose(
                    first,
                    second,
                    rtol=0.0,
                    atol=0.0,
                    equal_nan=True,
                )
            )
        return bool(torch.equal(first, second))


@unittest.skipIf(torch is None, "optional training dependency is not installed")
class BallTargetMaterializationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        assert torch is not None
        torch.set_num_threads(1)

    def test_exact_complete_targets_have_fixed_shapes_metadata_and_masks(self) -> None:
        annotations = (
            _ball(0, center=PixelPoint(0, 0)),
            _ball(
                0,
                annotation_id="spare-0",
                ball_instance_id="spare-ball",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(47, 31),
            ),
            _ball(1, visibility=BallVisibility.FULLY_OCCLUDED),
            _ball(2, visibility=BallVisibility.INDISTINGUISHABLE),
        )
        statement = _bundle(annotations, split=LabelBundleSplit.DEV)

        first = materialize_causal_ball_targets_v1(
            statement,
            annotations,
            model_config=_model_config(),
        )
        second = materialize_causal_ball_targets_v1(
            statement,
            annotations,
            model_config=_model_config(),
        )
        reordered = materialize_causal_ball_targets_v1(
            statement,
            tuple(reversed(annotations)),
            model_config=_model_config(),
        )
        targets = first.targets

        self.assertEqual(first.statement_sha256, statement.fingerprint())
        self.assertEqual(first.target_encoding_sha256, TARGET_ENCODING_SHA256)
        self.assertEqual(
            TARGET_ENCODING_SHA256,
            "dedbe55929e8a1863acaacb4e86e970d773a05baf53c96fa5654419bda32eec4",
        )
        self.assertEqual(TARGET_ENCODING_VERSION, "1.0")
        self.assertEqual(first.bundle_id, statement.bundle_id)
        self.assertEqual(first.source_asset_sha256, SOURCE)
        self.assertIs(first.split, LabelBundleSplit.DEV)
        self.assertEqual(
            first.frame_identity_sha256s,
            tuple(frame.frame_identity_sha256 for frame in statement.frames),
        )
        self.assertEqual(
            first.decoded_frame_sha256s,
            tuple(frame.decoded_frame_sha256 for frame in statement.frames),
        )
        self.assertEqual(targets.heatmap_target.shape, (1, 3, 1, 8, 12))
        self.assertEqual(targets.candidate_xy_heatmap.shape, (1, 3, 16, 2))
        self.assertEqual(targets.heatmap_target.device.type, "cpu")
        self.assertIs(targets.heatmap_target.dtype, torch.float32)
        self.assertTrue(bool(targets.heatmap_mask.all()))
        self.assertTrue(bool(targets.match_visibility_mask.all()))
        self.assertEqual(targets.candidate_mask.sum(dim=-1).tolist(), [[2, 0, 0]])
        self.assertTrue(bool((targets.heatmap_target[0, 1:] == 0).all()))
        for field_name in targets.__dataclass_fields__:
            for candidate in (second, reordered):
                self.assertTrue(
                    _tensor_equal(
                        getattr(first.targets, field_name),
                        getattr(candidate.targets, field_name),
                    ),
                    field_name,
                )
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertFalse(getattr(first, field_name))
        with self.assertRaises(FrozenInstanceError):
            first.bundle_id = "changed"  # type: ignore[misc]
        with self.assertRaisesRegex(ValueError, "fixed V1 encoding"):
            replace(first, target_encoding_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "equal non-zero length"):
            replace(first, decoded_frame_sha256s=first.decoded_frame_sha256s[:-1])
        with self.assertRaisesRegex(ValueError, "exact CausalBallTargets"):
            MaterializedCausalBallTargetsV1(
                statement_sha256=first.statement_sha256,
                target_encoding_sha256=first.target_encoding_sha256,
                bundle_id=first.bundle_id,
                source_asset_sha256=first.source_asset_sha256,
                split=first.split,
                frame_identity_sha256s=first.frame_identity_sha256s,
                decoded_frame_sha256s=first.decoded_frame_sha256s,
                targets=object(),  # type: ignore[arg-type]
            )
        wrong_candidate_axis = replace(
            first.targets,
            candidate_xy_heatmap=first.targets.candidate_xy_heatmap[:, :, :-1],
        )
        with self.assertRaisesRegex(ValueError, "fixed V1 tensor axes"):
            replace(first, targets=wrong_candidate_axis)

    def test_visibility_supervises_every_frame_without_inventing_coordinates(self) -> None:
        visibilities = (
            BallVisibility.VISIBLE,
            BallVisibility.PARTIALLY_OCCLUDED,
            BallVisibility.FULLY_OCCLUDED,
            BallVisibility.OUT_OF_FRAME,
            BallVisibility.INDISTINGUISHABLE,
            BallVisibility.NOT_PRESENT,
        )
        annotations = tuple(
            _ball(index, visibility=visibility)
            for index, visibility in enumerate(visibilities)
        )
        result = materialize_causal_ball_targets_v1(
            _bundle(annotations),
            annotations,
            model_config=_model_config(),
        )
        targets = result.targets
        self.assertEqual(
            targets.match_visibility_index.tolist(),
            [[VISIBILITY_INDEX[visibility] for visibility in visibilities]],
        )
        self.assertTrue(bool(targets.match_visibility_mask.all()))
        self.assertEqual(targets.candidate_mask.sum(dim=-1).tolist(), [[1, 1, 0, 0, 0, 0]])
        self.assertTrue(bool((targets.heatmap_target[0, 2:] == 0).all()))

    def test_half_pixel_centers_full_grid_gaussians_and_max_composition(self) -> None:
        match = _ball(0, center=PixelPoint(0, 0), minor_diameter=6.0)
        spare = _ball(
            0,
            annotation_id="spare-border",
            ball_instance_id="spare-border",
            role=BallRole.SPARE_BALL,
            center=PixelPoint(47, 31),
            minor_diameter=24.0,
        )
        annotations = (match, spare)
        targets = materialize_causal_ball_targets_v1(
            _bundle(annotations),
            annotations,
            model_config=_model_config(),
        ).targets

        self.assertTrue(
            torch.equal(
                targets.candidate_xy_heatmap[0, 0, 0],
                torch.tensor((-0.375, -0.375), dtype=torch.float32),
            )
        )
        self.assertTrue(
            torch.equal(
                targets.candidate_xy_heatmap[0, 0, 1],
                torch.tensor((11.375, 7.375), dtype=torch.float32),
            )
        )
        expected_match_at_origin = math.exp(
            -0.5 * (0.375**2 + 0.375**2) / (0.7**2)
        )
        expected_spare_at_origin = math.exp(
            -0.5 * (11.375**2 + 7.375**2) / (1.0**2)
        )
        self.assertAlmostEqual(
            float(targets.heatmap_target[0, 0, 0, 0, 0]),
            max(expected_match_at_origin, expected_spare_at_origin),
            places=6,
        )
        self.assertGreater(float(targets.heatmap_target[0, 0, 0, 0, 1]), 0.0)

    def test_blur_mapping_is_exact_and_unknown_local_role_is_supervised(self) -> None:
        annotations = (
            _ball(0, center=PixelPoint(4, 4)),
            _ball(
                0,
                annotation_id="endpoint-blur",
                ball_instance_id="a-endpoint",
                role=BallRole.UNKNOWN,
                appearance=BallAppearance.MOTION_BLURRED,
                center=PixelPoint(12, 8),
                minor_diameter=4.0,
                blur_start=PixelPoint(8, 8),
                blur_end=PixelPoint(16, 8),
            ),
            _ball(
                0,
                annotation_id="ellipse-blur",
                ball_instance_id="b-ellipse",
                role=BallRole.ADJACENT_COURT_BALL,
                appearance=BallAppearance.MOTION_BLURRED,
                center=PixelPoint(24, 16),
                minor_diameter=4.0,
                blur_ellipse=BlurEllipse(6, 2, 45),
            ),
        )
        targets = materialize_causal_ball_targets_v1(
            _bundle(annotations),
            annotations,
            model_config=_model_config(),
        ).targets

        self.assertEqual(targets.candidate_blur_extent_mask.sum().item(), 3)
        self.assertFalse(bool(targets.candidate_blur_axis_mask[0, 0, 0]))
        self.assertEqual(float(targets.candidate_blur_extent_heatmap_px_target[0, 0, 0]), 0.0)
        self.assertTrue(bool(targets.candidate_blur_axis_mask[0, 0, 1]))
        self.assertAlmostEqual(float(targets.candidate_blur_extent_heatmap_px_target[0, 0, 1]), 2.0)
        self.assertTrue(
            torch.allclose(
                targets.candidate_blur_axis_target[0, 0, 1],
                torch.tensor((1.0, 0.0)),
                atol=1e-7,
            )
        )
        self.assertAlmostEqual(float(targets.candidate_blur_extent_heatmap_px_target[0, 0, 2]), 3.0)
        self.assertTrue(
            torch.allclose(
                targets.candidate_blur_axis_target[0, 0, 2],
                torch.tensor((0.0, 1.0)),
                atol=1e-6,
            )
        )
        self.assertEqual(
            int(targets.candidate_role_index[0, 0, 1]),
            ROLE_INDEX[BallRole.UNKNOWN],
        )
        self.assertTrue(bool(targets.candidate_role_mask[0, 0, 1]))

    def test_collision_names_both_annotations_and_candidate_limit_precedes_allocation(self) -> None:
        collided = (
            _ball(0, center=PixelPoint(10, 8)),
            _ball(
                0,
                annotation_id="spare-collision",
                ball_instance_id="spare-collision",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(11, 8),
            ),
        )
        with self.assertRaises(MaterializationError) as collision:
            materialize_causal_ball_targets_v1(
                _bundle(collided),
                collided,
                model_config=_model_config(),
            )
        self.assertEqual(collision.exception.code, "MATERIALIZATION_CANDIDATE_COLLISION")
        self.assertIn("match-0", str(collision.exception))
        self.assertIn("spare-collision", str(collision.exception))

        precision_collision = (
            _ball(0, center=PixelPoint(3.49999996, 12)),
            _ball(
                0,
                annotation_id="spare-float32-collision",
                ball_instance_id="spare-float32-collision",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(3.50000004, 12),
            ),
        )
        with patch.object(
            materialization_module,
            "_allocate_targets",
            side_effect=AssertionError("allocation must not run"),
        ), self.assertRaises(MaterializationError) as precision:
            materialize_causal_ball_targets_v1(
                _bundle(precision_collision),
                precision_collision,
                model_config=_model_config(),
            )
        self.assertEqual(
            precision.exception.code,
            "MATERIALIZATION_CANDIDATE_COLLISION",
        )
        self.assertIn("match-0", str(precision.exception))
        self.assertIn("spare-float32-collision", str(precision.exception))

        addition_collision = (
            _ball(0, center=PixelPoint(3.4999998807907104, 16)),
            _ball(
                0,
                annotation_id="spare-float32-addition-collision",
                ball_instance_id="spare-float32-addition-collision",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(3.5, 16),
            ),
        )
        with patch.object(
            materialization_module,
            "_allocate_targets",
            side_effect=AssertionError("allocation must not run"),
        ), self.assertRaises(MaterializationError) as addition:
            materialize_causal_ball_targets_v1(
                _bundle(addition_collision),
                addition_collision,
                model_config=_model_config(),
            )
        self.assertEqual(
            addition.exception.code,
            "MATERIALIZATION_CANDIDATE_COLLISION",
        )
        self.assertIn("match-0", str(addition.exception))
        self.assertIn(
            "spare-float32-addition-collision",
            str(addition.exception),
        )

        bounded = [_ball(0, center=PixelPoint(0, 4), width=128)]
        bounded_roles = (
            BallRole.SPARE_BALL,
            BallRole.ADJACENT_COURT_BALL,
            BallRole.RETRIEVER_BALL,
            BallRole.WARMUP_BALL,
            BallRole.UNKNOWN,
        )
        for index in range(15):
            bounded.append(
                _ball(
                    0,
                    annotation_id=f"spare-{index:02d}",
                    ball_instance_id=f"spare-{index:02d}",
                    role=bounded_roles[index % len(bounded_roles)],
                    center=PixelPoint(4 * (index + 1), 4),
                    width=128,
                )
            )
        bounded_annotations = tuple(bounded)
        bounded_targets = materialize_causal_ball_targets_v1(
            _bundle(bounded_annotations),
            tuple(reversed(bounded_annotations)),
            model_config=_model_config(max_width=128),
        ).targets
        self.assertEqual(int(bounded_targets.candidate_mask.sum()), 16)
        active_roles = set(
            bounded_targets.candidate_role_index[bounded_targets.candidate_role_mask]
            .tolist()
        )
        self.assertIn(ROLE_INDEX[BallRole.RETRIEVER_BALL], active_roles)
        self.assertIn(ROLE_INDEX[BallRole.WARMUP_BALL], active_roles)

        annotations = bounded_annotations + (
            _ball(
                0,
                annotation_id="spare-15",
                ball_instance_id="spare-15",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(64, 12),
                width=128,
            ),
        )
        statement = _bundle(annotations)
        with patch.object(
            materialization_module,
            "_allocate_targets",
            side_effect=AssertionError("allocation must not run"),
        ), self.assertRaises(MaterializationError) as limit:
            materialize_causal_ball_targets_v1(
                statement,
                annotations,
                model_config=_model_config(max_width=128),
            )
        self.assertEqual(limit.exception.code, "MATERIALIZATION_CANDIDATE_LIMIT")

    def test_exact_preimage_set_types_and_frame_domain_fail_closed(self) -> None:
        annotations = (_ball(0), _ball(1))
        statement = _bundle(annotations)
        cases = (
            (
                (replace(annotations[0], center=PixelPoint(9, 8)), annotations[1]),
                "MATERIALIZATION_ANNOTATION_BINDING",
            ),
            ((annotations[0], annotations[0]), "MATERIALIZATION_ANNOTATION_DUPLICATE"),
            ((annotations[0],), "MATERIALIZATION_ANNOTATION_SET"),
            ((annotations[0], object()), "MATERIALIZATION_ANNOTATION_TYPE"),
        )
        for selected, expected_code in cases:
            with self.subTest(expected_code=expected_code), self.assertRaises(
                MaterializationError
            ) as caught:
                materialize_causal_ball_targets_v1(
                    statement,
                    selected,  # type: ignore[arg-type]
                    model_config=_model_config(),
                )
            self.assertEqual(caught.exception.code, expected_code)

        wrong_source_frame = replace(
            annotations[0].frame,
            identity=replace(
                annotations[0].frame.identity,
                source_sha256="9" * 64,
            ),
        )
        wrong_source = (replace(annotations[0], frame=wrong_source_frame), annotations[1])
        with self.assertRaises(MaterializationError) as binding:
            materialize_causal_ball_targets_v1(
                statement,
                wrong_source,
                model_config=_model_config(),
            )
        self.assertEqual(binding.exception.code, "MATERIALIZATION_ANNOTATION_BINDING")

    def test_uncertainty_duplicate_dimensions_and_pixel_bounds_fail_before_allocation(self) -> None:
        uncertainty = (_ball(0, uncertainty_radius_px=2.0),)
        duplicate = (
            _ball(0),
            _ball(
                1,
                duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                duplicate_of_frame_index=0,
            ),
        )
        non_divisible = (_ball(0, width=50, height=34),)
        three_frames = tuple(_ball(index) for index in range(3))
        cases = (
            (
                _bundle(uncertainty),
                uncertainty,
                _model_config(),
                "MATERIALIZATION_UNCERTAINTY_UNSUPPORTED",
            ),
            (
                _bundle(duplicate),
                duplicate,
                _model_config(),
                "MATERIALIZATION_DUPLICATE_FRAME",
            ),
            (
                _bundle(non_divisible),
                non_divisible,
                _model_config(),
                "MATERIALIZATION_DIMENSIONS",
            ),
            (
                _bundle(three_frames),
                three_frames,
                _model_config(max_total_input_pixels=4096),
                "MATERIALIZATION_PIXEL_LIMIT",
            ),
            (
                _bundle(three_frames),
                three_frames,
                _model_config(max_frames=2),
                "MATERIALIZATION_FRAME_LIMIT",
            ),
        )
        for statement, selected, config, expected_code in cases:
            with self.subTest(expected_code=expected_code), patch.object(
                materialization_module,
                "_allocate_targets",
                side_effect=AssertionError("allocation must not run"),
            ), self.assertRaises(MaterializationError) as caught:
                materialize_causal_ball_targets_v1(
                    statement,
                    selected,
                    model_config=config,
                )
            self.assertEqual(caught.exception.code, expected_code)

    def test_split_is_metadata_only_and_api_accepts_no_receipt_or_input_mask(self) -> None:
        annotations = (_ball(0),)
        train = materialize_causal_ball_targets_v1(
            _bundle(annotations, split=LabelBundleSplit.TRAIN, bundle_id="bundle-train"),
            annotations,
            model_config=_model_config(),
        )
        test = materialize_causal_ball_targets_v1(
            _bundle(annotations, split=LabelBundleSplit.TEST, bundle_id="bundle-test"),
            annotations,
            model_config=_model_config(),
        )
        for field_name in train.targets.__dataclass_fields__:
            self.assertTrue(
                _tensor_equal(
                    getattr(train.targets, field_name),
                    getattr(test.targets, field_name),
                )
            )
        self.assertIs(train.split, LabelBundleSplit.TRAIN)
        self.assertIs(test.split, LabelBundleSplit.TEST)
        self.assertFalse(train.admissible_for_training)
        self.assertFalse(test.admissible_for_training)
        self.assertEqual(
            tuple(inspect.signature(materialize_causal_ball_targets_v1).parameters),
            ("statement", "annotations", "model_config"),
        )

    def test_materialized_targets_run_through_model_loss_and_backprop_on_cpu(self) -> None:
        torch.manual_seed(31)
        annotations = (
            _ball(0),
            _ball(
                0,
                annotation_id="spare-0",
                ball_instance_id="spare-ball",
                role=BallRole.SPARE_BALL,
                center=PixelPoint(28, 20),
            ),
            _ball(1, visibility=BallVisibility.FULLY_OCCLUDED),
        )
        config = _model_config(max_frames=2)
        targets = materialize_causal_ball_targets_v1(
            _bundle(annotations),
            annotations,
            model_config=config,
        ).targets
        inputs = CausalBallInput(
            frames=torch.rand((1, 2, 3, 32, 48), dtype=torch.float32),
            valid_frame_mask=torch.ones((1, 2), dtype=torch.bool),
        )
        model = CausalBallPerceptionModel(config)
        output = model(inputs)
        targets.validate(output)
        loss = CausalBallMultiTaskLoss()(output, targets)
        self.assertTrue(bool(torch.isfinite(loss.total)))
        self.assertEqual(loss.heatmap_frames, 2)
        self.assertEqual(loss.match_visibility_frames, 2)
        self.assertEqual(loss.candidates, 2)
        loss.total.backward()
        gradients = [
            parameter.grad
            for parameter in model.parameters()
            if parameter.grad is not None
        ]
        self.assertTrue(gradients)
        self.assertTrue(all(bool(torch.isfinite(value).all()) for value in gradients))


if __name__ == "__main__":
    unittest.main()
