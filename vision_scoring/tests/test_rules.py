from __future__ import annotations

import unittest

from vision_scoring import (
    Authority,
    ConfirmationMode,
    CourtSide,
    DomainEffect,
    RuleEvent,
    RuleEventType,
    RulesError,
    RulesReducer,
    Ruleset,
    Team,
)


class ReducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.reducer = RulesReducer()
        self.state = self.reducer.new_match("match-1")
        self.event_counter = 0

    def make_event(
        self,
        event_type: RuleEventType,
        payload: dict,
        *,
        authority: Authority = Authority.OPERATOR,
        set_number: int | None = None,
        event_id: str | None = None,
        sequence_number: int | None = None,
        related_rally_id: str | None = None,
        evidence_refs: tuple[str, ...] | None = None,
        supersedes_event_id: str | None = None,
        reason: str | None = None,
        auto_rally: bool = True,
        ruleset_fingerprint: str | None = None,
    ) -> RuleEvent:
        self.event_counter += 1
        if (
            auto_rally
            and related_rally_id is None
            and event_type
            in {
                RuleEventType.POINT_AWARDED,
                RuleEventType.PENALTY_POINT,
                RuleEventType.SERVICE_ORDER_FAULT,
                RuleEventType.REPLAY_NO_POINT,
            }
        ):
            related_rally_id = f"rally-{self.event_counter}"
        if evidence_refs is None:
            evidence_required = {
                RuleEventType.POINT_AWARDED,
                RuleEventType.PENALTY_POINT,
                RuleEventType.SERVICE_ORDER_FAULT,
                RuleEventType.REPLAY_NO_POINT,
                RuleEventType.SIDE_SWITCH_CONFIRMED,
                RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                RuleEventType.SCORE_CORRECTION,
            }
            evidence_refs = (
                (f"evidence-{self.event_counter}",)
                if event_type in evidence_required or authority is Authority.AUTO_POLICY
                else ()
            )
        if reason is None:
            reason = (
                str(payload["reason"])
                if event_type in {RuleEventType.REPLAY_NO_POINT, RuleEventType.SCORE_CORRECTION}
                else f"test {event_type.value}"
            )
        return RuleEvent(
            event_id=event_id or f"event-{self.event_counter}",
            sequence_number=sequence_number or self.state.revision + 1,
            match_id=self.state.match_id,
            set_number=set_number or (self.state.current_set.number if self.state.current_set else 1),
            event_type=event_type,
            authority=authority,
            actor_id="auto-policy-1" if authority is Authority.AUTO_POLICY else "operator-1",
            authorization_id=f"authorization-{self.event_counter}",
            ruleset_id=self.state.ruleset_id,
            ruleset_version=self.state.ruleset_version,
            ruleset_fingerprint=ruleset_fingerprint or self.state.ruleset_fingerprint,
            payload=payload,
            reason=reason,
            created_at_ns=self.event_counter,
            decision_id=(f"decision-{self.event_counter}" if authority is Authority.AUTO_POLICY else None),
            policy_version=("auto-policy-1" if authority is Authority.AUTO_POLICY else None),
            related_rally_id=related_rally_id,
            evidence_refs=evidence_refs,
            supersedes_event_id=supersedes_event_id,
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
                {
                    "service_order_a": ["a1", "a2"],
                    "service_order_b": ["b1", "b2"],
                    "serving_team": serving_team.value,
                    "serving_player": player,
                    "side_a": CourtSide.NEAR.value,
                    "side_b": CourtSide.FAR.value,
                },
                set_number=set_number,
            )
        )

    def point(
        self,
        winner: Team,
        player: str,
        *,
        authority: Authority = Authority.OPERATOR,
        auto: bool = False,
    ):
        current = self.state.current_set
        assert current is not None
        projected_a = current.team_a_points + (1 if winner is Team.A else 0)
        projected_b = current.team_b_points + (1 if winner is Team.B else 0)
        target_reached = max(projected_a, projected_b) >= current.target_points
        terminal = target_reached and abs(projected_a - projected_b) >= current.win_by
        payload = {
            "winner_team": winner.value,
            "confirmation_mode": (
                ConfirmationMode.SERVER_CHANGE.value if auto else ConfirmationMode.HUMAN.value
            ),
        }
        if not terminal:
            payload["next_serving_player"] = player
        return self.apply(
            self.make_event(
                RuleEventType.POINT_AWARDED,
                payload,
                authority=authority,
            )
        )

    def award_next(self, winner: Team):
        current = self.state.current_set
        assert current is not None
        player = (
            current.serving_player
            if current.serving_team is winner
            else current.expected_next_server(winner)
        )
        return self.point(winner, player)

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
                last = self.award_next(Team.A)
                if clear_obligations:
                    self.clear_pending_obligations()
            current = self.state.current_set
            assert current is not None
            if current.team_b_points < team_b_points:
                last = self.award_next(Team.B)
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
                {
                    "due_total": (
                        current.last_side_switch_total + current.side_switch_interval
                        if due_total is None
                        else due_total
                    ),
                    "observed_at_total": (
                        current.total_points
                        if observed_at_total is None
                        else observed_at_total
                    ),
                    "cleared_through_total": (
                        (
                            current.total_points // current.side_switch_interval
                        )
                        * current.side_switch_interval
                        if cleared_through_total is None
                        else cleared_through_total
                    ),
                    "observed_side_a": (
                        current.side_b.value
                        if observed_side_a is None
                        else observed_side_a.value
                    ),
                    "observed_side_b": (
                        current.side_a.value
                        if observed_side_b is None
                        else observed_side_b.value
                    ),
                },
            )
        )

    def complete_technical_timeout(self, *, observed_at_total: int | None = None):
        current = self.state.current_set
        assert current is not None and current.technical_timeout_total is not None
        return self.apply(
            self.make_event(
                RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                {
                    "due_total": current.technical_timeout_total,
                    "observed_at_total": (
                        current.total_points
                        if observed_at_total is None
                        else observed_at_total
                    ),
                },
            )
        )

    def clear_pending_obligations(self) -> None:
        while self.state.current_set and self.state.current_set.pending_effects:
            if DomainEffect.SIDE_SWITCH_DUE in self.state.current_set.pending_effects:
                self.confirm_side_switch()
            if DomainEffect.TECHNICAL_TIMEOUT_DUE in self.state.current_set.pending_effects:
                self.complete_technical_timeout()

    def win_set(self, winner: Team) -> None:
        assert self.state.current_set is not None
        player = self.state.current_set.serving_player
        if self.state.current_set.serving_team is not winner:
            player = self.state.current_set.expected_next_server(winner)
            self.point(winner, player)
            self.clear_pending_obligations()
        while self.state.current_set and self.state.current_set.phase.value == "IN_PROGRESS":
            self.point(winner, self.state.current_set.serving_player)
            self.clear_pending_obligations()

    def correction_payload(self, **overrides):
        current = self.state.current_set
        assert current is not None
        payload = {
            "reason": "scorekeeper correction",
            "team_a_points": current.team_a_points,
            "team_b_points": current.team_b_points,
            "serving_team": current.serving_team.value,
            "serving_player": current.serving_player,
            "next_server_index_a": current.next_server_index_a,
            "next_server_index_b": current.next_server_index_b,
            "side_a": current.side_a.value,
            "side_b": current.side_b.value,
            "last_side_switch_total": current.last_side_switch_total,
            "technical_timeout_completed": current.technical_timeout_completed,
        }
        payload.update(overrides)
        return payload

    def test_server_change_is_only_initial_automatic_point_path(self) -> None:
        self.seed()
        reduction = self.point(Team.B, "b1", authority=Authority.AUTO_POLICY, auto=True)
        self.assertEqual((self.state.current_set.team_a_points, self.state.current_set.team_b_points), (0, 1))
        self.assertEqual(self.state.current_set.serving_player, "b1")
        self.assertEqual(reduction.effects, frozenset())

        with self.assertRaisesRegex(RulesError, "same-team next serve is ambiguous"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": Team.B.value,
                        "next_serving_player": "b1",
                        "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                    },
                    authority=Authority.AUTO_POLICY,
                ),
            )

    def test_service_order_alternates_only_when_team_regains_service(self) -> None:
        self.seed()
        self.point(Team.B, "b1")
        self.point(Team.B, "b1")
        self.point(Team.A, "a2")
        self.point(Team.B, "b2")
        self.assertEqual(self.state.current_set.serving_player, "b2")
        with self.assertRaisesRegex(RulesError, "expected 'a1'"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a2",
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                ),
            )

    def test_side_switch_is_pending_until_authorized_confirmation(self) -> None:
        self.seed()
        for _ in range(7):
            self.point(Team.A, "a1")
        self.assertTrue(self.state.current_set.side_switch_due)
        self.assertEqual(self.state.current_set.side_a, CourtSide.NEAR)
        with self.assertRaisesRegex(RulesError, "automatic scoring.*SIDE_SWITCH_DUE"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a1",
                        "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                    },
                    authority=Authority.AUTO_POLICY,
                ),
            )
        self.confirm_side_switch()
        self.assertEqual(self.state.current_set.side_a, CourtSide.FAR)
        self.assertFalse(self.state.current_set.side_switch_due)

    def test_side_switch_and_technical_timeout_are_simultaneous_effects(self) -> None:
        self.seed()
        self.advance_to(10, 10)
        reduction = self.award_next(Team.A)
        self.assertEqual(
            reduction.effects,
            frozenset({DomainEffect.SIDE_SWITCH_DUE, DomainEffect.TECHNICAL_TIMEOUT_DUE}),
        )
        self.confirm_side_switch()
        with self.assertRaisesRegex(RulesError, "automatic scoring.*TECHNICAL_TIMEOUT_DUE"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "B",
                        "next_serving_player": "b1",
                        "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                    },
                    authority=Authority.AUTO_POLICY,
                ),
            )
        self.complete_technical_timeout()
        self.award_next(Team.A)

    def test_replay_is_audited_no_op(self) -> None:
        self.seed()
        before = self.state
        reduction = self.apply(
            self.make_event(RuleEventType.REPLAY_NO_POINT, {"reason": "double fault"})
        )
        self.assertEqual(before.current_set, self.state.current_set)
        self.assertEqual(self.state.revision, before.revision + 1)
        self.assertEqual(reduction.effects, frozenset())

    def test_duplicate_rally_point_with_new_event_id_is_rejected(self) -> None:
        self.seed()
        rally_id = "rally-duplicate"
        self.apply(
            self.make_event(
                RuleEventType.POINT_AWARDED,
                {
                    "winner_team": "B",
                    "next_serving_player": "b1",
                    "confirmation_mode": ConfirmationMode.HUMAN.value,
                },
                related_rally_id=rally_id,
            )
        )
        with self.assertRaisesRegex(RulesError, "already resolved"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a2",
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                    related_rally_id=rally_id,
                ),
            )

    def test_replay_then_point_for_same_rally_is_rejected(self) -> None:
        self.seed()
        rally_id = "rally-replay"
        self.apply(
            self.make_event(
                RuleEventType.REPLAY_NO_POINT,
                {"reason": "external interference"},
                related_rally_id=rally_id,
            )
        )
        with self.assertRaisesRegex(RulesError, "already resolved"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "B",
                        "next_serving_player": "b1",
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                    related_rally_id=rally_id,
                ),
            )

    def test_service_fault_then_point_for_same_rally_is_rejected(self) -> None:
        self.seed()
        rally_id = "rally-service-fault"
        fault = self.make_event(
            RuleEventType.SERVICE_ORDER_FAULT,
            {
                "winner_team": "B",
                "next_serving_player": "b1",
                "confirmation_mode": ConfirmationMode.REFEREE_FEED.value,
            },
            authority=Authority.REFEREE_FEED,
            related_rally_id=rally_id,
        )
        self.apply(fault)
        self.assertEqual(self.state.rally_resolution(rally_id), fault.event_id)

        with self.assertRaisesRegex(RulesError, "already resolved"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a2",
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                    related_rally_id=rally_id,
                ),
            )

    def test_point_without_rally_id_is_rejected(self) -> None:
        self.seed()
        event = self.make_event(
            RuleEventType.POINT_AWARDED,
            {
                "winner_team": "B",
                "next_serving_player": "b1",
                "confirmation_mode": ConfirmationMode.HUMAN.value,
            },
            auto_rally=False,
            evidence_refs=("observation-missing-rally",),
        )
        with self.assertRaisesRegex(RulesError, "require related_rally_id"):
            self.reducer.reduce(self.state, event)

    def test_authoritative_point_and_sanction_survive_overdue_side_switch(self) -> None:
        self.seed()
        for _ in range(7):
            self.point(Team.A, "a1")
        self.assertTrue(self.state.current_set.side_switch_due)

        self.point(Team.A, "a1")
        sanction = self.apply(
            self.make_event(
                RuleEventType.PENALTY_POINT,
                {
                    "winner_team": "B",
                    "next_serving_player": "b1",
                    "confirmation_mode": ConfirmationMode.REFEREE_FEED.value,
                },
                authority=Authority.REFEREE_FEED,
            )
        )

        self.assertEqual(
            (self.state.current_set.team_a_points, self.state.current_set.team_b_points),
            (8, 1),
        )
        self.assertIn(DomainEffect.SIDE_SWITCH_DUE, sanction.effects)

    def test_stale_side_switch_observation_is_rejected(self) -> None:
        self.seed()
        for _ in range(7):
            self.point(Team.A, "a1")
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

    def test_late_side_switch_confirmation_clears_multiple_deadlines_with_parity(self) -> None:
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
        self.assertEqual(self.state.current_set.last_side_switch_total, 14)
        self.assertFalse(self.state.current_set.side_switch_due)

    def test_administrative_point_requires_human_authority(self) -> None:
        self.seed()
        event = self.make_event(
            RuleEventType.PENALTY_POINT,
            {
                "winner_team": "B",
                "next_serving_player": "b1",
                "confirmation_mode": ConfirmationMode.REFEREE_FEED.value,
            },
            authority=Authority.REFEREE_FEED,
        )
        reduction = self.apply(event)
        self.assertEqual(self.state.current_set.team_b_points, 1)
        self.assertEqual(reduction.recorded_event.event_type, RuleEventType.PENALTY_POINT)
        self.assertEqual(self.state.rally_resolution(event.related_rally_id), event.event_id)
        with self.assertRaisesRegex(RulesError, "AUTO_POLICY may not issue"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SERVICE_ORDER_FAULT,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a2",
                        "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                    },
                    authority=Authority.AUTO_POLICY,
                ),
            )

    def test_duplicate_event_is_idempotent_and_conflict_is_rejected(self) -> None:
        event = self.make_event(
            RuleEventType.SET_SEED,
            {
                "service_order_a": ["a1", "a2"],
                "service_order_b": ["b1", "b2"],
                "serving_team": "A",
                "serving_player": "a1",
                "side_a": "NEAR",
                "side_b": "FAR",
            },
            event_id="seed-fixed",
        )
        self.apply(event)
        revision = self.state.revision
        duplicate = self.reducer.reduce(self.state, event)
        self.assertIs(duplicate.before, duplicate.after)
        self.assertEqual(duplicate.effects, frozenset({DomainEffect.DUPLICATE_IGNORED}))
        self.assertEqual(self.state.revision, revision)

        conflicting = RuleEvent(
            event_id=event.event_id,
            sequence_number=event.sequence_number,
            match_id=event.match_id,
            set_number=event.set_number,
            event_type=event.event_type,
            authority=event.authority,
            actor_id=event.actor_id,
            authorization_id=event.authorization_id,
            ruleset_id=event.ruleset_id,
            ruleset_version=event.ruleset_version,
            ruleset_fingerprint=event.ruleset_fingerprint,
            payload={**dict(event.payload), "serving_team": "B", "serving_player": "b1"},
            reason=event.reason,
            created_at_ns=event.created_at_ns,
        )
        with self.assertRaisesRegex(RulesError, "conflicting content"):
            self.reducer.reduce(self.state, conflicting)

    def test_deuce_and_human_terminal_authorization(self) -> None:
        self.seed()
        self.advance_to(20, 20)
        self.award_next(Team.A)
        self.assertIsNone(self.state.current_set.winner)
        reduction = self.award_next(Team.A)
        self.assertEqual(self.state.current_set.winner, Team.A)
        self.assertIn(DomainEffect.SET_COMPLETE, reduction.effects)

    def test_automatic_terminal_point_is_blocked(self) -> None:
        self.seed(serving_team=Team.B)
        self.advance_to(20, 0)
        with self.assertRaisesRegex(RulesError, "set- or match-ending"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "A",
                        "next_serving_player": "a1",
                        "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                    },
                    authority=Authority.AUTO_POLICY,
                    related_rally_id="terminal-rally",
                    evidence_refs=("obs-terminal",),
                ),
            )

    def test_match_progression_and_deciding_set_rules(self) -> None:
        self.seed(Team.A, 1)
        self.win_set(Team.A)
        self.seed(Team.B, 2)
        self.win_set(Team.B)
        self.seed(Team.A, 3)
        self.assertEqual(self.state.current_set.target_points, 15)
        self.assertEqual(self.state.current_set.side_switch_interval, 5)
        self.assertIsNone(self.state.current_set.technical_timeout_total)
        self.win_set(Team.A)
        self.assertEqual(self.state.match_winner, Team.A)
        self.assertEqual((self.state.team_a_sets, self.state.team_b_sets), (2, 1))
        self.assertEqual(
            [(result.team_a_points, result.team_b_points) for result in self.state.completed_sets],
            [(21, 0), (0, 21), (15, 0)],
        )

    def test_correction_is_compensating_and_can_reopen_latest_set(self) -> None:
        self.seed()
        self.win_set(Team.A)
        terminal_record = self.state.applied_events[-1]
        reduction = self.apply(
            self.make_event(
                RuleEventType.SCORE_CORRECTION,
                self.correction_payload(
                    team_a_points=20,
                    team_b_points=20,
                    last_side_switch_total=35,
                    technical_timeout_completed=True,
                ),
                supersedes_event_id=terminal_record.event_id,
                related_rally_id=terminal_record.related_rally_id,
            )
        )
        self.assertEqual(self.state.current_set.phase.value, "IN_PROGRESS")
        self.assertEqual(self.state.completed_sets, ())
        self.assertEqual(self.state.team_a_sets, 0)
        self.assertIn(DomainEffect.SCORE_CORRECTION_APPLIED, reduction.effects)
        self.assertIn(DomainEffect.SET_REOPENED, reduction.effects)

    def test_correction_rejects_nonlatest_target(self) -> None:
        self.seed()
        target = self.award_next(Team.B).recorded_event
        self.award_next(Team.A)
        with self.assertRaisesRegex(RulesError, "latest applied event"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(),
                    supersedes_event_id=target.event_id,
                    related_rally_id=target.related_rally_id,
                ),
            )

    def test_correction_rejects_repeated_target(self) -> None:
        self.seed()
        target = self.award_next(Team.B).recorded_event
        self.apply(
            self.make_event(
                RuleEventType.SCORE_CORRECTION,
                self.correction_payload(),
                supersedes_event_id=target.event_id,
                related_rally_id=target.related_rally_id,
            )
        )
        with self.assertRaisesRegex(RulesError, "latest applied event|already been superseded"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(),
                    supersedes_event_id=target.event_id,
                    related_rally_id=target.related_rally_id,
                ),
            )

    def test_correction_rejects_service_index_and_premature_timeout(self) -> None:
        self.seed()
        target = self.award_next(Team.B).recorded_event
        with self.assertRaisesRegex(RulesError, "next-server index conflicts"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(next_server_index_b=0),
                    supersedes_event_id=target.event_id,
                    related_rally_id=target.related_rally_id,
                ),
            )

        with self.assertRaisesRegex(RulesError, "cannot be complete below"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(technical_timeout_completed=True),
                    supersedes_event_id=target.event_id,
                    related_rally_id=target.related_rally_id,
                ),
            )

    def test_correction_requires_matching_top_level_reason(self) -> None:
        self.seed()
        target = self.award_next(Team.B).recorded_event
        event = self.make_event(
            RuleEventType.SCORE_CORRECTION,
            self.correction_payload(),
            supersedes_event_id=target.event_id,
            related_rally_id=target.related_rally_id,
            reason="different top-level reason",
        )
        with self.assertRaisesRegex(RulesError, "payload reason must match"):
            self.reducer.reduce(self.state, event)

    def test_correction_rejects_unreachable_terminal_score(self) -> None:
        self.seed()
        target = self.advance_to(20, 0).recorded_event
        with self.assertRaisesRegex(RulesError, "cannot be reached"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(team_a_points=22, team_b_points=0),
                    supersedes_event_id=target.event_id,
                    related_rally_id=target.related_rally_id,
                ),
            )

    def test_correction_cannot_claim_operations_at_the_terminal_point(self) -> None:
        self.seed()
        target = self.advance_to(20, 0).recorded_event
        cases = (
            (
                "last_side_switch_total is inconsistent",
                {"team_a_points": 21, "last_side_switch_total": 21},
            ),
            (
                "terminal point",
                {
                    "team_a_points": 21,
                    "last_side_switch_total": 14,
                    "technical_timeout_completed": True,
                },
            ),
        )
        for message, overrides in cases:
            with self.subTest(message=message), self.assertRaisesRegex(RulesError, message):
                self.reducer.reduce(
                    self.state,
                    self.make_event(
                        RuleEventType.SCORE_CORRECTION,
                        self.correction_payload(**overrides),
                        supersedes_event_id=target.event_id,
                        related_rally_id=target.related_rally_id,
                    ),
                )

    def test_terminal_point_rejects_a_next_server_payload(self) -> None:
        self.seed()
        self.advance_to(20, 0)
        current = self.state.current_set
        assert current is not None
        with self.assertRaisesRegex(RulesError, "must omit next_serving_player"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": Team.A.value,
                        "next_serving_player": current.serving_player,
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                ),
            )

    def test_correction_rejects_unrelated_latest_event(self) -> None:
        self.seed()
        self.advance_to(7, 0)
        target = self.state.applied_events[-1]
        self.assertEqual(target.event_type, RuleEventType.SIDE_SWITCH_CONFIRMED)
        with self.assertRaisesRegex(RulesError, "score/replay resolution event"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.SCORE_CORRECTION,
                    self.correction_payload(),
                    supersedes_event_id=target.event_id,
                ),
            )

    def test_correction_can_target_latest_correction_in_same_rally(self) -> None:
        self.seed()
        target = self.award_next(Team.B).recorded_event
        first = self.make_event(
            RuleEventType.SCORE_CORRECTION,
            self.correction_payload(),
            supersedes_event_id=target.event_id,
            related_rally_id=target.related_rally_id,
        )
        self.apply(first)
        second = self.make_event(
            RuleEventType.SCORE_CORRECTION,
            self.correction_payload(),
            supersedes_event_id=first.event_id,
            related_rally_id=first.related_rally_id,
        )
        reduction = self.apply(second)
        self.assertIn(DomainEffect.SCORE_CORRECTION_APPLIED, reduction.effects)
        self.assertEqual(self.state.rally_resolution(first.related_rally_id), second.event_id)

    def test_correction_emits_set_result_changed(self) -> None:
        self.seed()
        self.win_set(Team.A)
        target = self.state.applied_events[-1]
        reduction = self.apply(
            self.make_event(
                RuleEventType.SCORE_CORRECTION,
                self.correction_payload(
                    team_a_points=0,
                    team_b_points=21,
                    serving_team="B",
                    serving_player="b1",
                    next_server_index_b=1,
                ),
                supersedes_event_id=target.event_id,
                related_rally_id=target.related_rally_id,
            )
        )
        self.assertIn(DomainEffect.SCORE_CORRECTION_APPLIED, reduction.effects)
        self.assertIn(DomainEffect.SET_RESULT_CHANGED, reduction.effects)
        self.assertEqual(self.state.completed_sets[-1].winner, Team.B)

    def test_correction_emits_match_reopened(self) -> None:
        self.seed(Team.A, 1)
        self.win_set(Team.A)
        self.seed(Team.A, 2)
        self.win_set(Team.A)
        target = self.state.applied_events[-1]
        reduction = self.apply(
            self.make_event(
                RuleEventType.SCORE_CORRECTION,
                self.correction_payload(
                    team_a_points=20,
                    team_b_points=20,
                    last_side_switch_total=35,
                    technical_timeout_completed=True,
                ),
                supersedes_event_id=target.event_id,
                related_rally_id=target.related_rally_id,
            )
        )
        self.assertIn(DomainEffect.MATCH_REOPENED, reduction.effects)
        self.assertIsNone(self.state.match_winner)

    def test_correction_emits_match_result_changed(self) -> None:
        self.seed(Team.A, 1)
        self.win_set(Team.A)
        self.seed(Team.B, 2)
        self.win_set(Team.B)
        self.seed(Team.A, 3)
        self.win_set(Team.A)
        target = self.state.applied_events[-1]
        reduction = self.apply(
            self.make_event(
                RuleEventType.SCORE_CORRECTION,
                self.correction_payload(
                    team_a_points=0,
                    team_b_points=15,
                    serving_team="B",
                    serving_player="b1",
                    next_server_index_b=1,
                ),
                supersedes_event_id=target.event_id,
                related_rally_id=target.related_rally_id,
            )
        )
        self.assertIn(DomainEffect.SET_RESULT_CHANGED, reduction.effects)
        self.assertIn(DomainEffect.MATCH_RESULT_CHANGED, reduction.effects)
        self.assertEqual(self.state.match_winner, Team.B)

    def test_terminal_set_snapshots_overdue_obligations(self) -> None:
        self.seed()
        self.advance_to(20, 0, clear_obligations=False)
        reduction = self.award_next(Team.A)
        result = self.state.completed_sets[-1]
        self.assertEqual(
            result.unresolved_obligations,
            frozenset({DomainEffect.SIDE_SWITCH_DUE}),
        )
        self.assertIn(DomainEffect.SET_CLOSED_WITH_OPEN_OBLIGATIONS, reduction.effects)

    def test_deuce_terminal_snapshots_side_switch_and_timeout_obligations(self) -> None:
        self.seed()
        self.advance_to(20, 20, clear_obligations=False)
        self.award_next(Team.A)
        reduction = self.award_next(Team.A)
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
            {
                "service_order_a": ["a1", "a2"],
                "service_order_b": ["b1", "b2"],
                "serving_team": "A",
                "serving_player": "a1",
                "side_a": "NEAR",
                "side_b": "FAR",
            },
            ruleset_fingerprint=Ruleset(regular_set_target=19).fingerprint(),
        )
        with self.assertRaisesRegex(RulesError, "fingerprint does not match"):
            self.reducer.reduce(self.state, event)

    def test_reducer_semantics_version_changes_ruleset_fingerprint(self) -> None:
        current = Ruleset()
        changed = Ruleset(reducer_semantics_version="beach-reducer-v2")
        self.assertNotEqual(current.fingerprint(), changed.fingerprint())

    def test_wrong_reducer_rejects_exact_duplicate_before_idempotency(self) -> None:
        event = self.seed().recorded_event
        wrong_reducer = RulesReducer(
            Ruleset(reducer_semantics_version="beach-reducer-incompatible")
        )
        with self.assertRaisesRegex(RulesError, "reducer ruleset does not match"):
            wrong_reducer.reduce(self.state, event)

    def test_event_authority_and_confirmation_mode_matrix(self) -> None:
        auto_seed = self.make_event(
            RuleEventType.SET_SEED,
            {
                "service_order_a": ["a1", "a2"],
                "service_order_b": ["b1", "b2"],
                "serving_team": "A",
                "serving_player": "a1",
                "side_a": "NEAR",
                "side_b": "FAR",
            },
            authority=Authority.AUTO_POLICY,
        )
        with self.assertRaisesRegex(RulesError, "AUTO_POLICY may not issue SET_SEED"):
            self.reducer.reduce(self.state, auto_seed)

        self.seed()
        with self.assertRaisesRegex(RulesError, "referee-feed points require"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "B",
                        "next_serving_player": "b1",
                        "confirmation_mode": ConfirmationMode.HUMAN.value,
                    },
                    authority=Authority.REFEREE_FEED,
                ),
            )
        with self.assertRaisesRegex(RulesError, "require HUMAN confirmation"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.POINT_AWARDED,
                    {
                        "winner_team": "B",
                        "next_serving_player": "b1",
                        "confirmation_mode": ConfirmationMode.REFEREE_FEED.value,
                    },
                    authority=Authority.OPERATOR,
                ),
            )
        with self.assertRaisesRegex(RulesError, "AUTO_POLICY may not issue REPLAY_NO_POINT"):
            self.reducer.reduce(
                self.state,
                self.make_event(
                    RuleEventType.REPLAY_NO_POINT,
                    {"reason": "external interference"},
                    authority=Authority.AUTO_POLICY,
                ),
            )

    def test_replay_fold_reproduces_exact_state(self) -> None:
        events = []
        seed = self.make_event(
            RuleEventType.SET_SEED,
            {
                "service_order_a": ["a1", "a2"],
                "service_order_b": ["b1", "b2"],
                "serving_team": "A",
                "serving_player": "a1",
                "side_a": "NEAR",
                "side_b": "FAR",
            },
        )
        events.append(seed)
        self.apply(seed)
        point = self.make_event(
            RuleEventType.POINT_AWARDED,
            {
                "winner_team": "B",
                "next_serving_player": "b1",
                "confirmation_mode": ConfirmationMode.HUMAN.value,
            },
        )
        events.append(point)
        self.apply(point)
        replayed = self.reducer.replay(events)
        self.assertEqual(replayed, self.state)


if __name__ == "__main__":
    unittest.main()
