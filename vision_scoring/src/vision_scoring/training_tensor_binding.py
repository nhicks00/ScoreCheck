"""Pure, non-authorizing bindings for one causal-ball input/target tensor pair.

Both the clip loader and target materializer return mutable PyTorch tensors.
This module commits their current bytes and exact structural joins without
persisting a tensor or granting any consumer authority.  A trusted consumer
must call :meth:`TrainingTensorBindingsV1.validate_mutable_bindings` immediately
before using the same tensor objects while exclusively owning their storage and
preventing concurrent mutation or resizing.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, ClassVar

from .ball_target_materialization import MaterializedCausalBallTargetsV1
from .clip_input_contract import (
    CausalBallClipInputReceiptV1,
    LoadedCausalBallClipInputV1,
)
from .contract_wire import (
    CanonicalWireError,
    canonical_json_bytes,
    exact_list,
    parse_canonical_json_object,
    require_exact_fields,
    require_sha256,
)
from .training_admission_contracts import (
    CAUSAL_BALL_HEATMAP_STRIDE,
    CAUSAL_BALL_MAX_FRAMES,
    TargetTensorContentRowV1,
    target_tensor_set_sha256_v1,
)
from .training_target_encoding import (
    TrainingTargetEncodingError,
    causal_ball_target_tensor_rows_v1,
    validate_causal_ball_target_tensor_rows_v1,
)


TRAINING_TENSOR_BINDING_SCHEMA_VERSION = "1.0"
TRAINING_TENSOR_BINDING_DOMAIN = (
    "multicourt-vision-scoring:training-tensor-binding:v1"
)
FRAME_IDENTITY_SEQUENCE_DOMAIN = (
    "multicourt-vision-scoring:frame-identity-sequence:v1"
)
DECODED_FRAME_SEQUENCE_DOMAIN = (
    "multicourt-vision-scoring:decoded-frame-sequence:v1"
)
MAX_TRAINING_TENSOR_BINDING_BYTES = 64 * 1024

_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class TrainingTensorBindingError(ValueError):
    """A fail-closed tensor-binding error with a stable machine code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingTensorBindingError(code, message)


def _sequence_sha256(
    values: tuple[str, ...],
    *,
    domain: str,
    label: str,
) -> str:
    if (
        type(values) is not tuple
        or not 1 <= len(values) <= CAUSAL_BALL_MAX_FRAMES
    ):
        raise ValueError(f"{label} must be a bounded immutable tuple")
    for value in values:
        require_sha256(value, f"{label} entry")
    return hashlib.sha256(
        canonical_json_bytes(
            {
                "domain": domain,
                "frame_count": len(values),
                "schema_version": TRAINING_TENSOR_BINDING_SCHEMA_VERSION,
                "sha256s": list(values),
            },
            label=label,
            maximum_bytes=MAX_TRAINING_TENSOR_BINDING_BYTES,
        )
    ).hexdigest()


def frame_identity_sequence_sha256_v1(values: tuple[str, ...]) -> str:
    """Commit one exact presentation-ordered frame-identity sequence."""

    return _sequence_sha256(
        values,
        domain=FRAME_IDENTITY_SEQUENCE_DOMAIN,
        label="frame identity sequence",
    )


def decoded_frame_sequence_sha256_v1(values: tuple[str, ...]) -> str:
    """Commit one exact presentation-ordered decoded-frame sequence."""

    return _sequence_sha256(
        values,
        domain=DECODED_FRAME_SEQUENCE_DOMAIN,
        label="decoded frame sequence",
    )


def _authority_dict(value: object) -> dict[str, bool]:
    return {field_name: getattr(value, field_name) for field_name in _AUTHORITY_FIELDS}


def _require_false_authority(value: object, *, label: str) -> None:
    for field_name in _AUTHORITY_FIELDS:
        selected = getattr(value, field_name, None)
        if type(selected) is not bool or selected is not False:
            _fail(
                "TENSOR_BINDING_AUTHORITY",
                f"{label} authority properties must remain exactly false",
            )


def _revalidate_loaded_clip(
    loaded_clip: LoadedCausalBallClipInputV1,
) -> CausalBallClipInputReceiptV1:
    if type(loaded_clip) is not LoadedCausalBallClipInputV1:
        _fail(
            "TENSOR_BINDING_INPUT",
            "loaded_clip has the wrong exact type",
        )
    _require_false_authority(loaded_clip, label="loaded clip")
    receipt = loaded_clip.receipt
    if type(receipt) is not CausalBallClipInputReceiptV1:
        _fail(
            "TENSOR_BINDING_INPUT",
            "loaded clip receipt has the wrong exact type",
        )
    _require_false_authority(receipt, label="clip input receipt")
    try:
        normalized_receipt = CausalBallClipInputReceiptV1.from_json_bytes(
            receipt.to_json_bytes()
        )
        if normalized_receipt != receipt:
            raise ValueError("receipt did not reconstruct exactly")
        # Use the existing clip-input boundary for shape, mask, and byte binding.
        LoadedCausalBallClipInputV1(
            receipt=receipt,
            model_input=loaded_clip.model_input,
        ).validate_tensor_binding()
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTensorBindingError(
            "TENSOR_BINDING_INPUT_MUTATION",
            "loaded clip or receipt no longer validates",
        ) from exc
    return receipt


