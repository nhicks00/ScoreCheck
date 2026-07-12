"""Fail-closed finalized capture and video-only review provenance.

This module is a pure control-plane boundary.  It hashes exact fragment and
clip bytes supplied by its caller, re-runs the structural capture evaluator,
recomputes the evidence-window plan, and verifies current capture-session
rights.  It never opens media and therefore makes no codec, stream-layout,
decoded-pixel, physical-camera, or semantic-scoring claim.

The finalized capture record is structurally checked metadata, not a trusted
media or capture attestation. Serialized metadata authenticity additionally
requires its distinct domain-separated metadata signature and current/revoked
trust snapshot. The durable review record is intentionally
named *provenance*, not a verified render.  Its frame map is a one-to-one
metadata commitment to source PTS and presentation identities;
``NOT_INSPECTED`` fields make explicit that the clip bytes have not been
decoded and compared with that map.  A later isolated, signed
renderer/validator boundary must replace those statuses before content can be
presented as a verified ReviewClip.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .capture_contracts import (
    MAX_CLOSED_FRAGMENTS,
    MAX_FINALIZED_FRAMES,
    MAX_FINALIZED_SOURCE_BYTES,
    MAX_SIGNED_64,
    CaptureFragmentDescriptor,
    CaptureSessionDescriptor,
    CaptureSourceKind,
    CaptureTraceRecord,
    CaptureTrustDomain,
    EvidenceWindowPlan,
    EvidenceWindowRequest,
    EvidenceWindowStatus,
    FinalizedSourceFrameSignal,
    IntegrityDisposition,
)
from .capture_integrity import ClockMappingCandidate, evaluate_capture_trace
from .capture_rights import (
    CAPTURE_OPERATION_REQUIRED_USES,
    MAX_CAMERA_IDS,
    MAX_PARTICIPANT_IDS,
    CaptureRightsTrustSnapshot,
    CaptureSessionRightsGrant,
    CaptureSessionRightsGrantAttestation,
    verify_capture_session_rights,
)
from .capture_windows import plan_evidence_window
from .rights import PermittedUse


CAPTURE_ASSET_SCHEMA_VERSION = "1.0"
FINALIZED_CAPTURE_METADATA_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:finalized-capture-metadata:v1"
)
MAX_CAPTURE_ASSET_JSON_BYTES = 2 * 1024 * 1024
MAX_CAPTURE_ASSET_JSON_DEPTH = 16
MAX_CAPTURE_ASSET_JSON_NODES = 50_000
MAX_CAPTURE_ASSET_JSON_CONTAINERS = 10_000
MAX_CAPTURE_ASSET_REVOKED_IDENTITIES = 256
MAX_CAPTURE_ASSET_SIGNER_KEYS = 64
MAX_CURRENT_FINALIZED_METADATA = 256
MAX_REVIEW_CLIP_BYTES = 128 * 1024 * 1024

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


class CaptureAssetError(ValueError):
    """Construction, parsing, or verification failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaptureAssetError(code, message)


def _require_exact_int(
    value: object,
    field_name: str,
    *,
    minimum: int = 0,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{field_name} must be an exact integer in [{minimum}, {maximum}]"
        )
    return value


def _require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _canonical_base64(
    value: object,
    field_name: str,
    *,
    expected_bytes: int,
) -> bytes:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        decoded = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if (
        len(decoded) != expected_bytes
        or base64.b64encode(decoded).decode("ascii") != value
    ):
        raise ValueError(
            f"{field_name} must be canonical base64 for {expected_bytes} bytes"
        )
    return decoded


def _require_country(value: object, field_name: str) -> str:
    if type(value) is not str or _COUNTRY_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ISO alpha-2 country code")
    return value


def _require_permitted_use(value: object, field_name: str) -> PermittedUse:
    if type(value) is not PermittedUse:
        raise ValueError(f"{field_name} must be a PermittedUse")
    return value


def _require_canonical_tuple(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
    validator: Any,
) -> tuple[Any, ...]:
    if type(value) is not tuple or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{field_name} must be an immutable tuple with {minimum} to "
            f"{maximum} items"
        )
    for item in value:
        validator(item, f"{field_name} item")
    order = tuple(
        sorted(value, key=lambda item: item.value if isinstance(item, Enum) else item)
    )
    if value != order or len(set(value)) != len(value):
        raise ValueError(f"{field_name} must be unique and canonically sorted")
    return value


def _canonical_json_bytes(value: Mapping[str, Any], *, label: str) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if len(encoded) > MAX_CAPTURE_ASSET_JSON_BYTES:
        raise ValueError(
            f"{label} exceeds {MAX_CAPTURE_ASSET_JSON_BYTES} bytes"
        )
    return encoded


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DUPLICATE_JSON_KEY", f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite(token: str) -> None:
    _fail("NONFINITE_JSON_NUMBER", f"nonfinite JSON number: {token}")


def _parse_bounded_json_integer(token: str) -> int:
    if len(token) > 20:
        _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    try:
        value = int(token, 10)
    except ValueError as exc:
        _fail("INVALID_JSON_NUMBER", "JSON integer is invalid")
        raise AssertionError from exc
    if not -(1 << 63) <= value <= MAX_SIGNED_64:
        _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    return value


def _reject_float(token: str) -> None:
    _fail("INVALID_JSON_NUMBER", f"floating JSON number is forbidden: {token}")


def _measure_json(value: object, *, depth: int = 1) -> tuple[int, int]:
    if depth > MAX_CAPTURE_ASSET_JSON_DEPTH:
        _fail("JSON_DEPTH_EXCEEDED", "capture-asset JSON is too deeply nested")
    nodes = 1
    containers = 0
    if type(value) is dict:
        containers = 1
        for key, item in value.items():
            if type(key) is not str:
                _fail("INVALID_JSON_KEY", "JSON object keys must be strings")
            child_nodes, child_containers = _measure_json(item, depth=depth + 1)
            nodes += child_nodes
            containers += child_containers
    elif type(value) is list:
        containers = 1
        for item in value:
            child_nodes, child_containers = _measure_json(item, depth=depth + 1)
            nodes += child_nodes
            containers += child_containers
    elif value is not None and type(value) not in (str, int, bool):
        _fail("INVALID_JSON_VALUE", "unsupported JSON value")
    if nodes > MAX_CAPTURE_ASSET_JSON_NODES:
        _fail("JSON_NODE_LIMIT_EXCEEDED", "capture-asset JSON has too many nodes")
    if containers > MAX_CAPTURE_ASSET_JSON_CONTAINERS:
        _fail(
            "JSON_CONTAINER_LIMIT_EXCEEDED",
            "capture-asset JSON has too many containers",
        )
    return nodes, containers


