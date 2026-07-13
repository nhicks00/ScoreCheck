"""Canonical, bounded persistence codec for reducer match state.

The codec is deliberately narrower than a general dataclass/JSON serializer.  A
snapshot is a security boundary: every field is declared here, every collection
is bounded, and all reducer invariants that can be established from ``MatchState``
alone are checked before a snapshot is accepted.
"""

from __future__ import annotations

import hashlib
import json
import re
from enum import Enum
from typing import Any, NoReturn

from .domain_events import CourtSide, RuleEventType, Team
from .rules import (
    MAX_EVENTS_PER_MATCH,
    AppliedEventRecord,
    DomainEffect,
    MatchState,
    Ruleset,
    SetPhase,
    SetResult,
    SetState,
)


MATCH_STATE_SCHEMA_VERSION = "1.0"
MAX_RAW_STATE_BYTES = 512 * 1024
MAX_JSON_DEPTH = 8
MAX_ID_LENGTH = 128
MAX_COMPLETED_SETS = 99
# Per-match cache ceilings are fail-closed: callers must never truncate these
# audit tuples.  Canonical event storage/replay remains authoritative when a
# snapshot cannot be emitted under either this count bound or the byte bound.
MAX_APPLIED_EVENTS = MAX_EVENTS_PER_MATCH
MAX_RALLY_RESOLUTIONS = 4_096
MIN_SIGNED_64 = -(1 << 63)
MAX_SIGNED_64 = (1 << 63) - 1

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_UNRESOLVED_EFFECTS = frozenset(
    {DomainEffect.SIDE_SWITCH_DUE, DomainEffect.TECHNICAL_TIMEOUT_DUE}
)
_RESOLUTION_EVENT_TYPES = frozenset(
    {RuleEventType.POINT_AWARDED, RuleEventType.REPLAY_NO_POINT}
)


class StateCodecErrorCode(str, Enum):
    """Stable classifications for snapshot rejection."""

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
    NON_CANONICAL = "NON_CANONICAL"
    INVARIANT = "INVARIANT"


class StateCodecError(ValueError):
    """A stable, machine-classifiable match-state codec failure."""

    def __init__(self, code: StateCodecErrorCode | str, message: str) -> None:
        self.code = code.value if isinstance(code, StateCodecErrorCode) else code
        super().__init__(f"{self.code}: {message}")


def _fail(code: StateCodecErrorCode, message: str) -> NoReturn:
    raise StateCodecError(code, message)


_MATCH_STATE_FIELDS = frozenset(
    {
        "schema_version",
        "match_id",
        "ruleset_id",
        "ruleset_version",
        "ruleset_fingerprint",
        "current_set",
        "completed_sets",
        "team_a_sets",
        "team_b_sets",
        "match_winner",
        "last_sequence_number",
        "applied_events",
        "rally_resolutions",
    }
)
_SET_STATE_FIELDS = frozenset(
    {
        "number",
        "target_points",
        "win_by",
        "side_switch_interval",
        "technical_timeout_total",
        "team_a_points",
        "team_b_points",
        "service_order_a",
        "service_order_b",
        "serving_team",
        "serving_player",
        "next_server_index_a",
        "next_server_index_b",
        "side_a",
        "side_b",
        "last_side_switch_total",
        "technical_timeout_completed",
        "phase",
    }
)
_SET_RESULT_FIELDS = frozenset(
    {
        "set_number",
        "team_a_points",
        "team_b_points",
        "winner",
        "unresolved_obligations",
    }
)
_APPLIED_EVENT_FIELDS = frozenset(
    {
        "event_id",
        "fingerprint",
        "event_type",
        "set_number",
        "resolution_rally_id",
    }
)
_RALLY_RESOLUTION_FIELDS = frozenset({"rally_id", "event_id"})


def _exact_object(
    value: Any,
    fields: frozenset[str],
    path: str,
) -> dict[str, Any]:
    if type(value) is not dict:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be an object")
    present = frozenset(value)
    if present != fields:
        missing = ",".join(sorted(fields - present)) or "-"
        extra = ",".join(sorted(present - fields)) or "-"
        _fail(
            StateCodecErrorCode.FIELD_SET,
            f"{path} fields differ (missing={missing}; extra={extra})",
        )
    return value


def _array(value: Any, path: str, maximum: int) -> list[Any]:
    if type(value) is not list:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be an array")
    if len(value) > maximum:
        _fail(
            StateCodecErrorCode.FIELD_BOUNDS,
            f"{path} exceeds {maximum} entries",
        )
    return value


def _ascii_id(value: Any, path: str) -> str:
    if type(value) is not str:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be a string")
    if not 1 <= len(value) <= MAX_ID_LENGTH or value != value.strip():
        _fail(
            StateCodecErrorCode.FIELD_BOUNDS,
            f"{path} must contain 1..{MAX_ID_LENGTH} characters without outer whitespace",
        )
    if not value.isascii() or any(
        ord(character) < 0x21 or ord(character) > 0x7E for character in value
    ):
        _fail(StateCodecErrorCode.FIELD_ASCII, f"{path} must be printable ASCII")
    return value


