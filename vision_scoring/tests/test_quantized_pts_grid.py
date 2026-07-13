from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from fractions import Fraction
import unittest

from vision_scoring.quantized_pts_grid import (
    PROOF_SCOPE_STATEMENT,
    QuantizedPtsGridUntrustedCandidateClaimV1,
    QuantizedPtsGridUntrustedClaimAbstentionV1,
    QuantizedPtsGridUntrustedClaimStatusV1,
    QuantizedPtsGridUntrustedClaimV1,
    evaluate_quantized_pts_grid_untrusted_claim_v1,
)


_RATES = ((30, 1), (30_000, 1_001), (60, 1), (60_000, 1_001))


def _grid(
    rate_numerator: int,
    rate_denominator: int,
    *,
    count: int = 1_201,
    phase: int = 0,
    origin: int = 17,
    timebase_numerator: int = 1,
    timebase_denominator: int = 1_000,
) -> list[int]:
    period = Fraction(
        timebase_denominator * rate_denominator,
        timebase_numerator * rate_numerator,
    )
    numerator = period.numerator
    denominator = period.denominator
    return [
        origin + (index * numerator + phase) // denominator for index in range(count)
    ]


def _evaluate(pts: object, *, tb_num: int = 1, tb_den: int = 1_000):
    return evaluate_quantized_pts_grid_untrusted_claim_v1(
        pts,  # type: ignore[arg-type]
        timebase_numerator=tb_num,
        timebase_denominator=tb_den,
    )


class ExactFixedPhaseTests(unittest.TestCase):
    def test_phase_zero_one_and_d_minus_one_for_every_rate(self) -> None:
        for numerator, denominator in _RATES:
            period = Fraction(1_000 * denominator, numerator)
            for phase in (0, 1, period.denominator - 1):
                with self.subTest(rate=(numerator, denominator), phase=phase):
                    receipt = _evaluate(_grid(numerator, denominator, phase=phase))
                    self.assertIs(
                        receipt.untrusted_claim_status,
                        QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE,
                    )
                    candidate = receipt.matched_candidate_claim
                    self.assertIsNotNone(candidate)
                    assert candidate is not None
                    self.assertEqual(
                        (candidate.rate_numerator, candidate.rate_denominator),
                        (numerator, denominator),
                    )
                    self.assertLessEqual(candidate.phase_lower_numerator, phase)
                    self.assertGreater(candidate.phase_upper_exclusive_numerator, phase)
                    self.assertEqual(candidate.phase_denominator, period.denominator)
                    self.assertEqual(len(receipt.consistent_candidate_claims), 1)

    def test_one_pass_generator_and_exact_metrics(self) -> None:
        rows = _grid(30_000, 1_001, count=901, phase=19, origin=-2_000)
        consumed = 0

        def source():
            nonlocal consumed
            for item in rows:
                consumed += 1
                yield item

        receipt = _evaluate(source())
        self.assertEqual(consumed, len(rows))
        self.assertEqual(receipt.origin_pts, rows[0])
        self.assertEqual(receipt.presentation_timestamp_count, len(rows))
        self.assertEqual(receipt.interval_count, len(rows) - 1)
        self.assertEqual(receipt.presentation_span_ticks, rows[-1] - rows[0])
        candidate = receipt.matched_candidate_claim
        assert candidate is not None
        self.assertEqual(candidate.phase_lower_numerator, 19)
        self.assertEqual(candidate.phase_upper_exclusive_numerator, 20)

    def test_result_and_nested_candidate_are_immutable_and_non_authorizing(
        self,
    ) -> None:
        receipt = _evaluate(_grid(30, 1))
        with self.assertRaises(FrozenInstanceError):
            receipt.untrusted_claim_status = (  # type: ignore[misc]
                QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED
            )
        assert receipt.matched_candidate_claim is not None
        with self.assertRaises(FrozenInstanceError):
            receipt.matched_candidate_claim.phase_lower_numerator = 2  # type: ignore[misc]
        for field in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(receipt, field), False)
            with self.assertRaises(ValueError):
                replace(receipt, **{field: True})

    def test_scope_is_narrow_and_explicit(self) -> None:
        receipt = _evaluate(_grid(60_000, 1_001))
        self.assertEqual(receipt.proof_scope, PROOF_SCOPE_STATEMENT)
        for limitation in (
            "sensor CFR",
            "dropped",
            "duplicated",
            "interpolated",
            "splices",
            "pixel-content uniqueness",
        ):
            self.assertIn(limitation, receipt.proof_scope)


