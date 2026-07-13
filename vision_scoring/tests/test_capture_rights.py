from __future__ import annotations

import base64
from dataclasses import FrozenInstanceError, replace
import json
from pathlib import Path
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.capture_rights import (
    CAPTURE_OPERATION_REQUIRED_USES,
    CAPTURE_RIGHTS_SIGNING_DOMAIN,
    MAX_CAMERA_IDS,
    MAX_CAPTURE_RIGHTS_JSON_BYTES,
    MAX_CURRENT_GRANTS,
    MAX_EVIDENCE_SHA256S,
    MAX_PARTICIPANT_IDS,
    CaptureRightsError,
    CaptureRightsKeyRole,
    CaptureRightsTrustSnapshot,
    CaptureSessionRightsGrant,
    CaptureSessionRightsGrantAttestation,
    CurrentCaptureSessionRightsGrant,
    TrustedCaptureRightsReviewerKey,
    capture_rights_trust_snapshot_from_dict,
    capture_rights_trust_snapshot_from_json_bytes,
    capture_session_rights_grant_attestation_from_dict,
    capture_session_rights_grant_attestation_from_json_bytes,
    capture_session_rights_grant_from_dict,
    capture_session_rights_grant_from_json_bytes,
    capture_session_rights_grant_signing_message,
    verify_capture_session_rights,
)
from vision_scoring.rights import ParticipantAgeStatus, PermittedUse, RightsBasis


PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x51" * 32)
OTHER_KEY = Ed25519PrivateKey.from_private_bytes(b"\x52" * 32)
POLICY = "a" * 64
ROSTER = "b" * 64
EVIDENCE = "c" * 64
RELEASE = "d" * 64
ROLE = CaptureRightsKeyRole.CAPTURE_SESSION_RIGHTS_GRANT_SIGNER
DOMAIN = "capture-rights-production"


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    return base64.b64encode(private_key.public_key().public_bytes_raw()).decode(
        "ascii"
    )


def _grant(**overrides: object) -> CaptureSessionRightsGrant:
    values: dict[str, object] = {
        "grant_id": "grant-match-1",
        "match_id": "match-1",
        "capture_session_id": "capture-session-1",
        "venue_id": "venue-1",
        "camera_ids": ("camera-a", "camera-b"),
        "roster_scope_sha256": ROSTER,
        "participant_ids": (
            "participant-1",
            "participant-2",
            "participant-3",
            "participant-4",
        ),
        "valid_from_ns": 200,
        "valid_until_ns": 1_000,
        "geography_scope": ("US",),
        "permitted_uses": CAPTURE_OPERATION_REQUIRED_USES,
        "basis": RightsBasis.OWNED,
        "owner_or_licensor": "Fixture Capture Media LLC",
        "license_id": None,
        "participant_age_status": ParticipantAgeStatus.NO_MINORS,
        "participant_release_sha256s": (),
        "evidence_sha256s": (EVIDENCE,),
        "reviewer_id": "capture-rights-reviewer-1",
        "reviewed_at_ns": 100,
        "protected_policy_fingerprint": POLICY,
        "protected_policy_generation": 7,
    }
    values.update(overrides)
    return CaptureSessionRightsGrant(**values)  # type: ignore[arg-type]


def _key(
    *,
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    key_id: str = "capture-rights-key-1",
    reviewer_id: str = "capture-rights-reviewer-1",
    revoked_at_ns: int | None = None,
) -> TrustedCaptureRightsReviewerKey:
    return TrustedCaptureRightsReviewerKey(
        key_id=key_id,
        reviewer_id=reviewer_id,
        key_role=ROLE,
        public_key_base64=_public_key_base64(private_key),
        valid_from_ns=1,
        valid_until_ns=2_000,
        revoked_at_ns=revoked_at_ns,
    )