def _sha256(value: Any, path: str) -> str:
    if type(value) is not str:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be a string")
    if _SHA256_RE.fullmatch(value) is None:
        _fail(
            StateCodecErrorCode.FIELD_VALUE,
            f"{path} must be a lowercase SHA-256",
        )
    return value


def _integer(
    value: Any,
    path: str,
    *,
    minimum: int = MIN_SIGNED_64,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be an integer")
    if value < minimum or value > maximum:
        _fail(
            StateCodecErrorCode.FIELD_BOUNDS,
            f"{path} is outside {minimum}..{maximum}",
        )
    return value


def _boolean(value: Any, path: str) -> bool:
    if type(value) is not bool:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be a boolean")
    return value


def _enum(value: Any, enum_type: type[Enum], path: str) -> Any:
    if type(value) is not str:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be a string")
    try:
        return enum_type(value)
    except ValueError:
        _fail(StateCodecErrorCode.FIELD_VALUE, f"{path} is unsupported")


def _optional_enum(value: Any, enum_type: type[Enum], path: str) -> Any | None:
    return None if value is None else _enum(value, enum_type, path)


def _wire_player_order(value: Any, path: str) -> tuple[str, str]:
    entries = _array(value, path, 2)
    if len(entries) != 2:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, f"{path} must have exactly 2 entries")
    return (_ascii_id(entries[0], f"{path}[0]"), _ascii_id(entries[1], f"{path}[1]"))


def _wire_effects(value: Any, path: str) -> frozenset[DomainEffect]:
    entries = _array(value, path, len(DomainEffect))
    effects = tuple(
        _enum(item, DomainEffect, f"{path}[{index}]")
        for index, item in enumerate(entries)
    )
    if len(set(effects)) != len(effects):
        _fail(StateCodecErrorCode.FIELD_VALUE, f"{path} contains duplicates")
    return frozenset(effects)


def _set_state_from_wire(value: Any, path: str) -> SetState:
    data = _exact_object(value, _SET_STATE_FIELDS, path)
    timeout = data["technical_timeout_total"]
    if timeout is not None:
        timeout = _integer(timeout, f"{path}.technical_timeout_total", minimum=1)
    return SetState(
        number=_integer(data["number"], f"{path}.number", minimum=1, maximum=99),
        target_points=_integer(
            data["target_points"], f"{path}.target_points", minimum=1
        ),
        win_by=_integer(data["win_by"], f"{path}.win_by", minimum=1),
        side_switch_interval=_integer(
            data["side_switch_interval"],
            f"{path}.side_switch_interval",
            minimum=1,
        ),
        technical_timeout_total=timeout,
        team_a_points=_integer(
            data["team_a_points"], f"{path}.team_a_points", minimum=0
        ),
        team_b_points=_integer(
            data["team_b_points"], f"{path}.team_b_points", minimum=0
        ),
        service_order_a=_wire_player_order(
            data["service_order_a"], f"{path}.service_order_a"
        ),
        service_order_b=_wire_player_order(
            data["service_order_b"], f"{path}.service_order_b"
        ),
        serving_team=_enum(data["serving_team"], Team, f"{path}.serving_team"),
        serving_player=_ascii_id(data["serving_player"], f"{path}.serving_player"),
        next_server_index_a=_integer(
            data["next_server_index_a"],
            f"{path}.next_server_index_a",
            minimum=0,
            maximum=1,
        ),
        next_server_index_b=_integer(
            data["next_server_index_b"],
            f"{path}.next_server_index_b",
            minimum=0,
            maximum=1,
        ),
        side_a=_enum(data["side_a"], CourtSide, f"{path}.side_a"),
        side_b=_enum(data["side_b"], CourtSide, f"{path}.side_b"),
        last_side_switch_total=_integer(
            data["last_side_switch_total"],
            f"{path}.last_side_switch_total",
            minimum=0,
        ),
        technical_timeout_completed=_boolean(
            data["technical_timeout_completed"],
            f"{path}.technical_timeout_completed",
        ),
        phase=_enum(data["phase"], SetPhase, f"{path}.phase"),
    )


def _set_result_from_wire(value: Any, path: str) -> SetResult:
    data = _exact_object(value, _SET_RESULT_FIELDS, path)
    return SetResult(
        set_number=_integer(
            data["set_number"], f"{path}.set_number", minimum=1, maximum=99
        ),
        team_a_points=_integer(
            data["team_a_points"], f"{path}.team_a_points", minimum=0
        ),
        team_b_points=_integer(
            data["team_b_points"], f"{path}.team_b_points", minimum=0
        ),
        winner=_enum(data["winner"], Team, f"{path}.winner"),
        unresolved_obligations=_wire_effects(
            data["unresolved_obligations"], f"{path}.unresolved_obligations"
        ),
    )


