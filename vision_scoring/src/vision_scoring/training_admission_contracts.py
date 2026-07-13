"""Pure, non-authorizing contracts for causal-ball TRAIN/DEV admission.

These contracts bind immutable facts for a later trusted coordinator.  They do
not validate readiness, open label or media stores, initialize a model, or
grant training, evaluation, TEST, deployment, or live-scoring authority.

All wire formats are bounded canonical ASCII JSON.  Numeric policy and
sampling quantities are exact integers; ratios use parts per million.  TEST
identifiers may be reduced to one domain-separated commitment but are never
serialized into any training contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import Enum
import hashlib
import math
import re
from typing import Any, ClassVar, Iterable, Mapping, TypeVar

from .annotation_trust import AnnotationMinimumTruthPolicy
from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from .capture_profile_contracts import (
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CompressionStratumV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
)
from .contract_wire import (
    MAX_SIGNED_64,
    CanonicalWireError,
    canonical_json_bytes,
    enum_from_json,
    exact_list,
    parse_canonical_json_object,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)


TRAINING_ADMISSION_SCHEMA_VERSION = "1.0"
TRAINING_EXAMPLE_SCHEMA_VERSION = "3.0"

TRAINING_ADMISSION_POLICY_DOMAIN = (
    "multicourt-vision-scoring:training-admission-policy:v1"
)
TRAINING_COVERAGE_REPORT_DOMAIN = (
    "multicourt-vision-scoring:training-coverage-report:v1"
)
TRAINING_EXAMPLE_DOMAIN = "multicourt-vision-scoring:training-example:v3"
TRAINING_DATASET_MANIFEST_DOMAIN = (
    "multicourt-vision-scoring:training-dataset-manifest:v1"
)
TRAINING_RUN_REQUEST_DOMAIN = (
    "multicourt-vision-scoring:training-run-request:v1"
)
STRATIFIED_SAMPLING_PLAN_DOMAIN = (
    "multicourt-vision-scoring:stratified-sampling-plan:v1"
)
TRAINING_SAMPLING_SCHEDULE_DOMAIN = (
    "multicourt-vision-scoring:training-sampling-schedule:v1"
)
TRAINING_RUN_MANIFEST_DOMAIN = (
    "multicourt-vision-scoring:training-run-manifest:v1"
)
TEST_EXCLUSION_COMMITMENT_DOMAIN = (
    "multicourt-vision-scoring:test-exclusion-commitment:v1"
)
CAMERA_RISK_KEY_DOMAIN = "multicourt-vision-scoring:camera-risk-key:v2"
CAMERA_RISK_KEY_SCHEMA_VERSION = "2.0"
LEAKAGE_GROUP_DOMAIN = "multicourt-vision-scoring:leakage-group:v1"
TARGET_TENSOR_SET_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-target-tensor-set:v1"
)
TRAINING_EXAMPLE_REFERENCE_SET_DOMAIN = (
    "multicourt-vision-scoring:training-example-reference-set:v1"
)
TRAINING_SCHEDULE_RANKING_DOMAIN = (
    "multicourt-vision-scoring:training-schedule-ranking:v1"
)

CAUSAL_BALL_MODEL_CONFIG_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-model-config:v1"
)
CAUSAL_BALL_LOSS_CONFIG_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-loss-config:v1"
)
CAUSAL_BALL_OPTIMIZER_CONFIG_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-optimizer-config:v1"
)
CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256 = (
    "e163cd45f875869fe20545ad6304524cc88545d77da4e539413e3f4ad36dfe0c"
)
CAUSAL_BALL_TARGET_ENCODING_SHA256 = (
    "dedbe55929e8a1863acaacb4e86e970d773a05baf53c96fa5654419bda32eec4"
)

CAUSAL_BALL_HEATMAP_STRIDE = 4
CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME = 16
CAUSAL_BALL_MAX_FRAMES = 32
CAUSAL_BALL_MAX_HEIGHT = 2160
CAUSAL_BALL_MAX_WIDTH = 3840
CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS = 16_777_216
MAX_TRAINING_EXAMPLES = 512
MAX_TARGET_TENSOR_ROWS = 13
MAX_SAMPLING_EPOCHS = 64
MAX_SCHEDULE_ROWS = 4096
MAX_TRAINING_FRAMES = MAX_TRAINING_EXAMPLES * CAUSAL_BALL_MAX_FRAMES
MAX_TRAINING_CONTRACT_BYTES = 2 * 1024 * 1024
MAX_EXAMPLE_CONTRACT_BYTES = 256 * 1024
MAX_POLICY_CONTRACT_BYTES = 64 * 1024
MAX_COVERAGE_CONTRACT_BYTES = 128 * 1024
MAX_RUN_REQUEST_BYTES = 64 * 1024
MAX_SAMPLING_PLAN_BYTES = 128 * 1024
MAX_RUN_MANIFEST_BYTES = 128 * 1024
MAX_TEST_EXCLUSION_PREIMAGE_BYTES = 128 * 1024
PPM = 1_000_000

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UTC_SECOND_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_T = TypeVar("_T")

_ADMISSION_FLAG_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class TrainingAdmissionContractError(ValueError):
    """A fail-closed contract-shape error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingAdmissionContractError(code, message)


class TrainingSplitV1(str, Enum):
    """Partitions visible to the training boundary; TEST is unrepresentable."""

    TRAIN = "TRAIN"
    DEV = "DEV"


class ExampleStratumTagV1(str, Enum):
    VISIBLE_BALL = "VISIBLE_BALL"
    PARTIALLY_OCCLUDED_BALL = "PARTIALLY_OCCLUDED_BALL"
    FULLY_OCCLUDED_BALL = "FULLY_OCCLUDED_BALL"
    BALL_OUT_OF_FRAME = "BALL_OUT_OF_FRAME"
    NO_BALL = "NO_BALL"
    HARD_NEGATIVE = "HARD_NEGATIVE"
    MOTION_BLUR = "MOTION_BLUR"
    LOW_LIGHT = "LOW_LIGHT"


class PrimarySamplingStratumV1(str, Enum):
    LOCALIZABLE_BALL = "LOCALIZABLE_BALL"
    OCCLUDED_OR_OUT_OF_FRAME = "OCCLUDED_OR_OUT_OF_FRAME"
    NO_BALL_HARD_NEGATIVE = "NO_BALL_HARD_NEGATIVE"
    OTHER_SUPERVISED = "OTHER_SUPERVISED"


class CoverageRequirementV1(str, Enum):
    MAXIMUM_EXAMPLES = "MAXIMUM_EXAMPLES"
    MAXIMUM_TOTAL_FRAMES = "MAXIMUM_TOTAL_FRAMES"
    MINIMUM_TRAIN_SOURCES = "MINIMUM_TRAIN_SOURCES"
    MINIMUM_DEV_SOURCES = "MINIMUM_DEV_SOURCES"
    MINIMUM_TRAIN_FRAMES = "MINIMUM_TRAIN_FRAMES"
    MINIMUM_DEV_FRAMES = "MINIMUM_DEV_FRAMES"
    MINIMUM_MATCHES = "MINIMUM_MATCHES"
    MINIMUM_VENUES = "MINIMUM_VENUES"
    MINIMUM_CAMERA_SETUPS = "MINIMUM_CAMERA_SETUPS"
    REQUIRED_CAPTURE_MODES = "REQUIRED_CAPTURE_MODES"
    REQUIRED_CAPTURE_RISKS = "REQUIRED_CAPTURE_RISKS"
    REQUIRED_EXAMPLE_STRATA = "REQUIRED_EXAMPLE_STRATA"
    MAXIMUM_MATCH_SHARE = "MAXIMUM_MATCH_SHARE"
    MAXIMUM_ROOT_ASSET_SHARE = "MAXIMUM_ROOT_ASSET_SHARE"
    MAXIMUM_LEAKAGE_GROUP_SHARE = "MAXIMUM_LEAKAGE_GROUP_SHARE"


class TargetTensorFieldV1(str, Enum):
    HEATMAP_TARGET = "heatmap_target"
    HEATMAP_MASK = "heatmap_mask"
    MATCH_VISIBILITY_INDEX = "match_visibility_index"
    MATCH_VISIBILITY_MASK = "match_visibility_mask"
    CANDIDATE_XY_HEATMAP = "candidate_xy_heatmap"
    CANDIDATE_VISIBILITY_INDEX = "candidate_visibility_index"
    CANDIDATE_MASK = "candidate_mask"
    CANDIDATE_ROLE_INDEX = "candidate_role_index"
    CANDIDATE_ROLE_MASK = "candidate_role_mask"
    CANDIDATE_BLUR_AXIS_TARGET = "candidate_blur_axis_target"
    CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET = (
        "candidate_blur_extent_heatmap_px_target"
    )
    CANDIDATE_BLUR_AXIS_MASK = "candidate_blur_axis_mask"
    CANDIDATE_BLUR_EXTENT_MASK = "candidate_blur_extent_mask"


class TargetTensorDTypeV1(str, Enum):
    IEEE754_BINARY32_LE = "IEEE754_BINARY32_LE"
    SIGNED_INT64_LE = "SIGNED_INT64_LE"
    BOOL_U8 = "BOOL_U8"


class TrainingOutputRoleV1(str, Enum):
    QUARANTINED_TRAINING_CHECKPOINTS = "QUARANTINED_TRAINING_CHECKPOINTS"


_SPLIT_ORDER = {TrainingSplitV1.TRAIN: 0, TrainingSplitV1.DEV: 1}
_TARGET_FIELD_ORDER = {value: index for index, value in enumerate(TargetTensorFieldV1)}
_PRIMARY_STRATUM_ORDER = {
    value: index for index, value in enumerate(PrimarySamplingStratumV1)
}

_LOCALIZABLE_BALL_TAGS = frozenset(
    {
        ExampleStratumTagV1.VISIBLE_BALL,
        ExampleStratumTagV1.PARTIALLY_OCCLUDED_BALL,
    }
)
_OCCLUDED_OR_OUT_OF_FRAME_TAGS = frozenset(
    {
        ExampleStratumTagV1.FULLY_OCCLUDED_BALL,
        ExampleStratumTagV1.BALL_OUT_OF_FRAME,
    }
)
_BALL_STATE_TAGS = _LOCALIZABLE_BALL_TAGS | _OCCLUDED_OR_OUT_OF_FRAME_TAGS

_FLOAT_TARGET_FIELDS = frozenset(
    {
        TargetTensorFieldV1.HEATMAP_TARGET,
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET,
    }
)
_INDEX_TARGET_FIELDS = frozenset(
    {
        TargetTensorFieldV1.MATCH_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX,
    }
)


def _require_date(value: object, field_name: str) -> str:
    if type(value) is not str or _ISO_DATE_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    return value


def _require_schema_version(
    value: object,
    *,
    label: str,
    expected: str = TRAINING_ADMISSION_SCHEMA_VERSION,
) -> None:
    if type(value) is not str or value != expected:
        raise ValueError(f"unsupported {label} schema")


def _require_utc_second(value: object, field_name: str) -> datetime:
    if type(value) is not str or _UTC_SECOND_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be UTC to exact-second precision")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as exc:
        raise ValueError(f"{field_name} must be UTC to exact-second precision") from exc
    return parsed


def _require_exact_false_flags(value: object) -> None:
    for field_name in _ADMISSION_FLAG_FIELDS:
        selected = getattr(value, field_name)
        if type(selected) is not bool or selected is not False:
            raise ValueError("persisted training-admission authority flags must be false")


def _authority_flags_dict(value: object) -> dict[str, bool]:
    return {field_name: getattr(value, field_name) for field_name in _ADMISSION_FLAG_FIELDS}


def _require_exact_tuple(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
    exact_type: type[_T],
) -> tuple[_T, ...]:
    if type(value) is not tuple or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{field_name} must be an immutable tuple with {minimum} to {maximum} rows"
        )
    if any(type(item) is not exact_type for item in value):
        raise ValueError(f"{field_name} contains a row with the wrong exact type")
    return value


