"""Immutable capture and perception contracts.

Scoring-domain events, policy assessments, and authorization deliberately live
in separate modules so inference objects cannot acquire mutation authority.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Any, Mapping

from . import domain_events as _domain_events


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ASCII_TOKEN_RE = re.compile(r"^[\x21-\x7e]+$")
_MAX_JSON_DEPTH = 16
_MAX_JSON_NODES = 4_096
_MAX_JSON_CONTAINER_ITEMS = 1_024
_MAX_JSON_ESTIMATED_BYTES = 64 * 1_024
_MAX_JSON_KEY_BYTES = 128
_MAX_JSON_STRING_BYTES = 4_096


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze(item) for item in value)
    return value


def _require_sha256(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")


def _require_ascii_token(
    value: object,
    field_name: str,
    *,
    maximum: int = _domain_events.MAX_ID_LENGTH,
) -> str:
    if (
        type(value) is not str
        or len(value) > maximum
        or _ASCII_TOKEN_RE.fullmatch(value) is None
    ):
        raise ValueError(
            f"{field_name} must be printable non-whitespace ASCII of at most "
            f"{maximum} characters"
        )
    return value


def _validate_json_value(value: Any, path: str = "payload") -> None:
    stack: list[tuple[Any, str, int]] = [(value, path, 0)]
    seen_containers: set[int] = set()
    nodes = 0
    estimated_bytes = 0
    while stack:
        item, item_path, depth = stack.pop()
        nodes += 1
        if nodes > _MAX_JSON_NODES:
            raise ValueError(f"{path} exceeds the {_MAX_JSON_NODES}-node limit")
        if type(item) is dict:
            if depth >= _MAX_JSON_DEPTH:
                raise ValueError(f"{path} exceeds depth {_MAX_JSON_DEPTH}")
            if len(item) > _MAX_JSON_CONTAINER_ITEMS:
                raise ValueError(f"{item_path} contains too many object fields")
            identity = id(item)
            if identity in seen_containers:
                raise ValueError(f"{item_path} contains a cycle or reused container")
            seen_containers.add(identity)
            estimated_bytes += 2
            for key, child in item.items():
                _require_ascii_token(
                    key,
                    f"{item_path} object key",
                    maximum=_MAX_JSON_KEY_BYTES,
                )
                estimated_bytes += len(key.encode("ascii")) + 4
                stack.append((child, f"{item_path}.{key}", depth + 1))
        elif type(item) in (list, tuple):
            if depth >= _MAX_JSON_DEPTH:
                raise ValueError(f"{path} exceeds depth {_MAX_JSON_DEPTH}")
            if len(item) > _MAX_JSON_CONTAINER_ITEMS:
                raise ValueError(f"{item_path} contains too many array items")
            identity = id(item)
            if identity in seen_containers:
                raise ValueError(f"{item_path} contains a cycle or reused container")
            seen_containers.add(identity)
            estimated_bytes += 2
            for index, child in enumerate(item):
                stack.append((child, f"{item_path}[{index}]", depth + 1))
        elif type(item) is str:
            try:
                encoded = item.encode("utf-8", errors="strict")
            except UnicodeEncodeError as exc:
                raise ValueError(f"{item_path} is not valid UTF-8") from exc
            if len(encoded) > _MAX_JSON_STRING_BYTES:
                raise ValueError(f"{item_path} string is too long")
            estimated_bytes += len(encoded) + 2
        elif item is None or type(item) is bool:
            estimated_bytes += 5
        elif type(item) is int:
            if not -_domain_events.MAX_SEQUENCE_NUMBER <= item <= _domain_events.MAX_SEQUENCE_NUMBER:
                raise ValueError(f"{item_path} integer exceeds signed 64-bit bounds")
            estimated_bytes += 20
        elif type(item) is float and math.isfinite(item):
            estimated_bytes += 32
        else:
            raise ValueError(
                f"{item_path} must contain only finite JSON-compatible values"
            )
        if estimated_bytes > _MAX_JSON_ESTIMATED_BYTES:
            raise ValueError(
                f"{path} exceeds the {_MAX_JSON_ESTIMATED_BYTES}-byte budget"
            )


def _is_finite_number(value: Any) -> bool:
    if type(value) is int:
        return (
            -_domain_events.MAX_SEQUENCE_NUMBER
            <= value
            <= _domain_events.MAX_SEQUENCE_NUMBER
        )
    return type(value) is float and math.isfinite(value)


def _is_bounded_ascii_tuple(
    value: Any,
    *,
    maximum_items: int,
    maximum_length: int,
) -> bool:
    return (
        type(value) is tuple
        and len(value) <= maximum_items
        and all(
            type(item) is str
            and len(item) <= maximum_length
            and _ASCII_TOKEN_RE.fullmatch(item) is not None
            for item in value
        )
    )


class ObservationType(str, Enum):
    BALL = "BALL"
    PERSON = "PERSON"
    POSE = "POSE"
    COURT_LINE = "COURT_LINE"
    AUDIO_EVENT = "AUDIO_EVENT"
    REF_SIGNAL = "REF_SIGNAL"


class Visibility(str, Enum):
    VISIBLE = "VISIBLE"
    PARTIAL = "PARTIAL"
    OCCLUDED = "OCCLUDED"
    BLUR_ONLY = "BLUR_ONLY"
    ABSENT = "ABSENT"


class CalibrationState(str, Enum):
    LOCKED = "LOCKED"
    SUSPECT = "SUSPECT"
    FAILED = "FAILED"


@dataclass(frozen=True, slots=True)
class ModelProvenance:
    model_id: str
    model_version: str
    weights_sha256: str
    runtime_engine_id: str
    causal_cutoff_timestamp_ns: int

    def __post_init__(self) -> None:
        for field_name in ("model_id", "model_version", "runtime_engine_id"):
            _require_ascii_token(getattr(self, field_name), field_name)
        _require_sha256(self.weights_sha256, "weights_sha256")
        if (
            type(self.causal_cutoff_timestamp_ns) is not int
            or not 0
            <= self.causal_cutoff_timestamp_ns
            <= _domain_events.MAX_SEQUENCE_NUMBER
        ):
            raise ValueError(
                "causal_cutoff_timestamp_ns must be a non-negative signed 64-bit integer"
            )


@dataclass(frozen=True, slots=True)
class FramePacket:
    stream_id: str
    sequence_number: int
    capture_timestamp_ns: int
    receive_timestamp_ns: int
    pts: int
    dts: int
    duration_ns: int
    source_width: int
    source_height: int
    codec_profile: str
    keyframe: bool
    duplicate: bool
    dropped_before: int
    decode_corrupt: bool
    content_sha256: str
    calibration_segment_id: str

    def __post_init__(self) -> None:
        for field_name in (
            "stream_id",
            "codec_profile",
            "calibration_segment_id",
        ):
            _require_ascii_token(getattr(self, field_name), field_name)
        integer_fields = (
            self.sequence_number,
            self.capture_timestamp_ns,
            self.receive_timestamp_ns,
            self.pts,
            self.dts,
            self.duration_ns,
            self.source_width,
            self.source_height,
            self.dropped_before,
        )
        if any(type(value) is not int for value in integer_fields):
            raise ValueError("frame counters, timestamps, dimensions, and PTS/DTS must be integers")
        if any(
            not -_domain_events.MAX_SEQUENCE_NUMBER
            <= value
            <= _domain_events.MAX_SEQUENCE_NUMBER
            for value in integer_fields
        ):
            raise ValueError("frame integer fields must fit signed 64-bit bounds")
        if any(type(value) is not bool for value in (self.keyframe, self.duplicate, self.decode_corrupt)):
            raise ValueError("frame health flags must be booleans")
        if self.sequence_number < 0:
            raise ValueError("sequence_number cannot be negative")
        if self.capture_timestamp_ns < 0 or self.receive_timestamp_ns < 0:
            raise ValueError("timestamps cannot be negative")
        if self.receive_timestamp_ns < self.capture_timestamp_ns:
            raise ValueError("receive timestamp cannot precede capture timestamp")
        if self.duration_ns <= 0:
            raise ValueError("duration_ns must be positive")
        if (
            not 1 <= self.source_width <= 65_536
            or not 1 <= self.source_height <= 65_536
        ):
            raise ValueError("source dimensions must be positive")
        if self.dropped_before < 0:
            raise ValueError("dropped_before cannot be negative")
        _require_sha256(self.content_sha256, "content_sha256")

    @property
    def scoring_healthy(self) -> bool:
        return not self.duplicate and not self.decode_corrupt and self.dropped_before == 0


@dataclass(frozen=True, slots=True)
class CalibrationSegment:
    calibration_segment_id: str
    valid_from_timestamp_ns: int
    valid_to_timestamp_ns: int | None
    intrinsics: tuple[tuple[float, float, float], ...]
    distortion_model: str
    distortion_coefficients: tuple[float, ...]
    camera_rotation: tuple[float, ...]
    camera_translation: tuple[float, float, float]
    court_homography: tuple[tuple[float, float, float], ...]
    survey_geometry_version: str
    median_reprojection_px: float
    p95_reprojection_px: float
    boundary_error_cm: float | None
    drift_state: CalibrationState
    evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in (
            "calibration_segment_id",
            "distortion_model",
            "survey_geometry_version",
        ):
            _require_ascii_token(getattr(self, field_name), field_name)
        if type(self.valid_from_timestamp_ns) is not int or (
            self.valid_to_timestamp_ns is not None
            and type(self.valid_to_timestamp_ns) is not int
        ):
            raise ValueError("calibration validity timestamps must be integers")
        if not isinstance(self.drift_state, CalibrationState):
            raise ValueError("drift_state must be a CalibrationState")
        if not _is_bounded_ascii_tuple(
            self.evidence_refs,
            maximum_items=_domain_events.MAX_EVIDENCE_REFS,
            maximum_length=_domain_events.MAX_EVIDENCE_REF_LENGTH,
        ):
            raise ValueError("evidence_refs must be a bounded ASCII tuple")
        if self.valid_from_timestamp_ns < 0:
            raise ValueError("valid_from_timestamp_ns cannot be negative")
        if (
            self.valid_to_timestamp_ns is not None
            and self.valid_to_timestamp_ns <= self.valid_from_timestamp_ns
        ):
            raise ValueError("calibration validity interval is invalid")
        if self.valid_from_timestamp_ns > _domain_events.MAX_SEQUENCE_NUMBER or (
            self.valid_to_timestamp_ns is not None
            and self.valid_to_timestamp_ns > _domain_events.MAX_SEQUENCE_NUMBER
        ):
            raise ValueError("calibration validity timestamps exceed signed 64-bit bounds")
        if (
            not isinstance(self.intrinsics, tuple)
            or len(self.intrinsics) != 3
            or any(not isinstance(row, tuple) or len(row) != 3 for row in self.intrinsics)
            or any(not _is_finite_number(value) for row in self.intrinsics for value in row)
        ):
            raise ValueError("intrinsics must be 3x3")
        if (
            not isinstance(self.court_homography, tuple)
            or len(self.court_homography) != 3
            or any(
                not isinstance(row, tuple) or len(row) != 3 for row in self.court_homography
            )
            or any(
                not _is_finite_number(value)
                for row in self.court_homography
                for value in row
            )
        ):
            raise ValueError("court_homography must be 3x3")
        for name, values in (
            ("distortion_coefficients", self.distortion_coefficients),
            ("camera_rotation", self.camera_rotation),
            ("camera_translation", self.camera_translation),
        ):
            if (
                not isinstance(values, tuple)
                or not values
                or len(values) > 64
                or any(
                not _is_finite_number(value) for value in values
                )
            ):
                raise ValueError(f"{name} must be a non-empty tuple of finite numbers")
        if len(self.camera_translation) != 3:
            raise ValueError("camera_translation must contain exactly three values")
        if any(
            not _is_finite_number(value)
            for value in (self.median_reprojection_px, self.p95_reprojection_px)
        ) or self.median_reprojection_px < 0 or self.p95_reprojection_px < self.median_reprojection_px:
            raise ValueError("reprojection errors cannot be negative")
        if self.boundary_error_cm is not None and (
            not _is_finite_number(self.boundary_error_cm) or self.boundary_error_cm < 0
        ):
            raise ValueError("boundary_error_cm must be a finite nonnegative number")


@dataclass(frozen=True, slots=True)
class Observation:
    observation_id: str
    observation_type: ObservationType
    stream_id: str
    calibration_segment_id: str
    frame_sequence: int
    timestamp_ns: int
    source_geometry: Mapping[str, Any]
    undistorted_geometry: Mapping[str, Any]
    court_geometry: Mapping[str, Any] | None
    covariance: tuple[float, ...] | None
    visibility: Visibility
    quality_flags: tuple[str, ...]
    provenance: ModelProvenance

    def __post_init__(self) -> None:
        for field_name in (
            "observation_id",
            "stream_id",
            "calibration_segment_id",
        ):
            _require_ascii_token(getattr(self, field_name), field_name)
        if not isinstance(self.observation_type, ObservationType) or not isinstance(
            self.visibility, Visibility
        ):
            raise ValueError("observation_type and visibility must use their declared enums")
        if not isinstance(self.provenance, ModelProvenance):
            raise ValueError("provenance must be ModelProvenance")
        if type(self.frame_sequence) is not int or type(self.timestamp_ns) is not int:
            raise ValueError("observation frame sequence and timestamp must be integers")
        if not 0 <= self.frame_sequence <= _domain_events.MAX_SEQUENCE_NUMBER or not (
            0 <= self.timestamp_ns <= _domain_events.MAX_SEQUENCE_NUMBER
        ):
            raise ValueError(
                "observation sequence and timestamp must be non-negative signed 64-bit integers"
            )
        if self.provenance.causal_cutoff_timestamp_ns > self.timestamp_ns:
            raise ValueError("an observation cannot depend on future evidence")
        for name, geometry in (
            ("source_geometry", self.source_geometry),
            ("undistorted_geometry", self.undistorted_geometry),
        ):
            if type(geometry) is not dict:
                raise ValueError(f"{name} must be an exact dict")
            _validate_json_value(geometry, name)
        if self.court_geometry is not None:
            if type(self.court_geometry) is not dict:
                raise ValueError("court_geometry must be an exact dict when present")
            _validate_json_value(self.court_geometry, "court_geometry")
        if self.covariance is not None and (
            not isinstance(self.covariance, tuple)
            or len(self.covariance) > 256
            or any(not _is_finite_number(value) for value in self.covariance)
        ):
            raise ValueError("covariance must be a tuple of finite numbers when present")
        if not _is_bounded_ascii_tuple(
            self.quality_flags,
            maximum_items=64,
            maximum_length=128,
        ):
            raise ValueError("quality_flags must be a bounded ASCII tuple")
        object.__setattr__(self, "source_geometry", _freeze(self.source_geometry))
        object.__setattr__(self, "undistorted_geometry", _freeze(self.undistorted_geometry))
        if self.court_geometry is not None:
            object.__setattr__(self, "court_geometry", _freeze(self.court_geometry))
        object.__setattr__(self, "quality_flags", tuple(self.quality_flags))


@dataclass(frozen=True, slots=True)
class EventProposal:
    proposal_id: str
    rally_id: str
    event_type: str
    time_interval_ns: tuple[int, int]
    class_probabilities: Mapping[str, float]
    team_probabilities: Mapping[_domain_events.Team, float]
    player_probabilities: Mapping[str, float]
    evidence_refs: tuple[str, ...]
    model_versions: tuple[str, ...]
    capture_health: Mapping[str, Any]
    blockers: tuple[str, ...] = ()
    abstained: bool = False

    def __post_init__(self) -> None:
        for field_name in ("proposal_id", "rally_id", "event_type"):
            _require_ascii_token(getattr(self, field_name), field_name)
        if (
            not isinstance(self.time_interval_ns, tuple)
            or len(self.time_interval_ns) != 2
            or any(type(value) is not int for value in self.time_interval_ns)
        ):
            raise ValueError("event proposal interval must be a two-integer tuple")
        start, end = self.time_interval_ns
        if (
            start < 0
            or end < start
            or end > _domain_events.MAX_SEQUENCE_NUMBER
        ):
            raise ValueError("event proposal interval is invalid")
        for name, probabilities, maximum_items in (
            ("class_probabilities", self.class_probabilities, 256),
            ("team_probabilities", self.team_probabilities, 2),
            ("player_probabilities", self.player_probabilities, 64),
        ):
            if type(probabilities) is not dict:
                raise ValueError(f"{name} must be an exact dict")
            if len(probabilities) > maximum_items:
                raise ValueError(f"{name} contains too many entries")
            if any(
                not _is_finite_number(probability)
                or probability < 0
                or probability > 1
                for probability in probabilities.values()
            ):
                raise ValueError(f"{name} values must be finite numbers in [0, 1]")
        for key in self.class_probabilities:
            _require_ascii_token(key, "class_probabilities key")
        if any(
            not isinstance(key, _domain_events.Team)
            for key in self.team_probabilities
        ):
            raise ValueError("team_probabilities keys must be Team values")
        for key in self.player_probabilities:
            _require_ascii_token(key, "player_probabilities key")
        for name, values, maximum_items, maximum_length in (
            (
                "evidence_refs",
                self.evidence_refs,
                _domain_events.MAX_EVIDENCE_REFS,
                _domain_events.MAX_EVIDENCE_REF_LENGTH,
            ),
            ("model_versions", self.model_versions, 32, 128),
            ("blockers", self.blockers, 64, 128),
        ):
            if not _is_bounded_ascii_tuple(
                values,
                maximum_items=maximum_items,
                maximum_length=maximum_length,
            ):
                raise ValueError(f"{name} must be a bounded ASCII tuple")
        if type(self.capture_health) is not dict:
            raise ValueError("capture_health must be an exact dict")
        _validate_json_value(self.capture_health, "capture_health")
        if not isinstance(self.abstained, bool):
            raise ValueError("abstained must be a boolean")
        object.__setattr__(self, "class_probabilities", _freeze(self.class_probabilities))
        object.__setattr__(self, "team_probabilities", _freeze(self.team_probabilities))
        object.__setattr__(self, "player_probabilities", _freeze(self.player_probabilities))
        object.__setattr__(self, "capture_health", _freeze(self.capture_health))
        object.__setattr__(self, "evidence_refs", tuple(self.evidence_refs))
        object.__setattr__(self, "model_versions", tuple(self.model_versions))
        object.__setattr__(self, "blockers", tuple(self.blockers))
