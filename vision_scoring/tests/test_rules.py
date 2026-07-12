from __future__ import annotations

import unittest
from dataclasses import replace

from vision_scoring.domain_events import (
    CourtSide,
    PointAwardedPayload,
    ReplayNoPointPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    SideSwitchConfirmedPayload,
    Team,
    TechnicalTimeoutCompletedPayload,
)
from vision_scoring.rules import (
    DomainEffect,
    RulesError,
    RulesReducer,
    Ruleset,
    SetPhase,
)


class ReducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.reducer = RulesReducer()
        self.state = self.reducer.new_match("match-1")
        self.event_counter = 0

    def evidence_refs(self) -> tuple[str, ...]:
        return (f"evidence-{self.event_counter + 1}",)

    def make_event(
        self,
        event_type: RuleEventType,
        payload,
        *,
        set_number: int | None = None,
        event_id: str | None = None,
        sequence_number: int | None = None,
        related_rally_id: str | None = None,
        auto_rally: bool = True,
        ruleset_fingerprint: str | None = None,
    ) -> RuleEvent:
        self.event_counter += 1
        if (
            auto_rally
            and related_rally_id is None
            and event_type
            in {RuleEventType.POINT_AWARDED, RuleEventType.REPLAY_NO_POINT}
        ):
            related_rally_id = f"rally-{self.event_counter}"
        return RuleEvent(
            event_id=event_id or f"event-{self.event_counter}",
            sequence_number=sequence_number or self.state.revision + 1,
            match_id=self.state.match_id,
            set_number=set_number
            or (self.state.current_set.number if self.state.current_set else 1),
            event_type=event_type,
            ruleset_id=self.state.ruleset_id,
            ruleset_version=self.state.ruleset_version,
            ruleset_fingerprint=ruleset_fingerprint or self.state.ruleset_fingerprint,
            payload=payload,
            related_rally_id=related_rally_id,
            created_at_ns=self.event_counter,
        )

    def apply(self, event: RuleEvent):
        reduction = self.reducer.reduce(self.state, event)
        self.state = reduction.after
        return reduction

    def seed(self, serving_team: Team = Team.A, set_number: int = 1):
        player = "a1" if serving_team is Team.A else "b1"
        return self.apply(
            self.make_event(
                RuleEventType.SET_SEED,
                SetSeedPayload(
                    service_order_a=("a1", "a2"),
                    service_order_b=("b1", "b2"),
                    serving_team=serving_team,
                    serving_player=player,
                    side_a=CourtSide.NEAR,
                    side_b=CourtSide.FAR,
                ),
                set_number=set_number,
            )
        )

    def point(self, winner: Team):
        return self.apply(
            self.make_event(
                RuleEventType.POINT_AWARDED,
                PointAwardedPayload(
                    winner_team=winner,
                    evidence_refs=self.evidence_refs(),
                ),
            )
        )

    def advance_to(
        self,
        team_a_points: int,
        team_b_points: int,
        *,
        clear_obligations: bool = True,
    ):
        current = self.state.current_set
        assert current is not None
        if current.team_a_points > team_a_points or current.team_b_points > team_b_points:
            raise AssertionError("advance_to cannot reduce the score")
        last = None
        while True:
            current = self.state.current_set
            assert current is not None
            if current.team_a_points >= team_a_points and current.team_b_points >= team_b_points:
                return last
            if current.team_a_points < team_a_points:
                last = self.point(Team.A)
                if clear_obligations:
                    self.clear_pending_obligations()
            current = self.state.current_set
            assert current is not None
            if current.team_b_points < team_b_points:
                last = self.point(Team.B)
                if clear_obligations:
                    self.clear_pending_obligations()

    def confirm_side_switch(
        self,
        *,
        due_total: int | None = None,
        observed_at_total: int | None = None,
        cleared_through_total: int | None = None,
        observed_side_a: CourtSide | None = None,
        observed_side_b: CourtSide | None = None,
    ):
        current = self.state.current_set
        assert current is not None
        return self.apply(
            self.make_event(
                RuleEventType.SIDE_SWITCH_CONFIRMED,
                SideSwitchConfirmedPayload(
                    due_total=(
                        current.last_side_switch_total + current.side_switch_interval
                        if due_total is None
                        else due_total
                    ),
                    observed_at_total=(
                        current.total_points
                        if observed_at_total is None
                        else observed_at_total
                    ),
                    cleared_through_total=(
                        (current.total_points // current.side_switch_interval)
                        * current.side_switch_interval
                        if cleared_through_total is None
                        else cleared_through_total
                    ),
                    observed_side_a=(
                        current.side_b if observed_side_a is None else observed_side_a
                    ),
                    observed_side_b=(
                        current.side_a if observed_side_b is None else observed_side_b
                    ),
                    evidence_refs=self.evidence_refs(),
                ),
            )
        )

    def complete_technical_timeout(self, *, observed_at_total: int | None = None):
        current = self.state.current_set
        assert current is not None and current.technical_timeout_total is not None
        return self.apply(
            self.make_event(
                RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                TechnicalTimeoutCompletedPayload(
                    due_total=current.technical_timeout_total,
                    observed_at_total=(
                        current.total_points
                        if observed_at_total is None
                        else observed_at_total
                    ),
                    evidence_refs=self.evidence_refs(),
                ),
            )
        )

    def clear_pending_obligations(self) -> None:
        while self.state.current_set and self.state.current_set.pending_effects:
            if DomainEffect.SIDE_SWITCH_DUE in self.state.current_set.pending_effects:
                self.confirm_side_switch()
            if DomainEffect.TECHNICAL_TIMEOUT_DUE in self.state.current_set.pending_effects:
                self.complete_technical_timeout()

    def win_set(self, winner: Team) -> None:
        while self.state.current_set and self.state.current_set.phase is SetPhase.IN_PROGRESS:
            self.point(winner)
            self.clear_pending_obligations()

    def test_service_order_is_derived_and_rotates_only_on_service_gain(self) -> None:
        self.seed()
        current = self.state.current_set
        assert current is not None
        self.assertEqual((current.serving_team, current.serving_player), (Team.A, "a1"))
        self.assertEqual((current.next_server_index_a, current.next_server_index_b), (1, 0))

        self.point(Team.A)
        current = self.state.current_set
        assert current is not None
        self.assertEqual((current.serving_team, current.serving_player), (Team.A, "a1"))
        self.assertEqual((current.next_server_index_a, current.next_server_index_b), (1, 0))

        self.point(Team.B)
        current = self.state.current_set
        assert current is not None
        self.assertEqual((current.serving_team, current.serving_player), (Team.B, "b1"))
        self.assertEqual((current.next_server_index_a, current.next_server_index_b), (1, 1))

        self.point(Team.B)
        self.point(Team.A)
        self.point(Team.B)
        current = self.state.current_set
        assert current is not None
        self.assertEqual((current.serving_team, current.serving_player), (Team.B, "b2"))
        self.assertEqual((current.next_server_index_a, current.next_server_index_b), (0, 0))

    def test_set_seed_contract_rejects_duplicate_and_wrong_first_server(self) -> None:
        with self.assertRaisesRegex(ValueError, "all four player ids"):
            SetSeedPayload(
                service_order_a=("a1", "shared"),
                service_order_b=("shared", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            )

        with self.assertRaisesRegex(ValueError, "must be first"):
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a2",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            )

    def test_later_sets_preserve_stable_rosters_but_may_rotate_order(self) -> None:
        self.seed()
        self.win_set(Team.A)
        rotated = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a2", "a1"),
                service_order_b=("b2", "b1"),
                serving_team=Team.A,
                serving_player="a2",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
            set_number=2,
        )
        self.apply(rotated)
        current = self.state.current_set
        assert current is not None
        self.assertEqual(current.service_order_a, ("a2", "a1"))

        self.win_set(Team.B)
        changed_roster = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("replacement-a", "a1"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="replacement-a",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
            set_number=3,
        )
        with self.assertRaisesRegex(RulesError, "preserve the match roster"):
            self.reducer.reduce(self.state, changed_roster)

    def test_ruleset_and_match_ids_align_with_event_contract_bounds(self) -> None:
        with self.assertRaisesRegex(ValueError, "best_of_sets cannot exceed"):
            Ruleset(best_of_sets=101)
        with self.assertRaisesRegex(ValueError, "printable non-whitespace ASCII"):
            Ruleset(ruleset_id="règles")
        with self.assertRaisesRegex(ValueError, "printable non-whitespace ASCII"):
            self.reducer.new_match("m" * 129)
        with self.assertRaisesRegex(ValueError, "max_events_per_match cannot exceed"):
            Ruleset(max_events_per_match=4_097)

    def test_match_event_bound_fails_to_explicit_manual_takeover(self) -> None:
        self.seed()
        bounded = replace(
            self.state,
            applied_events=self.state.applied_events * 4_096,
        )
        event = self.make_event(
            RuleEventType.POINT_AWARDED,
            PointAwardedPayload(
                winner_team=Team.A,
                evidence_refs=self.evidence_refs(),
            ),
        )
        with self.assertRaisesRegex(RulesError, "manual takeover"):
            self.reducer.reduce(bounded, event)

    def test_side_switch_is_latched_until_its_confirmation_event(self) -> None:
        self.seed()
        self.advance_to(7, 0, clear_obligations=False)
        current = self.state.current_set
        assert current is not None
        self.assertTrue(current.side_switch_due)
        self.assertEqual(current.side_a, CourtSide.NEAR)

        reduction = self.point(Team.A)
        self.assertIn(DomainEffect.SIDE_SWITCH_DUE, reduction.effects)
        self.confirm_side_switch()
        current = self.state.current_set
        assert current is not None
        self.assertEqual(current.side_a, CourtSide.FAR)
        self.assertFalse(current.side_switch_due)

    def test_side_switch_and_timeout_are_independent_simultaneous_effects(self) -> None:
        self.seed()
        self.advance_to(10, 10)
        reduction = self.point(Team.A)
        self.assertEqual(
            reduction.effects,
            frozenset(
                {DomainEffect.SIDE_SWITCH_DUE, DomainEffect.TECHNICAL_TIMEOUT_DUE}
            ),
        )
        self.confirm_side_switch()
        current = self.state.current_set
        assert current is not None
        self.assertFalse(current.side_switch_due)
        self.assertTrue(current.technical_timeout_due)
        self.complete_technical_timeout()
        self.assertFalse(self.state.current_set.technical_timeout_due)

    def test_replay_is_an_audited_no_op(self) -> None:
        self.seed()
        before = self.state
        reduction = self.apply(
            self.make_event(
                RuleEventType.REPLAY_NO_POINT,
                ReplayNoPointPayload(
                    reason="external interference",
                    evidence_refs=self.evidence_refs(),
                ),
            )
        )
        self.assertEqual(before.current_set, self.state.current_set)
        self.assertEqual(self.state.revision, before.revision + 1)
        self.assertEqual(reduction.effects, frozenset())

    def test_a_rally_can_be_resolved_only_once(self) -> None:
        self.seed()
        rally_id = "rally-duplicate"
        self.apply(
            self.make_event(
                RuleEventType.POINT_AWARDED,
                PointAwardedPayload(
                    winner_team=Team.B,
                    evidence_refs=self.evidence_refs(),
                ),
                related_rally_id=rally_id,
            )
        )
        with self.assertRaisesRegex(RulesError, "already resolved"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    PointAwardedPayload(
                        winner_team=Team.A,
                        evidence_refs=self.evidence_refs(),
                    ),
                    related_rally_id=rally_id,
                ),
            )

    def test_replay_then_point_for_same_rally_is_rejected(self) -> None:
        self.seed()
        rally_id = "rally-replay"
        self.apply(
            self.make_event(
                RuleEventType.REPLAY_NO_POINT,
                ReplayNoPointPayload(
                    reason="external interference",
                    evidence_refs=self.evidence_refs(),
                ),
                related_rally_id=rally_id,
            )
        )
        with self.assertRaisesRegex(RulesError, "already resolved"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    PointAwardedPayload(
                        winner_team=Team.B,
                        evidence_refs=self.evidence_refs(),
                    ),
                    related_rally_id=rally_id,
                ),
            )

    def test_stale_side_switch_observation_is_rejected(self) -> None:
        self.seed()
        self.advance_to(7, 0, clear_obligations=False)
        with self.assertRaisesRegex(RulesError, "stale"):
            self.confirm_side_switch(observed_at_total=6)

    def test_no_op_side_switch_mapping_is_rejected(self) -> None:
        self.seed()
        self.advance_to(7, 0, clear_obligations=False)
        current = self.state.current_set
        assert current is not None
        with self.assertRaisesRegex(RulesError, "scheduled switch parity"):
            self.confirm_side_switch(
                observed_side_a=current.side_a,
                observed_side_b=current.side_b,
            )

    def test_side_switch_requires_explicit_cleared_through_boundary(self) -> None:
        self.seed()
        self.advance_to(7, 0, clear_obligations=False)
        with self.assertRaisesRegex(RulesError, "cleared_through_total must be 7"):
            self.confirm_side_switch(cleared_through_total=0)

    def test_late_side_switch_clears_multiple_deadlines_with_parity(self) -> None:
        self.seed()
        self.advance_to(14, 0, clear_obligations=False)
        current = self.state.current_set
        assert current is not None
        self.confirm_side_switch(
            due_total=7,
            cleared_through_total=14,
            observed_side_a=current.side_a,
            observed_side_b=current.side_b,
        )
        current = self.state.current_set
        assert current is not None
        self.assertEqual(current.last_side_switch_total, 14)
        self.assertFalse(current.side_switch_due)

    def test_duplicate_event_is_idempotent_and_conflict_is_rejected(self) -> None:
        event = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
            event_id="seed-fixed",
        )
        self.apply(event)
        revision = self.state.revision
        duplicate = self.reducer.reduce(self.state, event)
        self.assertIs(duplicate.before, duplicate.after)
        self.assertEqual(
            duplicate.effects,
            frozenset({DomainEffect.DUPLICATE_IGNORED}),
        )
        self.assertEqual(self.state.revision, revision)

        conflicting = replace(
            event,
            payload=replace(
                event.payload,
                serving_team=Team.B,
                serving_player="b1",
            ),
        )
        with self.assertRaisesRegex(RulesError, "conflicting content"):
            self.reducer.reduce(self.state, conflicting)

    def test_deuce_and_terminal_point_completion(self) -> None:
        self.seed()
        self.advance_to(20, 20)
        self.point(Team.A)
        self.assertIsNone(self.state.current_set.winner)
        reduction = self.point(Team.A)
        self.assertEqual(self.state.current_set.winner, Team.A)
        self.assertIn(DomainEffect.SET_COMPLETE, reduction.effects)

    def test_terminal_point_needs_no_next_server_input(self) -> None:
        self.seed(serving_team=Team.B)
        self.advance_to(20, 0)
        reduction = self.point(Team.A)
        current = self.state.current_set
        assert current is not None
        self.assertIs(current.phase, SetPhase.COMPLETE)
        self.assertEqual(current.winner, Team.A)
        self.assertIn(DomainEffect.SET_COMPLETE, reduction.effects)

    def test_match_progression_and_deciding_set_rules(self) -> None:
        self.seed(Team.A, 1)
        self.win_set(Team.A)
        self.seed(Team.B, 2)
        self.win_set(Team.B)
        self.seed(Team.A, 3)
        current = self.state.current_set
        assert current is not None
        self.assertEqual(current.target_points, 15)
        self.assertEqual(current.side_switch_interval, 5)
        self.assertIsNone(current.technical_timeout_total)
        self.win_set(Team.A)
        self.assertEqual(self.state.match_winner, Team.A)
        self.assertEqual((self.state.team_a_sets, self.state.team_b_sets), (2, 1))
        self.assertEqual(
            [
                (result.team_a_points, result.team_b_points)
                for result in self.state.completed_sets
            ],
            [(21, 0), (0, 21), (15, 0)],
        )

    def test_terminal_set_snapshots_overdue_obligations(self) -> None:
        self.seed()
        self.advance_to(20, 0, clear_obligations=False)
        reduction = self.point(Team.A)
        result = self.state.completed_sets[-1]
        self.assertEqual(
            result.unresolved_obligations,
            frozenset({DomainEffect.SIDE_SWITCH_DUE}),
        )
        self.assertIn(DomainEffect.SET_CLOSED_WITH_OPEN_OBLIGATIONS, reduction.effects)

    def test_deuce_terminal_snapshots_side_switch_and_timeout_obligations(self) -> None:
        self.seed()
        self.advance_to(20, 20, clear_obligations=False)
        self.point(Team.A)
        reduction = self.point(Team.A)
        result = self.state.completed_sets[-1]
        self.assertEqual(
            result.unresolved_obligations,
            frozenset(
                {
                    DomainEffect.SIDE_SWITCH_DUE,
                    DomainEffect.TECHNICAL_TIMEOUT_DUE,
                }
            ),
        )
        self.assertIn(DomainEffect.SET_CLOSED_WITH_OPEN_OBLIGATIONS, reduction.effects)

    def test_ruleset_fingerprint_mismatch_is_rejected(self) -> None:
        event = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
            ruleset_fingerprint=Ruleset(regular_set_target=19).fingerprint(),
        )
        with self.assertRaisesRegex(RulesError, "fingerprint does not match"):
            self.reducer.reduce(self.state, event)

    def test_reducer_semantics_version_changes_ruleset_fingerprint(self) -> None:
        current = Ruleset()
        changed = Ruleset(reducer_semantics_version="beach-reducer-v3")
        self.assertNotEqual(current.fingerprint(), changed.fingerprint())

    def test_wrong_reducer_rejects_exact_duplicate_before_idempotency(self) -> None:
        event = self.seed().recorded_event
        wrong_reducer = RulesReducer(
            Ruleset(reducer_semantics_version="beach-reducer-incompatible")
        )
        with self.assertRaisesRegex(RulesError, "reducer ruleset does not match"):
            wrong_reducer.reduce(self.state, event)

    def test_replay_fold_reproduces_exact_state(self) -> None:
        events = []
        seed = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
        )
        events.append(seed)
        self.apply(seed)
        point = self.make_event(
            RuleEventType.POINT_AWARDED,
            PointAwardedPayload(
                winner_team=Team.B,
                evidence_refs=self.evidence_refs(),
            ),
        )
        events.append(point)
        self.apply(point)
        replayed = self.reducer.replay(events)
        self.assertEqual(replayed, self.state)

    def test_replay_streams_without_materializing_the_event_log(self) -> None:
        seed = self.make_event(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
        )

        class NoLengthHint:
            def __init__(self, values):
                self._values = iter(values)

            def __iter__(self):
                return self

            def __next__(self):
                return next(self._values)

            def __length_hint__(self):
                raise AssertionError("replay must not preallocate from the log")

        replayed = self.reducer.replay(NoLengthHint((seed,)))
        self.assertEqual(replayed.revision, 1)
        self.assertEqual(replayed.current_set.service_order_a, ("a1", "a2"))


if __name__ == "__main__":
    unittest.main()
