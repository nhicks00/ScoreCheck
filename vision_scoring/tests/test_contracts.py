from __future__ import annotations

import unittest

from vision_scoring.contracts import (
    Authority,
    ConfirmationMode,
    DecisionState,
    EventProposal,
    FramePacket,
    ModelProvenance,
    Observation,
    ObservationType,
    RallyDecision,
    RuleEvent,
    RuleEventType,
    Team,
    Visibility,
)
from vision_scoring.rules import Ruleset


SHA = "a" * 64
RULESET_FINGERPRINT = Ruleset().fingerprint()


def _decision(**overrides) -> RallyDecision:
    values = {
        "decision_id": "decision-1",
        "match_id": "match-1",
        "rally_id": "rally-1",
        "set_number": 1,
        "ruleset_id": "FIVB_BEACH",
        "ruleset_version": "2025-2028",
        "state": DecisionState.AUTO_CONFIRM,
        "proposed_winner_team": Team.B,
        "confirmation_mode": ConfirmationMode.SERVER_CHANGE,
        "calibrated_probability": 0.999,
        "coverage_policy_version": "coverage-1",
        "causal_cutoff_timestamp_ns": 100,
        "blocking_reasons": (),
        "evidence_refs": ("observation-1",),
    }
    values.update(overrides)
    return RallyDecision(**values)


def _rule_event(**overrides) -> RuleEvent:
    values = {
        "event_id": "event-1",
        "sequence_number": 1,
        "match_id": "match-1",
        "set_number": 1,
        "event_type": RuleEventType.REPLAY_NO_POINT,
        "authority": Authority.OPERATOR,
        "actor_id": "operator-1",
        "authorization_id": "authorization-1",
        "ruleset_id": "FIVB_BEACH",
        "ruleset_version": "2025-2028",
        "ruleset_fingerprint": RULESET_FINGERPRINT,
        "payload": {"reason": "external interference"},
        "reason": "external interference",
        "related_rally_id": "rally-1",
        "evidence_refs": ("observation-1",),
        "created_at_ns": 1,
    }
    values.update(overrides)
    return RuleEvent(**values)


