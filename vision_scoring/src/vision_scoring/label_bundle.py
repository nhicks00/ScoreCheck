"""Curator-signed, complete decoded-frame ball-label enumeration.

The curator signature authenticates an enumeration claim, not pixels or media.
Individual observations remain authoritative only after the existing Annotation
Truth V2 verifier checks their concrete preimages, detached attestations,
currentness, revocations, evidence, and protected policy.  A receipt returned by
this module is evidence only and is deliberately unusable as an admission token.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .annotation_trust import (
    AnnotationAttestation,
    AnnotationMinimumTruthPolicy,
    AnnotationTrustStore,
    AnnotationVerificationPolicy,
    annotation_attestation_set_fingerprint,
)
from .annotations import (
    AnnotationType,
    BallFrameAnnotationV2,
    BallRole,
    BallVisibility,
    DecodedFrameHashBasis,
    FrameReference,
    PixelCoordinateSpace,
    ReviewState,
    TimestampBasis,
)
from .contract_wire import (
    CanonicalWireError,
    canonical_base64,
    canonical_json_bytes,
    enum_from_json,
    exact_list,
    parse_canonical_json_object,
    require_canonical_tuple,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)


LABEL_BUNDLE_SCHEMA_VERSION = "1.0"
LABEL_BUNDLE_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:causal-ball-label-bundle:v1"
)
MAX_LABEL_BUNDLE_BYTES = 1_900_000
MAX_LABEL_BUNDLE_ATTESTATION_BYTES = 4 * 1024
MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES = 512 * 1024
MAX_LABEL_BUNDLE_FRAMES = 10_000
MAX_BALL_ANNOTATIONS_PER_FRAME = 64
MAX_ANNOTATION_ATTESTATIONS = 17
MAX_LABEL_BUNDLE_ANNOTATIONS = 100_000
MAX_LABEL_BUNDLE_ANNOTATION_ATTESTATIONS = 200_000
MAX_LABEL_CURATOR_KEYS = 64
MAX_REVOKED_LABEL_BUNDLES = 2_048

_CONTENT_ADDRESS_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ANNOTATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")


class LabelBundleError(ValueError):
    """Construction, parsing, or verification failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise LabelBundleError(code, message)


def _require_content_address(value: object, field_name: str) -> str:
    if type(value) is not str or _CONTENT_ADDRESS_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an exact sha256 content address")
    return value


def _require_annotation_id(value: object, field_name: str) -> str:
    if type(value) is not str or _ANNOTATION_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an Annotation Truth V2 identifier")
    return value


def _bounded_json(value: Mapping[str, Any], *, label: str, maximum: int) -> bytes:
    return canonical_json_bytes(value, label=label, maximum_bytes=maximum)


def _parse_json(raw: bytes, *, label: str, maximum: int) -> dict[str, Any]:
    try:
        return parse_canonical_json_object(
            raw,
            label=label,
            maximum_bytes=maximum,
        )
    except CanonicalWireError as exc:
        _fail(exc.code, str(exc))
        raise AssertionError from exc
    except ValueError as exc:
        _fail("INVALID_JSON", str(exc))
        raise AssertionError from exc


