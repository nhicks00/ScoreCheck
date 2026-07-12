"""Strict, metadata-only contracts for the capture integrity gateway.

The capture boundary is intentionally isolated from scoring.  This module
contains no authorization, domain-event, event-store, or ScoreCheck imports.
It describes observations; it never authorizes an outcome.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, TypeAlias


CAPTURE_SCHEMA_VERSION = "1.0"
MAX_SIGNED_64 = (1 << 63) - 1
MIN_SIGNED_64 = -(1 << 63)
MAX_CAPTURE_JSON_BYTES = 256 * 1024
MAX_CAPTURE_JSON_DEPTH = 24
MAX_CAPTURE_JSON_NODES = 8_192
MAX_CAPTURE_JSON_CONTAINERS = 2_048
MAX_CAPTURE_FINDINGS = 64
MAX_CAPTURE_RECORDS = 4_096

MAX_RETENTION_NS = 30 * 1_000_000_000
MAX_RING_BYTES = 1 * 1024 * 1024 * 1024
MAX_CLOSED_FRAGMENTS = 64
MAX_FRAGMENT_DURATION_NS = 2 * 1_000_000_000
MAX_FRAGMENT_BYTES = 64 * 1024 * 1024
MAX_PENDING_WINDOWS = 4
MAX_WINDOW_ROLL_NS = 30 * 1_000_000_000
MAX_FINALIZED_SOURCE_BYTES = MAX_RING_BYTES
MAX_FINALIZED_FRAMES = 3_600
FREEZE_CANDIDATE_MIN_NS = 250_000_000

DIAGNOSTIC_FINGERPRINT_CONTRACT = "LUMA_64X36_U8_V1"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")


class CaptureContractError(ValueError):
    """Strict parsing or construction failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaptureContractError(code, message)


def _require_exact_int(
    value: object,
    field_name: str,
    *,
    minimum: int = MIN_SIGNED_64,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{field_name} must be an integer in [{minimum}, {maximum}]"
        )
    return value


def _require_nonnegative(value: object, field_name: str) -> int:
    return _require_exact_int(value, field_name, minimum=0)


def _require_positive(
    value: object, field_name: str, *, maximum: int = MAX_SIGNED_64
) -> int:
    return _require_exact_int(value, field_name, minimum=1, maximum=maximum)