def _parse_canonical_json(raw: bytes, *, label: str) -> dict[str, Any]:
    if type(raw) is not bytes:
        _fail("JSON_TYPE", f"{label} must be exact bytes")
    if not raw or len(raw) > MAX_CAPTURE_ASSET_JSON_BYTES:
        _fail("JSON_SIZE", f"{label} has an invalid byte length")
    try:
        value = json.loads(
            raw.decode("ascii", errors="strict"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite,
            parse_int=_parse_bounded_json_integer,
            parse_float=_reject_float,
        )
    except CaptureAssetError:
        raise
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("INVALID_JSON", f"{label} must be valid ASCII JSON")
        raise AssertionError from exc
    try:
        _measure_json(value)
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    if type(value) is not dict:
        _fail("JSON_ROOT", f"{label} root must be an object")
    if _canonical_json_bytes(value, label=label) != raw:
        _fail("NONCANONICAL_JSON", f"{label} must use canonical JSON encoding")
    return value


def _require_fields(value: object, expected: set[str], *, label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an exact JSON object")
    actual = set(value)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        raise ValueError(
            f"{label} field set mismatch; missing={missing}, extra={extra}"
        )
    return value


def _exact_list(value: Mapping[str, Any], field_name: str, *, label: str) -> list[Any]:
    selected = value[field_name]
    if type(selected) is not list:
        raise ValueError(f"{label}.{field_name} must be a JSON array")
    return selected


def _enum_from_json(enum_type: type[Enum], value: object, field_name: str) -> Enum:
    if type(value) is not str:
        raise ValueError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} has an unsupported enum value") from exc


class FinalizedSourceAssembly(str, Enum):
    ORDERED_SELECTED_FRAGMENT_CONCAT_V1 = (
        "ORDERED_SELECTED_FRAGMENT_CONCAT_V1"
    )


class ProvenanceScope(str, Enum):
    VIDEO_FRAMES_ONLY = "VIDEO_FRAMES_ONLY"


class ContentInspectionStatus(str, Enum):
    NOT_INSPECTED = "NOT_INSPECTED"


class AudioProvenanceStatus(str, Enum):
    ABSENT_FROM_CONTRACT_NOT_INSPECTED = (
        "ABSENT_FROM_CONTRACT_NOT_INSPECTED"
    )


class FrameDerivationStatus(str, Enum):
    NOT_VERIFIED_AGAINST_CLIP_BYTES = "NOT_VERIFIED_AGAINST_CLIP_BYTES"


class CaptureAssetKeyRole(str, Enum):
    FINALIZED_CAPTURE_METADATA_SIGNER = "FINALIZED_CAPTURE_METADATA_SIGNER"


class CaptureReferenceStatus(str, Enum):
    PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED = (
        "PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED"
    )


class AssetResidencyStatus(str, Enum):
    NOT_VERIFIED = "NOT_VERIFIED"


class BoundaryAdmissibilityStatus(str, Enum):
    NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION = (
        "NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION"
    )
    NOT_ADMISSIBLE_PENDING_RENDERER_DECODER_AND_RESIDENCY_VALIDATION = (
        "NOT_ADMISSIBLE_PENDING_RENDERER_DECODER_AND_RESIDENCY_VALIDATION"
    )


_CAPTURE_METADATA_NOT_ADMISSIBLE = (
    BoundaryAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION
)
_REVIEW_PROVENANCE_NOT_ADMISSIBLE = (
    BoundaryAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_RENDERER_DECODER_AND_RESIDENCY_VALIDATION
)


@dataclass(frozen=True, slots=True)
class CaptureSourceScope:
    match_id: str
    capture_session_id: str
    venue_id: str
    camera_id: str
    camera_ids: tuple[str, ...]
    stream_id: str
    roster_scope_sha256: str
    participant_ids: tuple[str, ...]
    geography: str
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported capture-source-scope schema")
        for field_name in (
            "match_id",
            "capture_session_id",
            "venue_id",
            "camera_id",
            "stream_id",
        ):
            _require_stable_id(getattr(self, field_name), field_name)
        _require_canonical_tuple(
            self.camera_ids,
            "camera_ids",
            minimum=1,
            maximum=MAX_CAMERA_IDS,
            validator=_require_stable_id,
        )
        if self.camera_id not in self.camera_ids:
            raise ValueError("camera_id must be a member of the exact camera scope")
        _require_sha256(self.roster_scope_sha256, "roster_scope_sha256")
        _require_canonical_tuple(
            self.participant_ids,
            "participant_ids",
            minimum=1,
            maximum=MAX_PARTICIPANT_IDS,
            validator=_require_stable_id,
        )
        _require_country(self.geography, "geography")

    def to_dict(self) -> dict[str, Any]:
        return {
            "camera_id": self.camera_id,
            "camera_ids": list(self.camera_ids),
            "capture_session_id": self.capture_session_id,
            "geography": self.geography,
            "match_id": self.match_id,
            "participant_ids": list(self.participant_ids),
            "roster_scope_sha256": self.roster_scope_sha256,
            "schema_version": self.schema_version,
            "stream_id": self.stream_id,
            "venue_id": self.venue_id,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture source scope")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureSourceScope":
        value = _parse_canonical_json(raw, label="capture source scope")
        try:
            _require_fields(value, set(cls.__dataclass_fields__), label="capture source scope")
            return cls(
                **{
                    **value,
                    "camera_ids": tuple(
                        _exact_list(value, "camera_ids", label="capture source scope")
                    ),
                    "participant_ids": tuple(
                        _exact_list(
                            value,
                            "participant_ids",
                            label="capture source scope",
                        )
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_SOURCE_SCOPE", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class FinalizedAssetClaim:
    asset_id: str
    asset_sha256: str
    byte_length: int
    assembly: FinalizedSourceAssembly
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported finalized-asset-claim schema")
        _require_stable_id(self.asset_id, "asset_id")
        _require_sha256(self.asset_sha256, "asset_sha256")
        _require_exact_int(
            self.byte_length,
            "byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        if type(self.assembly) is not FinalizedSourceAssembly:
            raise ValueError("assembly must be a FinalizedSourceAssembly")

    def to_dict(self) -> dict[str, Any]:
        return {
            "assembly": self.assembly.value,
            "asset_id": self.asset_id,
            "asset_sha256": self.asset_sha256,
            "byte_length": self.byte_length,
            "schema_version": self.schema_version,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="finalized asset claim")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "FinalizedAssetClaim":
        value = _parse_canonical_json(raw, label="finalized asset claim")
        try:
            _require_fields(value, set(cls.__dataclass_fields__), label="finalized asset claim")
            return cls(
                **{
                    **value,
                    "assembly": _enum_from_json(
                        FinalizedSourceAssembly, value["assembly"], "assembly"
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_FINALIZED_ASSET_CLAIM", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class CaptureAssetTrustPolicy:
    policy_id: str
    policy_generation: int
    trust_domain_id: str
    valid_from_ns: int
    valid_until_ns: int
    deployment_id: str
    match_id: str
    capture_session_id: str
    venue_id: str
    camera_id: str
    stream_id: str
    session_fingerprint: str
    session_configuration_fingerprint: str
    camera_attestation_sha256: str
    clock_attestation_sha256: str
    clock_mapping_fingerprint: str
    capture_profile_sha256: str
    backend_artifact_sha256: str
    encoder_configuration_sha256: str
    exposure_configuration_sha256: str
    max_clock_absolute_error_ns: int
    revoked_session_fingerprints: tuple[str, ...] = ()
    revoked_camera_attestation_sha256s: tuple[str, ...] = ()
    revoked_clock_attestation_sha256s: tuple[str, ...] = ()
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported capture-asset-trust-policy schema")
        for field_name in (
            "policy_id",
            "trust_domain_id",
            "deployment_id",
            "match_id",
            "capture_session_id",
            "venue_id",
            "camera_id",
            "stream_id",
        ):
            _require_stable_id(getattr(self, field_name), field_name)
        _require_exact_int(self.policy_generation, "policy_generation")
        valid_from = _require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = _require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("capture trust policy validity interval is reversed")
        for field_name in (
            "session_fingerprint",
            "session_configuration_fingerprint",
            "camera_attestation_sha256",
            "clock_attestation_sha256",
            "clock_mapping_fingerprint",
            "capture_profile_sha256",
            "backend_artifact_sha256",
            "encoder_configuration_sha256",
            "exposure_configuration_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_exact_int(
            self.max_clock_absolute_error_ns,
            "max_clock_absolute_error_ns",
        )
        for field_name in (
            "revoked_session_fingerprints",
            "revoked_camera_attestation_sha256s",
            "revoked_clock_attestation_sha256s",
        ):
            _require_canonical_tuple(
                getattr(self, field_name),
                field_name,
                minimum=0,
                maximum=MAX_CAPTURE_ASSET_REVOKED_IDENTITIES,
                validator=_require_sha256,
            )
        if self.session_fingerprint in self.revoked_session_fingerprints:
            raise ValueError("current session fingerprint cannot also be revoked")
        if (
            self.camera_attestation_sha256
            in self.revoked_camera_attestation_sha256s
        ):
            raise ValueError("current camera attestation cannot also be revoked")
        if self.clock_attestation_sha256 in self.revoked_clock_attestation_sha256s:
            raise ValueError("current clock attestation cannot also be revoked")

    def to_dict(self) -> dict[str, Any]:
        return {
            name: (
                list(item)
                if name.startswith("revoked_")
                else item
            )
            for name, item in (
                (field_name, getattr(self, field_name))
                for field_name in self.__dataclass_fields__
            )
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_dict(), label="capture asset trust policy"
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureAssetTrustPolicy":
        value = _parse_canonical_json(raw, label="capture asset trust policy")
        try:
            _require_fields(
                value, set(cls.__dataclass_fields__), label="capture asset trust policy"
            )
            return cls(
                **{
                    **value,
                    "revoked_session_fingerprints": tuple(
                        _exact_list(
                            value,
                            "revoked_session_fingerprints",
                            label="capture asset trust policy",
                        )
                    ),
                    "revoked_camera_attestation_sha256s": tuple(
                        _exact_list(
                            value,
                            "revoked_camera_attestation_sha256s",
                            label="capture asset trust policy",
                        )
                    ),
                    "revoked_clock_attestation_sha256s": tuple(
                        _exact_list(
                            value,
                            "revoked_clock_attestation_sha256s",
                            label="capture asset trust policy",
                        )
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_ASSET_TRUST_POLICY", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class FinalizedCaptureMetadataAttestation:
    """Authenticates canonical metadata only, never media or capture truth."""

    metadata_sha256: str
    key_id: str
    key_role: CaptureAssetKeyRole
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported finalized-capture-metadata-attestation schema")
        _require_sha256(self.metadata_sha256, "metadata_sha256")
        _require_stable_id(self.key_id, "key_id")
        if type(self.key_role) is not CaptureAssetKeyRole:
            raise ValueError("key_role must be a CaptureAssetKeyRole")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_exact_int(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    @property
    def signature(self) -> bytes:
        return _canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "schema_version": self.schema_version,
            "signature_base64": self.signature_base64,
            "signed_at_ns": self.signed_at_ns,
            "metadata_sha256": self.metadata_sha256,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_dict(), label="finalized capture metadata attestation"
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "FinalizedCaptureMetadataAttestation":
        value = _parse_canonical_json(
            raw, label="finalized capture metadata attestation"
        )
        try:
            _require_fields(
                value,
                set(cls.__dataclass_fields__),
                label="finalized capture metadata attestation",
            )
            return cls(
                **{
                    **value,
                    "key_role": _enum_from_json(
                        CaptureAssetKeyRole, value["key_role"], "key_role"
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_METADATA_ATTESTATION", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class TrustedCaptureMetadataSignerKey:
    key_id: str
    key_role: CaptureAssetKeyRole
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None

    def __post_init__(self) -> None:
        _require_stable_id(self.key_id, "key_id")
        if type(self.key_role) is not CaptureAssetKeyRole:
            raise ValueError("key_role must be a CaptureAssetKeyRole")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = _require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("metadata signer validity interval is reversed")
        if self.revoked_at_ns is not None:
            _require_exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }


@dataclass(frozen=True, slots=True)
class CurrentFinalizedCaptureMetadata:
    metadata_id: str
    asset_sha256: str
    metadata_sha256: str

    def __post_init__(self) -> None:
        _require_stable_id(self.metadata_id, "metadata_id")
        _require_sha256(self.asset_sha256, "asset_sha256")
        _require_sha256(self.metadata_sha256, "metadata_sha256")

    def to_dict(self) -> dict[str, str]:
        return {
            "asset_sha256": self.asset_sha256,
            "metadata_id": self.metadata_id,
            "metadata_sha256": self.metadata_sha256,
        }


@dataclass(frozen=True, slots=True)
class FinalizedCaptureMetadataTrustSnapshot:
    """Current/revoked trust for metadata signatures, not capture devices."""

    trust_domain_id: str
    capture_policy_sha256: str
    capture_policy_generation: int
    keys: tuple[TrustedCaptureMetadataSignerKey, ...]
    current_metadata: tuple[CurrentFinalizedCaptureMetadata, ...]
    revoked_metadata_sha256s: tuple[str, ...]
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported finalized-capture-metadata-trust-snapshot schema")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_sha256(self.capture_policy_sha256, "capture_policy_sha256")
        _require_exact_int(
            self.capture_policy_generation, "capture_policy_generation"
        )
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_CAPTURE_ASSET_SIGNER_KEYS
            or any(
                type(item) is not TrustedCaptureMetadataSignerKey
                for item in self.keys
            )
        ):
            raise ValueError("keys must be a bounded immutable signer-key tuple")
        if self.keys != tuple(sorted(self.keys, key=lambda item: item.key_id)):
            raise ValueError("keys must be sorted by key_id")
        if len({item.key_id for item in self.keys}) != len(self.keys):
            raise ValueError("metadata signer key IDs cannot repeat")
        if len({item.public_key_base64 for item in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot have multiple metadata identities")
        if (
            type(self.current_metadata) is not tuple
            or len(self.current_metadata) > MAX_CURRENT_FINALIZED_METADATA
            or any(
                type(item) is not CurrentFinalizedCaptureMetadata
                for item in self.current_metadata
            )
        ):
            raise ValueError("current_metadata must be a bounded immutable tuple")
        if self.current_metadata != tuple(
            sorted(self.current_metadata, key=lambda item: item.metadata_id)
        ):
            raise ValueError("current_metadata must be sorted by metadata_id")
        if len({item.metadata_id for item in self.current_metadata}) != len(
            self.current_metadata
        ):
            raise ValueError("each metadata_id may have only one current metadata")
        if len({item.metadata_sha256 for item in self.current_metadata}) != len(
            self.current_metadata
        ):
            raise ValueError("one metadata record cannot be current under two IDs")
        if len({item.asset_sha256 for item in self.current_metadata}) != len(
            self.current_metadata
        ):
            raise ValueError(
                "one finalized asset cannot be current under multiple metadata IDs"
            )
        _require_canonical_tuple(
            self.revoked_metadata_sha256s,
            "revoked_metadata_sha256s",
            minimum=0,
            maximum=MAX_CAPTURE_ASSET_REVOKED_IDENTITIES,
            validator=_require_sha256,
        )
        if {item.metadata_sha256 for item in self.current_metadata} & set(
            self.revoked_metadata_sha256s
        ):
            raise ValueError("a revoked metadata record cannot also be current")

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_policy_generation": self.capture_policy_generation,
            "capture_policy_sha256": self.capture_policy_sha256,
            "current_metadata": [item.to_dict() for item in self.current_metadata],
            "keys": [item.to_dict() for item in self.keys],
            "revoked_metadata_sha256s": list(self.revoked_metadata_sha256s),
            "schema_version": self.schema_version,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_dict(), label="finalized capture metadata trust snapshot"
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(
        cls, raw: bytes
    ) -> "FinalizedCaptureMetadataTrustSnapshot":
        value = _parse_canonical_json(
            raw, label="finalized capture metadata trust snapshot"
        )
        try:
            _require_fields(
                value,
                set(cls.__dataclass_fields__),
                label="finalized capture metadata trust snapshot",
            )
            raw_keys = _exact_list(
                value, "keys", label="finalized capture metadata trust snapshot"
            )
            if len(raw_keys) > MAX_CAPTURE_ASSET_SIGNER_KEYS:
                raise ValueError("metadata trust snapshot has too many keys")
            keys: list[TrustedCaptureMetadataSignerKey] = []
            for index, raw_key in enumerate(raw_keys):
                key_value = _require_fields(
                    raw_key,
                    set(TrustedCaptureMetadataSignerKey.__dataclass_fields__),
                    label=f"keys[{index}]",
                )
                keys.append(
                    TrustedCaptureMetadataSignerKey(
                        **{
                            **key_value,
                            "key_role": _enum_from_json(
                                CaptureAssetKeyRole,
                                key_value["key_role"],
                                f"keys[{index}].key_role",
                            ),
                        }
                    )
                )
            raw_sources = _exact_list(
                value,
                "current_metadata",
                label="finalized capture metadata trust snapshot",
            )
            if len(raw_sources) > MAX_CURRENT_FINALIZED_METADATA:
                raise ValueError("metadata trust snapshot has too many current records")
            sources = tuple(
                CurrentFinalizedCaptureMetadata(
                    **_require_fields(
                        raw_source,
                        set(CurrentFinalizedCaptureMetadata.__dataclass_fields__),
                        label=f"current_metadata[{index}]",
                    )
                )
                for index, raw_source in enumerate(raw_sources)
            )
            return cls(
                **{
                    **value,
                    "keys": tuple(keys),
                    "current_metadata": sources,
                    "revoked_metadata_sha256s": tuple(
                        _exact_list(
                            value,
                            "revoked_metadata_sha256s",
                            label="finalized capture metadata trust snapshot",
                        )
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_METADATA_TRUST_SNAPSHOT", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class StructurallyVerifiedCaptureMetadata:
    """Exact byte/trace metadata that remains inadmissible for product use."""

    metadata_id: str
    asset_id: str
    asset_claim_sha256: str
    asset_sha256: str
    asset_byte_length: int
    assembly: FinalizedSourceAssembly
    scope_fingerprint: str
    deployment_id: str
    match_id: str
    capture_session_id: str
    venue_id: str
    camera_id: str
    camera_ids: tuple[str, ...]
    stream_id: str
    roster_scope_sha256: str
    participant_ids: tuple[str, ...]
    geography: str
    reconnect_epoch: int
    session_fingerprint: str
    session_configuration_fingerprint: str
    window_request_fingerprint: str
    window_plan_fingerprint: str
    requested_start_ns: int
    requested_end_ns: int
    actual_start_ns: int
    actual_end_ns: int
    selected_fragment_ids: tuple[str, ...]
    selected_fragment_fingerprints: tuple[str, ...]
    finalized_trace_sha256: str
    integrity_report_sha256: str
    integrity_window_sha256: str
    clock_mapping_fingerprint: str
    frame_count: int
    source_start_pts: int
    source_end_pts: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    evidence_start_ns: int
    evidence_end_ns: int
    capture_policy_sha256: str
    capture_policy_generation: int
    capture_rights_grant_sha256: str
    capture_rights_attestation_sha256: str
    capture_rights_trust_snapshot_sha256: str
    rights_policy_sha256: str
    rights_policy_generation: int
    verified_at_ns: int
    provenance_scope: ProvenanceScope = ProvenanceScope.VIDEO_FRAMES_ONLY
    content_inspection_status: ContentInspectionStatus = (
        ContentInspectionStatus.NOT_INSPECTED
    )
    audio_provenance_status: AudioProvenanceStatus = (
        AudioProvenanceStatus.ABSENT_FROM_CONTRACT_NOT_INSPECTED
    )
    capture_reference_status: CaptureReferenceStatus = (
        CaptureReferenceStatus.PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED
    )
    asset_residency_status: AssetResidencyStatus = AssetResidencyStatus.NOT_VERIFIED
    admissibility_status: BoundaryAdmissibilityStatus = (
        _CAPTURE_METADATA_NOT_ADMISSIBLE
    )
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported structurally-verified-capture-metadata schema")
        for field_name in (
            "metadata_id",
            "asset_id",
            "deployment_id",
            "match_id",
            "capture_session_id",
            "venue_id",
            "camera_id",
            "stream_id",
        ):
            _require_stable_id(getattr(self, field_name), field_name)
        for field_name in (
            "asset_sha256",
            "asset_claim_sha256",
            "scope_fingerprint",
            "roster_scope_sha256",
            "session_fingerprint",
            "session_configuration_fingerprint",
            "window_request_fingerprint",
            "window_plan_fingerprint",
            "finalized_trace_sha256",
            "integrity_report_sha256",
            "integrity_window_sha256",
            "clock_mapping_fingerprint",
            "capture_policy_sha256",
            "capture_rights_grant_sha256",
            "capture_rights_attestation_sha256",
            "capture_rights_trust_snapshot_sha256",
            "rights_policy_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_exact_int(
            self.asset_byte_length,
            "asset_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        if type(self.assembly) is not FinalizedSourceAssembly:
            raise ValueError("assembly must be a FinalizedSourceAssembly")
        reconstructed_claim = FinalizedAssetClaim(
            asset_id=self.asset_id,
            asset_sha256=self.asset_sha256,
            byte_length=self.asset_byte_length,
            assembly=self.assembly,
        )
        if reconstructed_claim.fingerprint() != self.asset_claim_sha256:
            raise ValueError(
                "asset_claim_sha256 differs from the embedded asset identity"
            )
        _require_canonical_tuple(
            self.camera_ids,
            "camera_ids",
            minimum=1,
            maximum=MAX_CAMERA_IDS,
            validator=_require_stable_id,
        )
        if self.camera_id not in self.camera_ids:
            raise ValueError("camera_id must be in camera_ids")
        _require_canonical_tuple(
            self.participant_ids,
            "participant_ids",
            minimum=1,
            maximum=MAX_PARTICIPANT_IDS,
            validator=_require_stable_id,
        )
        _require_country(self.geography, "geography")
        reconstructed_scope = CaptureSourceScope(
            match_id=self.match_id,
            capture_session_id=self.capture_session_id,
            venue_id=self.venue_id,
            camera_id=self.camera_id,
            camera_ids=self.camera_ids,
            stream_id=self.stream_id,
            roster_scope_sha256=self.roster_scope_sha256,
            participant_ids=self.participant_ids,
            geography=self.geography,
        )
        if reconstructed_scope.fingerprint() != self.scope_fingerprint:
            raise ValueError("scope_fingerprint differs from the embedded scope")
        for field_name in (
            "reconnect_epoch",
            "requested_start_ns",
            "requested_end_ns",
            "actual_start_ns",
            "actual_end_ns",
            "frame_count",
            "source_time_base_numerator",
            "source_time_base_denominator",
            "evidence_start_ns",
            "evidence_end_ns",
            "capture_policy_generation",
            "rights_policy_generation",
            "verified_at_ns",
        ):
            minimum = 1 if field_name in (
                "frame_count",
                "source_time_base_numerator",
                "source_time_base_denominator",
            ) else 0
            _require_exact_int(getattr(self, field_name), field_name, minimum=minimum)
        _require_exact_int(
            self.source_start_pts,
            "source_start_pts",
            minimum=-(1 << 63),
        )
        _require_exact_int(
            self.source_end_pts,
            "source_end_pts",
            minimum=-(1 << 63),
        )
        if math.gcd(
            self.source_time_base_numerator, self.source_time_base_denominator
        ) != 1:
            raise ValueError("source time base must be a reduced rational")
        if not (
            self.actual_start_ns <= self.requested_start_ns
            <= self.requested_end_ns <= self.actual_end_ns
        ):
            raise ValueError("actual source interval cannot shorten the request")
        if not (
            self.evidence_start_ns <= self.requested_start_ns
            <= self.requested_end_ns <= self.evidence_end_ns
        ):
            raise ValueError("finalized frames must cover the requested context")
        if self.source_end_pts < self.source_start_pts:
            raise ValueError("source PTS interval is reversed")
        if self.evidence_end_ns < self.evidence_start_ns:
            raise ValueError("source evidence interval is reversed")
        if self.frame_count > MAX_FINALIZED_FRAMES:
            raise ValueError("frame_count exceeds the finalized-frame ceiling")
        if type(self.selected_fragment_ids) is not tuple or type(
            self.selected_fragment_fingerprints
        ) is not tuple:
            raise ValueError("selected fragment bindings must be immutable tuples")
        if not 1 <= len(self.selected_fragment_ids) <= MAX_CLOSED_FRAGMENTS:
            raise ValueError("selected fragment count is outside the fixed bound")
        if len(self.selected_fragment_ids) != len(
            self.selected_fragment_fingerprints
        ):
            raise ValueError("selected fragment identities are misaligned")
        for index, fragment_id in enumerate(self.selected_fragment_ids):
            _require_stable_id(fragment_id, f"selected_fragment_ids[{index}]")
            _require_sha256(
                self.selected_fragment_fingerprints[index],
                f"selected_fragment_fingerprints[{index}]",
            )
        if len(set(self.selected_fragment_ids)) != len(self.selected_fragment_ids):
            raise ValueError("selected fragment IDs cannot repeat")
        if type(self.provenance_scope) is not ProvenanceScope:
            raise ValueError("provenance_scope must be a ProvenanceScope")
        if self.provenance_scope is not ProvenanceScope.VIDEO_FRAMES_ONLY:
            raise ValueError("capture asset schema 1 is video-frame provenance only")
        if self.content_inspection_status is not ContentInspectionStatus.NOT_INSPECTED:
            raise ValueError("this boundary cannot claim media content inspection")
        if (
            self.audio_provenance_status
            is not AudioProvenanceStatus.ABSENT_FROM_CONTRACT_NOT_INSPECTED
        ):
            raise ValueError("this boundary cannot claim audio inspection or absence")
        if (
            self.capture_reference_status
            is not CaptureReferenceStatus.PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED
        ):
            raise ValueError(
                "camera and clock values are pinned service references only"
            )
        if self.asset_residency_status is not AssetResidencyStatus.NOT_VERIFIED:
            raise ValueError("this boundary cannot claim asset residency")
        if (
            self.admissibility_status
            is not _CAPTURE_METADATA_NOT_ADMISSIBLE
        ):
            raise ValueError("capture metadata is not admissible for any product use")
        _canonical_json_bytes(
            self.to_dict(), label="structurally verified capture metadata"
        )

    @property
    def admissible_for_live_scorecheck_presentation(self) -> bool:
        return False

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    def to_dict(self) -> dict[str, Any]:
        return {
            name: (
                list(item)
                if name
                in {
                    "camera_ids",
                    "participant_ids",
                    "selected_fragment_ids",
                    "selected_fragment_fingerprints",
                }
                else item.value
                if isinstance(item, Enum)
                else item
            )
            for name, item in (
                (field_name, getattr(self, field_name))
                for field_name in self.__dataclass_fields__
            )
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_dict(), label="structurally verified capture metadata"
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "StructurallyVerifiedCaptureMetadata":
        value = _parse_canonical_json(
            raw, label="structurally verified capture metadata"
        )
        try:
            _require_fields(
                value,
                set(cls.__dataclass_fields__),
                label="structurally verified capture metadata",
            )
            return cls(
                **{
                    **value,
                    "assembly": _enum_from_json(
                        FinalizedSourceAssembly, value["assembly"], "assembly"
                    ),
                    "camera_ids": tuple(
                        _exact_list(
                            value,
                            "camera_ids",
                            label="structurally verified capture metadata",
                        )
                    ),
                    "participant_ids": tuple(
                        _exact_list(
                            value,
                            "participant_ids",
                            label="structurally verified capture metadata",
                        )
                    ),
                    "selected_fragment_ids": tuple(
                        _exact_list(
                            value,
                            "selected_fragment_ids",
                            label="structurally verified capture metadata",
                        )
                    ),
                    "selected_fragment_fingerprints": tuple(
                        _exact_list(
                            value,
                            "selected_fragment_fingerprints",
                            label="structurally verified capture metadata",
                        )
                    ),
                    "provenance_scope": _enum_from_json(
                        ProvenanceScope,
                        value["provenance_scope"],
                        "provenance_scope",
                    ),
                    "content_inspection_status": _enum_from_json(
                        ContentInspectionStatus,
                        value["content_inspection_status"],
                        "content_inspection_status",
                    ),
                    "audio_provenance_status": _enum_from_json(
                        AudioProvenanceStatus,
                        value["audio_provenance_status"],
                        "audio_provenance_status",
                    ),
                    "capture_reference_status": _enum_from_json(
                        CaptureReferenceStatus,
                        value["capture_reference_status"],
                        "capture_reference_status",
                    ),
                    "asset_residency_status": _enum_from_json(
                        AssetResidencyStatus,
                        value["asset_residency_status"],
                        "asset_residency_status",
                    ),
                    "admissibility_status": _enum_from_json(
                        BoundaryAdmissibilityStatus,
                        value["admissibility_status"],
                        "admissibility_status",
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_STRUCTURALLY_VERIFIED_CAPTURE_METADATA", str(exc))
            raise AssertionError from exc


def finalized_capture_metadata_signing_message(
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    *,
    key_id: str,
    key_role: CaptureAssetKeyRole,
    trust_domain_id: str,
    signed_at_ns: int,
) -> bytes:
    """Return the domain-separated bytes a capture-metadata key may sign."""

    if type(capture_metadata) is not StructurallyVerifiedCaptureMetadata:
        raise ValueError(
            "capture_metadata must be a StructurallyVerifiedCaptureMetadata"
        )
    _require_stable_id(key_id, "key_id")
    if type(key_role) is not CaptureAssetKeyRole:
        raise ValueError("key_role must be a CaptureAssetKeyRole")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _require_exact_int(signed_at_ns, "signed_at_ns")
    return _canonical_json_bytes(
        {
            "domain": FINALIZED_CAPTURE_METADATA_SIGNING_DOMAIN,
            "key_id": key_id,
            "key_role": key_role.value,
            "signed_at_ns": signed_at_ns,
            "capture_metadata": capture_metadata.to_dict(),
            "trust_domain_id": trust_domain_id,
        },
        label="finalized capture metadata signing message",
    )


def verify_finalized_capture_metadata_attestation(
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    attestation: FinalizedCaptureMetadataAttestation,
    trust_snapshot: FinalizedCaptureMetadataTrustSnapshot,
    *,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_trust_snapshot_sha256: str,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    verified_at_ns: int,
) -> StructurallyVerifiedCaptureMetadata:
    """Authenticate one current metadata record against protected trust state."""

    if type(capture_metadata) is not StructurallyVerifiedCaptureMetadata:
        _fail("CAPTURE_METADATA_TYPE", "capture metadata has the wrong exact type")
    if type(attestation) is not FinalizedCaptureMetadataAttestation:
        _fail("CAPTURE_METADATA_ATTESTATION_TYPE", "attestation has the wrong type")
    if type(trust_snapshot) is not FinalizedCaptureMetadataTrustSnapshot:
        _fail("CAPTURE_METADATA_TRUST_TYPE", "trust snapshot has the wrong type")
    if type(capture_rights_trust_snapshot) is not CaptureRightsTrustSnapshot:
        _fail(
            "CAPTURE_METADATA_RIGHTS_TRUST_TYPE",
            "capture-rights trust snapshot has the wrong type",
        )
    _require_sha256(
        expected_capture_rights_trust_snapshot_sha256,
        "expected_capture_rights_trust_snapshot_sha256",
    )
    if (
        capture_rights_trust_snapshot.fingerprint()
        != expected_capture_rights_trust_snapshot_sha256
    ):
        _fail(
            "CAPTURE_METADATA_RIGHTS_TRUST_PIN",
            "capture-rights trust snapshot differs from the protected pin",
        )
    metadata_public_keys = {item.public_key_base64 for item in trust_snapshot.keys}
    rights_public_keys = {
        item.public_key_base64 for item in capture_rights_trust_snapshot.keys
    }
    if metadata_public_keys & rights_public_keys:
        _fail(
            "CAPTURE_METADATA_KEY_DOMAIN_OVERLAP",
            "capture metadata and capture-session rights must use disjoint keys",
        )
    _require_sha256(
        expected_trust_snapshot_sha256,
        "expected_trust_snapshot_sha256",
    )
    _require_sha256(
        expected_capture_policy_sha256,
        "expected_capture_policy_sha256",
    )
    _require_exact_int(
        expected_capture_policy_generation,
        "expected_capture_policy_generation",
    )
    verified_at = _require_exact_int(verified_at_ns, "verified_at_ns")
    if trust_snapshot.fingerprint() != expected_trust_snapshot_sha256:
        _fail(
            "CAPTURE_METADATA_TRUST_PIN",
            "metadata trust snapshot differs from the protected fingerprint",
        )
    if (
        trust_snapshot.capture_policy_sha256 != expected_capture_policy_sha256
        or trust_snapshot.capture_policy_generation
        != expected_capture_policy_generation
        or capture_metadata.capture_policy_sha256
        != expected_capture_policy_sha256
        or capture_metadata.capture_policy_generation
        != expected_capture_policy_generation
    ):
        _fail(
            "CAPTURE_METADATA_POLICY",
            "source and trust snapshot differ from protected capture policy",
        )
    metadata_sha256 = capture_metadata.fingerprint()
    if attestation.metadata_sha256 != metadata_sha256:
        _fail(
            "CAPTURE_METADATA_ATTESTATION_MISMATCH",
            "attestation does not name the exact canonical source",
        )
    if metadata_sha256 in trust_snapshot.revoked_metadata_sha256s:
        _fail("CAPTURE_METADATA_REVOKED", "capture metadata is revoked")
    current = next(
        (
            item
            for item in trust_snapshot.current_metadata
            if item.metadata_id == capture_metadata.metadata_id
        ),
        None,
    )
    if current is None:
        _fail(
            "CAPTURE_METADATA_UNTRUSTED",
            "trust snapshot has no current entry for metadata_id",
        )
    if (
        current.metadata_sha256 != metadata_sha256
        or current.asset_sha256 != capture_metadata.asset_sha256
    ):
        _fail(
            "CAPTURE_METADATA_STALE",
            "metadata record is not current for its metadata_id and asset",
        )
    if attestation.trust_domain_id != trust_snapshot.trust_domain_id:
        _fail(
            "CAPTURE_METADATA_TRUST_DOMAIN",
            "attestation trust domain differs from protected metadata trust",
        )
    if (
        attestation.key_role
        is not CaptureAssetKeyRole.FINALIZED_CAPTURE_METADATA_SIGNER
    ):
        _fail("CAPTURE_METADATA_KEY_ROLE", "attestation has the wrong key role")
    key = next(
        (item for item in trust_snapshot.keys if item.key_id == attestation.key_id),
        None,
    )
    if key is None:
        _fail("CAPTURE_METADATA_KEY_UNTRUSTED", "metadata signer key is untrusted")
    if key.key_role is not attestation.key_role:
        _fail("CAPTURE_METADATA_KEY_ROLE", "trusted key role differs")
    if not key.valid_from_ns <= attestation.signed_at_ns <= key.valid_until_ns:
        _fail(
            "CAPTURE_METADATA_KEY_DATE",
            "metadata signer key was not valid at signing",
        )
    if key.revoked_at_ns is not None and verified_at >= key.revoked_at_ns:
        _fail("CAPTURE_METADATA_KEY_REVOKED", "metadata signer key is revoked")
    if not (
        capture_metadata.verified_at_ns
        <= attestation.signed_at_ns
        <= verified_at
    ):
        _fail(
            "CAPTURE_METADATA_ATTESTATION_DATE",
            "metadata signature must follow structural verification and not be future-dated",
        )
    try:
        key.public_key.verify(
            attestation.signature,
            finalized_capture_metadata_signing_message(
                capture_metadata,
                key_id=attestation.key_id,
                key_role=attestation.key_role,
                trust_domain_id=attestation.trust_domain_id,
                signed_at_ns=attestation.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        _fail("CAPTURE_METADATA_SIGNATURE", "metadata signature is invalid")
        raise AssertionError from exc
    return capture_metadata


@dataclass(frozen=True, slots=True)
class ReviewClipFrameRef:
    output_presentation_index: int
    source_presentation_index: int
    source_pts: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    mapped_evidence_timestamp_ns: int

    def __post_init__(self) -> None:
        _require_exact_int(
            self.output_presentation_index, "output_presentation_index"
        )
        _require_exact_int(
            self.source_presentation_index, "source_presentation_index"
        )
        _require_exact_int(self.source_pts, "source_pts", minimum=-(1 << 63))
        _require_exact_int(
            self.source_time_base_numerator,
            "source_time_base_numerator",
            minimum=1,
        )
        _require_exact_int(
            self.source_time_base_denominator,
            "source_time_base_denominator",
            minimum=1,
        )
        if math.gcd(
            self.source_time_base_numerator, self.source_time_base_denominator
        ) != 1:
            raise ValueError("frame source time base must be a reduced rational")
        _require_exact_int(
            self.mapped_evidence_timestamp_ns,
            "mapped_evidence_timestamp_ns",
        )

    def to_dict(self) -> dict[str, int]:
        return {
            field_name: getattr(self, field_name)
            for field_name in self.__dataclass_fields__
        }


@dataclass(frozen=True, slots=True)
class ReviewClipProvenance:
    clip_id: str
    capture_metadata_fingerprint: str
    capture_metadata_asset_sha256: str
    capture_metadata_attestation_sha256: str
    capture_metadata_trust_snapshot_sha256: str
    capture_metadata_attested_at_ns: int
    capture_metadata_trust_verified_at_ns: int
    clip_sha256: str
    clip_byte_length: int
    selection_start_ns: int
    selection_end_ns: int
    frame_refs: tuple[ReviewClipFrameRef, ...]
    declared_decoder_contract_sha256: str
    declared_render_profile_sha256: str
    declared_renderer_runtime_sha256: str
    intended_uses: tuple[PermittedUse, ...]
    operational_rights_grant_sha256: str
    operational_rights_attestation_sha256: str
    operational_rights_trust_snapshot_sha256: str
    rights_reverified_at_ns: int
    provenance_scope: ProvenanceScope = ProvenanceScope.VIDEO_FRAMES_ONLY
    content_inspection_status: ContentInspectionStatus = (
        ContentInspectionStatus.NOT_INSPECTED
    )
    audio_provenance_status: AudioProvenanceStatus = (
        AudioProvenanceStatus.ABSENT_FROM_CONTRACT_NOT_INSPECTED
    )
    frame_derivation_status: FrameDerivationStatus = (
        FrameDerivationStatus.NOT_VERIFIED_AGAINST_CLIP_BYTES
    )
    capture_reference_status: CaptureReferenceStatus = (
        CaptureReferenceStatus.PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED
    )
    asset_residency_status: AssetResidencyStatus = AssetResidencyStatus.NOT_VERIFIED
    admissibility_status: BoundaryAdmissibilityStatus = (
        _REVIEW_PROVENANCE_NOT_ADMISSIBLE
    )
    schema_version: str = CAPTURE_ASSET_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_ASSET_SCHEMA_VERSION:
            raise ValueError("unsupported review-clip-provenance schema")
        _require_stable_id(self.clip_id, "clip_id")
        for field_name in (
            "capture_metadata_fingerprint",
            "capture_metadata_asset_sha256",
            "capture_metadata_attestation_sha256",
            "capture_metadata_trust_snapshot_sha256",
            "clip_sha256",
            "declared_decoder_contract_sha256",
            "declared_render_profile_sha256",
            "declared_renderer_runtime_sha256",
            "operational_rights_grant_sha256",
            "operational_rights_attestation_sha256",
            "operational_rights_trust_snapshot_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_exact_int(
            self.clip_byte_length,
            "clip_byte_length",
            minimum=1,
            maximum=MAX_REVIEW_CLIP_BYTES,
        )
        _require_exact_int(self.selection_start_ns, "selection_start_ns")
        _require_exact_int(self.selection_end_ns, "selection_end_ns")
        if self.selection_end_ns < self.selection_start_ns:
            raise ValueError("clip selection interval is reversed")
        _require_exact_int(self.rights_reverified_at_ns, "rights_reverified_at_ns")
        _require_exact_int(
            self.capture_metadata_attested_at_ns,
            "capture_metadata_attested_at_ns",
        )
        _require_exact_int(
            self.capture_metadata_trust_verified_at_ns,
            "capture_metadata_trust_verified_at_ns",
        )
        if not (
            self.capture_metadata_attested_at_ns
            <= self.capture_metadata_trust_verified_at_ns
            == self.rights_reverified_at_ns
        ):
            raise ValueError(
                "capture-metadata attestation and verification times are inconsistent"
            )
        if (
            type(self.frame_refs) is not tuple
            or not 1 <= len(self.frame_refs) <= MAX_FINALIZED_FRAMES
            or any(type(item) is not ReviewClipFrameRef for item in self.frame_refs)
        ):
            raise ValueError("frame_refs must be a bounded immutable frame tuple")
        previous: ReviewClipFrameRef | None = None
        for expected_index, frame in enumerate(self.frame_refs):
            if frame.output_presentation_index != expected_index:
                raise ValueError("output presentation indices must be contiguous")
            if previous is not None and (
                frame.source_presentation_index
                != previous.source_presentation_index + 1
                or frame.source_pts <= previous.source_pts
                or frame.mapped_evidence_timestamp_ns
                <= previous.mapped_evidence_timestamp_ns
                or (
                    frame.source_time_base_numerator,
                    frame.source_time_base_denominator,
                )
                != (
                    previous.source_time_base_numerator,
                    previous.source_time_base_denominator,
                )
            ):
                raise ValueError(
                    "frame map must preserve contiguous presentation, PTS, time-base, "
                    "and evidence identity"
                )
            previous = frame
        if not (
            self.frame_refs[0].mapped_evidence_timestamp_ns
            <= self.selection_start_ns
            <= self.selection_end_ns
            <= self.frame_refs[-1].mapped_evidence_timestamp_ns
        ):
            raise ValueError("frame map cannot shorten the requested clip context")
        _require_canonical_tuple(
            self.intended_uses,
            "intended_uses",
            minimum=len(CAPTURE_OPERATION_REQUIRED_USES),
            maximum=len(CAPTURE_OPERATION_REQUIRED_USES),
            validator=_require_permitted_use,
        )
        if self.intended_uses != CAPTURE_OPERATION_REQUIRED_USES:
            raise ValueError(
                "interim review provenance permits exactly the two operational uses"
            )
        if type(self.provenance_scope) is not ProvenanceScope or (
            self.provenance_scope is not ProvenanceScope.VIDEO_FRAMES_ONLY
        ):
            raise ValueError("review clip provenance is video-frame-only")
        if self.content_inspection_status is not ContentInspectionStatus.NOT_INSPECTED:
            raise ValueError("this boundary cannot claim media content inspection")
        if (
            self.audio_provenance_status
            is not AudioProvenanceStatus.ABSENT_FROM_CONTRACT_NOT_INSPECTED
        ):
            raise ValueError("this boundary cannot claim audio inspection or absence")
        if (
            self.frame_derivation_status
            is not FrameDerivationStatus.NOT_VERIFIED_AGAINST_CLIP_BYTES
        ):
            raise ValueError("this boundary cannot claim decoded-frame derivation")
        if (
            self.capture_reference_status
            is not CaptureReferenceStatus.PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED
        ):
            raise ValueError(
                "camera and clock values are pinned service references only"
            )
        if self.asset_residency_status is not AssetResidencyStatus.NOT_VERIFIED:
            raise ValueError("this boundary cannot claim clip residency")
        if (
            self.admissibility_status
            is not _REVIEW_PROVENANCE_NOT_ADMISSIBLE
        ):
            raise ValueError("review provenance is not admissible for any product use")
        _canonical_json_bytes(self.to_dict(), label="review clip provenance")

    @property
    def admissible_for_live_scorecheck_presentation(self) -> bool:
        return False

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    def to_dict(self) -> dict[str, Any]:
        return {
            name: (
                [frame.to_dict() for frame in self.frame_refs]
                if name == "frame_refs"
                else [value.value for value in item]
                if name == "intended_uses"
                else item.value
                if isinstance(item, Enum)
                else item
            )
            for name, item in (
                (field_name, getattr(self, field_name))
                for field_name in self.__dataclass_fields__
            )
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="review clip provenance")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "ReviewClipProvenance":
        value = _parse_canonical_json(raw, label="review clip provenance")
        try:
            _require_fields(
                value, set(cls.__dataclass_fields__), label="review clip provenance"
            )
            raw_frames = _exact_list(value, "frame_refs", label="review clip provenance")
            frames: list[ReviewClipFrameRef] = []
            for index, raw_frame in enumerate(raw_frames):
                frame_value = _require_fields(
                    raw_frame,
                    set(ReviewClipFrameRef.__dataclass_fields__),
                    label=f"frame_refs[{index}]",
                )
                frames.append(ReviewClipFrameRef(**frame_value))
            return cls(
                **{
                    **value,
                    "frame_refs": tuple(frames),
                    "intended_uses": tuple(
                        _enum_from_json(PermittedUse, item, "intended_uses item")
                        for item in _exact_list(
                            value, "intended_uses", label="review clip provenance"
                        )
                    ),
                    "provenance_scope": _enum_from_json(
                        ProvenanceScope,
                        value["provenance_scope"],
                        "provenance_scope",
                    ),
                    "content_inspection_status": _enum_from_json(
                        ContentInspectionStatus,
                        value["content_inspection_status"],
                        "content_inspection_status",
                    ),
                    "audio_provenance_status": _enum_from_json(
                        AudioProvenanceStatus,
                        value["audio_provenance_status"],
                        "audio_provenance_status",
                    ),
                    "frame_derivation_status": _enum_from_json(
                        FrameDerivationStatus,
                        value["frame_derivation_status"],
                        "frame_derivation_status",
                    ),
                    "capture_reference_status": _enum_from_json(
                        CaptureReferenceStatus,
                        value["capture_reference_status"],
                        "capture_reference_status",
                    ),
                    "asset_residency_status": _enum_from_json(
                        AssetResidencyStatus,
                        value["asset_residency_status"],
                        "asset_residency_status",
                    ),
                    "admissibility_status": _enum_from_json(
                        BoundaryAdmissibilityStatus,
                        value["admissibility_status"],
                        "admissibility_status",
                    ),
                }
            )
        except CaptureAssetError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_REVIEW_CLIP_PROVENANCE", str(exc))
            raise AssertionError from exc


def finalized_trace_fingerprint(
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
) -> str:
    """Return the stable length-delimited fingerprint of a finalized trace."""

    digest = hashlib.sha256()
    digest.update(b"capture-finalized-trace-v1\0")
    for frame in finalized_trace:
        encoded = frame.to_json_bytes()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def verify_capture_asset_policy_pin(
    policy: CaptureAssetTrustPolicy,
    *,
    expected_policy_sha256: str,
    expected_policy_generation: int,
    verified_at_ns: int,
) -> None:
    """Verify one policy against protected identity, generation, and time."""

    if type(policy) is not CaptureAssetTrustPolicy:
        _fail("CAPTURE_POLICY_TYPE", "capture policy has the wrong exact type")
    _require_sha256(expected_policy_sha256, "expected_policy_sha256")
    _require_exact_int(expected_policy_generation, "expected_policy_generation")
    _require_exact_int(verified_at_ns, "verified_at_ns")
    if policy.fingerprint() != expected_policy_sha256:
        _fail("CAPTURE_POLICY_PIN", "capture policy does not match the protected pin")
    if policy.policy_generation != expected_policy_generation:
        _fail(
            "CAPTURE_POLICY_GENERATION",
            "capture policy generation does not match protected configuration",
        )
    if not policy.valid_from_ns <= verified_at_ns <= policy.valid_until_ns:
        _fail("CAPTURE_POLICY_VALIDITY", "capture policy is not active")


def verify_capture_metadata_policy_binding(
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    policy: CaptureAssetTrustPolicy,
) -> None:
    """Require structural capture metadata to match one exact capture policy."""

    expected = {
        "deployment_id": capture_metadata.deployment_id,
        "match_id": capture_metadata.match_id,
        "capture_session_id": capture_metadata.capture_session_id,
        "venue_id": capture_metadata.venue_id,
        "camera_id": capture_metadata.camera_id,
        "stream_id": capture_metadata.stream_id,
        "session_fingerprint": capture_metadata.session_fingerprint,
        "session_configuration_fingerprint": (
            capture_metadata.session_configuration_fingerprint
        ),
        "clock_mapping_fingerprint": capture_metadata.clock_mapping_fingerprint,
    }
    for field_name, value in expected.items():
        if getattr(policy, field_name) != value:
            _fail(
                "CAPTURE_POLICY_SCOPE",
                f"capture policy {field_name} differs from capture metadata",
            )
    if (
        capture_metadata.session_fingerprint
        in policy.revoked_session_fingerprints
    ):
        _fail("CAPTURE_SESSION_REVOKED", "capture session has been revoked")


def build_structurally_verified_capture_metadata(
    *,
    metadata_id: str,
    scope: CaptureSourceScope,
    asset_claim: FinalizedAssetClaim,
    selected_fragment_payloads: tuple[bytes, ...],
    session: CaptureSessionDescriptor,
    clock_mapping: ClockMappingCandidate,
    records: tuple[CaptureTraceRecord, ...],
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
    window_request: EvidenceWindowRequest,
    fragment_projection: tuple[CaptureFragmentDescriptor, ...],
    committed_window_plan: EvidenceWindowPlan,
    capture_policy: CaptureAssetTrustPolicy,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    capture_rights_grant: CaptureSessionRightsGrant,
    capture_rights_attestation: CaptureSessionRightsGrantAttestation,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_rights_policy_sha256: str,
    expected_rights_policy_generation: int,
    verified_at_ns: int,
) -> StructurallyVerifiedCaptureMetadata:
    """Build metadata after exact byte, trace, plan, and rights checks.

    The returned record binds exact supplied bytes, the recomputed structural
    trace and window plan, protected policy references, and current operational
    rights at the supplied trusted time. Camera and clock hashes remain pinned
    service references, not verified device/clock attestations. This function
    does not prove residency, decodability, stream layout, video-only content,
    decoded pixels, physical-camera truth, or scene semantics.
    """

    _require_stable_id(metadata_id, "metadata_id")
    if type(scope) is not CaptureSourceScope:
        _fail("CAPTURE_SCOPE_TYPE", "scope has the wrong exact type")
    if type(asset_claim) is not FinalizedAssetClaim:
        _fail("CAPTURE_ASSET_CLAIM_TYPE", "asset claim has the wrong exact type")
    if type(session) is not CaptureSessionDescriptor:
        _fail("CAPTURE_SESSION_TYPE", "session has the wrong exact type")
    if type(clock_mapping) is not ClockMappingCandidate:
        _fail("CAPTURE_CLOCK_TYPE", "clock mapping has the wrong exact type")
    if type(window_request) is not EvidenceWindowRequest:
        _fail("CAPTURE_WINDOW_REQUEST_TYPE", "window request has the wrong exact type")
    if type(committed_window_plan) is not EvidenceWindowPlan:
        _fail("CAPTURE_WINDOW_PLAN_TYPE", "window plan has the wrong exact type")
    if type(capture_rights_grant) is not CaptureSessionRightsGrant:
        _fail("CAPTURE_RIGHTS_GRANT_TYPE", "capture grant has the wrong exact type")
    if type(capture_rights_attestation) is not CaptureSessionRightsGrantAttestation:
        _fail(
            "CAPTURE_RIGHTS_ATTESTATION_TYPE",
            "capture-rights attestation has the wrong exact type",
        )
    if type(capture_rights_trust_snapshot) is not CaptureRightsTrustSnapshot:
        _fail(
            "CAPTURE_RIGHTS_TRUST_TYPE",
            "capture-rights trust snapshot has the wrong exact type",
        )
    verified_at = _require_exact_int(verified_at_ns, "verified_at_ns")
    verify_capture_asset_policy_pin(
        capture_policy,
        expected_policy_sha256=expected_capture_policy_sha256,
        expected_policy_generation=expected_capture_policy_generation,
        verified_at_ns=verified_at,
    )

    if (
        session.source_kind is not CaptureSourceKind.LIVE_CAMERA
        or session.trust_domain is not CaptureTrustDomain.PRODUCTION_CAPTURE
    ):
        _fail(
            "CAPTURE_SOURCE_DOMAIN",
            "capture metadata requires a live production capture input",
        )
    session_fingerprint = session.fingerprint()
    session_configuration = session.configuration_fingerprint
    policy_bindings = {
        "deployment_id": session.deployment_id,
        "match_id": scope.match_id,
        "capture_session_id": scope.capture_session_id,
        "venue_id": scope.venue_id,
        "camera_id": scope.camera_id,
        "stream_id": scope.stream_id,
        "session_fingerprint": session_fingerprint,
        "session_configuration_fingerprint": session_configuration,
        "camera_attestation_sha256": session.camera_attestation_sha256,
        "clock_attestation_sha256": session.clock_attestation_sha256,
        "clock_mapping_fingerprint": clock_mapping.fingerprint(),
        "capture_profile_sha256": session.capture_profile_sha256,
        "backend_artifact_sha256": session.backend_artifact_sha256,
        "encoder_configuration_sha256": session.encoder_configuration_sha256,
        "exposure_configuration_sha256": session.exposure_configuration_sha256,
    }
    for field_name, observed in policy_bindings.items():
        if getattr(capture_policy, field_name) != observed:
            _fail(
                "CAPTURE_POLICY_SCOPE",
                f"capture policy {field_name} differs from the operation",
            )
    if (
        session.match_id != scope.match_id
        or session.session_id != scope.capture_session_id
        or session.stream_id != scope.stream_id
    ):
        _fail("CAPTURE_SESSION_SCOPE", "session differs from the exact source scope")
    if session_fingerprint in capture_policy.revoked_session_fingerprints:
        _fail("CAPTURE_SESSION_REVOKED", "capture session has been revoked")
    assert session.camera_attestation_sha256 is not None
    assert session.clock_attestation_sha256 is not None
    if (
        session.camera_attestation_sha256
        in capture_policy.revoked_camera_attestation_sha256s
    ):
        _fail("CAPTURE_CAMERA_REVOKED", "camera attestation has been revoked")
    if (
        session.clock_attestation_sha256
        in capture_policy.revoked_clock_attestation_sha256s
    ):
        _fail("CAPTURE_CLOCK_REVOKED", "clock attestation has been revoked")
    if (
        clock_mapping.claimed_max_absolute_error_ns
        > capture_policy.max_clock_absolute_error_ns
    ):
        _fail(
            "CAPTURE_CLOCK_ERROR_BOUND",
            "clock mapping exceeds the protected maximum error bound",
        )

    grant_sha256 = capture_rights_grant.fingerprint()
    if session.rights_grant_sha256 != grant_sha256:
        _fail(
            "CAPTURE_RIGHTS_SESSION_BINDING",
            "session does not bind the exact verified capture grant",
        )
    rights = verify_capture_session_rights(
        capture_rights_grant,
        capture_rights_attestation,
        capture_rights_trust_snapshot,
        verified_at_ns=verified_at,
        geography=scope.geography,
        match_id=scope.match_id,
        capture_session_id=scope.capture_session_id,
        venue_id=scope.venue_id,
        camera_ids=scope.camera_ids,
        roster_scope_sha256=scope.roster_scope_sha256,
        participant_ids=scope.participant_ids,
        required_uses=CAPTURE_OPERATION_REQUIRED_USES,
        expected_trust_snapshot_sha256=(
            expected_capture_rights_trust_snapshot_sha256
        ),
        expected_protected_policy_fingerprint=expected_rights_policy_sha256,
        expected_protected_policy_generation=expected_rights_policy_generation,
    )

    recomputed_plan = plan_evidence_window(window_request, fragment_projection)
    if recomputed_plan != committed_window_plan:
        _fail(
            "CAPTURE_WINDOW_PLAN_MISMATCH",
            "committed window plan differs from pure recomputation",
        )
    if recomputed_plan.status is not EvidenceWindowStatus.PLANNED:
        _fail("CAPTURE_WINDOW_UNAVAILABLE", "evidence window is not fully planned")
    if (
        window_request.session_fingerprint != session_fingerprint
        or window_request.expected_session_configuration_fingerprint
        != session_configuration
        or window_request.reconnect_epoch != session.reconnect_epoch
    ):
        _fail(
            "CAPTURE_WINDOW_SCOPE",
            "window request differs from session/configuration/epoch",
        )

    projection_by_id = {item.fragment_id: item for item in fragment_projection}
    try:
        selected = tuple(
            projection_by_id[fragment_id]
            for fragment_id in recomputed_plan.selected_fragment_ids
        )
    except KeyError as exc:
        _fail("CAPTURE_FRAGMENT_MISSING", "planned fragment is absent")
        raise AssertionError from exc
    if tuple(item.fingerprint() for item in selected) != (
        recomputed_plan.selected_fragment_fingerprints
    ):
        _fail("CAPTURE_FRAGMENT_SUBSTITUTION", "planned fragment fingerprint changed")
    if type(selected_fragment_payloads) is not tuple or len(
        selected_fragment_payloads
    ) != len(selected):
        _fail(
            "CAPTURE_FRAGMENT_BYTES",
            "fragment payloads must align exactly with the selected plan",
        )
    asset_digest = hashlib.sha256()
    asset_byte_length = 0
    for index, (fragment, payload) in enumerate(
        zip(selected, selected_fragment_payloads, strict=True)
    ):
        if type(payload) is not bytes:
            _fail("CAPTURE_FRAGMENT_BYTES", f"fragment payload {index} is not bytes")
        if len(payload) != fragment.byte_length:
            _fail("CAPTURE_FRAGMENT_SIZE", f"fragment payload {index} size differs")
        if hashlib.sha256(payload).hexdigest() != fragment.content_sha256:
            _fail("CAPTURE_FRAGMENT_HASH", f"fragment payload {index} hash differs")
        if (
            fragment.capture_profile_sha256 != session.capture_profile_sha256
            or fragment.camera_fingerprint != session.camera_attestation_sha256
            or fragment.clock_fingerprint != clock_mapping.fingerprint()
            or fragment.encoder_configuration_sha256
            != session.encoder_configuration_sha256
            or fragment.exposure_configuration_sha256
            != session.exposure_configuration_sha256
        ):
            _fail(
                "CAPTURE_FRAGMENT_CONFIGURATION",
                f"fragment {index} differs from the pinned capture configuration",
            )
        asset_digest.update(payload)
        asset_byte_length += len(payload)
    if asset_byte_length != recomputed_plan.total_byte_length:
        _fail("CAPTURE_ASSET_SIZE", "assembled bytes differ from the planned total")
    if (
        asset_claim.byte_length != asset_byte_length
        or asset_claim.asset_sha256 != asset_digest.hexdigest()
    ):
        _fail("CAPTURE_ASSET_IDENTITY", "finalized asset claim differs from exact bytes")
    if asset_claim.assembly is not FinalizedSourceAssembly.ORDERED_SELECTED_FRAGMENT_CONCAT_V1:
        _fail("CAPTURE_ASSET_ASSEMBLY", "unsupported finalized source assembly")

    report = evaluate_capture_trace(session, clock_mapping, records, finalized_trace)
    if (
        report.disposition is not IntegrityDisposition.OBSERVED_CLEAN
        or not report.finalized_trace_structurally_valid
        or not report.structurally_eligible_for_trust_verification
    ):
        _fail(
            "CAPTURE_INTEGRITY",
            "recomputed structural capture report is not clean and eligible",
        )
    if len(finalized_trace) != recomputed_plan.total_frame_count:
        _fail("CAPTURE_FRAME_COUNT", "finalized trace differs from planned frame total")
    if not finalized_trace:
        _fail("CAPTURE_FRAME_COUNT", "finalized trace cannot be empty")
    assert recomputed_plan.actual_start_ns is not None
    assert recomputed_plan.actual_end_ns is not None
    first_frame = finalized_trace[0]
    last_frame = finalized_trace[-1]
    first_fragment = selected[0]
    last_fragment = selected[-1]
    fragment_time_base = (
        first_fragment.device_time_base_numerator,
        first_fragment.device_time_base_denominator,
    )
    if any(
        (
            fragment.device_time_base_numerator,
            fragment.device_time_base_denominator,
        )
        != fragment_time_base
        for fragment in selected
    ):
        _fail("CAPTURE_FRAGMENT_TIME_BASE", "selected fragment time bases differ")
    if (
        first_frame.source_pts != first_fragment.device_start_timestamp
        or last_frame.source_pts > last_fragment.device_end_timestamp
        or (
            first_frame.source_time_base_numerator,
            first_frame.source_time_base_denominator,
        )
        != fragment_time_base
    ):
        _fail(
            "CAPTURE_FRAME_INTERVAL",
            "finalized PTS identity differs from the selected fragment interval",
        )
    if (
        first_frame.mapped_evidence_timestamp_ns
        != recomputed_plan.actual_start_ns
        or last_frame.mapped_evidence_timestamp_ns > recomputed_plan.actual_end_ns
        or first_frame.mapped_evidence_timestamp_ns
        > recomputed_plan.requested_start_ns
        or last_frame.mapped_evidence_timestamp_ns
        < recomputed_plan.requested_end_ns
    ):
        _fail(
            "CAPTURE_CONTEXT_SHORTENED",
            "finalized frame timeline does not cover the complete requested context",
        )

    return StructurallyVerifiedCaptureMetadata(
        metadata_id=metadata_id,
        asset_id=asset_claim.asset_id,
        asset_claim_sha256=asset_claim.fingerprint(),
        asset_sha256=asset_claim.asset_sha256,
        asset_byte_length=asset_claim.byte_length,
        assembly=asset_claim.assembly,
        scope_fingerprint=scope.fingerprint(),
        deployment_id=session.deployment_id,
        match_id=scope.match_id,
        capture_session_id=scope.capture_session_id,
        venue_id=scope.venue_id,
        camera_id=scope.camera_id,
        camera_ids=scope.camera_ids,
        stream_id=scope.stream_id,
        roster_scope_sha256=scope.roster_scope_sha256,
        participant_ids=scope.participant_ids,
        geography=scope.geography,
        reconnect_epoch=session.reconnect_epoch,
        session_fingerprint=session_fingerprint,
        session_configuration_fingerprint=session_configuration,
        window_request_fingerprint=window_request.fingerprint(),
        window_plan_fingerprint=recomputed_plan.fingerprint(),
        requested_start_ns=recomputed_plan.requested_start_ns,
        requested_end_ns=recomputed_plan.requested_end_ns,
        actual_start_ns=recomputed_plan.actual_start_ns,
        actual_end_ns=recomputed_plan.actual_end_ns,
        selected_fragment_ids=recomputed_plan.selected_fragment_ids,
        selected_fragment_fingerprints=(
            recomputed_plan.selected_fragment_fingerprints
        ),
        finalized_trace_sha256=finalized_trace_fingerprint(finalized_trace),
        integrity_report_sha256=report.fingerprint(),
        integrity_window_sha256=report.window_fingerprint,
        clock_mapping_fingerprint=clock_mapping.fingerprint(),
        frame_count=report.finalized_frame_count,
        source_start_pts=report.source_start_pts,
        source_end_pts=report.source_end_pts,
        source_time_base_numerator=report.source_time_base_numerator,
        source_time_base_denominator=report.source_time_base_denominator,
        evidence_start_ns=report.evidence_start_ns,
        evidence_end_ns=report.evidence_end_ns,
        capture_policy_sha256=capture_policy.fingerprint(),
        capture_policy_generation=capture_policy.policy_generation,
        capture_rights_grant_sha256=rights.grant_sha256,
        capture_rights_attestation_sha256=rights.attestation_sha256,
        capture_rights_trust_snapshot_sha256=rights.trust_snapshot_sha256,
        rights_policy_sha256=rights.protected_policy_fingerprint,
        rights_policy_generation=rights.protected_policy_generation,
        verified_at_ns=verified_at,
    )


def build_video_only_review_clip_provenance(
    *,
    clip_id: str,
    clip_bytes: bytes,
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
    declared_decoder_contract_sha256: str,
    declared_render_profile_sha256: str,
    declared_renderer_runtime_sha256: str,
    intended_uses: tuple[PermittedUse, ...],
    capture_metadata_attestation: FinalizedCaptureMetadataAttestation,
    capture_metadata_trust_snapshot: FinalizedCaptureMetadataTrustSnapshot,
    expected_capture_metadata_trust_snapshot_sha256: str,
    capture_policy: CaptureAssetTrustPolicy,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    capture_rights_grant: CaptureSessionRightsGrant,
    capture_rights_attestation: CaptureSessionRightsGrantAttestation,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_rights_policy_sha256: str,
    expected_rights_policy_generation: int,
    rights_reverified_at_ns: int,
) -> ReviewClipProvenance:
    """Build bounded video-frame-only provenance for exact clip bytes.

    This is not a decoder or render verifier.  The record explicitly retains
    ``NOT_INSPECTED``/``NOT_VERIFIED_AGAINST_CLIP_BYTES`` and may not be used to
    claim that the container lacks audio or that its decoded frames match the
    source map. It is explicitly inadmissible for ScoreCheck presentation,
    training, evaluation, and deployment.
    """

    _require_stable_id(clip_id, "clip_id")
    if type(clip_bytes) is not bytes or not 1 <= len(clip_bytes) <= MAX_REVIEW_CLIP_BYTES:
        _fail("REVIEW_CLIP_BYTES", "clip bytes have an invalid exact length")
    if type(capture_metadata) is not StructurallyVerifiedCaptureMetadata:
        _fail(
            "REVIEW_CAPTURE_METADATA_TYPE",
            "capture metadata has the wrong exact type",
        )
    reverified_at = _require_exact_int(
        rights_reverified_at_ns, "rights_reverified_at_ns"
    )
    verify_capture_asset_policy_pin(
        capture_policy,
        expected_policy_sha256=expected_capture_policy_sha256,
        expected_policy_generation=expected_capture_policy_generation,
        verified_at_ns=reverified_at,
    )
    verify_capture_metadata_policy_binding(capture_metadata, capture_policy)
    if capture_metadata.capture_policy_sha256 != capture_policy.fingerprint():
        _fail(
            "CAPTURE_POLICY_ROTATED",
            "capture-metadata policy differs at clip construction",
        )
    if reverified_at < capture_metadata.verified_at_ns:
        _fail(
            "TRUSTED_TIME_REGRESSION",
            "clip rights verification time cannot precede source verification",
        )
    verify_finalized_capture_metadata_attestation(
        capture_metadata,
        capture_metadata_attestation,
        capture_metadata_trust_snapshot,
        capture_rights_trust_snapshot=capture_rights_trust_snapshot,
        expected_capture_rights_trust_snapshot_sha256=(
            expected_capture_rights_trust_snapshot_sha256
        ),
        expected_trust_snapshot_sha256=expected_capture_metadata_trust_snapshot_sha256,
        expected_capture_policy_sha256=expected_capture_policy_sha256,
        expected_capture_policy_generation=expected_capture_policy_generation,
        verified_at_ns=reverified_at,
    )

    rights = verify_capture_session_rights(
        capture_rights_grant,
        capture_rights_attestation,
        capture_rights_trust_snapshot,
        verified_at_ns=reverified_at,
        geography=capture_metadata.geography,
        match_id=capture_metadata.match_id,
        capture_session_id=capture_metadata.capture_session_id,
        venue_id=capture_metadata.venue_id,
        camera_ids=capture_metadata.camera_ids,
        roster_scope_sha256=capture_metadata.roster_scope_sha256,
        participant_ids=capture_metadata.participant_ids,
        required_uses=CAPTURE_OPERATION_REQUIRED_USES,
        expected_trust_snapshot_sha256=(
            expected_capture_rights_trust_snapshot_sha256
        ),
        expected_protected_policy_fingerprint=expected_rights_policy_sha256,
        expected_protected_policy_generation=expected_rights_policy_generation,
    )
    if (
        rights.grant_sha256 != capture_metadata.capture_rights_grant_sha256
        or rights.attestation_sha256
        != capture_metadata.capture_rights_attestation_sha256
    ):
        _fail(
            "CAPTURE_RIGHTS_ROTATED",
            "clip construction must reverify the capture-metadata-bound grant",
        )

    if type(finalized_trace) is not tuple or any(
        type(frame) is not FinalizedSourceFrameSignal for frame in finalized_trace
    ):
        _fail("REVIEW_FRAME_TRACE", "finalized trace must be an immutable frame tuple")
    if (
        len(finalized_trace) != capture_metadata.frame_count
        or finalized_trace_fingerprint(finalized_trace)
        != capture_metadata.finalized_trace_sha256
    ):
        _fail(
            "REVIEW_FRAME_TRACE",
            "finalized frame trace differs from authenticated capture metadata",
        )
    first_index = max(
        (
            index
            for index, frame in enumerate(finalized_trace)
            if frame.mapped_evidence_timestamp_ns
            <= capture_metadata.requested_start_ns
        ),
        default=-1,
    )
    last_index = next(
        (
            index
            for index, frame in enumerate(finalized_trace)
            if frame.mapped_evidence_timestamp_ns
            >= capture_metadata.requested_end_ns
        ),
        -1,
    )
    if first_index < 0 or last_index < first_index:
        _fail("REVIEW_CONTEXT_SHORTENED", "source frames do not cover review context")
    selected_frames = finalized_trace[first_index : last_index + 1]
    frame_refs = tuple(
        ReviewClipFrameRef(
            output_presentation_index=output_index,
            source_presentation_index=frame.presentation_index,
            source_pts=frame.source_pts,
            source_time_base_numerator=frame.source_time_base_numerator,
            source_time_base_denominator=frame.source_time_base_denominator,
            mapped_evidence_timestamp_ns=frame.mapped_evidence_timestamp_ns,
        )
        for output_index, frame in enumerate(selected_frames)
    )

    for field_name, value in (
        (
            "declared_decoder_contract_sha256",
            declared_decoder_contract_sha256,
        ),
        ("declared_render_profile_sha256", declared_render_profile_sha256),
        ("declared_renderer_runtime_sha256", declared_renderer_runtime_sha256),
    ):
        _require_sha256(value, field_name)
    if (
        type(intended_uses) is not tuple
        or any(type(use) is not PermittedUse for use in intended_uses)
        or intended_uses != CAPTURE_OPERATION_REQUIRED_USES
    ):
        _fail(
            "REVIEW_NON_OPERATIONAL_USE_FORBIDDEN",
            "interim provenance permits exactly assistive processing and scorer review",
        )
    clip_sha256 = hashlib.sha256(clip_bytes).hexdigest()

    return ReviewClipProvenance(
        clip_id=clip_id,
        capture_metadata_fingerprint=capture_metadata.fingerprint(),
        capture_metadata_asset_sha256=capture_metadata.asset_sha256,
        capture_metadata_attestation_sha256=capture_metadata_attestation.fingerprint(),
        capture_metadata_trust_snapshot_sha256=capture_metadata_trust_snapshot.fingerprint(),
        capture_metadata_attested_at_ns=capture_metadata_attestation.signed_at_ns,
        capture_metadata_trust_verified_at_ns=reverified_at,
        clip_sha256=clip_sha256,
        clip_byte_length=len(clip_bytes),
        selection_start_ns=capture_metadata.requested_start_ns,
        selection_end_ns=capture_metadata.requested_end_ns,
        frame_refs=frame_refs,
        declared_decoder_contract_sha256=declared_decoder_contract_sha256,
        declared_render_profile_sha256=declared_render_profile_sha256,
        declared_renderer_runtime_sha256=declared_renderer_runtime_sha256,
        intended_uses=intended_uses,
        operational_rights_grant_sha256=rights.grant_sha256,
        operational_rights_attestation_sha256=rights.attestation_sha256,
        operational_rights_trust_snapshot_sha256=rights.trust_snapshot_sha256,
        rights_reverified_at_ns=reverified_at,
    )


__all__ = [
    "CAPTURE_ASSET_SCHEMA_VERSION",
    "FINALIZED_CAPTURE_METADATA_SIGNING_DOMAIN",
    "MAX_CAPTURE_ASSET_JSON_BYTES",
    "MAX_REVIEW_CLIP_BYTES",
    "AssetResidencyStatus",
    "AudioProvenanceStatus",
    "BoundaryAdmissibilityStatus",
    "CaptureAssetError",
    "CaptureAssetKeyRole",
    "CaptureAssetTrustPolicy",
    "CaptureReferenceStatus",
    "CaptureSourceScope",
    "ContentInspectionStatus",
    "CurrentFinalizedCaptureMetadata",
    "FinalizedAssetClaim",
    "FinalizedCaptureMetadataAttestation",
    "FinalizedCaptureMetadataTrustSnapshot",
    "FinalizedSourceAssembly",
    "FrameDerivationStatus",
    "ProvenanceScope",
    "ReviewClipFrameRef",
    "ReviewClipProvenance",
    "StructurallyVerifiedCaptureMetadata",
    "TrustedCaptureMetadataSignerKey",
    "build_video_only_review_clip_provenance",
    "finalized_capture_metadata_signing_message",
    "finalized_trace_fingerprint",
    "build_structurally_verified_capture_metadata",
    "verify_finalized_capture_metadata_attestation",
    "verify_capture_asset_policy_pin",
    "verify_capture_metadata_policy_binding",
]
