import dataclasses
import unittest

from vision_scoring.hypotheses import (
    PPM_TOTAL,
    EvidenceKind,
    EvidenceProvenance,
    ExceptionSignal,
    HypothesisModelProvenance,
    RallyHypothesis,
    RallyOutcome,
)


SHA_A = "a" * 64
SHA_B = "b" * 64


def evidence(
    reference: str = "artifact:sha256:evidence",
    kind: EvidenceKind = EvidenceKind.FUSED_RALLY,
    captured_at_ns: int = 90,
) -> EvidenceProvenance:
    return EvidenceProvenance(
        evidence_ref=reference,
        kind=kind,
        source_id="camera-1",
        content_sha256=SHA_A,
        captured_at_ns=captured_at_ns,
    )


def model() -> HypothesisModelProvenance:
    return HypothesisModelProvenance(
        model_id="fusion",
        model_version="1.2.3",
        weights_sha256=SHA_A,
        inference_config_sha256=SHA_B,
        runtime_id="onnxruntime-1",
    )


def hypothesis(**overrides: object) -> RallyHypothesis:
    values: dict[str, object] = {
        "hypothesis_id": "hypothesis-1",
        "match_id": "match-1",
        "rally_id": "rally-1",
        "set_number": 1,
        "state_revision": 3,
        "ruleset_fingerprint": SHA_A,
        "causal_cutoff_timestamp_ns": 100,
        "probabilities_ppm": {
            RallyOutcome.POINT_TEAM_A: 800_000,
            RallyOutcome.POINT_TEAM_B: 100_000,
            RallyOutcome.REPLAY_NO_POINT: 50_000,
            RallyOutcome.UNRESOLVED: 50_000,
        },
        "exception_signals": (),
        "evidence": (evidence(),),
        "models": (model(),),
    }
    values.update(overrides)
    return RallyHypothesis(**values)  # type: ignore[arg-type]


class RallyHypothesisTests(unittest.TestCase):
    def test_valid_hypothesis_is_deeply_immutable_and_integer_ppm(self) -> None:
        probabilities = {
            RallyOutcome.POINT_TEAM_A: 800_000,
            RallyOutcome.POINT_TEAM_B: 100_000,
            RallyOutcome.REPLAY_NO_POINT: 50_000,
            RallyOutcome.UNRESOLVED: 50_000,
        }
        value = hypothesis(probabilities_ppm=probabilities)
        probabilities[RallyOutcome.POINT_TEAM_A] = 0

        self.assertEqual(value.probability_ppm(RallyOutcome.POINT_TEAM_A), 800_000)
        self.assertEqual(sum(value.probabilities_ppm.values()), PPM_TOTAL)
        self.assertEqual(value.leading_outcome, RallyOutcome.POINT_TEAM_A)
        self.assertTrue(value.has_primary_point_evidence)
        with self.assertRaises(TypeError):
            value.probabilities_ppm[RallyOutcome.POINT_TEAM_A] = 1  # type: ignore[index]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            value.state_revision = 4  # type: ignore[misc]

    def test_fingerprint_is_independent_of_probability_input_order(self) -> None:
        reversed_probabilities = dict(
            reversed(tuple(hypothesis().probabilities_ppm.items()))
        )
        self.assertEqual(
            hypothesis().fingerprint(),
            hypothesis(probabilities_ppm=reversed_probabilities).fingerprint(),
        )

    def test_evidence_and_model_sets_have_canonical_order(self) -> None:
        evidence_a = evidence("artifact:evidence:a")
        evidence_z = evidence("artifact:evidence:z")
        model_a = dataclasses.replace(model(), model_id="model-a")
        model_z = dataclasses.replace(model(), model_id="model-z")
        first = hypothesis(
            evidence=(evidence_z, evidence_a),
            models=(model_z, model_a),
        )
        second = hypothesis(
            evidence=(evidence_a, evidence_z),
            models=(model_a, model_z),
        )
        self.assertEqual(
            tuple(item.evidence_ref for item in first.evidence),
            ("artifact:evidence:a", "artifact:evidence:z"),
        )
        self.assertEqual(
            tuple(item.model_id for item in first.models),
            ("model-a", "model-z"),
        )
        self.assertEqual(first.fingerprint(), second.fingerprint())

    def test_probabilities_require_exact_complete_integer_ppm_distribution(self) -> None:
        cases = (
            {RallyOutcome.POINT_TEAM_A: PPM_TOTAL},
            {
                RallyOutcome.POINT_TEAM_A: 800_001,
                RallyOutcome.POINT_TEAM_B: 100_000,
                RallyOutcome.REPLAY_NO_POINT: 50_000,
                RallyOutcome.UNRESOLVED: 50_000,
            },
            {
                RallyOutcome.POINT_TEAM_A: 800_000.0,
                RallyOutcome.POINT_TEAM_B: 100_000,
                RallyOutcome.REPLAY_NO_POINT: 50_000,
                RallyOutcome.UNRESOLVED: 50_000,
            },
        )
        for probabilities in cases:
            with self.subTest(probabilities=probabilities):
                with self.assertRaises(ValueError):
                    hypothesis(probabilities_ppm=probabilities)

    def test_exception_and_provenance_collections_are_bounded_and_unique(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicates"):
            hypothesis(
                exception_signals=(
                    ExceptionSignal.CAPTURE_GAP,
                    ExceptionSignal.CAPTURE_GAP,
                )
            )
        with self.assertRaisesRegex(ValueError, "between 1 and 64"):
            hypothesis(
                evidence=tuple(
                    evidence(f"artifact:evidence:{index}") for index in range(65)
                )
            )
        with self.assertRaisesRegex(ValueError, "unique"):
            hypothesis(evidence=(evidence(), evidence()))

    def test_causal_cutoff_rejects_future_evidence(self) -> None:
        with self.assertRaisesRegex(ValueError, "causal_cutoff"):
            hypothesis(evidence=(evidence(captured_at_ns=101),))

    def test_next_server_evidence_is_reserved_for_reconciliation(self) -> None:
        with self.assertRaisesRegex(ValueError, "only in reconciliation"):
            hypothesis(
                evidence=(
                    evidence(
                        "artifact:next-server:1",
                        EvidenceKind.NEXT_SERVER,
                    ),
                )
            )

    def test_schema_and_text_are_canonical_ascii(self) -> None:
        with self.assertRaisesRegex(ValueError, "schema_version"):
            hypothesis(schema_version="1.0 ")
        with self.assertRaisesRegex(ValueError, "ASCII"):
            hypothesis(hypothesis_id="hypothèse")


if __name__ == "__main__":
    unittest.main()
