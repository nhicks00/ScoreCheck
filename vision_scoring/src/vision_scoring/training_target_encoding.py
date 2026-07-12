"""Exact, non-authorizing content hashes for causal-ball target tensors.

The materializer produces mutable PyTorch tensors.  This module binds their
current, exact CPU storage bytes to the canonical target-content rows used by
the training-admission contracts.  It performs no persistence, trust lookup,
training, evaluation, or capability grant.  Callers must revalidate the rows
immediately before a trusted consumer uses the same tensors.  The caller must
exclusively own the storage and prevent concurrent mutation or resizing during
each hash operation; the trusted coordinator satisfies this by hashing fresh,
private materializer output on one thread.
"""

from __future__ import annotations

import ctypes
import hashlib
import sys

try:
    import torch
except ModuleNotFoundError as error:  # pragma: no cover - optional dependency
    raise ModuleNotFoundError(
        "vision_scoring.training_target_encoding requires the optional "
        "'training' dependency; install multicourt-vision-scoring[training]"
    ) from error

from .ball_target_materialization import MaterializedCausalBallTargetsV1
from .training_admission_contracts import (
    CAUSAL_BALL_HEATMAP_STRIDE,
    CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME,
    CAUSAL_BALL_MAX_FRAMES,
    CAUSAL_BALL_MAX_HEIGHT,
    CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS,
    CAUSAL_BALL_MAX_WIDTH,
    CAUSAL_BALL_TARGET_ENCODING_SHA256,
    TargetTensorContentRowV1,
    TargetTensorDTypeV1,
    TargetTensorFieldV1,
    target_tensor_set_sha256_v1,
)


MAX_TARGET_TENSOR_SET_BYTES_V1 = 8 * 1024 * 1024
_HASH_CHUNK_BYTES = 1024 * 1024

_FLOAT_FIELDS = frozenset(
    {
        TargetTensorFieldV1.HEATMAP_TARGET,
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET,
    }
)
_INDEX_FIELDS = frozenset(
    {
        TargetTensorFieldV1.MATCH_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX,
    }
)


