from __future__ import annotations

import ast
import inspect
import json
import unittest

import vision_scoring.capture_contracts as capture_contracts_module
import vision_scoring.capture_integrity as capture_integrity_module
import vision_scoring.capture_windows as capture_windows_module
from vision_scoring.capture_contracts import (
    CAPTURE_SCHEMA_VERSION,
    DIAGNOSTIC_FINGERPRINT_CONTRACT,
    CaptureBoundaryKind,
    CaptureContractError,
    CaptureDropNotice,
    CaptureDropReason,
    CaptureFragmentDescriptor,
    CaptureFrameSignal,
    CaptureSessionDescriptor,
    CaptureSourceKind,
    CaptureStreamBoundary,
    CaptureTrustDomain,
    EvidenceWindowRequest,
    ExposurePolicy,
    IntegrityFinding,
    IntegrityFindingKind,
    WindowRequestOrigin,
    decode_capture_trace_record,
    encode_capture_trace_record,
)


def sha(character: str) -> str:
    return character * 64


def synthetic_session(**changes: object) -> CaptureSessionDescriptor:
    values: dict[str, object] = {
        "source_kind": CaptureSourceKind.SYNTHETIC_TEST,
        "trust_domain": CaptureTrustDomain.SYNTHETIC_TEST,
        "deployment_id": "deployment-test",
        "session_id": "session-test",
        "match_id": "match-test",
        "stream_id": "stream-main",
        "reconnect_epoch": 0,
        "expected_width": 3840,
        "expected_height": 2160,
        "fps_numerator": 60,
        "fps_denominator": 1,
        "capture_profile_sha256": sha("1"),
        "backend_artifact_sha256": sha("2"),
        "camera_attestation_sha256": None,
        "clock_attestation_sha256": None,
        "encoder_configuration_sha256": sha("3"),
        "rights_grant_sha256": None,
        "evidence_time_open_ns": 0,
        "exposure_policy": ExposurePolicy.MANUAL_LOCKED,
        "exposure_configuration_sha256": sha("4"),
        "locked_exposure_duration_ns": 1_000_000,
        "locked_gain_milli_db": 100,
        "locked_iso": 200,
    }
    values.update(changes)
    return CaptureSessionDescriptor(**values)


