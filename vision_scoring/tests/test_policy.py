import dataclasses
import unittest

import vision_scoring.policy as policy_module
from vision_scoring.domain_events import Team
from vision_scoring.hypotheses import (
    EvidenceKind,
    ExceptionSignal,
    RallyOutcome,
)
from vision_scoring.policy import (
    PolicyAssessmentStatus,
    PolicyConfig,
    PolicyReason,
    ScoringIntentKind,
    assess_hypothesis,
)
from vision_scoring.reconciliation import NextServerOutcome, reconcile_next_server

from tests.test_hypotheses import evidence, hypothesis
from tests.test_reconciliation import match_state, observation, point_hypothesis


CONFIG = PolicyConfig(
    policy_version="policy-v1",
    human_authorization_threshold_ppm=950_000,
    review_threshold_ppm=700_000,
    minimum_reconciliation_probability_ppm=900_000,
)


class PolicyAssessmentTests(unittest.TestCase):
    def test_high_confidence_primary_evidence_requires_separate_human_authorization(self) -> None:
        candidate = point_hypothesis(Team.B)
        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
        )

        self.assertEqual(
            assessment.status,
            PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
        )
        self.assertEqual(assessment.recommended_intent.kind, ScoringIntentKind.AWARD_POINT)
        self.assertEqual(assessment.recommended_intent.winner_team, Team.B)
        self.assertEqual(assessment.policy_fingerprint, CONFIG.fingerprint())
        self.assertFalse(hasattr(policy_module, "RuleEvent"))

    def test_policy_fingerprint_binds_every_threshold(self) -> None:
        candidate = point_hypothesis(Team.B)
        baseline = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
        )
        for field_name in (
            "human_authorization_threshold_ppm",
            "review_threshold_ppm",
            "minimum_reconciliation_probability_ppm",
        ):
            changed_config = dataclasses.replace(
                CONFIG,
                **{field_name: getattr(CONFIG, field_name) - 1},
            )
            with self.subTest(field_name=field_name):
                changed = assess_hypothesis(
                    hypothesis=candidate,
                    state=match_state(),
                    config=changed_config,
                )
                self.assertNotEqual(CONFIG.fingerprint(), changed_config.fingerprint())
                self.assertEqual(
                    changed.policy_fingerprint,
                    changed_config.fingerprint(),
                )
                self.assertNotEqual(baseline.fingerprint(), changed.fingerprint())
        with self.assertRaisesRegex(ValueError, "policy_fingerprint"):
            dataclasses.replace(baseline, policy_fingerprint="not-a-sha256")
        with self.assertRaisesRegex(ValueError, "exception or review reasons"):
            dataclasses.replace(
                baseline,
                reasons=(
                    PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,
                    PolicyReason.CAPTURE_GAP,
                ),
            )
        with self.assertRaisesRegex(ValueError, "contradictory reconciliation"):
            dataclasses.replace(
                baseline,
                reconciliation_outcome=NextServerOutcome.CONTRADICTS,
                reconciliation_fingerprint="a" * 64,
            )

    def test_assessment_evidence_references_have_canonical_set_order(self) -> None:
        candidate = point_hypothesis(
            Team.B,
            evidence=(
                evidence("artifact:evidence:z", EvidenceKind.FUSED_RALLY),
                evidence("artifact:evidence:a", EvidenceKind.AUDIO),
            ),
        )
        baseline = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
        )
        changed_order = dataclasses.replace(
            baseline,
            evidence_refs=tuple(reversed(baseline.evidence_refs)),
        )
        self.assertEqual(changed_order.evidence_refs, baseline.evidence_refs)
        self.assertEqual(changed_order.fingerprint(), baseline.fingerprint())

    def test_corroboration_cannot_upgrade_medium_confidence_primary_evidence(self) -> None:
        candidate = hypothesis(
            probabilities_ppm={
                RallyOutcome.POINT_TEAM_A: 100_000,
                RallyOutcome.POINT_TEAM_B: 800_000,
                RallyOutcome.REPLAY_NO_POINT: 50_000,
                RallyOutcome.UNRESOLVED: 50_000,
            }
        )
        reconciliation = reconcile_next_server(
            hypothesis=candidate,
            state=match_state(),
            observation=observation(Team.B, "b1"),
        )
        self.assertEqual(reconciliation.outcome.value, "CORROBORATES")

        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
            reconciliation=reconciliation,
        )
        self.assertEqual(assessment.status, PolicyAssessmentStatus.REVIEW_REQUIRED)
        self.assertIn(PolicyReason.INSUFFICIENT_CONFIDENCE, assessment.reasons)

    def test_same_server_reconciliation_remains_explicitly_ambiguous(self) -> None:
        candidate = point_hypothesis(Team.A)
        reconciliation = reconcile_next_server(
            hypothesis=candidate,
            state=match_state(),
            observation=observation(Team.A, "a1"),
        )
        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
            reconciliation=reconciliation,
        )
        self.assertEqual(reconciliation.outcome.value, "AMBIGUOUS_SAME_SERVER")
        self.assertEqual(
            assessment.status,
            PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
        )
        self.assertIn(PolicyReason.NEXT_SERVER_AMBIGUOUS, assessment.reasons)

    def test_fatal_exception_signals_fail_unresolved_before_winner_policy(self) -> None:
        for signal, reason in (
            (ExceptionSignal.CAPTURE_GAP, PolicyReason.CAPTURE_GAP),
            (ExceptionSignal.RULES_CONFLICT, PolicyReason.RULES_CONFLICT),
        ):
            with self.subTest(signal=signal):
                assessment = assess_hypothesis(
                    hypothesis=point_hypothesis(
                        Team.B,
                        exception_signals=(signal,),
                    ),
                    state=match_state(),
                    config=CONFIG,
                )
                self.assertEqual(
                    assessment.status,
                    PolicyAssessmentStatus.UNRESOLVED,
                )
                self.assertIn(reason, assessment.reasons)
                self.assertIsNone(assessment.recommended_intent)

    def test_review_exception_signals_never_reach_authorization(self) -> None:
        signals = (
            ExceptionSignal.REPLAY_NO_POINT,
            ExceptionSignal.CHALLENGE,
            ExceptionSignal.CORRECTION,
            ExceptionSignal.ADMINISTRATIVE_POINT,
            ExceptionSignal.TIMEOUT,
            ExceptionSignal.SIDE_SWITCH,
        )
        for signal in signals:
            with self.subTest(signal=signal):
                assessment = assess_hypothesis(
                    hypothesis=point_hypothesis(
                        Team.B,
                        exception_signals=(signal,),
                    ),
                    state=match_state(),
                    config=CONFIG,
                )
                self.assertEqual(
                    assessment.status,
                    PolicyAssessmentStatus.REVIEW_REQUIRED,
                )

    def test_stale_state_and_pending_obligations_fail_closed(self) -> None:
        stale = assess_hypothesis(
            hypothesis=point_hypothesis(Team.B, state_revision=2),
            state=match_state(revision=3),
            config=CONFIG,
        )
        self.assertEqual(stale.status, PolicyAssessmentStatus.UNRESOLVED)
        self.assertIn(PolicyReason.STALE_STATE, stale.reasons)

        state_with_switch_due = match_state(
            team_a_points=4,
            team_b_points=3,
            last_side_switch_total=0,
        )
        pending = assess_hypothesis(
            hypothesis=point_hypothesis(Team.B),
            state=state_with_switch_due,
            config=CONFIG,
        )
        self.assertEqual(pending.status, PolicyAssessmentStatus.REVIEW_REQUIRED)
        self.assertIn(PolicyReason.PENDING_DOMAIN_OBLIGATIONS, pending.reasons)

    def test_high_confidence_next_server_contradiction_requires_review(self) -> None:
        candidate = point_hypothesis(Team.B)
        reconciliation = reconcile_next_server(
            hypothesis=candidate,
            state=match_state(),
            observation=observation(Team.A, "a1"),
        )
        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
            reconciliation=reconciliation,
        )
        self.assertEqual(assessment.status, PolicyAssessmentStatus.REVIEW_REQUIRED)
        self.assertIn(PolicyReason.NEXT_SERVER_CONTRADICTION, assessment.reasons)

    def test_reconciliation_context_is_rechecked_defensively(self) -> None:
        candidate = point_hypothesis(Team.B)
        reconciliation = reconcile_next_server(
            hypothesis=candidate,
            state=match_state(),
            observation=observation(Team.B, "b1"),
        )
        mismatched = dataclasses.replace(reconciliation, match_id="other-match")
        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
            reconciliation=mismatched,
        )
        self.assertEqual(assessment.status, PolicyAssessmentStatus.UNRESOLVED)
        self.assertIn(
            PolicyReason.RECONCILIATION_CONTEXT_MISMATCH,
            assessment.reasons,
        )

    def test_assessment_binds_later_reconciliation_evidence_and_cutoff(self) -> None:
        candidate = point_hypothesis(Team.B)
        reconciliation = reconcile_next_server(
            hypothesis=candidate,
            state=match_state(),
            observation=observation(
                Team.B,
                "b1",
                captured_at_ns=150,
                reference="artifact:next-server:later",
            ),
        )
        assessment = assess_hypothesis(
            hypothesis=candidate,
            state=match_state(),
            config=CONFIG,
            reconciliation=reconciliation,
        )
        self.assertEqual(assessment.causal_cutoff_timestamp_ns, 150)
        self.assertIn("artifact:next-server:later", assessment.evidence_refs)

    def test_low_confidence_stays_pending_and_replay_stays_review(self) -> None:
        low = hypothesis(
            probabilities_ppm={
                RallyOutcome.POINT_TEAM_A: 600_000,
                RallyOutcome.POINT_TEAM_B: 200_000,
                RallyOutcome.REPLAY_NO_POINT: 100_000,
                RallyOutcome.UNRESOLVED: 100_000,
            }
        )
        pending = assess_hypothesis(
            hypothesis=low,
            state=match_state(),
            config=CONFIG,
        )
        self.assertEqual(pending.status, PolicyAssessmentStatus.PENDING)
        self.assertIsNone(pending.recommended_intent)

        replay = hypothesis(
            probabilities_ppm={
                RallyOutcome.POINT_TEAM_A: 10_000,
                RallyOutcome.POINT_TEAM_B: 10_000,
                RallyOutcome.REPLAY_NO_POINT: 970_000,
                RallyOutcome.UNRESOLVED: 10_000,
            }
        )
        review = assess_hypothesis(
            hypothesis=replay,
            state=match_state(),
            config=CONFIG,
        )
        self.assertEqual(review.status, PolicyAssessmentStatus.REVIEW_REQUIRED)
        self.assertEqual(
            review.recommended_intent.kind,
            ScoringIntentKind.RECORD_REPLAY_NO_POINT,
        )

    def test_terminal_state_is_unresolved(self) -> None:
        state = match_state()
        assert state.current_set is not None
        state = dataclasses.replace(
            state,
            current_set=dataclasses.replace(
                state.current_set,
                phase=state.current_set.phase.COMPLETE,
            ),
        )
        assessment = assess_hypothesis(
            hypothesis=point_hypothesis(Team.B),
            state=state,
            config=CONFIG,
        )
        self.assertEqual(assessment.status, PolicyAssessmentStatus.UNRESOLVED)
        self.assertIn(PolicyReason.TERMINAL_STATE, assessment.reasons)


if __name__ == "__main__":
    unittest.main()