def _require_canonical_enum_tuple(
    value: object,
    field_name: str,
    *,
    enum_type: type[_T],
    minimum: int = 0,
) -> tuple[_T, ...]:
    if type(value) is not tuple or not minimum <= len(value) <= len(enum_type):
        raise ValueError(f"{field_name} must be a bounded immutable tuple")
    if any(type(item) is not enum_type for item in value):
        raise ValueError(f"{field_name} contains an unsupported exact enum value")
    expected = tuple(sorted(value, key=lambda item: item.value))  # type: ignore[attr-defined]
    if value != expected or len(set(value)) != len(value):
        raise ValueError(f"{field_name} must be unique and canonically sorted")
    return value


def derive_primary_sampling_stratum_v1(
    tags: tuple[ExampleStratumTagV1, ...],
) -> PrimarySamplingStratumV1:
    """Derive the one fixed V1 sampling stratum from canonical example tags."""

    _require_canonical_enum_tuple(
        tags,
        "example_stratum_tags",
        enum_type=ExampleStratumTagV1,
        minimum=1,
    )
    selected = frozenset(tags)
    if ExampleStratumTagV1.HARD_NEGATIVE in selected:
        if ExampleStratumTagV1.NO_BALL not in selected:
            raise ValueError("HARD_NEGATIVE requires NO_BALL")
        if selected.intersection(_BALL_STATE_TAGS):
            raise ValueError("HARD_NEGATIVE cannot coexist with ball-state tags")
        return PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE
    if selected.intersection(_LOCALIZABLE_BALL_TAGS):
        return PrimarySamplingStratumV1.LOCALIZABLE_BALL
    if selected.intersection(_OCCLUDED_OR_OUT_OF_FRAME_TAGS):
        return PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME
    return PrimarySamplingStratumV1.OTHER_SUPERVISED


def _require_distinct_digests(
    rows: Iterable[tuple[str, str | None]],
    *,
    label: str,
) -> None:
    selected: list[str] = []
    for field_name, value in rows:
        if value is None:
            continue
        require_sha256(value, field_name)
        selected.append(value)
    if len(selected) != len(set(selected)):
        raise ValueError(f"{label} typed digest roles must not alias")


def _fingerprint(value: Mapping[str, Any], *, label: str, maximum_bytes: int) -> str:
    return hashlib.sha256(
        canonical_json_bytes(value, label=label, maximum_bytes=maximum_bytes)
    ).hexdigest()


def _parse_contract(
    raw: bytes,
    *,
    label: str,
    domain: str,
    fields: set[str],
    maximum_bytes: int,
    maximum_depth: int,
    maximum_nodes: int,
    maximum_containers: int,
) -> dict[str, Any]:
    payload = parse_canonical_json_object(
        raw,
        label=label,
        maximum_bytes=maximum_bytes,
        maximum_depth=maximum_depth,
        maximum_nodes=maximum_nodes,
        maximum_containers=maximum_containers,
    )
    payload = require_exact_fields(payload, {"domain", *fields}, label=label)
    if payload.pop("domain") != domain:
        raise ValueError(f"{label} domain is invalid")
    return payload


class _CanonicalContract:
    _DOMAIN: ClassVar[str]
    _LABEL: ClassVar[str]
    _MAXIMUM_BYTES: ClassVar[int]

    def to_dict(self) -> dict[str, Any]:
        raise NotImplementedError

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(), label=self._LABEL, maximum_bytes=self._MAXIMUM_BYTES
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()


def causal_ball_model_config_descriptor_v1() -> dict[str, Any]:
    """Return the fixed, torch-free V1 model configuration descriptor."""

    return {
        "architecture": "OWNED_CAUSAL_CONVGRU_BALL_BASELINE",
        "domain": CAUSAL_BALL_MODEL_CONFIG_DOMAIN,
        "heatmap_stride": CAUSAL_BALL_HEATMAP_STRIDE,
        "max_batch_size": 16,
        "max_blur_extent_heatmap_px_decimal": "64",
        "max_frames": CAUSAL_BALL_MAX_FRAMES,
        "max_height": CAUSAL_BALL_MAX_HEIGHT,
        "max_log_variance_decimal": "6",
        "max_total_input_pixels": CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS,
        "max_width": CAUSAL_BALL_MAX_WIDTH,
        "min_log_variance_decimal": "-4",
        "residual_blocks": 2,
        "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
        "spatial_channels": 24,
        "temporal_channels": 32,
    }


def causal_ball_loss_config_descriptor_v1() -> dict[str, Any]:
    """Return the fixed V1 multi-task loss configuration descriptor."""

    return {
        "blur_axis_weight_decimal": "0.25",
        "blur_extent_weight_decimal": "0.25",
        "domain": CAUSAL_BALL_LOSS_CONFIG_DOMAIN,
        "heatmap_focal_alpha_decimal": "0.75",
        "heatmap_focal_gamma_decimal": "2",
        "heatmap_weight_decimal": "1",
        "loss": "CAUSAL_BALL_MULTI_TASK_V1",
        "role_weight_decimal": "0.5",
        "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
        "uncertainty_weight_decimal": "0.25",
        "visibility_weight_decimal": "1",
    }


def causal_ball_optimizer_config_descriptor_v1() -> dict[str, Any]:
    """Return the fixed V1 Adam optimizer configuration descriptor."""

    return {
        "amsgrad": False,
        "beta1_decimal": "0.9",
        "beta2_decimal": "0.999",
        "capturable": False,
        "decoupled_weight_decay": False,
        "differentiable": False,
        "domain": CAUSAL_BALL_OPTIMIZER_CONFIG_DOMAIN,
        "epsilon_decimal": "0.00000001",
        "foreach": False,
        "fused": False,
        "learning_rate_decimal": "0.001",
        "maximize": False,
        "optimizer": "TORCH_ADAM",
        "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
        "weight_decay_decimal": "0",
    }


_CALCULATED_CAUSAL_BALL_MODEL_CONFIG_SHA256 = _fingerprint(
    causal_ball_model_config_descriptor_v1(),
    label="fixed causal-ball model configuration",
    maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
)
CAUSAL_BALL_MODEL_CONFIG_SHA256 = (
    "d6d590c22efeb15ae3eb8abc3cf679b7b95167fe338c4693f7b8ee5e6aad0b25"
)
_CALCULATED_CAUSAL_BALL_LOSS_CONFIG_SHA256 = _fingerprint(
    causal_ball_loss_config_descriptor_v1(),
    label="fixed causal-ball loss configuration",
    maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
)
CAUSAL_BALL_LOSS_CONFIG_SHA256 = (
    "0a68f75e80b1297588819f7eee8ffcce8b57fcfddf8f2cbc0368c73fa5627a7e"
)
_CALCULATED_CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256 = _fingerprint(
    causal_ball_optimizer_config_descriptor_v1(),
    label="fixed causal-ball optimizer configuration",
    maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
)
CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256 = (
    "ae8ba3aa857e057b49b201b030831e8b0840cc49596956ecba3db8989b1befe6"
)
if (
    _CALCULATED_CAUSAL_BALL_MODEL_CONFIG_SHA256
    != CAUSAL_BALL_MODEL_CONFIG_SHA256
    or _CALCULATED_CAUSAL_BALL_LOSS_CONFIG_SHA256
    != CAUSAL_BALL_LOSS_CONFIG_SHA256
    or _CALCULATED_CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256
    != CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256
):
    raise RuntimeError("a fixed V1 training configuration descriptor changed")


def compute_test_exclusion_commitment_sha256_v1(
    dataset_id: str,
    test_source_ids: tuple[str, ...],
) -> str:
    """Commit to the isolated TEST source set without returning its IDs.

    This domain-separated digest omits identifiers from downstream contracts;
    it is not a secrecy mechanism for predictable identifiers or cardinality.
    """

    require_stable_id(dataset_id, "dataset_id")
    if (
        type(test_source_ids) is not tuple
        or not 1 <= len(test_source_ids) <= MAX_TRAINING_EXAMPLES
    ):
        raise ValueError("test_source_ids must be a bounded immutable tuple")
    for source_id in test_source_ids:
        require_stable_id(source_id, "test source ID")
    if (
        test_source_ids != tuple(sorted(test_source_ids))
        or len(set(test_source_ids)) != len(test_source_ids)
    ):
        raise ValueError("test_source_ids must be unique and canonically sorted")
    return _fingerprint(
        {
            "dataset_id": dataset_id,
            "domain": TEST_EXCLUSION_COMMITMENT_DOMAIN,
            "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
            "source_count": len(test_source_ids),
            "source_ids": list(test_source_ids),
        },
        label="TEST exclusion commitment preimage",
        maximum_bytes=MAX_TEST_EXCLUSION_PREIMAGE_BYTES,
    )


def camera_risk_key_sha256_v2(
    *,
    capture_mode: TrainingCaptureModeV1,
    camera_setup_id: str,
    capture_profile_sha256: str,
    lighting_condition_id: str,
    encoder_configuration_sha256: str,
    source_representation: SourceRepresentationV1,
    source_classification: CaptureSourceClassificationV1,
) -> str:
    if type(capture_mode) is not TrainingCaptureModeV1:
        raise ValueError("capture_mode must be an exact TrainingCaptureModeV1")
    if type(source_representation) is not SourceRepresentationV1:
        raise ValueError(
            "source_representation must be an exact SourceRepresentationV1"
        )
    if type(source_classification) is not CaptureSourceClassificationV1:
        raise ValueError(
            "source_classification must be an exact CaptureSourceClassificationV1"
        )
    require_stable_id(camera_setup_id, "camera_setup_id")
    require_stable_id(lighting_condition_id, "lighting_condition_id")
    _require_distinct_digests(
        (
            ("capture_profile_sha256", capture_profile_sha256),
            ("encoder_configuration_sha256", encoder_configuration_sha256),
        ),
        label="camera risk key",
    )
    return _fingerprint(
        {
            "camera_setup_id": camera_setup_id,
            "capture_mode": capture_mode.value,
            "capture_profile_sha256": capture_profile_sha256,
            "domain": CAMERA_RISK_KEY_DOMAIN,
            "encoder_configuration_sha256": encoder_configuration_sha256,
            "lighting_condition_id": lighting_condition_id,
            "schema_version": CAMERA_RISK_KEY_SCHEMA_VERSION,
            "source_classification": source_classification.value,
            "source_representation": source_representation.value,
        },
        label="camera risk key",
        maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
    )


def leakage_group_sha256_v1(
    *,
    match_id: str,
    root_asset_sha256: str,
    synchronized_capture_group_id: str,
    split_group_id: str,
    venue_id: str,
    camera_setup_id: str,
    recording_date: str,
) -> str:
    for field_name, value in (
        ("match_id", match_id),
        ("synchronized_capture_group_id", synchronized_capture_group_id),
        ("split_group_id", split_group_id),
        ("venue_id", venue_id),
        ("camera_setup_id", camera_setup_id),
    ):
        require_stable_id(value, field_name)
    require_sha256(root_asset_sha256, "root_asset_sha256")
    _require_date(recording_date, "recording_date")
    return _fingerprint(
        {
            "camera_setup_id": camera_setup_id,
            "domain": LEAKAGE_GROUP_DOMAIN,
            "match_id": match_id,
            "recording_date": recording_date,
            "root_asset_sha256": root_asset_sha256,
            "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
            "split_group_id": split_group_id,
            "synchronized_capture_group_id": synchronized_capture_group_id,
            "venue_id": venue_id,
        },
        label="training leakage group",
        maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
    )