class ConservativeAbstentionTests(unittest.TestCase):
    def test_midpoint_plus_one_tick_breaks_every_exact_grid(self) -> None:
        for numerator, denominator in _RATES:
            pts = _grid(numerator, denominator)
            pts[len(pts) // 2] += 1
            with self.subTest(rate=(numerator, denominator)):
                receipt = _evaluate(pts)
                self.assertIs(
                    receipt.abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE,
                )

    def test_deleted_timestamp_breaks_frame_index_grid(self) -> None:
        for numerator, denominator in _RATES:
            pts = _grid(numerator, denominator)
            del pts[len(pts) // 2]
            with self.subTest(rate=(numerator, denominator)):
                self.assertIs(
                    _evaluate(pts).abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE,
                )

    def test_duplicate_and_reconnect_reset_are_invalid(self) -> None:
        duplicate = _grid(30, 1)
        duplicate[600] = duplicate[599]
        reset = _grid(30, 1)
        reset[600] = reset[0] - 10_000
        for label, pts in (("duplicate", duplicate), ("reset", reset)):
            with self.subTest(case=label):
                self.assertIs(
                    _evaluate(pts).abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                )

    def test_reconnect_gap_and_locally_plausible_impossible_order_abstain(self) -> None:
        gap = _grid(60, 1)
        for index in range(600, len(gap)):
            gap[index] += 2_000

        locally_plausible = [0]
        for index in range(1, 1_202):
            locally_plausible.append(locally_plausible[-1] + (33 if index % 2 else 34))
        for label, pts in (("gap", gap), ("phase-order", locally_plausible)):
            with self.subTest(case=label):
                self.assertIs(
                    _evaluate(pts).abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE,
                )

    def test_near_rates_never_round_into_supported_rates(self) -> None:
        for numerator, denominator in (
            (3_001, 100),
            (1_499, 50),
            (6_001, 100),
            (1_199, 20),
        ):
            with self.subTest(rate=(numerator, denominator)):
                receipt = _evaluate(_grid(numerator, denominator, count=1_501))
                self.assertIs(
                    receipt.abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE,
                )

    def test_insufficient_evidence_retains_exact_phase_intersection(self) -> None:
        receipt = _evaluate(_grid(30, 1, count=300, phase=2))
        self.assertIs(
            receipt.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INSUFFICIENT_EVIDENCE,
        )
        self.assertEqual(receipt.interval_count, 299)
        self.assertEqual(len(receipt.consistent_candidate_claims), 1)
        candidate = receipt.consistent_candidate_claims[0]
        self.assertEqual(
            (
                candidate.phase_lower_numerator,
                candidate.phase_upper_exclusive_numerator,
            ),
            (2, 3),
        )
        self.assertFalse(candidate.evidence_sufficient)

    def test_short_sequence_with_multiple_intersections_is_insufficient_not_accepted(
        self,
    ) -> None:
        receipt = _evaluate([10])
        self.assertIs(
            receipt.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INSUFFICIENT_EVIDENCE,
        )
        self.assertGreater(len(receipt.consistent_candidate_claims), 1)
        self.assertIsNone(receipt.matched_candidate_claim)

    def test_coarse_or_nonreduced_timebase_abstains_explicitly(self) -> None:
        coarse = _evaluate(_grid(30, 1), tb_num=1, tb_den=500)
        self.assertIs(
            coarse.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.UNSUPPORTED_TIMEBASE,
        )
        nonreduced = _evaluate(_grid(30, 1), tb_num=2, tb_den=2_000)
        self.assertIs(
            nonreduced.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_TIMEBASE,
        )

    def test_missing_noninteger_and_out_of_order_pts_abstain(self) -> None:
        cases = ([0, None, 67], [0, True, 67], [0, 34, 33])
        for pts in cases:
            with self.subTest(pts=pts):
                self.assertIs(
                    _evaluate(pts).abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                )

    def test_invalid_rows_report_only_the_validated_prefix(self) -> None:
        for label, pts in (
            ("missing", [100, 134, None, 200]),
            ("duplicate", [100, 134, 134, 200]),
            ("regression", [100, 134, 90, 200]),
        ):
            with self.subTest(case=label):
                receipt = _evaluate(pts)
                self.assertIs(
                    receipt.abstention_reason,
                    QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                )
                self.assertEqual(receipt.origin_pts, 100)
                self.assertEqual(receipt.presentation_timestamp_count, 2)
                self.assertEqual(receipt.interval_count, 1)
                self.assertEqual(receipt.presentation_span_ticks, 34)
                self.assertEqual(receipt.consistent_candidate_claims, ())


class InputFailureAndPrecedenceTests(unittest.TestCase):
    class _HostileIterable:
        def __init__(self, exception: BaseException = AssertionError("touched")):
            self.exception = exception
            self.iter_calls = 0

        def __iter__(self):
            self.iter_calls += 1
            raise self.exception

    def test_invalid_and_unsupported_timebases_precede_hostile_iterables(self) -> None:
        invalid_source = self._HostileIterable()
        invalid = _evaluate(invalid_source, tb_num=2, tb_den=2_000)
        self.assertIs(
            invalid.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_TIMEBASE,
        )
        self.assertEqual(invalid_source.iter_calls, 0)
        self.assertIsNone(invalid.timebase_numerator)
        self.assertEqual(invalid.presentation_timestamp_count, 0)

        unsupported_source = self._HostileIterable()
        unsupported = _evaluate(unsupported_source, tb_num=1, tb_den=500)
        self.assertIs(
            unsupported.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.UNSUPPORTED_TIMEBASE,
        )
        self.assertEqual(unsupported_source.iter_calls, 0)
        self.assertEqual(
            (unsupported.timebase_numerator, unsupported.timebase_denominator),
            (1, 500),
        )
        self.assertEqual(unsupported.presentation_timestamp_count, 0)

    def test_ordinary_iter_and_next_exceptions_become_invalid_pts(self) -> None:
        iter_failure = _evaluate(self._HostileIterable(RuntimeError("iter failed")))
        self.assertIs(
            iter_failure.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
        )
        self.assertEqual(iter_failure.presentation_timestamp_count, 0)

        def failing_next():
            yield 100
            yield 134
            raise OSError("source failed")

        next_failure = _evaluate(failing_next())
        self.assertIs(
            next_failure.abstention_reason,
            QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
        )
        self.assertEqual(next_failure.origin_pts, 100)
        self.assertEqual(next_failure.presentation_timestamp_count, 2)
        self.assertEqual(next_failure.interval_count, 1)
        self.assertEqual(next_failure.presentation_span_ticks, 34)
        self.assertEqual(next_failure.consistent_candidate_claims, ())

    def test_base_exceptions_are_not_swallowed(self) -> None:
        with self.assertRaises(KeyboardInterrupt):
            _evaluate(self._HostileIterable(KeyboardInterrupt()))


class PublicConstructorHardeningTests(unittest.TestCase):
    def test_candidate_rejects_fabricated_rate_period_phase_and_sufficiency(
        self,
    ) -> None:
        receipt = _evaluate(_grid(30, 1))
        candidate = receipt.matched_candidate_claim
        assert candidate is not None
        mutations = (
            {"rate_numerator": 25},
            {"rate_denominator": True},
            {
                "target_period_ticks_numerator": (
                    candidate.target_period_ticks_numerator + 1
                )
            },
            {"phase_upper_exclusive_numerator": candidate.phase_lower_numerator},
            {"evidence_sufficient": False},
            {"timebase_denominator": 2_000},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                replace(candidate, **mutation)

    def test_candidate_recomputes_count_shape_and_evidence_floor(self) -> None:
        insufficient = _evaluate(_grid(30, 1, count=300)).consistent_candidate_claims[0]
        with self.assertRaises(ValueError):
            replace(insufficient, interval_count=300)
        with self.assertRaises(ValueError):
            replace(insufficient, evidence_sufficient=True)

    def test_outer_receipt_rejects_mismatched_nested_metrics_and_timebase(self) -> None:
        receipt = _evaluate(_grid(30, 1))
        candidate = receipt.matched_candidate_claim
        assert candidate is not None
        changed_candidate = replace(
            candidate,
            presentation_timestamp_count=(candidate.presentation_timestamp_count + 1),
            interval_count=candidate.interval_count + 1,
        )
        with self.assertRaises(ValueError):
            replace(
                receipt,
                consistent_candidate_claims=(changed_candidate,),
                matched_candidate_claim=changed_candidate,
            )
        with self.assertRaises(ValueError):
            replace(receipt, timebase_denominator=1_001)

    def test_accepted_and_abstained_reason_shapes_are_canonical(self) -> None:
        accepted = _evaluate(_grid(60, 1))
        with self.assertRaises(ValueError):
            replace(accepted, origin_pts=None)
        with self.assertRaises(ValueError):
            replace(accepted, consistent_candidate_claims=())
        with self.assertRaises(ValueError):
            replace(
                accepted,
                untrusted_claim_status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
                abstention_reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_TIMEBASE,
                matched_candidate_claim=None,
            )

        insufficient = _evaluate([10])
        with self.assertRaises(ValueError):
            replace(
                insufficient,
                abstention_reason=(
                    QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS
                ),
            )

    def test_direct_public_types_reject_wrong_exact_types(self) -> None:
        receipt = _evaluate(_grid(30, 1))
        candidate = receipt.matched_candidate_claim
        assert candidate is not None
        self.assertIsInstance(candidate, QuantizedPtsGridUntrustedCandidateClaimV1)
        self.assertIsInstance(receipt, QuantizedPtsGridUntrustedClaimV1)
        with self.assertRaises(ValueError):
            replace(receipt, presentation_timestamp_count=True)


class MandatoryReplayValidationTests(unittest.TestCase):
    def test_derived_claim_validates_only_against_the_exact_original_rows(self) -> None:
        rows = _grid(30_000, 1_001, phase=11)
        claim = _evaluate(rows)
        self.assertTrue(
            claim.validate_against(
                iter(rows), timebase_numerator=1, timebase_denominator=1_000
            )
        )

        altered = rows.copy()
        altered[len(altered) // 2] += 1
        self.assertFalse(
            claim.validate_against(
                altered, timebase_numerator=1, timebase_denominator=1_000
            )
        )
        self.assertFalse(
            claim.validate_against(
                rows, timebase_numerator=1, timebase_denominator=1_001
            )
        )

    def test_fabricated_accepted_intermediate_with_plausible_endpoints_fails_replay(
        self,
    ) -> None:
        rows = _grid(30, 1, phase=0)
        genuine = _evaluate(rows)
        candidate = genuine.matched_candidate_claim
        assert candidate is not None
        self.assertEqual(
            (
                candidate.phase_lower_numerator,
                candidate.phase_upper_exclusive_numerator,
            ),
            (0, 1),
        )
        fabricated_candidate = replace(
            candidate,
            phase_lower_numerator=1,
            phase_upper_exclusive_numerator=2,
        )
        fabricated = replace(
            genuine,
            consistent_candidate_claims=(fabricated_candidate,),
            matched_candidate_claim=fabricated_candidate,
        )
        self.assertEqual(fabricated.origin_pts, genuine.origin_pts)
        self.assertEqual(
            fabricated.presentation_span_ticks,
            genuine.presentation_span_ticks,
        )
        self.assertEqual(
            fabricated.ordered_validated_pts_sha256,
            genuine.ordered_validated_pts_sha256,
        )
        self.assertNotEqual(
            fabricated.canonical_claim_sha256(), genuine.canonical_claim_sha256()
        )
        self.assertFalse(
            fabricated.validate_against(
                rows, timebase_numerator=1, timebase_denominator=1_000
            )
        )

    def test_ordered_digest_is_deterministic_order_sensitive_and_bound(self) -> None:
        rows = _grid(60, 1)
        first = _evaluate(rows)
        second = _evaluate(iter(rows))
        self.assertEqual(
            first.ordered_validated_pts_sha256,
            second.ordered_validated_pts_sha256,
        )
        self.assertEqual(
            first.canonical_claim_sha256(), second.canonical_claim_sha256()
        )

        reordered = rows.copy()
        reordered[100], reordered[101] = reordered[101], reordered[100]
        reordered_claim = _evaluate(reordered)
        self.assertNotEqual(
            first.ordered_validated_pts_sha256,
            reordered_claim.ordered_validated_pts_sha256,
        )
        self.assertFalse(
            first.validate_against(
                reordered, timebase_numerator=1, timebase_denominator=1_000
            )
        )

        digest_fabrication = replace(first, ordered_validated_pts_sha256="0" * 64)
        self.assertFalse(
            digest_fabrication.validate_against(
                rows, timebase_numerator=1, timebase_denominator=1_000
            )
        )

    def test_replay_validation_handles_hostile_iterators_conservatively(self) -> None:
        rows = _grid(30, 1)
        accepted = _evaluate(rows)
        hostile = InputFailureAndPrecedenceTests._HostileIterable(
            RuntimeError("hostile replay")
        )
        self.assertFalse(
            accepted.validate_against(
                hostile, timebase_numerator=1, timebase_denominator=1_000
            )
        )
        self.assertEqual(hostile.iter_calls, 1)

        def hostile_next():
            yield rows[0]
            yield rows[1]
            raise OSError("hostile next")

        self.assertFalse(
            accepted.validate_against(
                hostile_next(),
                timebase_numerator=1,
                timebase_denominator=1_000,
            )
        )

        invalid_timebase_claim = _evaluate(rows, tb_num=2, tb_den=2_000)
        untouched = InputFailureAndPrecedenceTests._HostileIterable()
        self.assertTrue(
            invalid_timebase_claim.validate_against(
                untouched, timebase_numerator=2, timebase_denominator=2_000
            )
        )
        self.assertEqual(untouched.iter_calls, 0)

    def test_replay_validation_rejects_tampered_frozen_objects_without_leaking(
        self,
    ) -> None:
        rows = _grid(30, 1)
        outer_tampered = _evaluate(rows)
        object.__setattr__(outer_tampered, "untrusted_claim_status", "bogus")
        self.assertFalse(
            outer_tampered.validate_against(
                rows, timebase_numerator=1, timebase_denominator=1_000
            )
        )

        nested_tampered = _evaluate(rows)
        candidate = nested_tampered.matched_candidate_claim
        assert candidate is not None
        object.__setattr__(candidate, "rate_numerator", object())
        self.assertFalse(
            nested_tampered.validate_against(
                rows, timebase_numerator=1, timebase_denominator=1_000
            )
        )

    def test_replay_validation_does_not_mask_base_exceptions(self) -> None:
        class ReplayAbort(BaseException):
            pass

        rows = _grid(30, 1)
        claim = _evaluate(rows)

        def aborting_rows():
            yield rows[0]
            raise ReplayAbort

        with self.assertRaises(ReplayAbort):
            claim.validate_against(
                aborting_rows(),
                timebase_numerator=1,
                timebase_denominator=1_000,
            )

    def test_public_names_and_status_make_untrusted_semantics_explicit(self) -> None:
        claim = _evaluate(_grid(30, 1))
        self.assertIn("UntrustedClaim", type(claim).__name__)
        self.assertIn("UNTRUSTED_CLAIM", claim.untrusted_claim_status.value)
        self.assertIn("Untrusted structural claim", claim.proof_scope)


class ProofBoundaryAdversaryTests(unittest.TestCase):
    def test_timestamp_rewrite_vfr_interpolation_and_repeated_pixels_are_expected_passes(
        self,
    ) -> None:
        # These three sources can expose the same PTS iterable. Pixel content and
        # pre-rewrite capture timing are intentionally outside this structural proof.
        exact_rewritten_pts = _grid(60_000, 1_001)
        for source_description in (
            "rewritten-vfr",
            "interpolated-frames",
            "repeated-pixels",
        ):
            with self.subTest(source=source_description):
                receipt = _evaluate(iter(exact_rewritten_pts))
                self.assertIs(
                    receipt.untrusted_claim_status,
                    QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE,
                )
                self.assertFalse(receipt.admissible_for_training)


if __name__ == "__main__":
    unittest.main()
