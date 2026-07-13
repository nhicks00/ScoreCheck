import dataclasses
import unittest

from vision_scoring.domain_events import CourtSide, Team
from vision_scoring.hypotheses import (
    EvidenceKind,
    RallyOutcome,
)
from vision_scoring.reconciliation import (
    NextServerObservation,
    NextServerOutcome,
    reconcile_next_server,
)
from vision_scoring.rules import MatchState, SetPhase, SetState

from tests.test_hypotheses import SHA_A, evidence, hypothesis, model


def match_state(
    *,
    revision: int = 3,
    team_a_points: int = 5,
    team_b_points: int = 5,
    last_side_switch_total: int = 7,
    phase: SetPhase = SetPhase.IN_PROGRESS,
) -> MatchState:
    current = SetState(
        number=1,
        target_points=21,
        win_by=2,
        side_switch_interval=7,
        technical_timeout_total=21,
        team_a_points=team_a_points,
        team_b_points=team_b_points,
        service_order_a=("a1", "a2"),
        service_order_b=("b1", "b2"),
        serving_team=Team.A,
        serving_player="a1",
        next_server_index_a=1,
        next_server_index_b=0,
        side_a=CourtSide.NEAR,
        side_b=CourtSide.FAR,
        last_side_switch_total=last_side_switch_total,
        phase=phase,
    )
    return MatchState(
        match_id="match-1",
        ruleset_id="FIVB_BEACH",
        ruleset_version="2025-2028",
        ruleset_fingerprint=SHA_A,
        current_set=current,
        last_sequence_number=revision,
    )


def point_hypothesis(winner: Team, **overrides: object):
    probabilities = {
        RallyOutcome.POINT_TEAM_A: 990_000 if winner is Team.A else 1_000,
        RallyOutcome.POINT_TEAM_B: 990_000 if winner is Team.B else 1_000,
        RallyOutcome.REPLAY_NO_POINT: 5_000,
        RallyOutcome.UNRESOLVED: 4_000,
    }
    return hypothesis(probabilities_ppm=probabilities, **overrides)


def observation(
    team: Team,
    player_id: str,
    *,
    captured_at_ns: int = 150,
    reference: str = "artifact:next-server:1",
    match_id: str = "match-1",
    rally_id: str = "rally-1",
    set_number: int = 1,
    state_revision: int = 3,
) -> NextServerObservation:
    return NextServerObservation(
        match_id=match_id,
        rally_id=rally_id,
        set_number=set_number,
        state_revision=state_revision,
        team=team,
        player_id=player_id,
        probability_ppm=980_000,
        evidence=evidence(
            reference,
            EvidenceKind.NEXT_SERVER,
            captured_at_ns,
        ),
        model=model(),
    )


class NextServerReconciliationTests(unittest.TestCase):
    def test_receiving_team_server_corroborates_an_independent_point(self) -> None:
        result = reconcile_next_server(
            hypothesis=point_hypothesis(Team.B),
            state=match_state(),
            observation=observation(Team.B, "b1"),
        )
        self.assertEqual(result.outcome, NextServerOutcome.CORROBORATES)
        self.assertEqual(result.expected_team, Team.B)
        self.assertEqual(result.expected_player_id, "b1")

    def test_team_contradiction_and_service_order_conflict_are_distinct(self) -> None:
        for observed, expected in (
            (observation(Team.A, "a1"), NextServerOutcome.CONTRADICTS),
            (observation(Team.B, "b2"), NextServerOutcome.SERVICE_ORDER_CONFLICT),
        ):
            with self.subTest(expected=expected):
                result = reconcile_next_server(
                    hypothesis=point_hypothesis(Team.B),
                    state=match_state(),
                    observation=observed,
                )
                self.assertEqual(result.outcome, expected)

    def test_same_server_is_ambiguous_between_point_and_no_point(self) -> None:
        result = reconcile_next_server(
            hypothesis=point_hypothesis(Team.A),
            state=match_state(),
            observation=observation(Team.A, "a1"),
        )
        self.assertEqual(result.outcome, NextServerOutcome.AMBIGUOUS_SAME_SERVER)

    def test_terminal_point_makes_next_server_not_applicable(self) -> None:
        result = reconcile_next_server(
            hypothesis=point_hypothesis(Team.A),
            state=match_state(team_a_points=20, team_b_points=19),
            observation=None,
        )
        self.assertEqual(result.outcome, NextServerOutcome.NOT_APPLICABLE_TERMINAL)
        self.assertIsNone(result.expected_team)

    def test_missing_observation_is_unavailable(self) -> None:
        result = reconcile_next_server(
            hypothesis=point_hypothesis(Team.B),
            state=match_state(),
            observation=None,
        )
        self.assertEqual(result.outcome, NextServerOutcome.UNAVAILABLE)

    def test_later_reconciliation_evidence_advances_its_own_causal_cutoff(self) -> None:
        result = reconcile_next_server(
            hypothesis=point_hypothesis(Team.B),
            state=match_state(),
            observation=observation(Team.B, "b1", captured_at_ns=150),
        )
        self.assertEqual(result.causal_cutoff_timestamp_ns, 150)
        self.assertEqual(result.evidence.captured_at_ns, 150)

    def test_active_set_mismatch_is_rejected(self) -> None:
        state = match_state()
        assert state.current_set is not None
        state = dataclasses.replace(
            state,
            current_set=dataclasses.replace(state.current_set, number=2),
        )
        with self.assertRaisesRegex(ValueError, "active set"):
            reconcile_next_server(
                hypothesis=point_hypothesis(Team.B),
                state=state,
                observation=None,
            )
        with self.assertRaisesRegex(ValueError, "active set"):
            reconcile_next_server(
                hypothesis=point_hypothesis(Team.B),
                state=dataclasses.replace(match_state(), current_set=None),
                observation=None,
            )

    def test_observation_context_and_post_rally_time_are_bound(self) -> None:
        candidate = point_hypothesis(Team.B)
        for changed in (
            observation(Team.B, "b1", match_id="other-match"),
            observation(Team.B, "b1", rally_id="other-rally"),
            observation(Team.B, "b1", set_number=2),
            observation(Team.B, "b1", state_revision=2),
        ):
            with self.subTest(observation=changed):
                with self.assertRaisesRegex(ValueError, "context"):
                    reconcile_next_server(
                        hypothesis=candidate,
                        state=match_state(),
                        observation=changed,
                    )
        with self.assertRaisesRegex(ValueError, "at or after"):
            reconcile_next_server(
                hypothesis=candidate,
                state=match_state(),
                observation=observation(Team.B, "b1", captured_at_ns=99),
            )
if __name__ == "__main__":
    unittest.main()
