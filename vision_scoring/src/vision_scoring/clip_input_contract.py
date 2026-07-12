"""Deterministic RGB24 clip inputs and non-authorizing decode receipts.

This module is deliberately pure.  It does not read media, load a decoder,
verify label or rights authority, choose a clip, resize pixels, or admit a job.
It converts an already verified tuple of complete RGB24 frame byte strings into
the fixed CPU tensor encoding consumed by the causal-ball baseline and defines
the canonical receipt that a later protected decoder coordinator may issue.

PyTorch tensors remain mutable after construction.  The tensor content digest
detects later mutation when it is recomputed; neither a frozen envelope nor a
receipt is an admission or persistence-integrity boundary.  Hash callers must
exclusively own the tensor storage and prevent concurrent mutation or resizing
during validation and hashing; the trusted loader/coordinator path supplies
fresh private tensors on one thread.
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass
import hashlib
import math
import struct
import sys
from typing import Any

try:
    import torch
except ModuleNotFoundError as error:  # pragma: no cover - optional dependency
    raise ModuleNotFoundError(
        "vision_scoring.clip_input_contract requires the optional 'training' "
        "dependency; install multicourt-vision-scoring[training]"
    ) from error

from .ball_model import CausalBallInput
from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
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
from .label_bundle import LabelBundleSplit


CLIP_INPUT_SCHEMA_VERSION = "1.0"
CLIP_INPUT_ENCODING_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-clip-input-encoding:v1"
)
CLIP_INPUT_RECEIPT_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-clip-input-receipt:v1"
)
MAX_CLIP_INPUT_RECEIPT_BYTES = 64 * 1024
MAX_CLIP_INPUT_FRAMES = 32
MAX_CLIP_INPUT_HEIGHT = 2160
MAX_CLIP_INPUT_WIDTH = 3840
MAX_CLIP_INPUT_PIXELS = 16_777_216
MAX_CLIP_INPUT_RAW_RGB24_BYTES = MAX_CLIP_INPUT_PIXELS * 3
MAX_CLIP_INPUT_FLOAT32_BYTES = MAX_CLIP_INPUT_PIXELS * 3 * 4

_TENSOR_HASH_CHUNK_BYTES = 1024 * 1024
_TENSOR_VALIDATION_CHUNK_VALUES = 1024 * 1024
_RECEIPT_MAXIMUM_DEPTH = 5
_RECEIPT_MAXIMUM_NODES = 1024
_RECEIPT_MAXIMUM_CONTAINERS = 128
_RECEIPT_TOP_LEVEL_TYPED_DIGEST_FIELDS = (
    "label_pack_generation_id",
    "label_pack_sha256",
    "label_bundle_statement_sha256",
    "source_asset_sha256",
    "finalized_trace_sha256",
    "capture_policy_sha256",
    "artifact_generation_id",
    "decoder_runtime_generation_id",
    "decoder_runtime_manifest_sha256",
    "decoder_recipe_sha256",
    "decode_contract_sha256",
    "input_encoding_sha256",
    "input_tensor_sha256",
)


class ClipInputContractError(ValueError):
    """Fail-closed clip-input contract failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise ClipInputContractError(code, message)


def causal_ball_clip_input_encoding_descriptor_v1() -> dict[str, Any]:
    """Return a fresh JSON-safe copy of the fixed V1 input encoding."""

    return {
        "batch_size": 1,
        "channel_order": "RGB",
        "device": "CPU",
        "domain": CLIP_INPUT_ENCODING_DOMAIN,
        "dtype": "IEEE754_BINARY32",
        "frame_order": "LABEL_BUNDLE_STATEMENT_FRAME_ORDER",
        "layout": "NTCHW_CONTIGUOUS",
        "normalization": (
            "ROUND_TO_NEAREST_TIES_TO_EVEN_BINARY32(U8/255)"
        ),
        "pixel_source": (
            "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
        ),
        "schema_version": CLIP_INPUT_SCHEMA_VERSION,
        "spatial_transform": "NONE",
        "tensor_hash_basis": (
            "SHA256_LITTLE_ENDIAN_FLOAT32_NTCHW_NO_HEADER"
        ),
        "tensor_shape": "[1,T,3,H,W]",
        "valid_frame_mask": "CPU_TORCH_BOOL_[1,T]_ALL_TRUE",
    }