def _attestation(
    grant: CaptureSessionRightsGrant,
    *,
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    key_id: str = "capture-rights-key-1",
    trust_domain_id: str = DOMAIN,
    signed_at_ns: int = 150,
) -> CaptureSessionRightsGrantAttestation:
    signature = private_key.sign(
        capture_session_rights_grant_signing_message(
            grant,
            key_id=key_id,
            key_role=ROLE,
            trust_domain_id=trust_domain_id,
            signed_at_ns=signed_at_ns,
        )
    )
    return CaptureSessionRightsGrantAttestation(
        grant_sha256=grant.fingerprint(),
        key_id=key_id,
        key_role=ROLE,
        trust_domain_id=trust_domain_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _snapshot(
    grant: CaptureSessionRightsGrant,
    **overrides: object,
) -> CaptureRightsTrustSnapshot:
    values: dict[str, object] = {
        "trust_domain_id": DOMAIN,
        "protected_policy_fingerprint": POLICY,
        "protected_policy_generation": 7,
        "keys": (_key(),),
        "current_grants": (
            CurrentCaptureSessionRightsGrant(
                grant_id=grant.grant_id,
                match_id=grant.match_id,
                capture_session_id=grant.capture_session_id,
                grant_sha256=grant.fingerprint(),
            ),
        ),
        "revoked_grant_sha256s": (),
    }
    values.update(overrides)
    return CaptureRightsTrustSnapshot(**values)  # type: ignore[arg-type]


def _verification_arguments(
    grant: CaptureSessionRightsGrant,
    snapshot: CaptureRightsTrustSnapshot | None = None,
) -> dict[str, object]:
    selected_snapshot = snapshot if snapshot is not None else _snapshot(grant)
    return {
        "verified_at_ns": 300,
        "geography": "US",
        "match_id": grant.match_id,
        "capture_session_id": grant.capture_session_id,
        "venue_id": grant.venue_id,
        "camera_ids": grant.camera_ids,
        "roster_scope_sha256": grant.roster_scope_sha256,
        "participant_ids": grant.participant_ids,
        "required_uses": CAPTURE_OPERATION_REQUIRED_USES,
        "expected_trust_snapshot_sha256": selected_snapshot.fingerprint(),
        "expected_protected_policy_fingerprint": POLICY,
        "expected_protected_policy_generation": 7,
    }


class CaptureSessionRightsGrantTests(unittest.TestCase):
    def test_valid_current_grant_verifies_exact_operation(self) -> None:
        grant = _grant()
        attestation = _attestation(grant)
        snapshot = _snapshot(grant)
        proof = verify_capture_session_rights(
            grant,
            attestation,
            snapshot,
            **_verification_arguments(grant),  # type: ignore[arg-type]
        )
        self.assertEqual(proof.grant_sha256, grant.fingerprint())
        self.assertEqual(proof.attestation_sha256, attestation.fingerprint())
        self.assertEqual(proof.trust_snapshot_sha256, snapshot.fingerprint())
        self.assertEqual(proof.evidence_sha256s, (EVIDENCE,))
        self.assertEqual(proof.required_uses, CAPTURE_OPERATION_REQUIRED_USES)
        self.assertNotIn(b"segment_sha256", grant.canonical_json_bytes())
        self.assertNotIn(b"asset_sha256", grant.canonical_json_bytes())
        self.assertIn(CAPTURE_RIGHTS_SIGNING_DOMAIN.encode("ascii"), capture_session_rights_grant_signing_message(
            grant,
            key_id="capture-rights-key-1",
            key_role=ROLE,
            trust_domain_id=DOMAIN,
            signed_at_ns=150,
        ))

    def test_exact_context_substitution_fails_closed(self) -> None:
        grant = _grant()
        attestation = _attestation(grant)
        snapshot = _snapshot(grant)
        cases = (
            ("match_id", "match-other", "CAPTURE_RIGHTS_MATCH"),
            ("capture_session_id", "session-other", "CAPTURE_RIGHTS_SESSION"),
            ("venue_id", "venue-other", "CAPTURE_RIGHTS_VENUE"),
            ("camera_ids", ("camera-a",), "CAPTURE_RIGHTS_CAMERAS"),
            ("roster_scope_sha256", "e" * 64, "CAPTURE_RIGHTS_ROSTER"),
            (
                "participant_ids",
                ("participant-1", "participant-2"),
                "CAPTURE_RIGHTS_PARTICIPANTS",
            ),
            ("geography", "CA", "CAPTURE_RIGHTS_GEOGRAPHY"),
        )
        for field_name, replacement, expected_code in cases:
            with self.subTest(field_name=field_name):
                arguments = _verification_arguments(grant)
                arguments[field_name] = replacement
                with self.assertRaises(CaptureRightsError) as caught:
                    verify_capture_session_rights(
                        grant,
                        attestation,
                        snapshot,
                        **arguments,  # type: ignore[arg-type]
                    )
                self.assertEqual(caught.exception.code, expected_code)

    def test_training_or_evaluation_never_implies_operational_rights(self) -> None:
        with self.assertRaisesRegex(ValueError, "future-byte-free"):
            _grant(
                permitted_uses=(
                    PermittedUse.COMMERCIAL_MODEL_EVALUATION,
                    PermittedUse.COMMERCIAL_MODEL_TRAINING,
                )
            )

        valid = _grant()
        arguments = _verification_arguments(valid)
        arguments["required_uses"] = (
            PermittedUse.ASSISTIVE_SCORING_PROCESSING,
            PermittedUse.COMMERCIAL_MODEL_TRAINING,
        )
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                valid,
                _attestation(valid),
                _snapshot(valid),
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_PURPOSE")

    def test_future_byte_uses_require_later_exact_asset_rights(self) -> None:
        grant = _grant()
        arguments = _verification_arguments(grant)
        arguments["required_uses"] = (
            PermittedUse.ASSISTIVE_SCORING_PROCESSING,
            PermittedUse.BIOMETRIC_POSE_ANALYSIS,
            PermittedUse.SCORER_COPILOT_REVIEW,
        )
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                _snapshot(grant),
                **arguments,  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_PURPOSE")

        with self.assertRaisesRegex(ValueError, "future-byte-free"):
            replace(
                grant,
                permitted_uses=arguments["required_uses"],  # type: ignore[arg-type]
            )

    def test_minor_clearance_is_content_addressed_and_required(self) -> None:
        with self.assertRaisesRegex(ValueError, "release evidence"):
            _grant(participant_age_status=ParticipantAgeStatus.MINORS_CLEARED)
        for status in (
            ParticipantAgeStatus.UNKNOWN,
            ParticipantAgeStatus.MINORS_NOT_CLEARED,
        ):
            with self.subTest(status=status), self.assertRaisesRegex(
                ValueError,
                "minor clearance",
            ):
                _grant(participant_age_status=status)

        grant = _grant(
            participant_age_status=ParticipantAgeStatus.MINORS_CLEARED,
            participant_release_sha256s=(RELEASE,),
        )
        proof = verify_capture_session_rights(
            grant,
            _attestation(grant),
            _snapshot(grant),
            **_verification_arguments(grant),  # type: ignore[arg-type]
        )
        self.assertEqual(proof.evidence_sha256s, (EVIDENCE, RELEASE))

    def test_validity_geography_and_protected_policy_are_current(self) -> None:
        grant = _grant()
        for field_name, value, expected_code in (
            ("verified_at_ns", 199, "CAPTURE_RIGHTS_VALIDITY"),
            ("verified_at_ns", 1_001, "CAPTURE_RIGHTS_VALIDITY"),
            (
                "expected_protected_policy_fingerprint",
                "f" * 64,
                "CAPTURE_RIGHTS_POLICY",
            ),
            (
                "expected_protected_policy_generation",
                8,
                "CAPTURE_RIGHTS_POLICY",
            ),
        ):
            with self.subTest(field_name=field_name, value=value):
                arguments = _verification_arguments(grant)
                arguments[field_name] = value
                with self.assertRaises(CaptureRightsError) as caught:
                    verify_capture_session_rights(
                        grant,
                        _attestation(grant),
                        _snapshot(grant),
                        **arguments,  # type: ignore[arg-type]
                    )
                self.assertEqual(caught.exception.code, expected_code)

        global_grant = _grant(geography_scope=("GLOBAL",))
        arguments = _verification_arguments(global_grant)
        arguments["geography"] = "CA"
        verify_capture_session_rights(
            global_grant,
            _attestation(global_grant),
            _snapshot(global_grant),
            **arguments,  # type: ignore[arg-type]
        )

    def test_cross_key_domain_and_direct_payload_signatures_fail(self) -> None:
        grant = _grant()
        other_key = _key(
            private_key=OTHER_KEY,
            key_id="capture-rights-key-2",
            reviewer_id="different-reviewer",
        )
        snapshot = _snapshot(grant, keys=(_key(), other_key))
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                snapshot,
                **_verification_arguments(grant),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_TRUST_PIN")

        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(
                    grant,
                    private_key=OTHER_KEY,
                    key_id="capture-rights-key-2",
                ),
                snapshot,
                **_verification_arguments(grant, snapshot),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_REVIEWER")

        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant, trust_domain_id="other-domain"),
                _snapshot(grant),
                **_verification_arguments(grant),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_TRUST_DOMAIN")

        wrong_signature = PRIVATE_KEY.sign(grant.canonical_json_bytes())
        forged = replace(
            _attestation(grant),
            signature_base64=base64.b64encode(wrong_signature).decode("ascii"),
        )
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                forged,
                _snapshot(grant),
                **_verification_arguments(grant),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_SIGNATURE")

    def test_grant_and_key_revocation_and_staleness_fail_closed(self) -> None:
        grant = _grant()
        stale_current = CurrentCaptureSessionRightsGrant(
            grant_id="replacement-grant",
            match_id=grant.match_id,
            capture_session_id=grant.capture_session_id,
            grant_sha256="e" * 64,
        )
        revoked_snapshot = _snapshot(
            grant,
            current_grants=(stale_current,),
            revoked_grant_sha256s=(grant.fingerprint(),),
        )
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                revoked_snapshot,
                **_verification_arguments(grant, revoked_snapshot),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_GRANT_REVOKED")

        stale_snapshot = _snapshot(grant, current_grants=(stale_current,))
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                stale_snapshot,
                **_verification_arguments(grant, stale_snapshot),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_GRANT_STALE")

        key_revoked = _snapshot(grant, keys=(_key(revoked_at_ns=250),))
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                key_revoked,
                **_verification_arguments(grant, key_revoked),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_KEY_REVOKED")

    def test_signature_dates_and_key_window_are_enforced(self) -> None:
        grant = _grant()
        for signed_at_ns, expected_code in (
            (99, "CAPTURE_RIGHTS_ATTESTATION_DATE"),
            (301, "CAPTURE_RIGHTS_ATTESTATION_DATE"),
        ):
            with self.subTest(signed_at_ns=signed_at_ns):
                with self.assertRaises(CaptureRightsError) as caught:
                    verify_capture_session_rights(
                        grant,
                        _attestation(grant, signed_at_ns=signed_at_ns),
                        _snapshot(grant),
                        **_verification_arguments(grant),  # type: ignore[arg-type]
                    )
                self.assertEqual(caught.exception.code, expected_code)

        narrow_key = replace(_key(), valid_from_ns=160)
        narrow_snapshot = _snapshot(grant, keys=(narrow_key,))
        with self.assertRaises(CaptureRightsError) as caught:
            verify_capture_session_rights(
                grant,
                _attestation(grant),
                narrow_snapshot,
                **_verification_arguments(grant, narrow_snapshot),  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_RIGHTS_KEY_DATE")

    def test_grant_contract_rejects_noncanonical_and_unbounded_values(self) -> None:
        invalid = (
            {"grant_id": " spaced"},
            {"camera_ids": ("camera-b", "camera-a")},
            {"camera_ids": ("camera-a", "camera-a")},
            {"participant_ids": ("participant-2", "participant-1")},
            {"geography_scope": ("CA", "GLOBAL")},
            {
                "permitted_uses": (
                    PermittedUse.SCORER_COPILOT_REVIEW,
                    PermittedUse.ASSISTIVE_SCORING_PROCESSING,
                )
            },
            {"valid_from_ns": True},
            {"reviewed_at_ns": 1_001},
            {"owner_or_licensor": " padded "},
            {"owner_or_licensor": "Cafe\u0301 Media"},
            {"basis": "OWNED"},
            {"participant_age_status": "NO_MINORS"},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                _grant(**overrides)

        with self.assertRaises(ValueError):
            _grant(camera_ids=tuple(f"camera-{index:02d}" for index in range(MAX_CAMERA_IDS + 1)))
        with self.assertRaises(ValueError):
            _grant(
                participant_ids=tuple(
                    f"participant-{index:02d}"
                    for index in range(MAX_PARTICIPANT_IDS + 1)
                )
            )
        with self.assertRaises(ValueError):
            _grant(
                evidence_sha256s=tuple(
                    f"{index:064x}"
                    for index in range(MAX_EVIDENCE_SHA256S + 1)
                )
            )
        with self.assertRaises(FrozenInstanceError):
            _grant().match_id = "other"  # type: ignore[misc]

    def test_license_and_trust_snapshot_invariants_are_strict(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires license_id"):
            _grant(basis=RightsBasis.LICENSED)
        with self.assertRaisesRegex(ValueError, "only for LICENSED"):
            _grant(license_id="license-1")
        licensed = _grant(basis=RightsBasis.LICENSED, license_id="license-1")
        self.assertEqual(licensed.license_id, "license-1")

        grant = _grant()
        with self.assertRaisesRegex(ValueError, "sorted by key_id"):
            _snapshot(
                grant,
                keys=(
                    _key(
                        private_key=OTHER_KEY,
                        key_id="capture-rights-key-2",
                        reviewer_id="reviewer-2",
                    ),
                    _key(),
                ),
            )
        with self.assertRaisesRegex(ValueError, "one current grant"):
            _snapshot(
                grant,
                current_grants=(
                    CurrentCaptureSessionRightsGrant(
                        grant.grant_id,
                        grant.match_id,
                        grant.capture_session_id,
                        grant.fingerprint(),
                    ),
                    CurrentCaptureSessionRightsGrant(
                        "grant-other",
                        grant.match_id,
                        grant.capture_session_id,
                        "e" * 64,
                    ),
                ),
            )
        with self.assertRaisesRegex(ValueError, "revoked grant cannot also be current"):
            _snapshot(grant, revoked_grant_sha256s=(grant.fingerprint(),))


class CaptureRightsCodecTests(unittest.TestCase):
    def test_checked_in_human_readable_examples_verify_semantically(self) -> None:
        example_root = Path(__file__).parents[1] / "examples"
        grant = capture_session_rights_grant_from_dict(
            json.loads(
                (example_root / "capture-session-rights-grant.json").read_text(
                    encoding="utf-8"
                )
            )
        )
        attestation = capture_session_rights_grant_attestation_from_dict(
            json.loads(
                (
                    example_root
                    / "capture-session-rights-grant-attestation.json"
                ).read_text(encoding="utf-8")
            )
        )
        snapshot = capture_rights_trust_snapshot_from_dict(
            json.loads(
                (example_root / "capture-rights-trust-snapshot.json").read_text(
                    encoding="utf-8"
                )
            )
        )
        proof = verify_capture_session_rights(
            grant,
            attestation,
            snapshot,
            verified_at_ns=1_783_858_000_000_000_000,
            geography="US",
            match_id=grant.match_id,
            capture_session_id=grant.capture_session_id,
            venue_id=grant.venue_id,
            camera_ids=grant.camera_ids,
            roster_scope_sha256=grant.roster_scope_sha256,
            participant_ids=grant.participant_ids,
            required_uses=CAPTURE_OPERATION_REQUIRED_USES,
            expected_trust_snapshot_sha256=snapshot.fingerprint(),
            expected_protected_policy_fingerprint=("a" * 64),
            expected_protected_policy_generation=7,
        )
        self.assertEqual(proof.grant_sha256, grant.fingerprint())

    def test_exact_codecs_round_trip_all_public_wire_contracts(self) -> None:
        grant = _grant()
        attestation = _attestation(grant)
        snapshot = _snapshot(grant)
        self.assertEqual(
            capture_session_rights_grant_from_dict(grant.to_canonical_dict()),
            grant,
        )
        self.assertEqual(
            capture_session_rights_grant_from_json_bytes(
                grant.canonical_json_bytes()
            ),
            grant,
        )
        self.assertEqual(
            capture_session_rights_grant_attestation_from_dict(
                attestation.to_canonical_dict()
            ),
            attestation,
        )
        self.assertEqual(
            capture_session_rights_grant_attestation_from_json_bytes(
                attestation.canonical_json_bytes()
            ),
            attestation,
        )
        self.assertEqual(
            capture_rights_trust_snapshot_from_dict(snapshot.to_canonical_dict()),
            snapshot,
        )
        self.assertEqual(
            capture_rights_trust_snapshot_from_json_bytes(
                snapshot.canonical_json_bytes()
            ),
            snapshot,
        )

    def test_exact_schema_rejects_unknown_missing_future_asset_and_old_version(self) -> None:
        payload = _grant().to_canonical_dict()
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            capture_session_rights_grant_from_dict(
                {**payload, "segment_sha256": "e" * 64}
            )
        missing = dict(payload)
        missing.pop("participant_ids")
        with self.assertRaisesRegex(ValueError, "missing fields"):
            capture_session_rights_grant_from_dict(missing)
        with self.assertRaisesRegex(ValueError, "schema_version"):
            capture_session_rights_grant_from_dict(
                {**payload, "schema_version": "0.9"}
            )
        with self.assertRaisesRegex(ValueError, "exact JSON object"):
            capture_session_rights_grant_from_dict(  # type: ignore[arg-type]
                type("MappingSubclass", (dict,), {})(payload)
            )

    def test_wire_parser_rejects_duplicate_noncanonical_and_nonfinite_numbers(self) -> None:
        raw = _grant().canonical_json_bytes()
        duplicate = raw[:-1] + b',"grant_id":"grant-other"}'
        with self.assertRaises(CaptureRightsError) as caught:
            capture_session_rights_grant_from_json_bytes(duplicate)
        self.assertEqual(caught.exception.code, "DUPLICATE_JSON_KEY")

        for noncanonical in (b" " + raw, raw + b"\n"):
            with self.subTest(noncanonical=noncanonical[:4]), self.assertRaises(
                CaptureRightsError
            ) as caught:
                capture_session_rights_grant_from_json_bytes(noncanonical)
            self.assertEqual(caught.exception.code, "NONCANONICAL_JSON")

        for token, expected_code in (
            (b"NaN", "NONFINITE_JSON_NUMBER"),
            (b"1.5", "INVALID_JSON_NUMBER"),
            (b"9223372036854775808", "JSON_INTEGER_RANGE"),
        ):
            mutated = raw.replace(b'"valid_from_ns":200', b'"valid_from_ns":' + token)
            with self.subTest(token=token), self.assertRaises(
                CaptureRightsError
            ) as caught:
                capture_session_rights_grant_from_json_bytes(mutated)
            self.assertEqual(caught.exception.code, expected_code)

    def test_wire_parser_rejects_oversize_depth_and_node_exhaustion(self) -> None:
        with self.assertRaises(CaptureRightsError) as caught:
            capture_session_rights_grant_from_json_bytes(
                b" " * (MAX_CAPTURE_RIGHTS_JSON_BYTES + 1)
            )
        self.assertEqual(caught.exception.code, "JSON_SIZE")

        nested: object = 0
        for _ in range(17):
            nested = [nested]
        with self.assertRaises(CaptureRightsError) as caught:
            capture_session_rights_grant_from_json_bytes(
                json.dumps({"value": nested}, separators=(",", ":")).encode("ascii")
            )
        self.assertEqual(caught.exception.code, "JSON_DEPTH_EXCEEDED")

        deeply_nested = b'{"value":' + b"[" * 2_000 + b"0" + b"]" * 2_000 + b"}"
        with self.assertRaises(CaptureRightsError) as caught:
            capture_session_rights_grant_from_json_bytes(deeply_nested)
        self.assertEqual(caught.exception.code, "JSON_DEPTH_EXCEEDED")

        with self.assertRaises(CaptureRightsError) as caught:
            capture_session_rights_grant_from_json_bytes(
                json.dumps(
                    {"value": [0] * 4_100},
                    separators=(",", ":"),
                ).encode("ascii")
            )
        self.assertEqual(caught.exception.code, "JSON_NODE_LIMIT_EXCEEDED")

    def test_nested_trust_codec_rejects_nonobjects_and_collection_overrun(self) -> None:
        snapshot = _snapshot(_grant()).to_canonical_dict()
        malformed = dict(snapshot)
        malformed["keys"] = [7]
        with self.assertRaisesRegex(ValueError, "exact JSON object"):
            capture_rights_trust_snapshot_from_dict(malformed)

        overrun = dict(snapshot)
        overrun["current_grants"] = (
            overrun["current_grants"] * (MAX_CURRENT_GRANTS + 1)
        )
        with self.assertRaisesRegex(ValueError, "exceeds"):
            capture_rights_trust_snapshot_from_dict(overrun)

        payload = _grant().to_canonical_dict()
        payload["camera_ids"] = [
            f"camera-{index:02d}" for index in range(MAX_CAMERA_IDS + 1)
        ]
        with self.assertRaises(ValueError):
            capture_session_rights_grant_from_dict(payload)


if __name__ == "__main__":
    unittest.main()