@dataclass(frozen=True, slots=True)
class TargetTensorContentRowV1:
    """Content row for one exact CausalBallTargets tensor role."""

    field: TargetTensorFieldV1
    dtype: TargetTensorDTypeV1
    shape: tuple[int, ...]
    content_sha256: str

    def __post_init__(self) -> None:
        if type(self.field) is not TargetTensorFieldV1:
            raise ValueError("target tensor field must be an exact enum value")
        if type(self.dtype) is not TargetTensorDTypeV1:
            raise ValueError("target tensor dtype must be an exact enum value")
        if type(self.shape) is not tuple or not 1 <= len(self.shape) <= 5:
            raise ValueError("target tensor shape must have one to five dimensions")
        for dimension in self.shape:
            require_exact_int(
                dimension, "target tensor dimension", minimum=1, maximum=MAX_SIGNED_64
            )
        require_sha256(self.content_sha256, "content_sha256")

    def to_dict(self) -> dict[str, Any]:
        return {
            "content_sha256": self.content_sha256,
            "dtype": self.dtype.value,
            "field": self.field.value,
            "shape": list(self.shape),
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "TargetTensorContentRowV1":
        fields = require_exact_fields(
            value, {"field", "dtype", "shape", "content_sha256"}, label=label
        )
        raw_shape = fields["shape"]
        if type(raw_shape) is not list:
            raise ValueError(f"{label}.shape must be an array")
        return cls(
            field=enum_from_json(TargetTensorFieldV1, fields["field"], "field"),
            dtype=enum_from_json(TargetTensorDTypeV1, fields["dtype"], "dtype"),
            shape=tuple(raw_shape),
            content_sha256=fields["content_sha256"],
        )


def target_tensor_set_sha256_v1(
    rows: tuple[TargetTensorContentRowV1, ...],
) -> str:
    _require_exact_tuple(
        rows,
        "target tensor rows",
        minimum=MAX_TARGET_TENSOR_ROWS,
        maximum=MAX_TARGET_TENSOR_ROWS,
        exact_type=TargetTensorContentRowV1,
    )
    if tuple(row.field for row in rows) != tuple(TargetTensorFieldV1):
        raise ValueError("target tensor rows must contain every field in canonical order")
    return _fingerprint(
        {
            "domain": TARGET_TENSOR_SET_DOMAIN,
            "rows": [row.to_dict() for row in rows],
            "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
        },
        label="causal-ball target tensor set",
        maximum_bytes=MAX_EXAMPLE_CONTRACT_BYTES,
    )


@dataclass(frozen=True, slots=True)
class TrainingAdmissionPolicyV1(_CanonicalContract):
    """Protected aggregate corpus requirements, never supplied by a dataset."""

    policy_id: str
    valid_from: str
    valid_until: str
    minimum_train_sources: int
    minimum_dev_sources: int
    minimum_train_frames: int
    minimum_dev_frames: int
    minimum_distinct_matches: int
    minimum_distinct_venues: int
    minimum_distinct_camera_setups: int
    required_capture_modes: tuple[TrainingCaptureModeV1, ...]
    required_capture_risk_tags: tuple[CaptureRiskTagV1, ...]
    required_example_stratum_tags: tuple[ExampleStratumTagV1, ...]
    maximum_match_frames_ppm: int
    maximum_root_asset_frames_ppm: int
    maximum_leakage_group_frames_ppm: int
    maximum_match_draws_ppm: int
    maximum_root_asset_draws_ppm: int
    maximum_leakage_group_draws_ppm: int
    maximum_examples: int
    maximum_total_frames: int
    maximum_schedule_rows: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_ADMISSION_POLICY_DOMAIN
    _LABEL = "training admission policy"
    _MAXIMUM_BYTES = MAX_POLICY_CONTRACT_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training admission policy")
        require_stable_id(self.policy_id, "policy_id")
        valid_from = date.fromisoformat(_require_date(self.valid_from, "valid_from"))
        valid_until = date.fromisoformat(_require_date(self.valid_until, "valid_until"))
        if valid_until < valid_from:
            raise ValueError("valid_until cannot precede valid_from")
        for field_name in (
            "minimum_train_sources",
            "minimum_dev_sources",
            "minimum_distinct_matches",
            "minimum_distinct_venues",
            "minimum_distinct_camera_setups",
        ):
            require_exact_int(
                getattr(self, field_name),
                field_name,
                minimum=1,
                maximum=MAX_TRAINING_EXAMPLES,
            )
        for field_name in ("minimum_train_frames", "minimum_dev_frames"):
            require_exact_int(
                getattr(self, field_name),
                field_name,
                minimum=1,
                maximum=MAX_TRAINING_FRAMES,
            )
        _require_canonical_enum_tuple(
            self.required_capture_modes,
            "required_capture_modes",
            enum_type=TrainingCaptureModeV1,
            minimum=1,
        )
        _require_canonical_enum_tuple(
            self.required_capture_risk_tags,
            "required_capture_risk_tags",
            enum_type=CaptureRiskTagV1,
            minimum=1,
        )
        _require_canonical_enum_tuple(
            self.required_example_stratum_tags,
            "required_example_stratum_tags",
            enum_type=ExampleStratumTagV1,
            minimum=1,
        )
        for field_name in (
            "maximum_match_frames_ppm",
            "maximum_root_asset_frames_ppm",
            "maximum_leakage_group_frames_ppm",
            "maximum_match_draws_ppm",
            "maximum_root_asset_draws_ppm",
            "maximum_leakage_group_draws_ppm",
        ):
            require_exact_int(getattr(self, field_name), field_name, minimum=1, maximum=PPM)
        require_exact_int(
            self.maximum_examples,
            "maximum_examples",
            minimum=2,
            maximum=MAX_TRAINING_EXAMPLES,
        )
        if self.minimum_train_sources + self.minimum_dev_sources > self.maximum_examples:
            raise ValueError("minimum source counts exceed maximum_examples")
        if len(self.required_capture_modes) > self.maximum_examples:
            raise ValueError("required capture modes exceed maximum_examples")
        for field_name in (
            "minimum_distinct_matches",
            "minimum_distinct_venues",
            "minimum_distinct_camera_setups",
        ):
            if getattr(self, field_name) > self.maximum_examples:
                raise ValueError(f"{field_name} exceeds maximum_examples")
        maximum_train_examples = self.maximum_examples - self.minimum_dev_sources
        maximum_dev_examples = self.maximum_examples - self.minimum_train_sources
        if (
            self.minimum_train_frames
            > maximum_train_examples * CAUSAL_BALL_MAX_FRAMES
        ):
            raise ValueError(
                "minimum_train_frames cannot fit while reserving minimum DEV sources"
            )
        if (
            self.minimum_dev_frames
            > maximum_dev_examples * CAUSAL_BALL_MAX_FRAMES
        ):
            raise ValueError(
                "minimum_dev_frames cannot fit while reserving minimum TRAIN sources"
            )
        minimum_train_examples = max(
            self.minimum_train_sources,
            (
                self.minimum_train_frames
                + CAUSAL_BALL_MAX_FRAMES
                - 1
            )
            // CAUSAL_BALL_MAX_FRAMES,
        )
        minimum_dev_examples = max(
            self.minimum_dev_sources,
            (self.minimum_dev_frames + CAUSAL_BALL_MAX_FRAMES - 1)
            // CAUSAL_BALL_MAX_FRAMES,
        )
        if minimum_train_examples + minimum_dev_examples > self.maximum_examples:
            raise ValueError(
                "combined TRAIN/DEV frame and source minima exceed maximum_examples"
            )
        require_exact_int(
            self.maximum_total_frames,
            "maximum_total_frames",
            minimum=2,
            maximum=MAX_TRAINING_FRAMES,
        )
        minimum_required_examples = max(
            minimum_train_examples + minimum_dev_examples,
            self.minimum_distinct_matches,
            self.minimum_distinct_venues,
            self.minimum_distinct_camera_setups,
            len(self.required_capture_modes),
        )
        if self.maximum_total_frames < minimum_required_examples:
            raise ValueError(
                "maximum_total_frames cannot hold the minimum required examples"
            )
        if self.minimum_train_frames + self.minimum_dev_frames > self.maximum_total_frames:
            raise ValueError("minimum frame counts exceed maximum_total_frames")
        require_exact_int(
            self.maximum_schedule_rows,
            "maximum_schedule_rows",
            minimum=1,
            maximum=MAX_SCHEDULE_ROWS,
        )
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "domain": self._DOMAIN,
            "maximum_examples": self.maximum_examples,
            "maximum_leakage_group_draws_ppm": self.maximum_leakage_group_draws_ppm,
            "maximum_leakage_group_frames_ppm": self.maximum_leakage_group_frames_ppm,
            "maximum_match_draws_ppm": self.maximum_match_draws_ppm,
            "maximum_match_frames_ppm": self.maximum_match_frames_ppm,
            "maximum_root_asset_draws_ppm": self.maximum_root_asset_draws_ppm,
            "maximum_root_asset_frames_ppm": self.maximum_root_asset_frames_ppm,
            "maximum_schedule_rows": self.maximum_schedule_rows,
            "maximum_total_frames": self.maximum_total_frames,
            "minimum_dev_frames": self.minimum_dev_frames,
            "minimum_dev_sources": self.minimum_dev_sources,
            "minimum_distinct_camera_setups": self.minimum_distinct_camera_setups,
            "minimum_distinct_matches": self.minimum_distinct_matches,
            "minimum_distinct_venues": self.minimum_distinct_venues,
            "minimum_train_frames": self.minimum_train_frames,
            "minimum_train_sources": self.minimum_train_sources,
            "policy_id": self.policy_id,
            "required_capture_modes": [item.value for item in self.required_capture_modes],
            "required_capture_risk_tags": [
                item.value for item in self.required_capture_risk_tags
            ],
            "required_example_stratum_tags": [
                item.value for item in self.required_example_stratum_tags
            ],
            "schema_version": self.schema_version,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingAdmissionPolicyV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields=set(cls.__dataclass_fields__),
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=4,
                maximum_nodes=128,
                maximum_containers=8,
            )
            for field_name, enum_type in (
                ("required_capture_modes", TrainingCaptureModeV1),
                ("required_capture_risk_tags", CaptureRiskTagV1),
                ("required_example_stratum_tags", ExampleStratumTagV1),
            ):
                raw_values = exact_list(fields, field_name, label=cls._LABEL)
                fields[field_name] = tuple(
                    enum_from_json(enum_type, item, field_name) for item in raw_values
                )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_POLICY_SHAPE", "training admission policy fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_POLICY_WIRE", "policy did not reconstruct exactly")
        return result