_ENCODING_BYTES = canonical_json_bytes(
    causal_ball_clip_input_encoding_descriptor_v1(),
    label="causal-ball clip input encoding",
    maximum_bytes=MAX_CLIP_INPUT_RECEIPT_BYTES,
)
_CALCULATED_ENCODING_SHA256 = hashlib.sha256(_ENCODING_BYTES).hexdigest()
CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256 = (
    "e163cd45f875869fe20545ad6304524cc88545d77da4e539413e3f4ad36dfe0c"
)
if _CALCULATED_ENCODING_SHA256 != CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256:
    raise RuntimeError("the fixed causal-ball clip input encoding digest changed")


_V1_NORMALIZED_CODEWORD_BITS = tuple(
    struct.unpack("<I", struct.pack("<f", value / 255.0))[0]
    for value in range(256)
)
if (
    len(set(_V1_NORMALIZED_CODEWORD_BITS)) != 256
    or _V1_NORMALIZED_CODEWORD_BITS != tuple(sorted(_V1_NORMALIZED_CODEWORD_BITS))
    or _V1_NORMALIZED_CODEWORD_BITS[0] != 0
    or _V1_NORMALIZED_CODEWORD_BITS[-1] != 0x3F800000
):
    raise RuntimeError("the fixed V1 normalized binary32 codebook changed")


