from __future__ import annotations

from dataclasses import replace
from fractions import Fraction
import json
import unittest

from vision_scoring.capture_contracts import (
    DIAGNOSTIC_FINGERPRINT_CONTRACT,
    MAX_SIGNED_64,
    MIN_SIGNED_64,
    CaptureBoundaryKind,
    CaptureContractError,
    CaptureDropNotice,
    CaptureDropReason,
    CaptureFrameSignal,
    CaptureSessionDescriptor,
    CaptureSegmentIntegrityReport,
    CaptureSourceKind,
    CaptureStreamBoundary,
    CaptureTrustDomain,
    ExposurePolicy,
    FinalizedSourceFrameSignal,
    IntegrityDisposition,
    IntegrityFinding,
    IntegrityFindingKind,
)
from vision_scoring.capture_integrity import (
    ClockMappingCandidate,
    evaluate_capture_trace,
)


def sha(character: str) -> str:
    return character * 64


def session_factory(
    *,
    fps_numerator: int = 60,
    fps_denominator: int = 1,
    exposure_policy: ExposurePolicy = ExposurePolicy.MANUAL_LOCKED,
    live: bool = False,
) -> CaptureSessionDescriptor:
    return CaptureSessionDescriptor(
        source_kind=(
            CaptureSourceKind.LIVE_CAMERA if live else CaptureSourceKind.SYNTHETIC_TEST
        ),
        trust_domain=(
            CaptureTrustDomain.PRODUCTION_CAPTURE
            if live
            else CaptureTrustDomain.SYNTHETIC_TEST
        ),
        deployment_id="deployment-test",
        session_id="session-test",
        match_id="match-test",
        stream_id="stream-main",
        reconnect_epoch=0,
        expected_width=3840,
        expected_height=2160,
        fps_numerator=fps_numerator,
        fps_denominator=fps_denominator,
        capture_profile_sha256=sha("1"),
        backend_artifact_sha256=sha("2"),
        camera_attestation_sha256=sha("5") if live else None,
        clock_attestation_sha256=sha("6") if live else None,
        encoder_configuration_sha256=sha("3"),
        rights_grant_sha256=sha("7") if live else None,
        evidence_time_open_ns=0,
        exposure_policy=exposure_policy,
        exposure_configuration_sha256=sha("4"),
        locked_exposure_duration_ns=1_000_000,
        locked_gain_milli_db=100,
        locked_iso=200,
    )


def mapping_factory(
    session: CaptureSessionDescriptor,
    *,
    time_base_numerator: int,
    time_base_denominator: int,
) -> ClockMappingCandidate:
    return ClockMappingCandidate(
        session_fingerprint=session.fingerprint(),
        reconnect_epoch=session.reconnect_epoch,
        trust_domain=session.trust_domain,
        clock_attestation_sha256=session.clock_attestation_sha256,
        device_anchor_timestamp=0,
        device_time_base_numerator=time_base_numerator,
        device_time_base_denominator=time_base_denominator,
        evidence_anchor_ns=0,
        rate_numerator=1,
        rate_denominator=1,
        valid_host_start_ns=0,
        valid_host_end_ns=60_000_000_000,
        claimed_max_absolute_error_ns=1_000,
    )


