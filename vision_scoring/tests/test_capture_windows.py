from __future__ import annotations

from dataclasses import replace
import json
import unittest

from vision_scoring.capture_contracts import (
    MAX_FRAGMENT_BYTES,
    CaptureContractError,
    CaptureFragmentDescriptor,
    EvidenceWindowPlan,
    EvidenceWindowRequest,
    EvidenceWindowStatus,
    WindowRequestOrigin,
)
from vision_scoring.capture_windows import (
    EvidenceWindowPlanningError,
    plan_evidence_window,
)


def sha(character: str) -> str:
    return character * 64


def request_factory(**changes: object) -> EvidenceWindowRequest:
    values: dict[str, object] = {
        "request_id": "request-1",
        "idempotency_key": "window-request:1",
        "session_fingerprint": sha("a"),
        "expected_session_configuration_fingerprint": sha("b"),
        "reconnect_epoch": 0,
        "trigger_evidence_time_ns": 3_500_000_000,
        "pre_roll_ns": 1_200_000_000,
        "post_roll_ns": 1_000_000_000,
        "origin": WindowRequestOrigin.HUMAN_REVIEW_TRIGGER,
        "requested_at_ns": 5_000_000_000,
    }
    values.update(changes)
    return EvidenceWindowRequest(**values)


def fragments_factory(
    count: int = 6,
    *,
    byte_length: int = 1_000_000,
    frame_count: int = 60,
    keyframes: set[int] | None = None,
) -> tuple[CaptureFragmentDescriptor, ...]:
    starts = keyframes if keyframes is not None else {0, 2, 4}
    return tuple(
        CaptureFragmentDescriptor(
            fragment_id=f"fragment-{index}",
            session_fingerprint=sha("a"),
            session_configuration_fingerprint=sha("b"),
            reconnect_epoch=0,
            fragment_sequence=index,
            evidence_start_ns=index * 1_000_000_000,
            evidence_end_ns=(index + 1) * 1_000_000_000,
            device_start_timestamp=index * 60,
            device_end_timestamp=(index + 1) * 60,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            byte_length=byte_length,
            content_sha256=f"{index:064x}",
            frame_count=frame_count,
            keyframe_at_start=index in starts,
            capture_profile_sha256=sha("1"),
            camera_fingerprint=sha("2"),
            clock_fingerprint=sha("3"),
            encoder_configuration_sha256=sha("4"),
            exposure_configuration_sha256=sha("5"),
        )
        for index in range(count)
    )