class ContractTests(unittest.TestCase):
    def test_frame_health_fails_closed_on_duplicate_drop_or_corruption(self) -> None:
        healthy = FramePacket(
            stream_id="camera-1",
            sequence_number=10,
            capture_timestamp_ns=100,
            receive_timestamp_ns=110,
            pts=10,
            dts=10,
            duration_ns=33,
            source_width=1920,
            source_height=1080,
            codec_profile="h264-high",
            keyframe=False,
            duplicate=False,
            dropped_before=0,
            decode_corrupt=False,
            content_sha256=SHA,
            calibration_segment_id="cal-1",
        )
        self.assertTrue(healthy.scoring_healthy)
        self.assertFalse(
            FramePacket(
                **{
                    field: getattr(healthy, field)
                    for field in healthy.__dataclass_fields__
                    if field != "dropped_before"
                },
                dropped_before=1,
            ).scoring_healthy
        )

    def test_observation_rejects_future_context(self) -> None:
        provenance = ModelProvenance(
            model_id="ball",
            model_version="1",
            weights_sha256=SHA,
            runtime_engine_id="ort",
            causal_cutoff_timestamp_ns=101,
        )
        with self.assertRaisesRegex(ValueError, "future evidence"):
            Observation(
                observation_id="obs-1",
                observation_type=ObservationType.BALL,
                stream_id="camera-1",
                calibration_segment_id="cal-1",
                frame_sequence=3,
                timestamp_ns=100,
                source_geometry={"center": [1.0, 2.0]},
                undistorted_geometry={"center": [1.1, 2.1]},
                court_geometry=None,
                covariance=None,
                visibility=Visibility.VISIBLE,
                quality_flags=(),
                provenance=provenance,
            )

    def test_event_proposal_rejects_nonfinite_probabilities_and_raw_team_keys(self) -> None:
        base = {
            "proposal_id": "proposal-1",
            "rally_id": "rally-1",
            "event_type": "SERVE_CONTACT",
            "time_interval_ns": (100, 120),
            "class_probabilities": {"serve": 0.9},
            "team_probabilities": {Team.A: 0.8},
            "player_probabilities": {"a1": 0.7},
            "evidence_refs": ("observation-1",),
            "model_versions": ("serve-model-1",),
            "capture_health": {"healthy": True},
        }
        with self.assertRaisesRegex(ValueError, "finite numbers"):
            EventProposal(
                **{
                    **base,
                    "class_probabilities": {"serve": float("nan")},
                }
            )
        with self.assertRaisesRegex(ValueError, "Team values"):
            EventProposal(**{**base, "team_probabilities": {"A": 0.8}})

    def test_rule_event_payload_is_recursively_immutable(self) -> None:
        payload = {"winner_team": "A", "nested": {"frames": [1, 2]}}
        event = RuleEvent(
            event_id="event-1",
            sequence_number=1,
            match_id="match-1",
            set_number=1,
            event_type=RuleEventType.POINT_AWARDED,
            authority=Authority.OPERATOR,
            actor_id="operator-1",
            authorization_id="authorization-1",
            ruleset_id="FIVB_BEACH",
            ruleset_version="2025-2028",
            ruleset_fingerprint=RULESET_FINGERPRINT,
            payload=payload,
            reason="operator awarded point",
            related_rally_id="rally-1",
            evidence_refs=("observation-1",),
            created_at_ns=1,
        )
        payload["winner_team"] = "B"
        payload["nested"]["frames"].append(3)
        self.assertEqual(event.payload["winner_team"], "A")
        self.assertEqual(event.payload["nested"]["frames"], (1, 2))
        with self.assertRaises(TypeError):
            event.payload["winner_team"] = "B"

    def test_auto_decision_requires_evidence_but_has_no_mutation_api(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires evidence"):
            _decision(evidence_refs=())
        self.assertFalse(hasattr(RallyDecision, "to_rule_event"))
        self.assertFalse(hasattr(RallyDecision, "apply"))

    def test_rally_decision_rejects_state_mode_contradictions(self) -> None:
        invalid_cases = (
            (
                "automatic confirmation mode",
                {"confirmation_mode": ConfirmationMode.HUMAN},
            ),
            (
                "calibrated probability",
                {"calibrated_probability": None},
            ),
            (
                "cannot contain a winner",
                {
                    "state": DecisionState.REPLAY_NO_POINT,
                    "confirmation_mode": None,
                    "calibrated_probability": None,
                },
            ),
            (
                "blocking reason",
                {
                    "state": DecisionState.UNRESOLVED,
                    "proposed_winner_team": None,
                    "confirmation_mode": None,
                    "calibrated_probability": None,
                    "blocking_reasons": (),
                },
            ),
            (
                "REVIEW requires evidence",
                {
                    "state": DecisionState.REVIEW,
                    "proposed_winner_team": None,
                    "confirmation_mode": None,
                    "calibrated_probability": None,
                    "blocking_reasons": ("identity uncertain",),
                    "evidence_refs": (),
                },
            ),
            (
                "provisional mode",
                {
                    "state": DecisionState.PENDING,
                    "confirmation_mode": ConfirmationMode.HUMAN,
                    "blocking_reasons": (),
                },
            ),
        )
        for message, overrides in invalid_cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                _decision(**overrides)

    def test_auto_rule_event_requires_policy_decision_linkage(self) -> None:
        with self.assertRaisesRegex(ValueError, "decision, policy"):
            RuleEvent(
                event_id="event-auto",
                sequence_number=1,
                match_id="match-1",
                set_number=1,
                event_type=RuleEventType.POINT_AWARDED,
                authority=Authority.AUTO_POLICY,
                actor_id="auto-policy-1",
                authorization_id="authorization-auto",
                ruleset_id="FIVB_BEACH",
                ruleset_version="2025-2028",
                ruleset_fingerprint=RULESET_FINGERPRINT,
                payload={
                    "winner_team": "B",
                    "next_serving_player": "b1",
                    "confirmation_mode": ConfirmationMode.SERVER_CHANGE.value,
                },
                reason="automatic server change",
                related_rally_id="rally-auto",
                evidence_refs=("observation-auto",),
                created_at_ns=1,
            )

    def test_contracts_reject_raw_enums_strings_bools_and_nan(self) -> None:
        invalid_cases = (
            ("declared enums", lambda: _rule_event(event_type="REPLAY_NO_POINT")),
            ("state must be a DecisionState", lambda: _decision(state="AUTO_CONFIRM")),
            (
                "declared enum",
                lambda: _decision(confirmation_mode="SERVER_CHANGE"),
            ),
            ("evidence_refs must be a tuple", lambda: _rule_event(evidence_refs="obs-1")),
            (
                "evidence_refs must be a tuple",
                lambda: _decision(evidence_refs="obs-1"),
            ),
            (
                "sequence numbers must be positive",
                lambda: _rule_event(sequence_number=True),
            ),
            ("set number and causal cutoff", lambda: _decision(set_number=True)),
            (
                "finite number",
                lambda: _decision(calibrated_probability=float("nan")),
            ),
            (
                "finite JSON-compatible",
                lambda: _rule_event(payload={"value": float("nan")}),
            ),
            ("scoring values must be integers", lambda: Ruleset(best_of_sets=True)),
        )
        for message, construct in invalid_cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                construct()

    def test_same_server_corroboration_mode_is_not_exposed(self) -> None:
        self.assertNotIn("SAME_SERVER_CORROBORATED", ConfirmationMode.__members__)

    def test_event_fingerprint_is_stable_and_content_sensitive(self) -> None:
        base = dict(
            event_id="event-1",
            sequence_number=1,
            match_id="match-1",
            set_number=1,
            event_type=RuleEventType.REPLAY_NO_POINT,
            authority=Authority.OPERATOR,
            actor_id="operator-1",
            authorization_id="authorization-1",
            ruleset_id="FIVB_BEACH",
            ruleset_version="2025-2028",
            ruleset_fingerprint=RULESET_FINGERPRINT,
            payload={"reason": "double fault"},
            reason="double fault",
            related_rally_id="rally-1",
            evidence_refs=("referee-observation-1",),
            created_at_ns=1,
        )
        first = RuleEvent(**base)
        second = RuleEvent(**base)
        changed = RuleEvent(**{**base, "reason": "external interference"})
        self.assertEqual(first.fingerprint(), second.fingerprint())
        self.assertNotEqual(first.fingerprint(), changed.fingerprint())


if __name__ == "__main__":
    unittest.main()