def build_trace(
    session: CaptureSessionDescriptor,
    mapping: ClockMappingCandidate,
    *,
    timestamps: list[int],
    device_sequences: list[int | None] | None = None,
    diagnostic_hashes: list[str | None] | None = None,
    exposure_isos: list[int | None] | None = None,
) -> tuple[tuple[object, ...], tuple[FinalizedSourceFrameSignal, ...]]:
    sequences = device_sequences or list(range(len(timestamps)))
    hashes = diagnostic_hashes or [None] * len(timestamps)
    isos = exposure_isos or [session.locked_iso] * len(timestamps)
    frames: list[CaptureFrameSignal] = []
    finalized: list[FinalizedSourceFrameSignal] = []
    for index, timestamp in enumerate(timestamps):
        evidence_ns = mapping.map_ns(
            timestamp,
            time_base_numerator=mapping.device_time_base_numerator,
            time_base_denominator=mapping.device_time_base_denominator,
        )
        frames.append(
            CaptureFrameSignal(
                session_fingerprint=session.fingerprint(),
                reconnect_epoch=0,
                observed_sequence=index,
                device_sequence=sequences[index],
                device_timestamp=timestamp,
                device_time_base_numerator=mapping.device_time_base_numerator,
                device_time_base_denominator=mapping.device_time_base_denominator,
                host_monotonic_ns=evidence_ns,
                width=3840,
                height=2160,
                configuration_fingerprint=session.configuration_fingerprint,
                diagnostic_contract=(
                    DIAGNOSTIC_FINGERPRINT_CONTRACT if hashes[index] else None
                ),
                diagnostic_luma_sha256=hashes[index],
                exposure_duration_ns=(
                    session.locked_exposure_duration_ns
                    if session.exposure_policy is ExposurePolicy.MANUAL_LOCKED
                    else 1_000_000
                ),
                gain_milli_db=(
                    session.locked_gain_milli_db
                    if session.exposure_policy is ExposurePolicy.MANUAL_LOCKED
                    else 100
                ),
                iso=isos[index],
            )
        )
        finalized.append(
            FinalizedSourceFrameSignal(
                session_fingerprint=session.fingerprint(),
                reconnect_epoch=0,
                configuration_fingerprint=session.configuration_fingerprint,
                presentation_index=index,
                source_pts=timestamp,
                source_time_base_numerator=mapping.device_time_base_numerator,
                source_time_base_denominator=mapping.device_time_base_denominator,
                mapped_evidence_timestamp_ns=evidence_ns,
                width=3840,
                height=2160,
                represented_in_output=True,
            )
        )
    records: tuple[object, ...] = (
        CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=0,
            host_monotonic_ns=0,
            kind=CaptureBoundaryKind.START,
            configuration_fingerprint=session.configuration_fingerprint,
        ),
        *frames,
        CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=len(frames),
            host_monotonic_ns=(frames[-1].host_monotonic_ns if frames else 0),
            kind=CaptureBoundaryKind.STOP,
            configuration_fingerprint=session.configuration_fingerprint,
        ),
    )
    return records, tuple(finalized)


