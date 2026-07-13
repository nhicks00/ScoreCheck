"""Pure, deterministic Annotation Truth V2 to ball-target materialization.

This module performs no trust verification and grants no admission.  It accepts
an exact causal-ball label statement plus the exact concrete annotation
preimages named by that statement, rebinds every value, and emits the fixed V1
CPU tensor encoding consumed by :mod:`vision_scoring.ball_model`.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
import struct

try:
    import torch
except ModuleNotFoundError as error:  # pragma: no cover - optional dependency
    raise ModuleNotFoundError(
        "vision_scoring.ball_target_materialization requires the optional "
        "'training' dependency; install multicourt-vision-scoring[training]"
    ) from error

from .annotations import (
    BallAppearance,
    BallFrameAnnotationV2,
    BallRole,
    BallVisibility,
    FrameDuplicateKind,
    FrameReference,
)
from .ball_model import (
    CausalBallModelConfig,
    CausalBallTargets,
    MAX_CANDIDATES_PER_FRAME,
    ROLE_INDEX,
    ROLE_STATES,
    VISIBILITY_INDEX,
    VISIBILITY_STATES,
    source_pixel_center_to_heatmap_coordinate,
)
from .label_bundle import (
    CausalBallLabelBundleV1,
    LabelBundleSplit,
)


TARGET_ENCODING_VERSION = "1.0"
_TARGET_ENCODING_DESCRIPTOR = {
    "anchor": "floor(binary32(center_heatmap+binary32(0.5)))",
    "batch": "one_complete_source_bundle",
    "blur_axis": "axial_cos_2theta_sin_2theta",
    "blur_endpoint_extent": "hypot(end-start)/4",
    "blur_ellipse_extent": "2*major_radius_px/4",
    "candidate_order": "bundle_reference_order_localizable_only",
    "candidate_slots": MAX_CANDIDATES_PER_FRAME,
    "candidate_supervision": {
        "blur_extent_mask": "all_localizable_candidates",
        "center_mask": "localizable_candidates_only",
        "role_mask": "all_localizable_candidates_including_unknown",
    },
    "center": "(source_pixel_center+0.5)/4-0.5",
    "device": "cpu",
    "dtype": "float32",
    "float_scalar_normalization": (
        "ieee754_binary32_round_to_nearest_ties_to_even_before_"
        "anchor_collision_gaussian_blur_and_bound_decisions"
    ),
    "heatmap": "full_grid_isotropic_gaussian_pointwise_max",
    "heatmap_mask": "true_for_every_complete_decoded_frame",
    "heatmap_sigma": "max(0.7,apparent_minor_axis_diameter_px/(6*4))",
    "heatmap_stride": 4,
    "index_dtype": "int64",
    "localizable_visibilities": [
        BallVisibility.VISIBLE.value,
        BallVisibility.PARTIALLY_OCCLUDED.value,
    ],
    "mask_dtype": "bool",
    "match_target": "frame.match_ball_annotation_id",
    "match_visibility_mask": "true_for_every_complete_decoded_frame",
    "nonlocalizable_candidate_policy": "no_coordinate_or_candidate",
    "placeholder": {
        "float": "nan_with_false_mask",
        "index": "-1_with_false_mask",
    },
    "role_index_order": [role.value for role in ROLE_STATES],
    "schema_version": TARGET_ENCODING_VERSION,
    "sharp_blur": "extent=0,extent_mask=true,axis_mask=false",
    "split_semantics": "metadata_only_no_tensor_effect",
    "tensor_layout": {
        "candidate": "[1,time,16]",
        "candidate_xy_or_axis": "[1,time,16,2]",
        "heatmap": "[1,time,1,height/4,width/4]",
        "match_visibility": "[1,time]",
    },
    "visibility_index_order": [
        visibility.value for visibility in VISIBILITY_STATES
    ],
    "zero_candidate_heatmap": "exactly_zero",
}
TARGET_ENCODING_SHA256 = hashlib.sha256(
    json.dumps(
        _TARGET_ENCODING_DESCRIPTOR,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")
).hexdigest()


class MaterializationError(ValueError):
    """Fail-closed materialization error carrying a stable machine code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise MaterializationError(code, message)


