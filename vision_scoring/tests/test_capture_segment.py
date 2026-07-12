from __future__ import annotations

import ast
import base64
from dataclasses import is_dataclass, replace
import hashlib
import inspect
from pathlib import Path
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_capture_assets import (
    RIGHTS_POLICY,
    SOURCE_KEY,
    _capture_metadata_attestation,
    _capture_metadata_trust_snapshot,
    _fixture,
)
from vision_scoring.capture_assets import (
    AssetResidencyStatus,
    build_structurally_verified_capture_metadata,
)
from vision_scoring.capture_segment import (
    MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES,
    MAX_CAPTURE_SEGMENT_STATEMENT_BYTES,
    MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES,
    CaptureSegmentAdmissibilityStatus,
    CaptureSegmentAttestation,
    CaptureSegmentAudioStatus,
    CaptureSegmentContentStatus,
    CaptureSegmentError,
    CaptureSegmentKeyRole,
    CaptureSegmentTrustSnapshot,
    CaptureServiceClaimStatus,
    CurrentCaptureSegment,
    FinalizedCaptureSegmentStatement,
    PhysicalCaptureTruthStatus,
    TrustedCaptureSegmentSignerKey,
    VerifiedCaptureSegmentEvidence,
    build_finalized_capture_segment_statement,
    capture_segment_signing_message,
    verify_capture_segment_attestation,
)
from vision_scoring.contract_wire import (
    CanonicalWireError,
    canonical_json_bytes,
    parse_canonical_json_object,
)

SEGMENT_KEY = Ed25519PrivateKey.from_private_bytes(b"\x71" * 32)


def _public_base64(key: Ed25519PrivateKey) -> str:
    return base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii")


def _public_sha256(public_key_base64: str) -> str:
    return hashlib.sha256(base64.b64decode(public_key_base64)).hexdigest()