def _applied_event_from_wire(value: Any, path: str) -> AppliedEventRecord:
    data = _exact_object(value, _APPLIED_EVENT_FIELDS, path)
    rally_id = data["resolution_rally_id"]
    if rally_id is not None:
        rally_id = _ascii_id(rally_id, f"{path}.resolution_rally_id")
    return AppliedEventRecord(
        event_id=_ascii_id(data["event_id"], f"{path}.event_id"),
        fingerprint=_sha256(data["fingerprint"], f"{path}.fingerprint"),
        event_type=_enum(data["event_type"], RuleEventType, f"{path}.event_type"),
        set_number=_integer(
            data["set_number"], f"{path}.set_number", minimum=1, maximum=99
        ),
        resolution_rally_id=rally_id,
    )


def _match_state_from_wire(value: Any) -> MatchState:
    data = _exact_object(value, _MATCH_STATE_FIELDS, "match_state")
    if data["schema_version"] != MATCH_STATE_SCHEMA_VERSION:
        _fail(StateCodecErrorCode.UNSUPPORTED_SCHEMA, "unsupported match-state schema")

    raw_current = data["current_set"]
    current = (
        None
        if raw_current is None
        else _set_state_from_wire(raw_current, "match_state.current_set")
    )
    completed_raw = _array(
        data["completed_sets"],
        "match_state.completed_sets",
        MAX_COMPLETED_SETS,
    )
    applied_raw = _array(
        data["applied_events"],
        "match_state.applied_events",
        MAX_APPLIED_EVENTS,
    )
    rallies_raw = _array(
        data["rally_resolutions"],
        "match_state.rally_resolutions",
        MAX_RALLY_RESOLUTIONS,
    )

    completed = tuple(
        _set_result_from_wire(item, f"match_state.completed_sets[{index}]")
        for index, item in enumerate(completed_raw)
    )
    applied = tuple(
        _applied_event_from_wire(item, f"match_state.applied_events[{index}]")
        for index, item in enumerate(applied_raw)
    )
    rallies: list[tuple[str, str]] = []
    for index, raw_resolution in enumerate(rallies_raw):
        path = f"match_state.rally_resolutions[{index}]"
        resolution = _exact_object(raw_resolution, _RALLY_RESOLUTION_FIELDS, path)
        rallies.append(
            (
                _ascii_id(resolution["rally_id"], f"{path}.rally_id"),
                _ascii_id(resolution["event_id"], f"{path}.event_id"),
            )
        )
    return MatchState(
        match_id=_ascii_id(data["match_id"], "match_state.match_id"),
        ruleset_id=_ascii_id(data["ruleset_id"], "match_state.ruleset_id"),
        ruleset_version=_ascii_id(
            data["ruleset_version"], "match_state.ruleset_version"
        ),
        ruleset_fingerprint=_sha256(
            data["ruleset_fingerprint"], "match_state.ruleset_fingerprint"
        ),
        current_set=current,
        completed_sets=completed,
        team_a_sets=_integer(
            data["team_a_sets"], "match_state.team_a_sets", minimum=0, maximum=99
        ),
        team_b_sets=_integer(
            data["team_b_sets"], "match_state.team_b_sets", minimum=0, maximum=99
        ),
        match_winner=_optional_enum(
            data["match_winner"], Team, "match_state.match_winner"
        ),
        last_sequence_number=_integer(
            data["last_sequence_number"],
            "match_state.last_sequence_number",
            minimum=0,
        ),
        applied_events=applied,
        rally_resolutions=tuple(rallies),
    )


def _validate_dataclass_types(state: MatchState) -> None:
    if type(state) is not MatchState:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state must be exactly MatchState")
    _ascii_id(state.match_id, "state.match_id")
    _ascii_id(state.ruleset_id, "state.ruleset_id")
    _ascii_id(state.ruleset_version, "state.ruleset_version")
    _sha256(state.ruleset_fingerprint, "state.ruleset_fingerprint")
    if state.current_set is not None and type(state.current_set) is not SetState:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.current_set must be SetState or null")
    if type(state.completed_sets) is not tuple:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.completed_sets must be a tuple")
    if type(state.applied_events) is not tuple:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.applied_events must be a tuple")
    if type(state.rally_resolutions) is not tuple:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.rally_resolutions must be a tuple")
    if len(state.completed_sets) > MAX_COMPLETED_SETS:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, "state.completed_sets is too large")
    if len(state.applied_events) > MAX_APPLIED_EVENTS:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, "state.applied_events is too large")
    if len(state.rally_resolutions) > MAX_RALLY_RESOLUTIONS:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, "state.rally_resolutions is too large")
    _integer(state.team_a_sets, "state.team_a_sets", minimum=0, maximum=99)
    _integer(state.team_b_sets, "state.team_b_sets", minimum=0, maximum=99)
    if state.match_winner is not None and type(state.match_winner) is not Team:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.match_winner must be Team or null")
    _integer(state.last_sequence_number, "state.last_sequence_number", minimum=0)


