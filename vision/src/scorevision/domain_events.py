"""Typed, immutable rule-event contracts and bounded JSON interchange."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, TypeAlias


RULE_EVENT_SCHEMA_VERSION = "2.0"
MAX_RAW_EVENT_BYTES = 64 * 1024
MAX_JSON_DEPTH = 32
MAX_ID_LENGTH = 128
MAX_REASON_LENGTH = 512
MAX_EVIDENCE_REF_LENGTH = 256
MAX_EVIDENCE_REFS = 64
MAX_SEQUENCE_NUMBER = (1 << 63) - 1
MAX_SET_NUMBER = 99

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ContractErrorCode(str, Enum):
    RAW_TYPE = "RAW_TYPE"
    RAW_TOO_LARGE = "RAW_TOO_LARGE"
    INVALID_UTF8 = "INVALID_UTF8"
    INVALID_JSON = "INVALID_JSON"
    JSON_DEPTH_EXCEEDED = "JSON_DEPTH_EXCEEDED"
    DUPLICATE_KEY = "DUPLICATE_KEY"
    TOP_LEVEL_TYPE = "TOP_LEVEL_TYPE"
    FIELD_SET = "FIELD_SET"
    FIELD_TYPE = "FIELD_TYPE"
    FIELD_VALUE = "FIELD_VALUE"
    FIELD_ASCII = "FIELD_ASCII"
    FIELD_BOUNDS = "FIELD_BOUNDS"
    UNSUPPORTED_SCHEMA = "UNSUPPORTED_SCHEMA"
    UNSUPPORTED_EVENT_TYPE = "UNSUPPORTED_EVENT_TYPE"
    PAYLOAD_EVENT_MISMATCH = "PAYLOAD_EVENT_MISMATCH"
    RELATIONSHIP_INVALID = "RELATIONSHIP_INVALID"


class ContractError(ValueError):
    """A stable, machine-classifiable domain-contract failure."""

    def __init__(self, code: ContractErrorCode | str, message: str) -> None:
        self.code = code.value if isinstance(code, ContractErrorCode) else code
        super().__init__(f"{self.code}: {message}")


class Team(str, Enum):
    A = "A"
    B = "B"

    @property
    def other(self) -> "Team":
        return Team.B if self is Team.A else Team.A


class CourtSide(str, Enum):
    NEAR = "NEAR"
    FAR = "FAR"


class RuleEventType(str, Enum):
    SET_SEED = "SET_SEED"
    POINT_AWARDED = "POINT_AWARDED"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    SIDE_SWITCH_CONFIRMED = "SIDE_SWITCH_CONFIRMED"
    TECHNICAL_TIMEOUT_COMPLETED = "TECHNICAL_TIMEOUT_COMPLETED"


def _error(code: ContractErrorCode, message: str) -> None:
    raise ContractError(code, message)


def _ascii_text(
    value: Any,
    name: str,
    *,
    maximum: int,
    spaces: bool = False,
) -> str:
    if not isinstance(value, str):
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be a string")
    if not value or len(value) > maximum or value != value.strip():
        _error(
            ContractErrorCode.FIELD_BOUNDS,
            f"{name} must contain 1..{maximum} characters without outer whitespace",
        )
    if not value.isascii():
        _error(ContractErrorCode.FIELD_ASCII, f"{name} must contain only ASCII")
    lower = 0x20 if spaces else 0x21
    if any(ord(character) < lower or ord(character) > 0x7E for character in value):
        _error(ContractErrorCode.FIELD_ASCII, f"{name} contains unsupported characters")
    return value


def _positive_int(value: Any, name: str, maximum: int) -> int:
    if type(value) is not int:
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be an integer")
    if value <= 0 or value > maximum:
        _error(ContractErrorCode.FIELD_BOUNDS, f"{name} is outside 1..{maximum}")
    return value


def _nonnegative_int(
    value: Any,
    name: str,
    maximum: int = MAX_SEQUENCE_NUMBER,
) -> int:
    if type(value) is not int:
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be an integer")
    if value < 0 or value > maximum:
        _error(ContractErrorCode.FIELD_BOUNDS, f"{name} is outside 0..{maximum}")
    return value


def _declared_enum(value: Any, enum_type: type[Enum], name: str) -> None:
    if not isinstance(value, enum_type):
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must use {enum_type.__name__}")


def _player_order(value: Any, name: str) -> tuple[str, str]:
    if not isinstance(value, tuple) or len(value) != 2:
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be a two-item tuple")
    first = _ascii_text(value[0], f"{name}[0]", maximum=MAX_ID_LENGTH)
    second = _ascii_text(value[1], f"{name}[1]", maximum=MAX_ID_LENGTH)
    if first == second:
        _error(ContractErrorCode.FIELD_VALUE, f"{name} player ids must be distinct")
    return first, second


def _evidence_refs(value: Any) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        _error(ContractErrorCode.FIELD_TYPE, "evidence_refs must be a tuple")
    if not 1 <= len(value) <= MAX_EVIDENCE_REFS:
        _error(
            ContractErrorCode.FIELD_BOUNDS,
            f"evidence_refs must contain 1..{MAX_EVIDENCE_REFS} entries",
        )
    validated = tuple(
        _ascii_text(
            reference,
            f"evidence_refs[{index}]",
            maximum=MAX_EVIDENCE_REF_LENGTH,
        )
        for index, reference in enumerate(value)
    )
    if len(set(validated)) != len(validated):
        _error(ContractErrorCode.FIELD_VALUE, "evidence_refs must be unique")
    return validated


@dataclass(frozen=True, slots=True)
class SetSeedPayload:
    service_order_a: tuple[str, str]
    service_order_b: tuple[str, str]
    serving_team: Team
    serving_player: str
    side_a: CourtSide
    side_b: CourtSide

    def __post_init__(self) -> None:
        order_a = _player_order(self.service_order_a, "service_order_a")
        order_b = _player_order(self.service_order_b, "service_order_b")
        if len(set(order_a + order_b)) != 4:
            _error(ContractErrorCode.FIELD_VALUE, "all four player ids must be distinct")
        _declared_enum(self.serving_team, Team, "serving_team")
        serving_player = _ascii_text(
            self.serving_player, "serving_player", maximum=MAX_ID_LENGTH
        )
        expected = order_a[0] if self.serving_team is Team.A else order_b[0]
        if serving_player != expected:
            _error(
                ContractErrorCode.FIELD_VALUE,
                "serving_player must be first in the serving team's order",
            )
        _declared_enum(self.side_a, CourtSide, "side_a")
        _declared_enum(self.side_b, CourtSide, "side_b")
        if self.side_a is self.side_b:
            _error(ContractErrorCode.FIELD_VALUE, "teams must occupy different sides")


@dataclass(frozen=True, slots=True)
class PointAwardedPayload:
    winner_team: Team
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _declared_enum(self.winner_team, Team, "winner_team")
        object.__setattr__(
            self,
            "evidence_refs",
            tuple(sorted(_evidence_refs(self.evidence_refs))),
        )


@dataclass(frozen=True, slots=True)
class ReplayNoPointPayload:
    reason: str
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _ascii_text(self.reason, "reason", maximum=MAX_REASON_LENGTH, spaces=True)
        object.__setattr__(
            self,
            "evidence_refs",
            tuple(sorted(_evidence_refs(self.evidence_refs))),
        )


@dataclass(frozen=True, slots=True)
class SideSwitchConfirmedPayload:
    due_total: int
    observed_at_total: int
    cleared_through_total: int
    observed_side_a: CourtSide
    observed_side_b: CourtSide
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _nonnegative_int(self.due_total, "due_total")
        _nonnegative_int(self.observed_at_total, "observed_at_total")
        _nonnegative_int(self.cleared_through_total, "cleared_through_total")
        _declared_enum(self.observed_side_a, CourtSide, "observed_side_a")
        _declared_enum(self.observed_side_b, CourtSide, "observed_side_b")
        if self.observed_side_a is self.observed_side_b:
            _error(ContractErrorCode.FIELD_VALUE, "observed sides must be distinct")
        object.__setattr__(
            self,
            "evidence_refs",
            tuple(sorted(_evidence_refs(self.evidence_refs))),
        )


@dataclass(frozen=True, slots=True)
class TechnicalTimeoutCompletedPayload:
    due_total: int
    observed_at_total: int
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _nonnegative_int(self.due_total, "due_total")
        _nonnegative_int(self.observed_at_total, "observed_at_total")
        object.__setattr__(
            self,
            "evidence_refs",
            tuple(sorted(_evidence_refs(self.evidence_refs))),
        )


RulePayload: TypeAlias = (
    SetSeedPayload
    | PointAwardedPayload
    | ReplayNoPointPayload
    | SideSwitchConfirmedPayload
    | TechnicalTimeoutCompletedPayload
)

_PAYLOAD_TYPE: dict[RuleEventType, type[RulePayload]] = {
    RuleEventType.SET_SEED: SetSeedPayload,
    RuleEventType.POINT_AWARDED: PointAwardedPayload,
    RuleEventType.REPLAY_NO_POINT: ReplayNoPointPayload,
    RuleEventType.SIDE_SWITCH_CONFIRMED: SideSwitchConfirmedPayload,
    RuleEventType.TECHNICAL_TIMEOUT_COMPLETED: TechnicalTimeoutCompletedPayload,
}


@dataclass(frozen=True, slots=True)
class RuleEvent:
    event_id: str
    sequence_number: int
    match_id: str
    set_number: int
    event_type: RuleEventType
    ruleset_id: str
    ruleset_version: str
    ruleset_fingerprint: str
    payload: RulePayload
    created_at_ns: int
    related_rally_id: str | None = None
    schema_version: str = RULE_EVENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != RULE_EVENT_SCHEMA_VERSION:
            _error(ContractErrorCode.UNSUPPORTED_SCHEMA, "unsupported rule-event schema")
        _ascii_text(self.event_id, "event_id", maximum=MAX_ID_LENGTH)
        _positive_int(self.sequence_number, "sequence_number", MAX_SEQUENCE_NUMBER)
        _ascii_text(self.match_id, "match_id", maximum=MAX_ID_LENGTH)
        _positive_int(self.set_number, "set_number", MAX_SET_NUMBER)
        _declared_enum(self.event_type, RuleEventType, "event_type")
        _ascii_text(self.ruleset_id, "ruleset_id", maximum=MAX_ID_LENGTH)
        _ascii_text(self.ruleset_version, "ruleset_version", maximum=MAX_ID_LENGTH)
        if not isinstance(self.ruleset_fingerprint, str) or not _SHA256_RE.fullmatch(
            self.ruleset_fingerprint
        ):
            _error(
                ContractErrorCode.FIELD_VALUE,
                "ruleset_fingerprint must be a lowercase SHA-256",
            )
        expected_payload = _PAYLOAD_TYPE[self.event_type]
        if type(self.payload) is not expected_payload:
            _error(
                ContractErrorCode.PAYLOAD_EVENT_MISMATCH,
                f"{self.event_type.value} requires {expected_payload.__name__}",
            )
        _positive_int(self.created_at_ns, "created_at_ns", MAX_SEQUENCE_NUMBER)
        if self.related_rally_id is not None:
            _ascii_text(
                self.related_rally_id,
                "related_rally_id",
                maximum=MAX_ID_LENGTH,
            )

        if self.event_type in {
            RuleEventType.POINT_AWARDED,
            RuleEventType.REPLAY_NO_POINT,
        }:
            if self.related_rally_id is None:
                _error(
                    ContractErrorCode.RELATIONSHIP_INVALID,
                    "point/replay events require a rally id",
                )
        elif self.related_rally_id is not None:
            _error(
                ContractErrorCode.RELATIONSHIP_INVALID,
                "this event type does not accept rally linkage",
            )

    def fingerprint(self) -> str:
        return hashlib.sha256(encode_rule_event(self)).hexdigest()


_TOP_LEVEL_FIELDS = frozenset(
    {
        "schema_version",
        "event_id",
        "sequence_number",
        "match_id",
        "set_number",
        "event_type",
        "ruleset_id",
        "ruleset_version",
        "ruleset_fingerprint",
        "payload",
        "created_at_ns",
        "related_rally_id",
    }
)


def _exact_fields(value: Any, expected: frozenset[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be an object")
    present = frozenset(value)
    if present != expected:
        missing = ",".join(sorted(expected - present)) or "-"
        extra = ",".join(sorted(present - expected)) or "-"
        _error(
            ContractErrorCode.FIELD_SET,
            f"{name} fields differ (missing={missing}; extra={extra})",
        )
    return value


def _enum_from_wire(value: Any, enum_type: type[Enum], name: str) -> Any:
    if not isinstance(value, str):
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be a string")
    try:
        return enum_type(value)
    except ValueError:
        code = (
            ContractErrorCode.UNSUPPORTED_EVENT_TYPE
            if enum_type is RuleEventType
            else ContractErrorCode.FIELD_VALUE
        )
        _error(code, f"unsupported {name}")


def _tuple_of_strings(value: Any, name: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        _error(ContractErrorCode.FIELD_TYPE, f"{name} must be an array")
    return tuple(value)


def _build_payload(event_type: RuleEventType, raw: Any) -> RulePayload:
    specs: dict[RuleEventType, tuple[frozenset[str], Callable[[dict[str, Any]], RulePayload]]] = {
        RuleEventType.SET_SEED: (
            frozenset({"service_order_a", "service_order_b", "serving_team", "serving_player", "side_a", "side_b"}),
            lambda p: SetSeedPayload(
                service_order_a=_tuple_of_strings(p["service_order_a"], "service_order_a"),
                service_order_b=_tuple_of_strings(p["service_order_b"], "service_order_b"),
                serving_team=_enum_from_wire(p["serving_team"], Team, "serving_team"),
                serving_player=p["serving_player"],
                side_a=_enum_from_wire(p["side_a"], CourtSide, "side_a"),
                side_b=_enum_from_wire(p["side_b"], CourtSide, "side_b"),
            ),
        ),
        RuleEventType.POINT_AWARDED: (
            frozenset({"winner_team", "evidence_refs"}),
            lambda p: PointAwardedPayload(
                winner_team=_enum_from_wire(p["winner_team"], Team, "winner_team"),
                evidence_refs=_tuple_of_strings(p["evidence_refs"], "evidence_refs"),
            ),
        ),
        RuleEventType.REPLAY_NO_POINT: (
            frozenset({"reason", "evidence_refs"}),
            lambda p: ReplayNoPointPayload(
                reason=p["reason"],
                evidence_refs=_tuple_of_strings(p["evidence_refs"], "evidence_refs"),
            ),
        ),
        RuleEventType.SIDE_SWITCH_CONFIRMED: (
            frozenset({"due_total", "observed_at_total", "cleared_through_total", "observed_side_a", "observed_side_b", "evidence_refs"}),
            lambda p: SideSwitchConfirmedPayload(
                due_total=p["due_total"],
                observed_at_total=p["observed_at_total"],
                cleared_through_total=p["cleared_through_total"],
                observed_side_a=_enum_from_wire(p["observed_side_a"], CourtSide, "observed_side_a"),
                observed_side_b=_enum_from_wire(p["observed_side_b"], CourtSide, "observed_side_b"),
                evidence_refs=_tuple_of_strings(p["evidence_refs"], "evidence_refs"),
            ),
        ),
        RuleEventType.TECHNICAL_TIMEOUT_COMPLETED: (
            frozenset({"due_total", "observed_at_total", "evidence_refs"}),
            lambda p: TechnicalTimeoutCompletedPayload(
                due_total=p["due_total"],
                observed_at_total=p["observed_at_total"],
                evidence_refs=_tuple_of_strings(p["evidence_refs"], "evidence_refs"),
            ),
        ),
    }
    fields, builder = specs[event_type]
    return builder(_exact_fields(raw, fields, "payload"))


class _DuplicateKey(Exception):
    pass


class _UnsupportedJsonNumber(Exception):
    pass


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _check_json_depth(text: str) -> None:
    """Bound structural nesting without recursively walking attacker input."""

    depth = 0
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                _error(
                    ContractErrorCode.JSON_DEPTH_EXCEEDED,
                    f"JSON nesting exceeds {MAX_JSON_DEPTH}",
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def parse_rule_event(raw: bytes | str) -> RuleEvent:
    """Parse one untrusted JSON event under strict size and schema bounds."""

    if isinstance(raw, bytes):
        if len(raw) > MAX_RAW_EVENT_BYTES:
            _error(ContractErrorCode.RAW_TOO_LARGE, "event exceeds 64 KiB")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ContractError(ContractErrorCode.INVALID_UTF8, "event is not UTF-8") from exc
    elif isinstance(raw, str):
        try:
            encoded = raw.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise ContractError(ContractErrorCode.INVALID_UTF8, "event is not valid UTF-8") from exc
        if len(encoded) > MAX_RAW_EVENT_BYTES:
            _error(ContractErrorCode.RAW_TOO_LARGE, "event exceeds 64 KiB")
        text = raw
    else:
        _error(ContractErrorCode.RAW_TYPE, "event must be bytes or string JSON")

    _check_json_depth(text)
    try:
        decoded = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=lambda _: (_ for _ in ()).throw(_UnsupportedJsonNumber()),
            parse_constant=lambda _: (_ for _ in ()).throw(_UnsupportedJsonNumber()),
        )
    except _DuplicateKey as exc:
        raise ContractError(ContractErrorCode.DUPLICATE_KEY, f"duplicate key: {exc}") from exc
    except _UnsupportedJsonNumber as exc:
        raise ContractError(
            ContractErrorCode.INVALID_JSON, "floating/non-finite numbers are not allowed"
        ) from exc
    except RecursionError as exc:
        raise ContractError(
            ContractErrorCode.JSON_DEPTH_EXCEEDED, "JSON nesting exceeds parser depth"
        ) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise ContractError(ContractErrorCode.INVALID_JSON, "invalid JSON") from exc

    if not isinstance(decoded, dict):
        _error(ContractErrorCode.TOP_LEVEL_TYPE, "rule event must be a JSON object")
    data = _exact_fields(decoded, _TOP_LEVEL_FIELDS, "rule event")
    event_type = _enum_from_wire(data["event_type"], RuleEventType, "event_type")
    return RuleEvent(
        schema_version=data["schema_version"],
        event_id=data["event_id"],
        sequence_number=data["sequence_number"],
        match_id=data["match_id"],
        set_number=data["set_number"],
        event_type=event_type,
        ruleset_id=data["ruleset_id"],
        ruleset_version=data["ruleset_version"],
        ruleset_fingerprint=data["ruleset_fingerprint"],
        payload=_build_payload(event_type, data["payload"]),
        created_at_ns=data["created_at_ns"],
        related_rally_id=data["related_rally_id"],
    )


def _payload_wire(payload: RulePayload) -> dict[str, Any]:
    if isinstance(payload, SetSeedPayload):
        return {
            "service_order_a": list(payload.service_order_a),
            "service_order_b": list(payload.service_order_b),
            "serving_team": payload.serving_team.value,
            "serving_player": payload.serving_player,
            "side_a": payload.side_a.value,
            "side_b": payload.side_b.value,
        }
    if isinstance(payload, PointAwardedPayload):
        return {"winner_team": payload.winner_team.value, "evidence_refs": list(payload.evidence_refs)}
    if isinstance(payload, ReplayNoPointPayload):
        return {"reason": payload.reason, "evidence_refs": list(payload.evidence_refs)}
    if isinstance(payload, SideSwitchConfirmedPayload):
        return {
            "due_total": payload.due_total,
            "observed_at_total": payload.observed_at_total,
            "cleared_through_total": payload.cleared_through_total,
            "observed_side_a": payload.observed_side_a.value,
            "observed_side_b": payload.observed_side_b.value,
            "evidence_refs": list(payload.evidence_refs),
        }
    if isinstance(payload, TechnicalTimeoutCompletedPayload):
        return {"due_total": payload.due_total, "observed_at_total": payload.observed_at_total, "evidence_refs": list(payload.evidence_refs)}
    _error(ContractErrorCode.FIELD_TYPE, "unsupported typed payload")


def rule_event_to_dict(event: RuleEvent) -> dict[str, Any]:
    if not isinstance(event, RuleEvent):
        _error(ContractErrorCode.FIELD_TYPE, "event must be a RuleEvent")
    return {
        "schema_version": event.schema_version,
        "event_id": event.event_id,
        "sequence_number": event.sequence_number,
        "match_id": event.match_id,
        "set_number": event.set_number,
        "event_type": event.event_type.value,
        "ruleset_id": event.ruleset_id,
        "ruleset_version": event.ruleset_version,
        "ruleset_fingerprint": event.ruleset_fingerprint,
        "payload": _payload_wire(event.payload),
        "created_at_ns": event.created_at_ns,
        "related_rally_id": event.related_rally_id,
    }


def encode_rule_event(event: RuleEvent) -> bytes:
    """Return the unique canonical UTF-8 encoding used for hashing/signing."""

    return json.dumps(
        rule_event_to_dict(event),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


__all__ = [
    "ContractError",
    "ContractErrorCode",
    "CourtSide",
    "MAX_EVIDENCE_REFS",
    "MAX_JSON_DEPTH",
    "MAX_RAW_EVENT_BYTES",
    "PointAwardedPayload",
    "ReplayNoPointPayload",
    "RULE_EVENT_SCHEMA_VERSION",
    "RuleEvent",
    "RuleEventType",
    "RulePayload",
    "SetSeedPayload",
    "SideSwitchConfirmedPayload",
    "Team",
    "TechnicalTimeoutCompletedPayload",
    "encode_rule_event",
    "parse_rule_event",
    "rule_event_to_dict",
]