def _attest(
    statement: FinalizedCaptureSegmentStatement,
    *,
    key: Ed25519PrivateKey = SEGMENT_KEY,
    key_id: str = "capture-segment-key",
    signed_at_ns: int = 450,
) -> CaptureSegmentAttestation:
    role = CaptureSegmentKeyRole.CAPTURE_SEGMENT_ATTESTATION_SIGNER
    signature = key.sign(
        capture_segment_signing_message(
            statement,
            key_id=key_id,
            key_role=role,
            trust_domain_id="capture-segment-domain",
            signed_at_ns=signed_at_ns,
        )
    )
    return CaptureSegmentAttestation(
        statement_sha256=statement.fingerprint(),
        key_id=key_id,
        key_role=role,
        capture_service_id="capture-service-1",
        trust_domain_id="capture-segment-domain",
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _snapshot(
    statement: FinalizedCaptureSegmentStatement,
    attestation: CaptureSegmentAttestation,
    prepared: dict[str, object],
    *,
    key: Ed25519PrivateKey = SEGMENT_KEY,
    key_id: str = "capture-segment-key",
    revoked_at_ns: int | None = None,
    reserved: tuple[str, ...] | None = None,
    revoked_statements: tuple[str, ...] = (),
) -> CaptureSegmentTrustSnapshot:
    metadata_snapshot = prepared["capture_metadata_trust_snapshot"]
    rights_snapshot = prepared["capture_rights_trust_snapshot"]
    if reserved is None:
        reserved = tuple(
            sorted(
                {
                    *(
                        _public_sha256(item.public_key_base64)
                        for item in metadata_snapshot.keys  # type: ignore[union-attr]
                    ),
                    *(
                        _public_sha256(item.public_key_base64)
                        for item in rights_snapshot.keys  # type: ignore[union-attr]
                    ),
                }
            )
        )
    current = CurrentCaptureSegment(
        segment_id=statement.segment_id,
        segment_sequence=0,
        capture_metadata_sha256=statement.capture_metadata_sha256,
        statement_sha256=statement.fingerprint(),
        attestation_sha256=attestation.fingerprint(),
    )
    return CaptureSegmentTrustSnapshot(
        snapshot_generation=9,
        trust_domain_id="capture-segment-domain",
        capture_service_id="capture-service-1",
        lineage_id="lineage-1",
        reconnect_epoch=0,
        capture_session_id=statement.capture_metadata.capture_session_id,
        session_fingerprint=statement.session.fingerprint(),
        capture_policy_sha256=statement.capture_policy_sha256,
        capture_policy_generation=statement.capture_policy_generation,
        keys=(
            TrustedCaptureSegmentSignerKey(
                key_id=key_id,
                key_role=(CaptureSegmentKeyRole.CAPTURE_SEGMENT_ATTESTATION_SIGNER),
                capture_service_id="capture-service-1",
                public_key_base64=_public_base64(key),
                valid_from_ns=1,
                valid_until_ns=2_000,
                revoked_at_ns=revoked_at_ns,
            ),
        ),
        current_segment=current,
        revoked_statement_sha256s=revoked_statements,
        reserved_nonsegment_public_key_sha256s=reserved,
    )


def _prepared() -> dict[str, object]:
    fixture = _fixture()
    metadata = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
    metadata_attestation = _capture_metadata_attestation(metadata)
    metadata_snapshot = _capture_metadata_trust_snapshot(metadata)
    statement = build_finalized_capture_segment_statement(
        segment_id="segment-0",
        lineage_id="lineage-1",
        capture_service_id="capture-service-1",
        finalized_at_ns=400,
        rights_verified_at_ns=400,
        capture_metadata=metadata,
        capture_metadata_attestation=metadata_attestation,
        capture_metadata_trust_snapshot=metadata_snapshot,
        session=fixture["session"],  # type: ignore[arg-type]
        clock_mapping=fixture["clock_mapping"],  # type: ignore[arg-type]
        records=fixture["records"],  # type: ignore[arg-type]
        finalized_trace=fixture["finalized_trace"],  # type: ignore[arg-type]
        window_request=fixture["window_request"],  # type: ignore[arg-type]
        fragment_projection=fixture["fragment_projection"],  # type: ignore[arg-type]
        capture_policy=fixture["capture_policy"],  # type: ignore[arg-type]
        capture_rights_grant=fixture["capture_rights_grant"],  # type: ignore[arg-type]
        capture_rights_attestation=fixture["capture_rights_attestation"],  # type: ignore[arg-type]
        capture_rights_trust_snapshot=fixture["capture_rights_trust_snapshot"],  # type: ignore[arg-type]
        expected_capture_metadata_trust_snapshot_sha256=(
            metadata_snapshot.fingerprint()
        ),
        expected_capture_rights_trust_snapshot_sha256=fixture[
            "expected_capture_rights_trust_snapshot_sha256"
        ],  # type: ignore[arg-type]
        expected_capture_policy_sha256=fixture[
            "expected_capture_policy_sha256"
        ],  # type: ignore[arg-type]
        expected_capture_policy_generation=fixture[
            "expected_capture_policy_generation"
        ],  # type: ignore[arg-type]
        expected_rights_policy_sha256=RIGHTS_POLICY,
        expected_rights_policy_generation=7,
    )
    attestation = _attest(statement)
    prepared = {
        **fixture,
        "capture_metadata": metadata,
        "capture_metadata_attestation": metadata_attestation,
        "capture_metadata_trust_snapshot": metadata_snapshot,
        "statement": statement,
        "attestation": attestation,
    }
    prepared["trust_snapshot"] = _snapshot(statement, attestation, prepared)
    return prepared


def _verify_arguments(prepared: dict[str, object]) -> dict[str, object]:
    statement = prepared["statement"]
    attestation = prepared["attestation"]
    trust_snapshot = prepared["trust_snapshot"]
    assert type(statement) is FinalizedCaptureSegmentStatement
    assert type(attestation) is CaptureSegmentAttestation
    assert type(trust_snapshot) is CaptureSegmentTrustSnapshot
    return {
        "capture_metadata": prepared["capture_metadata"],
        "capture_metadata_attestation": prepared["capture_metadata_attestation"],
        "capture_metadata_trust_snapshot": prepared["capture_metadata_trust_snapshot"],
        "session": prepared["session"],
        "clock_mapping": prepared["clock_mapping"],
        "records": prepared["records"],
        "finalized_trace": prepared["finalized_trace"],
        "window_request": prepared["window_request"],
        "fragment_projection": prepared["fragment_projection"],
        "capture_policy": prepared["capture_policy"],
        "capture_rights_grant": prepared["capture_rights_grant"],
        "capture_rights_attestation": prepared["capture_rights_attestation"],
        "capture_rights_trust_snapshot": prepared["capture_rights_trust_snapshot"],
        "expected_trust_snapshot_sha256": trust_snapshot.fingerprint(),
        "expected_trust_snapshot_generation": trust_snapshot.snapshot_generation,
        "expected_capture_service_id": "capture-service-1",
        "expected_lineage_id": "lineage-1",
        "expected_current_attestation_sha256": attestation.fingerprint(),
        "expected_capture_metadata_trust_snapshot_sha256": prepared[
            "capture_metadata_trust_snapshot"
        ].fingerprint(),  # type: ignore[union-attr]
        "expected_capture_rights_trust_snapshot_sha256": prepared[
            "capture_rights_trust_snapshot"
        ].fingerprint(),  # type: ignore[union-attr]
        "expected_capture_policy_sha256": prepared[
            "capture_policy"
        ].fingerprint(),  # type: ignore[union-attr]
        "expected_capture_policy_generation": prepared[
            "capture_policy"
        ].policy_generation,  # type: ignore[union-attr]
        "expected_rights_policy_sha256": RIGHTS_POLICY,
        "expected_rights_policy_generation": 7,
        "verified_at_ns": 500,
    }


class CaptureSegmentHappyPathTests(unittest.TestCase):
    def test_existing_capture_asset_wire_bytes_and_fingerprints_are_stable(
        self,
    ) -> None:
        prepared = _prepared()
        claim = prepared["asset_claim"]
        metadata = prepared["capture_metadata"]
        policy = prepared["capture_policy"]
        self.assertEqual(
            claim.to_json_bytes(),  # type: ignore[union-attr]
            b'{"assembly":"ORDERED_SELECTED_FRAGMENT_CONCAT_V1","asset_id":"source-asset-1","asset_sha256":"450d3b632e8afeca137e9b3e41d00f85a6e6e035d5a238f31733b967531939f6","byte_length":25,"schema_version":"1.0"}',
        )
        self.assertEqual(
            claim.fingerprint(),  # type: ignore[union-attr]
            "849e286db30f85f74db496a631558fc156173dee9450ade1d8ebe0aa1e74cbf5",
        )
        self.assertEqual(len(metadata.to_json_bytes()), 3_168)  # type: ignore[union-attr]
        self.assertEqual(
            metadata.fingerprint(),  # type: ignore[union-attr]
            "736f6185ff905900e0a308d762eede3e2c893de832619d87573656a7da6ab627",
        )
        self.assertEqual(len(policy.to_json_bytes()), 1_333)  # type: ignore[union-attr]
        self.assertEqual(
            policy.fingerprint(),  # type: ignore[union-attr]
            "401e5c7d5a9d3ea2f4c3232e071fb57072d512c21fdcf78f37c5516508869819",
        )

    def test_exact_statement_signature_current_genesis_and_replay_verify(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        snapshot = prepared["trust_snapshot"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        assert type(snapshot) is CaptureSegmentTrustSnapshot

        self.assertLessEqual(
            len(statement.to_json_bytes()), MAX_CAPTURE_SEGMENT_STATEMENT_BYTES
        )
        self.assertEqual(
            FinalizedCaptureSegmentStatement.from_json_bytes(statement.to_json_bytes()),
            statement,
        )
        self.assertEqual(
            CaptureSegmentAttestation.from_json_bytes(attestation.to_json_bytes()),
            attestation,
        )
        self.assertEqual(
            CaptureSegmentTrustSnapshot.from_json_bytes(snapshot.to_json_bytes()),
            snapshot,
        )
        verified = verify_capture_segment_attestation(
            statement, attestation, snapshot, **_verify_arguments(prepared)  # type: ignore[arg-type]
        )
        self.assertEqual(
            verified.service_claim_status,
            CaptureServiceClaimStatus.SERVICE_SIGNED_POLICY_BOUNDED_REFERENCES,
        )
        self.assertEqual(
            verified.physical_capture_truth_status,
            PhysicalCaptureTruthStatus.NOT_CLAIMED,
        )
        self.assertEqual(
            verified.asset_residency_status, AssetResidencyStatus.NOT_VERIFIED
        )
        self.assertEqual(
            verified.content_status, CaptureSegmentContentStatus.NOT_VERIFIED
        )
        self.assertEqual(
            verified.audio_status,
            CaptureSegmentAudioStatus.OUTSIDE_CAPTURE_SEGMENT_CONTRACT,
        )
        self.assertEqual(
            verified.admissibility_status,
            CaptureSegmentAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_SOURCE_RESIDENCY_AND_SIGNED_RENDER_VALIDATION,
        )
        self.assertFalse(verified.admissible_for_live_scorecheck_presentation)
        self.assertFalse(verified.admissible_for_training)
        self.assertFalse(verified.admissible_for_evaluation)
        self.assertFalse(verified.admissible_for_deployment)

        self.assertFalse(is_dataclass(verified))
        self.assertFalse(hasattr(verified, "__dict__"))
        with self.assertRaises((AttributeError, TypeError)):
            verified.segment_id = "forged"  # type: ignore[misc]
        with self.assertRaises(TypeError):
            VerifiedCaptureSegmentEvidence()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            isinstance(verified, VerifiedCaptureSegmentEvidence)


class CaptureSegmentTamperTests(unittest.TestCase):
    def test_shared_parser_rejects_float_depth_nodes_and_signed64_overflow(
        self,
    ) -> None:
        self.assertEqual(
            canonical_json_bytes(
                {"tuple": ("a", 1, True)}, label="tuple encoder regression"
            ),
            b'{"tuple":["a",1,true]}',
        )
        cases = (
            (b'{"x":1.0}', {}, "INVALID_JSON_NUMBER"),
            (
                b'{"x":9223372036854775808}',
                {},
                "JSON_INTEGER_RANGE",
            ),
            (b'{"x":[[[0]]]}', {"maximum_depth": 3}, "JSON_DEPTH_EXCEEDED"),
            (
                b'{"x":[0,0,0]}',
                {"maximum_nodes": 4},
                "JSON_NODE_LIMIT_EXCEEDED",
            ),
        )
        for raw, limits, expected_code in cases:
            with self.subTest(expected_code=expected_code), self.assertRaises(
                CanonicalWireError
            ) as caught:
                parse_canonical_json_object(raw, label="parser regression", **limits)
            self.assertEqual(caught.exception.code, expected_code)
        self.assertEqual(
            parse_canonical_json_object(
                b'{"x":-9223372036854775808}', label="signed64 minimum"
            ),
            {"x": -(1 << 63)},
        )
        with self.assertRaises(CanonicalWireError) as caught:
            canonical_json_bytes({"x": 1 << 63}, label="encoder signed64 overflow")
        self.assertEqual(caught.exception.code, "JSON_INTEGER_RANGE")

    def test_canonical_parsers_reject_noncanonical_duplicate_and_oversize(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        canonical = statement.to_json_bytes()
        for raw in (
            canonical + b"\n",
            b'{"schema_version":"1.0",' + canonical[1:],
            b"{" + b" " * MAX_CAPTURE_SEGMENT_STATEMENT_BYTES + b"}",
        ):
            with self.subTest(size=len(raw)), self.assertRaises(
                (CaptureSegmentError, ValueError)
            ):
                FinalizedCaptureSegmentStatement.from_json_bytes(raw)
        with self.assertRaises(CaptureSegmentError) as caught:
            CaptureSegmentAttestation.from_json_bytes(
                b"{" + b" " * MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES + b"}"
            )
        self.assertEqual(caught.exception.code, "JSON_SIZE")
        with self.assertRaises(CaptureSegmentError) as caught:
            CaptureSegmentTrustSnapshot.from_json_bytes(
                b"{" + b" " * MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES + b"}"
            )
        self.assertEqual(caught.exception.code, "JSON_SIZE")

    def test_signature_and_current_genesis_substitution_fail_closed(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        snapshot = prepared["trust_snapshot"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        assert type(snapshot) is CaptureSegmentTrustSnapshot

        signature = bytearray(attestation.signature)
        signature[0] ^= 1
        invalid = replace(
            attestation,
            signature_base64=base64.b64encode(signature).decode("ascii"),
        )
        invalid_snapshot = _snapshot(statement, invalid, prepared)
        arguments = _verify_arguments(prepared)
        arguments["expected_trust_snapshot_sha256"] = invalid_snapshot.fingerprint()
        arguments["expected_current_attestation_sha256"] = invalid.fingerprint()
        with self.assertRaises(CaptureSegmentError) as caught:
            verify_capture_segment_attestation(
                statement,
                invalid,
                invalid_snapshot,
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_SEGMENT_SIGNATURE")

        arguments = _verify_arguments(prepared)
        arguments["expected_current_attestation_sha256"] = "f" * 64
        with self.assertRaises(CaptureSegmentError) as caught:
            verify_capture_segment_attestation(
                statement,
                attestation,
                snapshot,
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_SEGMENT_CURRENT_PIN")

    def test_metadata_rights_window_trace_and_policy_substitution_fail(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        snapshot = prepared["trust_snapshot"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        assert type(snapshot) is CaptureSegmentTrustSnapshot

        cases: list[tuple[str, object]] = []
        metadata = prepared["capture_metadata"]
        cases.append(
            (
                "capture_metadata",
                replace(metadata, verified_at_ns=301),  # type: ignore[arg-type]
            )
        )
        grant = prepared["capture_rights_grant"]
        cases.append(
            (
                "capture_rights_grant",
                replace(grant, owner_or_licensor="Other Owner"),  # type: ignore[arg-type]
            )
        )
        request = prepared["window_request"]
        cases.append(
            ("window_request", replace(request, request_id="window-request-2"))  # type: ignore[arg-type]
        )
        trace = prepared["finalized_trace"]
        assert type(trace) is tuple
        cases.append(
            (
                "finalized_trace",
                (
                    *trace[:-1],
                    replace(trace[-1], mapped_evidence_timestamp_ns=1_999_999_999),
                ),
            )
        )
        policy = prepared["capture_policy"]
        cases.append(
            (
                "capture_policy",
                replace(policy, max_clock_absolute_error_ns=999),  # type: ignore[arg-type]
            )
        )
        for field_name, substituted in cases:
            arguments = _verify_arguments(prepared)
            arguments[field_name] = substituted
            with self.subTest(field_name=field_name), self.assertRaises(
                (CaptureSegmentError, ValueError)
            ):
                verify_capture_segment_attestation(
                    statement,
                    attestation,
                    snapshot,
                    **arguments,  # type: ignore[arg-type]
                )


class CaptureSegmentTrustTests(unittest.TestCase):
    def test_key_revocation_policy_pin_and_reserved_key_currentness(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation

        revoked_snapshot = _snapshot(
            statement, attestation, prepared, revoked_at_ns=475
        )
        arguments = _verify_arguments(prepared)
        arguments["expected_trust_snapshot_sha256"] = revoked_snapshot.fingerprint()
        with self.assertRaises(CaptureSegmentError) as caught:
            verify_capture_segment_attestation(
                statement,
                attestation,
                revoked_snapshot,
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_SEGMENT_KEY_REVOKED")

        snapshot = prepared["trust_snapshot"]
        assert type(snapshot) is CaptureSegmentTrustSnapshot
        arguments = _verify_arguments(prepared)
        arguments["expected_capture_policy_sha256"] = "f" * 64
        with self.assertRaises(CaptureSegmentError):
            verify_capture_segment_attestation(
                statement,
                attestation,
                snapshot,
                **arguments,  # type: ignore[arg-type]
            )

        metadata_snapshot = prepared["capture_metadata_trust_snapshot"]
        incomplete_reserved = tuple(
            sorted(
                _public_sha256(item.public_key_base64)
                for item in metadata_snapshot.keys  # type: ignore[union-attr]
            )
        )
        incomplete_snapshot = _snapshot(
            statement,
            attestation,
            prepared,
            reserved=incomplete_reserved,
        )
        arguments = _verify_arguments(prepared)
        arguments["expected_trust_snapshot_sha256"] = incomplete_snapshot.fingerprint()
        with self.assertRaises(CaptureSegmentError) as caught:
            verify_capture_segment_attestation(
                statement,
                attestation,
                incomplete_snapshot,
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_SEGMENT_RESERVED_KEYS")

    def test_cross_role_key_overlap_and_current_revocation_rejected(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        metadata_key_hash = _public_sha256(_public_base64(SOURCE_KEY))
        with self.assertRaises(ValueError):
            _snapshot(
                statement,
                attestation,
                prepared,
                key=SOURCE_KEY,
                reserved=tuple(
                    sorted(
                        {
                            metadata_key_hash,
                            *(
                                _public_sha256(item.public_key_base64)
                                for item in prepared[
                                    "capture_rights_trust_snapshot"
                                ].keys  # type: ignore[union-attr]
                            ),
                        }
                    )
                ),
            )
        with self.assertRaises(ValueError):
            _snapshot(
                statement,
                attestation,
                prepared,
                revoked_statements=(statement.fingerprint(),),
            )

    def test_non_genesis_sequence_and_reconnect_are_hard_cut(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        with self.assertRaises(ValueError):
            replace(statement, segment_sequence=1)
        with self.assertRaises(ValueError):
            replace(statement, reconnect_epoch=1)

    def test_fixed_key_resource_ceiling(self) -> None:
        prepared = _prepared()
        statement = prepared["statement"]
        attestation = prepared["attestation"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        base = _snapshot(statement, attestation, prepared)
        with self.assertRaises(ValueError):
            replace(base, keys=base.keys * 65)


class CaptureSegmentIsolationTests(unittest.TestCase):
    def test_module_has_no_mutating_or_media_io_import_surface(self) -> None:
        import vision_scoring.capture_segment as module

        source_path = Path(inspect.getsourcefile(module) or "")
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(item.name.split(".")[0] for item in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported_roots.add(node.module.split(".")[0])
            if isinstance(node, ast.ImportFrom) and node.module == "capture_assets":
                self.assertTrue(
                    all(not item.name.startswith("_") for item in node.names)
                )
        self.assertTrue(
            imported_roots.isdisjoint(
                {
                    "asyncio",
                    "http",
                    "os",
                    "pathlib",
                    "requests",
                    "shutil",
                    "socket",
                    "sqlite3",
                    "subprocess",
                    "urllib",
                }
            )
        )
        signature = inspect.signature(verify_capture_segment_attestation)
        self.assertTrue(
            set(signature.parameters).isdisjoint(
                {
                    "asset_bytes",
                    "clip_bytes",
                    "database",
                    "destination",
                    "media_path",
                    "private_key",
                    "scorecheck",
                    "storage",
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