@dataclass(frozen=True, slots=True)
class TrainingCoverageReportV1(_CanonicalContract):
    """Non-authorizing aggregate coverage result for one exact example set."""

    dataset_id: str
    readiness_manifest_sha256: str
    admission_policy_sha256: str
    example_reference_set_sha256: str
    train_source_count: int
    dev_source_count: int
    train_frame_count: int
    dev_frame_count: int
    distinct_match_count: int
    distinct_venue_count: int
    distinct_camera_setup_count: int
    covered_capture_modes: tuple[TrainingCaptureModeV1, ...]
    covered_capture_risk_tags: tuple[CaptureRiskTagV1, ...]
    covered_example_stratum_tags: tuple[ExampleStratumTagV1, ...]
    maximum_match_frames_ppm: int
    maximum_root_asset_frames_ppm: int
    maximum_leakage_group_frames_ppm: int
    unsatisfied_requirements: tuple[CoverageRequirementV1, ...]
    coverage_requirements_satisfied: bool
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_COVERAGE_REPORT_DOMAIN
    _LABEL = "training coverage report"
    _MAXIMUM_BYTES = MAX_COVERAGE_CONTRACT_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training coverage report")
        require_stable_id(self.dataset_id, "dataset_id")
        _require_distinct_digests(
            (
                ("readiness_manifest_sha256", self.readiness_manifest_sha256),
                ("admission_policy_sha256", self.admission_policy_sha256),
                ("example_reference_set_sha256", self.example_reference_set_sha256),
            ),
            label="coverage report",
        )
        for field_name in ("train_source_count", "dev_source_count"):
            require_exact_int(
                getattr(self, field_name), field_name, minimum=1, maximum=MAX_TRAINING_EXAMPLES
            )
        if self.train_source_count + self.dev_source_count > MAX_TRAINING_EXAMPLES:
            raise ValueError("coverage source count exceeds the corpus bound")
        for field_name in ("train_frame_count", "dev_frame_count"):
            require_exact_int(
                getattr(self, field_name), field_name, minimum=1, maximum=MAX_TRAINING_FRAMES
            )
        if self.train_frame_count + self.dev_frame_count > MAX_TRAINING_FRAMES:
            raise ValueError("coverage frame count exceeds the corpus bound")
        for field_name in (
            "distinct_match_count",
            "distinct_venue_count",
            "distinct_camera_setup_count",
        ):
            require_exact_int(
                getattr(self, field_name),
                field_name,
                minimum=1,
                maximum=self.train_source_count + self.dev_source_count,
            )
        _require_canonical_enum_tuple(
            self.covered_capture_modes,
            "covered_capture_modes",
            enum_type=TrainingCaptureModeV1,
            minimum=1,
        )
        _require_canonical_enum_tuple(
            self.covered_capture_risk_tags,
            "covered_capture_risk_tags",
            enum_type=CaptureRiskTagV1,
            minimum=1,
        )
        _require_canonical_enum_tuple(
            self.covered_example_stratum_tags,
            "covered_example_stratum_tags",
            enum_type=ExampleStratumTagV1,
            minimum=1,
        )
        for field_name in (
            "maximum_match_frames_ppm",
            "maximum_root_asset_frames_ppm",
            "maximum_leakage_group_frames_ppm",
        ):
            require_exact_int(getattr(self, field_name), field_name, minimum=1, maximum=PPM)
        _require_canonical_enum_tuple(
            self.unsatisfied_requirements,
            "unsatisfied_requirements",
            enum_type=CoverageRequirementV1,
        )
        if type(self.coverage_requirements_satisfied) is not bool:
            raise ValueError("coverage_requirements_satisfied must be exact bool")
        if self.coverage_requirements_satisfied is not (not self.unsatisfied_requirements):
            raise ValueError("coverage satisfaction must exactly reflect the issue tuple")
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "admission_policy_sha256": self.admission_policy_sha256,
            "coverage_requirements_satisfied": self.coverage_requirements_satisfied,
            "covered_capture_modes": [item.value for item in self.covered_capture_modes],
            "covered_capture_risk_tags": [
                item.value for item in self.covered_capture_risk_tags
            ],
            "covered_example_stratum_tags": [
                item.value for item in self.covered_example_stratum_tags
            ],
            "dataset_id": self.dataset_id,
            "dev_frame_count": self.dev_frame_count,
            "dev_source_count": self.dev_source_count,
            "distinct_camera_setup_count": self.distinct_camera_setup_count,
            "distinct_match_count": self.distinct_match_count,
            "distinct_venue_count": self.distinct_venue_count,
            "domain": self._DOMAIN,
            "example_reference_set_sha256": self.example_reference_set_sha256,
            "maximum_leakage_group_frames_ppm": self.maximum_leakage_group_frames_ppm,
            "maximum_match_frames_ppm": self.maximum_match_frames_ppm,
            "maximum_root_asset_frames_ppm": self.maximum_root_asset_frames_ppm,
            "readiness_manifest_sha256": self.readiness_manifest_sha256,
            "schema_version": self.schema_version,
            "train_frame_count": self.train_frame_count,
            "train_source_count": self.train_source_count,
            "unsatisfied_requirements": [
                item.value for item in self.unsatisfied_requirements
            ],
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingCoverageReportV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields=set(cls.__dataclass_fields__),
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=4,
                maximum_nodes=256,
                maximum_containers=12,
            )
            for field_name, enum_type in (
                ("covered_capture_modes", TrainingCaptureModeV1),
                ("covered_capture_risk_tags", CaptureRiskTagV1),
                ("covered_example_stratum_tags", ExampleStratumTagV1),
                ("unsatisfied_requirements", CoverageRequirementV1),
            ):
                raw_values = exact_list(fields, field_name, label=cls._LABEL)
                fields[field_name] = tuple(
                    enum_from_json(enum_type, item, field_name) for item in raw_values
                )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_COVERAGE_SHAPE", "coverage report fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_COVERAGE_WIRE", "coverage report did not reconstruct exactly")
        return result


def _validate_target_tensor_rows_for_example(
    rows: tuple[TargetTensorContentRowV1, ...],
    *,
    frame_count: int,
    output_width: int,
    output_height: int,
) -> None:
    _require_exact_tuple(
        rows,
        "target_tensor_rows",
        minimum=MAX_TARGET_TENSOR_ROWS,
        maximum=MAX_TARGET_TENSOR_ROWS,
        exact_type=TargetTensorContentRowV1,
    )
    if tuple(row.field for row in rows) != tuple(TargetTensorFieldV1):
        raise ValueError("target tensor rows must contain every field in canonical order")
    candidate_shape = (1, frame_count, CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME)
    expected_shapes: dict[TargetTensorFieldV1, tuple[int, ...]] = {
        TargetTensorFieldV1.HEATMAP_TARGET: (
            1,
            frame_count,
            1,
            output_height // CAUSAL_BALL_HEATMAP_STRIDE,
            output_width // CAUSAL_BALL_HEATMAP_STRIDE,
        ),
        TargetTensorFieldV1.HEATMAP_MASK: (1, frame_count),
        TargetTensorFieldV1.MATCH_VISIBILITY_INDEX: (1, frame_count),
        TargetTensorFieldV1.MATCH_VISIBILITY_MASK: (1, frame_count),
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP: (*candidate_shape, 2),
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_ROLE_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET: (*candidate_shape, 2),
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_MASK: candidate_shape,
    }
    for row in rows:
        expected_dtype = (
            TargetTensorDTypeV1.IEEE754_BINARY32_LE
            if row.field in _FLOAT_TARGET_FIELDS
            else TargetTensorDTypeV1.SIGNED_INT64_LE
            if row.field in _INDEX_TARGET_FIELDS
            else TargetTensorDTypeV1.BOOL_U8
        )
        if row.dtype is not expected_dtype:
            raise ValueError(f"{row.field.value} has the wrong fixed V1 dtype")
        if row.shape != expected_shapes[row.field]:
            raise ValueError(f"{row.field.value} has the wrong fixed V1 shape")