def _validate_ruleset(state: MatchState, ruleset: Ruleset) -> None:
    if type(ruleset) is not Ruleset:
        _fail(StateCodecErrorCode.FIELD_TYPE, "ruleset must be exactly Ruleset")
    _ascii_id(ruleset.ruleset_id, "ruleset.ruleset_id")
    _ascii_id(ruleset.version, "ruleset.version")
    _ascii_id(ruleset.reducer_semantics_version, "ruleset.reducer_semantics_version")
    for name, value in (
        ("best_of_sets", ruleset.best_of_sets),
        ("regular_set_target", ruleset.regular_set_target),
        ("deciding_set_target", ruleset.deciding_set_target),
        ("win_by", ruleset.win_by),
        ("regular_side_switch_interval", ruleset.regular_side_switch_interval),
        ("deciding_side_switch_interval", ruleset.deciding_side_switch_interval),
        ("max_events_per_match", ruleset.max_events_per_match),
    ):
        _integer(value, f"ruleset.{name}", minimum=1)
    if ruleset.best_of_sets > MAX_COMPLETED_SETS:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, "ruleset.best_of_sets exceeds 99")
    if len(state.applied_events) > ruleset.max_events_per_match:
        _fail(
            StateCodecErrorCode.FIELD_BOUNDS,
            "state.applied_events exceeds the protected ruleset event limit",
        )
    if ruleset.regular_technical_timeout_total is not None:
        _integer(
            ruleset.regular_technical_timeout_total,
            "ruleset.regular_technical_timeout_total",
            minimum=1,
        )
    fingerprint = _sha256(ruleset.fingerprint(), "ruleset.fingerprint")
    if (
        state.ruleset_id != ruleset.ruleset_id
        or state.ruleset_version != ruleset.version
        or state.ruleset_fingerprint != fingerprint
    ):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "state rules identity does not match the protected ruleset",
        )


def _score_winner(
    points_a: int,
    points_b: int,
    *,
    target: int,
    win_by: int,
) -> Team | None:
    if max(points_a, points_b) < target or abs(points_a - points_b) < win_by:
        return None
    return Team.A if points_a > points_b else Team.B


def _validate_terminal_score(
    points_a: int,
    points_b: int,
    *,
    target: int,
    win_by: int,
    expected_winner: Team,
    path: str,
) -> None:
    winner = _score_winner(points_a, points_b, target=target, win_by=win_by)
    if winner is not expected_winner:
        _fail(StateCodecErrorCode.INVARIANT, f"{path} winner conflicts with its score")
    prior_a = points_a - (1 if winner is Team.A else 0)
    prior_b = points_b - (1 if winner is Team.B else 0)
    if prior_a < 0 or prior_b < 0 or _score_winner(
        prior_a,
        prior_b,
        target=target,
        win_by=win_by,
    ) is not None:
        _fail(StateCodecErrorCode.INVARIANT, f"{path} has an unreachable terminal score")


def _validate_set_state(current: SetState, ruleset: Ruleset) -> None:
    path = "state.current_set"
    _integer(current.number, f"{path}.number", minimum=1, maximum=99)
    _integer(current.target_points, f"{path}.target_points", minimum=1)
    _integer(current.win_by, f"{path}.win_by", minimum=1)
    _integer(current.side_switch_interval, f"{path}.side_switch_interval", minimum=1)
    if current.technical_timeout_total is not None:
        _integer(
            current.technical_timeout_total,
            f"{path}.technical_timeout_total",
            minimum=1,
        )
    points_a = _integer(current.team_a_points, f"{path}.team_a_points", minimum=0)
    points_b = _integer(current.team_b_points, f"{path}.team_b_points", minimum=0)
    if points_a + points_b > MAX_SIGNED_64:
        _fail(StateCodecErrorCode.FIELD_BOUNDS, "current-set point total exceeds signed64")
    if current.number > ruleset.best_of_sets:
        _fail(StateCodecErrorCode.INVARIANT, "current set exceeds the protected match format")
    expected_timeout = (
        None
        if current.number == ruleset.deciding_set_number
        else ruleset.regular_technical_timeout_total
    )
    if (
        current.target_points != ruleset.target_for_set(current.number)
        or current.win_by != ruleset.win_by
        or current.side_switch_interval
        != ruleset.switch_interval_for_set(current.number)
        or current.technical_timeout_total != expected_timeout
    ):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "current-set parameters do not match the protected ruleset",
        )

    for name, order in (
        ("service_order_a", current.service_order_a),
        ("service_order_b", current.service_order_b),
    ):
        if type(order) is not tuple or len(order) != 2:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path}.{name} must be a two-item tuple")
        _ascii_id(order[0], f"{path}.{name}[0]")
        _ascii_id(order[1], f"{path}.{name}[1]")
    if len(set(current.service_order_a + current.service_order_b)) != 4:
        _fail(StateCodecErrorCode.INVARIANT, "all service-order player ids must be unique")
    if type(current.serving_team) is not Team:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path}.serving_team must be Team")
    _ascii_id(current.serving_player, f"{path}.serving_player")
    next_a = _integer(
        current.next_server_index_a,
        f"{path}.next_server_index_a",
        minimum=0,
        maximum=1,
    )
    next_b = _integer(
        current.next_server_index_b,
        f"{path}.next_server_index_b",
        minimum=0,
        maximum=1,
    )
    service_order = (
        current.service_order_a
        if current.serving_team is Team.A
        else current.service_order_b
    )
    if current.serving_player not in service_order:
        _fail(StateCodecErrorCode.INVARIANT, "serving player is not on the serving team")
    serving_index = service_order.index(current.serving_player)
    next_index = next_a if current.serving_team is Team.A else next_b
    if next_index != 1 - serving_index:
        _fail(
            StateCodecErrorCode.INVARIANT,
            "serving player conflicts with the serving team's next-server index",
        )

    if type(current.side_a) is not CourtSide or type(current.side_b) is not CourtSide:
        _fail(StateCodecErrorCode.FIELD_TYPE, "current-set sides must be CourtSide values")
    if current.side_a is current.side_b:
        _fail(StateCodecErrorCode.INVARIANT, "teams must occupy opposing court sides")
    last_switch = _integer(
        current.last_side_switch_total,
        f"{path}.last_side_switch_total",
        minimum=0,
    )
    operational_total = current.total_points
    if current.phase is SetPhase.COMPLETE:
        operational_total -= 1
    if (
        operational_total < 0
        or last_switch > operational_total
        or last_switch % current.side_switch_interval
    ):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "last side-switch total is inconsistent with the score and interval",
        )
    _boolean(current.technical_timeout_completed, f"{path}.technical_timeout_completed")
    if current.technical_timeout_completed and (
        current.technical_timeout_total is None
        or operational_total < current.technical_timeout_total
    ):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "technical-timeout completion is inconsistent with the set total",
        )
    if type(current.phase) is not SetPhase:
        _fail(StateCodecErrorCode.FIELD_TYPE, f"{path}.phase must be SetPhase")

    winner = _score_winner(
        points_a,
        points_b,
        target=current.target_points,
        win_by=current.win_by,
    )
    if current.phase is SetPhase.IN_PROGRESS and winner is not None:
        _fail(StateCodecErrorCode.INVARIANT, "in-progress set has a terminal score")
    if current.phase is SetPhase.COMPLETE:
        if winner is None:
            _fail(StateCodecErrorCode.INVARIANT, "complete set does not have a winner")
        _validate_terminal_score(
            points_a,
            points_b,
            target=current.target_points,
            win_by=current.win_by,
            expected_winner=winner,
            path="current set",
        )