class CaptureIntegrityTests(unittest.TestCase):
    def test_exact_rational_clock_mapping_at_60000_over_1001(self) -> None:
        session = session_factory(fps_numerator=60_000, fps_denominator=1_001)
        mapping = mapping_factory(
            session,
            time_base_numerator=1_001,
            time_base_denominator=60_000,
        )
        self.assertEqual(
            mapping.map_fraction(
                1, time_base_numerator=1_001, time_base_denominator=60_000
            ),
            Fraction(50_050_000, 3),
        )
        self.assertEqual(
            mapping.map_ns(
                1, time_base_numerator=1_001, time_base_denominator=60_000
            ),
            16_683_333,
        )

    def test_clean_synthetic_trace_is_observed_clean_but_never_operational(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 2, 3])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)
        self.assertTrue(report.finalized_trace_structurally_valid)
        self.assertFalse(report.structurally_eligible_for_trust_verification)
        self.assertIn("SYNTHETIC_NON_OPERATIONAL", report.reason_codes)
        self.assertEqual(report.total_finding_count, 0)
        self.assertTrue(report.video_only)

    def test_integrity_report_codec_round_trip_and_fingerprint_are_stable(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 2])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        encoded = report.to_json_bytes()
        decoded = CaptureSegmentIntegrityReport.from_json_bytes(encoded)
        self.assertEqual(decoded, report)
        self.assertEqual(decoded.fingerprint(), report.fingerprint())
        self.assertEqual(len(report.fingerprint()), 64)
        self.assertEqual(
            json.dumps(
                json.loads(encoded), sort_keys=True, separators=(",", ":")
            ).encode(),
            encoded,
        )

    def test_integrity_report_codec_rejects_unknown_nested_fields(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 2])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertTrue(report.findings)

        value = json.loads(report.to_json_bytes())
        value["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

        value = json.loads(report.to_json_bytes())
        value["findings"][0]["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

        value = json.loads(report.to_json_bytes())
        value["findings"][0]["basis"][0]["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_integrity_report_fingerprint_detects_canonical_payload_tampering(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        value = json.loads(report.to_json_bytes())
        value["window_fingerprint"] = sha("f")
        tampered = CaptureSegmentIntegrityReport.from_json_bytes(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        )
        self.assertNotEqual(tampered.fingerprint(), report.fingerprint())

    def test_integrity_report_codec_enforces_detailed_finding_ceiling(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 2])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        value = json.loads(report.to_json_bytes())
        value["findings"] = [value["findings"][0] for _ in range(65)]
        with self.assertRaisesRegex(CaptureContractError, "INVALID_CAPTURE_REPORT"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )
        one_records, one_finalized = build_trace(
            session, mapping, timestamps=[0]
        )
        one_frame_report = evaluate_capture_trace(
            session, mapping, one_records, one_finalized
        )
        for patch in (
            {"source_end_pts": one_frame_report.source_start_pts + 1},
            {"evidence_end_ns": one_frame_report.evidence_start_ns + 1},
        ):
            value = json.loads(one_frame_report.to_json_bytes())
            value.update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(
                CaptureContractError, "INVALID_CAPTURE_REPORT"
            ):
                CaptureSegmentIntegrityReport.from_json_bytes(
                    json.dumps(
                        value, sort_keys=True, separators=(",", ":")
                    ).encode()
                )

        live_session = session_factory(live=True)
        live_mapping = mapping_factory(
            live_session, time_base_numerator=1, time_base_denominator=60
        )
        live_records, live_finalized = build_trace(
            live_session, live_mapping, timestamps=[0, 1, 2]
        )
        live_report = evaluate_capture_trace(
            live_session, live_mapping, live_records, live_finalized
        )
        value = json.loads(live_report.to_json_bytes())
        value["source_end_pts"] = value["source_start_pts"]
        with self.assertRaisesRegex(CaptureContractError, "INVALID_CAPTURE_REPORT"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )
        for patch in (
            {
                "observed_frame_count": 3_601,
                "finalized_frame_count": 3_601,
                "source_end_pts": 3_600,
            },
            {"fps_numerator": 1_000_001, "fps_denominator": 1},
        ):
            value = json.loads(live_report.to_json_bytes())
            value.update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(
                CaptureContractError, "INVALID_CAPTURE_REPORT"
            ):
                CaptureSegmentIntegrityReport.from_json_bytes(
                    json.dumps(
                        value, sort_keys=True, separators=(",", ":")
                    ).encode()
                )

    def test_integrity_report_codec_rejects_derived_field_tampering(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 2])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        gap_reason = IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP.value
        for patch in (
            {"disposition": IntegrityDisposition.OBSERVED_CLEAN.value},
            {"inferred_timestamp_gap_count": 0},
            {
                "reason_codes": [
                    reason
                    for reason in report.reason_codes
                    if reason != gap_reason
                ]
            },
        ):
            value = json.loads(report.to_json_bytes())
            value.update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(
                CaptureContractError, "INVALID_CAPTURE_REPORT"
            ):
                CaptureSegmentIntegrityReport.from_json_bytes(
                    json.dumps(
                        value, sort_keys=True, separators=(",", ":")
                    ).encode()
                )

        clean_records, clean_finalized = build_trace(
            session, mapping, timestamps=[0, 1]
        )
        clean = evaluate_capture_trace(
            session, mapping, clean_records, clean_finalized
        )
        value = json.loads(clean.to_json_bytes())
        value["structurally_eligible_for_trust_verification"] = True
        with self.assertRaisesRegex(CaptureContractError, "INVALID_CAPTURE_REPORT"):
            CaptureSegmentIntegrityReport.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_constructible_report_always_fits_public_codec_bound(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        clean = evaluate_capture_trace(session, mapping, records, finalized)
        maximal_finding = IntegrityFinding(
            kind=IntegrityFindingKind.DIAGNOSTIC_FREEZE_CANDIDATE,
            observed_sequence_start=0,
            observed_sequence_end=0,
            evidence_start_ns=0,
            evidence_end_ns=0,
            basis=tuple(
                (f"basis-{index:02d}", "x" * 256)
                for index in range(16)
            ),
        )
        with self.assertRaisesRegex(ValueError, "exceeds 262144 bytes"):
            replace(
                clean,
                findings=(maximal_finding,) * 64,
                total_finding_count=64,
                finding_kind_counts=tuple(
                    (
                        kind,
                        64
                        if kind
                        is IntegrityFindingKind.DIAGNOSTIC_FREEZE_CANDIDATE
                        else 0,
                    )
                    for kind, _ in clean.finding_kind_counts
                ),
                freeze_candidate_count=64,
                disposition=IntegrityDisposition.OBSERVED_DEGRADED,
                reason_codes=(
                    IntegrityFindingKind.DIAGNOSTIC_FREEZE_CANDIDATE.value,
                    "SYNTHETIC_NON_OPERATIONAL",
                ),
            )

    def test_clean_live_trace_is_only_structurally_ready_for_trust_verification(self) -> None:
        session = session_factory(live=True)
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 2])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)
        self.assertTrue(report.structurally_eligible_for_trust_verification)
        self.assertIn(
            "CRYPTOGRAPHIC_CAPTURE_TRUST_NOT_VERIFIED",
            report.reason_codes,
        )

    def test_timestamp_gap_is_inferred_and_never_an_explicit_drop(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 3])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.inferred_timestamp_gap_count, 1)
        self.assertEqual(report.explicit_drop_notice_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)
        finding = next(
            value
            for value in report.findings
            if value.kind is IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP
        )
        self.assertNotIn("missing_count", dict(finding.basis))

    def test_degraded_live_trace_cannot_claim_structural_trust_readiness(self) -> None:
        session = session_factory(live=True)
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 3])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)
        self.assertFalse(report.structurally_eligible_for_trust_verification)

    def test_gap_threshold_uses_exact_greater_than_three_halves_periods(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=120
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 3])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.inferred_timestamp_gap_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)

        records, finalized = build_trace(session, mapping, timestamps=[0, 4])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.inferred_timestamp_gap_count, 1)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)

    def test_explicit_drop_notice_is_distinct_from_timestamp_inference(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        notice = CaptureDropNotice(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            after_observed_sequence=0,
            device_timestamp=0,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            host_monotonic_ns=0,
            reported_count=2,
            reason=CaptureDropReason.OUT_OF_BUFFERS,
        )
        records = (records[0], records[1], notice, *records[2:])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.explicit_drop_notice_count, 1)
        self.assertEqual(report.explicit_reported_drop_count, 2)
        self.assertEqual(report.inferred_timestamp_gap_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)

    def test_unmappable_drop_timestamp_does_not_claim_prior_frame_time(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        notice = CaptureDropNotice(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            after_observed_sequence=0,
            device_timestamp=MAX_SIGNED_64,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            host_monotonic_ns=0,
            reported_count=None,
            reason=CaptureDropReason.UNKNOWN,
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], notice, *records[2:]),
            finalized,
        )
        finding = next(
            item
            for item in report.findings
            if item.kind is IntegrityFindingKind.EXPLICIT_BACKEND_DROP
        )
        self.assertIsNone(finding.evidence_start_ns)
        self.assertEqual(
            dict(finding.basis)["evidence_time_basis"],
            "UNAVAILABLE_MAPPING_FAILED",
        )

    def test_drop_notice_time_base_substitution_invalidates_location(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        notice = CaptureDropNotice(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            after_observed_sequence=0,
            device_timestamp=1,
            device_time_base_numerator=1,
            device_time_base_denominator=30,
            host_monotonic_ns=0,
            reported_count=1,
            reason=CaptureDropReason.LATE_DATA,
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], notice, *records[2:]),
            finalized,
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        explicit = next(
            item
            for item in report.findings
            if item.kind is IntegrityFindingKind.EXPLICIT_BACKEND_DROP
        )
        self.assertIsNone(explicit.evidence_start_ns)
        self.assertIn("CLOCK_MAPPING_FAILURE", report.reason_codes)

    def test_initial_drop_notice_uses_no_after_frame_sequence(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        notice = CaptureDropNotice(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            after_observed_sequence=None,
            device_timestamp=0,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            host_monotonic_ns=0,
            reported_count=1,
            reason=CaptureDropReason.OUT_OF_BUFFERS,
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], notice, *records[1:]),
            finalized,
        )
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)
        self.assertNotIn("STREAM_SEQUENCE_FAILURE", report.reason_codes)

    def test_device_sequence_gap_is_independent_of_device_time(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            session, mapping, timestamps=[0, 1, 2], device_sequences=[0, 1, 4]
        )
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.device_sequence_gap_count, 1)
        self.assertEqual(report.inferred_timestamp_gap_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)

    def test_missing_optional_device_sequence_breaks_the_gap_chain(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            session,
            mapping,
            timestamps=[0, 1, 2],
            device_sequences=[0, None, 2],
        )
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.device_sequence_gap_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)

    def test_repeated_luma_is_only_a_freeze_candidate(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            session,
            mapping,
            timestamps=list(range(17)),
            diagnostic_hashes=[sha("a")] * 17,
        )
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.freeze_candidate_count, 1)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_DEGRADED)
        kinds = {finding.kind.value for finding in report.findings}
        self.assertEqual(kinds, {"DIAGNOSTIC_FREEZE_CANDIDATE"})
        self.assertFalse(any("VERIFIED" in kind for kind in kinds))
        finding = report.findings[0]
        self.assertEqual(
            dict(finding.basis)["authority"],
            "NON_AUTHORITATIVE_CANDIDATE_ONLY",
        )

    def test_short_repeated_luma_does_not_create_a_finding(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            session,
            mapping,
            timestamps=list(range(15)),
            diagnostic_hashes=[sha("a")] * 15,
        )
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.freeze_candidate_count, 0)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)

    def test_reconnect_and_config_boundaries_invalidate_segment(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        reconnect = CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=1,
            host_monotonic_ns=1,
            kind=CaptureBoundaryKind.INTERRUPT,
            configuration_fingerprint=session.configuration_fingerprint,
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], reconnect, *records[2:]),
            finalized,
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("RECONNECT_BOUNDARY", report.reason_codes)

        changed = CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=1,
            host_monotonic_ns=1,
            kind=CaptureBoundaryKind.CONFIG_CHANGE,
            configuration_fingerprint=session.configuration_fingerprint,
            new_configuration_fingerprint=sha("9"),
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], changed, *records[2:]),
            finalized,
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("CONFIGURATION_CHANGE", report.reason_codes)

    def test_frame_before_start_boundary_invalidates_segment(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        late_start = replace(records[0], at_observed_sequence=1)
        reordered = (records[1], late_start, records[2], records[-1])
        report = evaluate_capture_trace(session, mapping, reordered, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertTrue(
            any(
                dict(finding.basis).get("reason")
                == "FIRST_RECORD_MUST_BE_START_AT_SEQUENCE_ZERO"
                for finding in report.findings
            )
        )

    def test_observed_sequence_exhaustion_returns_invalid_report(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        exhausted = (
            records[0],
            replace(records[1], observed_sequence=MAX_SIGNED_64),
            replace(records[2], observed_sequence=MAX_SIGNED_64),
            replace(records[-1], at_observed_sequence=MAX_SIGNED_64),
        )
        report = evaluate_capture_trace(session, mapping, exhausted, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("STREAM_SEQUENCE_FAILURE", report.reason_codes)

    def test_extreme_signed_timestamp_delta_returns_invalid_report(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        extreme = (
            records[0],
            replace(records[1], device_timestamp=-(1 << 63)),
            replace(records[2], device_timestamp=MAX_SIGNED_64),
            records[-1],
        )
        report = evaluate_capture_trace(session, mapping, extreme, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("CLOCK_MAPPING_FAILURE", report.reason_codes)

    def test_failed_mapping_omits_regression_evidence_intervals(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        invalid_trace = (
            records[0],
            replace(records[1], device_timestamp=1, device_sequence=0),
            replace(
                records[2],
                device_timestamp=MIN_SIGNED_64,
                device_sequence=0,
            ),
            records[-1],
        )
        report = evaluate_capture_trace(
            session, mapping, invalid_trace, finalized
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        relevant = tuple(
            finding
            for finding in report.findings
            if finding.kind
            in (
                IntegrityFindingKind.TIMESTAMP_DUPLICATE_OR_REGRESSION,
                IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            )
            and (
                finding.kind
                is IntegrityFindingKind.TIMESTAMP_DUPLICATE_OR_REGRESSION
                or dict(finding.basis).get("reason")
                == "DEVICE_SEQUENCE_DUPLICATE_OR_REGRESSION"
            )
        )
        self.assertEqual(len(relevant), 2)
        self.assertTrue(
            all(
                finding.evidence_start_ns is None
                and finding.evidence_end_ns is None
                for finding in relevant
            )
        )

    def test_failed_mapping_omits_positive_gap_evidence_interval(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        invalid_trace = (
            records[0],
            replace(records[1], device_timestamp=1, device_sequence=None),
            replace(
                records[2],
                device_timestamp=MAX_SIGNED_64,
                device_sequence=None,
            ),
            records[-1],
        )
        report = evaluate_capture_trace(
            session, mapping, invalid_trace, finalized
        )
        gap = next(
            finding
            for finding in report.findings
            if finding.kind is IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIsNone(gap.evidence_start_ns)
        self.assertIsNone(gap.evidence_end_ns)

    def test_manual_and_auto_locked_exposure_changes_invalidate(self) -> None:
        manual = session_factory()
        manual_mapping = mapping_factory(
            manual, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            manual,
            manual_mapping,
            timestamps=[0, 1],
            exposure_isos=[200, 201],
        )
        report = evaluate_capture_trace(manual, manual_mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("EXPOSURE_POLICY_VIOLATION", report.reason_codes)

        auto = session_factory(exposure_policy=ExposurePolicy.AUTO_LOCKED)
        auto_mapping = mapping_factory(
            auto, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(
            auto,
            auto_mapping,
            timestamps=[0, 1],
            exposure_isos=[200, 201],
        )
        report = evaluate_capture_trace(auto, auto_mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("EXPOSURE_POLICY_VIOLATION", report.reason_codes)

        records, finalized = build_trace(
            auto,
            auto_mapping,
            timestamps=[0, 1],
            exposure_isos=[900, 900],
        )
        report = evaluate_capture_trace(auto, auto_mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("EXPOSURE_POLICY_VIOLATION", report.reason_codes)

    def test_finalized_pts_must_be_strict_and_caller_time_is_not_trusted(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 2])
        regressed = (
            finalized[0],
            finalized[1],
            replace(finalized[2], source_pts=1, mapped_evidence_timestamp_ns=16_666_667),
        )
        report = evaluate_capture_trace(session, mapping, records, regressed)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertFalse(report.finalized_trace_structurally_valid)
        self.assertIn("FINALIZED_OUTPUT_VALIDATION_FAILURE", report.reason_codes)

        forged_time = (
            finalized[0],
            replace(finalized[1], mapped_evidence_timestamp_ns=999),
            finalized[2],
        )
        report = evaluate_capture_trace(session, mapping, records, forged_time)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("FINALIZED_OUTPUT_VALIDATION_FAILURE", report.reason_codes)

    def test_finalized_time_base_cannot_change_inside_a_segment(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        changed = (
            finalized[0],
            replace(
                finalized[1],
                source_pts=1,
                source_time_base_numerator=1,
                source_time_base_denominator=30,
                mapped_evidence_timestamp_ns=33_333_333,
            ),
        )
        report = evaluate_capture_trace(session, mapping, records, changed)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("FINALIZED_OUTPUT_VALIDATION_FAILURE", report.reason_codes)
        self.assertTrue(
            any(
                dict(finding.basis).get("reason") == "FINALIZED_TIME_BASE_CHANGED"
                for finding in report.findings
            )
        )

    def test_rebased_source_pts_requires_a_future_explicit_clock_mapping(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        rebased = tuple(
            replace(
                item,
                source_pts=item.source_pts + 100,
                mapped_evidence_timestamp_ns=mapping.map_ns(
                    item.source_pts + 100,
                    time_base_numerator=item.source_time_base_numerator,
                    time_base_denominator=item.source_time_base_denominator,
                ),
            )
            for item in finalized
        )
        report = evaluate_capture_trace(session, mapping, records, rebased)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertTrue(
            any(
                dict(finding.basis).get("reason")
                == "SOURCE_PTS_DID_NOT_PRESERVE_DEVICE_TIMESTAMP"
                for finding in report.findings
            )
        )

    def test_regressing_observed_sequence_and_timestamp_return_invalid_report(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        duplicate = replace(records[2], observed_sequence=0, device_timestamp=0)
        report = evaluate_capture_trace(
            session, mapping, (records[0], records[1], duplicate, records[-1]), finalized
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("STREAM_SEQUENCE_FAILURE", report.reason_codes)
        self.assertIn("TIMESTAMP_DUPLICATE_OR_REGRESSION", report.reason_codes)

    def test_dimension_and_frame_configuration_substitution_invalidate(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        substituted = replace(
            records[2], width=1920, configuration_fingerprint=sha("9")
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], substituted, records[-1]),
            finalized,
        )
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("DIMENSION_CHANGE", report.reason_codes)
        self.assertIn("CONFIGURATION_CHANGE", report.reason_codes)

    def test_b_frame_demux_order_is_irrelevant_to_presentation_trace(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        # There is deliberately no DTS/demux-order field.  The finalized trace
        # is decoded presentation order and therefore accepts increasing PTS.
        records, finalized = build_trace(session, mapping, timestamps=[0, 1, 2, 3])
        report = evaluate_capture_trace(session, mapping, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.OBSERVED_CLEAN)

    def test_clock_mapping_substitution_and_validity_fail_closed(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0, 1])
        wrong = replace(mapping, session_fingerprint=sha("f"))
        report = evaluate_capture_trace(session, wrong, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("CLOCK_MAPPING_FAILURE", report.reason_codes)

        expired = replace(mapping, valid_host_end_ns=0)
        report = evaluate_capture_trace(session, expired, records, finalized)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("CLOCK_MAPPING_FAILURE", report.reason_codes)

    def test_finding_details_are_bounded_and_truncation_is_invalid(self) -> None:
        session = session_factory()
        mapping = mapping_factory(
            session, time_base_numerator=1, time_base_denominator=60
        )
        records, finalized = build_trace(session, mapping, timestamps=[0])
        notices = tuple(
            CaptureDropNotice(
                session_fingerprint=session.fingerprint(),
                reconnect_epoch=0,
                after_observed_sequence=0,
                device_timestamp=None,
                device_time_base_numerator=None,
                device_time_base_denominator=None,
                host_monotonic_ns=0,
                reported_count=None,
                reason=CaptureDropReason.UNKNOWN,
            )
            for _ in range(65)
        )
        report = evaluate_capture_trace(
            session,
            mapping,
            (records[0], records[1], *notices, records[-1]),
            finalized,
        )
        self.assertEqual(len(report.findings), 64)
        self.assertEqual(report.total_finding_count, 65)
        self.assertTrue(report.finding_details_truncated)
        self.assertEqual(report.disposition, IntegrityDisposition.INVALID)
        self.assertIn("FINDING_DETAILS_TRUNCATED", report.reason_codes)
        self.assertEqual(
            CaptureSegmentIntegrityReport.from_json_bytes(report.to_json_bytes()),
            report,
        )

        for mutation in ("LOWER_EXPLICIT", "RAISE_TOTAL", "UNCOUNTED_REASON"):
            value = json.loads(report.to_json_bytes())
            if mutation == "LOWER_EXPLICIT":
                value["explicit_drop_notice_count"] = 64
                value["explicit_unknown_drop_count_notices"] = 64
            elif mutation == "RAISE_TOTAL":
                value["total_finding_count"] = 66
            else:
                value["reason_codes"] = sorted(
                    [
                        *value["reason_codes"],
                        IntegrityFindingKind.HOST_CLOCK_REGRESSION.value,
                    ]
                )
            with self.subTest(mutation=mutation), self.assertRaisesRegex(
                CaptureContractError, "INVALID_CAPTURE_REPORT"
            ):
                CaptureSegmentIntegrityReport.from_json_bytes(
                    json.dumps(
                        value, sort_keys=True, separators=(",", ":")
                    ).encode()
                )

        # This alternate summary is different from the evaluator output but
        # describes a logically possible hidden 65th finding. Authentication
        # of which report was produced belongs to the later trust boundary.
        plausible = json.loads(report.to_json_bytes())
        plausible["explicit_drop_notice_count"] = 64
        plausible["explicit_unknown_drop_count_notices"] = 64
        for entry in plausible["finding_kind_counts"]:
            if entry["kind"] == IntegrityFindingKind.EXPLICIT_BACKEND_DROP.value:
                entry["count"] = 64
            elif entry["kind"] == IntegrityFindingKind.HOST_CLOCK_REGRESSION.value:
                entry["count"] = 1
        plausible["reason_codes"] = sorted(
            [
                *plausible["reason_codes"],
                IntegrityFindingKind.HOST_CLOCK_REGRESSION.value,
            ]
        )
        alternate = CaptureSegmentIntegrityReport.from_json_bytes(
            json.dumps(
                plausible, sort_keys=True, separators=(",", ":")
            ).encode()
        )
        self.assertNotEqual(alternate.fingerprint(), report.fingerprint())


if __name__ == "__main__":
    unittest.main()