def _require_optional_nonnegative(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return _require_nonnegative(value, field_name)


def _require_reduced_rational(
    numerator: object,
    denominator: object,
    *,
    field_prefix: str,
    maximum: int = 1_000_000_000,
) -> tuple[int, int]:
    numerator_value = _require_positive(
        numerator, f"{field_prefix}_numerator", maximum=maximum
    )
    denominator_value = _require_positive(
        denominator, f"{field_prefix}_denominator", maximum=maximum
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError(f"{field_prefix} must be a reduced positive rational")
    return numerator_value, denominator_value


def _require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _require_optional_sha256(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _require_sha256(value, field_name)


def _require_bool(value: object, field_name: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _require_enum(value: object, enum_type: type[Enum], field_name: str) -> Enum:
    if type(value) is not enum_type:
        raise ValueError(f"{field_name} must be a {enum_type.__name__}")
    return value


def _enum_from_json(enum_type: type[Enum], value: object, field_name: str) -> Enum:
    if type(value) is not str:
        _fail("INVALID_ENUM", f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        _fail("INVALID_ENUM", f"{field_name} is unsupported")
        raise AssertionError from exc


def _canonical_json_bytes(
    value: Mapping[str, Any], *, label: str, maximum: int = MAX_CAPTURE_JSON_BYTES
) -> bytes:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if len(encoded) > maximum:
        raise ValueError(f"{label} exceeds {maximum} bytes")
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
        _fail("JSON_INTEGER_RANGE", "capture JSON integer exceeds signed 64-bit")
    try:
        value = int(token, 10)
    except ValueError as exc:
        _fail("INVALID_JSON_NUMBER", "capture JSON integer is invalid")
        raise AssertionError from exc
    if not MIN_SIGNED_64 <= value <= MAX_SIGNED_64:
        _fail("JSON_INTEGER_RANGE", "capture JSON integer exceeds signed 64-bit")
    return value


def _reject_json_float(token: str) -> None:
    _fail("INVALID_JSON_NUMBER", f"capture JSON forbids floating number: {token}")


def _measure_json(value: object, *, depth: int = 1) -> tuple[int, int]:
    if depth > MAX_CAPTURE_JSON_DEPTH:
        _fail("JSON_DEPTH_EXCEEDED", "capture JSON is too deeply nested")
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
    elif value is not None and type(value) not in (str, int, bool, float):
        _fail("INVALID_JSON_VALUE", "unsupported JSON value")
    if type(value) is float and not math.isfinite(value):
        _fail("NONFINITE_JSON_NUMBER", "nonfinite JSON number")
    if nodes > MAX_CAPTURE_JSON_NODES:
        _fail("JSON_NODE_LIMIT_EXCEEDED", "capture JSON has too many nodes")
    if containers > MAX_CAPTURE_JSON_CONTAINERS:
        _fail("JSON_CONTAINER_LIMIT_EXCEEDED", "capture JSON has too many containers")
    return nodes, containers


def _parse_canonical_json(raw: bytes, *, label: str) -> dict[str, Any]:
    if type(raw) is not bytes:
        _fail("INVALID_JSON_TYPE", f"{label} must be bytes")
    if not raw or len(raw) > MAX_CAPTURE_JSON_BYTES:
        _fail("JSON_SIZE_EXCEEDED", f"{label} has an invalid byte length")
    try:
        value = json.loads(
            raw.decode("ascii"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite,
            parse_int=_parse_bounded_json_integer,
            parse_float=_reject_json_float,
        )
    except CaptureContractError:
        raise
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", "capture JSON is too deeply nested")
        raise AssertionError from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("INVALID_JSON", f"{label} is not valid ASCII JSON")
        raise AssertionError from exc
    try:
        _measure_json(value)
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", "capture JSON is too deeply nested")
        raise AssertionError from exc
    if type(value) is not dict:
        _fail("INVALID_JSON_ROOT", f"{label} must be a JSON object")
    try:
        canonical = _canonical_json_bytes(value, label=label)
    except ValueError as exc:
        _fail("INVALID_JSON", str(exc))
    if canonical != raw:
        _fail("NONCANONICAL_JSON", f"{label} must use canonical JSON encoding")
    return value


def _require_fields(
    value: Mapping[str, Any], *, required: set[str], label: str
) -> None:
    actual = set(value)
    if actual != required:
        missing = sorted(required - actual)
        extra = sorted(actual - required)
        _fail(
            "INVALID_FIELD_SET",
            f"{label} field set mismatch; missing={missing}, extra={extra}",
        )


def _fingerprint(value: Mapping[str, Any], *, label: str) -> str:
    return hashlib.sha256(_canonical_json_bytes(value, label=label)).hexdigest()


class CaptureSourceKind(str, Enum):
    SYNTHETIC_TEST = "SYNTHETIC_TEST"
    LIVE_CAMERA = "LIVE_CAMERA"


class CaptureTrustDomain(str, Enum):
    SYNTHETIC_TEST = "SYNTHETIC_TEST"
    PRODUCTION_CAPTURE = "PRODUCTION_CAPTURE"


class ExposurePolicy(str, Enum):
    MANUAL_LOCKED = "MANUAL_LOCKED"
    AUTO_LOCKED = "AUTO_LOCKED"


class CaptureDropReason(str, Enum):
    LATE_DATA = "LATE_DATA"
    OUT_OF_BUFFERS = "OUT_OF_BUFFERS"
    DEVICE_DISCONTINUITY = "DEVICE_DISCONTINUITY"
    ENCODER_REJECTION = "ENCODER_REJECTION"
    DEVICE_FAILURE = "DEVICE_FAILURE"
    UNKNOWN = "UNKNOWN"


class CaptureBoundaryKind(str, Enum):
    START = "START"
    INTERRUPT = "INTERRUPT"
    RESUME = "RESUME"
    CONFIG_CHANGE = "CONFIG_CHANGE"
    STOP = "STOP"


class IntegrityFindingKind(str, Enum):
    EXPLICIT_BACKEND_DROP = "EXPLICIT_BACKEND_DROP"
    INFERRED_DEVICE_TIMESTAMP_GAP = "INFERRED_DEVICE_TIMESTAMP_GAP"
    DEVICE_SEQUENCE_GAP = "DEVICE_SEQUENCE_GAP"
    TIMESTAMP_DUPLICATE_OR_REGRESSION = "TIMESTAMP_DUPLICATE_OR_REGRESSION"
    HOST_CLOCK_REGRESSION = "HOST_CLOCK_REGRESSION"
    DIAGNOSTIC_FREEZE_CANDIDATE = "DIAGNOSTIC_FREEZE_CANDIDATE"
    DIMENSION_CHANGE = "DIMENSION_CHANGE"
    EXPOSURE_POLICY_VIOLATION = "EXPOSURE_POLICY_VIOLATION"
    RECONNECT_BOUNDARY = "RECONNECT_BOUNDARY"
    CONFIGURATION_CHANGE = "CONFIGURATION_CHANGE"
    CLOCK_MAPPING_FAILURE = "CLOCK_MAPPING_FAILURE"
    STREAM_SEQUENCE_FAILURE = "STREAM_SEQUENCE_FAILURE"
    ENCODER_FRAME_LOSS = "ENCODER_FRAME_LOSS"
    FINALIZED_OUTPUT_VALIDATION_FAILURE = "FINALIZED_OUTPUT_VALIDATION_FAILURE"


class IntegrityDisposition(str, Enum):
    OBSERVED_CLEAN = "OBSERVED_CLEAN"
    OBSERVED_DEGRADED = "OBSERVED_DEGRADED"
    INVALID = "INVALID"


class WindowRequestOrigin(str, Enum):
    SYNTHETIC_TEST = "SYNTHETIC_TEST"
    HUMAN_REVIEW_TRIGGER = "HUMAN_REVIEW_TRIGGER"
    UNTRUSTED_PERCEPTION_TRIGGER = "UNTRUSTED_PERCEPTION_TRIGGER"


class EvidenceWindowStatus(str, Enum):
    PLANNED = "PLANNED"
    PREROLL_UNAVAILABLE = "PREROLL_UNAVAILABLE"
    POSTROLL_UNAVAILABLE = "POSTROLL_UNAVAILABLE"
    KEYFRAME_UNAVAILABLE = "KEYFRAME_UNAVAILABLE"
    FRAGMENT_SCOPE_MISMATCH = "FRAGMENT_SCOPE_MISMATCH"
    CONFIGURATION_MISMATCH = "CONFIGURATION_MISMATCH"
    FRAGMENT_GAP = "FRAGMENT_GAP"
    CAPACITY_EXCEEDED = "CAPACITY_EXCEEDED"


INVALID_CAPTURE_FINDING_KINDS = frozenset(
    {
        IntegrityFindingKind.TIMESTAMP_DUPLICATE_OR_REGRESSION,
        IntegrityFindingKind.HOST_CLOCK_REGRESSION,
        IntegrityFindingKind.DIMENSION_CHANGE,
        IntegrityFindingKind.EXPOSURE_POLICY_VIOLATION,
        IntegrityFindingKind.RECONNECT_BOUNDARY,
        IntegrityFindingKind.CONFIGURATION_CHANGE,
        IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
        IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
        IntegrityFindingKind.ENCODER_FRAME_LOSS,
        IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
    }
)

_WINDOW_REASON_CODES = {
    EvidenceWindowStatus.PLANNED: frozenset(
        {"COMPLETE_KEYFRAME_ALIGNED_WINDOW"}
    ),
    EvidenceWindowStatus.PREROLL_UNAVAILABLE: frozenset(
        {
            "NO_CLOSED_FRAGMENTS",
            "PREROLL_PRECEDES_EVIDENCE_EPOCH",
            "REQUIRED_PREROLL_EVICTED",
            "REQUEST_START_NOT_RETAINED",
        }
    ),
    EvidenceWindowStatus.POSTROLL_UNAVAILABLE: frozenset(
        {"REQUIRED_POSTROLL_NOT_CLOSED", "REQUEST_END_NOT_CLOSED"}
    ),
    EvidenceWindowStatus.KEYFRAME_UNAVAILABLE: frozenset(
        {"NO_RETAINED_KEYFRAME_BEFORE_REQUEST"}
    ),
    EvidenceWindowStatus.FRAGMENT_SCOPE_MISMATCH: frozenset(
        {"SESSION_OR_RECONNECT_EPOCH_MIXED"}
    ),
    EvidenceWindowStatus.CONFIGURATION_MISMATCH: frozenset(
        {
            "FRAGMENT_SESSION_CONFIGURATION_SUBSTITUTED",
            "FRAGMENT_CONFIGURATION_MIXED",
            "FRAGMENT_DEVICE_TIME_BASE_MIXED",
        }
    ),
    EvidenceWindowStatus.FRAGMENT_GAP: frozenset(
        {
            "DUPLICATE_FRAGMENT_ID",
            "FRAGMENT_SEQUENCE_GAP",
            "FRAGMENT_EVIDENCE_INTERVAL_GAP_OR_OVERLAP",
            "FRAGMENT_DEVICE_INTERVAL_GAP_OR_OVERLAP",
        }
    ),
    EvidenceWindowStatus.CAPACITY_EXCEEDED: frozenset(
        {
            "PENDING_WINDOW_CAPACITY_EXCEEDED",
            "CLOSED_FRAGMENT_COUNT_EXCEEDED",
            "RING_BYTE_CEILING_EXCEEDED",
            "RETENTION_INTERVAL_EXCEEDED",
            "FINALIZED_SOURCE_BYTE_CEILING_EXCEEDED",
            "FINALIZED_FRAME_CEILING_EXCEEDED",
        }
    ),
}


@dataclass(frozen=True, slots=True)
class CaptureSessionDescriptor:
    source_kind: CaptureSourceKind
    trust_domain: CaptureTrustDomain
    deployment_id: str
    session_id: str
    match_id: str
    stream_id: str
    reconnect_epoch: int
    expected_width: int
    expected_height: int
    fps_numerator: int
    fps_denominator: int
    capture_profile_sha256: str
    backend_artifact_sha256: str
    camera_attestation_sha256: str | None
    clock_attestation_sha256: str | None
    encoder_configuration_sha256: str
    rights_grant_sha256: str | None
    evidence_time_open_ns: int
    exposure_policy: ExposurePolicy
    exposure_configuration_sha256: str
    locked_exposure_duration_ns: int | None = None
    locked_gain_milli_db: int | None = None
    locked_iso: int | None = None
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-session schema")
        _require_enum(self.source_kind, CaptureSourceKind, "source_kind")
        _require_enum(self.trust_domain, CaptureTrustDomain, "trust_domain")
        for field_name in ("deployment_id", "session_id", "match_id", "stream_id"):
            _require_stable_id(getattr(self, field_name), field_name)
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_positive(self.expected_width, "expected_width", maximum=16_384)
        _require_positive(self.expected_height, "expected_height", maximum=16_384)
        _require_reduced_rational(
            self.fps_numerator,
            self.fps_denominator,
            field_prefix="fps",
            maximum=1_000_000,
        )
        for field_name in (
            "capture_profile_sha256",
            "backend_artifact_sha256",
            "encoder_configuration_sha256",
            "exposure_configuration_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_optional_sha256(
            self.camera_attestation_sha256, "camera_attestation_sha256"
        )
        _require_optional_sha256(
            self.clock_attestation_sha256, "clock_attestation_sha256"
        )
        _require_optional_sha256(self.rights_grant_sha256, "rights_grant_sha256")
        _require_nonnegative(self.evidence_time_open_ns, "evidence_time_open_ns")
        _require_enum(self.exposure_policy, ExposurePolicy, "exposure_policy")
        if self.locked_exposure_duration_ns is not None:
            _require_positive(
                self.locked_exposure_duration_ns,
                "locked_exposure_duration_ns",
            )
        if self.locked_gain_milli_db is not None:
            _require_exact_int(self.locked_gain_milli_db, "locked_gain_milli_db")
        if self.locked_iso is not None:
            _require_positive(self.locked_iso, "locked_iso")

        if self.source_kind is CaptureSourceKind.LIVE_CAMERA:
            if self.trust_domain is not CaptureTrustDomain.PRODUCTION_CAPTURE:
                raise ValueError("live camera requires the production capture trust domain")
            if (
                self.camera_attestation_sha256 is None
                or self.clock_attestation_sha256 is None
                or self.rights_grant_sha256 is None
            ):
                raise ValueError(
                    "live camera requires camera, clock, and rights attestations"
                )
        else:
            if self.trust_domain is not CaptureTrustDomain.SYNTHETIC_TEST:
                raise ValueError("synthetic source requires the synthetic test trust domain")
            if any(
                value is not None
                for value in (
                    self.camera_attestation_sha256,
                    self.clock_attestation_sha256,
                    self.rights_grant_sha256,
                )
            ):
                raise ValueError(
                    "synthetic source cannot carry production trust attestations"
                )

        locked = (
            self.locked_exposure_duration_ns,
            self.locked_gain_milli_db,
            self.locked_iso,
        )
        if any(value is None for value in locked):
            raise ValueError(
                "locked exposure requires captured duration, gain, and ISO baselines"
            )

    @property
    def configuration_fingerprint(self) -> str:
        return _fingerprint(
            {
                "backend_artifact_sha256": self.backend_artifact_sha256,
                "camera_attestation_sha256": self.camera_attestation_sha256,
                "capture_profile_sha256": self.capture_profile_sha256,
                "clock_attestation_sha256": self.clock_attestation_sha256,
                "encoder_configuration_sha256": self.encoder_configuration_sha256,
                "expected_height": self.expected_height,
                "expected_width": self.expected_width,
                "exposure_configuration_sha256": self.exposure_configuration_sha256,
                "exposure_policy": self.exposure_policy.value,
                "fps_denominator": self.fps_denominator,
                "fps_numerator": self.fps_numerator,
                "locked_exposure_duration_ns": self.locked_exposure_duration_ns,
                "locked_gain_milli_db": self.locked_gain_milli_db,
                "locked_iso": self.locked_iso,
            },
            label="capture configuration",
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend_artifact_sha256": self.backend_artifact_sha256,
            "camera_attestation_sha256": self.camera_attestation_sha256,
            "capture_profile_sha256": self.capture_profile_sha256,
            "clock_attestation_sha256": self.clock_attestation_sha256,
            "deployment_id": self.deployment_id,
            "encoder_configuration_sha256": self.encoder_configuration_sha256,
            "evidence_time_open_ns": self.evidence_time_open_ns,
            "expected_height": self.expected_height,
            "expected_width": self.expected_width,
            "exposure_configuration_sha256": self.exposure_configuration_sha256,
            "exposure_policy": self.exposure_policy.value,
            "fps_denominator": self.fps_denominator,
            "fps_numerator": self.fps_numerator,
            "locked_exposure_duration_ns": self.locked_exposure_duration_ns,
            "locked_gain_milli_db": self.locked_gain_milli_db,
            "locked_iso": self.locked_iso,
            "match_id": self.match_id,
            "reconnect_epoch": self.reconnect_epoch,
            "rights_grant_sha256": self.rights_grant_sha256,
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "source_kind": self.source_kind.value,
            "stream_id": self.stream_id,
            "trust_domain": self.trust_domain.value,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture session")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureSessionDescriptor":
        value = _parse_canonical_json(raw, label="capture session")
        _require_fields(value, required=set(cls.__dataclass_fields__), label="capture session")
        try:
            return cls(
                **{
                    **value,
                    "source_kind": _enum_from_json(
                        CaptureSourceKind, value["source_kind"], "source_kind"
                    ),
                    "trust_domain": _enum_from_json(
                        CaptureTrustDomain, value["trust_domain"], "trust_domain"
                    ),
                    "exposure_policy": _enum_from_json(
                        ExposurePolicy, value["exposure_policy"], "exposure_policy"
                    ),
                }
            )
        except CaptureContractError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_SESSION", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class CaptureFrameSignal:
    session_fingerprint: str
    reconnect_epoch: int
    observed_sequence: int
    device_sequence: int | None
    device_timestamp: int
    device_time_base_numerator: int
    device_time_base_denominator: int
    host_monotonic_ns: int
    width: int
    height: int
    configuration_fingerprint: str
    diagnostic_contract: str | None = None
    diagnostic_luma_sha256: str | None = None
    exposure_duration_ns: int | None = None
    gain_milli_db: int | None = None
    iso: int | None = None
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-frame schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_nonnegative(self.observed_sequence, "observed_sequence")
        _require_optional_nonnegative(self.device_sequence, "device_sequence")
        _require_exact_int(self.device_timestamp, "device_timestamp")
        _require_reduced_rational(
            self.device_time_base_numerator,
            self.device_time_base_denominator,
            field_prefix="device_time_base",
        )
        _require_nonnegative(self.host_monotonic_ns, "host_monotonic_ns")
        _require_positive(self.width, "width", maximum=16_384)
        _require_positive(self.height, "height", maximum=16_384)
        _require_sha256(self.configuration_fingerprint, "configuration_fingerprint")
        if (self.diagnostic_contract is None) != (
            self.diagnostic_luma_sha256 is None
        ):
            raise ValueError("diagnostic contract and hash must be present together")
        if self.diagnostic_contract is not None:
            if self.diagnostic_contract != DIAGNOSTIC_FINGERPRINT_CONTRACT:
                raise ValueError("unsupported diagnostic fingerprint contract")
            _require_sha256(self.diagnostic_luma_sha256, "diagnostic_luma_sha256")
        if self.exposure_duration_ns is not None:
            _require_positive(self.exposure_duration_ns, "exposure_duration_ns")
        if self.gain_milli_db is not None:
            _require_exact_int(self.gain_milli_db, "gain_milli_db")
        if self.iso is not None:
            _require_positive(self.iso, "iso")

    def to_dict(self) -> dict[str, Any]:
        return {
            name: (value.value if isinstance(value, Enum) else value)
            for name, value in (
                (field_name, getattr(self, field_name))
                for field_name in self.__dataclass_fields__
            )
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture frame")

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureFrameSignal":
        return _decode_simple_dataclass(cls, raw, label="capture frame")


@dataclass(frozen=True, slots=True)
class CaptureDropNotice:
    session_fingerprint: str
    reconnect_epoch: int
    after_observed_sequence: int | None
    device_timestamp: int | None
    device_time_base_numerator: int | None
    device_time_base_denominator: int | None
    host_monotonic_ns: int
    reported_count: int | None
    reason: CaptureDropReason
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-drop schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_optional_nonnegative(
            self.after_observed_sequence,
            "after_observed_sequence",
        )
        if self.device_timestamp is None:
            if self.device_time_base_numerator is not None or self.device_time_base_denominator is not None:
                raise ValueError("device time base requires a device timestamp")
        else:
            _require_exact_int(self.device_timestamp, "device_timestamp")
            _require_reduced_rational(
                self.device_time_base_numerator,
                self.device_time_base_denominator,
                field_prefix="device_time_base",
            )
        _require_nonnegative(self.host_monotonic_ns, "host_monotonic_ns")
        if self.reported_count is not None:
            _require_positive(self.reported_count, "reported_count")
        _require_enum(self.reason, CaptureDropReason, "reason")

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture drop notice")

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureDropNotice":
        return _decode_simple_dataclass(
            cls,
            raw,
            label="capture drop notice",
            enum_fields={"reason": CaptureDropReason},
        )


@dataclass(frozen=True, slots=True)
class CaptureStreamBoundary:
    session_fingerprint: str
    reconnect_epoch: int
    at_observed_sequence: int
    host_monotonic_ns: int
    kind: CaptureBoundaryKind
    configuration_fingerprint: str
    new_configuration_fingerprint: str | None = None
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-boundary schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_nonnegative(self.at_observed_sequence, "at_observed_sequence")
        _require_nonnegative(self.host_monotonic_ns, "host_monotonic_ns")
        _require_enum(self.kind, CaptureBoundaryKind, "kind")
        _require_sha256(self.configuration_fingerprint, "configuration_fingerprint")
        _require_optional_sha256(
            self.new_configuration_fingerprint, "new_configuration_fingerprint"
        )
        if self.kind is CaptureBoundaryKind.CONFIG_CHANGE:
            if (
                self.new_configuration_fingerprint is None
                or self.new_configuration_fingerprint == self.configuration_fingerprint
            ):
                raise ValueError("config change requires a distinct new configuration")
        elif self.new_configuration_fingerprint is not None:
            raise ValueError("only config change may declare a new configuration")

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture stream boundary")

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureStreamBoundary":
        return _decode_simple_dataclass(
            cls,
            raw,
            label="capture stream boundary",
            enum_fields={"kind": CaptureBoundaryKind},
        )


@dataclass(frozen=True, slots=True)
class FinalizedSourceFrameSignal:
    session_fingerprint: str
    reconnect_epoch: int
    configuration_fingerprint: str
    presentation_index: int
    source_pts: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    mapped_evidence_timestamp_ns: int
    width: int
    height: int
    represented_in_output: bool
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported finalized-source-frame schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_sha256(self.configuration_fingerprint, "configuration_fingerprint")
        _require_nonnegative(self.presentation_index, "presentation_index")
        _require_exact_int(self.source_pts, "source_pts")
        _require_reduced_rational(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
            field_prefix="source_time_base",
        )
        _require_nonnegative(
            self.mapped_evidence_timestamp_ns, "mapped_evidence_timestamp_ns"
        )
        _require_positive(self.width, "width", maximum=16_384)
        _require_positive(self.height, "height", maximum=16_384)
        _require_bool(self.represented_in_output, "represented_in_output")

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="finalized source frame")

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "FinalizedSourceFrameSignal":
        return _decode_simple_dataclass(cls, raw, label="finalized source frame")


CaptureTraceRecord: TypeAlias = (
    CaptureFrameSignal | CaptureDropNotice | CaptureStreamBoundary
)


def encode_capture_trace_record(record: CaptureTraceRecord) -> bytes:
    if type(record) is CaptureFrameSignal:
        record_type = "FRAME"
    elif type(record) is CaptureDropNotice:
        record_type = "DROP_NOTICE"
    elif type(record) is CaptureStreamBoundary:
        record_type = "STREAM_BOUNDARY"
    else:
        raise ValueError("unsupported capture trace record type")
    return _canonical_json_bytes(
        {"record": record.to_dict(), "record_type": record_type},
        label="capture trace record",
    )


def decode_capture_trace_record(raw: bytes) -> CaptureTraceRecord:
    value = _parse_canonical_json(raw, label="capture trace record")
    _require_fields(
        value,
        required={"record", "record_type"},
        label="capture trace record",
    )
    record = value["record"]
    if type(record) is not dict:
        _fail("INVALID_CAPTURE_RECORD", "record must be an object")
    encoded_record = _canonical_json_bytes(record, label="nested capture record")
    record_type = value["record_type"]
    if record_type == "FRAME":
        return CaptureFrameSignal.from_json_bytes(encoded_record)
    if record_type == "DROP_NOTICE":
        return CaptureDropNotice.from_json_bytes(encoded_record)
    if record_type == "STREAM_BOUNDARY":
        return CaptureStreamBoundary.from_json_bytes(encoded_record)
    _fail("INVALID_CAPTURE_RECORD", "unsupported capture record type")
    raise AssertionError


@dataclass(frozen=True, slots=True)
class EvidenceWindowRequest:
    request_id: str
    idempotency_key: str
    session_fingerprint: str
    expected_session_configuration_fingerprint: str
    reconnect_epoch: int
    trigger_evidence_time_ns: int
    pre_roll_ns: int
    post_roll_ns: int
    origin: WindowRequestOrigin
    requested_at_ns: int
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported evidence-window-request schema")
        _require_stable_id(self.request_id, "request_id")
        _require_stable_id(self.idempotency_key, "idempotency_key")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_sha256(
            self.expected_session_configuration_fingerprint,
            "expected_session_configuration_fingerprint",
        )
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_nonnegative(
            self.trigger_evidence_time_ns, "trigger_evidence_time_ns"
        )
        _require_nonnegative(self.pre_roll_ns, "pre_roll_ns")
        _require_nonnegative(self.post_roll_ns, "post_roll_ns")
        if self.pre_roll_ns + self.post_roll_ns > MAX_WINDOW_ROLL_NS:
            raise ValueError("pre-roll plus post-roll exceeds the 30-second ceiling")
        _require_enum(self.origin, WindowRequestOrigin, "origin")
        _require_nonnegative(self.requested_at_ns, "requested_at_ns")
        if self.trigger_evidence_time_ns + self.post_roll_ns > MAX_SIGNED_64:
            raise ValueError("requested window end exceeds signed 64-bit range")

    @property
    def requested_start_ns(self) -> int:
        if self.pre_roll_ns > self.trigger_evidence_time_ns:
            return 0
        return self.trigger_evidence_time_ns - self.pre_roll_ns

    @property
    def requested_end_ns(self) -> int:
        value = self.trigger_evidence_time_ns + self.post_roll_ns
        if value > MAX_SIGNED_64:
            raise ValueError("requested window end exceeds signed 64-bit range")
        return value

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="evidence window request")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "EvidenceWindowRequest":
        return _decode_simple_dataclass(
            cls,
            raw,
            label="evidence window request",
            enum_fields={"origin": WindowRequestOrigin},
        )


@dataclass(frozen=True, slots=True)
class CaptureFragmentDescriptor:
    fragment_id: str
    session_fingerprint: str
    session_configuration_fingerprint: str
    reconnect_epoch: int
    fragment_sequence: int
    evidence_start_ns: int
    evidence_end_ns: int
    device_start_timestamp: int
    device_end_timestamp: int
    device_time_base_numerator: int
    device_time_base_denominator: int
    byte_length: int
    content_sha256: str
    frame_count: int
    keyframe_at_start: bool
    capture_profile_sha256: str
    camera_fingerprint: str
    clock_fingerprint: str
    encoder_configuration_sha256: str
    exposure_configuration_sha256: str
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-fragment schema")
        _require_stable_id(self.fragment_id, "fragment_id")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_sha256(
            self.session_configuration_fingerprint,
            "session_configuration_fingerprint",
        )
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_nonnegative(self.fragment_sequence, "fragment_sequence")
        start = _require_nonnegative(self.evidence_start_ns, "evidence_start_ns")
        end = _require_nonnegative(self.evidence_end_ns, "evidence_end_ns")
        if end <= start or end - start > MAX_FRAGMENT_DURATION_NS:
            raise ValueError("fragment must have a positive duration of at most 2 seconds")
        device_start = _require_exact_int(
            self.device_start_timestamp, "device_start_timestamp"
        )
        device_end = _require_exact_int(
            self.device_end_timestamp, "device_end_timestamp"
        )
        if device_end <= device_start:
            raise ValueError("device_end_timestamp must follow device_start_timestamp")
        _require_reduced_rational(
            self.device_time_base_numerator,
            self.device_time_base_denominator,
            field_prefix="device_time_base",
        )
        _require_positive(self.byte_length, "byte_length", maximum=MAX_FRAGMENT_BYTES)
        _require_sha256(self.content_sha256, "content_sha256")
        _require_positive(self.frame_count, "frame_count", maximum=MAX_FINALIZED_FRAMES)
        _require_bool(self.keyframe_at_start, "keyframe_at_start")
        for field_name in (
            "capture_profile_sha256",
            "camera_fingerprint",
            "clock_fingerprint",
            "encoder_configuration_sha256",
            "exposure_configuration_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)

    @property
    def configuration_fingerprint(self) -> str:
        return _fingerprint(
            {
                "camera_fingerprint": self.camera_fingerprint,
                "capture_profile_sha256": self.capture_profile_sha256,
                "clock_fingerprint": self.clock_fingerprint,
                "encoder_configuration_sha256": self.encoder_configuration_sha256,
                "exposure_configuration_sha256": self.exposure_configuration_sha256,
            },
            label="fragment configuration",
        )

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="capture fragment")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureFragmentDescriptor":
        return _decode_simple_dataclass(cls, raw, label="capture fragment")


FindingBasisValue: TypeAlias = int | str | bool | None


@dataclass(frozen=True, slots=True)
class IntegrityFinding:
    kind: IntegrityFindingKind
    observed_sequence_start: int | None
    observed_sequence_end: int | None
    evidence_start_ns: int | None
    evidence_end_ns: int | None
    basis: tuple[tuple[str, FindingBasisValue], ...]
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported integrity-finding schema")
        _require_enum(self.kind, IntegrityFindingKind, "kind")
        for field_name in (
            "observed_sequence_start",
            "observed_sequence_end",
            "evidence_start_ns",
            "evidence_end_ns",
        ):
            _require_optional_nonnegative(getattr(self, field_name), field_name)
        if (self.observed_sequence_start is None) != (
            self.observed_sequence_end is None
        ):
            raise ValueError("observed sequence interval must be complete or absent")
        if (
            self.observed_sequence_start is not None
            and self.observed_sequence_end < self.observed_sequence_start
        ):
            raise ValueError("observed sequence interval is reversed")
        if (self.evidence_start_ns is None) != (self.evidence_end_ns is None):
            raise ValueError("evidence interval must be complete or absent")
        if (
            self.evidence_start_ns is not None
            and self.evidence_end_ns < self.evidence_start_ns
        ):
            raise ValueError("evidence interval is reversed")
        if type(self.basis) is not tuple or len(self.basis) > 16:
            raise ValueError("basis must be an immutable tuple of at most 16 entries")
        keys: list[str] = []
        for index, item in enumerate(self.basis):
            if type(item) is not tuple or len(item) != 2:
                raise ValueError(f"basis[{index}] must be a key/value tuple")
            key, value = item
            _require_stable_id(key, f"basis[{index}].key")
            if value is not None and type(value) not in (str, int, bool):
                raise ValueError(f"basis[{index}].value has an unsupported type")
            if type(value) is str and len(value) > 256:
                raise ValueError(f"basis[{index}].value exceeds 256 characters")
            if type(value) is int:
                _require_exact_int(value, f"basis[{index}].value")
            keys.append(key)
        if keys != sorted(keys) or len(keys) != len(set(keys)):
            raise ValueError("basis keys must be unique and sorted")

    def to_dict(self) -> dict[str, Any]:
        return {
            "basis": [
                {"key": key, "value": value}
                for key, value in self.basis
            ],
            "evidence_end_ns": self.evidence_end_ns,
            "evidence_start_ns": self.evidence_start_ns,
            "kind": self.kind.value,
            "observed_sequence_end": self.observed_sequence_end,
            "observed_sequence_start": self.observed_sequence_start,
            "schema_version": self.schema_version,
        }

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="integrity finding")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "IntegrityFinding":
        value = _parse_canonical_json(raw, label="integrity finding")
        return _decode_integrity_finding_value(value, label="integrity finding")


@dataclass(frozen=True, slots=True)
class CaptureSegmentIntegrityReport:
    session_fingerprint: str
    source_kind: CaptureSourceKind
    trust_domain: CaptureTrustDomain
    window_fingerprint: str
    reconnect_epoch: int
    source_start_pts: int
    source_end_pts: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    evidence_start_ns: int
    evidence_end_ns: int
    observed_frame_count: int
    finalized_frame_count: int
    fps_numerator: int
    fps_denominator: int
    explicit_drop_notice_count: int
    explicit_reported_drop_count: int
    explicit_unknown_drop_count_notices: int
    inferred_timestamp_gap_count: int
    device_sequence_gap_count: int
    timestamp_failure_count: int
    freeze_candidate_count: int
    findings: tuple[IntegrityFinding, ...]
    finding_details_truncated: bool
    total_finding_count: int
    finding_kind_counts: tuple[tuple[IntegrityFindingKind, int], ...]
    camera_fingerprint: str | None
    clock_fingerprint: str | None
    encoder_configuration_sha256: str
    exposure_configuration_sha256: str
    finalized_trace_structurally_valid: bool
    disposition: IntegrityDisposition
    reason_codes: tuple[str, ...]
    structurally_eligible_for_trust_verification: bool
    video_only: bool = True
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported capture-report schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_enum(self.source_kind, CaptureSourceKind, "source_kind")
        _require_enum(self.trust_domain, CaptureTrustDomain, "trust_domain")
        _require_sha256(self.window_fingerprint, "window_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_exact_int(self.source_start_pts, "source_start_pts")
        _require_exact_int(self.source_end_pts, "source_end_pts")
        if self.source_end_pts < self.source_start_pts:
            raise ValueError("source interval is reversed")
        _require_reduced_rational(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
            field_prefix="source_time_base",
        )
        _require_nonnegative(self.evidence_start_ns, "evidence_start_ns")
        _require_nonnegative(self.evidence_end_ns, "evidence_end_ns")
        if self.evidence_end_ns < self.evidence_start_ns:
            raise ValueError("evidence interval is reversed")
        for field_name in (
            "observed_frame_count",
            "finalized_frame_count",
            "explicit_drop_notice_count",
            "explicit_reported_drop_count",
            "explicit_unknown_drop_count_notices",
            "inferred_timestamp_gap_count",
            "device_sequence_gap_count",
            "timestamp_failure_count",
            "freeze_candidate_count",
            "total_finding_count",
        ):
            _require_nonnegative(getattr(self, field_name), field_name)
        if self.observed_frame_count > MAX_FINALIZED_FRAMES:
            raise ValueError("observed_frame_count exceeds the frame ceiling")
        if self.finalized_frame_count > MAX_FINALIZED_FRAMES:
            raise ValueError("finalized_frame_count exceeds the frame ceiling")
        _require_reduced_rational(
            self.fps_numerator,
            self.fps_denominator,
            field_prefix="fps",
            maximum=1_000_000,
        )
        if type(self.findings) is not tuple or len(self.findings) > MAX_CAPTURE_FINDINGS:
            raise ValueError("findings exceed the fixed detailed-finding ceiling")
        if any(type(item) is not IntegrityFinding for item in self.findings):
            raise ValueError("findings must contain IntegrityFinding values")
        _require_bool(self.finding_details_truncated, "finding_details_truncated")
        if self.total_finding_count < len(self.findings):
            raise ValueError("total_finding_count cannot be smaller than details")
        if self.finding_details_truncated != (
            self.total_finding_count > len(self.findings)
        ):
            raise ValueError("finding truncation state is inconsistent")
        if self.finding_details_truncated and len(self.findings) != MAX_CAPTURE_FINDINGS:
            raise ValueError(
                "truncated finding details must fill the fixed detail ceiling"
            )
        _require_optional_sha256(self.camera_fingerprint, "camera_fingerprint")
        _require_optional_sha256(self.clock_fingerprint, "clock_fingerprint")
        _require_sha256(
            self.encoder_configuration_sha256, "encoder_configuration_sha256"
        )
        _require_sha256(
            self.exposure_configuration_sha256, "exposure_configuration_sha256"
        )
        _require_bool(
            self.finalized_trace_structurally_valid,
            "finalized_trace_structurally_valid",
        )
        _require_enum(self.disposition, IntegrityDisposition, "disposition")
        if type(self.reason_codes) is not tuple or len(self.reason_codes) > 32:
            raise ValueError("reason_codes must be a bounded immutable tuple")
        for index, reason in enumerate(self.reason_codes):
            _require_stable_id(reason, f"reason_codes[{index}]")
        if tuple(sorted(set(self.reason_codes))) != self.reason_codes:
            raise ValueError("reason_codes must be unique and sorted")
        _require_bool(
            self.structurally_eligible_for_trust_verification,
            "structurally_eligible_for_trust_verification",
        )
        _require_bool(self.video_only, "video_only")
        if not self.video_only:
            raise ValueError("capture integrity schema 1 is video-only")

        production = (
            self.source_kind is CaptureSourceKind.LIVE_CAMERA
            and self.trust_domain is CaptureTrustDomain.PRODUCTION_CAPTURE
        )
        synthetic = (
            self.source_kind is CaptureSourceKind.SYNTHETIC_TEST
            and self.trust_domain is CaptureTrustDomain.SYNTHETIC_TEST
        )
        if not (production or synthetic):
            raise ValueError("capture report source and trust domains are inconsistent")
        if self.clock_fingerprint is None:
            raise ValueError("capture report requires its clock-mapping fingerprint")
        if production and self.camera_fingerprint is None:
            raise ValueError("production capture report requires its camera claim")
        if synthetic and self.camera_fingerprint is not None:
            raise ValueError("synthetic capture report cannot carry a camera attestation")

        expected_finding_kinds = tuple(
            sorted(IntegrityFindingKind, key=lambda item: item.value)
        )
        if type(self.finding_kind_counts) is not tuple:
            raise ValueError("finding_kind_counts must be an immutable tuple")
        parsed_finding_kinds: list[IntegrityFindingKind] = []
        parsed_finding_counts: list[int] = []
        for index, item in enumerate(self.finding_kind_counts):
            if type(item) is not tuple or len(item) != 2:
                raise ValueError(
                    f"finding_kind_counts[{index}] must be a kind/count tuple"
                )
            kind, count = item
            _require_enum(
                kind,
                IntegrityFindingKind,
                f"finding_kind_counts[{index}].kind",
            )
            _require_nonnegative(count, f"finding_kind_counts[{index}].count")
            parsed_finding_kinds.append(kind)
            parsed_finding_counts.append(count)
        if tuple(parsed_finding_kinds) != expected_finding_kinds:
            raise ValueError(
                "finding_kind_counts must contain every finding kind in canonical order"
            )
        if sum(parsed_finding_counts) != self.total_finding_count:
            raise ValueError("finding-kind counts must sum to total_finding_count")
        finding_counts = dict(self.finding_kind_counts)
        visible_counts = {
            kind: sum(finding.kind is kind for finding in self.findings)
            for kind in IntegrityFindingKind
        }
        for kind, visible_count in visible_counts.items():
            if finding_counts[kind] < visible_count:
                raise ValueError(
                    "finding-kind aggregate is smaller than visible details"
                )
        visible_reported_drop_count = 0
        visible_unknown_drop_notices = 0
        for finding in self.findings:
            if finding.kind is not IntegrityFindingKind.EXPLICIT_BACKEND_DROP:
                continue
            finding_basis = dict(finding.basis)
            if "reported_count" not in finding_basis:
                raise ValueError(
                    "explicit-drop finding must bind its reported_count"
                )
            reported_count = finding_basis["reported_count"]
            if reported_count is None:
                visible_unknown_drop_notices += 1
            else:
                _require_positive(reported_count, "finding reported_count")
                visible_reported_drop_count += reported_count
                if visible_reported_drop_count > MAX_SIGNED_64:
                    raise ValueError("visible reported-drop total exceeds signed 64-bit")

        kind_counter_expectations = (
            (
                "explicit_drop_notice_count",
                IntegrityFindingKind.EXPLICIT_BACKEND_DROP,
            ),
            (
                "inferred_timestamp_gap_count",
                IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP,
            ),
            (
                "device_sequence_gap_count",
                IntegrityFindingKind.DEVICE_SEQUENCE_GAP,
            ),
            (
                "timestamp_failure_count",
                IntegrityFindingKind.TIMESTAMP_DUPLICATE_OR_REGRESSION,
            ),
            (
                "freeze_candidate_count",
                IntegrityFindingKind.DIAGNOSTIC_FREEZE_CANDIDATE,
            ),
        )
        for field_name, finding_kind in kind_counter_expectations:
            if getattr(self, field_name) != finding_counts[finding_kind]:
                raise ValueError(
                    f"{field_name} differs from its finding-kind aggregate"
                )
        if self.explicit_unknown_drop_count_notices > self.explicit_drop_notice_count:
            raise ValueError("unknown drop notices exceed all explicit drop notices")
        if self.explicit_unknown_drop_count_notices < visible_unknown_drop_notices:
            raise ValueError("unknown-drop aggregate is smaller than visible details")
        visible_known_drop_notices = (
            visible_counts[IntegrityFindingKind.EXPLICIT_BACKEND_DROP]
            - visible_unknown_drop_notices
        )
        all_known_drop_notices = (
            self.explicit_drop_notice_count
            - self.explicit_unknown_drop_count_notices
        )
        if all_known_drop_notices < visible_known_drop_notices:
            raise ValueError("known-drop aggregate is smaller than visible details")
        if self.explicit_reported_drop_count < visible_reported_drop_count:
            raise ValueError("reported-drop aggregate is smaller than visible details")
        hidden_known_drop_notices = (
            all_known_drop_notices - visible_known_drop_notices
        )
        hidden_reported_drop_count = (
            self.explicit_reported_drop_count - visible_reported_drop_count
        )
        if (
            hidden_known_drop_notices == 0
            and hidden_reported_drop_count != 0
        ) or (
            hidden_known_drop_notices > 0
            and hidden_reported_drop_count < hidden_known_drop_notices
        ):
            raise ValueError(
                "reported-drop aggregate cannot describe the hidden known notices"
            )

        trust_reason = (
            "CRYPTOGRAPHIC_CAPTURE_TRUST_NOT_VERIFIED"
            if production
            else "SYNTHETIC_NON_OPERATIONAL"
        )
        expected_reason_codes = {
            kind.value
            for kind, count in self.finding_kind_counts
            if count > 0
        } | {trust_reason}
        if self.finding_details_truncated:
            expected_reason_codes.add("FINDING_DETAILS_TRUNCATED")
        actual_reason_codes = set(self.reason_codes)
        if actual_reason_codes != expected_reason_codes:
            raise ValueError("reason_codes differ from finding-kind aggregates")
        expected_disposition = (
            IntegrityDisposition.INVALID
            if self.finding_details_truncated
            or any(
                finding_counts[kind] > 0
                for kind in INVALID_CAPTURE_FINDING_KINDS
            )
            else IntegrityDisposition.OBSERVED_DEGRADED
            if self.total_finding_count
            else IntegrityDisposition.OBSERVED_CLEAN
        )
        if self.disposition is not expected_disposition:
            raise ValueError("disposition differs from the derived integrity state")

        expected_finalized_valid = not bool(
            actual_reason_codes
            & {
                IntegrityFindingKind.ENCODER_FRAME_LOSS.value,
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE.value,
            }
        )
        if self.finalized_trace_structurally_valid != expected_finalized_valid:
            raise ValueError(
                "finalized-trace validity differs from finalized-output findings"
            )
        if self.finalized_trace_structurally_valid and (
            self.finalized_frame_count == 0
            or self.observed_frame_count != self.finalized_frame_count
        ):
            raise ValueError(
                "a structurally valid finalized trace must preserve every frame"
            )
        if self.finalized_frame_count <= 1 and (
            self.source_start_pts != self.source_end_pts
            or self.evidence_start_ns != self.evidence_end_ns
        ):
            raise ValueError(
                "zero- or one-frame finalized traces require singleton intervals"
            )
        if (
            self.finalized_trace_structurally_valid
            and self.source_end_pts - self.source_start_pts
            < self.finalized_frame_count - 1
        ):
            raise ValueError(
                "finalized source PTS range cannot contain its strictly increasing frames"
            )

        expected_eligibility = (
            production
            and self.disposition is IntegrityDisposition.OBSERVED_CLEAN
            and self.finalized_trace_structurally_valid
        )
        if self.structurally_eligible_for_trust_verification != expected_eligibility:
            raise ValueError(
                "trust-verification eligibility differs from derived structural state"
            )

        # Every constructible report must be serializable under the public
        # parser's exact byte ceiling; otherwise construction and handoff have
        # incompatible bounds.
        _canonical_json_bytes(
            self.to_dict(), label="capture segment integrity report"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            name: (
                [finding.to_dict() for finding in self.findings]
                if name == "findings"
                else [
                    {"count": count, "kind": kind.value}
                    for kind, count in self.finding_kind_counts
                ]
                if name == "finding_kind_counts"
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
            self.to_dict(), label="capture segment integrity report"
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureSegmentIntegrityReport":
        value = _parse_canonical_json(
            raw, label="capture segment integrity report"
        )
        _require_fields(
            value,
            required=set(cls.__dataclass_fields__),
            label="capture segment integrity report",
        )
        findings = value["findings"]
        finding_kind_counts = value["finding_kind_counts"]
        reason_codes = value["reason_codes"]
        if type(findings) is not list:
            _fail("INVALID_CAPTURE_REPORT", "findings must be a JSON array")
        if len(findings) > MAX_CAPTURE_FINDINGS:
            _fail(
                "INVALID_CAPTURE_REPORT",
                "findings exceed the fixed detailed-finding ceiling",
            )
        if type(reason_codes) is not list:
            _fail("INVALID_CAPTURE_REPORT", "reason_codes must be a JSON array")
        if type(finding_kind_counts) is not list:
            _fail(
                "INVALID_CAPTURE_REPORT",
                "finding_kind_counts must be a JSON array",
            )
        try:
            decoded_findings = tuple(
                _decode_integrity_finding_value(
                    finding,
                    label=f"capture segment integrity report findings[{index}]",
                )
                for index, finding in enumerate(findings)
            )
            decoded_finding_kind_counts: list[
                tuple[IntegrityFindingKind, int]
            ] = []
            for index, entry in enumerate(finding_kind_counts):
                entry_label = f"finding_kind_counts[{index}]"
                if type(entry) is not dict:
                    _fail(
                        "INVALID_CAPTURE_REPORT",
                        f"{entry_label} must be a JSON object",
                    )
                _require_fields(
                    entry,
                    required={"count", "kind"},
                    label=entry_label,
                )
                decoded_finding_kind_counts.append(
                    (
                        _enum_from_json(
                            IntegrityFindingKind,
                            entry["kind"],
                            f"{entry_label}.kind",
                        ),
                        entry["count"],
                    )
                )
            return cls(
                **{
                    **value,
                    "findings": decoded_findings,
                    "finding_kind_counts": tuple(
                        decoded_finding_kind_counts
                    ),
                    "reason_codes": tuple(reason_codes),
                    "source_kind": _enum_from_json(
                        CaptureSourceKind,
                        value["source_kind"],
                        "source_kind",
                    ),
                    "trust_domain": _enum_from_json(
                        CaptureTrustDomain,
                        value["trust_domain"],
                        "trust_domain",
                    ),
                    "disposition": _enum_from_json(
                        IntegrityDisposition,
                        value["disposition"],
                        "disposition",
                    ),
                }
            )
        except CaptureContractError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_REPORT", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class EvidenceWindowPlan:
    request_fingerprint: str
    status: EvidenceWindowStatus
    session_fingerprint: str
    reconnect_epoch: int
    requested_start_ns: int
    requested_end_ns: int
    actual_start_ns: int | None
    actual_end_ns: int | None
    selected_fragment_ids: tuple[str, ...]
    selected_fragment_fingerprints: tuple[str, ...]
    configuration_fingerprint: str | None
    total_byte_length: int
    total_frame_count: int
    reason_code: str
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported evidence-window-plan schema")
        _require_sha256(self.request_fingerprint, "request_fingerprint")
        _require_enum(self.status, EvidenceWindowStatus, "status")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_nonnegative(self.requested_start_ns, "requested_start_ns")
        _require_nonnegative(self.requested_end_ns, "requested_end_ns")
        if self.requested_end_ns < self.requested_start_ns:
            raise ValueError("requested interval is reversed")
        _require_optional_nonnegative(self.actual_start_ns, "actual_start_ns")
        _require_optional_nonnegative(self.actual_end_ns, "actual_end_ns")
        if (self.actual_start_ns is None) != (self.actual_end_ns is None):
            raise ValueError("actual interval must be complete or absent")
        if self.actual_start_ns is not None and self.actual_end_ns <= self.actual_start_ns:
            raise ValueError("actual interval must have positive duration")
        if type(self.selected_fragment_ids) is not tuple or type(
            self.selected_fragment_fingerprints
        ) is not tuple:
            raise ValueError("selected fragments must be immutable tuples")
        if len(self.selected_fragment_ids) != len(self.selected_fragment_fingerprints):
            raise ValueError("selected fragment identities are misaligned")
        if len(self.selected_fragment_ids) > MAX_CLOSED_FRAGMENTS:
            raise ValueError("too many selected fragments")
        for index, fragment_id in enumerate(self.selected_fragment_ids):
            _require_stable_id(fragment_id, f"selected_fragment_ids[{index}]")
            _require_sha256(
                self.selected_fragment_fingerprints[index],
                f"selected_fragment_fingerprints[{index}]",
            )
        if len(set(self.selected_fragment_ids)) != len(self.selected_fragment_ids):
            raise ValueError("selected fragment IDs must be unique")
        if len(set(self.selected_fragment_fingerprints)) != len(
            self.selected_fragment_fingerprints
        ):
            raise ValueError("selected fragment fingerprints must be unique")
        _require_optional_sha256(
            self.configuration_fingerprint, "configuration_fingerprint"
        )
        _require_nonnegative(self.total_byte_length, "total_byte_length")
        _require_nonnegative(self.total_frame_count, "total_frame_count")
        if self.total_byte_length > MAX_FINALIZED_SOURCE_BYTES:
            raise ValueError("planned source exceeds the byte ceiling")
        if self.total_frame_count > MAX_FINALIZED_FRAMES:
            raise ValueError("planned source exceeds the frame ceiling")
        _require_stable_id(self.reason_code, "reason_code")
        if self.reason_code not in _WINDOW_REASON_CODES[self.status]:
            raise ValueError("reason_code is not valid for the window status")
        planned = self.status is EvidenceWindowStatus.PLANNED
        if planned != bool(self.selected_fragment_ids):
            raise ValueError("only a planned result may select fragments")
        if planned and (
            self.actual_start_ns is None or self.configuration_fingerprint is None
        ):
            raise ValueError("planned result requires actual interval and configuration")
        if planned and (
            self.actual_start_ns > self.requested_start_ns
            or self.actual_end_ns < self.requested_end_ns
        ):
            raise ValueError("planned interval cannot shorten the requested window")
        if planned and (
            self.total_byte_length < len(self.selected_fragment_ids)
            or self.total_frame_count < len(self.selected_fragment_ids)
        ):
            raise ValueError(
                "planned totals must include positive bytes and frames per fragment"
            )
        if not planned and (
            self.actual_start_ns is not None
            or self.configuration_fingerprint is not None
            or self.total_byte_length != 0
            or self.total_frame_count != 0
        ):
            raise ValueError("unplanned result cannot claim materialized content")

    def to_dict(self) -> dict[str, Any]:
        return _dataclass_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_dict(), label="evidence window plan")

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "EvidenceWindowPlan":
        value = _parse_canonical_json(raw, label="evidence window plan")
        _require_fields(
            value,
            required=set(cls.__dataclass_fields__),
            label="evidence window plan",
        )
        fragment_ids = value["selected_fragment_ids"]
        fragment_fingerprints = value["selected_fragment_fingerprints"]
        if type(fragment_ids) is not list:
            _fail(
                "INVALID_EVIDENCE_WINDOW_PLAN",
                "selected_fragment_ids must be a JSON array",
            )
        if type(fragment_fingerprints) is not list:
            _fail(
                "INVALID_EVIDENCE_WINDOW_PLAN",
                "selected_fragment_fingerprints must be a JSON array",
            )
        try:
            return cls(
                **{
                    **value,
                    "status": _enum_from_json(
                        EvidenceWindowStatus, value["status"], "status"
                    ),
                    "selected_fragment_ids": tuple(fragment_ids),
                    "selected_fragment_fingerprints": tuple(
                        fragment_fingerprints
                    ),
                }
            )
        except CaptureContractError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_EVIDENCE_WINDOW_PLAN", str(exc))
            raise AssertionError from exc


def _decode_integrity_finding_value(
    value: object, *, label: str
) -> IntegrityFinding:
    if type(value) is not dict:
        _fail("INVALID_INTEGRITY_FINDING", f"{label} must be a JSON object")
    _require_fields(
        value,
        required=set(IntegrityFinding.__dataclass_fields__),
        label=label,
    )
    basis = value["basis"]
    if type(basis) is not list:
        _fail("INVALID_INTEGRITY_FINDING", f"{label} basis must be a JSON array")
    if len(basis) > 16:
        _fail(
            "INVALID_INTEGRITY_FINDING",
            f"{label} basis exceeds the fixed entry ceiling",
        )
    decoded_basis: list[tuple[str, FindingBasisValue]] = []
    for index, entry in enumerate(basis):
        entry_label = f"{label} basis[{index}]"
        if type(entry) is not dict:
            _fail(
                "INVALID_INTEGRITY_FINDING",
                f"{entry_label} must be a JSON object",
            )
        _require_fields(
            entry,
            required={"key", "value"},
            label=entry_label,
        )
        decoded_basis.append((entry["key"], entry["value"]))
    try:
        return IntegrityFinding(
            **{
                **value,
                "kind": _enum_from_json(
                    IntegrityFindingKind, value["kind"], "kind"
                ),
                "basis": tuple(decoded_basis),
            }
        )
    except CaptureContractError:
        raise
    except (TypeError, ValueError) as exc:
        _fail("INVALID_INTEGRITY_FINDING", str(exc))
        raise AssertionError from exc


def _dataclass_to_dict(value: object) -> dict[str, Any]:
    return {
        name: (item.value if isinstance(item, Enum) else item)
        for name, item in (
            (field_name, getattr(value, field_name))
            for field_name in value.__dataclass_fields__
        )
    }


def _decode_simple_dataclass(
    cls: type[Any],
    raw: bytes,
    *,
    label: str,
    enum_fields: Mapping[str, type[Enum]] | None = None,
) -> Any:
    value = _parse_canonical_json(raw, label=label)
    _require_fields(value, required=set(cls.__dataclass_fields__), label=label)
    decoded = dict(value)
    for field_name, enum_type in (enum_fields or {}).items():
        decoded[field_name] = _enum_from_json(
            enum_type, decoded[field_name], field_name
        )
    try:
        return cls(**decoded)
    except CaptureContractError:
        raise
    except (TypeError, ValueError) as exc:
        _fail("INVALID_CAPTURE_CONTRACT", str(exc))
        raise AssertionError from exc


__all__ = [
    "CAPTURE_SCHEMA_VERSION",
    "DIAGNOSTIC_FINGERPRINT_CONTRACT",
    "FREEZE_CANDIDATE_MIN_NS",
    "INVALID_CAPTURE_FINDING_KINDS",
    "MAX_CAPTURE_FINDINGS",
    "MAX_CLOSED_FRAGMENTS",
    "MAX_FINALIZED_FRAMES",
    "MAX_FINALIZED_SOURCE_BYTES",
    "MAX_FRAGMENT_BYTES",
    "MAX_FRAGMENT_DURATION_NS",
    "MAX_PENDING_WINDOWS",
    "MAX_RETENTION_NS",
    "MAX_RING_BYTES",
    "MAX_WINDOW_ROLL_NS",
    "CaptureBoundaryKind",
    "CaptureContractError",
    "CaptureDropNotice",
    "CaptureDropReason",
    "CaptureFragmentDescriptor",
    "CaptureFrameSignal",
    "CaptureSegmentIntegrityReport",
    "CaptureSessionDescriptor",
    "CaptureSourceKind",
    "CaptureStreamBoundary",
    "CaptureTraceRecord",
    "CaptureTrustDomain",
    "EvidenceWindowPlan",
    "EvidenceWindowRequest",
    "EvidenceWindowStatus",
    "ExposurePolicy",
    "FinalizedSourceFrameSignal",
    "IntegrityDisposition",
    "IntegrityFinding",
    "IntegrityFindingKind",
    "WindowRequestOrigin",
    "decode_capture_trace_record",
    "encode_capture_trace_record",
]