def _binary32(value: float, field_name: str) -> float:
    """Round one scalar exactly as a CPU ``torch.float32`` target will store it."""

    try:
        normalized = struct.unpack("!f", struct.pack("!f", float(value)))[0]
    except (OverflowError, struct.error, TypeError, ValueError) as exc:
        _fail(
            "MATERIALIZATION_FLOAT32_RANGE",
            f"{field_name} cannot be represented as IEEE-754 binary32: {exc}",
        )
    if not math.isfinite(normalized):
        _fail(
            "MATERIALIZATION_FLOAT32_RANGE",
            f"{field_name} must remain finite in IEEE-754 binary32",
        )
    return normalized


def _candidate_anchor(center_heatmap: float, field_name: str) -> int:
    """Match ``torch.floor(torch.float32(center) + torch.float32(0.5))``."""

    half = _binary32(0.5, "candidate anchor half offset")
    accumulated = _binary32(
        center_heatmap + half,
        f"{field_name} anchor accumulation",
    )
    return math.floor(accumulated)


@dataclass(frozen=True, slots=True)
class MaterializedCausalBallTargetsV1:
    """Frozen result envelope whose metadata and tensors grant no authority.

    PyTorch tensors are mutable objects.  Freezing this dataclass prevents
    envelope-field replacement; it is not a deep-immutability or integrity
    boundary.  A later trusted coordinator must bind any persisted tensor
    artifact independently.
    """

    statement_sha256: str
    target_encoding_sha256: str
    bundle_id: str
    source_asset_sha256: str
    split: LabelBundleSplit
    frame_identity_sha256s: tuple[str, ...]
    decoded_frame_sha256s: tuple[str, ...]
    targets: CausalBallTargets

    def __post_init__(self) -> None:
        sha256_pattern = re.compile(r"^[0-9a-f]{64}$")
        for field_name in (
            "statement_sha256",
            "target_encoding_sha256",
            "source_asset_sha256",
        ):
            value = getattr(self, field_name)
            if type(value) is not str or sha256_pattern.fullmatch(value) is None:
                raise ValueError(f"{field_name} must be an exact SHA-256")
        if self.target_encoding_sha256 != TARGET_ENCODING_SHA256:
            raise ValueError("target_encoding_sha256 is not the fixed V1 encoding")
        if (
            type(self.bundle_id) is not str
            or not self.bundle_id
            or not self.bundle_id.isascii()
        ):
            raise ValueError("bundle_id must be a non-empty ASCII identifier")
        if type(self.split) is not LabelBundleSplit:
            raise ValueError("split must be exact LabelBundleSplit metadata")
        if (
            type(self.frame_identity_sha256s) is not tuple
            or type(self.decoded_frame_sha256s) is not tuple
            or not self.frame_identity_sha256s
            or len(self.frame_identity_sha256s) != len(self.decoded_frame_sha256s)
        ):
            raise ValueError("frame hash tuples must have one equal non-zero length")
        for field_name in ("frame_identity_sha256s", "decoded_frame_sha256s"):
            if any(
                type(value) is not str or sha256_pattern.fullmatch(value) is None
                for value in getattr(self, field_name)
            ):
                raise ValueError(f"{field_name} must contain exact SHA-256 values")
        if type(self.targets) is not CausalBallTargets:
            raise ValueError("targets must have exact CausalBallTargets type")
        frame_count = len(self.frame_identity_sha256s)
        heatmap = self.targets.heatmap_target
        candidates = self.targets.candidate_xy_heatmap
        if (
            not isinstance(heatmap, torch.Tensor)
            or heatmap.ndim != 5
            or heatmap.shape[:3] != (1, frame_count, 1)
            or heatmap.shape[3] < 1
            or heatmap.shape[4] < 1
            or not isinstance(candidates, torch.Tensor)
            or candidates.shape
            != (1, frame_count, MAX_CANDIDATES_PER_FRAME, 2)
        ):
            raise ValueError(
                "targets must bind the frame hashes and fixed V1 tensor axes"
            )
        candidate_shape = (1, frame_count, MAX_CANDIDATES_PER_FRAME)
        expected_shapes = {
            "heatmap_mask": (1, frame_count),
            "match_visibility_index": (1, frame_count),
            "match_visibility_mask": (1, frame_count),
            "candidate_visibility_index": candidate_shape,
            "candidate_mask": candidate_shape,
            "candidate_role_index": candidate_shape,
            "candidate_role_mask": candidate_shape,
            "candidate_blur_axis_target": (*candidate_shape, 2),
            "candidate_blur_extent_heatmap_px_target": candidate_shape,
            "candidate_blur_axis_mask": candidate_shape,
            "candidate_blur_extent_mask": candidate_shape,
        }
        for field_name, expected_shape in expected_shapes.items():
            value = getattr(self.targets, field_name)
            if not isinstance(value, torch.Tensor) or value.shape != expected_shape:
                raise ValueError(
                    f"{field_name} must match the fixed V1 frame/candidate axes"
                )
        float_fields = (
            "heatmap_target",
            "candidate_xy_heatmap",
            "candidate_blur_axis_target",
            "candidate_blur_extent_heatmap_px_target",
        )
        index_fields = (
            "match_visibility_index",
            "candidate_visibility_index",
            "candidate_role_index",
        )
        mask_fields = (
            "heatmap_mask",
            "match_visibility_mask",
            "candidate_mask",
            "candidate_role_mask",
            "candidate_blur_axis_mask",
            "candidate_blur_extent_mask",
        )
        for field_name in float_fields:
            value = getattr(self.targets, field_name)
            if value.dtype is not torch.float32 or value.device.type != "cpu":
                raise ValueError(f"{field_name} must be CPU torch.float32")
        for field_name in index_fields:
            value = getattr(self.targets, field_name)
            if value.dtype is not torch.long or value.device.type != "cpu":
                raise ValueError(f"{field_name} must be CPU torch.long")
        for field_name in mask_fields:
            value = getattr(self.targets, field_name)
            if value.dtype is not torch.bool or value.device.type != "cpu":
                raise ValueError(f"{field_name} must be CPU torch.bool")

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_test(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    @property
    def admissible_for_live_scoring(self) -> bool:
        return False


@dataclass(frozen=True, slots=True)
class _CandidatePlan:
    center_x_heatmap: float
    center_y_heatmap: float
    visibility_index: int
    role_index: int
    sigma_heatmap: float
    blur_axis_x: float
    blur_axis_y: float
    blur_extent_heatmap: float
    blur_axis_mask: bool


@dataclass(frozen=True, slots=True)
class _FramePlan:
    match_visibility_index: int
    candidates: tuple[_CandidatePlan, ...]


def _blur_plan(
    annotation: BallFrameAnnotationV2,
) -> tuple[float, float, float, bool]:
    if annotation.appearance is BallAppearance.SHARP:
        return math.nan, math.nan, _binary32(0.0, "sharp blur extent"), False
    if annotation.appearance is not BallAppearance.MOTION_BLURRED:
        _fail(
            "MATERIALIZATION_APPEARANCE_UNSUPPORTED",
            "a localizable annotation has no observable appearance",
        )
    if annotation.blur_start is not None and annotation.blur_end is not None:
        dx = annotation.blur_end.x - annotation.blur_start.x
        dy = annotation.blur_end.y - annotation.blur_start.y
        extent = math.hypot(dx, dy) / 4.0
        angle = math.atan2(dy, dx)
    elif annotation.blur_ellipse is not None:
        extent = 2.0 * annotation.blur_ellipse.major_radius_px / 4.0
        angle = math.radians(annotation.blur_ellipse.angle_degrees)
    else:  # Annotation V2 construction normally makes this unreachable.
        _fail(
            "MATERIALIZATION_BLUR_GEOMETRY_MISSING",
            "motion-blurred truth lacks exact endpoint or ellipse geometry",
        )
    return (
        _binary32(math.cos(2.0 * angle), "blur axis x"),
        _binary32(math.sin(2.0 * angle), "blur axis y"),
        _binary32(extent, "blur extent"),
        True,
    )


def _preflight(
    statement: CausalBallLabelBundleV1,
    annotations: tuple[BallFrameAnnotationV2, ...],
    model_config: CausalBallModelConfig,
) -> tuple[int, int, tuple[_FramePlan, ...]]:
    if statement.frame_count > model_config.max_frames:
        _fail(
            "MATERIALIZATION_FRAME_LIMIT",
            "bundle frame_count exceeds the model sequence bound",
        )

    references = tuple(
        reference
        for frame in statement.frames
        for reference in frame.annotations
    )
    if len(references) != statement.annotation_count:
        _fail(
            "MATERIALIZATION_REFERENCE_COUNT",
            "bundle reference count differs from annotation_count",
        )
    if len(annotations) != statement.annotation_count:
        _fail(
            "MATERIALIZATION_ANNOTATION_SET",
            "concrete annotation count differs from the exact bundle set",
        )

    concrete_by_id: dict[str, BallFrameAnnotationV2] = {}
    for annotation in annotations:
        if type(annotation) is not BallFrameAnnotationV2:
            _fail(
                "MATERIALIZATION_ANNOTATION_TYPE",
                "every concrete annotation must have exact BallFrameAnnotationV2 type",
            )
        if annotation.annotation_id in concrete_by_id:
            _fail(
                "MATERIALIZATION_ANNOTATION_DUPLICATE",
                "concrete annotation IDs cannot repeat",
            )
        concrete_by_id[annotation.annotation_id] = annotation

    reference_ids = tuple(reference.annotation_id for reference in references)
    if len(set(reference_ids)) != len(reference_ids):
        _fail(
            "MATERIALIZATION_REFERENCE_DUPLICATE",
            "bundle annotation references cannot repeat",
        )
    if set(concrete_by_id) != set(reference_ids):
        _fail(
            "MATERIALIZATION_ANNOTATION_SET",
            "concrete annotation IDs differ from the exact bundle set",
        )

    first_annotation = concrete_by_id[reference_ids[0]]
    if type(first_annotation.frame) is not FrameReference:
        _fail(
            "MATERIALIZATION_FRAME_UNAVAILABLE",
            "complete target materialization cannot contain a capture gap",
        )
    width = first_annotation.frame.width
    height = first_annotation.frame.height
    if height < 16 or width < 16 or height % 4 or width % 4:
        _fail(
            "MATERIALIZATION_DIMENSIONS",
            "source dimensions must be at least 16 and exactly divisible by four",
        )
    if height > model_config.max_height or width > model_config.max_width:
        _fail(
            "MATERIALIZATION_DIMENSIONS",
            "source dimensions exceed the model bounds",
        )
    total_source_pixels = statement.frame_count * height * width
    if total_source_pixels > model_config.max_total_input_pixels:
        _fail(
            "MATERIALIZATION_PIXEL_LIMIT",
            "bundle source pixels exceed max_total_input_pixels",
        )

    frame_plans: list[_FramePlan] = []
    for enumeration in statement.frames:
        selected: list[_CandidatePlan] = []
        anchors: dict[tuple[int, int], str] = {}
        match_visibility_index: int | None = None
        for reference in enumeration.annotations:
            annotation = concrete_by_id[reference.annotation_id]
            if annotation.visibility is BallVisibility.CAPTURE_UNKNOWN:
                _fail(
                    "MATERIALIZATION_CAPTURE_UNKNOWN",
                    "CAPTURE_UNKNOWN cannot supervise a decoded-frame target",
                )
            if type(annotation.frame) is not FrameReference:
                _fail(
                    "MATERIALIZATION_FRAME_UNAVAILABLE",
                    "complete target materialization cannot contain a capture gap",
                )
            concrete_frame = annotation.frame
            if concrete_frame.duplicate_kind is not FrameDuplicateKind.NONE:
                _fail(
                    "MATERIALIZATION_DUPLICATE_FRAME",
                    "duplicate-classified frames are excluded from V1 materialization",
                )
            if annotation.uncertainty_radius_px is not None:
                _fail(
                    "MATERIALIZATION_UNCERTAINTY_UNSUPPORTED",
                    "V1 has no honest mapping for annotation uncertainty_radius_px",
                )

            try:
                annotation_sha256 = annotation.fingerprint()
                frame_identity_sha256 = concrete_frame.identity.fingerprint()
                decode_contract_sha256 = concrete_frame.decode_contract.fingerprint()
            except (TypeError, ValueError) as exc:
                _fail("MATERIALIZATION_PREIMAGE", str(exc))
            if (
                annotation.annotation_type is not reference.annotation_type
                or annotation.annotation_id != reference.annotation_id
                or annotation_sha256 != reference.annotation_sha256
                or reference.annotation_preimage_ref != f"sha256:{annotation_sha256}"
                or annotation.ball_instance_id != reference.ball_instance_id
                or annotation.role is not reference.role
                or annotation.visibility is not reference.visibility
            ):
                _fail(
                    "MATERIALIZATION_ANNOTATION_BINDING",
                    "a concrete annotation differs from its exact bundle preimage",
                )
            if (
                annotation.ontology_sha256 != statement.ontology_sha256
                or concrete_frame.source_sha256 != statement.source_asset_sha256
                or concrete_frame.selected_video_stream_index
                != statement.selected_video_stream_index
                or decode_contract_sha256 != statement.decode_contract_sha256
                or concrete_frame.timestamp_basis is not statement.timestamp_basis
                or concrete_frame.pixel_coordinate_space
                is not statement.pixel_coordinate_space
                or concrete_frame.decoded_frame_hash_basis
                is not statement.decoded_frame_hash_basis
                or concrete_frame.frame_index != enumeration.frame_index
                or concrete_frame.timestamp_ns != enumeration.timestamp_ns
                or concrete_frame.decoded_frame_sha256
                != enumeration.decoded_frame_sha256
                or frame_identity_sha256 != enumeration.frame_identity_sha256
            ):
                _fail(
                    "MATERIALIZATION_FRAME_BINDING",
                    "annotation frame identity or decode domain differs from the bundle",
                )
            if concrete_frame.width != width or concrete_frame.height != height:
                _fail(
                    "MATERIALIZATION_DIMENSIONS",
                    "source dimensions change within the bundle",
                )

            if reference.annotation_id == enumeration.match_ball_annotation_id:
                if annotation.ball_instance_id != statement.match_ball_instance_id:
                    _fail(
                        "MATERIALIZATION_MATCH_BINDING",
                        "frame match target differs from the declared subject",
                    )
                try:
                    match_visibility_index = VISIBILITY_INDEX[annotation.visibility]
                except KeyError:
                    _fail(
                        "MATERIALIZATION_CAPTURE_UNKNOWN",
                        "match visibility has no decoded-frame target class",
                    )

            if not annotation.is_localizable_observation:
                continue
            if len(selected) >= MAX_CANDIDATES_PER_FRAME:
                _fail(
                    "MATERIALIZATION_CANDIDATE_LIMIT",
                    "a frame exceeds the fixed 16-candidate target axis",
                )
            assert annotation.center is not None
            assert annotation.apparent_minor_axis_diameter_px is not None
            try:
                mapped_center_x = source_pixel_center_to_heatmap_coordinate(
                    annotation.center.x
                )
                mapped_center_y = source_pixel_center_to_heatmap_coordinate(
                    annotation.center.y
                )
            except ValueError as exc:
                _fail("MATERIALIZATION_CENTER_BOUNDS", str(exc))
            center_x = _binary32(mapped_center_x, "candidate center x")
            center_y = _binary32(mapped_center_y, "candidate center y")
            anchor = (
                _candidate_anchor(center_x, "candidate x"),
                _candidate_anchor(center_y, "candidate y"),
            )
            if not (0 <= anchor[0] < width // 4 and 0 <= anchor[1] < height // 4):
                _fail(
                    "MATERIALIZATION_CENTER_BOUNDS",
                    f"annotation {annotation.annotation_id!r} has an out-of-frame anchor",
                )
            if anchor in anchors:
                _fail(
                    "MATERIALIZATION_CANDIDATE_COLLISION",
                    "localizable annotations "
                    f"{anchors[anchor]!r} and {annotation.annotation_id!r} share "
                    "one stride-four heatmap anchor",
                )
            anchors[anchor] = annotation.annotation_id
            axis_x, axis_y, extent, axis_mask = _blur_plan(annotation)
            if extent > model_config.max_blur_extent_heatmap_px:
                _fail(
                    "MATERIALIZATION_BLUR_EXTENT_MODEL_BOUND",
                    "exact blur extent exceeds the model output bound",
                )
            selected.append(
                _CandidatePlan(
                    center_x_heatmap=center_x,
                    center_y_heatmap=center_y,
                    visibility_index=VISIBILITY_INDEX[annotation.visibility],
                    role_index=ROLE_INDEX[annotation.role],
                    sigma_heatmap=_binary32(
                        max(
                            0.7,
                            annotation.apparent_minor_axis_diameter_px / 24.0,
                        ),
                        "heatmap sigma",
                    ),
                    blur_axis_x=axis_x,
                    blur_axis_y=axis_y,
                    blur_extent_heatmap=extent,
                    blur_axis_mask=axis_mask,
                )
            )
        if match_visibility_index is None:
            _fail(
                "MATERIALIZATION_MATCH_BINDING",
                "frame has no exact match-ball target annotation",
            )
        frame_plans.append(
            _FramePlan(
                match_visibility_index=match_visibility_index,
                candidates=tuple(selected),
            )
        )
    return height, width, tuple(frame_plans)


def _allocate_targets(
    *,
    height: int,
    width: int,
    frame_plans: tuple[_FramePlan, ...],
) -> CausalBallTargets:
    """Allocate only after the entire input has passed the bounded preflight."""

    frame_count = len(frame_plans)
    heatmap_height = height // 4
    heatmap_width = width // 4
    cpu = torch.device("cpu")
    float_options = {"dtype": torch.float32, "device": cpu}
    frame_shape = (1, frame_count)
    candidate_shape = (1, frame_count, MAX_CANDIDATES_PER_FRAME)

    heatmap_target = torch.zeros(
        (1, frame_count, 1, heatmap_height, heatmap_width),
        **float_options,
    )
    heatmap_mask = torch.ones(frame_shape, dtype=torch.bool, device=cpu)
    match_visibility_index = torch.empty(
        frame_shape,
        dtype=torch.long,
        device=cpu,
    )
    match_visibility_mask = torch.ones_like(heatmap_mask)
    candidate_xy = torch.full(
        (*candidate_shape, 2),
        math.nan,
        **float_options,
    )
    candidate_visibility_index = torch.full(
        candidate_shape,
        -1,
        dtype=torch.long,
        device=cpu,
    )
    candidate_mask = torch.zeros(candidate_shape, dtype=torch.bool, device=cpu)
    candidate_role_index = torch.full(
        candidate_shape,
        -1,
        dtype=torch.long,
        device=cpu,
    )
    candidate_role_mask = torch.zeros_like(candidate_mask)
    candidate_blur_axis = torch.full(
        (*candidate_shape, 2),
        math.nan,
        **float_options,
    )
    candidate_blur_extent = torch.full(
        candidate_shape,
        math.nan,
        **float_options,
    )
    candidate_blur_axis_mask = torch.zeros_like(candidate_mask)
    candidate_blur_extent_mask = torch.zeros_like(candidate_mask)

    grid_y, grid_x = torch.meshgrid(
        torch.arange(heatmap_height, **float_options),
        torch.arange(heatmap_width, **float_options),
        indexing="ij",
    )
    for frame_index, frame_plan in enumerate(frame_plans):
        match_visibility_index[0, frame_index] = frame_plan.match_visibility_index
        for slot, candidate in enumerate(frame_plan.candidates):
            candidate_mask[0, frame_index, slot] = True
            candidate_xy[0, frame_index, slot] = torch.tensor(
                (candidate.center_x_heatmap, candidate.center_y_heatmap),
                **float_options,
            )
            candidate_visibility_index[0, frame_index, slot] = (
                candidate.visibility_index
            )
            candidate_role_index[0, frame_index, slot] = candidate.role_index
            candidate_role_mask[0, frame_index, slot] = True
            candidate_blur_extent[0, frame_index, slot] = (
                candidate.blur_extent_heatmap
            )
            candidate_blur_extent_mask[0, frame_index, slot] = True
            if candidate.blur_axis_mask:
                candidate_blur_axis[0, frame_index, slot] = torch.tensor(
                    (candidate.blur_axis_x, candidate.blur_axis_y),
                    **float_options,
                )
                candidate_blur_axis_mask[0, frame_index, slot] = True

            squared_distance = (
                (grid_x - candidate.center_x_heatmap).square()
                + (grid_y - candidate.center_y_heatmap).square()
            )
            gaussian = torch.exp(
                -0.5
                * squared_distance
                / (candidate.sigma_heatmap * candidate.sigma_heatmap)
            )
            heatmap_target[0, frame_index, 0] = torch.maximum(
                heatmap_target[0, frame_index, 0],
                gaussian,
            )

    return CausalBallTargets(
        heatmap_target=heatmap_target,
        heatmap_mask=heatmap_mask,
        match_visibility_index=match_visibility_index,
        match_visibility_mask=match_visibility_mask,
        candidate_xy_heatmap=candidate_xy,
        candidate_visibility_index=candidate_visibility_index,
        candidate_mask=candidate_mask,
        candidate_role_index=candidate_role_index,
        candidate_role_mask=candidate_role_mask,
        candidate_blur_axis_target=candidate_blur_axis,
        candidate_blur_extent_heatmap_px_target=candidate_blur_extent,
        candidate_blur_axis_mask=candidate_blur_axis_mask,
        candidate_blur_extent_mask=candidate_blur_extent_mask,
    )


def materialize_causal_ball_targets_v1(
    statement: CausalBallLabelBundleV1,
    annotations: tuple[BallFrameAnnotationV2, ...],
    *,
    model_config: CausalBallModelConfig,
) -> MaterializedCausalBallTargetsV1:
    """Rebind exact label preimages and deterministically materialize V1 targets.

    The function intentionally does not accept a verification receipt, input
    frame tensor, gap mask, admission token, or persistence interface.
    """

    if type(statement) is not CausalBallLabelBundleV1:
        _fail(
            "MATERIALIZATION_STATEMENT_TYPE",
            "statement must have exact CausalBallLabelBundleV1 type",
        )
    if type(annotations) is not tuple:
        _fail(
            "MATERIALIZATION_ANNOTATIONS_TYPE",
            "annotations must be an exact immutable tuple",
        )
    if type(model_config) is not CausalBallModelConfig:
        _fail(
            "MATERIALIZATION_MODEL_CONFIG_TYPE",
            "model_config must have exact CausalBallModelConfig type",
        )

    height, width, frame_plans = _preflight(statement, annotations, model_config)
    try:
        statement_sha256 = statement.fingerprint()
    except (TypeError, ValueError) as exc:
        _fail("MATERIALIZATION_STATEMENT_PREIMAGE", str(exc))
    targets = _allocate_targets(
        height=height,
        width=width,
        frame_plans=frame_plans,
    )
    return MaterializedCausalBallTargetsV1(
        statement_sha256=statement_sha256,
        target_encoding_sha256=TARGET_ENCODING_SHA256,
        bundle_id=statement.bundle_id,
        source_asset_sha256=statement.source_asset_sha256,
        split=statement.split,
        frame_identity_sha256s=tuple(
            frame.frame_identity_sha256 for frame in statement.frames
        ),
        decoded_frame_sha256s=tuple(
            frame.decoded_frame_sha256 for frame in statement.frames
        ),
        targets=targets,
    )


__all__ = (
    "TARGET_ENCODING_SHA256",
    "TARGET_ENCODING_VERSION",
    "MaterializationError",
    "MaterializedCausalBallTargetsV1",
    "materialize_causal_ball_targets_v1",
)