def _validate_completed_sets(state: MatchState, ruleset: Ruleset) -> None:
    if len(state.completed_sets) > ruleset.best_of_sets:
        _fail(StateCodecErrorCode.INVARIANT, "completed sets exceed the match format")
    for index, result in enumerate(state.completed_sets):
        path = f"state.completed_sets[{index}]"
        if type(result) is not SetResult:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be SetResult")
        if result.set_number != index + 1:
            _fail(StateCodecErrorCode.INVARIANT, "completed sets must be contiguous and ordered")
        points_a = _integer(result.team_a_points, f"{path}.team_a_points", minimum=0)
        points_b = _integer(result.team_b_points, f"{path}.team_b_points", minimum=0)
        if points_a + points_b > MAX_SIGNED_64:
            _fail(StateCodecErrorCode.FIELD_BOUNDS, f"{path} point total exceeds signed64")
        if type(result.winner) is not Team:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path}.winner must be Team")
        target = ruleset.target_for_set(result.set_number)
        _validate_terminal_score(
            points_a,
            points_b,
            target=target,
            win_by=ruleset.win_by,
            expected_winner=result.winner,
            path=path,
        )
        if type(result.unresolved_obligations) is not frozenset:
            _fail(
                StateCodecErrorCode.FIELD_TYPE,
                f"{path}.unresolved_obligations must be a frozenset",
            )
        if any(type(effect) is not DomainEffect for effect in result.unresolved_obligations):
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} contains a non-DomainEffect")
        if not result.unresolved_obligations <= _UNRESOLVED_EFFECTS:
            _fail(
                StateCodecErrorCode.INVARIANT,
                f"{path} contains a non-obligation domain effect",
            )
        prior_total = points_a + points_b - 1
        if (
            DomainEffect.SIDE_SWITCH_DUE in result.unresolved_obligations
            and prior_total < ruleset.switch_interval_for_set(result.set_number)
        ):
            _fail(StateCodecErrorCode.INVARIANT, f"{path} has an impossible side obligation")
        timeout = (
            None
            if result.set_number == ruleset.deciding_set_number
            else ruleset.regular_technical_timeout_total
        )
        if DomainEffect.TECHNICAL_TIMEOUT_DUE in result.unresolved_obligations and (
            timeout is None or prior_total < timeout
        ):
            _fail(
                StateCodecErrorCode.INVARIANT,
                f"{path} has an impossible technical-timeout obligation",
            )

    expected_a = sum(result.winner is Team.A for result in state.completed_sets)
    expected_b = sum(result.winner is Team.B for result in state.completed_sets)
    if (state.team_a_sets, state.team_b_sets) != (expected_a, expected_b):
        _fail(StateCodecErrorCode.INVARIANT, "match set totals do not match completed sets")

    winner: Team | None = None
    running_a = 0
    running_b = 0
    for index, result in enumerate(state.completed_sets):
        running_a += result.winner is Team.A
        running_b += result.winner is Team.B
        if running_a >= ruleset.sets_to_win:
            winner = Team.A
        elif running_b >= ruleset.sets_to_win:
            winner = Team.B
        if winner is not None and index != len(state.completed_sets) - 1:
            _fail(StateCodecErrorCode.INVARIANT, "sets continued after match completion")
    if state.match_winner is not winner:
        _fail(StateCodecErrorCode.INVARIANT, "match winner does not match protected rules")


