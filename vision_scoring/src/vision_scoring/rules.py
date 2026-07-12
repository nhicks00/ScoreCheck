"""Deterministic, event-sourced beach-volleyball score reducer."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Iterable, Mapping

from .contracts import Authority, ConfirmationMode, RuleEvent, RuleEventType, Team


class RulesError(ValueError):
    """Raised when an event cannot legally or safely mutate score state."""


class CourtSide(str, Enum):
    NEAR = "NEAR"
    FAR = "FAR"


class SetPhase(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETE = "COMPLETE"


class DomainEffect(str, Enum):
    SIDE_SWITCH_DUE = "SIDE_SWITCH_DUE"
    TECHNICAL_TIMEOUT_DUE = "TECHNICAL_TIMEOUT_DUE"
    SET_COMPLETE = "SET_COMPLETE"
    MATCH_COMPLETE = "MATCH_COMPLETE"
    SCORE_CORRECTION_APPLIED = "SCORE_CORRECTION_APPLIED"
    SET_REOPENED = "SET_REOPENED"
    SET_RESULT_CHANGED = "SET_RESULT_CHANGED"
    MATCH_REOPENED = "MATCH_REOPENED"
    MATCH_RESULT_CHANGED = "MATCH_RESULT_CHANGED"
    SET_CLOSED_WITH_OPEN_OBLIGATIONS = "SET_CLOSED_WITH_OPEN_OBLIGATIONS"
    DUPLICATE_IGNORED = "DUPLICATE_IGNORED"


@dataclass(frozen=True, slots=True)
class Ruleset:
    ruleset_id: str = "FIVB_BEACH"
    version: str = "2025-2028"
    reducer_semantics_version: str = "beach-reducer-v1"
    best_of_sets: int = 3
    regular_set_target: int = 21
    deciding_set_target: int = 15
    win_by: int = 2
    regular_side_switch_interval: int = 7
    deciding_side_switch_interval: int = 5
    regular_technical_timeout_total: int | None = 21

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.ruleset_id, self.version, self.reducer_semantics_version)
        ):
            raise ValueError("ruleset identity and reducer semantics version must be non-empty")
        scoring_values = (
            self.best_of_sets,
            self.regular_set_target,
            self.deciding_set_target,
            self.win_by,
            self.regular_side_switch_interval,
            self.deciding_side_switch_interval,
        )
        if any(type(value) is not int for value in scoring_values):
            raise ValueError("ruleset scoring values must be integers")
        if self.best_of_sets < 1 or self.best_of_sets % 2 == 0:
            raise ValueError("best_of_sets must be a positive odd number")
        if min(scoring_values) <= 0:
            raise ValueError("ruleset scoring values must be positive")
        if self.regular_technical_timeout_total is not None and (
            type(self.regular_technical_timeout_total) is not int
            or self.regular_technical_timeout_total <= 0
        ):
            raise ValueError("technical-timeout total must be a positive integer")

    @property
    def sets_to_win(self) -> int:
        return self.best_of_sets // 2 + 1

    @property
    def deciding_set_number(self) -> int:
        return self.best_of_sets

    def target_for_set(self, set_number: int) -> int:
        return self.deciding_set_target if set_number == self.deciding_set_number else self.regular_set_target

    def switch_interval_for_set(self, set_number: int) -> int:
        return (
            self.deciding_side_switch_interval
            if set_number == self.deciding_set_number
            else self.regular_side_switch_interval
        )

    def fingerprint(self) -> str:
        """Return the canonical identity of every scoring parameter."""

        canonical = {
            "best_of_sets": self.best_of_sets,
            "deciding_set_target": self.deciding_set_target,
            "deciding_side_switch_interval": self.deciding_side_switch_interval,
            "regular_set_target": self.regular_set_target,
            "regular_side_switch_interval": self.regular_side_switch_interval,
            "regular_technical_timeout_total": self.regular_technical_timeout_total,
            "reducer_semantics_version": self.reducer_semantics_version,
            "ruleset_id": self.ruleset_id,
            "version": self.version,
            "win_by": self.win_by,
        }
        encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class SetState:
    number: int
    target_points: int
    win_by: int
    side_switch_interval: int
    technical_timeout_total: int | None
    team_a_points: int
    team_b_points: int
    service_order_a: tuple[str, str]
    service_order_b: tuple[str, str]
    serving_team: Team
    serving_player: str
    next_server_index_a: int
    next_server_index_b: int
    side_a: CourtSide
    side_b: CourtSide
    last_side_switch_total: int
    technical_timeout_completed: bool = False
    phase: SetPhase = SetPhase.IN_PROGRESS

    @property
    def total_points(self) -> int:
        return self.team_a_points + self.team_b_points

    @property
    def winner(self) -> Team | None:
        if max(self.team_a_points, self.team_b_points) < self.target_points:
            return None
        if abs(self.team_a_points - self.team_b_points) < self.win_by:
            return None
        return Team.A if self.team_a_points > self.team_b_points else Team.B

    @property
    def side_switch_due(self) -> bool:
        if self.phase is SetPhase.COMPLETE:
            return False
        return self.total_points >= self.last_side_switch_total + self.side_switch_interval

    @property
    def technical_timeout_due(self) -> bool:
        return (
            self.phase is SetPhase.IN_PROGRESS
            and self.technical_timeout_total is not None
            and not self.technical_timeout_completed
            and self.total_points >= self.technical_timeout_total
        )

    @property
    def pending_effects(self) -> frozenset[DomainEffect]:
        effects: set[DomainEffect] = set()
        if self.side_switch_due:
            effects.add(DomainEffect.SIDE_SWITCH_DUE)
        if self.technical_timeout_due:
            effects.add(DomainEffect.TECHNICAL_TIMEOUT_DUE)
        return frozenset(effects)

    def service_order(self, team: Team) -> tuple[str, str]:
        return self.service_order_a if team is Team.A else self.service_order_b

    def next_server_index(self, team: Team) -> int:
        return self.next_server_index_a if team is Team.A else self.next_server_index_b

    def expected_next_server(self, team: Team) -> str:
        return self.service_order(team)[self.next_server_index(team)]


@dataclass(frozen=True, slots=True)
class SetResult:
    set_number: int
    team_a_points: int
    team_b_points: int
    winner: Team
    unresolved_obligations: frozenset[DomainEffect] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class AppliedEventRecord:
    event_id: str
    fingerprint: str
    event_type: RuleEventType
    set_number: int
    related_rally_id: str | None


@dataclass(frozen=True, slots=True)
class MatchState:
    match_id: str
    ruleset_id: str
    ruleset_version: str
    ruleset_fingerprint: str
    current_set: SetState | None = None
    completed_sets: tuple[SetResult, ...] = ()
    team_a_sets: int = 0
    team_b_sets: int = 0
    match_winner: Team | None = None
    last_sequence_number: int = 0
    applied_events: tuple[AppliedEventRecord, ...] = ()
    rally_resolutions: tuple[tuple[str, str], ...] = ()
    corrected_event_ids: tuple[str, ...] = ()

    @property
    def match_complete(self) -> bool:
        return self.match_winner is not None

    @property
    def revision(self) -> int:
        return self.last_sequence_number

    @property
    def applied_event_ids(self) -> tuple[str, ...]:
        return tuple(record.event_id for record in self.applied_events)

    def applied_event(self, event_id: str) -> AppliedEventRecord | None:
        return next((record for record in self.applied_events if record.event_id == event_id), None)

    def rally_resolution(self, rally_id: str) -> str | None:
        return dict(self.rally_resolutions).get(rally_id)


@dataclass(frozen=True, slots=True)
class Reduction:
    before: MatchState
    after: MatchState
    recorded_event: RuleEvent
    effects: frozenset[DomainEffect]


def initial_state(match_id: str, ruleset: Ruleset) -> MatchState:
    if not isinstance(match_id, str) or not match_id.strip():
        raise ValueError("match_id must be a non-empty string")
    if not isinstance(ruleset, Ruleset):
        raise ValueError("ruleset must be a Ruleset")
    return MatchState(
        match_id=match_id,
        ruleset_id=ruleset.ruleset_id,
        ruleset_version=ruleset.version,
        ruleset_fingerprint=ruleset.fingerprint(),
    )


class RulesReducer:
    """Validate domain transitions; caller authentication remains an outer boundary."""

    _HUMAN_AUTHORITIES = frozenset(
        {Authority.OPERATOR, Authority.REFEREE_FEED, Authority.SCOREKEEPER, Authority.IMPORT}
    )
    _ALLOWED_AUTHORITIES = {
        RuleEventType.SET_SEED: _HUMAN_AUTHORITIES,
        RuleEventType.POINT_AWARDED: _HUMAN_AUTHORITIES | {Authority.AUTO_POLICY},
        RuleEventType.PENALTY_POINT: _HUMAN_AUTHORITIES,
        RuleEventType.SERVICE_ORDER_FAULT: _HUMAN_AUTHORITIES,
        RuleEventType.REPLAY_NO_POINT: _HUMAN_AUTHORITIES,
        RuleEventType.SIDE_SWITCH_CONFIRMED: _HUMAN_AUTHORITIES,
        RuleEventType.TECHNICAL_TIMEOUT_COMPLETED: _HUMAN_AUTHORITIES,
        RuleEventType.SCORE_CORRECTION: _HUMAN_AUTHORITIES,
    }
    _RESOLUTION_EVENTS = frozenset(
        {
            RuleEventType.POINT_AWARDED,
            RuleEventType.PENALTY_POINT,
            RuleEventType.SERVICE_ORDER_FAULT,
            RuleEventType.REPLAY_NO_POINT,
        }
    )
    _CORRECTION_TARGETS = frozenset(
        {
            RuleEventType.POINT_AWARDED,
            RuleEventType.PENALTY_POINT,
            RuleEventType.SERVICE_ORDER_FAULT,
            RuleEventType.REPLAY_NO_POINT,
            RuleEventType.SCORE_CORRECTION,
        }
    )

    def __init__(self, ruleset: Ruleset | None = None) -> None:
        if ruleset is not None and not isinstance(ruleset, Ruleset):
            raise ValueError("ruleset must be a Ruleset")
        self.ruleset = ruleset or Ruleset()

    def new_match(self, match_id: str) -> MatchState:
        return initial_state(match_id, self.ruleset)

    def replay(self, events: Iterable[RuleEvent], match_id: str | None = None) -> MatchState:
        event_list = tuple(events)
        if not event_list and match_id is None:
            raise RulesError("match_id is required when replaying an empty log")
        resolved_match_id = match_id or event_list[0].match_id
        state = self.new_match(resolved_match_id)
        for event in event_list:
            state = self.reduce(state, event).after
        return state

    def reduce(self, state: MatchState, event: RuleEvent) -> Reduction:
        self._validate_identity(state, event)
        duplicate_record = state.applied_event(event.event_id)
        if duplicate_record is not None:
            if duplicate_record.fingerprint != event.fingerprint():
                raise RulesError("duplicate event id has conflicting content")
            return Reduction(
                before=state,
                after=state,
                recorded_event=event,
                effects=frozenset({DomainEffect.DUPLICATE_IGNORED}),
            )
        self._validate_sequence(state, event)
        self._validate_authority(event)
        if event.event_type in self._RESOLUTION_EVENTS:
            self._validate_new_rally_resolution(state, event)

        if event.event_type is RuleEventType.SET_SEED:
            updated = self._apply_set_seed(state, event)
        elif event.event_type is RuleEventType.POINT_AWARDED:
            updated = self._apply_point(state, event)
        elif event.event_type in (RuleEventType.PENALTY_POINT, RuleEventType.SERVICE_ORDER_FAULT):
            updated = self._apply_administrative_point(state, event)
        elif event.event_type is RuleEventType.REPLAY_NO_POINT:
            updated = self._apply_replay_no_point(state, event)
        elif event.event_type is RuleEventType.SIDE_SWITCH_CONFIRMED:
            updated = self._apply_side_switch(state, event)
        elif event.event_type is RuleEventType.TECHNICAL_TIMEOUT_COMPLETED:
            updated = self._apply_technical_timeout(state, event)
        elif event.event_type is RuleEventType.SCORE_CORRECTION:
            updated = self._apply_score_correction(state, event)
        else:  # pragma: no cover - Enum exhaustiveness guard
            raise RulesError(f"unsupported rule event type: {event.event_type}")

        audited = self._update_resolution_audit(updated, event)
        record = AppliedEventRecord(
            event_id=event.event_id,
            fingerprint=event.fingerprint(),
            event_type=event.event_type,
            set_number=event.set_number,
            related_rally_id=event.related_rally_id,
        )
        after = replace(
            audited,
            last_sequence_number=event.sequence_number,
            applied_events=audited.applied_events + (record,),
        )
        effects = self._effects_for_transition(state, after, event.event_type)
        return Reduction(before=state, after=after, recorded_event=event, effects=effects)

    def _validate_identity(self, state: MatchState, event: RuleEvent) -> None:
        if (
            state.ruleset_id != self.ruleset.ruleset_id
            or state.ruleset_version != self.ruleset.version
            or state.ruleset_fingerprint != self.ruleset.fingerprint()
        ):
            raise RulesError("reducer ruleset does not match reducer state")
        if event.match_id != state.match_id:
            raise RulesError("event match_id does not match reducer state")
        if event.ruleset_id != state.ruleset_id or event.ruleset_version != state.ruleset_version:
            raise RulesError("event ruleset does not match reducer state")
        if event.ruleset_fingerprint != state.ruleset_fingerprint:
            raise RulesError("event ruleset fingerprint does not match reducer state")

    @staticmethod
    def _validate_sequence(state: MatchState, event: RuleEvent) -> None:
        if event.sequence_number != state.last_sequence_number + 1:
            raise RulesError("rule events must have contiguous sequence numbers")

    def _validate_authority(self, event: RuleEvent) -> None:
        allowed = self._ALLOWED_AUTHORITIES[event.event_type]
        if event.authority not in allowed:
            raise RulesError(
                f"{event.authority.value} may not issue {event.event_type.value} events"
            )

    @staticmethod
    def _validate_new_rally_resolution(state: MatchState, event: RuleEvent) -> None:
        if not event.related_rally_id:
            raise RulesError("score/replay events require related_rally_id")
        if not event.evidence_refs:
            raise RulesError("score/replay events require immutable evidence")
        existing = state.rally_resolution(event.related_rally_id)
        if existing is not None:
            raise RulesError(
                f"rally {event.related_rally_id!r} is already resolved by event {existing!r}"
            )

    @staticmethod
    def _update_resolution_audit(state: MatchState, event: RuleEvent) -> MatchState:
        if event.event_type in RulesReducer._RESOLUTION_EVENTS:
            assert event.related_rally_id is not None
            return replace(
                state,
                rally_resolutions=state.rally_resolutions
                + ((event.related_rally_id, event.event_id),),
            )
        if event.event_type is RuleEventType.SCORE_CORRECTION and event.related_rally_id:
            resolutions = dict(state.rally_resolutions)
            resolutions[event.related_rally_id] = event.event_id
            return replace(state, rally_resolutions=tuple(resolutions.items()))
        return state

    def _apply_set_seed(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(
            event,
            required={
                "service_order_a",
                "service_order_b",
                "serving_team",
                "serving_player",
                "side_a",
                "side_b",
            },
        )
        if state.match_complete:
            raise RulesError("cannot seed another set after match completion")
        if state.current_set is not None and state.current_set.phase is not SetPhase.COMPLETE:
            raise RulesError("cannot seed a new set while the current set is active")

        expected_number = 1 if state.current_set is None else state.current_set.number + 1
        if event.set_number != expected_number:
            raise RulesError(f"expected set {expected_number}, got set {event.set_number}")

        order_a = self._player_order(event.payload, "service_order_a")
        order_b = self._player_order(event.payload, "service_order_b")
        if len(set(order_a + order_b)) != 4:
            raise RulesError("the four service-order player ids must be unique")

        serving_team = self._team(event.payload, "serving_team")
        serving_player = self._string(event.payload, "serving_player")
        if serving_player != (order_a if serving_team is Team.A else order_b)[0]:
            raise RulesError("serving_player must be first in that team's seeded service order")

        side_a = self._court_side(event.payload, "side_a")
        side_b = self._court_side(event.payload, "side_b")
        if side_a is side_b:
            raise RulesError("teams cannot occupy the same court side")

        set_state = SetState(
            number=event.set_number,
            target_points=self.ruleset.target_for_set(event.set_number),
            win_by=self.ruleset.win_by,
            side_switch_interval=self.ruleset.switch_interval_for_set(event.set_number),
            technical_timeout_total=(
                None
                if event.set_number == self.ruleset.deciding_set_number
                else self.ruleset.regular_technical_timeout_total
            ),
            team_a_points=0,
            team_b_points=0,
            service_order_a=order_a,
            service_order_b=order_b,
            serving_team=serving_team,
            serving_player=serving_player,
            next_server_index_a=1 if serving_team is Team.A else 0,
            next_server_index_b=1 if serving_team is Team.B else 0,
            side_a=side_a,
            side_b=side_b,
            last_side_switch_total=0,
            technical_timeout_completed=False,
        )
        return replace(state, current_set=set_state)

    def _apply_point(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(
            event,
            required={"winner_team", "confirmation_mode"},
            optional={"next_serving_player"},
        )
        current = self._active_set(state, event)
        if current.pending_effects and event.authority is Authority.AUTO_POLICY:
            pending = ", ".join(sorted(effect.value for effect in current.pending_effects))
            raise RulesError(f"automatic scoring is blocked by pending set obligations: {pending}")

        confirmation_mode = self._confirmation_mode(event.payload, "confirmation_mode")
        if event.authority is Authority.AUTO_POLICY:
            if confirmation_mode is not ConfirmationMode.SERVER_CHANGE:
                raise RulesError("automatic points require SERVER_CHANGE confirmation")
        elif event.authority is Authority.REFEREE_FEED:
            if confirmation_mode is not ConfirmationMode.REFEREE_FEED:
                raise RulesError("referee-feed points require REFEREE_FEED confirmation")
        elif confirmation_mode is not ConfirmationMode.HUMAN:
            raise RulesError("operator, scorekeeper, and import points require HUMAN confirmation")

        winner = self._team(event.payload, "winner_team")
        points_a = current.team_a_points + (1 if winner is Team.A else 0)
        points_b = current.team_b_points + (1 if winner is Team.B else 0)
        score_only = replace(current, team_a_points=points_a, team_b_points=points_b)
        set_winner = score_only.winner
        if set_winner is not None:
            if event.authority is Authority.AUTO_POLICY:
                raise RulesError("set- or match-ending points require human or official authorization in v0")
            if "next_serving_player" in event.payload:
                raise RulesError("terminal point payload must omit next_serving_player")
            return self._complete_set(
                state,
                replace(score_only, phase=SetPhase.COMPLETE),
                set_winner,
                unresolved_obligations=current.pending_effects,
            )

        next_serving_player = self._string(event.payload, "next_serving_player")
        server_changed = winner is not current.serving_team

        if server_changed:
            expected_player = current.expected_next_server(winner)
        else:
            expected_player = current.serving_player
        if next_serving_player != expected_player:
            raise RulesError(
                f"invalid serving player {next_serving_player!r}; expected {expected_player!r}"
            )

        if event.authority is Authority.AUTO_POLICY:
            if not server_changed:
                raise RulesError("same-team next serve is ambiguous and cannot auto-award a point")

        provisional = replace(
            score_only,
            serving_team=winner,
            serving_player=next_serving_player,
            next_server_index_a=(
                1 - current.next_server_index_a
                if server_changed and winner is Team.A
                else current.next_server_index_a
            ),
            next_server_index_b=(
                1 - current.next_server_index_b
                if server_changed and winner is Team.B
                else current.next_server_index_b
            ),
        )

        return replace(state, current_set=provisional)

    def _apply_replay_no_point(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(event, required={"reason"})
        self._active_set(state, event)
        payload_reason = self._string(event.payload, "reason")
        if payload_reason != event.reason:
            raise RulesError("payload reason must match the rule-event reason")
        return state

    def _apply_administrative_point(self, state: MatchState, event: RuleEvent) -> MatchState:
        return self._apply_point(state, event)

    def _apply_side_switch(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(
            event,
            required={
                "due_total",
                "observed_at_total",
                "cleared_through_total",
                "observed_side_a",
                "observed_side_b",
            },
        )
        current = self._active_set(state, event)
        if not current.side_switch_due:
            raise RulesError("no side switch is currently due")
        if not event.evidence_refs:
            raise RulesError("side-switch confirmation requires immutable evidence")
        due_total = self._nonnegative_int(event.payload, "due_total")
        expected_due = current.last_side_switch_total + current.side_switch_interval
        if due_total != expected_due:
            raise RulesError(f"side-switch due_total must be {expected_due}")
        observed_at = self._nonnegative_int(event.payload, "observed_at_total")
        if observed_at != current.total_points:
            raise RulesError("side-switch observation is stale for the current score")
        cleared_through = self._nonnegative_int(event.payload, "cleared_through_total")
        expected_cleared_through = (
            current.total_points // current.side_switch_interval
        ) * current.side_switch_interval
        if cleared_through != expected_cleared_through:
            raise RulesError(
                f"side-switch cleared_through_total must be {expected_cleared_through}"
            )
        side_a = self._court_side(event.payload, "observed_side_a")
        side_b = self._court_side(event.payload, "observed_side_b")
        if side_a is side_b:
            raise RulesError("observed teams cannot occupy the same court side")
        elapsed_switches = (
            current.total_points // current.side_switch_interval
            - current.last_side_switch_total // current.side_switch_interval
        )
        expected_side_a = current.side_b if elapsed_switches % 2 else current.side_a
        expected_side_b = current.side_a if elapsed_switches % 2 else current.side_b
        if side_a is not expected_side_a or side_b is not expected_side_b:
            raise RulesError("observed side mapping conflicts with scheduled switch parity")
        switched = replace(
            current,
            side_a=side_a,
            side_b=side_b,
            last_side_switch_total=cleared_through,
        )
        return replace(state, current_set=switched)

    def _apply_technical_timeout(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(event, required={"due_total", "observed_at_total"})
        current = self._active_set(state, event)
        if not current.technical_timeout_due:
            raise RulesError("no technical timeout is currently due")
        if not event.evidence_refs:
            raise RulesError("technical-timeout completion requires immutable evidence")
        due_total = self._nonnegative_int(event.payload, "due_total")
        if due_total != current.technical_timeout_total:
            raise RulesError(f"technical-timeout due_total must be {current.technical_timeout_total}")
        observed_at = self._nonnegative_int(event.payload, "observed_at_total")
        if observed_at != current.total_points:
            raise RulesError("technical-timeout observation is stale for the current score")
        return replace(state, current_set=replace(current, technical_timeout_completed=True))

    def _apply_score_correction(self, state: MatchState, event: RuleEvent) -> MatchState:
        self._require_payload_fields(
            event,
            required={
                "reason",
                "team_a_points",
                "team_b_points",
                "serving_team",
                "serving_player",
                "next_server_index_a",
                "next_server_index_b",
                "side_a",
                "side_b",
                "last_side_switch_total",
                "technical_timeout_completed",
            },
        )
        current = state.current_set
        if current is None or current.number != event.set_number:
            raise RulesError("score correction must target the current set")
        if not event.evidence_refs:
            raise RulesError("score correction requires immutable evidence")
        payload_reason = self._string(event.payload, "reason")
        if payload_reason != event.reason:
            raise RulesError("payload reason must match the rule-event reason")
        if event.supersedes_event_id is None:
            raise RulesError("score correction must identify the superseded event")
        target = state.applied_event(event.supersedes_event_id)
        if target is None:
            raise RulesError("score correction targets an unknown event")
        if target.set_number != current.number:
            raise RulesError("score correction target must belong to the current set")
        if target.event_type not in self._CORRECTION_TARGETS:
            raise RulesError("score correction target must be a score/replay resolution event")
        if target.event_id in state.corrected_event_ids:
            raise RulesError("score correction target has already been superseded")
        if not state.applied_events or target.event_id != state.applied_events[-1].event_id:
            raise RulesError("v0 score correction must supersede the latest applied event")
        if target.related_rally_id != event.related_rally_id:
            raise RulesError("score correction must retain the target event's related rally")
        if target.related_rally_id:
            if state.rally_resolution(target.related_rally_id) != target.event_id:
                raise RulesError("score correction rally target is not the active resolution")

        points_a = self._nonnegative_int(event.payload, "team_a_points")
        points_b = self._nonnegative_int(event.payload, "team_b_points")
        serving_team = self._team(event.payload, "serving_team")
        serving_player = self._string(event.payload, "serving_player")
        if serving_player not in current.service_order(serving_team):
            raise RulesError("corrected serving player is not in the serving team's order")
        side_a = self._court_side(event.payload, "side_a")
        side_b = self._court_side(event.payload, "side_b")
        if side_a is side_b:
            raise RulesError("corrected sides must be distinct")
        next_a = self._binary_index(event.payload, "next_server_index_a")
        next_b = self._binary_index(event.payload, "next_server_index_b")
        serving_index = current.service_order(serving_team).index(serving_player)
        corrected_next = next_a if serving_team is Team.A else next_b
        if corrected_next != 1 - serving_index:
            raise RulesError("corrected next-server index conflicts with the serving player")
        last_switch = self._nonnegative_int(event.payload, "last_side_switch_total")
        technical_timeout_completed = self._boolean(event.payload, "technical_timeout_completed")
        total = points_a + points_b
        candidate = replace(current, team_a_points=points_a, team_b_points=points_b)
        operational_total = total - 1 if candidate.winner is not None else total
        if last_switch > operational_total or last_switch % current.side_switch_interval != 0:
            raise RulesError("last_side_switch_total is inconsistent with this set")
        if technical_timeout_completed and (
            current.technical_timeout_total is None
            or operational_total < current.technical_timeout_total
        ):
            raise RulesError(
                "technical timeout cannot be complete below its scheduled total or at/after the terminal point"
            )
        if not self._score_is_reachable(current, points_a, points_b):
            raise RulesError("corrected score cannot be reached without an earlier terminal state")

        base_completed = state.completed_sets
        if current.phase is SetPhase.COMPLETE:
            if not base_completed or base_completed[-1].set_number != current.number:
                raise RulesError("completed-set audit state is inconsistent")
            base_completed = base_completed[:-1]

        corrected = replace(
            current,
            team_a_points=points_a,
            team_b_points=points_b,
            serving_team=serving_team,
            serving_player=serving_player,
            next_server_index_a=next_a,
            next_server_index_b=next_b,
            side_a=side_a,
            side_b=side_b,
            last_side_switch_total=last_switch,
            technical_timeout_completed=technical_timeout_completed,
            phase=SetPhase.IN_PROGRESS,
        )

        reset_state = self._state_from_results(state, base_completed, corrected)
        corrected_winner = corrected.winner
        if corrected_winner is None:
            result = reset_state
        else:
            result = self._complete_set(
                reset_state,
                replace(corrected, phase=SetPhase.COMPLETE),
                corrected_winner,
                unresolved_obligations=self._obligations_before_terminal(corrected),
            )
        return replace(
            result,
            corrected_event_ids=state.corrected_event_ids + (target.event_id,),
        )

    @staticmethod
    def _score_is_reachable(current: SetState, points_a: int, points_b: int) -> bool:
        candidate = replace(current, team_a_points=points_a, team_b_points=points_b)
        winner = candidate.winner
        if winner is None:
            return True
        prior_a = points_a - (1 if winner is Team.A else 0)
        prior_b = points_b - (1 if winner is Team.B else 0)
        if prior_a < 0 or prior_b < 0:
            return False
        prior = replace(current, team_a_points=prior_a, team_b_points=prior_b)
        return prior.winner is None

    @staticmethod
    def _obligations_before_terminal(completed: SetState) -> frozenset[DomainEffect]:
        winner = completed.winner
        if winner is None:
            return frozenset()
        prior = replace(
            completed,
            team_a_points=completed.team_a_points - (1 if winner is Team.A else 0),
            team_b_points=completed.team_b_points - (1 if winner is Team.B else 0),
            phase=SetPhase.IN_PROGRESS,
        )
        return prior.pending_effects

    def _complete_set(
        self,
        state: MatchState,
        completed: SetState,
        winner: Team,
        *,
        unresolved_obligations: frozenset[DomainEffect] = frozenset(),
    ) -> MatchState:
        result = SetResult(
            set_number=completed.number,
            team_a_points=completed.team_a_points,
            team_b_points=completed.team_b_points,
            winner=winner,
            unresolved_obligations=unresolved_obligations,
        )
        results = state.completed_sets + (result,)
        return self._state_from_results(state, results, completed)

    def _state_from_results(
        self,
        state: MatchState,
        completed_sets: tuple[SetResult, ...],
        current_set: SetState,
    ) -> MatchState:
        sets_a = sum(result.winner is Team.A for result in completed_sets)
        sets_b = sum(result.winner is Team.B for result in completed_sets)
        winner: Team | None = None
        if sets_a >= self.ruleset.sets_to_win:
            winner = Team.A
        elif sets_b >= self.ruleset.sets_to_win:
            winner = Team.B
        return replace(
            state,
            current_set=current_set,
            completed_sets=completed_sets,
            team_a_sets=sets_a,
            team_b_sets=sets_b,
            match_winner=winner,
        )

    @staticmethod
    def _effects_for_transition(
        before: MatchState,
        after: MatchState,
        event_type: RuleEventType,
    ) -> frozenset[DomainEffect]:
        effects: set[DomainEffect] = set()
        current = after.current_set
        if current is not None:
            effects.update(current.pending_effects)
        before_phase = before.current_set.phase if before.current_set is not None else None
        if (
            current is not None
            and current.phase is SetPhase.COMPLETE
            and before_phase is not SetPhase.COMPLETE
        ):
            effects.add(DomainEffect.SET_COMPLETE)
        if after.match_complete and not before.match_complete:
            effects.add(DomainEffect.MATCH_COMPLETE)
        if after.completed_sets:
            after_result = after.completed_sets[-1]
            before_result = before.completed_sets[-1] if before.completed_sets else None
            if (
                after_result.unresolved_obligations
                and after_result != before_result
            ):
                effects.add(DomainEffect.SET_CLOSED_WITH_OPEN_OBLIGATIONS)
        if event_type is RuleEventType.SCORE_CORRECTION:
            effects.add(DomainEffect.SCORE_CORRECTION_APPLIED)
            before_set = before.current_set
            if before_set is not None and current is not None:
                if before_set.phase is SetPhase.COMPLETE and current.phase is SetPhase.IN_PROGRESS:
                    effects.add(DomainEffect.SET_REOPENED)
                elif (
                    before_set.phase is SetPhase.COMPLETE
                    and current.phase is SetPhase.COMPLETE
                    and (
                        before_set.team_a_points,
                        before_set.team_b_points,
                        before_set.winner,
                    )
                    != (current.team_a_points, current.team_b_points, current.winner)
                ):
                    effects.add(DomainEffect.SET_RESULT_CHANGED)
            if before.match_winner is not None and after.match_winner is None:
                effects.add(DomainEffect.MATCH_REOPENED)
            elif (
                before.match_winner is not None
                and after.match_winner is not None
                and before.match_winner is not after.match_winner
            ):
                effects.add(DomainEffect.MATCH_RESULT_CHANGED)
        return frozenset(effects)

    @staticmethod
    def _active_set(state: MatchState, event: RuleEvent) -> SetState:
        current = state.current_set
        if current is None:
            raise RulesError("set must be seeded before applying this event")
        if current.number != event.set_number:
            raise RulesError("event does not target the current set")
        if current.phase is SetPhase.COMPLETE:
            raise RulesError("current set is already complete")
        return current

    @staticmethod
    def _value(payload: Mapping[str, Any], key: str) -> Any:
        if key not in payload:
            raise RulesError(f"missing rule-event payload field: {key}")
        return payload[key]

    @staticmethod
    def _require_payload_fields(
        event: RuleEvent,
        *,
        required: set[str],
        optional: set[str] | None = None,
    ) -> None:
        optional = optional or set()
        present = set(event.payload)
        missing = required - present
        if missing:
            fields = ", ".join(sorted(missing))
            raise RulesError(f"missing rule-event payload fields: {fields}")
        extra = present - required - optional
        if extra:
            fields = ", ".join(sorted(extra))
            raise RulesError(f"unsupported rule-event payload fields: {fields}")

    @classmethod
    def _string(cls, payload: Mapping[str, Any], key: str) -> str:
        value = cls._value(payload, key)
        if not isinstance(value, str) or not value.strip():
            raise RulesError(f"{key} must be a non-empty string")
        return value

    @classmethod
    def _team(cls, payload: Mapping[str, Any], key: str) -> Team:
        try:
            return Team(cls._value(payload, key))
        except (TypeError, ValueError) as exc:
            raise RulesError(f"{key} must be team A or B") from exc

    @classmethod
    def _confirmation_mode(cls, payload: Mapping[str, Any], key: str) -> ConfirmationMode:
        try:
            return ConfirmationMode(cls._value(payload, key))
        except (TypeError, ValueError) as exc:
            raise RulesError(f"{key} is not a supported confirmation mode") from exc

    @classmethod
    def _court_side(cls, payload: Mapping[str, Any], key: str) -> CourtSide:
        try:
            return CourtSide(cls._value(payload, key))
        except (TypeError, ValueError) as exc:
            raise RulesError(f"{key} must be NEAR or FAR") from exc

    @classmethod
    def _player_order(cls, payload: Mapping[str, Any], key: str) -> tuple[str, str]:
        value = cls._value(payload, key)
        if not isinstance(value, tuple) or len(value) != 2:
            raise RulesError(f"{key} must contain exactly two player ids")
        first, second = value
        if not all(isinstance(player, str) and player.strip() for player in value):
            raise RulesError(f"{key} player ids must be non-empty strings")
        if first == second:
            raise RulesError(f"{key} player ids must be unique")
        return first, second

    @classmethod
    def _nonnegative_int(cls, payload: Mapping[str, Any], key: str) -> int:
        value = cls._value(payload, key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise RulesError(f"{key} must be a nonnegative integer")
        return value

    @classmethod
    def _binary_index(cls, payload: Mapping[str, Any], key: str) -> int:
        value = cls._nonnegative_int(payload, key)
        if value not in (0, 1):
            raise RulesError(f"{key} must be 0 or 1")
        return value

    @classmethod
    def _boolean(cls, payload: Mapping[str, Any], key: str) -> bool:
        value = cls._value(payload, key)
        if not isinstance(value, bool):
            raise RulesError(f"{key} must be a boolean")
        return value