class CaptureContractTests(unittest.TestCase):
    def test_session_codec_round_trip_is_canonical_and_fingerprinted(self) -> None:
        session = synthetic_session()
        encoded = session.to_json_bytes()
        self.assertEqual(CaptureSessionDescriptor.from_json_bytes(encoded), session)
        self.assertEqual(len(session.fingerprint()), 64)
        self.assertEqual(json.dumps(json.loads(encoded), sort_keys=True, separators=(",", ":")).encode(), encoded)

    def test_session_codec_rejects_duplicate_noncanonical_and_extra_fields(self) -> None:
        session = synthetic_session()
        encoded = session.to_json_bytes()
        duplicate = encoded[:-1] + b',"schema_version":"1.0"}'
        with self.assertRaisesRegex(CaptureContractError, "DUPLICATE_JSON_KEY"):
            CaptureSessionDescriptor.from_json_bytes(duplicate)
        with self.assertRaisesRegex(CaptureContractError, "NONCANONICAL_JSON"):
            CaptureSessionDescriptor.from_json_bytes(b" " + encoded)
        value = json.loads(encoded)
        value["unexpected"] = 1
        extra = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            CaptureSessionDescriptor.from_json_bytes(extra)

    def test_codec_rejects_nonfinite_and_oversize_json(self) -> None:
        with self.assertRaisesRegex(CaptureContractError, "NONFINITE_JSON_NUMBER"):
            CaptureSessionDescriptor.from_json_bytes(b'{"x":NaN}')
        with self.assertRaisesRegex(CaptureContractError, "JSON_SIZE_EXCEEDED"):
            CaptureSessionDescriptor.from_json_bytes(b"{" + b" " * (256 * 1024) + b"}")

    def test_integrity_finding_codec_is_strict_canonical_and_fingerprinted(self) -> None:
        finding = IntegrityFinding(
            kind=IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP,
            observed_sequence_start=4,
            observed_sequence_end=5,
            evidence_start_ns=1_000,
            evidence_end_ns=2_000,
            basis=(("delta_basis", "decimal:9223372036854775808"), ("inferred", True)),
        )
        encoded = finding.to_json_bytes()
        self.assertEqual(IntegrityFinding.from_json_bytes(encoded), finding)
        self.assertEqual(
            IntegrityFinding.from_json_bytes(encoded).fingerprint(),
            finding.fingerprint(),
        )
        self.assertEqual(len(finding.fingerprint()), 64)
        self.assertEqual(
            json.dumps(
                json.loads(encoded), sort_keys=True, separators=(",", ":")
            ).encode(),
            encoded,
        )

    def test_integrity_finding_codec_rejects_unknown_nested_and_duplicate_fields(self) -> None:
        finding = IntegrityFinding(
            kind=IntegrityFindingKind.EXPLICIT_BACKEND_DROP,
            observed_sequence_start=1,
            observed_sequence_end=1,
            evidence_start_ns=None,
            evidence_end_ns=None,
            basis=(("reason", "UNKNOWN"),),
        )
        value = json.loads(finding.to_json_bytes())
        value["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            IntegrityFinding.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

        value = json.loads(finding.to_json_bytes())
        value["basis"][0]["unexpected"] = 1
        with self.assertRaisesRegex(CaptureContractError, "INVALID_FIELD_SET"):
            IntegrityFinding.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

        duplicate = finding.to_json_bytes()[:-1] + b',"schema_version":"1.0"}'
        with self.assertRaisesRegex(CaptureContractError, "DUPLICATE_JSON_KEY"):
            IntegrityFinding.from_json_bytes(duplicate)

    def test_integrity_finding_codec_rejects_numeric_depth_and_size_attacks(self) -> None:
        finding = IntegrityFinding(
            kind=IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            observed_sequence_start=1,
            observed_sequence_end=1,
            evidence_start_ns=None,
            evidence_end_ns=None,
            basis=(),
        )
        encoded = finding.to_json_bytes()
        with self.assertRaisesRegex(CaptureContractError, "JSON_INTEGER_RANGE"):
            IntegrityFinding.from_json_bytes(
                encoded.replace(
                    b'"observed_sequence_start":1',
                    b'"observed_sequence_start":9223372036854775808',
                )
            )
        with self.assertRaisesRegex(CaptureContractError, "INVALID_JSON_NUMBER"):
            IntegrityFinding.from_json_bytes(
                encoded.replace(
                    b'"observed_sequence_start":1',
                    b'"observed_sequence_start":1.0',
                )
            )
        with self.assertRaisesRegex(CaptureContractError, "NONFINITE_JSON_NUMBER"):
            IntegrityFinding.from_json_bytes(
                encoded.replace(
                    b'"observed_sequence_start":1',
                    b'"observed_sequence_start":Infinity',
                )
            )
        too_deep = b'{"a":' + b"[" * 25 + b"0" + b"]" * 25 + b"}"
        with self.assertRaisesRegex(CaptureContractError, "JSON_DEPTH_EXCEEDED"):
            IntegrityFinding.from_json_bytes(too_deep)
        with self.assertRaisesRegex(CaptureContractError, "JSON_SIZE_EXCEEDED"):
            IntegrityFinding.from_json_bytes(
                b"{" + b" " * (256 * 1024) + b"}"
            )

        value = json.loads(finding.to_json_bytes())
        value["basis"] = [
            {"key": f"key-{index}", "value": index}
            for index in range(17)
        ]
        with self.assertRaisesRegex(
            CaptureContractError, "INVALID_INTEGRITY_FINDING"
        ):
            IntegrityFinding.from_json_bytes(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_bool_is_not_an_integer(self) -> None:
        with self.assertRaisesRegex(ValueError, "reconnect_epoch"):
            synthetic_session(reconnect_epoch=True)
        with self.assertRaisesRegex(ValueError, "fps_numerator"):
            synthetic_session(fps_numerator=True)
        with self.assertRaisesRegex(ValueError, "keyframe_at_start"):
            CaptureFragmentDescriptor(
                fragment_id="fragment-0",
                session_fingerprint=sha("a"),
                session_configuration_fingerprint=sha("9"),
                reconnect_epoch=0,
                fragment_sequence=0,
                evidence_start_ns=0,
                evidence_end_ns=1_000_000_000,
                device_start_timestamp=0,
                device_end_timestamp=60,
                device_time_base_numerator=1,
                device_time_base_denominator=60,
                byte_length=1,
                content_sha256=sha("b"),
                frame_count=60,
                keyframe_at_start=1,
                capture_profile_sha256=sha("c"),
                camera_fingerprint=sha("d"),
                clock_fingerprint=sha("e"),
                encoder_configuration_sha256=sha("f"),
                exposure_configuration_sha256=sha("0"),
            )

    def test_rationals_must_be_positive_reduced_and_exact(self) -> None:
        with self.assertRaisesRegex(ValueError, "reduced positive rational"):
            synthetic_session(fps_numerator=120, fps_denominator=2)
        with self.assertRaisesRegex(ValueError, "fps_numerator"):
            synthetic_session(fps_numerator=60.0)

    def test_live_session_requires_production_camera_clock_and_rights(self) -> None:
        with self.assertRaisesRegex(ValueError, "live camera requires"):
            synthetic_session(source_kind=CaptureSourceKind.LIVE_CAMERA)
        live = synthetic_session(
            source_kind=CaptureSourceKind.LIVE_CAMERA,
            trust_domain=CaptureTrustDomain.PRODUCTION_CAPTURE,
            camera_attestation_sha256=sha("5"),
            clock_attestation_sha256=sha("6"),
            rights_grant_sha256=sha("7"),
        )
        self.assertEqual(live.source_kind, CaptureSourceKind.LIVE_CAMERA)

    def test_synthetic_session_cannot_claim_production_trust(self) -> None:
        with self.assertRaisesRegex(ValueError, "synthetic source"):
            synthetic_session(camera_attestation_sha256=sha("5"))
        with self.assertRaisesRegex(ValueError, "synthetic source"):
            synthetic_session(trust_domain=CaptureTrustDomain.PRODUCTION_CAPTURE)

    def test_every_locked_exposure_policy_requires_captured_baselines(self) -> None:
        with self.assertRaisesRegex(ValueError, "locked exposure requires"):
            synthetic_session(locked_iso=None)
        auto = synthetic_session(
            exposure_policy=ExposurePolicy.AUTO_LOCKED,
        )
        self.assertEqual(auto.exposure_policy, ExposurePolicy.AUTO_LOCKED)
        with self.assertRaisesRegex(ValueError, "locked exposure requires"):
            synthetic_session(
                exposure_policy=ExposurePolicy.AUTO_LOCKED,
                locked_iso=None,
            )

    def test_exposure_provenance_changes_configuration_identity(self) -> None:
        baseline = synthetic_session()
        changed_policy = synthetic_session(
            exposure_configuration_sha256=sha("5")
        )
        changed_value = synthetic_session(locked_iso=201)
        self.assertNotEqual(
            baseline.configuration_fingerprint,
            changed_policy.configuration_fingerprint,
        )
        self.assertNotEqual(
            baseline.configuration_fingerprint,
            changed_value.configuration_fingerprint,
        )

    def test_diagnostic_hash_contract_is_exact_and_paired(self) -> None:
        session = synthetic_session()
        common = dict(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            observed_sequence=0,
            device_sequence=0,
            device_timestamp=0,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            host_monotonic_ns=0,
            width=3840,
            height=2160,
            configuration_fingerprint=session.configuration_fingerprint,
        )
        with self.assertRaisesRegex(ValueError, "present together"):
            CaptureFrameSignal(**common, diagnostic_luma_sha256=sha("a"))
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic"):
            CaptureFrameSignal(
                **common,
                diagnostic_contract="RGB_HASH_V1",
                diagnostic_luma_sha256=sha("a"),
            )
        frame = CaptureFrameSignal(
            **common,
            diagnostic_contract=DIAGNOSTIC_FINGERPRINT_CONTRACT,
            diagnostic_luma_sha256=sha("a"),
        )
        self.assertEqual(frame.diagnostic_contract, DIAGNOSTIC_FINGERPRINT_CONTRACT)

    def test_trace_record_codecs_preserve_exact_variant(self) -> None:
        session = synthetic_session()
        frame = CaptureFrameSignal(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            observed_sequence=0,
            device_sequence=None,
            device_timestamp=0,
            device_time_base_numerator=1,
            device_time_base_denominator=60,
            host_monotonic_ns=0,
            width=3840,
            height=2160,
            configuration_fingerprint=session.configuration_fingerprint,
        )
        boundary = CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=0,
            host_monotonic_ns=0,
            kind=CaptureBoundaryKind.START,
            configuration_fingerprint=session.configuration_fingerprint,
        )
        drop = CaptureDropNotice(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            after_observed_sequence=0,
            device_timestamp=None,
            device_time_base_numerator=None,
            device_time_base_denominator=None,
            host_monotonic_ns=1,
            reported_count=None,
            reason=CaptureDropReason.UNKNOWN,
        )
        for record in (frame, boundary, drop):
            self.assertEqual(decode_capture_trace_record(encode_capture_trace_record(record)), record)

    def test_config_change_requires_new_provenance(self) -> None:
        session = synthetic_session()
        common = dict(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=1,
            host_monotonic_ns=1,
            kind=CaptureBoundaryKind.CONFIG_CHANGE,
            configuration_fingerprint=session.configuration_fingerprint,
        )
        with self.assertRaisesRegex(ValueError, "distinct new configuration"):
            CaptureStreamBoundary(**common, new_configuration_fingerprint=None)
        boundary = CaptureStreamBoundary(
            **common, new_configuration_fingerprint=sha("9")
        )
        self.assertEqual(boundary.kind, CaptureBoundaryKind.CONFIG_CHANGE)

    def test_window_request_origin_cannot_assert_a_scoring_event(self) -> None:
        request = EvidenceWindowRequest(
            request_id="request-1",
            idempotency_key="capture-window:1",
            session_fingerprint=sha("a"),
            expected_session_configuration_fingerprint=sha("b"),
            reconnect_epoch=0,
            trigger_evidence_time_ns=5_000_000_000,
            pre_roll_ns=1_000_000_000,
            post_roll_ns=2_000_000_000,
            origin=WindowRequestOrigin.UNTRUSTED_PERCEPTION_TRIGGER,
            requested_at_ns=6_000_000_000,
        )
        self.assertEqual(EvidenceWindowRequest.from_json_bytes(request.to_json_bytes()), request)
        self.assertEqual(
            {origin.value for origin in WindowRequestOrigin},
            {
                "SYNTHETIC_TEST",
                "HUMAN_REVIEW_TRIGGER",
                "UNTRUSTED_PERCEPTION_TRIGGER",
            },
        )
        self.assertEqual(request.schema_version, CAPTURE_SCHEMA_VERSION)

    def test_schema_is_explicitly_video_only(self) -> None:
        session_fields = set(CaptureSessionDescriptor.__dataclass_fields__)
        frame_fields = set(CaptureFrameSignal.__dataclass_fields__)
        self.assertFalse(any("audio" in name.lower() for name in session_fields | frame_fields))

    def test_capture_modules_have_no_scoring_or_persistence_import_path(self) -> None:
        forbidden_roots = {
            "authorization",
            "domain_events",
            "event_store",
            "policy",
            "rules",
            "state_codec",
        }
        forbidden_symbols = {
            "AuthorizationCommand",
            "RuleEvent",
            "DomainEvent",
            "EventStore",
            "ScoreCheck",
        }
        for module in (
            capture_contracts_module,
            capture_integrity_module,
            capture_windows_module,
        ):
            tree = ast.parse(inspect.getsource(module))
            imported: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(alias.name.rsplit(".", 1)[-1] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.rsplit(".", 1)[-1])
            self.assertTrue(forbidden_roots.isdisjoint(imported), module.__name__)
            self.assertTrue(
                forbidden_symbols.isdisjoint(vars(module)), module.__name__
            )


if __name__ == "__main__":
    unittest.main()