def _validate_current_set_alignment(state: MatchState, ruleset: Ruleset) -> None:
    current = state.current_set
    if current is None:
        if state.completed_sets or state.team_a_sets or state.team_b_sets or state.match_winner:
            _fail(StateCodecErrorCode.INVARIANT, "an unseeded match cannot contain set results")
        return

    _validate_set_state(current, ruleset)
    completed_count = len(state.completed_sets)
    if current.phase is SetPhase.IN_PROGRESS:
        if current.number != completed_count + 1:
            _fail(
                StateCodecErrorCode.INVARIANT,
                "active current-set number must follow completed sets",
            )
    else:
        if current.number != completed_count or not state.completed_sets:
            _fail(
                StateCodecErrorCode.INVARIANT,
                "complete current set must be the final completed result",
            )
        result = state.completed_sets[-1]
        if (
            result.set_number,
            result.team_a_points,
            result.team_b_points,
            result.winner,
        ) != (
            current.number,
            current.team_a_points,
            current.team_b_points,
            current.winner,
        ):
            _fail(
                StateCodecErrorCode.INVARIANT,
                "complete current set conflicts with its completed-set result",
            )
        prior_total = current.total_points - 1
        expected_obligations: set[DomainEffect] = set()
        if prior_total >= current.last_side_switch_total + current.side_switch_interval:
            expected_obligations.add(DomainEffect.SIDE_SWITCH_DUE)
        if (
            current.technical_timeout_total is not None
            and not current.technical_timeout_completed
            and prior_total >= current.technical_timeout_total
        ):
            expected_obligations.add(DomainEffect.TECHNICAL_TIMEOUT_DUE)
        if result.unresolved_obligations != frozenset(expected_obligations):
            _fail(
                StateCodecErrorCode.INVARIANT,
                "final set obligations conflict with pre-terminal state",
            )

    if state.match_winner is not None and current.phase is not SetPhase.COMPLETE:
        _fail(StateCodecErrorCode.INVARIANT, "match winner requires a complete current set")