def _joined_sequences(
    *,
    receipt: CausalBallClipInputReceiptV1,
    materialized_targets: MaterializedCausalBallTargetsV1,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if type(materialized_targets) is not MaterializedCausalBallTargetsV1:
        _fail(
            "TENSOR_BINDING_INPUT",
            "materialized_targets has the wrong exact type",
        )
    _require_false_authority(materialized_targets, label="materialized targets")
    frame_identity_sha256s = tuple(
        binding.frame_identity_sha256 for binding in receipt.frame_bindings
    )
    decoded_frame_sha256s = tuple(
        binding.decoded_frame_sha256 for binding in receipt.frame_bindings
    )
    try:
        heatmap_shape = tuple(
            materialized_targets.targets.heatmap_target.shape
        )
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTensorBindingError(
            "TENSOR_BINDING_JOIN",
            "target heatmap geometry cannot be inspected",
        ) from exc
    expected_heatmap_shape = (
        1,
        receipt.frame_count,
        1,
        receipt.output_height // CAUSAL_BALL_HEATMAP_STRIDE,
        receipt.output_width // CAUSAL_BALL_HEATMAP_STRIDE,
    )
    if (
        materialized_targets.source_asset_sha256 != receipt.source_asset_sha256
        or materialized_targets.bundle_id != receipt.bundle_id
        or materialized_targets.split is not receipt.split
        or materialized_targets.statement_sha256
        != receipt.label_bundle_statement_sha256
        or len(materialized_targets.frame_identity_sha256s)
        != receipt.frame_count
        or materialized_targets.frame_identity_sha256s
        != frame_identity_sha256s
        or materialized_targets.decoded_frame_sha256s
        != decoded_frame_sha256s
        or heatmap_shape != expected_heatmap_shape
    ):
        _fail(
            "TENSOR_BINDING_JOIN",
            "clip receipt and materialized targets do not bind one exact clip",
        )
    return frame_identity_sha256s, decoded_frame_sha256s


@dataclass(frozen=True, slots=True)
class TrainingTensorBindingsV1:
    """Canonical byte commitments for one joined mutable input/target pair."""

    clip_input_receipt_sha256: str
    input_tensor_sha256: str
    frame_identity_sequence_sha256: str
    decoded_frame_sequence_sha256: str
    target_tensor_rows: tuple[TargetTensorContentRowV1, ...]
    target_tensor_set_sha256: str
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = TRAINING_TENSOR_BINDING_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = TRAINING_TENSOR_BINDING_DOMAIN

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not str
            or self.schema_version != TRAINING_TENSOR_BINDING_SCHEMA_VERSION
        ):
            raise ValueError("unsupported training tensor binding schema")
        digest_fields = (
            "clip_input_receipt_sha256",
            "input_tensor_sha256",
            "frame_identity_sequence_sha256",
            "decoded_frame_sequence_sha256",
            "target_tensor_set_sha256",
        )
        digests = tuple(
            require_sha256(getattr(self, field_name), field_name)
            for field_name in digest_fields
        )
        if len(set(digests)) != len(digests):
            raise ValueError("typed tensor-binding digest roles must not alias")
        if type(self.target_tensor_rows) is not tuple or any(
            type(row) is not TargetTensorContentRowV1
            for row in self.target_tensor_rows
        ):
            raise ValueError("target_tensor_rows must be an exact immutable row tuple")
        if set(digests).intersection(
            row.content_sha256 for row in self.target_tensor_rows
        ):
            raise ValueError(
                "top-level and target-content digest roles must not alias"
            )
        if target_tensor_set_sha256_v1(self.target_tensor_rows) != (
            self.target_tensor_set_sha256
        ):
            raise ValueError("target_tensor_set_sha256 does not bind target rows")
        _require_false_authority(self, label="training tensor binding")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            **_authority_dict(self),
            "clip_input_receipt_sha256": self.clip_input_receipt_sha256,
            "decoded_frame_sequence_sha256": (
                self.decoded_frame_sequence_sha256
            ),
            "domain": self._DOMAIN,
            "frame_identity_sequence_sha256": (
                self.frame_identity_sequence_sha256
            ),
            "input_tensor_sha256": self.input_tensor_sha256,
            "schema_version": self.schema_version,
            "target_tensor_rows": [row.to_dict() for row in self.target_tensor_rows],
            "target_tensor_set_sha256": self.target_tensor_set_sha256,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="training tensor binding",
            maximum_bytes=MAX_TRAINING_TENSOR_BINDING_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "TrainingTensorBindingsV1":
        try:
            fields = require_exact_fields(
                parse_canonical_json_object(
                    raw,
                    label="training tensor binding",
                    maximum_bytes=MAX_TRAINING_TENSOR_BINDING_BYTES,
                    maximum_depth=5,
                    maximum_nodes=256,
                    maximum_containers=32,
                ),
                {
                    "domain",
                    *{
                        name
                        for name in cls.__dataclass_fields__
                        if not name.startswith("_")
                    },
                },
                label="training tensor binding",
            )
            if fields.pop("domain") != cls._DOMAIN:
                raise ValueError("training tensor binding domain is invalid")
            raw_rows = exact_list(
                fields,
                "target_tensor_rows",
                label="training tensor binding",
            )
            fields["target_tensor_rows"] = tuple(
                TargetTensorContentRowV1.from_dict(
                    value,
                    label=f"target_tensor_rows[{index}]",
                )
                for index, value in enumerate(raw_rows)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingTensorBindingError(
                "TENSOR_BINDING_WIRE",
                "training tensor binding fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "TENSOR_BINDING_WIRE",
                "training tensor binding did not reconstruct exactly",
            )
        return result

    def validate_mutable_bindings(
        self,
        *,
        loaded_clip: LoadedCausalBallClipInputV1,
        materialized_targets: MaterializedCausalBallTargetsV1,
    ) -> None:
        """Rehash and rejoin the same mutable tensors at a consumption boundary."""

        try:
            if type(self) is not TrainingTensorBindingsV1:
                raise ValueError("binding has the wrong exact type")
            normalized_binding = TrainingTensorBindingsV1.from_json_bytes(
                self.to_json_bytes()
            )
            if normalized_binding != self:
                raise ValueError("binding did not reconstruct exactly")
            receipt = _revalidate_loaded_clip(loaded_clip)
            frame_sha256s, decoded_sha256s = _joined_sequences(
                receipt=receipt,
                materialized_targets=materialized_targets,
            )
            validate_causal_ball_target_tensor_rows_v1(
                materialized_targets,
                self.target_tensor_rows,
            )
            current_values = (
                receipt.fingerprint(),
                receipt.input_tensor_sha256,
                frame_identity_sequence_sha256_v1(frame_sha256s),
                decoded_frame_sequence_sha256_v1(decoded_sha256s),
                target_tensor_set_sha256_v1(self.target_tensor_rows),
            )
        except (
            AttributeError,
            RuntimeError,
            TrainingTargetEncodingError,
            TrainingTensorBindingError,
            TypeError,
            ValueError,
        ) as exc:
            raise TrainingTensorBindingError(
                "TENSOR_BINDING_MUTATION",
                "mutable input or target binding no longer validates",
            ) from exc
        expected_values = (
            self.clip_input_receipt_sha256,
            self.input_tensor_sha256,
            self.frame_identity_sequence_sha256,
            self.decoded_frame_sequence_sha256,
            self.target_tensor_set_sha256,
        )
        if current_values != expected_values:
            _fail(
                "TENSOR_BINDING_MUTATION",
                "mutable input or target bytes changed after binding",
            )


def bind_training_tensors_v1(
    *,
    loaded_clip: LoadedCausalBallClipInputV1,
    materialized_targets: MaterializedCausalBallTargetsV1,
) -> TrainingTensorBindingsV1:
    """Bind one current exact clip input and materialized target tensor set."""

    receipt = _revalidate_loaded_clip(loaded_clip)
    frame_sha256s, decoded_sha256s = _joined_sequences(
        receipt=receipt,
        materialized_targets=materialized_targets,
    )
    try:
        rows = causal_ball_target_tensor_rows_v1(materialized_targets)
        result = TrainingTensorBindingsV1(
            clip_input_receipt_sha256=receipt.fingerprint(),
            input_tensor_sha256=receipt.input_tensor_sha256,
            frame_identity_sequence_sha256=(
                frame_identity_sequence_sha256_v1(frame_sha256s)
            ),
            decoded_frame_sequence_sha256=(
                decoded_frame_sequence_sha256_v1(decoded_sha256s)
            ),
            target_tensor_rows=rows,
            target_tensor_set_sha256=target_tensor_set_sha256_v1(rows),
        )
    except TrainingTargetEncodingError as exc:
        raise TrainingTensorBindingError(
            "TENSOR_BINDING_TARGET",
            "materialized target tensors do not satisfy the V1 encoding",
        ) from exc
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingTensorBindingError(
            "TENSOR_BINDING_CONTRACT",
            "tensor commitments could not be constructed",
        ) from exc
    result.validate_mutable_bindings(
        loaded_clip=loaded_clip,
        materialized_targets=materialized_targets,
    )
    return result


__all__ = (
    "DECODED_FRAME_SEQUENCE_DOMAIN",
    "FRAME_IDENTITY_SEQUENCE_DOMAIN",
    "MAX_TRAINING_TENSOR_BINDING_BYTES",
    "TRAINING_TENSOR_BINDING_DOMAIN",
    "TRAINING_TENSOR_BINDING_SCHEMA_VERSION",
    "TrainingTensorBindingError",
    "TrainingTensorBindingsV1",
    "bind_training_tensors_v1",
    "decoded_frame_sequence_sha256_v1",
    "frame_identity_sequence_sha256_v1",
)
