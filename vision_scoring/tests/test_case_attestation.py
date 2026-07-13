from __future__ import annotations

import base64
import dataclasses
import hashlib
import inspect
import json
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vision_scoring.case_attestation as attestation_module
from tests.test_review_contracts import POLICY_SHA, make_case
from vision_scoring.authorization import (
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    KeyRevocationStatus,
    PrincipalRole,
    TrustedActorKey,
    TrustedAssessmentKey,
    TrustedAuthorizerKey,
    TrustedKeyKind,
    sign_authorization_command,
    sign_policy_assessment,
)
from vision_scoring.case_attestation import (
    CASE_ATTESTATION_SCHEMA_VERSION,
    CaseAttestationError,
    SignedScorerCopilotCase,
    encode_signed_scorer_copilot_case,
    parse_signed_scorer_copilot_case,
    sign_scorer_copilot_case,
    verify_signed_scorer_copilot_case,
    verify_signed_scorer_copilot_case_at_historical_acceptance,
)
from vision_scoring.review_contracts import (
    MAX_REVIEW_JSON_CONTAINERS,
    MAX_REVIEW_JSON_DEPTH,
    MAX_REVIEW_JSON_NODES,
    MAX_REVIEW_RECORD_BYTES,
)


def public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


class CaseAttestationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.producer_private = Ed25519PrivateKey.generate()
        self.actor_private = Ed25519PrivateKey.generate()
        self.authorizer_private = Ed25519PrivateKey.generate()
        self.producer_key = TrustedAssessmentKey(
            assessor_id="case-producer-1",
            key_id="case-producer-key-1",
            public_key_base64=public_key_base64(self.producer_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.actor_key = TrustedActorKey(
            actor_id="scorekeeper-1",
            key_id="scorekeeper-key-1",
            role=PrincipalRole.SCOREKEEPER,
            public_key_base64=public_key_base64(self.actor_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.authorizer_key = TrustedAuthorizerKey(
            authorizer_id="authorizer-1",
            key_id="authorizer-key-1",
            public_key_base64=public_key_base64(self.authorizer_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.policy = self.make_policy()
        self.archive = self.make_archive((self.policy,), self.policy)
        self.case = make_case()

    def make_policy(self, **overrides: object) -> AuthorizationPolicy:
        values: dict[str, object] = {
            "policy_id": "authorization-policy-v1",
            "trust_domain_id": "court-control",
            "match_id": "match-1",
            "valid_from_ns": 1,
            "valid_until_ns": 10_000,
            "max_command_lifetime_ns": 100,
            "accepted_assessment_policy_fingerprints": (POLICY_SHA,),
            "actor_keys": (self.actor_key,),
            "assessment_keys": (self.producer_key,),
            "authorizer_keys": (self.authorizer_key,),
        }
        values.update(overrides)
        return AuthorizationPolicy(**values)  # type: ignore[arg-type]

    def make_archive(
        self,
        policies: tuple[AuthorizationPolicy, ...],
        current_policy: AuthorizationPolicy,
        *,
        revocations: dict[tuple[TrustedKeyKind, str, str], int | None]
        | None = None,
    ) -> AuthorizationPolicyArchive:
        revocations = revocations or {}
        identities: dict[
            tuple[TrustedKeyKind, str, str],
            tuple[str, int | None],
        ] = {}
        groups = (
            (TrustedKeyKind.ACTOR, "actor_id", "actor_keys"),
            (TrustedKeyKind.ASSESSMENT, "assessor_id", "assessment_keys"),
            (TrustedKeyKind.AUTHORIZER, "authorizer_id", "authorizer_keys"),
        )
        for policy in policies:
            for key_kind, principal_field, collection_field in groups:
                for key in getattr(policy, collection_field):
                    principal_id = getattr(key, principal_field)
                    identity = (key_kind, principal_id, key.key_id)
                    public_fingerprint = hashlib.sha256(
                        base64.b64decode(key.public_key_base64)
                    ).hexdigest()
                    identities[identity] = (
                        public_fingerprint,
                        revocations.get(identity, key.revoked_at_ns),
                    )
        statuses = tuple(
            KeyRevocationStatus(
                key_kind=identity[0],
                principal_id=identity[1],
                key_id=identity[2],
                public_key_sha256=value[0],
                revoked_at_ns=value[1],
            )
            for identity, value in identities.items()
        )
        return AuthorizationPolicyArchive(
            archive_id="match-1-policy-archive",
            trust_domain_id=current_policy.trust_domain_id,
            match_id=current_policy.match_id,
            policies=policies,
            current_policy_fingerprint=current_policy.fingerprint(),
            key_revocations=statuses,
        )

    def sign_case(self, **overrides: object) -> SignedScorerCopilotCase:
        values: dict[str, object] = {
            "case": self.case,
            "policy_archive": self.archive,
            "assessor_id": self.producer_key.assessor_id,
            "assessment_key_id": self.producer_key.key_id,
            "signed_at_ns": 1_350,
            "assessment_private_key": self.producer_private,
        }
        values.update(overrides)
        return sign_scorer_copilot_case(**values)  # type: ignore[arg-type]

    def verify_case(
        self,
        signed: SignedScorerCopilotCase,
        **overrides: object,
    ):
        values: dict[str, object] = {
            "case": self.case,
            "policy_archive": self.archive,
            "verified_at_ns": self.case.opened_at_ns,
        }
        values.update(overrides)
        return verify_signed_scorer_copilot_case(
            signed,
            **values,  # type: ignore[arg-type]
        )

    def test_exact_case_round_trip_and_signature_verify(self) -> None:
        signed = self.sign_case()
        raw = encode_signed_scorer_copilot_case(signed)
        self.assertEqual(parse_signed_scorer_copilot_case(raw), signed)
        self.assertEqual(
            encode_signed_scorer_copilot_case(
                parse_signed_scorer_copilot_case(raw)
            ),
            raw,
        )
        self.assertEqual(self.verify_case(signed), self.case)
        self.assertEqual(
            signed.case_fingerprint,
            hashlib.sha256(
                attestation_module.encode_scorer_copilot_case(self.case)
            ).hexdigest(),
        )

    def test_signing_binds_current_policy_and_verification_resolves_history(
        self,
    ) -> None:
        signed = self.sign_case()
        self.assertEqual(
            signed.authorization_policy_fingerprint,
            self.policy.fingerprint(),
        )
        rotated_policy = self.make_policy(
            policy_id="authorization-policy-v2",
            valid_from_ns=1_400,
        )
        rotated_archive = self.make_archive(
            (self.policy, rotated_policy),
            rotated_policy,
        )
        self.assertEqual(
            self.verify_case(signed, policy_archive=rotated_archive),
            self.case,
        )
        signed_after_rotation = self.sign_case(
            policy_archive=rotated_archive,
            signed_at_ns=self.case.opened_at_ns,
        )
        self.assertEqual(
            signed_after_rotation.authorization_policy_fingerprint,
            rotated_policy.fingerprint(),
        )

    def test_wrong_case_bytes_fingerprint_and_expected_case_fail_closed(self) -> None:
        signed = self.sign_case()
        wrong_case = dataclasses.replace(self.case, opened_at_ns=1_401)
        with self.assertRaisesRegex(CaseAttestationError, "CASE_MISMATCH"):
            self.verify_case(signed, case=wrong_case, verified_at_ns=1_401)
        with self.assertRaisesRegex(ValueError, "case_fingerprint"):
            dataclasses.replace(signed, case_fingerprint="f" * 64)

        forged = dataclasses.replace(
            signed,
            case=wrong_case,
            case_fingerprint=wrong_case.fingerprint(),
        )
        with self.assertRaisesRegex(CaseAttestationError, "SIGNATURE_INVALID"):
            self.verify_case(
                forged,
                case=wrong_case,
                verified_at_ns=wrong_case.opened_at_ns,
            )

    def test_unretained_policy_wrong_scope_and_wrong_key_fail_closed(self) -> None:
        signed = self.sign_case()
        unretained = dataclasses.replace(
            signed,
            authorization_policy_fingerprint="f" * 64,
        )
        with self.assertRaisesRegex(CaseAttestationError, "POLICY_UNTRUSTED"):
            self.verify_case(unretained)

        wrong_scope = dataclasses.replace(signed, trust_domain_id="other-domain")
        with self.assertRaisesRegex(
            CaseAttestationError,
            "CASE_PRODUCER_SCOPE_MISMATCH",
        ):
            self.verify_case(wrong_scope)

        wrong_key = dataclasses.replace(
            signed,
            assessment_key_id="missing-producer-key",
        )
        with self.assertRaisesRegex(
            CaseAttestationError,
            "ASSESSMENT_KEY_UNTRUSTED",
        ):
            self.verify_case(wrong_key)

    def test_private_key_key_validity_and_signature_forgery_fail_closed(self) -> None:
        with self.assertRaisesRegex(
            CaseAttestationError,
            "PRIVATE_KEY_MISMATCH",
        ):
            self.sign_case(assessment_private_key=Ed25519PrivateKey.generate())
        with self.assertRaisesRegex(
            CaseAttestationError,
            "ASSESSMENT_KEY_UNTRUSTED",
        ):
            self.sign_case(assessment_key_id="missing-producer-key")

        expired_key = dataclasses.replace(
            self.producer_key,
            valid_until_ns=1_349,
        )
        expired_policy = self.make_policy(assessment_keys=(expired_key,))
        expired_archive = self.make_archive((expired_policy,), expired_policy)
        with self.assertRaisesRegex(
            CaseAttestationError,
            "ASSESSMENT_KEY_INACTIVE",
        ):
            self.sign_case(policy_archive=expired_archive)

        forged = dataclasses.replace(
            self.sign_case(),
            signature_base64=base64.b64encode(b"x" * 64).decode("ascii"),
        )
        with self.assertRaisesRegex(CaseAttestationError, "SIGNATURE_INVALID"):
            self.verify_case(forged)

    def test_current_archive_revocation_invalidates_prior_signature(self) -> None:
        signed = self.sign_case()
        identity = (
            TrustedKeyKind.ASSESSMENT,
            self.producer_key.assessor_id,
            self.producer_key.key_id,
        )
        revoked_archive = self.make_archive(
            (self.policy,),
            self.policy,
            revocations={identity: 1_375},
        )
        with self.assertRaisesRegex(
            CaseAttestationError,
            "ASSESSMENT_KEY_REVOKED",
        ):
            self.verify_case(signed, policy_archive=revoked_archive)

    def test_signature_time_covers_inputs_and_is_bounded_by_case_open(self) -> None:
        for invalid_time in (1_299, 1_401):
            with self.subTest(signed_at_ns=invalid_time):
                with self.assertRaisesRegex(
                    CaseAttestationError,
                    "CASE_PRODUCER_TIME",
                ):
                    self.sign_case(signed_at_ns=invalid_time)
        for valid_time in (1_300, 1_400):
            with self.subTest(signed_at_ns=valid_time):
                signed = self.sign_case(signed_at_ns=valid_time)
                self.assertEqual(self.verify_case(signed), self.case)

        with self.assertRaisesRegex(
            CaseAttestationError,
            "CASE_ADMISSION_TIME",
        ):
            self.verify_case(self.sign_case(), verified_at_ns=1_399)

        with self.assertRaisesRegex(
            CaseAttestationError,
            "CASE_ADMISSION_TIME",
        ):
            verify_signed_scorer_copilot_case_at_historical_acceptance(
                self.sign_case(),
                case=self.case,
                policy_archive=self.archive,
                accepted_at_ns=1_399,
                verified_at_ns=1_500,
            )

    def test_nested_signed_assessment_must_predate_producer(self) -> None:
        signed_assessment = sign_policy_assessment(
            assessment=self.case.assessment,
            assessor_id=self.producer_key.assessor_id,
            assessment_key_id=self.producer_key.key_id,
            signed_at_ns=1_375,
            assessment_private_key=self.producer_private,
        )
        case = dataclasses.replace(
            self.case,
            signed_assessment=signed_assessment,
        )
        with self.assertRaisesRegex(
            CaseAttestationError,
            "CASE_PRODUCER_TIME",
        ):
            self.sign_case(case=case, signed_at_ns=1_374)
        signed = self.sign_case(case=case, signed_at_ns=1_375)
        self.assertEqual(
            self.verify_case(signed, case=case),
            case,
        )

    def test_wrong_signing_domains_cannot_replay(self) -> None:
        signed = self.sign_case()
        payload = json.dumps(
            signed.unsigned_canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
        wrong_domains = (
            b"multicourt-vision-scoring:policy-assessment-attestation:v1\x00",
            b"multicourt-vision-scoring:scorer-copilot-review:v1\x00",
            b"multicourt-vision-scoring:scorer-copilot-adjudication:v1\x00",
            b"multicourt-vision-scoring:actor-authorization-command:v1\x00",
            b"multicourt-vision-scoring:authorized-rule-event:v1\x00",
        )
        self.assertNotIn(
            attestation_module._CASE_PRODUCER_SIGNING_DOMAIN,
            wrong_domains,
        )
        for domain in wrong_domains:
            with self.subTest(domain=domain):
                replay = dataclasses.replace(
                    signed,
                    signature_base64=base64.b64encode(
                        self.producer_private.sign(domain + payload)
                    ).decode("ascii"),
                )
                with self.assertRaisesRegex(
                    CaseAttestationError,
                    "SIGNATURE_INVALID",
                ):
                    self.verify_case(replay)

    def test_record_has_no_authorization_or_score_capability(self) -> None:
        signed = self.sign_case()
        with self.assertRaisesRegex(ValueError, "AuthorizationCommand"):
            sign_authorization_command(  # type: ignore[arg-type]
                signed,
                self.actor_private,
            )
        self.assertFalse(hasattr(attestation_module, "RuleEvent"))
        self.assertFalse(hasattr(attestation_module, "AuthorizationCommand"))
        self.assertFalse(hasattr(attestation_module, "authorize_rule_event"))
        for function in (
            sign_scorer_copilot_case,
            verify_signed_scorer_copilot_case,
        ):
            parameters = set(inspect.signature(function).parameters)
            self.assertNotIn("event", parameters)
            self.assertNotIn("command", parameters)
            self.assertNotIn("score", parameters)
            self.assertNotIn("state", parameters)

    def test_parser_rejects_field_set_duplicates_and_noncanonical_json(self) -> None:
        raw = encode_signed_scorer_copilot_case(self.sign_case())
        value = json.loads(raw)
        value["unknown"] = "forbidden"
        with self.assertRaisesRegex(CaseAttestationError, "FIELD_SET"):
            parse_signed_scorer_copilot_case(
                json.dumps(
                    value,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("ascii")
            )
        del value["unknown"]
        del value["case_fingerprint"]
        with self.assertRaisesRegex(CaseAttestationError, "FIELD_SET"):
            parse_signed_scorer_copilot_case(
                json.dumps(
                    value,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("ascii")
            )

        duplicated = raw.replace(
            b'"assessment_key_id":',
            b'"assessment_key_id":"duplicate","assessment_key_id":',
            1,
        )
        with self.assertRaisesRegex(CaseAttestationError, "DUPLICATE_KEY"):
            parse_signed_scorer_copilot_case(duplicated)
        with self.assertRaisesRegex(CaseAttestationError, "NON_CANONICAL"):
            parse_signed_scorer_copilot_case(b" " + raw)

    def test_parser_rejects_float_nonfinite_and_non_ascii_json(self) -> None:
        raw = encode_signed_scorer_copilot_case(self.sign_case())
        for token in (b"1.5", b"1e3", b"NaN", b"Infinity"):
            with self.subTest(token=token):
                hostile = raw.replace(b'"signed_at_ns":1350', b'"signed_at_ns":' + token)
                with self.assertRaisesRegex(
                    CaseAttestationError,
                    "INVALID_JSON",
                ):
                    parse_signed_scorer_copilot_case(hostile)
        non_ascii = raw.replace(b"court-control", "court-contr\u00f4l".encode())
        with self.assertRaisesRegex(CaseAttestationError, "INVALID_ASCII"):
            parse_signed_scorer_copilot_case(non_ascii)

    def test_parser_bounds_size_depth_nodes_and_containers(self) -> None:
        with self.assertRaisesRegex(CaseAttestationError, "RAW_SIZE"):
            parse_signed_scorer_copilot_case(
                b"x" * (MAX_REVIEW_RECORD_BYTES + 1)
            )

        deep = (
            b'{"x":'
            + b"[" * MAX_REVIEW_JSON_DEPTH
            + b"0"
            + b"]" * MAX_REVIEW_JSON_DEPTH
            + b"}"
        )
        with self.assertRaisesRegex(CaseAttestationError, "JSON_DEPTH"):
            parse_signed_scorer_copilot_case(deep)

        too_many_nodes = json.dumps(
            {"x": [0] * MAX_REVIEW_JSON_NODES},
            separators=(",", ":"),
        ).encode("ascii")
        with self.assertRaisesRegex(CaseAttestationError, "JSON_NODES"):
            parse_signed_scorer_copilot_case(too_many_nodes)

        too_many_containers = json.dumps(
            {"x": [[] for _ in range(MAX_REVIEW_JSON_CONTAINERS)]},
            separators=(",", ":"),
        ).encode("ascii")
        with self.assertRaisesRegex(CaseAttestationError, "JSON_CONTAINERS"):
            parse_signed_scorer_copilot_case(too_many_containers)

    def test_schema_and_exact_runtime_types_are_enforced(self) -> None:
        signed = self.sign_case()
        with self.assertRaisesRegex(ValueError, "unsupported"):
            dataclasses.replace(signed, schema_version="2.0")
        self.assertEqual(signed.schema_version, CASE_ATTESTATION_SCHEMA_VERSION)
        with self.assertRaisesRegex(ValueError, "SignedScorerCopilotCase"):
            encode_signed_scorer_copilot_case(self.case)  # type: ignore[arg-type]
        with self.assertRaisesRegex(CaseAttestationError, "RAW_TYPE"):
            parse_signed_scorer_copilot_case(bytearray(b"{}"))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