class TrainingTargetEncodingError(ValueError):
    """Fail-closed target-content encoding error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingTargetEncodingError(code, message)


def _expected_dtype(
    field: TargetTensorFieldV1,
) -> tuple[torch.dtype, TargetTensorDTypeV1, int]:
    if field in _FLOAT_FIELDS:
        return (
            torch.float32,
            TargetTensorDTypeV1.IEEE754_BINARY32_LE,
            4,
        )
    if field in _INDEX_FIELDS:
        return (
            torch.int64,
            TargetTensorDTypeV1.SIGNED_INT64_LE,
            8,
        )
    return torch.bool, TargetTensorDTypeV1.BOOL_U8, 1


def _revalidate_envelope(value: MaterializedCausalBallTargetsV1) -> None:
    try:
        MaterializedCausalBallTargetsV1(
            statement_sha256=value.statement_sha256,
            target_encoding_sha256=value.target_encoding_sha256,
            bundle_id=value.bundle_id,
            source_asset_sha256=value.source_asset_sha256,
            split=value.split,
            frame_identity_sha256s=value.frame_identity_sha256s,
            decoded_frame_sha256s=value.decoded_frame_sha256s,
            targets=value.targets,
        )
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTargetEncodingError(
            "TARGET_ENCODING_ENVELOPE",
            "materialized target envelope no longer validates",
        ) from exc
    if value.target_encoding_sha256 != CAUSAL_BALL_TARGET_ENCODING_SHA256:
        _fail("TARGET_ENCODING_ENVELOPE", "target encoding pin changed")
    for field_name in (
        "admissible_for_training",
        "admissible_for_evaluation",
        "admissible_for_test",
        "admissible_for_deployment",
        "admissible_for_live_scoring",
    ):
        if getattr(value, field_name, None) is not False:
            _fail("TARGET_ENCODING_AUTHORITY", "target authority must remain false")


def _validate_geometry(value: MaterializedCausalBallTargetsV1) -> None:
    frame_count = len(value.frame_identity_sha256s)
    if not 1 <= frame_count <= CAUSAL_BALL_MAX_FRAMES:
        _fail("TARGET_ENCODING_GEOMETRY", "frame count exceeds the V1 bound")
    heatmap = value.targets.heatmap_target
    if type(heatmap) is not torch.Tensor or heatmap.ndim != 5:
        _fail("TARGET_ENCODING_GEOMETRY", "heatmap target has the wrong rank")
    expected_prefix = (1, frame_count, 1)
    if tuple(heatmap.shape[:3]) != expected_prefix:
        _fail("TARGET_ENCODING_GEOMETRY", "heatmap axes changed")
    heatmap_height = int(heatmap.shape[3])
    heatmap_width = int(heatmap.shape[4])
    if (
        not 1 <= heatmap_height <= CAUSAL_BALL_MAX_HEIGHT // CAUSAL_BALL_HEATMAP_STRIDE
        or not 1 <= heatmap_width <= CAUSAL_BALL_MAX_WIDTH // CAUSAL_BALL_HEATMAP_STRIDE
        or frame_count
        * heatmap_height
        * heatmap_width
        * CAUSAL_BALL_HEATMAP_STRIDE
        * CAUSAL_BALL_HEATMAP_STRIDE
        > CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS
    ):
        _fail("TARGET_ENCODING_GEOMETRY", "heatmap geometry exceeds V1 bounds")
    candidate_shape = (
        1,
        frame_count,
        CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME,
    )
    expected_shapes = {
        TargetTensorFieldV1.HEATMAP_TARGET: (
            *expected_prefix,
            heatmap_height,
            heatmap_width,
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
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET: (
            candidate_shape
        ),
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_MASK: candidate_shape,
    }
    for field, expected_shape in expected_shapes.items():
        tensor = getattr(value.targets, field.value, None)
        if type(tensor) is not torch.Tensor or tuple(tensor.shape) != expected_shape:
            _fail(
                "TARGET_ENCODING_GEOMETRY",
                f"{field.value} has the wrong fixed V1 shape",
            )


def _hash_tensor(
    tensor: torch.Tensor,
    *,
    field: TargetTensorFieldV1,
    remaining_bytes: int,
) -> tuple[str, int]:
    expected_torch_dtype, _wire_dtype, element_bytes = _expected_dtype(field)
    try:
        exact_storage = (
            type(tensor) is torch.Tensor
            and tensor.dtype is expected_torch_dtype
            and tensor.device.type == "cpu"
            and tensor.layout is torch.strided
            and tensor.is_contiguous()
            and not tensor.is_conj()
            and not tensor.is_neg()
            and not tensor._is_zerotensor()
            and not tensor.requires_grad
            and tensor.element_size() == element_bytes
        )
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTargetEncodingError(
            "TARGET_ENCODING_TENSOR",
            f"{field.value} storage properties cannot be inspected",
        ) from exc
    if not exact_storage:
        _fail(
            "TARGET_ENCODING_TENSOR",
            f"{field.value} is not exact contiguous non-gradient CPU storage",
        )
    try:
        byte_count = tensor.numel() * element_bytes
    except (RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTargetEncodingError(
            "TARGET_ENCODING_TENSOR",
            f"{field.value} storage size cannot be inspected",
        ) from exc
    if byte_count < 1 or byte_count > remaining_bytes:
        _fail("TARGET_ENCODING_SIZE", "target tensor set exceeds its byte bound")
    try:
        storage = tensor.untyped_storage()
        storage_nbytes = storage.nbytes()
        storage_address = storage.data_ptr()
        storage_offset = tensor.storage_offset()
        address = tensor.data_ptr()
    except (RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTargetEncodingError(
            "TARGET_ENCODING_TENSOR",
            f"{field.value} has no readable storage",
        ) from exc
    if (
        type(storage_nbytes) is not int
        or type(storage_address) is not int
        or type(storage_offset) is not int
        or type(address) is not int
        or storage_nbytes < 1
        or storage_address <= 0
        or storage_offset < 0
        or address <= 0
    ):
        _fail("TARGET_ENCODING_TENSOR", f"{field.value} has no readable storage")
    offset_bytes = storage_offset * element_bytes
    if (
        address != storage_address + offset_bytes
        or offset_bytes + byte_count > storage_nbytes
    ):
        _fail(
            "TARGET_ENCODING_TENSOR",
            f"{field.value} storage does not cover its logical bytes",
        )
    digest = hashlib.sha256()
    for offset in range(0, byte_count, _HASH_CHUNK_BYTES):
        count = min(_HASH_CHUNK_BYTES, byte_count - offset)
        raw = ctypes.string_at(address + offset, count)
        if expected_torch_dtype is torch.bool and any(
            byte not in (0, 1) for byte in raw
        ):
            _fail("TARGET_ENCODING_BOOL", "bool storage is not canonical U8")
        digest.update(raw)
    return digest.hexdigest(), byte_count


def causal_ball_target_tensor_rows_v1(
    materialized: MaterializedCausalBallTargetsV1,
) -> tuple[TargetTensorContentRowV1, ...]:
    """Hash exclusively owned target tensors into canonical V1 content rows."""

    if type(materialized) is not MaterializedCausalBallTargetsV1:
        _fail(
            "TARGET_ENCODING_INPUT",
            "materialized must have exact MaterializedCausalBallTargetsV1 type",
        )
    if sys.byteorder != "little":
        _fail("TARGET_ENCODING_PLATFORM", "V1 target hashing requires little-endian CPU")
    _revalidate_envelope(materialized)
    _validate_geometry(materialized)
    if tuple(materialized.targets.__dataclass_fields__) != tuple(
        field.value for field in TargetTensorFieldV1
    ):
        _fail("TARGET_ENCODING_SCHEMA", "target field order differs from V1")

    rows: list[TargetTensorContentRowV1] = []
    remaining = MAX_TARGET_TENSOR_SET_BYTES_V1
    for field in TargetTensorFieldV1:
        tensor = getattr(materialized.targets, field.value)
        digest, byte_count = _hash_tensor(
            tensor,
            field=field,
            remaining_bytes=remaining,
        )
        remaining -= byte_count
        _torch_dtype, wire_dtype, _element_bytes = _expected_dtype(field)
        rows.append(
            TargetTensorContentRowV1(
                field=field,
                dtype=wire_dtype,
                shape=tuple(int(dimension) for dimension in tensor.shape),
                content_sha256=digest,
            )
        )
    result = tuple(rows)
    try:
        target_tensor_set_sha256_v1(result)
    except (TypeError, ValueError) as exc:
        raise TrainingTargetEncodingError(
            "TARGET_ENCODING_SCHEMA",
            "target rows do not satisfy the V1 contract",
        ) from exc
    return result


def validate_causal_ball_target_tensor_rows_v1(
    materialized: MaterializedCausalBallTargetsV1,
    rows: tuple[TargetTensorContentRowV1, ...],
) -> None:
    """Rehash the mutable tensors and require the exact previously bound rows."""

    if type(rows) is not tuple or any(
        type(row) is not TargetTensorContentRowV1 for row in rows
    ):
        _fail("TARGET_ENCODING_INPUT", "rows must be an exact immutable row tuple")
    if causal_ball_target_tensor_rows_v1(materialized) != rows:
        _fail("TARGET_ENCODING_MUTATION", "target tensor bytes changed after binding")


__all__ = (
    "MAX_TARGET_TENSOR_SET_BYTES_V1",
    "TrainingTargetEncodingError",
    "causal_ball_target_tensor_rows_v1",
    "validate_causal_ball_target_tensor_rows_v1",
)
