from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_capture_measurement_binding import _digest, _protected_rows
from tests.test_capture_measurement_rows import _recipe
from tests.test_capture_segment import _prepared, _verify_arguments
import vision_scoring.capture_measurement_binding as binding_module
from vision_scoring.capture_measurement import _ProtectedCaptureMeasurementRowsV1
from vision_scoring.capture_measurement_binding import SelectedVideoStreamBindingV1
from vision_scoring.capture_measurement_trust import (
    MAX_CURRENT_DECODED_CAPTURE_MEASUREMENTS,
    MAX_DECODED_CAPTURE_MEASUREMENT_SIGNER_KEYS,
    MAX_RESERVED_NONMEASUREMENT_KEYS,
    MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS,
    AuthenticatedDecodedCaptureMeasurementStatementV1,
    CaptureMeasurementReplayInvocationV1,
    CaptureSegmentVerificationInvocationV1,
    DecodedCaptureMeasurementAttestationV1,
    DecodedCaptureMeasurementKeyRoleV1,
    DecodedCaptureMeasurementPolicyV1,
    DecodedCaptureMeasurementTrustError,
    DecodedCaptureMeasurementTrustSnapshotV1,
    TrustedDecodedCaptureMeasurementSignerKeyV1,
    current_decoded_capture_measurement_v1,
    sign_protected_decoded_capture_measurement_v1,
    verify_authenticated_decoded_capture_measurement_v1,
)
from vision_scoring.capture_segment import (
    CaptureSegmentAttestation,
    CaptureSegmentTrustSnapshot,
    FinalizedCaptureSegmentStatement,
)
from vision_scoring.immutable_store import generation_id_for


MEASUREMENT_KEY = Ed25519PrivateKey.from_private_bytes(b"\x7a" * 32)


def _public_key_base64(key: Ed25519PrivateKey) -> str:
    return base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii")


class AuthenticatedCaptureMeasurementTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prepared = _prepared()
        statement = self.prepared["statement"]
        attestation = self.prepared["attestation"]
        trust_snapshot = self.prepared["trust_snapshot"]
        assert type(statement) is FinalizedCaptureSegmentStatement
        assert type(attestation) is CaptureSegmentAttestation
        assert type(trust_snapshot) is CaptureSegmentTrustSnapshot
        self.capture_statement = statement
        self.rows = _protected_rows(statement)
        metadata = statement.capture_metadata
        self.stream_binding = SelectedVideoStreamBindingV1(
            binding_id="stream-binding-1",
            capture_segment_statement_sha256=statement.fingerprint(),
            capture_metadata_sha256=metadata.fingerprint(),
            source_asset_sha256=metadata.asset_sha256,
            logical_stream_id=metadata.stream_id,
            selected_video_stream_index=2,
        )
        self.sign_capture_invocation = self._capture_invocation(500)
        self.replay_invocation = CaptureMeasurementReplayInvocationV1(
            artifact_store_root=Path("/protected/artifacts"),
            artifact_generation_id=self.rows.replay.receipt.artifact_generation_id,
            artifact_sha256s=(metadata.asset_sha256,),
            selected_video_stream_index=2,
            runtime_store_root=Path("/protected/runtime"),
            runtime_generation_id=self.rows.replay.decoder_runtime_generation_id,
            runtime_manifest_sha256=(self.rows.replay.decoder_runtime_manifest_sha256),
            expected_runtime_manifest_sha256=(
                self.rows.replay.decoder_runtime_manifest_sha256
            ),
            expected_platform="macos",
            expected_architecture="arm64",
            expected_abi="darwin",
            expected_system_runtime_id="system-runtime",
            expected_system_runtime_measurement_sha256=_digest(25),
            recipe=_recipe(),
            expected_measurement_recipe_sha256=_recipe().fingerprint(),
        )
        self.measurement_policy = DecodedCaptureMeasurementPolicyV1(
            policy_id="measurement-policy-1",
            policy_generation=3,
            measurement_verifier_id="measurement-verifier-1",
            capture_segment_statement_sha256=statement.fingerprint(),
            capture_segment_attestation_sha256=attestation.fingerprint(),
            capture_segment_trust_snapshot_sha256=trust_snapshot.fingerprint(),
            capture_segment_trust_snapshot_generation=(
                trust_snapshot.snapshot_generation
            ),
            capture_metadata_sha256=metadata.fingerprint(),
            selected_video_stream_binding_sha256=self.stream_binding.fingerprint(),
            selected_video_stream_index=2,
            source_asset_sha256=metadata.asset_sha256,
            source_asset_byte_length=metadata.asset_byte_length,
            artifact_generation_id=self.replay_invocation.artifact_generation_id,
            artifact_sha256s=self.replay_invocation.artifact_sha256s,
            runtime_generation_id=self.replay_invocation.runtime_generation_id,
            runtime_manifest_sha256=self.replay_invocation.runtime_manifest_sha256,
            expected_platform=self.replay_invocation.expected_platform,
            expected_architecture=self.replay_invocation.expected_architecture,
            expected_abi=self.replay_invocation.expected_abi,
            expected_system_runtime_id=(
                self.replay_invocation.expected_system_runtime_id
            ),
            expected_system_runtime_measurement_sha256=(
                self.replay_invocation.expected_system_runtime_measurement_sha256
            ),
            measurement_recipe_sha256=(
                self.replay_invocation.expected_measurement_recipe_sha256
            ),
            capture_measurement_command_recipe_sha256=(
                _recipe().capture_measurement_command_recipe_sha256
            ),
            valid_from_ns=1,
            valid_until_ns=1_000,
        )
        with patch.object(
            binding_module,
            "_replay_protected_capture_measurement_rows_v1",
            return_value=self.rows,
        ):
            self.measurement_statement, self.measurement_attestation = (
                sign_protected_decoded_capture_measurement_v1(
                    capture_invocation=self.sign_capture_invocation,
                    replay_invocation=self.replay_invocation,
                    selected_video_stream_binding=self.stream_binding,
                    measurement_policy=self.measurement_policy,
                    expected_measurement_policy_sha256=(
                        self.measurement_policy.fingerprint()
                    ),
                    expected_measurement_policy_generation=3,
                    measurement_id="measurement-1",
                    measurement_verifier_id="measurement-verifier-1",
                    statement_created_at_ns=510,
                    key_id="measurement-key-1",
                    trust_domain_id="measurement-domain-1",
                    signed_at_ns=520,
                    measurement_private_key=MEASUREMENT_KEY,
                )
            )
        self.current = current_decoded_capture_measurement_v1(
            self.measurement_statement,
            self.measurement_attestation,
        )
        upstream_reserved = tuple(
            sorted(
                {
                    *(item.public_key_sha256 for item in trust_snapshot.keys),
                    *trust_snapshot.reserved_nonsegment_public_key_sha256s,
                }
            )
        )
        self.snapshot = DecodedCaptureMeasurementTrustSnapshotV1(
            snapshot_generation=4,
            trust_domain_id="measurement-domain-1",
            measurement_verifier_id="measurement-verifier-1",
            capture_service_id=statement.capture_service_id,
            lineage_id=statement.lineage_id,
            capture_session_id=metadata.capture_session_id,
            session_fingerprint=metadata.session_fingerprint,
            reconnect_epoch=metadata.reconnect_epoch,
            measurement_policy_sha256=self.measurement_policy.fingerprint(),
            measurement_policy_generation=3,
            keys=(
                TrustedDecodedCaptureMeasurementSignerKeyV1(
                    key_id="measurement-key-1",
                    key_role=(
                        DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
                    ),
                    measurement_verifier_id="measurement-verifier-1",
                    public_key_base64=_public_key_base64(MEASUREMENT_KEY),
                    valid_from_ns=1,
                    valid_until_ns=1_000,
                    revoked_at_ns=None,
                ),
            ),
            current_measurements=(self.current,),
            revoked_statement_sha256s=(),
            revoked_measurement_receipt_sha256s=(),
            reserved_nonmeasurement_public_key_sha256s=upstream_reserved,
        )

    def _capture_invocation(
        self,
        verified_at_ns: int,
    ) -> CaptureSegmentVerificationInvocationV1:
        arguments = _verify_arguments(self.prepared)
        arguments["verified_at_ns"] = verified_at_ns
        return CaptureSegmentVerificationInvocationV1(
            statement=self.prepared["statement"],  # type: ignore[arg-type]
            attestation=self.prepared["attestation"],  # type: ignore[arg-type]
            trust_snapshot=self.prepared["trust_snapshot"],  # type: ignore[arg-type]
            verification_arguments=tuple(sorted(arguments.items())),
        )

    def _verify(self, **changes: object):
        snapshot = changes.pop("trust_snapshot", self.snapshot)
        assert type(snapshot) is DecodedCaptureMeasurementTrustSnapshotV1
        arguments: dict[str, object] = {
            "capture_invocation": self._capture_invocation(600),
            "replay_invocation": self.replay_invocation,
            "selected_video_stream_binding": self.stream_binding,
            "measurement_policy": self.measurement_policy,
            "expected_trust_snapshot_sha256": snapshot.fingerprint(),
            "expected_trust_snapshot_generation": snapshot.snapshot_generation,
            "expected_current_attestation_sha256": (
                self.measurement_attestation.fingerprint()
            ),
            "expected_measurement_verifier_id": "measurement-verifier-1",
            "expected_trust_domain_id": "measurement-domain-1",
            "expected_measurement_policy_sha256": (
                self.measurement_policy.fingerprint()
            ),
            "expected_measurement_policy_generation": 3,
            "verified_at_ns": 600,
            **changes,
        }
        with patch.object(
            binding_module,
            "_replay_protected_capture_measurement_rows_v1",
            return_value=self.rows,
        ):
            return verify_authenticated_decoded_capture_measurement_v1(
                self.measurement_statement,
                self.measurement_attestation,
                snapshot,
                **arguments,  # type: ignore[arg-type]
            )

    def assert_trust_error(
        self,
        expected_code: str,
        operation: object,
    ) -> DecodedCaptureMeasurementTrustError:
        self.assertTrue(callable(operation))
        with self.assertRaises(DecodedCaptureMeasurementTrustError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        return caught.exception

    def test_signer_owns_fresh_capture_verification_and_replay_then_verify_repeats(
        self,
    ) -> None:
        statement = self.measurement_statement
        attestation = self.measurement_attestation
        self.assertEqual(
            AuthenticatedDecodedCaptureMeasurementStatementV1.from_json_bytes(
                statement.to_json_bytes()
            ),
            statement,
        )
        self.assertEqual(
            DecodedCaptureMeasurementAttestationV1.from_json_bytes(
                attestation.to_json_bytes()
            ),
            attestation,
        )
        self.assertEqual(
            DecodedCaptureMeasurementTrustSnapshotV1.from_json_bytes(
                self.snapshot.to_json_bytes()
            ),
            self.snapshot,
        )
        self.assertEqual(
            DecodedCaptureMeasurementPolicyV1.from_json_bytes(
                self.measurement_policy.to_json_bytes()
            ),
            self.measurement_policy,
        )
        self.assertIsNone(self._verify())
        self.assertFalse(statement.admissible_for_training)
        self.assertFalse(
            statement.selected_video_stream_binding.admissible_for_training
        )

    def test_signer_snapshots_capture_verification_time_before_replay(self) -> None:
        invocation = self._capture_invocation(500)

        def mutate_original_invocation(*args: object, **kwargs: object):
            del args, kwargs
            changed = dict(invocation._arguments)  # type: ignore[attr-defined]
            changed["verified_at_ns"] = 1
            object.__setattr__(invocation, "_arguments", tuple(sorted(changed.items())))
            return self.rows

        with patch.object(
            binding_module,
            "_replay_protected_capture_measurement_rows_v1",
            side_effect=mutate_original_invocation,
        ):
            statement, _ = sign_protected_decoded_capture_measurement_v1(
                capture_invocation=invocation,
                replay_invocation=self.replay_invocation,
                selected_video_stream_binding=self.stream_binding,
                measurement_policy=self.measurement_policy,
                expected_measurement_policy_sha256=(
                    self.measurement_policy.fingerprint()
                ),
                expected_measurement_policy_generation=3,
                measurement_id="measurement-toctou",
                measurement_verifier_id="measurement-verifier-1",
                statement_created_at_ns=510,
                key_id="measurement-key-1",
                trust_domain_id="measurement-domain-1",
                signed_at_ns=520,
                measurement_private_key=MEASUREMENT_KEY,
            )
        self.assertEqual(statement.capture_segment_verified_at_ns, 500)

    def test_revocation_precedes_currentness_and_empty_current_is_representable(
        self,
    ) -> None:
        revoked_statement = replace(
            self.snapshot,
            current_measurements=(),
            revoked_statement_sha256s=(self.measurement_statement.fingerprint(),),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_REVOKED",
            lambda: self._verify(trust_snapshot=revoked_statement),
        )
        expired_policy = replace(self.measurement_policy, valid_until_ns=550)
        revoked_with_expired_policy = replace(
            revoked_statement,
            measurement_policy_sha256=expired_policy.fingerprint(),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_REVOKED",
            lambda: self._verify(
                trust_snapshot=revoked_with_expired_policy,
                measurement_policy=expired_policy,
                expected_measurement_policy_sha256=expired_policy.fingerprint(),
            ),
        )
        replacement_policy = replace(
            self.measurement_policy,
            policy_id="measurement-policy-2",
            policy_generation=4,
        )
        revoked_under_replacement_policy = replace(
            revoked_statement,
            measurement_policy_sha256=replacement_policy.fingerprint(),
            measurement_policy_generation=4,
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_REVOKED",
            lambda: self._verify(
                trust_snapshot=revoked_under_replacement_policy,
                measurement_policy=replacement_policy,
                expected_measurement_policy_sha256=(replacement_policy.fingerprint()),
                expected_measurement_policy_generation=4,
            ),
        )
        revoked_receipt = replace(
            self.snapshot,
            current_measurements=(),
            revoked_measurement_receipt_sha256s=(
                self.measurement_statement.measurement_receipt_sha256,
            ),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_REVOKED",
            lambda: self._verify(trust_snapshot=revoked_receipt),
        )
        empty = replace(self.snapshot, current_measurements=())
        self.assert_trust_error(
            "MEASUREMENT_TRUST_NOT_CURRENT",
            lambda: self._verify(trust_snapshot=empty),
        )

    def test_verifier_malformed_top_level_inputs_use_finite_error_code(self) -> None:
        for changes in (
            {"verified_at_ns": True},
            {"capture_invocation": object()},
            {"selected_video_stream_binding": object()},
        ):
            with self.subTest(changes=tuple(changes)):
                self.assert_trust_error(
                    "MEASUREMENT_TRUST_INPUT",
                    lambda changes=changes: self._verify(**changes),
                )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_INPUT",
            lambda: sign_protected_decoded_capture_measurement_v1(
                capture_invocation=self._capture_invocation(500),
                replay_invocation=self.replay_invocation,
                selected_video_stream_binding=self.stream_binding,
                measurement_policy=self.measurement_policy,
                expected_measurement_policy_sha256=(
                    self.measurement_policy.fingerprint()
                ),
                expected_measurement_policy_generation=3,
                measurement_id=True,  # type: ignore[arg-type]
                measurement_verifier_id="measurement-verifier-1",
                statement_created_at_ns=510,
                key_id="measurement-key-1",
                trust_domain_id="measurement-domain-1",
                signed_at_ns=520,
                measurement_private_key=MEASUREMENT_KEY,
            ),
        )

    def test_replay_and_policy_require_one_exact_source_artifact(self) -> None:
        artifacts = tuple(
            sorted((self.capture_statement.capture_metadata.asset_sha256, _digest(99)))
        )
        generation = generation_id_for(artifacts)
        with self.assertRaises(ValueError):
            replace(
                self.replay_invocation,
                artifact_generation_id=generation,
                artifact_sha256s=artifacts,
            )
        with self.assertRaises(ValueError):
            replace(
                self.measurement_policy,
                artifact_generation_id=generation,
                artifact_sha256s=artifacts,
            )

    def test_public_replay_or_statement_cannot_be_promoted_without_signer_and_rerun(
        self,
    ) -> None:
        self.assertNotIn(
            "replay",
            sign_protected_decoded_capture_measurement_v1.__annotations__,
        )
        self.assertNotIn(
            "statement",
            sign_protected_decoded_capture_measurement_v1.__annotations__,
        )
        forged = replace(
            self.measurement_statement,
            measurement_id="forged-measurement",
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_ATTESTATION",
            lambda: verify_authenticated_decoded_capture_measurement_v1(
                forged,
                self.measurement_attestation,
                self.snapshot,
                capture_invocation=self._capture_invocation(600),
                replay_invocation=self.replay_invocation,
                selected_video_stream_binding=self.stream_binding,
                measurement_policy=self.measurement_policy,
                expected_trust_snapshot_sha256=self.snapshot.fingerprint(),
                expected_trust_snapshot_generation=4,
                expected_current_attestation_sha256=(
                    self.measurement_attestation.fingerprint()
                ),
                expected_measurement_verifier_id="measurement-verifier-1",
                expected_trust_domain_id="measurement-domain-1",
                expected_measurement_policy_sha256=(
                    self.measurement_policy.fingerprint()
                ),
                expected_measurement_policy_generation=3,
                verified_at_ns=600,
            ),
        )

    def test_snapshot_current_attestation_policy_and_recipe_are_independent_pins(
        self,
    ) -> None:
        self.assert_trust_error(
            "MEASUREMENT_TRUST_PIN",
            lambda: self._verify(expected_trust_snapshot_sha256=_digest(70)),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_PIN",
            lambda: self._verify(expected_current_attestation_sha256=_digest(71)),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_PIN",
            lambda: self._verify(expected_measurement_policy_sha256=_digest(72)),
        )
        with self.assertRaises(ValueError):
            replace(
                self.replay_invocation,
                expected_measurement_recipe_sha256=_digest(73),
            )
        alternate_recipe = _recipe(freeze_minimum=5)
        alternate_invocation = replace(
            self.replay_invocation,
            recipe=alternate_recipe,
            expected_measurement_recipe_sha256=alternate_recipe.fingerprint(),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_PIN",
            lambda: self._verify(replay_invocation=alternate_invocation),
        )

    def test_stale_capture_verification_time_is_not_accepted_as_current(self) -> None:
        self.assert_trust_error(
            "MEASUREMENT_TRUST_TIME",
            lambda: self._verify(capture_invocation=self._capture_invocation(500)),
        )

    def test_signature_key_and_fresh_replay_nondeterminism_fail_closed(self) -> None:
        bad_signature = replace(
            self.measurement_attestation,
            signature_base64=base64.b64encode(b"\x00" * 64).decode("ascii"),
        )
        bad_current = replace(
            self.current,
            attestation_sha256=bad_signature.fingerprint(),
        )
        bad_snapshot = replace(
            self.snapshot,
            current_measurements=(bad_current,),
        )
        self.assert_trust_error(
            "MEASUREMENT_TRUST_SIGNATURE",
            lambda: verify_authenticated_decoded_capture_measurement_v1(
                self.measurement_statement,
                bad_signature,
                bad_snapshot,
                capture_invocation=self._capture_invocation(600),
                replay_invocation=self.replay_invocation,
                selected_video_stream_binding=self.stream_binding,
                measurement_policy=self.measurement_policy,
                expected_trust_snapshot_sha256=bad_snapshot.fingerprint(),
                expected_trust_snapshot_generation=4,
                expected_current_attestation_sha256=bad_signature.fingerprint(),
                expected_measurement_verifier_id="measurement-verifier-1",
                expected_trust_domain_id="measurement-domain-1",
                expected_measurement_policy_sha256=(
                    self.measurement_policy.fingerprint()
                ),
                expected_measurement_policy_generation=3,
                verified_at_ns=600,
            ),
        )

        changed_replay = replace(
            self.rows.replay,
            metadata_output_sha256=_digest(74),
        )
        changed_rows = _ProtectedCaptureMeasurementRowsV1(
            replay=changed_replay,
            measurement_recipe=self.rows.measurement_recipe,
            observed_codec=self.rows.observed_codec,
            presentation_timing_rows=self.rows.presentation_timing_rows,
            selected_video_packet_rows=self.rows.selected_video_packet_rows,
            decoded_frame_rows=self.rows.decoded_frame_rows,
        )
        with patch.object(
            binding_module,
            "_replay_protected_capture_measurement_rows_v1",
            return_value=changed_rows,
        ):
            self.assert_trust_error(
                "MEASUREMENT_TRUST_NONDETERMINISM",
                lambda: verify_authenticated_decoded_capture_measurement_v1(
                    self.measurement_statement,
                    self.measurement_attestation,
                    self.snapshot,
                    capture_invocation=self._capture_invocation(600),
                    replay_invocation=self.replay_invocation,
                    selected_video_stream_binding=self.stream_binding,
                    measurement_policy=self.measurement_policy,
                    expected_trust_snapshot_sha256=self.snapshot.fingerprint(),
                    expected_trust_snapshot_generation=4,
                    expected_current_attestation_sha256=(
                        self.measurement_attestation.fingerprint()
                    ),
                    expected_measurement_verifier_id="measurement-verifier-1",
                    expected_trust_domain_id="measurement-domain-1",
                    expected_measurement_policy_sha256=(
                        self.measurement_policy.fingerprint()
                    ),
                    expected_measurement_policy_generation=3,
                    verified_at_ns=600,
                ),
            )

    def test_trust_snapshot_rejects_key_domain_and_current_equivocation(self) -> None:
        key_digest = hashlib.sha256(
            base64.b64decode(_public_key_base64(MEASUREMENT_KEY))
        ).hexdigest()
        with self.assertRaises(ValueError):
            replace(
                self.snapshot,
                reserved_nonmeasurement_public_key_sha256s=(key_digest,),
            )
        duplicate = replace(self.current, measurement_id="measurement-2")
        with self.assertRaises(ValueError):
            replace(
                self.snapshot,
                current_measurements=(self.current, duplicate),
            )

    def test_maximum_cardinality_trust_snapshot_round_trips(self) -> None:
        keys = tuple(
            TrustedDecodedCaptureMeasurementSignerKeyV1(
                key_id=f"measurement-key-{index:03d}",
                key_role=(
                    DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
                ),
                measurement_verifier_id="measurement-verifier-1",
                public_key_base64=_public_key_base64(
                    Ed25519PrivateKey.from_private_bytes(bytes([index + 1]) * 32)
                ),
                valid_from_ns=1,
                valid_until_ns=1_000,
                revoked_at_ns=None,
            )
            for index in range(MAX_DECODED_CAPTURE_MEASUREMENT_SIGNER_KEYS)
        )
        current = tuple(
            replace(
                self.current,
                measurement_id=f"measurement-{index:03d}",
                capture_segment_statement_sha256=_digest(10_000 + index * 16),
                capture_metadata_sha256=_digest(10_001 + index * 16),
                source_asset_sha256=_digest(10_002 + index * 16),
                selected_video_stream_index=index,
                selected_video_stream_binding_sha256=_digest(10_003 + index * 16),
                decoder_runtime_manifest_sha256=_digest(10_004 + index * 16),
                measurement_recipe_sha256=_digest(10_005 + index * 16),
                measurement_receipt_sha256=_digest(10_006 + index * 16),
                statement_sha256=_digest(10_007 + index * 16),
                attestation_sha256=_digest(10_008 + index * 16),
            )
            for index in range(MAX_CURRENT_DECODED_CAPTURE_MEASUREMENTS)
        )
        maximal = replace(
            self.snapshot,
            keys=keys,
            current_measurements=current,
            revoked_statement_sha256s=tuple(
                _digest(20_000 + index)
                for index in range(MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS)
            ),
            revoked_measurement_receipt_sha256s=tuple(
                _digest(30_000 + index)
                for index in range(MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS)
            ),
            reserved_nonmeasurement_public_key_sha256s=tuple(
                _digest(40_000 + index)
                for index in range(MAX_RESERVED_NONMEASUREMENT_KEYS)
            ),
        )
        self.assertEqual(
            DecodedCaptureMeasurementTrustSnapshotV1.from_json_bytes(
                maximal.to_json_bytes()
            ),
            maximal,
        )


if __name__ == "__main__":
    unittest.main()
