"""Immutable contracts at the perception-to-rules safety boundary."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Mapping


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_thaw(item) for item in value]
    if isinstance(value, (set, frozenset)):
        thawed = [_thaw(item) for item in value]
        return sorted(thawed, key=lambda item: json.dumps(item, sort_keys=True))
    if isinstance(value, Enum):
        return value.value
    return value


def _require_sha256(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")


def _validate_json_value(value: Any, path: str = "payload") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} object keys must be strings")
            _validate_json_value(item, f"{path}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _validate_json_value(item, f"{path}[{index}]")
        return
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float) and math.isfinite(value):
        return
    raise ValueError(f"{path} must contain only finite JSON-compatible values")


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _is_nonempty_string_tuple(value: Any) -> bool:
    return isinstance(value, tuple) and all(
        isinstance(item, str) and item.strip() for item in value
    )


class Team(str, Enum):
    A = "A"
    B = "B"

    @property
    def other(self) -> "Team":
        return Team.B if self is Team.A else Team.A


class Authority(str, Enum):
    AUTO_POLICY = "AUTO_POLICY"
    OPERATOR = "OPERATOR"
    REFEREE_FEED = "REFEREE_FEED"
    SCOREKEEPER = "SCOREKEEPER"
    IMPORT = "IMPORT"


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


class DecisionState(str, Enum):
    AUTO_CONFIRM = "AUTO_CONFIRM"
    PENDING = "PENDING"
    REVIEW = "REVIEW"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    UNRESOLVED = "UNRESOLVED"


class ConfirmationMode(str, Enum):
    SERVER_CHANGE = "SERVER_CHANGE"
    DIRECT_PROVISIONAL = "DIRECT_PROVISIONAL"
    HUMAN = "HUMAN"
    REFEREE_FEED = "REFEREE_FEED"


class RuleEventType(str, Enum):
    SET_SEED = "SET_SEED"
    POINT_AWARDED = "POINT_AWARDED"
    PENALTY_POINT = "PENALTY_POINT"
    SERVICE_ORDER_FAULT = "SERVICE_ORDER_FAULT"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    SIDE_SWITCH_CONFIRMED = "SIDE_SWITCH_CONFIRMED"
    TECHNICAL_TIMEOUT_COMPLETED = "TECHNICAL_TIMEOUT_COMPLETED"
    SCORE_CORRECTION = "SCORE_CORRECTION"


@dataclass(frozen=True, slots=True)
class ModelProvenance:
    model_id: str
    model_version: str
    weights_sha256: str
    runtime_engine_id: str
    causal_cutoff_timestamp_ns: int

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.model_id, self.model_version, self.runtime_engine_id)
        ):
            raise ValueError("model provenance fields cannot be empty")
        _require_sha256(self.weights_sha256, "weights_sha256")
        if type(self.causal_cutoff_timestamp_ns) is not int or self.causal_cutoff_timestamp_ns < 0:
            raise ValueError("causal_cutoff_timestamp_ns cannot be negative")


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
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.stream_id, self.codec_profile, self.calibration_segment_id)
        ):
            raise ValueError("frame stream, codec, and calibration ids are required")
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
        if self.source_width <= 0 or self.source_height <= 0:
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
        if not all(
            isinstance(value, str) and value.strip()
            for value in (
                self.calibration_segment_id,
                self.distortion_model,
                self.survey_geometry_version,
            )
        ):
            raise ValueError("calibration identity, model, and survey version are required")
        if type(self.valid_from_timestamp_ns) is not int or (
            self.valid_to_timestamp_ns is not None
            and type(self.valid_to_timestamp_ns) is not int
        ):
            raise ValueError("calibration validity timestamps must be integers")
        if not isinstance(self.drift_state, CalibrationState):
            raise ValueError("drift_state must be a CalibrationState")
        if not _is_nonempty_string_tuple(self.evidence_refs):
            raise ValueError("evidence_refs must be a tuple of non-empty strings")
        if self.valid_from_timestamp_ns < 0:
            raise ValueError("valid_from_timestamp_ns cannot be negative")
        if (
            self.valid_to_timestamp_ns is not None
            and self.valid_to_timestamp_ns <= self.valid_from_timestamp_ns
        ):
            raise ValueError("calibration validity interval is invalid")
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
            if not isinstance(values, tuple) or not values or any(
                not _is_finite_number(value) for value in values
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
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.observation_id, self.stream_id, self.calibration_segment_id)
        ):
            raise ValueError("observation, stream, and calibration ids are required")
        if not isinstance(self.observation_type, ObservationType) or not isinstance(
            self.visibility, Visibility
        ):
            raise ValueError("observation_type and visibility must use their declared enums")
        if not isinstance(self.provenance, ModelProvenance):
            raise ValueError("provenance must be ModelProvenance")
        if type(self.frame_sequence) is not int or type(self.timestamp_ns) is not int:
            raise ValueError("observation frame sequence and timestamp must be integers")
        if self.frame_sequence < 0 or self.timestamp_ns < 0:
            raise ValueError("observation sequence and timestamp cannot be negative")
        if self.provenance.causal_cutoff_timestamp_ns > self.timestamp_ns:
            raise ValueError("an observation cannot depend on future evidence")
        for name, geometry in (
            ("source_geometry", self.source_geometry),
            ("undistorted_geometry", self.undistorted_geometry),
        ):
            if not isinstance(geometry, Mapping):
                raise ValueError(f"{name} must be a mapping")
            _validate_json_value(geometry, name)
        if self.court_geometry is not None:
            if not isinstance(self.court_geometry, Mapping):
                raise ValueError("court_geometry must be a mapping when present")
            _validate_json_value(self.court_geometry, "court_geometry")
        if self.covariance is not None and (
            not isinstance(self.covariance, tuple)
            or any(not _is_finite_number(value) for value in self.covariance)
        ):
            raise ValueError("covariance must be a tuple of finite numbers when present")
        if not _is_nonempty_string_tuple(self.quality_flags):
            raise ValueError("quality_flags must be a tuple of non-empty strings")
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
    team_probabilities: Mapping[Team, float]
    player_probabilities: Mapping[str, float]
    evidence_refs: tuple[str, ...]
    model_versions: tuple[str, ...]
    capture_health: Mapping[str, Any]
    blockers: tuple[str, ...] = ()
    abstained: bool = False

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.proposal_id, self.rally_id, self.event_type)
        ):
            raise ValueError("proposal identity and event_type are required")
        if (
            not isinstance(self.time_interval_ns, tuple)
            or len(self.time_interval_ns) != 2
            or any(type(value) is not int for value in self.time_interval_ns)
        ):
            raise ValueError("event proposal interval must be a two-integer tuple")
        start, end = self.time_interval_ns
        if start < 0 or end < start:
            raise ValueError("event proposal interval is invalid")
        for name, probabilities in (
            ("class_probabilities", self.class_probabilities),
            ("team_probabilities", self.team_probabilities),
            ("player_probabilities", self.player_probabilities),
        ):
            if not isinstance(probabilities, Mapping):
                raise ValueError(f"{name} must be a mapping")
            if any(
                not isinstance(probability, (int, float))
                or isinstance(probability, bool)
                or not math.isfinite(probability)
                or probability < 0
                or probability > 1
                for probability in probabilities.values()
            ):
                raise ValueError(f"{name} values must be finite numbers in [0, 1]")
        if any(not isinstance(key, str) or not key.strip() for key in self.class_probabilities):
            raise ValueError("class_probabilities keys must be non-empty strings")
        if any(not isinstance(key, Team) for key in self.team_probabilities):
            raise ValueError("team_probabilities keys must be Team values")
        if any(not isinstance(key, str) or not key.strip() for key in self.player_probabilities):
            raise ValueError("player_probabilities keys must be non-empty strings")
        for name, values in (
            ("evidence_refs", self.evidence_refs),
            ("model_versions", self.model_versions),
            ("blockers", self.blockers),
        ):
            if not isinstance(values, tuple) or any(
                not isinstance(value, str) or not value.strip() for value in values
            ):
                raise ValueError(f"{name} must be a tuple of non-empty strings")
        if not isinstance(self.capture_health, Mapping):
            raise ValueError("capture_health must be a mapping")
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


@dataclass(frozen=True, slots=True)
class RallyDecision:
    decision_id: str
    match_id: str
    rally_id: str
    set_number: int
    ruleset_id: str
    ruleset_version: str
    state: DecisionState
    proposed_winner_team: Team | None
    confirmation_mode: ConfirmationMode | None
    calibrated_probability: float | None
    coverage_policy_version: str
    causal_cutoff_timestamp_ns: int
    blocking_reasons: tuple[str, ...]
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.state, DecisionState):
            raise ValueError("state must be a DecisionState")
        if self.proposed_winner_team is not None and not isinstance(
            self.proposed_winner_team, Team
        ):
            raise ValueError("proposed_winner_team must be Team A or B when present")
        if self.confirmation_mode is not None and not isinstance(
            self.confirmation_mode, ConfirmationMode
        ):
            raise ValueError("confirmation_mode must use the declared enum when present")
        if not all(
            isinstance(value, str) and value.strip()
            for value in (
                self.decision_id,
                self.match_id,
                self.rally_id,
                self.ruleset_id,
                self.ruleset_version,
                self.coverage_policy_version,
            )
        ):
            raise ValueError("decision identity and version fields are required")
        if (
            type(self.set_number) is not int
            or self.set_number <= 0
            or type(self.causal_cutoff_timestamp_ns) is not int
            or self.causal_cutoff_timestamp_ns < 0
        ):
            raise ValueError("decision set number and causal cutoff are invalid")
        if self.calibrated_probability is not None and (
            not isinstance(self.calibrated_probability, (int, float))
            or isinstance(self.calibrated_probability, bool)
            or not math.isfinite(self.calibrated_probability)
            or not 0 <= self.calibrated_probability <= 1
        ):
            raise ValueError("calibrated_probability must be a finite number in [0, 1]")
        if not isinstance(self.blocking_reasons, tuple) or any(
            not isinstance(reason, str) or not reason.strip() for reason in self.blocking_reasons
        ):
            raise ValueError("blocking_reasons must be a tuple of non-empty strings")
        if not isinstance(self.evidence_refs, tuple) or any(
            not isinstance(reference, str) or not reference.strip()
            for reference in self.evidence_refs
        ):
            raise ValueError("evidence_refs must be a tuple of non-empty strings")
        object.__setattr__(self, "blocking_reasons", tuple(self.blocking_reasons))
        object.__setattr__(self, "evidence_refs", tuple(self.evidence_refs))
        if self.state is DecisionState.AUTO_CONFIRM:
            if self.proposed_winner_team is None or self.confirmation_mode is None:
                raise ValueError("AUTO_CONFIRM requires a winner and confirmation mode")
            if self.blocking_reasons:
                raise ValueError("AUTO_CONFIRM cannot contain blockers")
            if not self.evidence_refs:
                raise ValueError("AUTO_CONFIRM requires evidence")
            if self.calibrated_probability is None:
                raise ValueError("AUTO_CONFIRM requires a calibrated probability")
            if self.confirmation_mode is not ConfirmationMode.SERVER_CHANGE:
                raise ValueError("AUTO_CONFIRM requires an automatic confirmation mode")
        elif self.state is DecisionState.REPLAY_NO_POINT:
            if self.proposed_winner_team is not None or self.confirmation_mode is not None:
                raise ValueError("REPLAY_NO_POINT cannot contain a winner or confirmation mode")
            if not self.evidence_refs:
                raise ValueError("REPLAY_NO_POINT requires evidence")
        elif self.state is DecisionState.UNRESOLVED:
            if self.proposed_winner_team is not None or self.confirmation_mode is not None:
                raise ValueError("UNRESOLVED cannot contain a winner or confirmation mode")
            if not self.blocking_reasons:
                raise ValueError("UNRESOLVED requires a blocking reason")
            if self.calibrated_probability is not None:
                raise ValueError("UNRESOLVED cannot carry a calibrated winner probability")
        elif self.state is DecisionState.REVIEW:
            if not self.evidence_refs or not self.blocking_reasons:
                raise ValueError("REVIEW requires evidence and a review reason")
            if self.proposed_winner_team is None:
                if self.confirmation_mode is not None or self.calibrated_probability is not None:
                    raise ValueError("winnerless REVIEW cannot carry a mode or winner probability")
            elif (
                self.confirmation_mode is not ConfirmationMode.DIRECT_PROVISIONAL
                or self.calibrated_probability is None
            ):
                raise ValueError("winner-bearing REVIEW requires a provisional mode and probability")
        elif self.state is DecisionState.PENDING:
            if self.blocking_reasons:
                raise ValueError("PENDING cannot contain terminal blocking reasons")
            if self.proposed_winner_team is None:
                if self.confirmation_mode is not None or self.calibrated_probability is not None:
                    raise ValueError("winnerless PENDING cannot carry a mode or winner probability")
            elif (
                self.confirmation_mode is not ConfirmationMode.DIRECT_PROVISIONAL
                or self.calibrated_probability is None
                or not self.evidence_refs
            ):
                raise ValueError(
                    "winner-bearing PENDING requires provisional mode, probability, and evidence"
                )


@dataclass(frozen=True, slots=True)
class RuleEvent:
    event_id: str
    sequence_number: int
    match_id: str
    set_number: int
    event_type: RuleEventType
    authority: Authority
    actor_id: str
    authorization_id: str
    ruleset_id: str
    ruleset_version: str
    ruleset_fingerprint: str
    payload: Mapping[str, Any]
    reason: str
    schema_version: str = "1.0"
    decision_id: str | None = None
    policy_version: str | None = None
    related_rally_id: str | None = None
    evidence_refs: tuple[str, ...] = field(default_factory=tuple)
    created_at_ns: int = 0
    supersedes_event_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.event_type, RuleEventType) or not isinstance(
            self.authority, Authority
        ):
            raise ValueError("event_type and authority must use their declared enums")
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.event_id, self.match_id, self.actor_id, self.authorization_id)
        ):
            raise ValueError("event, match, actor, and authorization ids cannot be empty")
        if (
            type(self.sequence_number) is not int
            or self.sequence_number <= 0
            or type(self.set_number) is not int
            or self.set_number <= 0
        ):
            raise ValueError("event and set sequence numbers must be positive")
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.ruleset_id, self.ruleset_version)
        ):
            raise ValueError("ruleset identity and version are required")
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("reason and schema_version are required")
        if not isinstance(self.schema_version, str) or not self.schema_version.strip():
            raise ValueError("reason and schema_version are required")
        if self.schema_version != "1.0":
            raise ValueError("unsupported rule-event schema version")
        _require_sha256(self.ruleset_fingerprint, "ruleset_fingerprint")
        if not isinstance(self.payload, Mapping):
            raise ValueError("rule-event payload must be a mapping")
        _validate_json_value(self.payload)
        if type(self.created_at_ns) is not int or self.created_at_ns <= 0:
            raise ValueError("created_at_ns must be positive")
        if not isinstance(self.evidence_refs, tuple):
            raise ValueError("evidence_refs must be a tuple")
        object.__setattr__(self, "payload", _freeze(self.payload))
        object.__setattr__(self, "evidence_refs", tuple(self.evidence_refs))
        if any(not isinstance(reference, str) or not reference.strip() for reference in self.evidence_refs):
            raise ValueError("evidence_refs must contain non-empty strings")
        if self.related_rally_id is not None and (
            not isinstance(self.related_rally_id, str) or not self.related_rally_id.strip()
        ):
            raise ValueError("related_rally_id must be a non-empty string when present")
        if self.supersedes_event_id is not None and (
            not isinstance(self.supersedes_event_id, str) or not self.supersedes_event_id.strip()
        ):
            raise ValueError("supersedes_event_id must be a non-empty string when present")
        if self.authority is Authority.AUTO_POLICY:
            if (
                not isinstance(self.decision_id, str)
                or not self.decision_id.strip()
                or not isinstance(self.policy_version, str)
                or not self.policy_version.strip()
                or not self.evidence_refs
            ):
                raise ValueError(
                    "AUTO_POLICY events require decision, policy, and immutable evidence references"
                )
        elif self.decision_id is not None or self.policy_version is not None:
            raise ValueError("decision_id and policy_version are reserved for AUTO_POLICY events")

    def fingerprint(self) -> str:
        canonical = {
            "event_id": self.event_id,
            "sequence_number": self.sequence_number,
            "match_id": self.match_id,
            "set_number": self.set_number,
            "event_type": self.event_type.value,
            "authority": self.authority.value,
            "actor_id": self.actor_id,
            "authorization_id": self.authorization_id,
            "ruleset_id": self.ruleset_id,
            "ruleset_version": self.ruleset_version,
            "ruleset_fingerprint": self.ruleset_fingerprint,
            "payload": _thaw(self.payload),
            "reason": self.reason,
            "schema_version": self.schema_version,
            "decision_id": self.decision_id,
            "policy_version": self.policy_version,
            "related_rally_id": self.related_rally_id,
            "evidence_refs": list(self.evidence_refs),
            "created_at_ns": self.created_at_ns,
            "supersedes_event_id": self.supersedes_event_id,
        }
        encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
