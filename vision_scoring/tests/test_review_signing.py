from __future__ import annotations

import base64
import dataclasses
import hashlib
import inspect
import json
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vision_scoring.review_signing as signing_module
from vision_scoring.authorization import (
    AuthorizationError,
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
from vision_scoring.review_contracts import (
    SignedReviewAdjudication,
    encode_signed_review_adjudication,
    encode_signed_review_disposition,
    parse_signed_review_adjudication,
    parse_signed_review_disposition,
)
from vision_scoring.review_signing import (
    ReviewSignatureError,
    sign_review_adjudication,
    sign_review_disposition,
    verify_case_policy_assessment,
    verify_signed_review_adjudication,
    verify_signed_review_disposition,
)
from tests.test_review_contracts import (
    POLICY_SHA,
    make_adjudication,
    make_case,
    make_disposition,
)


def public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


class ReviewSigningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scorekeeper_private = Ed25519PrivateKey.generate()
        self.referee_private = Ed25519PrivateKey.generate()
        self.admin_private = Ed25519PrivateKey.generate()
        self.authorizer_private = Ed25519PrivateKey.generate()
        self.assessment_private = Ed25519PrivateKey.generate()
        self.scorekeeper_key = TrustedActorKey(
            actor_id="scorekeeper-1",
            key_id="scorekeeper-key-1",
            role=PrincipalRole.SCOREKEEPER,
            public_key_base64=public_key_base64(self.scorekeeper_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.referee_key = TrustedActorKey(
            actor_id="referee-1",
            key_id="referee-key-1",
            role=PrincipalRole.REFEREE,
            public_key_base64=public_key_base64(self.referee_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.admin_key = TrustedActorKey(
            actor_id="admin-1",
            key_id="admin-key-1",
            role=PrincipalRole.MATCH_ADMIN,
            public_key_base64=public_key_base64(self.admin_private),
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
        self.assessment_key = TrustedAssessmentKey(
            assessor_id="assessment-service-1",
            key_id="assessment-key-1",
            public_key_base64=public_key_base64(self.assessment_private),
            valid_from_ns=1,
            valid_until_ns=10_000,
        )
        self.policy = AuthorizationPolicy(
            policy_id="authorization-policy-v1",
            trust_domain_id="court-control",
            match_id="match-1",
            valid_from_ns=1,
            valid_until_ns=10_000,
            max_command_lifetime_ns=100,
            accepted_assessment_policy_fingerprints=(POLICY_SHA,),
            actor_keys=(self.scorekeeper_key, self.referee_key, self.admin_key),
            assessment_keys=(self.assessment_key,),
            authorizer_keys=(self.authorizer_key,),
        )
        self.archive = self.archive_for()
        self.case = make_case()
        self.disposition = make_disposition(self.case)

    def archive_for(
        self,
        *,
        policy: AuthorizationPolicy | None = None,
        revocations: dict[tuple[TrustedKeyKind, str, str], int | None] | None = None,
    ) -> AuthorizationPolicyArchive:
        policy = policy or self.policy
        revocations = revocations or {}
        statuses: list[KeyRevocationStatus] = []
        groups = (
            (TrustedKeyKind.ACTOR, policy.actor_keys, "actor_id"),
            (TrustedKeyKind.ASSESSMENT, policy.assessment_keys, "assessor_id"),
            (TrustedKeyKind.AUTHORIZER, policy.authorizer_keys, "authorizer_id"),
        )
        for key_kind, keys, principal_field in groups:
            for key in keys:
                principal_id = getattr(key, principal_field)
                raw = base64.b64decode(key.public_key_base64)
                statuses.append(
                    KeyRevocationStatus(
                        key_kind=key_kind,
                        principal_id=principal_id,
                        key_id=key.key_id,
                        public_key_sha256=hashlib.sha256(raw).hexdigest(),
                        revoked_at_ns=revocations.get(
                            (key_kind, principal_id, key.key_id),
                            key.revoked_at_ns,
                        ),
                    )
                )
        return AuthorizationPolicyArchive(
            archive_id="match-1-policy-archive",
            trust_domain_id=policy.trust_domain_id,
            match_id=policy.match_id,
            policies=(policy,),
            current_policy_fingerprint=policy.fingerprint(),
            key_revocations=tuple(statuses),
        )

    def sign_as_scorekeeper(self, **overrides: object):
        values: dict[str, object] = {
            "disposition": self.disposition,
            "case": self.case,
            "policy_archive": self.archive,
            "actor_id": self.scorekeeper_key.actor_id,
            "actor_key_id": self.scorekeeper_key.key_id,
            "actor_role": PrincipalRole.SCOREKEEPER,
            "signed_at_ns": 1_500,
            "actor_private_key": self.scorekeeper_private,
        }
        values.update(overrides)
        return sign_review_disposition(**values)  # type: ignore[arg-type]

    def sign_as_referee(
        self,
        *,
        considered_signed_dispositions=None,
        adjudication=None,
        **overrides: object,
    ):
        considered = considered_signed_dispositions or (self.sign_as_scorekeeper(),)
        adjudication = adjudication or make_adjudication(self.case, considered[0])
        values: dict[str, object] = {
            "adjudication": adjudication,
            "considered_signed_dispositions": considered,
            "case": self.case,
            "policy_archive": self.archive,
            "actor_id": self.referee_key.actor_id,
            "actor_key_id": self.referee_key.key_id,
            "actor_role": PrincipalRole.REFEREE,
            "signed_at_ns": 1_501,
            "actor_private_key": self.referee_private,
        }
        values.update(overrides)
        return sign_review_adjudication(**values)  # type: ignore[arg-type]

    def case_with_signed_assessment(self, **overrides: object):
        signed = sign_policy_assessment(
            assessment=self.case.assessment,
            assessor_id=self.assessment_key.assessor_id,
            assessment_key_id=self.assessment_key.key_id,
            signed_at_ns=1_350,
            assessment_private_key=self.assessment_private,
        )
        values: dict[str, object] = {"signed_assessment": signed}
        values.update(overrides)
        return dataclasses.replace(self.case, **values)

    def test_scorekeeper_and_referee_review_signatures_verify(self) -> None:
        scorekeeper = self.sign_as_scorekeeper()
        self.assertEqual(
            verify_signed_review_disposition(
                scorekeeper,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            ),
            self.disposition,
        )
        referee_review = sign_review_disposition(
            disposition=self.disposition,
            case=self.case,
            policy_archive=self.archive,
            actor_id=self.referee_key.actor_id,
            actor_key_id=self.referee_key.key_id,
            actor_role=PrincipalRole.REFEREE,
            signed_at_ns=1_500,
            actor_private_key=self.referee_private,
        )
        self.assertEqual(
            verify_signed_review_disposition(
                referee_review,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            ),
            self.disposition,
        )

    def test_only_referee_may_adjudicate(self) -> None:
        considered = (self.sign_as_scorekeeper(),)
        adjudication = make_adjudication(self.case, considered[0])
        with self.assertRaisesRegex(ReviewSignatureError, "ROLE_FORBIDDEN"):
            sign_review_adjudication(
                adjudication=adjudication,
                considered_signed_dispositions=considered,
                case=self.case,
                policy_archive=self.archive,
                actor_id=self.scorekeeper_key.actor_id,
                actor_key_id=self.scorekeeper_key.key_id,
                actor_role=PrincipalRole.SCOREKEEPER,
                signed_at_ns=1_501,
                actor_private_key=self.scorekeeper_private,
            )
        signed = self.sign_as_referee(
            considered_signed_dispositions=considered,
            adjudication=adjudication,
        )
        self.assertEqual(
            verify_signed_review_adjudication(
                signed,
                considered_signed_dispositions=considered,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            ),
            adjudication,
        )

    def test_match_admin_cannot_sign_review(self) -> None:
        with self.assertRaisesRegex(ReviewSignatureError, "ROLE_FORBIDDEN"):
            sign_review_disposition(
                disposition=self.disposition,
                case=self.case,
                policy_archive=self.archive,
                actor_id=self.admin_key.actor_id,
                actor_key_id=self.admin_key.key_id,
                actor_role=PrincipalRole.MATCH_ADMIN,
                signed_at_ns=1_500,
                actor_private_key=self.admin_private,
            )

    def test_signature_binds_every_disposition_byte(self) -> None:
        signed = self.sign_as_scorekeeper()
        changed = dataclasses.replace(
            self.disposition,
            idempotency_key="review-action-2",
        )
        tampered = dataclasses.replace(
            signed,
            disposition=changed,
            disposition_fingerprint=changed.fingerprint(),
        )
        with self.assertRaisesRegex(ReviewSignatureError, "SIGNATURE_INVALID"):
            verify_signed_review_disposition(
                tampered,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            )

    def test_review_and_adjudication_signing_domains_are_not_interchangeable(self) -> None:
        referee_review = sign_review_disposition(
            disposition=self.disposition,
            case=self.case,
            policy_archive=self.archive,
            actor_id=self.referee_key.actor_id,
            actor_key_id=self.referee_key.key_id,
            actor_role=PrincipalRole.REFEREE,
            signed_at_ns=1_501,
            actor_private_key=self.referee_private,
        )
        adjudication = make_adjudication(self.case, referee_review)
        forged = SignedReviewAdjudication(
            adjudication=adjudication,
            adjudication_fingerprint=adjudication.fingerprint(),
            actor_id=referee_review.actor_id,
            actor_key_id=referee_review.actor_key_id,
            actor_role=referee_review.actor_role,
            policy_fingerprint=referee_review.policy_fingerprint,
            trust_domain_id=referee_review.trust_domain_id,
            signed_at_ns=referee_review.signed_at_ns,
            signature_base64=referee_review.signature_base64,
        )
        with self.assertRaisesRegex(ReviewSignatureError, "SIGNATURE_INVALID"):
            verify_signed_review_adjudication(
                forged,
                considered_signed_dispositions=(referee_review,),
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            )

    def test_adjudication_requires_exact_valid_signed_dispositions(self) -> None:
        considered = (self.sign_as_scorekeeper(),)
        adjudication = make_adjudication(self.case, considered[0])
        unsigned_identity = dataclasses.replace(
            adjudication,
            previous_record_fingerprint=self.disposition.fingerprint(),
            considered_signed_disposition_fingerprints=(
                self.disposition.fingerprint(),
            ),
        )
        with self.assertRaisesRegex(
            ReviewSignatureError, "ADJUDICATION_DISPOSITIONS"
        ):
            self.sign_as_referee(
                considered_signed_dispositions=considered,
                adjudication=unsigned_identity,
            )

        changed_disposition = dataclasses.replace(
            self.disposition,
            idempotency_key="review-action-2",
        )
        second = self.sign_as_scorekeeper(disposition=changed_disposition)
        with self.assertRaisesRegex(
            ReviewSignatureError, "ADJUDICATION_DISPOSITIONS"
        ):
            self.sign_as_referee(
                considered_signed_dispositions=(considered[0], second),
                adjudication=adjudication,
            )

        forged = dataclasses.replace(
            considered[0],
            signature_base64=base64.b64encode(b"z" * 64).decode("ascii"),
        )
        forged_adjudication = make_adjudication(self.case, forged)
        with self.assertRaisesRegex(ReviewSignatureError, "SIGNATURE_INVALID"):
            self.sign_as_referee(
                considered_signed_dispositions=(forged,),
                adjudication=forged_adjudication,
            )

        other_case = dataclasses.replace(self.case, opened_at_ns=1_401)
        wrong_case_adjudication = dataclasses.replace(
            adjudication,
            case_fingerprint=other_case.fingerprint(),
        )
        with self.assertRaisesRegex(ReviewSignatureError, "CASE_MISMATCH"):
            self.sign_as_referee(
                considered_signed_dispositions=considered,
                adjudication=wrong_case_adjudication,
                case=other_case,
            )

    def test_adjudication_cannot_precede_any_considered_signature(self) -> None:
        considered = (self.sign_as_scorekeeper(signed_at_ns=1_500),)
        adjudication = make_adjudication(self.case, considered[0])
        with self.assertRaisesRegex(ReviewSignatureError, "ADJUDICATION_TIME"):
            self.sign_as_referee(
                considered_signed_dispositions=considered,
                adjudication=adjudication,
                signed_at_ns=1_499,
            )

        attestation = SignedReviewAdjudication.attestation_dict(
            adjudication=adjudication,
            adjudication_fingerprint=adjudication.fingerprint(),
            actor_id=self.referee_key.actor_id,
            actor_key_id=self.referee_key.key_id,
            actor_role=PrincipalRole.REFEREE,
            policy_fingerprint=self.policy.fingerprint(),
            trust_domain_id=self.policy.trust_domain_id,
            signed_at_ns=1_499,
        )
        message = (
            b"multicourt-vision-scoring:scorer-copilot-adjudication:v1\x00"
            + json.dumps(
                attestation,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ).encode("ascii")
        )
        backdated = SignedReviewAdjudication(
            adjudication=adjudication,
            adjudication_fingerprint=adjudication.fingerprint(),
            actor_id=self.referee_key.actor_id,
            actor_key_id=self.referee_key.key_id,
            actor_role=PrincipalRole.REFEREE,
            policy_fingerprint=self.policy.fingerprint(),
            trust_domain_id=self.policy.trust_domain_id,
            signed_at_ns=1_499,
            signature_base64=base64.b64encode(
                self.referee_private.sign(message)
            ).decode("ascii"),
        )
        with self.assertRaisesRegex(ReviewSignatureError, "ADJUDICATION_TIME"):
            verify_signed_review_adjudication(
                backdated,
                considered_signed_dispositions=considered,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            )

    def test_signature_time_cannot_precede_case_in_sign_or_verify(self) -> None:
        with self.assertRaisesRegex(ReviewSignatureError, "REVIEW_TIME"):
            self.sign_as_scorekeeper(signed_at_ns=self.case.opened_at_ns - 1)
        signed = self.sign_as_scorekeeper()
        backdated = dataclasses.replace(
            signed,
            signed_at_ns=self.case.opened_at_ns - 1,
        )
        with self.assertRaisesRegex(ReviewSignatureError, "REVIEW_TIME"):
            verify_signed_review_disposition(
                backdated,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            )

        considered = (self.sign_as_scorekeeper(),)
        with self.assertRaisesRegex(ReviewSignatureError, "REVIEW_TIME"):
            self.sign_as_referee(
                considered_signed_dispositions=considered,
                signed_at_ns=self.case.opened_at_ns - 1,
            )
        adjudication = self.sign_as_referee(
            considered_signed_dispositions=considered
        )
        backdated_adjudication = dataclasses.replace(
            adjudication,
            signed_at_ns=self.case.opened_at_ns - 1,
        )
        with self.assertRaisesRegex(ReviewSignatureError, "REVIEW_TIME"):
            verify_signed_review_adjudication(
                backdated_adjudication,
                considered_signed_dispositions=considered,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_600,
            )

    def test_current_revocation_invalidates_a_historical_review_signature(self) -> None:
        revoked_archive = self.archive_for(
            revocations={
                (
                    TrustedKeyKind.ACTOR,
                    self.scorekeeper_key.actor_id,
                    self.scorekeeper_key.key_id,
                ): 1_550
            }
        )
        signed = self.sign_as_scorekeeper(policy_archive=revoked_archive)
        with self.assertRaisesRegex(ReviewSignatureError, "ACTOR_KEY_REVOKED"):
            verify_signed_review_disposition(
                signed,
                case=self.case,
                policy_archive=revoked_archive,
                verified_at_ns=1_600,
            )

    def test_case_admission_allows_absence_but_verifies_any_present_assessment(self) -> None:
        self.assertIsNone(
            verify_case_policy_assessment(
                self.case,
                policy_archive=self.archive,
                verified_at_ns=1_500,
            )
        )
        signed_case = self.case_with_signed_assessment()
        self.assertEqual(
            verify_case_policy_assessment(
                signed_case,
                policy_archive=self.archive,
                verified_at_ns=1_500,
            ),
            self.case.assessment,
        )

        forged_assessment = dataclasses.replace(
            signed_case.signed_assessment,
            signature_base64=base64.b64encode(b"q" * 64).decode("ascii"),
        )
        forged_case = dataclasses.replace(
            signed_case,
            signed_assessment=forged_assessment,
        )
        with self.assertRaisesRegex(
            AuthorizationError, "ASSESSMENT_SIGNATURE_INVALID"
        ):
            verify_case_policy_assessment(
                forged_case,
                policy_archive=self.archive,
                verified_at_ns=1_500,
            )

        wrong_key_assessment = dataclasses.replace(
            signed_case.signed_assessment,
            assessment_key_id="missing-assessment-key",
        )
        wrong_key_case = dataclasses.replace(
            signed_case,
            signed_assessment=wrong_key_assessment,
        )
        with self.assertRaisesRegex(AuthorizationError, "ASSESSMENT_KEY_UNTRUSTED"):
            verify_case_policy_assessment(
                wrong_key_case,
                policy_archive=self.archive,
                verified_at_ns=1_500,
            )

    def test_case_assessment_admission_enforces_policy_scope_and_current_revocation(self) -> None:
        signed_case = self.case_with_signed_assessment()
        unaccepted_policy = dataclasses.replace(
            self.policy,
            accepted_assessment_policy_fingerprints=(),
        )
        with self.assertRaisesRegex(
            AuthorizationError, "ASSESSMENT_POLICY_UNTRUSTED"
        ):
            verify_case_policy_assessment(
                signed_case,
                policy_archive=self.archive_for(policy=unaccepted_policy),
                verified_at_ns=1_500,
            )

        revoked_archive = self.archive_for(
            revocations={
                (
                    TrustedKeyKind.ASSESSMENT,
                    self.assessment_key.assessor_id,
                    self.assessment_key.key_id,
                ): 1_450
            }
        )
        with self.assertRaisesRegex(AuthorizationError, "ASSESSMENT_KEY_REVOKED"):
            verify_case_policy_assessment(
                signed_case,
                policy_archive=revoked_archive,
                verified_at_ns=1_500,
            )

        wrong_scope_policy = dataclasses.replace(self.policy, match_id="match-2")
        with self.assertRaisesRegex(AuthorizationError, "ASSESSMENT_CONTEXT"):
            verify_case_policy_assessment(
                signed_case,
                policy_archive=self.archive_for(policy=wrong_scope_policy),
                verified_at_ns=1_500,
            )

    def test_wrong_case_scope_key_and_private_material_fail_closed(self) -> None:
        wrong_case = dataclasses.replace(self.case, opened_at_ns=1_401)
        with self.assertRaisesRegex(ValueError, "exact case"):
            self.sign_as_scorekeeper(case=wrong_case)
        with self.assertRaisesRegex(ReviewSignatureError, "PRIVATE_KEY_MISMATCH"):
            self.sign_as_scorekeeper(actor_private_key=Ed25519PrivateKey.generate())
        with self.assertRaisesRegex(ReviewSignatureError, "ACTOR_KEY_UNTRUSTED"):
            self.sign_as_scorekeeper(actor_key_id="missing-key")

    def test_verification_time_and_current_policy_freshness_are_enforced(self) -> None:
        signed = self.sign_as_scorekeeper()
        with self.assertRaisesRegex(ReviewSignatureError, "FUTURE_SIGNATURE"):
            verify_signed_review_disposition(
                signed,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=1_499,
            )
        with self.assertRaisesRegex(ReviewSignatureError, "POLICY_ARCHIVE_STALE"):
            verify_signed_review_disposition(
                signed,
                case=self.case,
                policy_archive=self.archive,
                verified_at_ns=10_001,
            )

    def test_signed_records_round_trip_through_strict_canonical_parsers(self) -> None:
        disposition = self.sign_as_scorekeeper()
        adjudication = self.sign_as_referee()
        self.assertEqual(
            parse_signed_review_disposition(
                encode_signed_review_disposition(disposition)
            ),
            disposition,
        )
        self.assertEqual(
            parse_signed_review_adjudication(
                encode_signed_review_adjudication(adjudication)
            ),
            adjudication,
        )

    def test_review_signatures_cannot_be_used_as_authorization_commands(self) -> None:
        signed = self.sign_as_scorekeeper()
        with self.assertRaisesRegex(ValueError, "AuthorizationCommand"):
            sign_authorization_command(signed, self.scorekeeper_private)  # type: ignore[arg-type]
        self.assertFalse(hasattr(signing_module, "RuleEvent"))
        self.assertFalse(hasattr(signing_module, "authorize_rule_event"))
        for function in (sign_review_disposition, sign_review_adjudication):
            parameters = set(inspect.signature(function).parameters)
            self.assertNotIn("event", parameters)
            self.assertNotIn("score", parameters)
            self.assertNotIn("state", parameters)


if __name__ == "__main__":
    unittest.main()