class EvidenceWindowPlannerTests(unittest.TestCase):
    def test_complete_window_is_keyframe_aligned_and_not_shortened(self) -> None:
        request = request_factory()
        fragments = fragments_factory(keyframes={0, 3})
        plan = plan_evidence_window(request, fragments)
        self.assertEqual(plan.status, EvidenceWindowStatus.PLANNED)
        self.assertEqual(plan.requested_start_ns, 2_300_000_000)
        self.assertEqual(plan.requested_end_ns, 4_500_000_000)
        self.assertEqual(plan.actual_start_ns, 0)
        self.assertEqual(plan.actual_end_ns, 5_000_000_000)
        self.assertEqual(
            plan.selected_fragment_ids,
            ("fragment-0", "fragment-1", "fragment-2", "fragment-3", "fragment-4"),
        )
        self.assertLessEqual(plan.actual_start_ns, plan.requested_start_ns)
        self.assertGreaterEqual(plan.actual_end_ns, plan.requested_end_ns)

    def test_exact_retry_is_deterministic(self) -> None:
        request = request_factory()
        fragments = fragments_factory()
        self.assertEqual(
            plan_evidence_window(request, fragments),
            plan_evidence_window(request, fragments),
        )

    def test_plan_codec_round_trip_and_fingerprint_are_stable(self) -> None:
        plan = plan_evidence_window(request_factory(), fragments_factory())
        encoded = plan.to_json_bytes()
        decoded = EvidenceWindowPlan.from_json_bytes(encoded)
        self.assertEqual(decoded, plan)
        self.assertEqual(decoded.fingerprint(), plan.fingerprint())
        self.assertEqual(len(plan.fingerprint()), 64)
        self.assertEqual(
            json.dumps(
                json.loads(encoded), sort_keys=True, separators=(",", ":")
            ).encode(),
            encoded,
        )

    def test_plan_codec_rejects_unknown_fields_and_non_array_fragment_lists(self) -> None:
        plan = plan_evidence_window(request_factory(), fragments_factory())
        value = json.loads(plan.to_json_bytes())
        value["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            EvidenceWindowPlan.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

        value = json.loads(plan.to_json_bytes())
        value["selected_fragment_ids"] = {
            str(index): fragment_id
            for index, fragment_id in enumerate(value["selected_fragment_ids"])
        }
        with self.assertRaisesRegex(
            CaptureContractError, "INVALID_EVIDENCE_WINDOW_PLAN"
        ):
            EvidenceWindowPlan.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_plan_codec_rejects_status_reason_tampering(self) -> None:
        plan = plan_evidence_window(request_factory(), fragments_factory())
        value = json.loads(plan.to_json_bytes())
        value["reason_code"] = "COMPLETE_KEYFRAME_ALIGNED_WINDOW_TAMPERED"
        with self.assertRaisesRegex(
            CaptureContractError, "INVALID_EVIDENCE_WINDOW_PLAN"
        ):
            EvidenceWindowPlan.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_plan_codec_rejects_shortened_window_and_empty_totals(self) -> None:
        plan = plan_evidence_window(request_factory(), fragments_factory())
        for patch in (
            {"actual_start_ns": plan.requested_start_ns + 1},
            {"actual_end_ns": plan.requested_end_ns - 1},
            {"total_byte_length": 0},
            {"total_frame_count": 0},
        ):
            value = json.loads(plan.to_json_bytes())
            value.update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(
                CaptureContractError, "INVALID_EVIDENCE_WINDOW_PLAN"
            ):
                EvidenceWindowPlan.from_json_bytes(
                    json.dumps(
                        value, sort_keys=True, separators=(",", ":")
                    ).encode()
                )

    def test_plan_codec_enforces_selected_fragment_ceiling(self) -> None:
        plan = plan_evidence_window(request_factory(), fragments_factory())
        value = json.loads(plan.to_json_bytes())
        value["selected_fragment_ids"] = [
            f"fragment-{index}" for index in range(65)
        ]
        value["selected_fragment_fingerprints"] = [
            f"{index:064x}" for index in range(65)
        ]
        with self.assertRaisesRegex(
            CaptureContractError, "INVALID_EVIDENCE_WINDOW_PLAN"
        ):
            EvidenceWindowPlan.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_zero_roll_trigger_on_fragment_boundary_prefers_following_fragment(self) -> None:
        request = request_factory(
            trigger_evidence_time_ns=2_000_000_000,
            pre_roll_ns=0,
            post_roll_ns=0,
        )
        plan = plan_evidence_window(request, fragments_factory(keyframes={2}))
        self.assertEqual(plan.status, EvidenceWindowStatus.PLANNED)
        self.assertEqual(plan.selected_fragment_ids, ("fragment-2",))
        self.assertEqual(plan.actual_start_ns, 2_000_000_000)

    def test_evicted_preroll_returns_explicit_failure(self) -> None:
        request = request_factory(
            trigger_evidence_time_ns=3_500_000_000,
            pre_roll_ns=3_000_000_000,
            post_roll_ns=0,
        )
        fragments = tuple(
            replace(
                fragment,
                fragment_sequence=fragment.fragment_sequence - 2,
                fragment_id=f"retained-{fragment.fragment_sequence - 2}",
            )
            for fragment in fragments_factory()[2:]
        )
        plan = plan_evidence_window(request, fragments)
        self.assertEqual(plan.status, EvidenceWindowStatus.PREROLL_UNAVAILABLE)
        self.assertEqual(plan.selected_fragment_ids, ())
        self.assertIsNone(plan.actual_start_ns)
        self.assertEqual(plan.reason_code, "REQUIRED_PREROLL_EVICTED")

    def test_missing_postroll_returns_explicit_failure(self) -> None:
        request = request_factory(
            trigger_evidence_time_ns=5_500_000_000,
            pre_roll_ns=0,
            post_roll_ns=1_000_000_000,
        )
        plan = plan_evidence_window(request, fragments_factory())
        self.assertEqual(plan.status, EvidenceWindowStatus.POSTROLL_UNAVAILABLE)
        self.assertEqual(plan.selected_fragment_ids, ())

    def test_no_keyframe_before_request_fails_without_shortening(self) -> None:
        plan = plan_evidence_window(
            request_factory(), fragments_factory(keyframes={3, 5})
        )
        self.assertEqual(plan.status, EvidenceWindowStatus.KEYFRAME_UNAVAILABLE)
        self.assertEqual(plan.selected_fragment_ids, ())

    def test_session_and_reconnect_epoch_mixing_are_rejected(self) -> None:
        fragments = fragments_factory()
        mixed_session = fragments[:2] + (
            replace(fragments[2], session_fingerprint=sha("b")),
            *fragments[3:],
        )
        plan = plan_evidence_window(request_factory(), mixed_session)
        self.assertEqual(plan.status, EvidenceWindowStatus.FRAGMENT_SCOPE_MISMATCH)

        mixed_epoch = fragments[:2] + (
            replace(fragments[2], reconnect_epoch=1),
            *fragments[3:],
        )
        plan = plan_evidence_window(request_factory(), mixed_epoch)
        self.assertEqual(plan.status, EvidenceWindowStatus.FRAGMENT_SCOPE_MISMATCH)

    def test_configuration_mixing_is_rejected(self) -> None:
        fragments = fragments_factory()
        mixed = fragments[:2] + (
            replace(fragments[2], exposure_configuration_sha256=sha("9")),
            *fragments[3:],
        )
        plan = plan_evidence_window(request_factory(), mixed)
        self.assertEqual(plan.status, EvidenceWindowStatus.CONFIGURATION_MISMATCH)
        self.assertEqual(plan.reason_code, "FRAGMENT_CONFIGURATION_MIXED")

    def test_uniform_session_configuration_substitution_is_rejected(self) -> None:
        substituted = tuple(
            replace(
                fragment,
                session_configuration_fingerprint=sha("9"),
            )
            for fragment in fragments_factory()
        )
        plan = plan_evidence_window(request_factory(), substituted)
        self.assertEqual(plan.status, EvidenceWindowStatus.CONFIGURATION_MISMATCH)
        self.assertEqual(
            plan.reason_code,
            "FRAGMENT_SESSION_CONFIGURATION_SUBSTITUTED",
        )

    def test_sequence_evidence_and_device_gaps_are_rejected(self) -> None:
        fragments = fragments_factory()
        sequence_gap = fragments[:2] + (
            replace(fragments[2], fragment_sequence=3),
            *fragments[3:],
        )
        self.assertEqual(
            plan_evidence_window(request_factory(), sequence_gap).status,
            EvidenceWindowStatus.FRAGMENT_GAP,
        )

        evidence_gap = fragments[:2] + (
            replace(fragments[2], evidence_start_ns=2_000_000_001),
            *fragments[3:],
        )
        self.assertEqual(
            plan_evidence_window(request_factory(), evidence_gap).status,
            EvidenceWindowStatus.FRAGMENT_GAP,
        )

        device_gap = fragments[:2] + (
            replace(fragments[2], device_start_timestamp=121),
            *fragments[3:],
        )
        self.assertEqual(
            plan_evidence_window(request_factory(), device_gap).status,
            EvidenceWindowStatus.FRAGMENT_GAP,
        )

        duplicate_id = fragments[:2] + (
            replace(fragments[2], fragment_id="fragment-1"),
            *fragments[3:],
        )
        self.assertEqual(
            plan_evidence_window(request_factory(), duplicate_id).reason_code,
            "DUPLICATE_FRAGMENT_ID",
        )

    def test_pending_window_capacity_is_exact_and_bounded(self) -> None:
        plan = plan_evidence_window(
            request_factory(), fragments_factory(), pending_window_count=4
        )
        self.assertEqual(plan.status, EvidenceWindowStatus.CAPACITY_EXCEEDED)
        self.assertEqual(plan.reason_code, "PENDING_WINDOW_CAPACITY_EXCEEDED")
        with self.assertRaisesRegex(EvidenceWindowPlanningError, "exact integer"):
            plan_evidence_window(
                request_factory(), fragments_factory(), pending_window_count=True
            )

    def test_ring_byte_and_fragment_count_ceilings_are_enforced(self) -> None:
        oversized_ring = fragments_factory(
            count=17, byte_length=MAX_FRAGMENT_BYTES, keyframes={0}
        )
        plan = plan_evidence_window(request_factory(), oversized_ring)
        self.assertEqual(plan.status, EvidenceWindowStatus.CAPACITY_EXCEEDED)
        self.assertEqual(plan.reason_code, "RING_BYTE_CEILING_EXCEEDED")

        too_many = fragments_factory(count=65)
        plan = plan_evidence_window(request_factory(), too_many)
        self.assertEqual(plan.status, EvidenceWindowStatus.CAPACITY_EXCEEDED)
        self.assertEqual(plan.reason_code, "CLOSED_FRAGMENT_COUNT_EXCEEDED")

    def test_finalized_frame_ceiling_is_enforced(self) -> None:
        fragments = fragments_factory(count=4, frame_count=1_000, keyframes={0})
        request = request_factory(
            trigger_evidence_time_ns=2_000_000_000,
            pre_roll_ns=2_000_000_000,
            post_roll_ns=2_000_000_000,
        )
        plan = plan_evidence_window(request, fragments)
        self.assertEqual(plan.status, EvidenceWindowStatus.CAPACITY_EXCEEDED)
        self.assertEqual(plan.reason_code, "FINALIZED_FRAME_CEILING_EXCEEDED")

    def test_window_roll_ceiling_and_underflow_are_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "30-second"):
            request_factory(pre_roll_ns=20_000_000_000, post_roll_ns=11_000_000_000)
        request = request_factory(
            trigger_evidence_time_ns=1,
            pre_roll_ns=2,
            post_roll_ns=0,
        )
        plan = plan_evidence_window(request, fragments_factory())
        self.assertEqual(plan.status, EvidenceWindowStatus.PREROLL_UNAVAILABLE)
        self.assertEqual(plan.reason_code, "PREROLL_PRECEDES_EVIDENCE_EPOCH")

    def test_fragment_codec_rejects_bool_as_numeric_and_round_trips(self) -> None:
        fragment = fragments_factory()[0]
        self.assertEqual(
            CaptureFragmentDescriptor.from_json_bytes(fragment.to_json_bytes()), fragment
        )
        with self.assertRaisesRegex(ValueError, "fragment_sequence"):
            replace(fragment, fragment_sequence=False)
        with self.assertRaisesRegex(ValueError, "keyframe_at_start"):
            replace(fragment, keyframe_at_start=1)


if __name__ == "__main__":
    unittest.main()