def _validate_applied_events(state: MatchState) -> None:
    events = state.applied_events
    if state.last_sequence_number != len(events):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "last_sequence_number must equal the contiguous applied-event count",
        )
    if state.current_set is None:
        if events or state.rally_resolutions:
            _fail(StateCodecErrorCode.INVARIANT, "unseeded match contains event audit state")
        return
    if not events:
        _fail(StateCodecErrorCode.INVARIANT, "seeded match has no applied events")

    ids: set[str] = set()
    fingerprints: set[str] = set()
    active_set_number = 0
    resolution_order: list[str] = []
    latest_resolution: dict[str, str] = {}
    seen_resolutions: set[str] = set()
    point_counts: dict[int, int] = {}
    timeout_counts: dict[int, int] = {}
    side_confirmation_counts: dict[int, int] = {}

    for index, record in enumerate(events):
        path = f"state.applied_events[{index}]"
        if type(record) is not AppliedEventRecord:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be AppliedEventRecord")
        event_id = _ascii_id(record.event_id, f"{path}.event_id")
        fingerprint = _sha256(record.fingerprint, f"{path}.fingerprint")
        if type(record.event_type) is not RuleEventType:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path}.event_type must be RuleEventType")
        _integer(record.set_number, f"{path}.set_number", minimum=1, maximum=99)
        if record.resolution_rally_id is not None:
            _ascii_id(record.resolution_rally_id, f"{path}.resolution_rally_id")
        if event_id in ids:
            _fail(StateCodecErrorCode.INVARIANT, "applied event ids must be unique")
        if fingerprint in fingerprints:
            _fail(StateCodecErrorCode.INVARIANT, "applied event fingerprints must be unique")
        ids.add(event_id)
        fingerprints.add(fingerprint)

        if record.event_type is RuleEventType.SET_SEED:
            if record.set_number != active_set_number + 1:
                _fail(StateCodecErrorCode.INVARIANT, "set-seed events must be contiguous")
            active_set_number += 1
        elif active_set_number == 0 or record.set_number != active_set_number:
            _fail(
                StateCodecErrorCode.INVARIANT,
                "applied events must remain ordered within their seeded set",
            )

        if record.event_type in _RESOLUTION_EVENT_TYPES:
            rally_id = record.resolution_rally_id
            if rally_id is None:
                _fail(StateCodecErrorCode.INVARIANT, "point/replay record lacks rally linkage")
            if rally_id in seen_resolutions:
                _fail(StateCodecErrorCode.INVARIANT, "a rally has multiple initial resolutions")
            seen_resolutions.add(rally_id)
            resolution_order.append(rally_id)
            latest_resolution[rally_id] = event_id
        elif record.resolution_rally_id is not None:
            _fail(
                StateCodecErrorCode.INVARIANT,
                "non-resolution event contains rally linkage",
            )
        if record.event_type is RuleEventType.POINT_AWARDED:
            point_counts[record.set_number] = point_counts.get(record.set_number, 0) + 1
        elif record.event_type is RuleEventType.TECHNICAL_TIMEOUT_COMPLETED:
            timeout_counts[record.set_number] = timeout_counts.get(record.set_number, 0) + 1
            if timeout_counts[record.set_number] > 1:
                _fail(
                    StateCodecErrorCode.INVARIANT,
                    "a set contains multiple technical-timeout completions",
                )
        elif record.event_type is RuleEventType.SIDE_SWITCH_CONFIRMED:
            side_confirmation_counts[record.set_number] = (
                side_confirmation_counts.get(record.set_number, 0) + 1
            )

    if active_set_number != state.current_set.number:
        _fail(StateCodecErrorCode.INVARIANT, "event set order does not reach current set")

    for set_number in range(1, state.current_set.number + 1):
        if set_number <= len(state.completed_sets):
            result = state.completed_sets[set_number - 1]
            expected_points = result.team_a_points + result.team_b_points
        else:
            expected_points = state.current_set.total_points
        if point_counts.get(set_number, 0) != expected_points:
            _fail(
                StateCodecErrorCode.INVARIANT,
                "point-event counts do not match persisted set scores",
            )
    current_number = state.current_set.number
    if bool(timeout_counts.get(current_number, 0)) != state.current_set.technical_timeout_completed:
        _fail(
            StateCodecErrorCode.INVARIANT,
            "technical-timeout event audit does not match current set state",
        )
    if bool(side_confirmation_counts.get(current_number, 0)) != bool(
        state.current_set.last_side_switch_total
    ):
        _fail(
            StateCodecErrorCode.INVARIANT,
            "side-switch event audit does not match current set state",
        )

    if type(state.rally_resolutions) is not tuple:
        _fail(StateCodecErrorCode.FIELD_TYPE, "state.rally_resolutions must be a tuple")
    validated_rallies: list[tuple[str, str]] = []
    for index, pair in enumerate(state.rally_resolutions):
        path = f"state.rally_resolutions[{index}]"
        if type(pair) is not tuple or len(pair) != 2:
            _fail(StateCodecErrorCode.FIELD_TYPE, f"{path} must be a two-item tuple")
        validated_rallies.append(
            (_ascii_id(pair[0], f"{path}[0]"), _ascii_id(pair[1], f"{path}[1]"))
        )
    expected_rallies = tuple(
        (rally_id, latest_resolution[rally_id]) for rally_id in resolution_order
    )
    if tuple(validated_rallies) != expected_rallies:
        _fail(
            StateCodecErrorCode.INVARIANT,
            "rally mappings must uniquely reference the latest matching resolution event",
        )

def _validate_match_state(state: MatchState, ruleset: Ruleset) -> None:
    _validate_dataclass_types(state)
    _validate_ruleset(state, ruleset)
    _validate_completed_sets(state, ruleset)
    _validate_current_set_alignment(state, ruleset)
    _validate_applied_events(state)


def _set_state_wire(current: SetState) -> dict[str, Any]:
    return {
        "number": current.number,
        "target_points": current.target_points,
        "win_by": current.win_by,
        "side_switch_interval": current.side_switch_interval,
        "technical_timeout_total": current.technical_timeout_total,
        "team_a_points": current.team_a_points,
        "team_b_points": current.team_b_points,
        "service_order_a": list(current.service_order_a),
        "service_order_b": list(current.service_order_b),
        "serving_team": current.serving_team.value,
        "serving_player": current.serving_player,
        "next_server_index_a": current.next_server_index_a,
        "next_server_index_b": current.next_server_index_b,
        "side_a": current.side_a.value,
        "side_b": current.side_b.value,
        "last_side_switch_total": current.last_side_switch_total,
        "technical_timeout_completed": current.technical_timeout_completed,
        "phase": current.phase.value,
    }


def _set_result_wire(result: SetResult) -> dict[str, Any]:
    return {
        "set_number": result.set_number,
        "team_a_points": result.team_a_points,
        "team_b_points": result.team_b_points,
        "winner": result.winner.value,
        "unresolved_obligations": sorted(
            effect.value for effect in result.unresolved_obligations
        ),
    }


def _applied_event_wire(record: AppliedEventRecord) -> dict[str, Any]:
    return {
        "event_id": record.event_id,
        "fingerprint": record.fingerprint,
        "event_type": record.event_type.value,
        "set_number": record.set_number,
        "resolution_rally_id": record.resolution_rally_id,
    }