def _public_key_sha256(public_key_base64: str) -> str:
    return hashlib.sha256(
        canonical_base64(
            public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
    ).hexdigest()


class LabelBundleSplit(str, Enum):
    TRAIN = "TRAIN"
    DEV = "DEV"
    TEST = "TEST"


class MatchBallFrameStatus(str, Enum):
    PRESENT = "PRESENT"
    ABSENT = "ABSENT"
    UNSEEN_UNKNOWN = "UNSEEN_UNKNOWN"


class LabelCompletenessScope(str, Enum):
    COMPLETE_FULL_DECODED_FRAME = "COMPLETE_FULL_DECODED_FRAME"


class LabelBundleCuratorKeyRole(str, Enum):
    COMPLETE_BALL_ENUMERATION_CURATOR = "COMPLETE_BALL_ENUMERATION_CURATOR"


class LabelBundleEvidenceStatus(str, Enum):
    CURATOR_CLAIM_AND_ANNOTATION_TRUST_VERIFIED = (
        "CURATOR_CLAIM_AND_ANNOTATION_TRUST_VERIFIED"
    )


_LOCALIZABLE_VISIBILITIES = frozenset(
    {BallVisibility.VISIBLE, BallVisibility.PARTIALLY_OCCLUDED}
)
_UNSEEN_MATCH_VISIBILITIES = frozenset(
    {
        BallVisibility.FULLY_OCCLUDED,
        BallVisibility.OUT_OF_FRAME,
        BallVisibility.INDISTINGUISHABLE,
    }
)


def _match_status(visibility: BallVisibility) -> MatchBallFrameStatus:
    if visibility in _LOCALIZABLE_VISIBILITIES:
        return MatchBallFrameStatus.PRESENT
    if visibility is BallVisibility.NOT_PRESENT:
        return MatchBallFrameStatus.ABSENT
    if visibility in _UNSEEN_MATCH_VISIBILITIES:
        return MatchBallFrameStatus.UNSEEN_UNKNOWN
    raise ValueError(
        "a decoded-frame MATCH_BALL enumeration must be PRESENT, ABSENT, or "
        "explicitly unseen; ambiguous-role and capture-unavailable labels are not "
        "complete decoded-frame match-ball truth"
    )


@dataclass(frozen=True, slots=True)
class BallAnnotationReferenceV1:
    """Content-addressed reference to one exact Annotation Truth V2 preimage."""

    annotation_type: AnnotationType
    annotation_id: str
    annotation_sha256: str
    annotation_preimage_ref: str
    annotation_attestation_refs: tuple[str, ...]
    ball_instance_id: str
    role: BallRole
    visibility: BallVisibility

    def __post_init__(self) -> None:
        if self.annotation_type is not AnnotationType.BALL_FRAME_OBSERVATION:
            raise ValueError("annotation_type must be BALL_FRAME_OBSERVATION")
        _require_annotation_id(self.annotation_id, "annotation_id")
        require_sha256(self.annotation_sha256, "annotation_sha256")
        _require_content_address(
            self.annotation_preimage_ref,
            "annotation_preimage_ref",
        )
        if self.annotation_preimage_ref != f"sha256:{self.annotation_sha256}":
            raise ValueError(
                "annotation_preimage_ref must address the exact annotation SHA-256"
            )
        _require_canonical_content_addresses(
            self.annotation_attestation_refs,
            "annotation_attestation_refs",
            minimum=1,
            maximum=MAX_ANNOTATION_ATTESTATIONS,
        )
        _require_annotation_id(self.ball_instance_id, "ball_instance_id")
        if type(self.role) is not BallRole:
            raise ValueError("role must be a BallRole")
        if type(self.visibility) is not BallVisibility:
            raise ValueError("visibility must be a BallVisibility")

    def to_dict(self) -> dict[str, Any]:
        return {
            "annotation_attestation_refs": list(self.annotation_attestation_refs),
            "annotation_id": self.annotation_id,
            "annotation_preimage_ref": self.annotation_preimage_ref,
            "annotation_sha256": self.annotation_sha256,
            "annotation_type": self.annotation_type.value,
            "ball_instance_id": self.ball_instance_id,
            "role": self.role.value,
            "visibility": self.visibility.value,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "BallAnnotationReferenceV1":
        try:
            parsed = require_exact_fields(
                value,
                set(cls.__dataclass_fields__),
                label=label,
            )
            return cls(
                **{
                    **parsed,
                    "annotation_type": enum_from_json(
                        AnnotationType,
                        parsed["annotation_type"],
                        f"{label}.annotation_type",
                    ),
                    "role": enum_from_json(
                        BallRole,
                        parsed["role"],
                        f"{label}.role",
                    ),
                    "visibility": enum_from_json(
                        BallVisibility,
                        parsed["visibility"],
                        f"{label}.visibility",
                    ),
                    "annotation_attestation_refs": tuple(
                        exact_list(parsed, "annotation_attestation_refs", label=label)
                    ),
                }
            )
        except (TypeError, ValueError) as exc:
            _fail("INVALID_ANNOTATION_REFERENCE", str(exc))
            raise AssertionError from exc


def _require_canonical_content_addresses(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
) -> tuple[str, ...]:
    return require_canonical_tuple(
        value,
        field_name,
        minimum=minimum,
        maximum=maximum,
        validator=_require_content_address,
    )


def _annotation_order(reference: BallAnnotationReferenceV1) -> tuple[object, ...]:
    return (
        0 if reference.role is BallRole.MATCH_BALL else 1,
        reference.ball_instance_id,
        reference.role.value,
        reference.annotation_id,
        reference.annotation_sha256,
    )


@dataclass(frozen=True, slots=True)
class BallFrameEnumerationV1:
    """One decoded frame's complete curator-declared localizable-ball set."""

    sequence: int
    frame_index: int
    timestamp_ns: int
    decoded_frame_sha256: str
    frame_identity_sha256: str
    match_ball_status: MatchBallFrameStatus
    match_ball_annotation_id: str
    annotations: tuple[BallAnnotationReferenceV1, ...]

    def __post_init__(self) -> None:
        require_exact_int(self.sequence, "sequence")
        require_exact_int(self.frame_index, "frame_index")
        require_exact_int(self.timestamp_ns, "timestamp_ns")
        require_sha256(self.decoded_frame_sha256, "decoded_frame_sha256")
        require_sha256(self.frame_identity_sha256, "frame_identity_sha256")
        if type(self.match_ball_status) is not MatchBallFrameStatus:
            raise ValueError("match_ball_status must be a MatchBallFrameStatus")
        _require_annotation_id(
            self.match_ball_annotation_id,
            "match_ball_annotation_id",
        )
        if (
            type(self.annotations) is not tuple
            or not 1 <= len(self.annotations) <= MAX_BALL_ANNOTATIONS_PER_FRAME
            or any(type(item) is not BallAnnotationReferenceV1 for item in self.annotations)
        ):
            raise ValueError("annotations must be a bounded immutable reference tuple")
        if self.annotations != tuple(sorted(self.annotations, key=_annotation_order)):
            raise ValueError("frame annotations must use canonical match-first ordering")
        if len({item.annotation_id for item in self.annotations}) != len(
            self.annotations
        ):
            raise ValueError("annotation IDs cannot repeat within a frame")
        if len({item.ball_instance_id for item in self.annotations}) != len(
            self.annotations
        ):
            raise ValueError("ball_instance_id values cannot repeat within a frame")
        targets = tuple(
            item
            for item in self.annotations
            if item.annotation_id == self.match_ball_annotation_id
        )
        if len(targets) != 1:
            raise ValueError(
                "match_ball_annotation_id must identify exactly one frame annotation"
            )
        target = targets[0]
        if target.visibility is BallVisibility.INDISTINGUISHABLE:
            if target.role is not BallRole.UNKNOWN:
                raise ValueError(
                    "INDISTINGUISHABLE target truth must retain Annotation V2 UNKNOWN role"
                )
        elif target.role is not BallRole.MATCH_BALL:
            raise ValueError("the target annotation must have MATCH_BALL role")
        if _match_status(target.visibility) is not self.match_ball_status:
            raise ValueError("match_ball_status disagrees with match-ball visibility")
        for item in self.annotations:
            if item is target:
                continue
            if item.role is BallRole.MATCH_BALL:
                raise ValueError("a frame cannot declare a second MATCH_BALL annotation")
            if item.visibility not in _LOCALIZABLE_VISIBILITIES:
                raise ValueError(
                    "non-match-ball entries must be localizable observations; "
                    "unknown non-match balls cannot satisfy complete heatmap truth"
                )

    @property
    def match_ball_annotation(self) -> BallAnnotationReferenceV1:
        return next(
            item
            for item in self.annotations
            if item.annotation_id == self.match_ball_annotation_id
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "annotations": [item.to_dict() for item in self.annotations],
            "decoded_frame_sha256": self.decoded_frame_sha256,
            "frame_identity_sha256": self.frame_identity_sha256,
            "frame_index": self.frame_index,
            "match_ball_annotation_id": self.match_ball_annotation_id,
            "match_ball_status": self.match_ball_status.value,
            "sequence": self.sequence,
            "timestamp_ns": self.timestamp_ns,
        }

    @classmethod
    def from_dict(cls, value: object, *, label: str) -> "BallFrameEnumerationV1":
        try:
            parsed = require_exact_fields(
                value,
                set(cls.__dataclass_fields__),
                label=label,
            )
            raw_annotations = exact_list(parsed, "annotations", label=label)
            if len(raw_annotations) > MAX_BALL_ANNOTATIONS_PER_FRAME:
                raise ValueError("frame contains too many annotations")
            return cls(
                **{
                    **parsed,
                    "match_ball_status": enum_from_json(
                        MatchBallFrameStatus,
                        parsed["match_ball_status"],
                        f"{label}.match_ball_status",
                    ),
                    "annotations": tuple(
                        BallAnnotationReferenceV1.from_dict(
                            item,
                            label=f"{label}.annotations[{index}]",
                        )
                        for index, item in enumerate(raw_annotations)
                    ),
                }
            )
        except LabelBundleError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_FRAME_ENUMERATION", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class CausalBallLabelBundleV1:
    """Exact curator claim over every decoded frame in one source asset."""

    bundle_id: str
    source_asset_sha256: str
    finalized_trace_sha256: str
    capture_policy_sha256: str
    capture_policy_generation: int
    split: LabelBundleSplit
    ontology_sha256: str
    ontology_version: str
    selected_video_stream_index: int
    decode_contract_sha256: str
    timestamp_basis: TimestampBasis
    pixel_coordinate_space: PixelCoordinateSpace
    decoded_frame_hash_basis: DecodedFrameHashBasis
    match_ball_instance_id: str
    target_role: BallRole
    completeness_scope: LabelCompletenessScope
    frame_count: int
    first_timestamp_ns: int
    last_timestamp_ns: int
    annotation_count: int
    annotation_attestation_set_sha256: str
    annotation_trust_store_sha256: str
    annotation_verification_policy_sha256: str
    frames: tuple[BallFrameEnumerationV1, ...]
    schema_version: str = LABEL_BUNDLE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != LABEL_BUNDLE_SCHEMA_VERSION:
            raise ValueError("unsupported causal-ball-label-bundle schema")
        require_stable_id(self.bundle_id, "bundle_id")
        for field_name in (
            "source_asset_sha256",
            "finalized_trace_sha256",
            "capture_policy_sha256",
            "ontology_sha256",
            "decode_contract_sha256",
            "annotation_attestation_set_sha256",
            "annotation_trust_store_sha256",
            "annotation_verification_policy_sha256",
        ):
            require_sha256(getattr(self, field_name), field_name)
        require_exact_int(self.capture_policy_generation, "capture_policy_generation")
        if type(self.split) is not LabelBundleSplit:
            raise ValueError("split must be TRAIN, DEV, or TEST")
        require_stable_id(self.ontology_version, "ontology_version")
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
        )
        if type(self.timestamp_basis) is not TimestampBasis:
            raise ValueError("timestamp_basis must be a TimestampBasis")
        if type(self.pixel_coordinate_space) is not PixelCoordinateSpace:
            raise ValueError("pixel_coordinate_space must be a PixelCoordinateSpace")
        if type(self.decoded_frame_hash_basis) is not DecodedFrameHashBasis:
            raise ValueError(
                "decoded_frame_hash_basis must be a DecodedFrameHashBasis"
            )
        _require_annotation_id(self.match_ball_instance_id, "match_ball_instance_id")
        if self.target_role is not BallRole.MATCH_BALL:
            raise ValueError("target_role must be MATCH_BALL")
        if (
            self.completeness_scope
            is not LabelCompletenessScope.COMPLETE_FULL_DECODED_FRAME
        ):
            raise ValueError("completeness_scope must be COMPLETE_FULL_DECODED_FRAME")
        require_exact_int(
            self.frame_count,
            "frame_count",
            minimum=1,
            maximum=MAX_LABEL_BUNDLE_FRAMES,
        )
        require_exact_int(self.first_timestamp_ns, "first_timestamp_ns")
        require_exact_int(self.last_timestamp_ns, "last_timestamp_ns")
        require_exact_int(self.annotation_count, "annotation_count", minimum=1)
        if (
            type(self.frames) is not tuple
            or len(self.frames) != self.frame_count
            or any(type(item) is not BallFrameEnumerationV1 for item in self.frames)
        ):
            raise ValueError("frames must contain exactly frame_count enumerations")
        timestamps: list[int] = []
        annotation_ids: set[str] = set()
        counted = 0
        for sequence, frame in enumerate(self.frames):
            if frame.sequence != sequence or frame.frame_index != sequence:
                raise ValueError(
                    "frames must be complete, contiguous, and ordered from frame zero"
                )
            if timestamps and frame.timestamp_ns < timestamps[-1]:
                raise ValueError("frame timestamps cannot move backward")
            timestamps.append(frame.timestamp_ns)
            if frame.match_ball_annotation.ball_instance_id != self.match_ball_instance_id:
                raise ValueError(
                    "every frame must reference the one declared match-ball subject"
                )
            for reference in frame.annotations:
                if reference.annotation_id in annotation_ids:
                    raise ValueError("annotation IDs must be unique across the bundle")
                annotation_ids.add(reference.annotation_id)
            counted += len(frame.annotations)
        if self.first_timestamp_ns != timestamps[0]:
            raise ValueError("first_timestamp_ns does not match frame zero")
        if self.last_timestamp_ns != timestamps[-1]:
            raise ValueError("last_timestamp_ns does not match the final frame")
        if self.annotation_count != counted:
            raise ValueError("annotation_count does not match the exact enumeration")
        _bounded_json(
            self.to_dict(),
            label="causal ball label bundle",
            maximum=MAX_LABEL_BUNDLE_BYTES,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "annotation_attestation_set_sha256": self.annotation_attestation_set_sha256,
            "annotation_count": self.annotation_count,
            "annotation_trust_store_sha256": self.annotation_trust_store_sha256,
            "annotation_verification_policy_sha256": (
                self.annotation_verification_policy_sha256
            ),
            "bundle_id": self.bundle_id,
            "capture_policy_generation": self.capture_policy_generation,
            "capture_policy_sha256": self.capture_policy_sha256,
            "completeness_scope": self.completeness_scope.value,
            "decode_contract_sha256": self.decode_contract_sha256,
            "decoded_frame_hash_basis": self.decoded_frame_hash_basis.value,
            "finalized_trace_sha256": self.finalized_trace_sha256,
            "first_timestamp_ns": self.first_timestamp_ns,
            "frame_count": self.frame_count,
            "frames": [item.to_dict() for item in self.frames],
            "last_timestamp_ns": self.last_timestamp_ns,
            "match_ball_instance_id": self.match_ball_instance_id,
            "ontology_sha256": self.ontology_sha256,
            "ontology_version": self.ontology_version,
            "pixel_coordinate_space": self.pixel_coordinate_space.value,
            "schema_version": self.schema_version,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_asset_sha256": self.source_asset_sha256,
            "split": self.split.value,
            "target_role": self.target_role.value,
            "timestamp_basis": self.timestamp_basis.value,
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_json(
            self.to_dict(),
            label="causal ball label bundle",
            maximum=MAX_LABEL_BUNDLE_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CausalBallLabelBundleV1":
        value = _parse_json(
            raw,
            label="causal ball label bundle",
            maximum=MAX_LABEL_BUNDLE_BYTES,
        )
        try:
            parsed = require_exact_fields(
                value,
                set(cls.__dataclass_fields__),
                label="causal ball label bundle",
            )
            raw_frames = exact_list(parsed, "frames", label="causal ball label bundle")
            if len(raw_frames) > MAX_LABEL_BUNDLE_FRAMES:
                raise ValueError("bundle has too many frames")
            return cls(
                **{
                    **parsed,
                    "split": enum_from_json(
                        LabelBundleSplit,
                        parsed["split"],
                        "split",
                    ),
                    "timestamp_basis": enum_from_json(
                        TimestampBasis,
                        parsed["timestamp_basis"],
                        "timestamp_basis",
                    ),
                    "pixel_coordinate_space": enum_from_json(
                        PixelCoordinateSpace,
                        parsed["pixel_coordinate_space"],
                        "pixel_coordinate_space",
                    ),
                    "decoded_frame_hash_basis": enum_from_json(
                        DecodedFrameHashBasis,
                        parsed["decoded_frame_hash_basis"],
                        "decoded_frame_hash_basis",
                    ),
                    "target_role": enum_from_json(
                        BallRole,
                        parsed["target_role"],
                        "target_role",
                    ),
                    "completeness_scope": enum_from_json(
                        LabelCompletenessScope,
                        parsed["completeness_scope"],
                        "completeness_scope",
                    ),
                    "frames": tuple(
                        BallFrameEnumerationV1.from_dict(
                            item,
                            label=f"frames[{index}]",
                        )
                        for index, item in enumerate(raw_frames)
                    ),
                }
            )
        except LabelBundleError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_LABEL_BUNDLE", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class CausalBallLabelBundleAttestationV1:
    statement_sha256: str
    key_id: str
    key_role: LabelBundleCuratorKeyRole
    curator_id: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = LABEL_BUNDLE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != LABEL_BUNDLE_SCHEMA_VERSION:
            raise ValueError("unsupported label-bundle attestation schema")
        require_sha256(self.statement_sha256, "statement_sha256")
        for field_name in ("key_id", "curator_id", "trust_domain_id"):
            require_stable_id(getattr(self, field_name), field_name)
        if (
            self.key_role
            is not LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR
        ):
            raise ValueError("attestation key_role has the wrong domain role")
        require_exact_int(self.signed_at_ns, "signed_at_ns")
        canonical_base64(self.signature_base64, "signature_base64", expected_bytes=64)
        _bounded_json(
            self.to_dict(),
            label="label bundle attestation",
            maximum=MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
        )

    @property
    def signature(self) -> bytes:
        return canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "curator_id": self.curator_id,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "schema_version": self.schema_version,
            "signature_base64": self.signature_base64,
            "signed_at_ns": self.signed_at_ns,
            "statement_sha256": self.statement_sha256,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_json(
            self.to_dict(),
            label="label bundle attestation",
            maximum=MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CausalBallLabelBundleAttestationV1":
        value = _parse_json(
            raw,
            label="label bundle attestation",
            maximum=MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
        )
        try:
            parsed = require_exact_fields(
                value,
                set(cls.__dataclass_fields__),
                label="label bundle attestation",
            )
            return cls(
                **{
                    **parsed,
                    "key_role": enum_from_json(
                        LabelBundleCuratorKeyRole,
                        parsed["key_role"],
                        "key_role",
                    ),
                }
            )
        except (TypeError, ValueError) as exc:
            _fail("INVALID_LABEL_BUNDLE_ATTESTATION", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class TrustedLabelBundleCuratorKeyV1:
    key_id: str
    key_role: LabelBundleCuratorKeyRole
    curator_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None

    def __post_init__(self) -> None:
        require_stable_id(self.key_id, "key_id")
        require_stable_id(self.curator_id, "curator_id")
        if (
            self.key_role
            is not LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR
        ):
            raise ValueError("curator key has the wrong domain role")
        canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("curator key validity interval is reversed")
        if self.revoked_at_ns is not None:
            require_exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    @property
    def public_key_sha256(self) -> str:
        return _public_key_sha256(self.public_key_base64)

    def to_dict(self) -> dict[str, Any]:
        return {
            "curator_id": self.curator_id,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }


@dataclass(frozen=True, slots=True)
class CurrentCausalBallLabelBundleV1:
    bundle_id: str
    statement_sha256: str
    attestation_sha256: str

    def __post_init__(self) -> None:
        require_stable_id(self.bundle_id, "bundle_id")
        require_sha256(self.statement_sha256, "statement_sha256")
        require_sha256(self.attestation_sha256, "attestation_sha256")

    def to_dict(self) -> dict[str, str]:
        return {
            "attestation_sha256": self.attestation_sha256,
            "bundle_id": self.bundle_id,
            "statement_sha256": self.statement_sha256,
        }


@dataclass(frozen=True, slots=True)
class CausalBallLabelBundleTrustSnapshotV1:
    snapshot_generation: int
    trust_domain_id: str
    curator_id: str
    keys: tuple[TrustedLabelBundleCuratorKeyV1, ...]
    current_key_id: str
    current_bundle: CurrentCausalBallLabelBundleV1
    revoked_statement_sha256s: tuple[str, ...]
    schema_version: str = LABEL_BUNDLE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != LABEL_BUNDLE_SCHEMA_VERSION:
            raise ValueError("unsupported label-bundle trust-snapshot schema")
        require_exact_int(self.snapshot_generation, "snapshot_generation")
        require_stable_id(self.trust_domain_id, "trust_domain_id")
        require_stable_id(self.curator_id, "curator_id")
        require_stable_id(self.current_key_id, "current_key_id")
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_LABEL_CURATOR_KEYS
            or any(type(item) is not TrustedLabelBundleCuratorKeyV1 for item in self.keys)
        ):
            raise ValueError("keys must be a bounded immutable curator-key tuple")
        if self.keys != tuple(sorted(self.keys, key=lambda item: item.key_id)):
            raise ValueError("keys must be sorted by key_id")
        if len({item.key_id for item in self.keys}) != len(self.keys):
            raise ValueError("curator key IDs cannot repeat")
        if len({item.public_key_base64 for item in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot have multiple curator identities")
        if any(item.curator_id != self.curator_id for item in self.keys):
            raise ValueError("every curator key must bind the snapshot curator")
        if len([item for item in self.keys if item.key_id == self.current_key_id]) != 1:
            raise ValueError("current_key_id must identify exactly one curator key")
        if type(self.current_bundle) is not CurrentCausalBallLabelBundleV1:
            raise ValueError("current_bundle must be an exact current bundle entry")
        _require_canonical_content_addresses_as_hashes(
            self.revoked_statement_sha256s,
            "revoked_statement_sha256s",
        )
        if self.current_bundle.statement_sha256 in self.revoked_statement_sha256s:
            raise ValueError("the current label bundle cannot be revoked")
        _bounded_json(
            self.to_dict(),
            label="label bundle trust snapshot",
            maximum=MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_bundle": self.current_bundle.to_dict(),
            "current_key_id": self.current_key_id,
            "curator_id": self.curator_id,
            "keys": [item.to_dict() for item in self.keys],
            "revoked_statement_sha256s": list(self.revoked_statement_sha256s),
            "schema_version": self.schema_version,
            "snapshot_generation": self.snapshot_generation,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_json(
            self.to_dict(),
            label="label bundle trust snapshot",
            maximum=MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CausalBallLabelBundleTrustSnapshotV1":
        value = _parse_json(
            raw,
            label="label bundle trust snapshot",
            maximum=MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES,
        )
        try:
            parsed = require_exact_fields(
                value,
                set(cls.__dataclass_fields__),
                label="label bundle trust snapshot",
            )
            raw_keys = exact_list(parsed, "keys", label="label bundle trust snapshot")
            if len(raw_keys) > MAX_LABEL_CURATOR_KEYS:
                raise ValueError("trust snapshot has too many curator keys")
            keys = tuple(
                TrustedLabelBundleCuratorKeyV1(
                    **{
                        **require_exact_fields(
                            item,
                            set(TrustedLabelBundleCuratorKeyV1.__dataclass_fields__),
                            label=f"keys[{index}]",
                        ),
                        "key_role": enum_from_json(
                            LabelBundleCuratorKeyRole,
                            item["key_role"],
                            f"keys[{index}].key_role",
                        ),
                    }
                )
                for index, item in enumerate(raw_keys)
            )
            current = CurrentCausalBallLabelBundleV1(
                **require_exact_fields(
                    parsed["current_bundle"],
                    set(CurrentCausalBallLabelBundleV1.__dataclass_fields__),
                    label="current_bundle",
                )
            )
            return cls(
                **{
                    **parsed,
                    "keys": keys,
                    "current_bundle": current,
                    "revoked_statement_sha256s": tuple(
                        exact_list(
                            parsed,
                            "revoked_statement_sha256s",
                            label="label bundle trust snapshot",
                        )
                    ),
                }
            )
        except LabelBundleError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_LABEL_BUNDLE_TRUST_SNAPSHOT", str(exc))
            raise AssertionError from exc


def _require_canonical_content_addresses_as_hashes(
    value: object,
    field_name: str,
) -> tuple[str, ...]:
    return require_canonical_tuple(
        value,
        field_name,
        minimum=0,
        maximum=MAX_REVOKED_LABEL_BUNDLES,
        validator=require_sha256,
    )


class VerifiedCausalBallLabelBundleEvidence(Protocol):
    """Read-only evidence shape; structural conformance grants no authority."""

    @property
    def statement_sha256(self) -> str: ...

    @property
    def attestation_sha256(self) -> str: ...

    @property
    def trust_snapshot_sha256(self) -> str: ...

    @property
    def annotation_trust_store_sha256(self) -> str: ...

    @property
    def annotation_verification_policy_sha256(self) -> str: ...

    @property
    def annotation_attestation_set_sha256(self) -> str: ...

    @property
    def annotation_configuration_generation_sha256(self) -> str: ...

    @property
    def annotation_evidence_set_sha256(self) -> str: ...

    @property
    def annotation_evidence_generation_id(self) -> str: ...

    @property
    def requested_truth_policy(self) -> AnnotationMinimumTruthPolicy: ...

    @property
    def trust_snapshot_generation(self) -> int: ...

    @property
    def protected_verified_at_ns(self) -> int: ...

    @property
    def bundle_id(self) -> str: ...

    @property
    def split(self) -> LabelBundleSplit: ...

    @property
    def evidence_status(self) -> LabelBundleEvidenceStatus: ...

    @property
    def admissible_for_training(self) -> bool: ...

    @property
    def admissible_for_evaluation(self) -> bool: ...

    @property
    def admissible_for_test(self) -> bool: ...

    @property
    def admissible_for_deployment(self) -> bool: ...

    @property
    def admissible_for_live_scoring(self) -> bool: ...


class _VerifiedCausalBallLabelBundleEvidence:
    __slots__ = (
        "_statement_sha256",
        "_attestation_sha256",
        "_trust_snapshot_sha256",
        "_annotation_trust_store_sha256",
        "_annotation_verification_policy_sha256",
        "_annotation_attestation_set_sha256",
        "_annotation_configuration_generation_sha256",
        "_annotation_evidence_set_sha256",
        "_annotation_evidence_generation_id",
        "_requested_truth_policy",
        "_trust_snapshot_generation",
        "_protected_verified_at_ns",
        "_bundle_id",
        "_split",
    )

    def __init__(
        self,
        *,
        statement_sha256: str,
        attestation_sha256: str,
        trust_snapshot_sha256: str,
        annotation_trust_store_sha256: str,
        annotation_verification_policy_sha256: str,
        annotation_attestation_set_sha256: str,
        annotation_configuration_generation_sha256: str,
        annotation_evidence_set_sha256: str,
        annotation_evidence_generation_id: str,
        requested_truth_policy: AnnotationMinimumTruthPolicy,
        trust_snapshot_generation: int,
        protected_verified_at_ns: int,
        bundle_id: str,
        split: LabelBundleSplit,
    ) -> None:
        for field_name, value in (
            ("statement_sha256", statement_sha256),
            ("attestation_sha256", attestation_sha256),
            ("trust_snapshot_sha256", trust_snapshot_sha256),
            ("annotation_trust_store_sha256", annotation_trust_store_sha256),
            (
                "annotation_verification_policy_sha256",
                annotation_verification_policy_sha256,
            ),
            (
                "annotation_attestation_set_sha256",
                annotation_attestation_set_sha256,
            ),
            (
                "annotation_configuration_generation_sha256",
                annotation_configuration_generation_sha256,
            ),
            ("annotation_evidence_set_sha256", annotation_evidence_set_sha256),
            (
                "annotation_evidence_generation_id",
                annotation_evidence_generation_id,
            ),
        ):
            require_sha256(value, field_name)
        if type(requested_truth_policy) is not AnnotationMinimumTruthPolicy:
            raise ValueError(
                "requested_truth_policy must be an AnnotationMinimumTruthPolicy"
            )
        require_exact_int(trust_snapshot_generation, "trust_snapshot_generation")
        require_exact_int(protected_verified_at_ns, "protected_verified_at_ns")
        require_stable_id(bundle_id, "bundle_id")
        if type(split) is not LabelBundleSplit:
            raise ValueError("split must be a LabelBundleSplit")
        object.__setattr__(self, "_statement_sha256", statement_sha256)
        object.__setattr__(self, "_attestation_sha256", attestation_sha256)
        object.__setattr__(self, "_trust_snapshot_sha256", trust_snapshot_sha256)
        object.__setattr__(
            self,
            "_annotation_trust_store_sha256",
            annotation_trust_store_sha256,
        )
        object.__setattr__(
            self,
            "_annotation_verification_policy_sha256",
            annotation_verification_policy_sha256,
        )
        object.__setattr__(
            self,
            "_annotation_attestation_set_sha256",
            annotation_attestation_set_sha256,
        )
        object.__setattr__(
            self,
            "_annotation_configuration_generation_sha256",
            annotation_configuration_generation_sha256,
        )
        object.__setattr__(
            self,
            "_annotation_evidence_set_sha256",
            annotation_evidence_set_sha256,
        )
        object.__setattr__(
            self,
            "_annotation_evidence_generation_id",
            annotation_evidence_generation_id,
        )
        object.__setattr__(
            self,
            "_requested_truth_policy",
            requested_truth_policy,
        )
        object.__setattr__(
            self,
            "_trust_snapshot_generation",
            trust_snapshot_generation,
        )
        object.__setattr__(
            self,
            "_protected_verified_at_ns",
            protected_verified_at_ns,
        )
        object.__setattr__(self, "_bundle_id", bundle_id)
        object.__setattr__(self, "_split", split)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("verified label-bundle receipts are immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("verified label-bundle receipts are immutable")

    @property
    def statement_sha256(self) -> str:
        return self._statement_sha256

    @property
    def attestation_sha256(self) -> str:
        return self._attestation_sha256

    @property
    def trust_snapshot_sha256(self) -> str:
        return self._trust_snapshot_sha256

    @property
    def annotation_trust_store_sha256(self) -> str:
        return self._annotation_trust_store_sha256

    @property
    def annotation_verification_policy_sha256(self) -> str:
        return self._annotation_verification_policy_sha256

    @property
    def annotation_attestation_set_sha256(self) -> str:
        return self._annotation_attestation_set_sha256

    @property
    def annotation_configuration_generation_sha256(self) -> str:
        return self._annotation_configuration_generation_sha256

    @property
    def annotation_evidence_set_sha256(self) -> str:
        return self._annotation_evidence_set_sha256

    @property
    def annotation_evidence_generation_id(self) -> str:
        return self._annotation_evidence_generation_id

    @property
    def requested_truth_policy(self) -> AnnotationMinimumTruthPolicy:
        return self._requested_truth_policy

    @property
    def trust_snapshot_generation(self) -> int:
        return self._trust_snapshot_generation

    @property
    def protected_verified_at_ns(self) -> int:
        return self._protected_verified_at_ns

    @property
    def bundle_id(self) -> str:
        return self._bundle_id

    @property
    def split(self) -> LabelBundleSplit:
        return self._split

    @property
    def evidence_status(self) -> LabelBundleEvidenceStatus:
        return LabelBundleEvidenceStatus.CURATOR_CLAIM_AND_ANNOTATION_TRUST_VERIFIED

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


def _annotation_reference(
    annotation: BallFrameAnnotationV2,
    annotation_sha256: str,
    attestation_refs: tuple[str, ...],
) -> BallAnnotationReferenceV1:
    require_sha256(annotation_sha256, "annotation_sha256")
    if not attestation_refs:
        raise ValueError(
            f"annotation has no detached attestation: {annotation.annotation_id}"
        )
    return BallAnnotationReferenceV1(
        annotation_type=annotation.annotation_type,
        annotation_id=annotation.annotation_id,
        annotation_sha256=annotation_sha256,
        annotation_preimage_ref=f"sha256:{annotation_sha256}",
        annotation_attestation_refs=attestation_refs,
        ball_instance_id=annotation.ball_instance_id,
        role=annotation.role,
        visibility=annotation.visibility,
    )


def build_causal_ball_label_bundle_v1(
    *,
    bundle_id: str,
    source_asset_sha256: str,
    finalized_trace_sha256: str,
    capture_policy_sha256: str,
    capture_policy_generation: int,
    split: LabelBundleSplit,
    ontology_sha256: str,
    ontology_version: str,
    match_ball_instance_id: str,
    annotations: tuple[BallFrameAnnotationV2, ...],
    attestations: tuple[AnnotationAttestation, ...],
    annotation_trust_store_sha256: str,
    annotation_verification_policy_sha256: str,
) -> CausalBallLabelBundleV1:
    """Build an unsigned exact statement; no trust decision occurs here."""

    if (
        type(annotations) is not tuple
        or not annotations
        or len(annotations) > MAX_LABEL_BUNDLE_ANNOTATIONS
        or any(type(item) is not BallFrameAnnotationV2 for item in annotations)
    ):
        raise ValueError("annotations must be a bounded non-empty exact immutable V2 tuple")
    if (
        type(attestations) is not tuple
        or len(attestations) > MAX_LABEL_BUNDLE_ANNOTATION_ATTESTATIONS
        or any(type(item) is not AnnotationAttestation for item in attestations)
    ):
        raise ValueError("attestations must be a bounded exact immutable V2 tuple")
    # Cheap structural/count preflight comes before annotation canonicalization,
    # attestation fingerprinting, or sorting.  Invalid bounded inputs must not
    # amplify work up to the much coarser global tuple limits.
    grouped: dict[int, list[BallFrameAnnotationV2]] = {}
    annotation_ids: set[str] = set()
    first_frame: FrameReference | None = None
    for annotation in annotations:
        if annotation.review_state is ReviewState.DRAFT:
            raise ValueError("DRAFT annotations cannot enter a completeness claim")
        if annotation.annotation_id in annotation_ids:
            raise ValueError("annotation IDs must be unique")
        annotation_ids.add(annotation.annotation_id)
        if type(annotation.frame) is not FrameReference:
            raise ValueError(
                "complete decoded-frame bundles cannot contain unavailable frames"
            )
        frame = annotation.frame
        if first_frame is None:
            first_frame = frame
        if (
            frame.source_sha256 != source_asset_sha256
            or annotation.ontology_sha256 != ontology_sha256
        ):
            raise ValueError("annotation source or ontology differs from the bundle")
        selected = grouped.setdefault(frame.frame_index, [])
        selected.append(annotation)
        if len(selected) > MAX_BALL_ANNOTATIONS_PER_FRAME:
            raise ValueError(
                "decoded frame exceeds the per-frame ball-annotation bound"
            )
        if len(grouped) > MAX_LABEL_BUNDLE_FRAMES:
            raise ValueError("bundle contains too many decoded frames")
    assert first_frame is not None
    expected_indexes = list(range(len(grouped)))
    if sorted(grouped) != expected_indexes:
        raise ValueError(
            "annotation frames must completely enumerate contiguous decoded frames from zero"
        )
    attestation_counts: dict[str, int] = {}
    for attestation in attestations:
        count = attestation_counts.get(attestation.annotation_sha256, 0) + 1
        if count > MAX_ANNOTATION_ATTESTATIONS:
            raise ValueError(
                "annotation exceeds the detached-attestation reference bound"
            )
        attestation_counts[attestation.annotation_sha256] = count
    annotation_sha256_by_id = {
        item.annotation_id: item.fingerprint() for item in annotations
    }
    annotation_hashes = set(annotation_sha256_by_id.values())
    if set(attestation_counts) - annotation_hashes:
        raise ValueError("attestations cannot refer outside the exact annotation set")
    missing_attestations = annotation_hashes - set(attestation_counts)
    if missing_attestations:
        missing_id = next(
            item.annotation_id
            for item in annotations
            if annotation_sha256_by_id[item.annotation_id] in missing_attestations
        )
        raise ValueError(f"annotation has no detached attestation: {missing_id}")
    attestation_refs_by_annotation: dict[str, list[str]] = {}
    for attestation in attestations:
        attestation_refs_by_annotation.setdefault(
            attestation.annotation_sha256,
            [],
        ).append(f"sha256:{attestation.fingerprint()}")
    canonical_attestation_refs = {
        annotation_sha256: tuple(sorted(references))
        for annotation_sha256, references in attestation_refs_by_annotation.items()
    }
    frames: list[BallFrameEnumerationV1] = []
    for sequence in expected_indexes:
        selected = grouped[sequence]
        representative = selected[0].frame
        assert type(representative) is FrameReference
        if any(item.frame != representative for item in selected):
            raise ValueError("all annotations in a frame must bind one exact frame preimage")
        if (
            representative.selected_video_stream_index
            != first_frame.selected_video_stream_index
            or representative.decode_contract.fingerprint()
            != first_frame.decode_contract.fingerprint()
            or representative.timestamp_basis is not first_frame.timestamp_basis
            or representative.pixel_coordinate_space
            is not first_frame.pixel_coordinate_space
            or representative.decoded_frame_hash_basis
            is not first_frame.decoded_frame_hash_basis
        ):
            raise ValueError("decoded frame domain changes within the bundle")
        references = tuple(
            sorted(
                (
                    _annotation_reference(
                        item,
                        annotation_sha256_by_id[item.annotation_id],
                        canonical_attestation_refs[
                            annotation_sha256_by_id[item.annotation_id]
                        ],
                    )
                    for item in selected
                ),
                key=_annotation_order,
            )
        )
        matches = tuple(
            item
            for item in selected
            if item.role is BallRole.MATCH_BALL
            or (
                item.ball_instance_id == match_ball_instance_id
                and item.visibility is BallVisibility.INDISTINGUISHABLE
                and item.role is BallRole.UNKNOWN
            )
        )
        if len(matches) != 1:
            raise ValueError(
                "each frame must have one match-ball target; Annotation V2 UNKNOWN "
                "role is allowed only for its INDISTINGUISHABLE state"
            )
        frames.append(
            BallFrameEnumerationV1(
                sequence=sequence,
                frame_index=representative.frame_index,
                timestamp_ns=representative.timestamp_ns,
                decoded_frame_sha256=representative.decoded_frame_sha256,
                frame_identity_sha256=representative.identity.fingerprint(),
                match_ball_status=_match_status(matches[0].visibility),
                match_ball_annotation_id=matches[0].annotation_id,
                annotations=references,
            )
        )
    return CausalBallLabelBundleV1(
        bundle_id=bundle_id,
        source_asset_sha256=source_asset_sha256,
        finalized_trace_sha256=finalized_trace_sha256,
        capture_policy_sha256=capture_policy_sha256,
        capture_policy_generation=capture_policy_generation,
        split=split,
        ontology_sha256=ontology_sha256,
        ontology_version=ontology_version,
        selected_video_stream_index=first_frame.selected_video_stream_index,
        decode_contract_sha256=first_frame.decode_contract.fingerprint(),
        timestamp_basis=first_frame.timestamp_basis,
        pixel_coordinate_space=first_frame.pixel_coordinate_space,
        decoded_frame_hash_basis=first_frame.decoded_frame_hash_basis,
        match_ball_instance_id=match_ball_instance_id,
        target_role=BallRole.MATCH_BALL,
        completeness_scope=LabelCompletenessScope.COMPLETE_FULL_DECODED_FRAME,
        frame_count=len(frames),
        first_timestamp_ns=frames[0].timestamp_ns,
        last_timestamp_ns=frames[-1].timestamp_ns,
        annotation_count=len(annotations),
        annotation_attestation_set_sha256=(
            annotation_attestation_set_fingerprint(attestations)
        ),
        annotation_trust_store_sha256=annotation_trust_store_sha256,
        annotation_verification_policy_sha256=(
            annotation_verification_policy_sha256
        ),
        frames=tuple(frames),
    )


def causal_ball_label_bundle_signing_message(
    statement: CausalBallLabelBundleV1,
    *,
    key_id: str,
    key_role: LabelBundleCuratorKeyRole,
    curator_id: str,
    trust_domain_id: str,
    signed_at_ns: int,
) -> bytes:
    if type(statement) is not CausalBallLabelBundleV1:
        raise ValueError("statement must be a CausalBallLabelBundleV1")
    require_stable_id(key_id, "key_id")
    if key_role is not LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR:
        raise ValueError("key_role has the wrong signing domain")
    require_stable_id(curator_id, "curator_id")
    require_stable_id(trust_domain_id, "trust_domain_id")
    require_exact_int(signed_at_ns, "signed_at_ns")
    return _bounded_json(
        {
            "curator_id": curator_id,
            "domain": LABEL_BUNDLE_SIGNING_DOMAIN,
            "key_id": key_id,
            "key_role": key_role.value,
            "signed_at_ns": signed_at_ns,
            "statement": statement.to_dict(),
            "trust_domain_id": trust_domain_id,
        },
        label="causal ball label bundle signing message",
        maximum=MAX_LABEL_BUNDLE_BYTES + MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
    )


def verify_causal_ball_label_bundle_v1(
    statement: CausalBallLabelBundleV1,
    attestation: CausalBallLabelBundleAttestationV1,
    trust_snapshot: CausalBallLabelBundleTrustSnapshotV1,
    *,
    annotations: tuple[BallFrameAnnotationV2, ...],
    annotation_attestations: tuple[AnnotationAttestation, ...],
    annotation_trust_store: AnnotationTrustStore,
    annotation_verification_policy: AnnotationVerificationPolicy,
    evidence_store_root: Path,
    protected_annotation_configuration_generation_path: Path,
    evaluator_artifact_sha256: str,
    requested_truth_policy: AnnotationMinimumTruthPolicy,
    expected_trust_snapshot_sha256: str,
    expected_trust_snapshot_generation: int,
    expected_current_attestation_sha256: str,
    expected_curator_id: str,
    expected_trust_domain_id: str,
    protected_verified_at_ns: int,
) -> VerifiedCausalBallLabelBundleEvidence:
    """Verify both authorities, returning evidence that never grants admission.

    ``protected_verified_at_ns`` must come from a protected, rollback-resistant
    coordinator clock.  Dataset or curator payloads are not a valid time source.
    """

    if type(statement) is not CausalBallLabelBundleV1:
        _fail("LABEL_BUNDLE_TYPE", "statement has the wrong exact type")
    if type(attestation) is not CausalBallLabelBundleAttestationV1:
        _fail("LABEL_BUNDLE_ATTESTATION_TYPE", "attestation has the wrong exact type")
    if type(trust_snapshot) is not CausalBallLabelBundleTrustSnapshotV1:
        _fail("LABEL_BUNDLE_TRUST_TYPE", "trust snapshot has the wrong exact type")
    if type(annotation_trust_store) is not AnnotationTrustStore:
        _fail("LABEL_BUNDLE_ANNOTATION_TRUST_TYPE", "annotation trust store type is wrong")
    if type(annotation_verification_policy) is not AnnotationVerificationPolicy:
        _fail("LABEL_BUNDLE_ANNOTATION_POLICY_TYPE", "annotation policy type is wrong")
    if type(requested_truth_policy) is not AnnotationMinimumTruthPolicy:
        _fail("LABEL_BUNDLE_TRUTH_POLICY_TYPE", "truth policy type is wrong")
    protected_verified_at = require_exact_int(
        protected_verified_at_ns,
        "protected_verified_at_ns",
    )
    require_sha256(expected_trust_snapshot_sha256, "expected_trust_snapshot_sha256")
    require_exact_int(
        expected_trust_snapshot_generation,
        "expected_trust_snapshot_generation",
    )
    require_sha256(
        expected_current_attestation_sha256,
        "expected_current_attestation_sha256",
    )
    require_stable_id(expected_curator_id, "expected_curator_id")
    require_stable_id(expected_trust_domain_id, "expected_trust_domain_id")
    if trust_snapshot.fingerprint() != expected_trust_snapshot_sha256:
        _fail("LABEL_BUNDLE_TRUST_PIN", "trust snapshot differs from protected pin")
    if trust_snapshot.snapshot_generation != expected_trust_snapshot_generation:
        _fail("LABEL_BUNDLE_TRUST_GENERATION", "trust generation differs from pin")
    if (
        trust_snapshot.curator_id != expected_curator_id
        or attestation.curator_id != expected_curator_id
        or trust_snapshot.trust_domain_id != expected_trust_domain_id
        or attestation.trust_domain_id != expected_trust_domain_id
    ):
        _fail("LABEL_BUNDLE_SCOPE", "curator or trust domain differs from protected scope")
    statement_sha256 = statement.fingerprint()
    attestation_sha256 = attestation.fingerprint()
    current = trust_snapshot.current_bundle
    if (
        current.bundle_id != statement.bundle_id
        or current.statement_sha256 != statement_sha256
        or current.attestation_sha256 != attestation_sha256
        or current.attestation_sha256 != expected_current_attestation_sha256
    ):
        _fail("LABEL_BUNDLE_CURRENT", "statement or attestation is not exactly current")
    if statement_sha256 in trust_snapshot.revoked_statement_sha256s:
        _fail("LABEL_BUNDLE_REVOKED", "label bundle statement is revoked")
    if attestation.statement_sha256 != statement_sha256:
        _fail("LABEL_BUNDLE_ATTESTATION_BINDING", "attestation binds another statement")
    if attestation.key_id != trust_snapshot.current_key_id:
        _fail("LABEL_BUNDLE_KEY_NOT_CURRENT", "attestation did not use the current key")
    key = next(
        item for item in trust_snapshot.keys if item.key_id == trust_snapshot.current_key_id
    )
    if (
        key.curator_id != attestation.curator_id
        or key.key_role is not attestation.key_role
    ):
        _fail("LABEL_BUNDLE_KEY_SCOPE", "key identity or role differs")
    if not key.valid_from_ns <= attestation.signed_at_ns <= key.valid_until_ns:
        _fail("LABEL_BUNDLE_KEY_DATE", "key was not valid at signature time")
    if not attestation.signed_at_ns <= protected_verified_at <= key.valid_until_ns:
        _fail("LABEL_BUNDLE_VERIFICATION_DATE", "signature/key is not current at verification")
    if key.revoked_at_ns is not None and key.revoked_at_ns <= protected_verified_at:
        _fail("LABEL_BUNDLE_KEY_REVOKED", "current curator key is revoked")
    try:
        key.public_key.verify(
            attestation.signature,
            causal_ball_label_bundle_signing_message(
                statement,
                key_id=attestation.key_id,
                key_role=attestation.key_role,
                curator_id=attestation.curator_id,
                trust_domain_id=attestation.trust_domain_id,
                signed_at_ns=attestation.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        _fail("LABEL_BUNDLE_SIGNATURE_INVALID", "curator signature is invalid")
        raise AssertionError from exc
    if annotation_trust_store.fingerprint() != statement.annotation_trust_store_sha256:
        _fail("LABEL_BUNDLE_ANNOTATION_TRUST_BINDING", "annotation trust store differs")
    curator_public_keys = {
        item.public_key_base64 for item in trust_snapshot.keys
    }
    annotation_public_keys = {
        item.public_key_base64 for item in annotation_trust_store.keys
    }
    if curator_public_keys & annotation_public_keys:
        _fail(
            "LABEL_BUNDLE_AUTHORITY_KEY_OVERLAP",
            "curator and Annotation Truth authorities must use disjoint keys",
        )
    if (
        annotation_verification_policy.fingerprint()
        != statement.annotation_verification_policy_sha256
    ):
        _fail("LABEL_BUNDLE_ANNOTATION_POLICY_BINDING", "annotation policy differs")
    try:
        rebuilt = build_causal_ball_label_bundle_v1(
            bundle_id=statement.bundle_id,
            source_asset_sha256=statement.source_asset_sha256,
            finalized_trace_sha256=statement.finalized_trace_sha256,
            capture_policy_sha256=statement.capture_policy_sha256,
            capture_policy_generation=statement.capture_policy_generation,
            split=statement.split,
            ontology_sha256=statement.ontology_sha256,
            ontology_version=statement.ontology_version,
            match_ball_instance_id=statement.match_ball_instance_id,
            annotations=annotations,
            attestations=annotation_attestations,
            annotation_trust_store_sha256=statement.annotation_trust_store_sha256,
            annotation_verification_policy_sha256=(
                statement.annotation_verification_policy_sha256
            ),
        )
    except ValueError as exc:
        _fail("LABEL_BUNDLE_CONCRETE_BINDING", str(exc))
        raise AssertionError from exc
    if rebuilt.to_json_bytes() != statement.to_json_bytes():
        _fail(
            "LABEL_BUNDLE_CONCRETE_BINDING",
            "concrete annotations or attestations differ from the signed enumeration",
        )
    annotation_verification = annotation_trust_store.verify_annotation_set(
        annotations,
        annotation_attestations,
        evidence_store_root=evidence_store_root,
        verification_policy=annotation_verification_policy,
        expected_verification_policy_sha256=(
            statement.annotation_verification_policy_sha256
        ),
        protected_configuration_generation_path=(
            protected_annotation_configuration_generation_path
        ),
        evaluator_artifact_sha256=evaluator_artifact_sha256,
        requested_truth_policy=requested_truth_policy.value,
        protected_verified_at_ns=protected_verified_at,
    )
    if (
        annotation_verification.trust_store_sha256
        != statement.annotation_trust_store_sha256
        or annotation_verification.verification_policy_sha256
        != statement.annotation_verification_policy_sha256
        or annotation_verification.attestation_set_sha256
        != statement.annotation_attestation_set_sha256
        or annotation_verification.requested_truth_policy
        is not requested_truth_policy
        or annotation_verification.protected_verified_at_ns
        != protected_verified_at
    ):
        _fail(
            "LABEL_BUNDLE_ANNOTATION_VERIFICATION_BINDING",
            "annotation verification result differs from the signed bundle",
        )
    return _VerifiedCausalBallLabelBundleEvidence(
        statement_sha256=statement_sha256,
        attestation_sha256=attestation_sha256,
        trust_snapshot_sha256=trust_snapshot.fingerprint(),
        annotation_trust_store_sha256=annotation_verification.trust_store_sha256,
        annotation_verification_policy_sha256=(
            annotation_verification.verification_policy_sha256
        ),
        annotation_attestation_set_sha256=(
            annotation_verification.attestation_set_sha256
        ),
        annotation_configuration_generation_sha256=(
            annotation_verification.protected_configuration_generation_sha256
        ),
        annotation_evidence_set_sha256=(
            annotation_verification.evidence_set_sha256
        ),
        annotation_evidence_generation_id=(
            annotation_verification.evidence_generation_id
        ),
        requested_truth_policy=annotation_verification.requested_truth_policy,
        trust_snapshot_generation=trust_snapshot.snapshot_generation,
        protected_verified_at_ns=(
            annotation_verification.protected_verified_at_ns
        ),
        bundle_id=statement.bundle_id,
        split=statement.split,
    )


__all__ = [
    "LABEL_BUNDLE_SCHEMA_VERSION",
    "LABEL_BUNDLE_SIGNING_DOMAIN",
    "BallAnnotationReferenceV1",
    "BallFrameEnumerationV1",
    "CausalBallLabelBundleAttestationV1",
    "CausalBallLabelBundleTrustSnapshotV1",
    "CausalBallLabelBundleV1",
    "CurrentCausalBallLabelBundleV1",
    "LabelBundleCuratorKeyRole",
    "LabelBundleError",
    "LabelBundleEvidenceStatus",
    "LabelBundleSplit",
    "LabelCompletenessScope",
    "MatchBallFrameStatus",
    "TrustedLabelBundleCuratorKeyV1",
    "VerifiedCausalBallLabelBundleEvidence",
    "build_causal_ball_label_bundle_v1",
    "causal_ball_label_bundle_signing_message",
    "verify_causal_ball_label_bundle_v1",
]