def _require_reduced_positive_time_base(
    numerator: object,
    denominator: object,
) -> tuple[int, int]:
    numerator_value = require_exact_int(
        numerator,
        "source_time_base_numerator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    denominator_value = require_exact_int(
        denominator,
        "source_time_base_denominator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError("source time base must be a reduced positive rational")
    return numerator_value, denominator_value


def source_pts_to_timestamp_ns_v1(
    source_pts: int,
    *,
    source_time_base_numerator: int,
    source_time_base_denominator: int,
) -> int:
    """Map one preserved source PTS to nanoseconds using exact integer floor.

    The first PTS is never subtracted.  Distinct, strictly increasing rational
    PTS values may therefore map to equal integer nanoseconds.
    """

    pts = require_exact_int(
        source_pts,
        "source_pts",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    numerator, denominator = _require_reduced_positive_time_base(
        source_time_base_numerator,
        source_time_base_denominator,
    )
    timestamp_ns = (pts * numerator * 1_000_000_000) // denominator
    if timestamp_ns > MAX_SIGNED_64:
        raise ValueError("source PTS maps outside non-negative signed 64-bit nanoseconds")
    return timestamp_ns


def _validate_clip_shape(
    *,
    frame_count: object,
    output_width: object,
    output_height: object,
) -> tuple[int, int, int]:
    frames = require_exact_int(
        frame_count,
        "frame_count",
        minimum=1,
        maximum=MAX_CLIP_INPUT_FRAMES,
    )
    width = require_exact_int(
        output_width,
        "output_width",
        minimum=16,
        maximum=MAX_CLIP_INPUT_WIDTH,
    )
    height = require_exact_int(
        output_height,
        "output_height",
        minimum=16,
        maximum=MAX_CLIP_INPUT_HEIGHT,
    )
    if width % 4 or height % 4:
        raise ValueError("clip input dimensions must be divisible by four")
    if frames * height * width > MAX_CLIP_INPUT_PIXELS:
        raise ValueError("clip input exceeds the fixed aggregate-pixel bound")
    return frames, width, height


def _require_exact_v1_normalized_codewords(frames: Any) -> None:
    """Require exact binary32 members of ``round_to_even(U8 / 255)``.

    The immutable Python tuple is the authority.  A fresh, small CPU lookup
    tensor prevents mutable module-level Torch state from changing validation.
    Search runs in fixed-size chunks so validation memory remains bounded even
    at the maximum clip size.  Exact bit matching rejects negative zero,
    subnormals, and arbitrary in-range floats such as 0.5.
    """

    allowed = torch.tensor(
        _V1_NORMALIZED_CODEWORD_BITS,
        dtype=torch.int32,
        device="cpu",
    )
    frame_bits = frames.view(torch.int32).reshape(-1)
    codeword_count = len(_V1_NORMALIZED_CODEWORD_BITS)
    for start in range(0, frame_bits.numel(), _TENSOR_VALIDATION_CHUNK_VALUES):
        selected = frame_bits[start : start + _TENSOR_VALIDATION_CHUNK_VALUES]
        positions = torch.searchsorted(allowed, selected)
        within = positions < codeword_count
        if not bool(within.all()):
            raise ValueError(
                "frames must contain only exact V1 U8/255 binary32 codewords"
            )
        if not torch.equal(allowed[positions], selected):
            raise ValueError(
                "frames must contain only exact V1 U8/255 binary32 codewords"
            )


def _require_exact_cpu_storage_window_v1(
    tensor: Any,
    *,
    expected_dtype: Any,
    element_bytes: int,
    label: str,
) -> tuple[int, int]:
    """Return one exclusively owned tensor's checked logical storage window."""

    try:
        exact_storage = (
            type(tensor) is torch.Tensor
            and tensor.dtype is expected_dtype
            and tensor.device.type == "cpu"
            and tensor.layout is torch.strided
            and tensor.is_contiguous()
            and not tensor.is_conj()
            and not tensor.is_neg()
            and not tensor.requires_grad
            and tensor.element_size() == element_bytes
        )
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} storage properties cannot be inspected") from exc
    if not exact_storage:
        requirement = (
            "frames must be contiguous non-gradient CPU torch.float32 with "
            "exact allocated storage"
            if label == "frames"
            else "valid_frame_mask must be contiguous CPU bool [1,T] with "
            "exact allocated storage"
        )
        raise ValueError(requirement)
    try:
        byte_count = tensor.numel() * element_bytes
        storage = tensor.untyped_storage()
        storage_nbytes = storage.nbytes()
        storage_address = storage.data_ptr()
        storage_offset = tensor.storage_offset()
        address = tensor.data_ptr()
    except (RuntimeError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} has no readable storage") from exc
    if (
        type(byte_count) is not int
        or type(storage_nbytes) is not int
        or type(storage_address) is not int
        or type(storage_offset) is not int
        or type(address) is not int
        or byte_count < 1
        or storage_nbytes < 1
        or storage_address <= 0
        or storage_offset < 0
        or address <= 0
    ):
        raise ValueError(f"{label} has no readable storage")
    offset_bytes = storage_offset * element_bytes
    if (
        address != storage_address + offset_bytes
        or offset_bytes + byte_count > storage_nbytes
    ):
        raise ValueError(f"{label} storage does not cover its logical bytes")
    return address, byte_count


@dataclass(frozen=True, slots=True)
class CausalBallClipFrameBindingV1:
    """One exact presentation-order frame row in a clip-input receipt."""

    frame_index: int
    source_pts: int
    timestamp_ns: int
    decoded_frame_sha256: str
    frame_identity_sha256: str

    def __post_init__(self) -> None:
        require_exact_int(
            self.frame_index,
            "frame_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.source_pts,
            "source_pts",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.timestamp_ns,
            "timestamp_ns",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_sha256(self.decoded_frame_sha256, "decoded_frame_sha256")
        require_sha256(self.frame_identity_sha256, "frame_identity_sha256")

    def to_dict(self) -> dict[str, Any]:
        return {
            "decoded_frame_sha256": self.decoded_frame_sha256,
            "frame_identity_sha256": self.frame_identity_sha256,
            "frame_index": self.frame_index,
            "source_pts": self.source_pts,
            "timestamp_ns": self.timestamp_ns,
        }

    @classmethod
    def from_dict(
        cls,
        value: object,
        *,
        label: str,
    ) -> "CausalBallClipFrameBindingV1":
        fields = require_exact_fields(
            value,
            set(cls.__dataclass_fields__),
            label=label,
        )
        return cls(**fields)


@dataclass(frozen=True, slots=True)
class CausalBallClipInputReceiptV1:
    """Canonical structural receipt for one deterministic clip decode.

    The receipt records cryptographic join coordinates and exact frame
    identities.  It deliberately contains no filename, filesystem path,
    descriptive match metadata, trust decision, or admission token.
    """

    label_pack_generation_id: str
    label_pack_sha256: str
    label_bundle_statement_sha256: str
    bundle_id: str
    source_asset_sha256: str
    split: LabelBundleSplit
    finalized_trace_sha256: str
    capture_policy_sha256: str
    capture_policy_generation: int
    artifact_generation_id: str
    source_byte_length: int
    decoder_runtime_generation_id: str
    decoder_runtime_manifest_sha256: str
    decoder_runtime_id: str
    decoder_recipe_sha256: str
    decode_contract_sha256: str
    selected_video_stream_index: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    output_width: int
    output_height: int
    frame_count: int
    frame_bindings: tuple[CausalBallClipFrameBindingV1, ...]
    input_encoding_sha256: str
    input_tensor_sha256: str
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CLIP_INPUT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not str
            or self.schema_version != CLIP_INPUT_SCHEMA_VERSION
        ):
            raise ValueError(
                f"schema_version must be exactly {CLIP_INPUT_SCHEMA_VERSION!r}"
            )
        for field_name in _RECEIPT_TOP_LEVEL_TYPED_DIGEST_FIELDS:
            require_sha256(getattr(self, field_name), field_name)
        top_level_digests = tuple(
            getattr(self, field_name)
            for field_name in _RECEIPT_TOP_LEVEL_TYPED_DIGEST_FIELDS
        )
        if len(set(top_level_digests)) != len(top_level_digests):
            raise ValueError(
                "top-level typed receipt digest roles must not alias"
            )
        require_stable_id(self.bundle_id, "bundle_id")
        require_stable_id(self.decoder_runtime_id, "decoder_runtime_id")
        if type(self.split) is not LabelBundleSplit or self.split not in {
            LabelBundleSplit.TRAIN,
            LabelBundleSplit.DEV,
        }:
            raise ValueError("clip input receipt split must be TRAIN or DEV")
        require_exact_int(
            self.capture_policy_generation,
            "capture_policy_generation",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.source_byte_length,
            "source_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        frame_count, _, _ = _validate_clip_shape(
            frame_count=self.frame_count,
            output_width=self.output_width,
            output_height=self.output_height,
        )
        numerator, denominator = _require_reduced_positive_time_base(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
        )
        if (
            type(self.frame_bindings) is not tuple
            or len(self.frame_bindings) != frame_count
            or any(
                type(item) is not CausalBallClipFrameBindingV1
                for item in self.frame_bindings
            )
        ):
            raise ValueError(
                "frame_bindings must contain exactly frame_count exact rows"
            )
        previous_source_pts: int | None = None
        previous_timestamp_ns: int | None = None
        frame_identity_digests: list[str] = []
        decoded_frame_digests: list[str] = []
        for expected_index, frame in enumerate(self.frame_bindings):
            if frame.frame_index != expected_index:
                raise ValueError(
                    "frame bindings must be contiguous and ordered from frame zero"
                )
            if (
                previous_source_pts is not None
                and frame.source_pts <= previous_source_pts
            ):
                raise ValueError("source PTS values must be strictly increasing")
            expected_timestamp_ns = source_pts_to_timestamp_ns_v1(
                frame.source_pts,
                source_time_base_numerator=numerator,
                source_time_base_denominator=denominator,
            )
            if frame.timestamp_ns != expected_timestamp_ns:
                raise ValueError(
                    "frame timestamp_ns does not equal the exact preserved-PTS mapping"
                )
            if (
                previous_timestamp_ns is not None
                and frame.timestamp_ns < previous_timestamp_ns
            ):
                raise ValueError("mapped frame timestamps cannot move backward")
            previous_source_pts = frame.source_pts
            previous_timestamp_ns = frame.timestamp_ns
            frame_identity_digests.append(frame.frame_identity_sha256)
            decoded_frame_digests.append(frame.decoded_frame_sha256)
        if len(set(frame_identity_digests)) != len(frame_identity_digests):
            raise ValueError("frame_identity_sha256 values must be unique")
        frame_identity_set = set(frame_identity_digests)
        decoded_frame_set = set(decoded_frame_digests)
        top_level_set = set(top_level_digests)
        if frame_identity_set.intersection(decoded_frame_set):
            raise ValueError(
                "frame identity and decoded-frame digest roles must not alias"
            )
        if top_level_set.intersection(frame_identity_set | decoded_frame_set):
            raise ValueError(
                "frame and top-level typed receipt digest roles must not alias"
            )
        if self.input_encoding_sha256 != CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256:
            raise ValueError("input_encoding_sha256 is not the fixed V1 encoding")
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            if type(getattr(self, field_name)) is not bool or getattr(
                self, field_name
            ) is not False:
                raise ValueError("clip input receipt admission flags must be false")
        canonical_json_bytes(
            self.to_dict(),
            label="causal-ball clip input receipt",
            maximum_bytes=MAX_CLIP_INPUT_RECEIPT_BYTES,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "admissible_for_deployment": self.admissible_for_deployment,
            "admissible_for_evaluation": self.admissible_for_evaluation,
            "admissible_for_live_scoring": self.admissible_for_live_scoring,
            "admissible_for_test": self.admissible_for_test,
            "admissible_for_training": self.admissible_for_training,
            "artifact_generation_id": self.artifact_generation_id,
            "bundle_id": self.bundle_id,
            "capture_policy_generation": self.capture_policy_generation,
            "capture_policy_sha256": self.capture_policy_sha256,
            "decode_contract_sha256": self.decode_contract_sha256,
            "decoder_recipe_sha256": self.decoder_recipe_sha256,
            "decoder_runtime_generation_id": self.decoder_runtime_generation_id,
            "decoder_runtime_id": self.decoder_runtime_id,
            "decoder_runtime_manifest_sha256": (
                self.decoder_runtime_manifest_sha256
            ),
            "domain": CLIP_INPUT_RECEIPT_DOMAIN,
            "finalized_trace_sha256": self.finalized_trace_sha256,
            "frame_bindings": [item.to_dict() for item in self.frame_bindings],
            "frame_count": self.frame_count,
            "input_encoding_sha256": self.input_encoding_sha256,
            "input_tensor_sha256": self.input_tensor_sha256,
            "label_bundle_statement_sha256": (
                self.label_bundle_statement_sha256
            ),
            "label_pack_generation_id": self.label_pack_generation_id,
            "label_pack_sha256": self.label_pack_sha256,
            "output_height": self.output_height,
            "output_width": self.output_width,
            "schema_version": self.schema_version,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_asset_sha256": self.source_asset_sha256,
            "source_byte_length": self.source_byte_length,
            "source_time_base_denominator": self.source_time_base_denominator,
            "source_time_base_numerator": self.source_time_base_numerator,
            "split": self.split.value,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="causal-ball clip input receipt",
            maximum_bytes=MAX_CLIP_INPUT_RECEIPT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CausalBallClipInputReceiptV1":
        try:
            payload = parse_canonical_json_object(
                raw,
                label="causal-ball clip input receipt",
                maximum_bytes=MAX_CLIP_INPUT_RECEIPT_BYTES,
                maximum_depth=_RECEIPT_MAXIMUM_DEPTH,
                maximum_nodes=_RECEIPT_MAXIMUM_NODES,
                maximum_containers=_RECEIPT_MAXIMUM_CONTAINERS,
            )
            fields = require_exact_fields(
                payload,
                {"domain", *cls.__dataclass_fields__},
                label="causal-ball clip input receipt",
            )
            if fields.pop("domain") != CLIP_INPUT_RECEIPT_DOMAIN:
                raise ValueError("clip input receipt domain is invalid")
            raw_bindings = exact_list(
                fields,
                "frame_bindings",
                label="causal-ball clip input receipt",
            )
            if len(raw_bindings) > MAX_CLIP_INPUT_FRAMES:
                raise ValueError("clip input receipt has too many frame rows")
            fields["frame_bindings"] = tuple(
                CausalBallClipFrameBindingV1.from_dict(
                    value,
                    label=f"frame_bindings[{index}]",
                )
                for index, value in enumerate(raw_bindings)
            )
            fields["split"] = enum_from_json(
                LabelBundleSplit,
                fields["split"],
                "split",
            )
            receipt = cls(**fields)
        except (CanonicalWireError, ClipInputContractError):
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise ClipInputContractError(
                "CLIP_INPUT_RECEIPT_SHAPE",
                "causal-ball clip input receipt fields are invalid",
            ) from exc
        if receipt.to_json_bytes() != raw:
            _fail(
                "CLIP_INPUT_RECEIPT_WIRE",
                "causal-ball clip input receipt did not reconstruct exactly",
            )
        return receipt


def _validate_causal_ball_input_v1(
    model_input: CausalBallInput,
) -> tuple[int, int, int]:
    if type(model_input) is not CausalBallInput:
        raise ValueError("model_input must have exact CausalBallInput type")
    frames = model_input.frames
    mask = model_input.valid_frame_mask
    if type(frames) is not torch.Tensor:
        raise ValueError("frames must be an exact five-dimensional torch.Tensor")
    try:
        if frames.ndim != 5:
            raise ValueError(
                "frames must be an exact five-dimensional torch.Tensor"
            )
        batch, frame_count, channels, height, width = frames.shape
    except (AttributeError, RuntimeError, TypeError) as exc:
        raise ValueError("frames shape cannot be inspected") from exc
    _validate_clip_shape(
        frame_count=frame_count,
        output_width=width,
        output_height=height,
    )
    if batch != 1 or channels != 3:
        raise ValueError("frames must have exact shape [1,T,3,H,W]")
    _require_exact_cpu_storage_window_v1(
        frames,
        expected_dtype=torch.float32,
        element_bytes=4,
        label="frames",
    )
    try:
        if not bool(torch.isfinite(frames).all()):
            raise ValueError("frames must contain only finite values")
        if bool((frames < 0).any()) or bool((frames > 1).any()):
            raise ValueError("frames must remain in the closed interval [0, 1]")
        _require_exact_v1_normalized_codewords(frames)
    except ValueError:
        raise
    except (RuntimeError, TypeError) as exc:
        raise ValueError("frames values cannot be inspected") from exc
    if type(mask) is not torch.Tensor:
        raise ValueError(
            "valid_frame_mask must be contiguous CPU bool [1,T] and all true"
        )
    try:
        mask_shape = tuple(mask.shape)
    except (AttributeError, RuntimeError, TypeError) as exc:
        raise ValueError("valid_frame_mask shape cannot be inspected") from exc
    if mask_shape != (1, frame_count):
        raise ValueError(
            "valid_frame_mask must be contiguous CPU bool [1,T] and all true"
        )
    _require_exact_cpu_storage_window_v1(
        mask,
        expected_dtype=torch.bool,
        element_bytes=1,
        label="valid_frame_mask",
    )
    try:
        mask_is_all_true = bool(mask.all())
    except (RuntimeError, TypeError, ValueError) as exc:
        raise ValueError("valid_frame_mask values cannot be inspected") from exc
    if not mask_is_all_true:
        raise ValueError(
            "valid_frame_mask must be contiguous CPU bool [1,T] and all true"
        )
    return frame_count, width, height


def causal_ball_input_tensor_sha256_v1(model_input: CausalBallInput) -> str:
    """Hash exact little-endian contiguous float32 NTCHW bytes, without a header."""

    _validate_causal_ball_input_v1(model_input)
    if sys.byteorder != "little":
        _fail(
            "CLIP_INPUT_ENCODING_PLATFORM",
            "V1 tensor hashing requires a little-endian CPU",
        )
    frames = model_input.frames
    address, byte_count = _require_exact_cpu_storage_window_v1(
        frames,
        expected_dtype=torch.float32,
        element_bytes=4,
        label="frames",
    )
    if byte_count > MAX_CLIP_INPUT_FLOAT32_BYTES:
        _fail(
            "CLIP_INPUT_ENCODING_TENSOR",
            "tensor exceeds the fixed V1 byte bound",
        )
    digest = hashlib.sha256()
    for offset in range(0, byte_count, _TENSOR_HASH_CHUNK_BYTES):
        count = min(_TENSOR_HASH_CHUNK_BYTES, byte_count - offset)
        digest.update(ctypes.string_at(address + offset, count))
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class EncodedCausalBallClipInputV1:
    """Frozen metadata envelope around one mutable encoded model input."""

    input_encoding_sha256: str
    input_tensor_sha256: str
    frame_count: int
    output_width: int
    output_height: int
    model_input: CausalBallInput

    def __post_init__(self) -> None:
        require_sha256(self.input_encoding_sha256, "input_encoding_sha256")
        require_sha256(self.input_tensor_sha256, "input_tensor_sha256")
        if self.input_encoding_sha256 != CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256:
            raise ValueError("input_encoding_sha256 is not the fixed V1 encoding")
        shape = _validate_clip_shape(
            frame_count=self.frame_count,
            output_width=self.output_width,
            output_height=self.output_height,
        )
        if _validate_causal_ball_input_v1(self.model_input) != shape:
            raise ValueError("model_input shape does not match its encoded metadata")
        if causal_ball_input_tensor_sha256_v1(self.model_input) != self.input_tensor_sha256:
            raise ValueError("input_tensor_sha256 does not bind the model input")

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


def encode_rgb24_causal_ball_clip_input_v1(
    rgb24_frames: tuple[bytes, ...],
    *,
    output_width: int,
    output_height: int,
) -> EncodedCausalBallClipInputV1:
    """Encode exact row-major RGB24 frames without any spatial transformation."""

    if type(rgb24_frames) is not tuple:
        _fail(
            "CLIP_INPUT_ENCODING_INPUT",
            "rgb24_frames must be an exact immutable tuple",
        )
    try:
        frame_count, width, height = _validate_clip_shape(
            frame_count=len(rgb24_frames),
            output_width=output_width,
            output_height=output_height,
        )
    except ValueError as exc:
        raise ClipInputContractError(
            "CLIP_INPUT_ENCODING_INPUT",
            "RGB24 clip shape is outside the fixed V1 bounds",
        ) from exc
    frame_bytes = width * height * 3
    if frame_bytes * frame_count > MAX_CLIP_INPUT_RAW_RGB24_BYTES:
        _fail(
            "CLIP_INPUT_ENCODING_INPUT",
            "RGB24 clip exceeds the fixed V1 raw-byte bound",
        )
    for frame in rgb24_frames:
        if type(frame) is not bytes or len(frame) != frame_bytes:
            _fail(
                "CLIP_INPUT_ENCODING_INPUT",
                "each frame must be exact complete row-major RGB24 bytes",
            )
    if sys.byteorder != "little":
        _fail(
            "CLIP_INPUT_ENCODING_PLATFORM",
            "V1 tensor encoding requires a little-endian CPU",
        )
    try:
        raw = bytearray(frame_bytes * frame_count)
        for index, frame in enumerate(rgb24_frames):
            start = index * frame_bytes
            raw[start : start + frame_bytes] = frame
        uint8_frames = torch.frombuffer(raw, dtype=torch.uint8).reshape(
            frame_count,
            height,
            width,
            3,
        )
        uint8_ncthw = uint8_frames.permute(0, 3, 1, 2).contiguous()
        frames = (
            uint8_ncthw.to(dtype=torch.float32, device="cpu")
            .div_(255.0)
            .unsqueeze(0)
            .contiguous()
        )
        mask = torch.ones((1, frame_count), dtype=torch.bool, device="cpu")
        model_input = CausalBallInput(frames=frames, valid_frame_mask=mask)
        tensor_sha256 = causal_ball_input_tensor_sha256_v1(model_input)
        return EncodedCausalBallClipInputV1(
            input_encoding_sha256=CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
            input_tensor_sha256=tensor_sha256,
            frame_count=frame_count,
            output_width=width,
            output_height=height,
            model_input=model_input,
        )
    except ClipInputContractError:
        raise
    except (RuntimeError, TypeError, ValueError) as exc:
        raise ClipInputContractError(
            "CLIP_INPUT_ENCODING_TENSOR",
            "RGB24 bytes could not be encoded into the fixed V1 tensor",
        ) from exc


@dataclass(frozen=True, slots=True)
class LoadedCausalBallClipInputV1:
    """Receipt-bound mutable model input with every admission scope false."""

    receipt: CausalBallClipInputReceiptV1
    model_input: CausalBallInput

    def __post_init__(self) -> None:
        if type(self.receipt) is not CausalBallClipInputReceiptV1:
            raise ValueError("receipt must have exact CausalBallClipInputReceiptV1 type")
        shape = _validate_causal_ball_input_v1(self.model_input)
        if shape != (
            self.receipt.frame_count,
            self.receipt.output_width,
            self.receipt.output_height,
        ):
            raise ValueError("receipt dimensions do not match the model input")
        self.validate_tensor_binding()

    def validate_tensor_binding(self) -> None:
        if (
            causal_ball_input_tensor_sha256_v1(self.model_input)
            != self.receipt.input_tensor_sha256
        ):
            raise ValueError("receipt input_tensor_sha256 does not bind the model input")

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


__all__ = [
    "CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256",
    "CLIP_INPUT_ENCODING_DOMAIN",
    "CLIP_INPUT_RECEIPT_DOMAIN",
    "CLIP_INPUT_SCHEMA_VERSION",
    "MAX_CLIP_INPUT_FLOAT32_BYTES",
    "MAX_CLIP_INPUT_FRAMES",
    "MAX_CLIP_INPUT_HEIGHT",
    "MAX_CLIP_INPUT_PIXELS",
    "MAX_CLIP_INPUT_RAW_RGB24_BYTES",
    "MAX_CLIP_INPUT_RECEIPT_BYTES",
    "MAX_CLIP_INPUT_WIDTH",
    "CausalBallClipFrameBindingV1",
    "CausalBallClipInputReceiptV1",
    "ClipInputContractError",
    "EncodedCausalBallClipInputV1",
    "LoadedCausalBallClipInputV1",
    "causal_ball_clip_input_encoding_descriptor_v1",
    "causal_ball_input_tensor_sha256_v1",
    "encode_rgb24_causal_ball_clip_input_v1",
    "source_pts_to_timestamp_ns_v1",
]
