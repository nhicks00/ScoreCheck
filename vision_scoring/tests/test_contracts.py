from __future__ import annotations

import unittest

import vision_scoring.contracts as contracts
from vision_scoring.contracts import (
    EventProposal,
    FramePacket,
    ModelProvenance,
    Observation,
    ObservationType,
    Visibility,
)
from vision_scoring.domain_events import Team


SHA = "a" * 64


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

    def test_perception_metadata_is_depth_cycle_count_and_byte_bounded(self) -> None:
        provenance = ModelProvenance(
            model_id="ball",
            model_version="1",
            weights_sha256=SHA,
            runtime_engine_id="ort",
            causal_cutoff_timestamp_ns=100,
        )

        def make_observation(geometry):
            return Observation(
                observation_id="obs-1",
                observation_type=ObservationType.BALL,
                stream_id="camera-1",
                calibration_segment_id="cal-1",
                frame_sequence=3,
                timestamp_ns=100,
                source_geometry=geometry,
                undistorted_geometry={"center": [1.1, 2.1]},
                court_geometry=None,
                covariance=None,
                visibility=Visibility.VISIBLE,
                quality_flags=(),
                provenance=provenance,
            )

        deep: dict[str, object] = {}
        cursor = deep
        for index in range(1_500):
            child: dict[str, object] = {}
            cursor[f"n{index}"] = child
            cursor = child
        with self.assertRaisesRegex(ValueError, "depth"):
            make_observation(deep)

        cycle: dict[str, object] = {}
        cycle["self"] = cycle
        with self.assertRaisesRegex(ValueError, "cycle"):
            make_observation(cycle)

        with self.assertRaisesRegex(ValueError, "string is too long"):
            make_observation({"label": "x" * 4_097})

        base = {
            "proposal_id": "proposal-1",
            "rally_id": "rally-1",
            "event_type": "SERVE_CONTACT",
            "time_interval_ns": (100, 120),
            "class_probabilities": {
                f"class-{index}": 0.5 for index in range(257)
            },
            "team_probabilities": {Team.A: 0.8},
            "player_probabilities": {"a1": 0.7},
            "evidence_refs": ("observation-1",),
            "model_versions": ("serve-model-1",),
            "capture_health": {"healthy": True},
        }
        with self.assertRaisesRegex(ValueError, "too many entries"):
            EventProposal(**base)

    def test_event_proposal_rejects_nonfinite_probabilities_and_raw_team_keys(
        self,
    ) -> None:
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
        with self.assertRaisesRegex(ValueError, "finite numbers"):
            EventProposal(
                **{
                    **base,
                    "class_probabilities": {"serve": 10**10_000},
                }
            )
        with self.assertRaisesRegex(ValueError, "Team values"):
            EventProposal(**{**base, "team_probabilities": {"A": 0.8}})

    def test_legacy_decision_authority_and_rule_event_symbols_are_absent(
        self,
    ) -> None:
        for name in (
            "Authority",
            "ConfirmationMode",
            "DecisionState",
            "RallyDecision",
            "RuleEvent",
            "RuleEventType",
            "Team",
        ):
            with self.subTest(name=name):
                self.assertFalse(hasattr(contracts, name))


if __name__ == "__main__":
    unittest.main()