def _state_wire(state: MatchState) -> dict[str, Any]:
    return {
        "schema_version": MATCH_STATE_SCHEMA_VERSION,
        "match_id": state.match_id,
        "ruleset_id": state.ruleset_id,
        "ruleset_version": state.ruleset_version,
        "ruleset_fingerprint": state.ruleset_fingerprint,
        "current_set": (
            None if state.current_set is None else _set_state_wire(state.current_set)
        ),
        "completed_sets": [_set_result_wire(result) for result in state.completed_sets],
        "team_a_sets": state.team_a_sets,
        "team_b_sets": state.team_b_sets,
        "match_winner": None if state.match_winner is None else state.match_winner.value,
        "last_sequence_number": state.last_sequence_number,
        "applied_events": [
            _applied_event_wire(record) for record in state.applied_events
        ],
        "rally_resolutions": [
            {"rally_id": rally_id, "event_id": event_id}
            for rally_id, event_id in state.rally_resolutions
        ],
    }


def _canonical_bytes(state: MatchState) -> bytes:
    encoded = json.dumps(
        _state_wire(state),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    if len(encoded) > MAX_RAW_STATE_BYTES:
        _fail(
            StateCodecErrorCode.RAW_TOO_LARGE,
            f"canonical state exceeds {MAX_RAW_STATE_BYTES} bytes",
        )
    return encoded


def encode_match_state(state: MatchState, *, ruleset: Ruleset) -> bytes:
    """Validate and encode a cache snapshot under an exact protected ruleset."""

    _validate_match_state(state, ruleset)
    return _canonical_bytes(state)


class _DuplicateKey(Exception):
    pass


class _UnsupportedNumber(Exception):
    pass


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _parse_json_integer(token: str) -> int:
    if len(token) > 20:
        raise _UnsupportedNumber
    value = int(token)
    if value < MIN_SIGNED_64 or value > MAX_SIGNED_64:
        raise _UnsupportedNumber
    return value


def _check_json_depth(text: str) -> None:
    """Bound nesting iteratively, before the recursive CPython JSON parser runs."""

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
                _fail(
                    StateCodecErrorCode.JSON_DEPTH_EXCEEDED,
                    f"JSON nesting exceeds {MAX_JSON_DEPTH}",
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def decode_match_state(raw: bytes, *, ruleset: Ruleset) -> MatchState:
    """Decode an untrusted cache snapshot under an exact protected ruleset.

    Snapshot acceptance does not replace authoritative event replay.  Storage
    recovery must replay canonical authorized events and compare the resulting
    canonical state bytes with this cache.
    """

    if type(raw) is not bytes:
        _fail(StateCodecErrorCode.RAW_TYPE, "match state must be bytes")
    if len(raw) > MAX_RAW_STATE_BYTES:
        _fail(
            StateCodecErrorCode.RAW_TOO_LARGE,
            f"match state exceeds {MAX_RAW_STATE_BYTES} bytes",
        )
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise StateCodecError(
            StateCodecErrorCode.INVALID_UTF8, "match state is not UTF-8"
        ) from exc

    _check_json_depth(text)
    try:
        decoded = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_int=_parse_json_integer,
            parse_float=lambda _: (_ for _ in ()).throw(_UnsupportedNumber()),
            parse_constant=lambda _: (_ for _ in ()).throw(_UnsupportedNumber()),
        )
    except _DuplicateKey as exc:
        raise StateCodecError(
            StateCodecErrorCode.DUPLICATE_KEY, f"duplicate key: {exc}"
        ) from exc
    except _UnsupportedNumber as exc:
        raise StateCodecError(
            StateCodecErrorCode.INVALID_JSON,
            "numbers must be signed64 integers; floats and non-finite values are forbidden",
        ) from exc
    except RecursionError as exc:
        raise StateCodecError(
            StateCodecErrorCode.JSON_DEPTH_EXCEEDED,
            "JSON nesting exceeds parser depth",
        ) from exc
    except (json.JSONDecodeError, ValueError, OverflowError) as exc:
        raise StateCodecError(StateCodecErrorCode.INVALID_JSON, "invalid JSON") from exc

    if type(decoded) is not dict:
        _fail(StateCodecErrorCode.TOP_LEVEL_TYPE, "match state must be a JSON object")
    state = _match_state_from_wire(decoded)
    _validate_match_state(state, ruleset)
    canonical = _canonical_bytes(state)
    if raw != canonical:
        _fail(
            StateCodecErrorCode.NON_CANONICAL,
            "match state is valid but not in canonical byte form",
        )
    return state


def match_state_fingerprint(state: MatchState, *, ruleset: Ruleset) -> str:
    """Return the lowercase SHA-256 of the canonical state snapshot."""

    return hashlib.sha256(encode_match_state(state, ruleset=ruleset)).hexdigest()


__all__ = [
    "MATCH_STATE_SCHEMA_VERSION",
    "MAX_RAW_STATE_BYTES",
    "StateCodecError",
    "StateCodecErrorCode",
    "decode_match_state",
    "encode_match_state",
    "match_state_fingerprint",
]