@dataclass(frozen=True, slots=True)
class TrainingExampleManifestV3(_CanonicalContract):
    """Exact non-authorizing TRAIN/DEV receipt, trust, and target binding."""

    source_id: str
    source_asset_sha256: str
    root_asset_sha256: str
    parent_asset_sha256: str | None
    split: TrainingSplitV1
    match_id: str
    venue_id: str
    capture_profile_id: str
    capture_profile_sha256: str
    capture_mode: TrainingCaptureModeV1
    camera_setup_id: str
    recording_date: str
    ball_design_id: str
    lighting_condition_id: str
    synchronized_capture_group_id: str
    split_group_id: str
    leakage_group_sha256: str
    camera_risk_key_sha256: str
    capture_risk_tags: tuple[CaptureRiskTagV1, ...]
    compression_stratum: CompressionStratumV1
    encoder_configuration_sha256: str
    protected_training_configuration_generation_sha256: str
    capture_classification_current_pin_set_sha256: str
    capture_classification_generation_id: str
    capture_profile_classification_sha256: str
    source_representation: SourceRepresentationV1
    source_classification: CaptureSourceClassificationV1
    artifact_generation_id: str
    source_byte_length: int
    finalized_trace_sha256: str
    capture_policy_sha256: str
    capture_policy_generation: int
    decoder_runtime_generation_id: str
    decoder_runtime_manifest_sha256: str
    decoder_runtime_id: str
    decoder_recipe_sha256: str
    decode_contract_sha256: str
    selected_video_stream_index: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    label_pack_generation_id: str
    label_pack_sha256: str
    label_bundle_statement_sha256: str
    bundle_id: str
    curator_attestation_sha256: str
    curator_trust_snapshot_sha256: str
    curator_trust_snapshot_generation: int
    requested_truth_policy: AnnotationMinimumTruthPolicy
    annotation_attestation_set_sha256: str
    annotation_trust_store_sha256: str
    annotation_verification_policy_sha256: str
    annotation_configuration_generation_sha256: str
    annotation_evidence_set_sha256: str
    annotation_evidence_generation_id: str
    protected_verified_at_ns: int
    rights_decision_sha256: str
    rights_attestation_sha256: str
    rights_evidence_generation_id: str
    rights_trust_store_sha256: str
    rights_verification_policy_sha256: str
    rights_verified_on: str
    clip_input_receipt_sha256: str
    input_encoding_sha256: str
    input_tensor_sha256: str
    frame_identity_sequence_sha256: str
    decoded_frame_sequence_sha256: str
    target_encoding_sha256: str
    target_tensor_set_sha256: str
    target_tensor_rows: tuple[TargetTensorContentRowV1, ...]
    frame_count: int
    output_width: int
    output_height: int
    primary_sampling_stratum: PrimarySamplingStratumV1
    example_stratum_tags: tuple[ExampleStratumTagV1, ...]
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_EXAMPLE_SCHEMA_VERSION

    _DOMAIN = TRAINING_EXAMPLE_DOMAIN
    _LABEL = "training example manifest"
    _MAXIMUM_BYTES = MAX_EXAMPLE_CONTRACT_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(
            self.schema_version,
            label="training example",
            expected=TRAINING_EXAMPLE_SCHEMA_VERSION,
        )
        for field_name in (
            "source_id",
            "match_id",
            "venue_id",
            "capture_profile_id",
            "camera_setup_id",
            "ball_design_id",
            "lighting_condition_id",
            "synchronized_capture_group_id",
            "split_group_id",
            "bundle_id",
            "decoder_runtime_id",
        ):
            require_stable_id(getattr(self, field_name), field_name)
        if type(self.split) is not TrainingSplitV1:
            raise ValueError("training example split must be TRAIN or DEV")
        if type(self.capture_mode) is not TrainingCaptureModeV1:
            raise ValueError("capture_mode has the wrong exact enum type")
        if type(self.compression_stratum) is not CompressionStratumV1:
            raise ValueError("compression_stratum has the wrong exact enum type")
        if type(self.source_representation) is not SourceRepresentationV1:
            raise ValueError("source_representation has the wrong exact enum type")
        if type(self.source_classification) is not CaptureSourceClassificationV1:
            raise ValueError("source_classification has the wrong exact enum type")
        if type(self.primary_sampling_stratum) is not PrimarySamplingStratumV1:
            raise ValueError("primary_sampling_stratum has the wrong exact enum type")
        _require_date(self.recording_date, "recording_date")
        for field_name in ("source_asset_sha256", "root_asset_sha256"):
            require_sha256(getattr(self, field_name), field_name)
        if self.parent_asset_sha256 is not None:
            require_sha256(self.parent_asset_sha256, "parent_asset_sha256")
            if self.parent_asset_sha256 == self.source_asset_sha256:
                raise ValueError("source asset cannot name itself as its parent")
        if self.parent_asset_sha256 is None:
            if self.source_asset_sha256 != self.root_asset_sha256:
                raise ValueError("root examples must bind equal source and root asset digests")
        elif self.source_asset_sha256 == self.root_asset_sha256:
            raise ValueError("derived examples cannot alias source and root asset digests")
        typed_digest_fields = (
            "capture_profile_sha256",
            "leakage_group_sha256",
            "camera_risk_key_sha256",
            "encoder_configuration_sha256",
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
            "artifact_generation_id",
            "finalized_trace_sha256",
            "capture_policy_sha256",
            "decoder_runtime_generation_id",
            "decoder_runtime_manifest_sha256",
            "decoder_recipe_sha256",
            "decode_contract_sha256",
            "label_pack_generation_id",
            "label_pack_sha256",
            "label_bundle_statement_sha256",
            "curator_attestation_sha256",
            "curator_trust_snapshot_sha256",
            "annotation_attestation_set_sha256",
            "annotation_trust_store_sha256",
            "annotation_verification_policy_sha256",
            "annotation_configuration_generation_sha256",
            "annotation_evidence_set_sha256",
            "annotation_evidence_generation_id",
            "rights_decision_sha256",
            "rights_attestation_sha256",
            "rights_evidence_generation_id",
            "rights_trust_store_sha256",
            "rights_verification_policy_sha256",
            "clip_input_receipt_sha256",
            "input_encoding_sha256",
            "input_tensor_sha256",
            "frame_identity_sequence_sha256",
            "decoded_frame_sequence_sha256",
            "target_encoding_sha256",
            "target_tensor_set_sha256",
        )
        _require_distinct_digests(
            tuple((field_name, getattr(self, field_name)) for field_name in typed_digest_fields),
            label="training example",
        )
        lineage_digests = {
            self.source_asset_sha256,
            self.root_asset_sha256,
            *(() if self.parent_asset_sha256 is None else (self.parent_asset_sha256,)),
        }
        proof_digests = {getattr(self, field_name) for field_name in typed_digest_fields}
        if lineage_digests.intersection(proof_digests):
            raise ValueError("proof and asset-lineage digest roles must not alias")
        expected_leakage = leakage_group_sha256_v1(
            match_id=self.match_id,
            root_asset_sha256=self.root_asset_sha256,
            synchronized_capture_group_id=self.synchronized_capture_group_id,
            split_group_id=self.split_group_id,
            venue_id=self.venue_id,
            camera_setup_id=self.camera_setup_id,
            recording_date=self.recording_date,
        )
        if self.leakage_group_sha256 != expected_leakage:
            raise ValueError("leakage_group_sha256 does not bind its exact inputs")
        expected_risk_key = camera_risk_key_sha256_v2(
            capture_mode=self.capture_mode,
            camera_setup_id=self.camera_setup_id,
            capture_profile_sha256=self.capture_profile_sha256,
            lighting_condition_id=self.lighting_condition_id,
            encoder_configuration_sha256=self.encoder_configuration_sha256,
            source_representation=self.source_representation,
            source_classification=self.source_classification,
        )
        if self.camera_risk_key_sha256 != expected_risk_key:
            raise ValueError("camera_risk_key_sha256 does not bind its exact inputs")
        _require_canonical_enum_tuple(
            self.capture_risk_tags,
            "capture_risk_tags",
            enum_type=CaptureRiskTagV1,
        )
        if (
            self.capture_mode is TrainingCaptureModeV1.HD_1080P30
            and CaptureRiskTagV1.COMPATIBILITY_1080P30 not in self.capture_risk_tags
        ):
            raise ValueError("1080P30 examples must carry compatibility risk")
        if (
            self.capture_mode
            in {
                TrainingCaptureModeV1.HD_1080P30,
                TrainingCaptureModeV1.HD_1080P60,
                TrainingCaptureModeV1.UHD_4K60,
            }
            and CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION not in self.capture_risk_tags
        ):
            raise ValueError("single-view examples must carry occlusion risk")
        if (
            self.compression_stratum is CompressionStratumV1.CONSTRAINED_INTERFRAME
            and CaptureRiskTagV1.HIGH_COMPRESSION not in self.capture_risk_tags
        ):
            raise ValueError("constrained compression must carry high-compression risk")
        _require_date(self.rights_verified_on, "rights_verified_on")
        if type(self.requested_truth_policy) is not AnnotationMinimumTruthPolicy:
            raise ValueError(
                "requested_truth_policy must be an AnnotationMinimumTruthPolicy"
            )
        require_exact_int(
            self.source_byte_length,
            "source_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        require_exact_int(
            self.capture_policy_generation,
            "capture_policy_generation",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.curator_trust_snapshot_generation,
            "curator_trust_snapshot_generation",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.protected_verified_at_ns,
            "protected_verified_at_ns",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        numerator = require_exact_int(
            self.source_time_base_numerator,
            "source_time_base_numerator",
            minimum=1,
            maximum=MAX_SIGNED_64,
        )
        denominator = require_exact_int(
            self.source_time_base_denominator,
            "source_time_base_denominator",
            minimum=1,
            maximum=MAX_SIGNED_64,
        )
        if math.gcd(numerator, denominator) != 1:
            raise ValueError("source time base must be a reduced positive rational")
        if self.input_encoding_sha256 != CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256:
            raise ValueError("input_encoding_sha256 is not the fixed V1 encoding")
        if self.target_encoding_sha256 != CAUSAL_BALL_TARGET_ENCODING_SHA256:
            raise ValueError("target_encoding_sha256 is not the fixed V1 encoding")
        require_exact_int(
            self.frame_count,
            "frame_count",
            minimum=1,
            maximum=CAUSAL_BALL_MAX_FRAMES,
        )
        require_exact_int(
            self.output_width,
            "output_width",
            minimum=16,
            maximum=CAUSAL_BALL_MAX_WIDTH,
        )
        require_exact_int(
            self.output_height,
            "output_height",
            minimum=16,
            maximum=CAUSAL_BALL_MAX_HEIGHT,
        )
        if (
            self.output_width % CAUSAL_BALL_HEATMAP_STRIDE
            or self.output_height % CAUSAL_BALL_HEATMAP_STRIDE
        ):
            raise ValueError("output dimensions must be divisible by four")
        if (
            self.frame_count * self.output_width * self.output_height
            > CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS
        ):
            raise ValueError("training example exceeds the aggregate pixel bound")
        _validate_target_tensor_rows_for_example(
            self.target_tensor_rows,
            frame_count=self.frame_count,
            output_width=self.output_width,
            output_height=self.output_height,
        )
        if self.target_tensor_set_sha256 != target_tensor_set_sha256_v1(
            self.target_tensor_rows
        ):
            raise ValueError("target_tensor_set_sha256 does not bind target rows")
        if lineage_digests.union(proof_digests).intersection(
            row.content_sha256 for row in self.target_tensor_rows
        ):
            raise ValueError("target content and proof/lineage digest roles must not alias")
        _require_canonical_enum_tuple(
            self.example_stratum_tags,
            "example_stratum_tags",
            enum_type=ExampleStratumTagV1,
            minimum=1,
        )
        if self.primary_sampling_stratum is not derive_primary_sampling_stratum_v1(
            self.example_stratum_tags
        ):
            raise ValueError(
                "primary_sampling_stratum does not match the fixed V1 tag derivation"
            )
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            field_name: getattr(self, field_name)
            for field_name in self.__dataclass_fields__
            if not field_name.startswith("_")
        }
        payload.update(_authority_flags_dict(self))
        payload["domain"] = self._DOMAIN
        payload["split"] = self.split.value
        payload["capture_mode"] = self.capture_mode.value
        payload["compression_stratum"] = self.compression_stratum.value
        payload["source_representation"] = self.source_representation.value
        payload["source_classification"] = self.source_classification.value
        payload["requested_truth_policy"] = self.requested_truth_policy.value
        payload["primary_sampling_stratum"] = self.primary_sampling_stratum.value
        payload["capture_risk_tags"] = [item.value for item in self.capture_risk_tags]
        payload["example_stratum_tags"] = [item.value for item in self.example_stratum_tags]
        payload["target_tensor_rows"] = [item.to_dict() for item in self.target_tensor_rows]
        return payload

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingExampleManifestV3":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=6,
                maximum_nodes=1024,
                maximum_containers=64,
            )
            fields["split"] = enum_from_json(TrainingSplitV1, fields["split"], "split")
            fields["capture_mode"] = enum_from_json(
                TrainingCaptureModeV1, fields["capture_mode"], "capture_mode"
            )
            fields["compression_stratum"] = enum_from_json(
                CompressionStratumV1, fields["compression_stratum"], "compression_stratum"
            )
            fields["source_representation"] = enum_from_json(
                SourceRepresentationV1,
                fields["source_representation"],
                "source_representation",
            )
            fields["source_classification"] = enum_from_json(
                CaptureSourceClassificationV1,
                fields["source_classification"],
                "source_classification",
            )
            fields["requested_truth_policy"] = enum_from_json(
                AnnotationMinimumTruthPolicy,
                fields["requested_truth_policy"],
                "requested_truth_policy",
            )
            fields["primary_sampling_stratum"] = enum_from_json(
                PrimarySamplingStratumV1,
                fields["primary_sampling_stratum"],
                "primary_sampling_stratum",
            )
            for field_name, enum_type in (
                ("capture_risk_tags", CaptureRiskTagV1),
                ("example_stratum_tags", ExampleStratumTagV1),
            ):
                raw_values = exact_list(fields, field_name, label=cls._LABEL)
                fields[field_name] = tuple(
                    enum_from_json(enum_type, item, field_name) for item in raw_values
                )
            raw_rows = exact_list(fields, "target_tensor_rows", label=cls._LABEL)
            if len(raw_rows) > MAX_TARGET_TENSOR_ROWS:
                raise ValueError("too many target tensor rows")
            fields["target_tensor_rows"] = tuple(
                TargetTensorContentRowV1.from_dict(
                    row, label=f"target_tensor_rows[{index}]"
                )
                for index, row in enumerate(raw_rows)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_EXAMPLE_SHAPE", "training example fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_EXAMPLE_WIRE", "training example did not reconstruct exactly")
        return result


@dataclass(frozen=True, slots=True)
class TrainingExampleReferenceV1:
    source_id: str
    split: TrainingSplitV1
    example_manifest_sha256: str
    leakage_group_sha256: str
    frame_count: int
    primary_sampling_stratum: PrimarySamplingStratumV1
    example_stratum_tags: tuple[ExampleStratumTagV1, ...]

    def __post_init__(self) -> None:
        require_stable_id(self.source_id, "source_id")
        if type(self.split) is not TrainingSplitV1:
            raise ValueError("example reference split must be TRAIN or DEV")
        if type(self.primary_sampling_stratum) is not PrimarySamplingStratumV1:
            raise ValueError("primary sampling stratum has the wrong exact type")
        _require_distinct_digests(
            (
                ("example_manifest_sha256", self.example_manifest_sha256),
                ("leakage_group_sha256", self.leakage_group_sha256),
            ),
            label="example reference",
        )
        require_exact_int(
            self.frame_count,
            "frame_count",
            minimum=1,
            maximum=CAUSAL_BALL_MAX_FRAMES,
        )
        _require_canonical_enum_tuple(
            self.example_stratum_tags,
            "example_stratum_tags",
            enum_type=ExampleStratumTagV1,
            minimum=1,
        )
        if self.primary_sampling_stratum is not derive_primary_sampling_stratum_v1(
            self.example_stratum_tags
        ):
            raise ValueError(
                "primary sampling stratum does not match the fixed V1 tag derivation"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "example_manifest_sha256": self.example_manifest_sha256,
            "example_stratum_tags": [item.value for item in self.example_stratum_tags],
            "frame_count": self.frame_count,
            "leakage_group_sha256": self.leakage_group_sha256,
            "primary_sampling_stratum": self.primary_sampling_stratum.value,
            "source_id": self.source_id,
            "split": self.split.value,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "TrainingExampleReferenceV1":
        fields = require_exact_fields(
            value,
            {
                "source_id",
                "split",
                "example_manifest_sha256",
                "leakage_group_sha256",
                "frame_count",
                "primary_sampling_stratum",
                "example_stratum_tags",
            },
            label=label,
        )
        raw_tags = fields["example_stratum_tags"]
        if type(raw_tags) is not list:
            raise ValueError(f"{label}.example_stratum_tags must be an array")
        return cls(
            source_id=fields["source_id"],
            split=enum_from_json(TrainingSplitV1, fields["split"], "split"),
            example_manifest_sha256=fields["example_manifest_sha256"],
            leakage_group_sha256=fields["leakage_group_sha256"],
            frame_count=fields["frame_count"],
            primary_sampling_stratum=enum_from_json(
                PrimarySamplingStratumV1,
                fields["primary_sampling_stratum"],
                "primary_sampling_stratum",
            ),
            example_stratum_tags=tuple(
                enum_from_json(ExampleStratumTagV1, item, "example_stratum_tags")
                for item in raw_tags
            ),
        )


def training_example_reference_set_sha256_v1(
    references: tuple[TrainingExampleReferenceV1, ...],
) -> str:
    _validate_example_references(references)
    return _fingerprint(
        {
            "domain": TRAINING_EXAMPLE_REFERENCE_SET_DOMAIN,
            "references": [item.to_dict() for item in references],
            "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
        },
        label="training example reference set",
        maximum_bytes=MAX_TRAINING_CONTRACT_BYTES,
    )


def _validate_example_references(
    references: tuple[TrainingExampleReferenceV1, ...],
) -> None:
    _require_exact_tuple(
        references,
        "example_references",
        minimum=2,
        maximum=MAX_TRAINING_EXAMPLES,
        exact_type=TrainingExampleReferenceV1,
    )
    expected = tuple(
        sorted(
            references,
            key=lambda item: (
                _SPLIT_ORDER[item.split],
                item.source_id,
                item.example_manifest_sha256,
            ),
        )
    )
    if references != expected:
        raise ValueError("example references must use canonical TRAIN-then-DEV source order")
    source_ids = tuple(item.source_id for item in references)
    example_sha256s = tuple(item.example_manifest_sha256 for item in references)
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("example reference source IDs must be unique")
    if len(example_sha256s) != len(set(example_sha256s)):
        raise ValueError("example manifest digests must be unique")
    leakage_sha256s = {item.leakage_group_sha256 for item in references}
    if set(example_sha256s).intersection(leakage_sha256s):
        raise ValueError("example and leakage-group digest roles must not alias")
    if {item.split for item in references} != {
        TrainingSplitV1.TRAIN,
        TrainingSplitV1.DEV,
    }:
        raise ValueError("example references must include both TRAIN and DEV")


@dataclass(frozen=True, slots=True)
class TrainingDatasetManifestV1(_CanonicalContract):
    """Immutable admitted-corpus record; it is deliberately not authority."""

    dataset_id: str
    readiness_manifest_sha256: str
    readiness_report_sha256: str
    protected_configuration_generation_sha256: str
    admission_policy_sha256: str
    artifact_generation_id: str
    rights_evidence_generation_id: str
    source_rights_proof_set_sha256: str
    source_label_pack_proof_set_sha256: str
    split_manifest_sha256: str
    test_exclusion_commitment_sha256: str
    test_source_count: int
    test_label_pack_count: int
    coverage_report_sha256: str
    example_reference_set_sha256: str
    example_references: tuple[TrainingExampleReferenceV1, ...]
    train_example_count: int
    dev_example_count: int
    train_frame_count: int
    dev_frame_count: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_DATASET_MANIFEST_DOMAIN
    _LABEL = "training dataset manifest"
    _MAXIMUM_BYTES = MAX_TRAINING_CONTRACT_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training dataset manifest")
        require_stable_id(self.dataset_id, "dataset_id")
        digest_fields = (
            "readiness_manifest_sha256",
            "readiness_report_sha256",
            "protected_configuration_generation_sha256",
            "admission_policy_sha256",
            "artifact_generation_id",
            "rights_evidence_generation_id",
            "source_rights_proof_set_sha256",
            "source_label_pack_proof_set_sha256",
            "split_manifest_sha256",
            "test_exclusion_commitment_sha256",
            "coverage_report_sha256",
            "example_reference_set_sha256",
        )
        _require_distinct_digests(
            tuple((field_name, getattr(self, field_name)) for field_name in digest_fields),
            label="training dataset manifest",
        )
        require_exact_int(
            self.test_source_count,
            "test_source_count",
            minimum=1,
            maximum=MAX_TRAINING_EXAMPLES,
        )
        require_exact_int(
            self.test_label_pack_count,
            "test_label_pack_count",
            minimum=1,
            maximum=MAX_TRAINING_EXAMPLES,
        )
        if self.test_label_pack_count != self.test_source_count:
            raise ValueError("TEST source and structural label-pack counts must match")
        _validate_example_references(self.example_references)
        if len(self.example_references) + self.test_source_count > MAX_TRAINING_EXAMPLES:
            raise ValueError("TRAIN/DEV and TEST sources exceed the readiness corpus bound")
        if self.example_reference_set_sha256 != training_example_reference_set_sha256_v1(
            self.example_references
        ):
            raise ValueError("example_reference_set_sha256 does not bind references")
        top_level = {getattr(self, name) for name in digest_fields}
        reference_digests = {
            digest
            for item in self.example_references
            for digest in (
                item.example_manifest_sha256,
                item.leakage_group_sha256,
            )
        }
        if top_level.intersection(reference_digests):
            raise ValueError("reference and dataset-level typed digest roles must not alias")
        expected_train = sum(
            item.split is TrainingSplitV1.TRAIN for item in self.example_references
        )
        expected_dev = len(self.example_references) - expected_train
        expected_train_frames = sum(
            item.frame_count
            for item in self.example_references
            if item.split is TrainingSplitV1.TRAIN
        )
        expected_dev_frames = sum(
            item.frame_count
            for item in self.example_references
            if item.split is TrainingSplitV1.DEV
        )
        for field_name, expected, maximum in (
            ("train_example_count", expected_train, MAX_TRAINING_EXAMPLES),
            ("dev_example_count", expected_dev, MAX_TRAINING_EXAMPLES),
            ("train_frame_count", expected_train_frames, MAX_TRAINING_FRAMES),
            ("dev_frame_count", expected_dev_frames, MAX_TRAINING_FRAMES),
        ):
            require_exact_int(getattr(self, field_name), field_name, minimum=1, maximum=maximum)
            if getattr(self, field_name) != expected:
                raise ValueError(f"{field_name} does not equal the exact reference total")
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "admission_policy_sha256": self.admission_policy_sha256,
            "artifact_generation_id": self.artifact_generation_id,
            "coverage_report_sha256": self.coverage_report_sha256,
            "dataset_id": self.dataset_id,
            "dev_example_count": self.dev_example_count,
            "dev_frame_count": self.dev_frame_count,
            "domain": self._DOMAIN,
            "example_reference_set_sha256": self.example_reference_set_sha256,
            "example_references": [item.to_dict() for item in self.example_references],
            "protected_configuration_generation_sha256": (
                self.protected_configuration_generation_sha256
            ),
            "readiness_manifest_sha256": self.readiness_manifest_sha256,
            "readiness_report_sha256": self.readiness_report_sha256,
            "rights_evidence_generation_id": self.rights_evidence_generation_id,
            "schema_version": self.schema_version,
            "source_label_pack_proof_set_sha256": (
                self.source_label_pack_proof_set_sha256
            ),
            "source_rights_proof_set_sha256": self.source_rights_proof_set_sha256,
            "split_manifest_sha256": self.split_manifest_sha256,
            "test_exclusion_commitment_sha256": self.test_exclusion_commitment_sha256,
            "test_label_pack_count": self.test_label_pack_count,
            "test_source_count": self.test_source_count,
            "train_example_count": self.train_example_count,
            "train_frame_count": self.train_frame_count,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingDatasetManifestV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=7,
                maximum_nodes=20_000,
                maximum_containers=2_000,
            )
            raw_references = exact_list(fields, "example_references", label=cls._LABEL)
            if len(raw_references) > MAX_TRAINING_EXAMPLES:
                raise ValueError("too many training example references")
            fields["example_references"] = tuple(
                TrainingExampleReferenceV1.from_dict(
                    value, label=f"example_references[{index}]"
                )
                for index, value in enumerate(raw_references)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_DATASET_MANIFEST_SHAPE",
                "training dataset manifest fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "TRAIN_ADMISSION_DATASET_MANIFEST_WIRE",
                "training dataset manifest did not reconstruct exactly",
            )
        return result


@dataclass(frozen=True, slots=True)
class TrainingRunRequestV1(_CanonicalContract):
    """Bounded request for one fixed causal-ball training configuration."""

    run_id: str
    requested_at_utc: str
    not_after_utc: str
    model_config_sha256: str
    loss_config_sha256: str
    optimizer_config_sha256: str
    trainer_source_tree_sha256: str
    environment_lock_sha256: str
    seed: int
    maximum_epochs: int
    maximum_steps: int
    base_weights_sha256: str | None
    base_weights_license_proof_sha256: str | None
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_RUN_REQUEST_DOMAIN
    _LABEL = "training run request"
    _MAXIMUM_BYTES = MAX_RUN_REQUEST_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training run request")
        require_stable_id(self.run_id, "run_id")
        requested_at = _require_utc_second(self.requested_at_utc, "requested_at_utc")
        not_after = _require_utc_second(self.not_after_utc, "not_after_utc")
        if not_after <= requested_at:
            raise ValueError("not_after_utc must be later than requested_at_utc")
        digest_fields: list[tuple[str, str | None]] = [
            ("model_config_sha256", self.model_config_sha256),
            ("loss_config_sha256", self.loss_config_sha256),
            ("optimizer_config_sha256", self.optimizer_config_sha256),
            ("trainer_source_tree_sha256", self.trainer_source_tree_sha256),
            ("environment_lock_sha256", self.environment_lock_sha256),
            ("base_weights_sha256", self.base_weights_sha256),
            (
                "base_weights_license_proof_sha256",
                self.base_weights_license_proof_sha256,
            ),
        ]
        _require_distinct_digests(digest_fields, label="training run request")
        if self.model_config_sha256 != CAUSAL_BALL_MODEL_CONFIG_SHA256:
            raise ValueError("model_config_sha256 is not the fixed V1 configuration")
        if self.loss_config_sha256 != CAUSAL_BALL_LOSS_CONFIG_SHA256:
            raise ValueError("loss_config_sha256 is not the fixed V1 configuration")
        if self.optimizer_config_sha256 != CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256:
            raise ValueError("optimizer_config_sha256 is not the fixed V1 configuration")
        if (self.base_weights_sha256 is None) is not (
            self.base_weights_license_proof_sha256 is None
        ):
            raise ValueError("base weights and their license proof must be both present or absent")
        require_exact_int(self.seed, "seed", minimum=0, maximum=MAX_SIGNED_64)
        require_exact_int(
            self.maximum_epochs,
            "maximum_epochs",
            minimum=1,
            maximum=MAX_SAMPLING_EPOCHS,
        )
        require_exact_int(
            self.maximum_steps,
            "maximum_steps",
            minimum=1,
            maximum=MAX_SCHEDULE_ROWS,
        )
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "base_weights_license_proof_sha256": self.base_weights_license_proof_sha256,
            "base_weights_sha256": self.base_weights_sha256,
            "domain": self._DOMAIN,
            "environment_lock_sha256": self.environment_lock_sha256,
            "loss_config_sha256": self.loss_config_sha256,
            "maximum_epochs": self.maximum_epochs,
            "maximum_steps": self.maximum_steps,
            "model_config_sha256": self.model_config_sha256,
            "not_after_utc": self.not_after_utc,
            "optimizer_config_sha256": self.optimizer_config_sha256,
            "requested_at_utc": self.requested_at_utc,
            "run_id": self.run_id,
            "schema_version": self.schema_version,
            "seed": self.seed,
            "trainer_source_tree_sha256": self.trainer_source_tree_sha256,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingRunRequestV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=3,
                maximum_nodes=64,
                maximum_containers=1,
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_RUN_REQUEST_SHAPE", "training run request fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_RUN_REQUEST_WIRE", "run request did not reconstruct exactly")
        return result


@dataclass(frozen=True, slots=True)
class StratumQuotaV1:
    stratum: PrimarySamplingStratumV1
    weight_ppm: int
    minimum_draws_per_epoch: int

    def __post_init__(self) -> None:
        if type(self.stratum) is not PrimarySamplingStratumV1:
            raise ValueError("sampling quota stratum has the wrong exact enum type")
        require_exact_int(self.weight_ppm, "weight_ppm", minimum=0, maximum=PPM)
        require_exact_int(
            self.minimum_draws_per_epoch,
            "minimum_draws_per_epoch",
            minimum=0,
            maximum=MAX_TRAINING_EXAMPLES,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "minimum_draws_per_epoch": self.minimum_draws_per_epoch,
            "stratum": self.stratum.value,
            "weight_ppm": self.weight_ppm,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "StratumQuotaV1":
        fields = require_exact_fields(
            value,
            {"stratum", "weight_ppm", "minimum_draws_per_epoch"},
            label=label,
        )
        return cls(
            stratum=enum_from_json(
                PrimarySamplingStratumV1, fields["stratum"], "stratum"
            ),
            weight_ppm=fields["weight_ppm"],
            minimum_draws_per_epoch=fields["minimum_draws_per_epoch"],
        )


@dataclass(frozen=True, slots=True)
class StratifiedSamplingPlanV1(_CanonicalContract):
    """Declarative integer-only, group-aware TRAIN sampling policy.

    A later trusted compiler must resolve quotas, eligible membership, ranking,
    and group caps against the exact dataset; this value grants no such proof.
    """

    dataset_manifest_sha256: str
    seed: int
    epoch_count: int
    train_draws_per_epoch: int
    maximum_leakage_group_draws_ppm: int
    stratum_quotas: tuple[StratumQuotaV1, ...]
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = STRATIFIED_SAMPLING_PLAN_DOMAIN
    _LABEL = "stratified sampling plan"
    _MAXIMUM_BYTES = MAX_SAMPLING_PLAN_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="stratified sampling plan")
        require_sha256(self.dataset_manifest_sha256, "dataset_manifest_sha256")
        require_exact_int(self.seed, "seed", minimum=0, maximum=MAX_SIGNED_64)
        require_exact_int(
            self.epoch_count, "epoch_count", minimum=1, maximum=MAX_SAMPLING_EPOCHS
        )
        require_exact_int(
            self.train_draws_per_epoch,
            "train_draws_per_epoch",
            minimum=1,
            maximum=MAX_TRAINING_EXAMPLES,
        )
        if self.epoch_count * self.train_draws_per_epoch > MAX_SCHEDULE_ROWS:
            raise ValueError("sampling plan exceeds the bounded schedule row budget")
        require_exact_int(
            self.maximum_leakage_group_draws_ppm,
            "maximum_leakage_group_draws_ppm",
            minimum=1,
            maximum=PPM,
        )
        _require_exact_tuple(
            self.stratum_quotas,
            "stratum_quotas",
            minimum=len(PrimarySamplingStratumV1),
            maximum=len(PrimarySamplingStratumV1),
            exact_type=StratumQuotaV1,
        )
        if tuple(item.stratum for item in self.stratum_quotas) != tuple(
            PrimarySamplingStratumV1
        ):
            raise ValueError("stratum quotas must contain every stratum in canonical order")
        if sum(item.weight_ppm for item in self.stratum_quotas) != PPM:
            raise ValueError("stratum quota weights must sum to exactly one million ppm")
        if sum(item.minimum_draws_per_epoch for item in self.stratum_quotas) > (
            self.train_draws_per_epoch
        ):
            raise ValueError("minimum stratum draws exceed train_draws_per_epoch")
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "dataset_manifest_sha256": self.dataset_manifest_sha256,
            "dev_order": "ALL_DEV_EXACTLY_ONCE_CANONICAL_EXAMPLE_REFERENCE_ORDER",
            "domain": self._DOMAIN,
            "epoch_count": self.epoch_count,
            "grouping_key": "LEAKAGE_GROUP_SHA256",
            "maximum_leakage_group_draws_ppm": self.maximum_leakage_group_draws_ppm,
            "ranking_algorithm": "SHA256_ASCENDING_UNSIGNED_BYTES",
            "ranking_domain": TRAINING_SCHEDULE_RANKING_DOMAIN,
            "sampling_unit": "WHOLE_TRAINING_EXAMPLE",
            "schema_version": self.schema_version,
            "seed": self.seed,
            "stratum_quotas": [item.to_dict() for item in self.stratum_quotas],
            "train_draws_per_epoch": self.train_draws_per_epoch,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "StratifiedSamplingPlanV1":
        literals = {
            "dev_order": "ALL_DEV_EXACTLY_ONCE_CANONICAL_EXAMPLE_REFERENCE_ORDER",
            "grouping_key": "LEAKAGE_GROUP_SHA256",
            "ranking_algorithm": "SHA256_ASCENDING_UNSIGNED_BYTES",
            "ranking_domain": TRAINING_SCHEDULE_RANKING_DOMAIN,
            "sampling_unit": "WHOLE_TRAINING_EXAMPLE",
        }
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={
                    *{name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                    *literals,
                },
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=5,
                maximum_nodes=256,
                maximum_containers=16,
            )
            for field_name, expected in literals.items():
                if fields.pop(field_name) != expected:
                    raise ValueError(f"{field_name} is not the fixed V1 value")
            raw_quotas = exact_list(fields, "stratum_quotas", label=cls._LABEL)
            if len(raw_quotas) > len(PrimarySamplingStratumV1):
                raise ValueError("too many stratum quotas")
            fields["stratum_quotas"] = tuple(
                StratumQuotaV1.from_dict(value, label=f"stratum_quotas[{index}]")
                for index, value in enumerate(raw_quotas)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_SAMPLING_PLAN_SHAPE", "sampling plan fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_SAMPLING_PLAN_WIRE", "sampling plan did not reconstruct exactly")
        return result


def training_schedule_ranking_sha256_v1(
    *,
    dataset_manifest_sha256: str,
    sampling_plan_sha256: str,
    seed: int,
    epoch_index: int,
    draw_index: int,
    stratum: PrimarySamplingStratumV1,
    leakage_group_sha256: str,
    example_manifest_sha256: str,
) -> str:
    _require_distinct_digests(
        (
            ("dataset_manifest_sha256", dataset_manifest_sha256),
            ("sampling_plan_sha256", sampling_plan_sha256),
            ("leakage_group_sha256", leakage_group_sha256),
            ("example_manifest_sha256", example_manifest_sha256),
        ),
        label="training schedule ranking input",
    )
    require_exact_int(seed, "seed", minimum=0, maximum=MAX_SIGNED_64)
    require_exact_int(
        epoch_index, "epoch_index", minimum=0, maximum=MAX_SAMPLING_EPOCHS - 1
    )
    require_exact_int(
        draw_index, "draw_index", minimum=0, maximum=MAX_TRAINING_EXAMPLES - 1
    )
    if type(stratum) is not PrimarySamplingStratumV1:
        raise ValueError("stratum must be an exact PrimarySamplingStratumV1")
    return _fingerprint(
        {
            "dataset_manifest_sha256": dataset_manifest_sha256,
            "domain": TRAINING_SCHEDULE_RANKING_DOMAIN,
            "draw_index": draw_index,
            "epoch_index": epoch_index,
            "example_manifest_sha256": example_manifest_sha256,
            "leakage_group_sha256": leakage_group_sha256,
            "sampling_plan_sha256": sampling_plan_sha256,
            "schema_version": TRAINING_ADMISSION_SCHEMA_VERSION,
            "seed": seed,
            "stratum": stratum.value,
        },
        label="training schedule ranking input",
        maximum_bytes=MAX_POLICY_CONTRACT_BYTES,
    )


@dataclass(frozen=True, slots=True)
class TrainingScheduleDrawV1:
    epoch_index: int
    draw_index: int
    stratum: PrimarySamplingStratumV1
    leakage_group_sha256: str
    example_manifest_sha256: str
    ranking_sha256: str

    def __post_init__(self) -> None:
        require_exact_int(
            self.epoch_index,
            "epoch_index",
            minimum=0,
            maximum=MAX_SAMPLING_EPOCHS - 1,
        )
        require_exact_int(
            self.draw_index,
            "draw_index",
            minimum=0,
            maximum=MAX_TRAINING_EXAMPLES - 1,
        )
        if type(self.stratum) is not PrimarySamplingStratumV1:
            raise ValueError("schedule stratum has the wrong exact enum type")
        _require_distinct_digests(
            (
                ("leakage_group_sha256", self.leakage_group_sha256),
                ("example_manifest_sha256", self.example_manifest_sha256),
                ("ranking_sha256", self.ranking_sha256),
            ),
            label="training schedule draw",
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "draw_index": self.draw_index,
            "epoch_index": self.epoch_index,
            "example_manifest_sha256": self.example_manifest_sha256,
            "leakage_group_sha256": self.leakage_group_sha256,
            "ranking_sha256": self.ranking_sha256,
            "stratum": self.stratum.value,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "TrainingScheduleDrawV1":
        fields = require_exact_fields(
            value,
            {
                "epoch_index",
                "draw_index",
                "stratum",
                "leakage_group_sha256",
                "example_manifest_sha256",
                "ranking_sha256",
            },
            label=label,
        )
        return cls(
            epoch_index=fields["epoch_index"],
            draw_index=fields["draw_index"],
            stratum=enum_from_json(
                PrimarySamplingStratumV1, fields["stratum"], "stratum"
            ),
            leakage_group_sha256=fields["leakage_group_sha256"],
            example_manifest_sha256=fields["example_manifest_sha256"],
            ranking_sha256=fields["ranking_sha256"],
        )


@dataclass(frozen=True, slots=True)
class DevScheduleEntryV1:
    dev_index: int
    source_id: str
    example_manifest_sha256: str

    def __post_init__(self) -> None:
        require_exact_int(
            self.dev_index,
            "dev_index",
            minimum=0,
            maximum=MAX_TRAINING_EXAMPLES - 1,
        )
        require_stable_id(self.source_id, "source_id")
        require_sha256(self.example_manifest_sha256, "example_manifest_sha256")

    def to_dict(self) -> dict[str, Any]:
        return {
            "dev_index": self.dev_index,
            "example_manifest_sha256": self.example_manifest_sha256,
            "source_id": self.source_id,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "DevScheduleEntryV1":
        fields = require_exact_fields(
            value,
            {"dev_index", "source_id", "example_manifest_sha256"},
            label=label,
        )
        return cls(**fields)


@dataclass(frozen=True, slots=True)
class TrainingSamplingScheduleV1(_CanonicalContract):
    """Structurally bound TRAIN draws and a proposed exact-once DEV order.

    Construction proves row shape, ordering, and ranking preimage bindings.  A
    trusted coordinator must still prove dataset membership, lowest-rank
    selection, quotas, group caps, and completeness before use.
    """

    dataset_manifest_sha256: str
    sampling_plan_sha256: str
    seed: int
    epoch_count: int
    train_draws_per_epoch: int
    train_draws: tuple[TrainingScheduleDrawV1, ...]
    dev_entries: tuple[DevScheduleEntryV1, ...]
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_SAMPLING_SCHEDULE_DOMAIN
    _LABEL = "training sampling schedule"
    _MAXIMUM_BYTES = MAX_TRAINING_CONTRACT_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training sampling schedule")
        _require_distinct_digests(
            (
                ("dataset_manifest_sha256", self.dataset_manifest_sha256),
                ("sampling_plan_sha256", self.sampling_plan_sha256),
            ),
            label="training sampling schedule",
        )
        require_exact_int(self.seed, "seed", minimum=0, maximum=MAX_SIGNED_64)
        require_exact_int(
            self.epoch_count, "epoch_count", minimum=1, maximum=MAX_SAMPLING_EPOCHS
        )
        require_exact_int(
            self.train_draws_per_epoch,
            "train_draws_per_epoch",
            minimum=1,
            maximum=MAX_TRAINING_EXAMPLES,
        )
        expected_draw_count = self.epoch_count * self.train_draws_per_epoch
        if expected_draw_count > MAX_SCHEDULE_ROWS:
            raise ValueError("training schedule exceeds the row bound")
        _require_exact_tuple(
            self.train_draws,
            "train_draws",
            minimum=expected_draw_count,
            maximum=expected_draw_count,
            exact_type=TrainingScheduleDrawV1,
        )
        expected_positions = tuple(
            (epoch, draw)
            for epoch in range(self.epoch_count)
            for draw in range(self.train_draws_per_epoch)
        )
        if tuple((item.epoch_index, item.draw_index) for item in self.train_draws) != (
            expected_positions
        ):
            raise ValueError("training draws must be contiguous in epoch/draw order")
        rankings: list[str] = []
        for item in self.train_draws:
            expected_ranking = training_schedule_ranking_sha256_v1(
                dataset_manifest_sha256=self.dataset_manifest_sha256,
                sampling_plan_sha256=self.sampling_plan_sha256,
                seed=self.seed,
                epoch_index=item.epoch_index,
                draw_index=item.draw_index,
                stratum=item.stratum,
                leakage_group_sha256=item.leakage_group_sha256,
                example_manifest_sha256=item.example_manifest_sha256,
            )
            if item.ranking_sha256 != expected_ranking:
                raise ValueError("training draw ranking_sha256 does not bind its inputs")
            rankings.append(item.ranking_sha256)
        if len(rankings) != len(set(rankings)):
            raise ValueError("training draw ranking digests must be unique")
        for epoch in range(self.epoch_count):
            selected = [
                item.example_manifest_sha256
                for item in self.train_draws
                if item.epoch_index == epoch
            ]
            if len(selected) != len(set(selected)):
                raise ValueError("an example cannot repeat within one training epoch")
        _require_exact_tuple(
            self.dev_entries,
            "dev_entries",
            minimum=1,
            maximum=MAX_TRAINING_EXAMPLES,
            exact_type=DevScheduleEntryV1,
        )
        if tuple(item.dev_index for item in self.dev_entries) != tuple(
            range(len(self.dev_entries))
        ):
            raise ValueError("DEV entries must have contiguous indices")
        dev_pairs = tuple(
            (item.source_id, item.example_manifest_sha256) for item in self.dev_entries
        )
        if dev_pairs != tuple(sorted(dev_pairs)) or len(set(dev_pairs)) != len(dev_pairs):
            raise ValueError("DEV examples must appear in canonical source/example order")
        dev_source_ids = tuple(item.source_id for item in self.dev_entries)
        dev_sha256s = tuple(item.example_manifest_sha256 for item in self.dev_entries)
        if len(set(dev_source_ids)) != len(dev_source_ids) or len(set(dev_sha256s)) != len(
            dev_sha256s
        ):
            raise ValueError("DEV sources and example manifests must each appear exactly once")
        train_sha256s = {item.example_manifest_sha256 for item in self.train_draws}
        train_leakage_sha256s = {
            item.leakage_group_sha256 for item in self.train_draws
        }
        if train_sha256s.intersection(dev_sha256s):
            raise ValueError("TRAIN and DEV example references must be disjoint")
        if train_leakage_sha256s.intersection(train_sha256s | set(dev_sha256s)):
            raise ValueError("schedule leakage-group and example digest roles must not alias")
        if set(rankings).intersection(
            train_leakage_sha256s | train_sha256s | set(dev_sha256s)
        ):
            raise ValueError("schedule ranking and reference digest roles must not alias")
        top_level = {self.dataset_manifest_sha256, self.sampling_plan_sha256}
        if top_level.intersection(
            train_leakage_sha256s
            | train_sha256s
            | set(dev_sha256s)
            | set(rankings)
        ):
            raise ValueError("schedule top-level and row digest roles must not alias")
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "dataset_manifest_sha256": self.dataset_manifest_sha256,
            "dev_entries": [item.to_dict() for item in self.dev_entries],
            "dev_order": "ALL_DEV_EXACTLY_ONCE_CANONICAL_EXAMPLE_REFERENCE_ORDER",
            "domain": self._DOMAIN,
            "epoch_count": self.epoch_count,
            "ranking_algorithm": "SHA256_ASCENDING_UNSIGNED_BYTES",
            "ranking_domain": TRAINING_SCHEDULE_RANKING_DOMAIN,
            "sampling_plan_sha256": self.sampling_plan_sha256,
            "sampling_unit": "WHOLE_TRAINING_EXAMPLE",
            "schema_version": self.schema_version,
            "seed": self.seed,
            "train_draws": [item.to_dict() for item in self.train_draws],
            "train_draws_per_epoch": self.train_draws_per_epoch,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingSamplingScheduleV1":
        literals = {
            "dev_order": "ALL_DEV_EXACTLY_ONCE_CANONICAL_EXAMPLE_REFERENCE_ORDER",
            "ranking_algorithm": "SHA256_ASCENDING_UNSIGNED_BYTES",
            "ranking_domain": TRAINING_SCHEDULE_RANKING_DOMAIN,
            "sampling_unit": "WHOLE_TRAINING_EXAMPLE",
        }
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={
                    *{name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                    *literals,
                },
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=6,
                maximum_nodes=40_000,
                maximum_containers=5_000,
            )
            for field_name, expected in literals.items():
                if fields.pop(field_name) != expected:
                    raise ValueError(f"{field_name} is not the fixed V1 value")
            raw_draws = exact_list(fields, "train_draws", label=cls._LABEL)
            raw_dev = exact_list(fields, "dev_entries", label=cls._LABEL)
            if len(raw_draws) > MAX_SCHEDULE_ROWS or len(raw_dev) > MAX_TRAINING_EXAMPLES:
                raise ValueError("sampling schedule exceeds row bounds")
            fields["train_draws"] = tuple(
                TrainingScheduleDrawV1.from_dict(value, label=f"train_draws[{index}]")
                for index, value in enumerate(raw_draws)
            )
            fields["dev_entries"] = tuple(
                DevScheduleEntryV1.from_dict(value, label=f"dev_entries[{index}]")
                for index, value in enumerate(raw_dev)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_SAMPLING_SCHEDULE_SHAPE",
                "sampling schedule fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "TRAIN_ADMISSION_SAMPLING_SCHEDULE_WIRE",
                "sampling schedule did not reconstruct exactly",
            )
        return result


@dataclass(frozen=True, slots=True)
class TrainingRunManifestV1(_CanonicalContract):
    """Final immutable run binding whose checkpoint role remains quarantined."""

    run_id: str
    run_request_sha256: str
    dataset_manifest_generation_id: str
    dataset_manifest_sha256: str
    sampling_plan_sha256: str
    sampling_schedule_sha256: str
    model_config_sha256: str
    loss_config_sha256: str
    optimizer_config_sha256: str
    trainer_source_tree_sha256: str
    environment_lock_sha256: str
    seed: int
    maximum_epochs: int
    maximum_steps: int
    not_after_utc: str
    base_weights_sha256: str | None
    base_weights_license_proof_sha256: str | None
    output_role: TrainingOutputRoleV1
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_ADMISSION_SCHEMA_VERSION

    _DOMAIN = TRAINING_RUN_MANIFEST_DOMAIN
    _LABEL = "training run manifest"
    _MAXIMUM_BYTES = MAX_RUN_MANIFEST_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label="training run manifest")
        require_stable_id(self.run_id, "run_id")
        _require_utc_second(self.not_after_utc, "not_after_utc")
        digest_fields: list[tuple[str, str | None]] = [
            ("run_request_sha256", self.run_request_sha256),
            ("dataset_manifest_generation_id", self.dataset_manifest_generation_id),
            ("dataset_manifest_sha256", self.dataset_manifest_sha256),
            ("sampling_plan_sha256", self.sampling_plan_sha256),
            ("sampling_schedule_sha256", self.sampling_schedule_sha256),
            ("model_config_sha256", self.model_config_sha256),
            ("loss_config_sha256", self.loss_config_sha256),
            ("optimizer_config_sha256", self.optimizer_config_sha256),
            ("trainer_source_tree_sha256", self.trainer_source_tree_sha256),
            ("environment_lock_sha256", self.environment_lock_sha256),
            ("base_weights_sha256", self.base_weights_sha256),
            (
                "base_weights_license_proof_sha256",
                self.base_weights_license_proof_sha256,
            ),
        ]
        _require_distinct_digests(digest_fields, label="training run manifest")
        if self.model_config_sha256 != CAUSAL_BALL_MODEL_CONFIG_SHA256:
            raise ValueError("run model config is not the fixed V1 configuration")
        if self.loss_config_sha256 != CAUSAL_BALL_LOSS_CONFIG_SHA256:
            raise ValueError("run loss config is not the fixed V1 configuration")
        if self.optimizer_config_sha256 != CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256:
            raise ValueError("run optimizer config is not the fixed V1 configuration")
        if (self.base_weights_sha256 is None) is not (
            self.base_weights_license_proof_sha256 is None
        ):
            raise ValueError("base weights and license proof must be both present or absent")
        require_exact_int(self.seed, "seed", minimum=0, maximum=MAX_SIGNED_64)
        require_exact_int(
            self.maximum_epochs,
            "maximum_epochs",
            minimum=1,
            maximum=MAX_SAMPLING_EPOCHS,
        )
        require_exact_int(
            self.maximum_steps,
            "maximum_steps",
            minimum=1,
            maximum=MAX_SCHEDULE_ROWS,
        )
        if type(self.output_role) is not TrainingOutputRoleV1:
            raise ValueError("output_role is not the fixed quarantined V1 role")
        _require_exact_false_flags(self)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_flags_dict(self),
            "base_weights_license_proof_sha256": self.base_weights_license_proof_sha256,
            "base_weights_sha256": self.base_weights_sha256,
            "dataset_manifest_generation_id": self.dataset_manifest_generation_id,
            "dataset_manifest_sha256": self.dataset_manifest_sha256,
            "domain": self._DOMAIN,
            "environment_lock_sha256": self.environment_lock_sha256,
            "loss_config_sha256": self.loss_config_sha256,
            "maximum_epochs": self.maximum_epochs,
            "maximum_steps": self.maximum_steps,
            "model_config_sha256": self.model_config_sha256,
            "not_after_utc": self.not_after_utc,
            "optimizer_config_sha256": self.optimizer_config_sha256,
            "output_role": self.output_role.value,
            "run_id": self.run_id,
            "run_request_sha256": self.run_request_sha256,
            "sampling_plan_sha256": self.sampling_plan_sha256,
            "sampling_schedule_sha256": self.sampling_schedule_sha256,
            "schema_version": self.schema_version,
            "seed": self.seed,
            "trainer_source_tree_sha256": self.trainer_source_tree_sha256,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingRunManifestV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={name for name in cls.__dataclass_fields__ if not name.startswith("_")},
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=3,
                maximum_nodes=96,
                maximum_containers=1,
            )
            fields["output_role"] = enum_from_json(
                TrainingOutputRoleV1, fields["output_role"], "output_role"
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingAdmissionContractError(
                "TRAIN_ADMISSION_RUN_MANIFEST_SHAPE", "training run manifest fields are invalid"
            ) from exc
        if result.to_json_bytes() != raw:
            _fail("TRAIN_ADMISSION_RUN_MANIFEST_WIRE", "run manifest did not reconstruct exactly")
        return result


__all__ = [
    "CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256",
    "CAUSAL_BALL_HEATMAP_STRIDE",
    "CAUSAL_BALL_LOSS_CONFIG_DOMAIN",
    "CAUSAL_BALL_LOSS_CONFIG_SHA256",
    "CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME",
    "CAUSAL_BALL_MAX_FRAMES",
    "CAUSAL_BALL_MAX_HEIGHT",
    "CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS",
    "CAUSAL_BALL_MAX_WIDTH",
    "CAUSAL_BALL_MODEL_CONFIG_DOMAIN",
    "CAUSAL_BALL_MODEL_CONFIG_SHA256",
    "CAUSAL_BALL_OPTIMIZER_CONFIG_DOMAIN",
    "CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256",
    "CAUSAL_BALL_TARGET_ENCODING_SHA256",
    "CAMERA_RISK_KEY_DOMAIN",
    "CAMERA_RISK_KEY_SCHEMA_VERSION",
    "CaptureSourceClassificationV1",
    "CaptureRiskTagV1",
    "CompressionStratumV1",
    "CoverageRequirementV1",
    "DevScheduleEntryV1",
    "ExampleStratumTagV1",
    "LEAKAGE_GROUP_DOMAIN",
    "MAX_SAMPLING_EPOCHS",
    "MAX_SCHEDULE_ROWS",
    "MAX_TARGET_TENSOR_ROWS",
    "MAX_TEST_EXCLUSION_PREIMAGE_BYTES",
    "MAX_TRAINING_EXAMPLES",
    "PPM",
    "PrimarySamplingStratumV1",
    "SourceRepresentationV1",
    "STRATIFIED_SAMPLING_PLAN_DOMAIN",
    "StratifiedSamplingPlanV1",
    "StratumQuotaV1",
    "TARGET_TENSOR_SET_DOMAIN",
    "TEST_EXCLUSION_COMMITMENT_DOMAIN",
    "TRAINING_ADMISSION_POLICY_DOMAIN",
    "TRAINING_ADMISSION_SCHEMA_VERSION",
    "TRAINING_COVERAGE_REPORT_DOMAIN",
    "TRAINING_DATASET_MANIFEST_DOMAIN",
    "TRAINING_EXAMPLE_DOMAIN",
    "TRAINING_EXAMPLE_SCHEMA_VERSION",
    "TRAINING_RUN_MANIFEST_DOMAIN",
    "TRAINING_RUN_REQUEST_DOMAIN",
    "TRAINING_SAMPLING_SCHEDULE_DOMAIN",
    "TRAINING_SCHEDULE_RANKING_DOMAIN",
    "TargetTensorContentRowV1",
    "TargetTensorDTypeV1",
    "TargetTensorFieldV1",
    "TrainingAdmissionContractError",
    "TrainingAdmissionPolicyV1",
    "TrainingCaptureModeV1",
    "TrainingCoverageReportV1",
    "TrainingDatasetManifestV1",
    "TrainingExampleManifestV3",
    "TrainingExampleReferenceV1",
    "TrainingOutputRoleV1",
    "TrainingRunManifestV1",
    "TrainingRunRequestV1",
    "TrainingSamplingScheduleV1",
    "TrainingScheduleDrawV1",
    "TrainingSplitV1",
    "camera_risk_key_sha256_v2",
    "causal_ball_loss_config_descriptor_v1",
    "causal_ball_model_config_descriptor_v1",
    "causal_ball_optimizer_config_descriptor_v1",
    "compute_test_exclusion_commitment_sha256_v1",
    "derive_primary_sampling_stratum_v1",
    "leakage_group_sha256_v1",
    "target_tensor_set_sha256_v1",
    "training_example_reference_set_sha256_v1",
    "training_schedule_ranking_sha256_v1",
]
