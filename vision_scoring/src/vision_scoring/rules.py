"""Deterministic, event-sourced beach-volleyball score reducer."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Iterable, cast

from . import domain_events as _domain


MAX_EVENTS_PER_MATCH = 4_096


def _require_domain_id(value: object, field_name: str) -> str:
    if (
        type(value) is not str
        or len(value) > _domain.MAX_ID_LENGTH
        or re.fullmatch(r"[\x21-\x7e]+", value) is None
    ):
        raise ValueError(
            f"{field_name} must be printable non-whitespace ASCII of at most "
            f"{_domain.MAX_ID_LENGTH} characters"
        )
    return value


class RulesError(ValueError):
    """Raised when an event cannot legally or safely mutate score state."""


class SetPhase(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETE = "COMPLETE"


class DomainEffect(str, Enum):
    SIDE_SWITCH_DUE = "SIDE_SWITCH_DUE"
    TECHNICAL_TIMEOUT_DUE = "TECHNICAL_TIMEOUT_DUE"
    SET_COMPLETE = "SET_COMPLETE"
    MATCH_COMPLETE = "MATCH_COMPLETE"
    SET_CLOSED_WITH_OPEN_OBLIGATIONS = "SET_CLOSED_WITH_OPEN_OBLIGATIONS"
    DUPLICATE_IGNORED = "DUPLICATE_IGNORED"


@dataclass(frozen=True, slots=True)
class Ruleset:
    ruleset_id: str = "FIVB_BEACH"
    version: str = "2025-2028"
    reducer_semantics_version: str = "beach-reducer-v2"
    best_of_sets: int = 3
    regular_set_target: int = 21
    deciding_set_target: int = 15
    win_by: int = 2
    regular_side_switch_interval: int = 7
    deciding_side_switch_interval: int = 5
    regular_technical_timeout_total: int | None = 21
    max_events_per_match: int = MAX_EVENTS_PER_MATCH

    def __post_init__(self) -> None:
        for field_name in (
            "ruleset_id",
            "version",
            "reducer_semantics_version",
        ):
            _require_domain_id(getattr(self, field_name), field_name)
        scoring_values = (
            self.best_of_sets,
            self.regular_set_target,
            self.deciding_set_target,
            self.win_by,
            self.regular_side_switch_interval,
            self.deciding_side_switch_interval,
            self.max_events_per_match,
        )
        if any(type(value) is not int for value in scoring_values):
            raise ValueError("ruleset scoring values must be integers")
        if self.best_of_sets < 1 or self.best_of_sets % 2 == 0:
            raise ValueError("best_of_sets must be a positive odd number")
        if min(scoring_values) <= 0 or max(scoring_values) > _domain.MAX_SEQUENCE_NUMBER:
            raise ValueError("ruleset scoring values must be positive signed 64-bit integers")
        if self.best_of_sets > _domain.MAX_SET_NUMBER:
            raise ValueError(
                f"best_of_sets cannot exceed {_domain.MAX_SET_NUMBER}"
            )
        if self.max_events_per_match > MAX_EVENTS_PER_MATCH:
            raise ValueError(
                f"max_events_per_match cannot exceed {MAX_EVENTS_PER_MATCH}"
            )
        if self.regular_technical_timeout_total is not None and (
            type(self.regular_technical_timeout_total) is not int
            or self.regular_technical_timeout_total <= 0
            or self.regular_technical_timeout_total > _domain.MAX_SEQUENCE_NUMBER
        ):
            raise ValueError(
                "technical-timeout total must be a positive signed 64-bit integer"
            )

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
            "max_events_per_match": self.max_events_per_match,
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
    serving_team: _domain.Team
    serving_player: str
    next_server_index_a: int
    next_server_index_b: int
    side_a: _domain.CourtSide
    side_b: _domain.CourtSide
    last_side_switch_total: int
    technical_timeout_completed: bool = False
    phase: SetPhase = SetPhase.IN_PROGRESS

    @property
    def total_points(self) -> int:
        return self.team_a_points + self.team_b_points

    @property
    def winner(self) -> _domain.Team | None:
        if max(self.team_a_points, self.team_b_points) < self.target_points:
            return None
        if abs(self.team_a_points - self.team_b_points) < self.win_by:
            return None
        return _domain.Team.A if self.team_a_points > self.team_b_points else _domain.Team.B

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

    def service_order(self, team: _domain.Team) -> tuple[str, str]:
        return self.service_order_a if team is _domain.Team.A else self.service_order_b

    def next_server_index(self, team: _domain.Team) -> int:
        return self.next_server_index_a if team is _domain.Team.A else self.next_server_index_b

    def expected_next_server(self, team: _domain.Team) -> str:
        return self.service_order(team)[self.next_server_index(team)]


@dataclass(frozen=True, slots=True)
class SetResult:
    set_number: int
    team_a_points: int
    team_b_points: int
    winner: _domain.Team
    unresolved_obligations: frozenset[DomainEffect] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class AppliedEventRecord:
    event_id: str
    fingerprint: str
    event_type: _domain.RuleEventType
    set_number: int
    resolution_rally_id: str | None


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
    match_winner: _domain.Team | None = None
    last_sequence_number: int = 0
    applied_events: tuple[AppliedEventRecord, ...] = ()
    rally_resolutions: tuple[tuple[str, str], ...] = ()

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
    recorded_event: _domain.RuleEvent
    effects: frozenset[DomainEffect]


def initial_state(match_id: str, ruleset: Ruleset) -> MatchState:
    _require_domain_id(match_id, "match_id")
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

    _RESOLUTION_EVENTS = frozenset(
        {
            _domain.RuleEventType.POINT_AWARDED,
            _domain.RuleEventType.REPLAY_NO_POINT,
        }
    )
    def __init__(self, ruleset: Ruleset | None = None) -> None:
        if ruleset is not None and not isinstance(ruleset, Ruleset):
            raise ValueError("ruleset must be a Ruleset")
        self.ruleset = ruleset or Ruleset()

    def new_match(self, match_id: str) -> MatchState:
        return initial_state(match_id, self.ruleset)

    def replay(
        self,
        events: Iterable[_domain.RuleEvent],
        match_id: str | None = None,
    ) -> MatchState:
        event_iterator = iter(events)
        if match_id is None:
            try:
                first_event = next(event_iterator)
            except StopIteration as exc:
                raise RulesError(
                    "match_id is required when replaying an empty log"
                ) from exc
            state = self.new_match(first_event.match_id)
            state = self.reduce(state, first_event).after
        else:
            state = self.new_match(match_id)
        for event in event_iterator:
            state = self.reduce(state, event).after
        return state

    def reduce(self, state: MatchState, event: _domain.RuleEvent) -> Reduction:
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
        if len(state.applied_events) >= self.ruleset.max_events_per_match:
            raise RulesError(
                "match event limit reached; manual takeover and log rollover are required"
            )
        self._validate_sequence(state, event)
        if event.event_type in self._RESOLUTION_EVENTS:
            self._validate_new_rally_resolution(state, event)

        if event.event_type is _domain.RuleEventType.SET_SEED:
            updated = self._apply_set_seed(state, event)
        elif event.event_type is _domain.RuleEventType.POINT_AWARDED:
            updated = self._apply_point(state, event)
        elif event.event_type is _domain.RuleEventType.REPLAY_NO_POINT:
            updated = self._apply_replay_no_point(state, event)
        elif event.event_type is _domain.RuleEventType.SIDE_SWITCH_CONFIRMED:
            updated = self._apply_side_switch(state, event)
        elif event.event_type is _domain.RuleEventType.TECHNICAL_TIMEOUT_COMPLETED:
            updated = self._apply_technical_timeout(state, event)
        else:  # pragma: no cover - Enum exhaustiveness guard
            raise RulesError(f"unsupported rule event type: {event.event_type}")

        resolution_rally_id = self._resolution_rally_id(state, event)
        audited = self._update_resolution_audit(
            updated,
            event,
            resolution_rally_id=resolution_rally_id,
        )
        record = AppliedEventRecord(
            event_id=event.event_id,
            fingerprint=event.fingerprint(),
            event_type=event.event_type,
            set_number=event.set_number,
            resolution_rally_id=resolution_rally_id,
        )
        after = replace(
            audited,
            last_sequence_number=event.sequence_number,
            applied_events=audited.applied_events + (record,),
        )
        effects = self._effects_for_transition(state, after)
        return Reduction(before=state, after=after, recorded_event=event, effects=effects)

    def _validate_identity(self, state: MatchState, event: _domain.RuleEvent) -> None:
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
    def _validate_sequence(state: MatchState, event: _domain.RuleEvent) -> None:
        if event.sequence_number != state.last_sequence_number + 1:
            raise RulesError("rule events must have contiguous sequence numbers")

    @staticmethod
    def _validate_new_rally_resolution(state: MatchState, event: _domain.RuleEvent) -> None:
        if not event.related_rally_id:
            raise RulesError("score/replay events require related_rally_id")
        if not event.payload.evidence_refs:
            raise RulesError("score/replay events require immutable evidence")
        existing = state.rally_resolution(event.related_rally_id)
        if existing is not None:
            raise RulesError(
                f"rally {event.related_rally_id!r} is already resolved by event {existing!r}"
            )

    @staticmethod
    def _resolution_rally_id(state: MatchState, event: _domain.RuleEvent) -> str | None:
        del state
        return event.related_rally_id

    @staticmethod
    def _update_resolution_audit(
        state: MatchState,
        event: _domain.RuleEvent,
        *,
        resolution_rally_id: str | None,
    ) -> MatchState:
        if event.event_type in RulesReducer._RESOLUTION_EVENTS:
            assert resolution_rally_id is not None
            return replace(
                state,
                rally_resolutions=state.rally_resolutions
                + ((resolution_rally_id, event.event_id),),
            )
        return state

    def _apply_set_seed(self, state: MatchState, event: _domain.RuleEvent) -> MatchState:
        payload = cast(_domain.SetSeedPayload, event.payload)
        if state.match_complete:
            raise RulesError("cannot seed another set after match completion")
        if state.current_set is not None and state.current_set.phase is not SetPhase.COMPLETE:
            raise RulesError("cannot seed a new set while the current set is active")

        expected_number = 1 if state.current_set is None else state.current_set.number + 1
        if event.set_number != expected_number:
            raise RulesError(f"expected set {expected_number}, got set {event.set_number}")

        order_a = payload.service_order_a
        order_b = payload.service_order_b
        if len(set(order_a + order_b)) != 4:
            raise RulesError("the four service-order player ids must be unique")
        if state.current_set is not None and (
            frozenset(order_a) != frozenset(state.current_set.service_order_a)
            or frozenset(order_b) != frozenset(state.current_set.service_order_b)
        ):
            raise RulesError("later set service orders must preserve the match roster")

        serving_team = payload.serving_team
        serving_player = payload.serving_player
        if serving_player != (order_a if serving_team is _domain.Team.A else order_b)[0]:
            raise RulesError("serving_player must be first in that team's seeded service order")

        side_a = payload.side_a
        side_b = payload.side_b
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
            next_server_index_a=1 if serving_team is _domain.Team.A else 0,
            next_server_index_b=1 if serving_team is _domain.Team.B else 0,
            side_a=side_a,
            side_b=side_b,
            last_side_switch_total=0,
            technical_timeout_completed=False,
        )
        return replace(state, current_set=set_state)

    def _apply_point(self, state: MatchState, event: _domain.RuleEvent) -> MatchState:
        payload = cast(_domain.PointAwardedPayload, event.payload)
        current = self._active_set(state, event)
        if current.total_points >= _domain.MAX_SEQUENCE_NUMBER:
            raise RulesError("score total exceeds the signed 64-bit operational bound")

        winner = payload.winner_team
        points_a = current.team_a_points + (1 if winner is _domain.Team.A else 0)
        points_b = current.team_b_points + (1 if winner is _domain.Team.B else 0)
        score_only = replace(current, team_a_points=points_a, team_b_points=points_b)
        set_winner = score_only.winner
        if set_winner is not None:
            return self._complete_set(
                state,
                replace(score_only, phase=SetPhase.COMPLETE),
                set_winner,
                unresolved_obligations=current.pending_effects,
            )

        server_changed = winner is not current.serving_team
        derived_serving_player = (
            current.expected_next_server(winner)
            if server_changed
            else current.serving_player
        )

        provisional = replace(
            score_only,
            serving_team=winner,
            serving_player=derived_serving_player,
            next_server_index_a=(
                1 - current.next_server_index_a
                if server_changed and winner is _domain.Team.A
                else current.next_server_index_a
            ),
            next_server_index_b=(
                1 - current.next_server_index_b
                if server_changed and winner is _domain.Team.B
                else current.next_server_index_b
            ),
        )

        return replace(state, current_set=provisional)

    def _apply_replay_no_point(self, state: MatchState, event: _domain.RuleEvent) -> MatchState:
        self._active_set(state, event)
        return state

    def _apply_side_switch(self, state: MatchState, event: _domain.RuleEvent) -> MatchState:
        payload = cast(_domain.SideSwitchConfirmedPayload, event.payload)
        current = self._active_set(state, event)
        if not current.side_switch_due:
            raise RulesError("no side switch is currently due")
        if not payload.evidence_refs:
            raise RulesError("side-switch confirmation requires immutable evidence")
        due_total = payload.due_total
        expected_due = current.last_side_switch_total + current.side_switch_interval
        if due_total != expected_due:
            raise RulesError(f"side-switch due_total must be {expected_due}")
        observed_at = payload.observed_at_total
        if observed_at != current.total_points:
            raise RulesError("side-switch observation is stale for the current score")
        cleared_through = payload.cleared_through_total
        expected_cleared_through = (
            current.total_points // current.side_switch_interval
        ) * current.side_switch_interval
        if cleared_through != expected_cleared_through:
            raise RulesError(
                f"side-switch cleared_through_total must be {expected_cleared_through}"
            )
        side_a = payload.observed_side_a
        side_b = payload.observed_side_b
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

    def _apply_technical_timeout(self, state: MatchState, event: _domain.RuleEvent) -> MatchState:
        payload = cast(_domain.TechnicalTimeoutCompletedPayload, event.payload)
        current = self._active_set(state, event)
        if not current.technical_timeout_due:
            raise RulesError("no technical timeout is currently due")
        if not payload.evidence_refs:
            raise RulesError("technical-timeout completion requires immutable evidence")
        due_total = payload.due_total
        if due_total != current.technical_timeout_total:
            raise RulesError(f"technical-timeout due_total must be {current.technical_timeout_total}")
        observed_at = payload.observed_at_total
        if observed_at != current.total_points:
            raise RulesError("technical-timeout observation is stale for the current score")
        return replace(state, current_set=replace(current, technical_timeout_completed=True))

    def _complete_set(
        self,
        state: MatchState,
        completed: SetState,
        winner: _domain.Team,
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
        sets_a = sum(result.winner is _domain.Team.A for result in completed_sets)
        sets_b = sum(result.winner is _domain.Team.B for result in completed_sets)
        winner: _domain.Team | None = None
        if sets_a >= self.ruleset.sets_to_win:
            winner = _domain.Team.A
        elif sets_b >= self.ruleset.sets_to_win:
            winner = _domain.Team.B
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
        return frozenset(effects)

    @staticmethod
    def _active_set(state: MatchState, event: _domain.RuleEvent) -> SetState:
        current = state.current_set
        if current is None:
            raise RulesError("set must be seeded before applying this event")
        if current.number != event.set_number:
            raise RulesError("event does not target the current set")
        if current.phase is SetPhase.COMPLETE:
            raise RulesError("current set is already complete")
        return current
