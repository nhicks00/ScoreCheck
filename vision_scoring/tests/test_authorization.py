from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.authorization import (
    MAX_AUTHORIZATION_BYTES,
    AuthorizationCommand,
    AuthorizationError,
    AuthorizationOrigin,
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    AuthorizedRuleEvent,
    KeyRevocationStatus,
    PrincipalRole,
    ROLE_EVENT_ALLOWLISTS,
    SignedPolicyAssessment,
    TrustedActorKey,
    TrustedAssessmentKey,
    TrustedAuthorizerKey,
    TrustedKeyKind,
    authorize_rule_event,
    encode_authorization_command,
    encode_authorized_rule_event,
    parse_authorized_rule_event,
    sign_authorization_command,
    sign_policy_assessment,
    verify_authorized_rule_event,
    verify_signed_policy_assessment,
)
from vision_scoring.domain_events import (
    CourtSide,
    PointAwardedPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    Team,
)
from vision_scoring.policy import (
    PolicyAssessment,
    PolicyAssessmentStatus,
    PolicyReason,
    ScoringIntent,
    ScoringIntentKind,
)
from vision_scoring.reconciliation import NextServerOutcome


RULESET_FINGERPRINT = "a" * 64
HYPOTHESIS_FINGERPRINT = "b" * 64
SCORING_POLICY_FINGERPRINT = "c" * 64


def public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


def point_event(*, winner: Team = Team.A, event_id: str = "event-2") -> RuleEvent:
    return RuleEvent(
        event_id=event_id,
        sequence_number=2,
        match_id="match-1",
        set_number=1,
        event_type=RuleEventType.POINT_AWARDED,
        ruleset_id="FIVB_BEACH",
        ruleset_version="2025-2028",
        ruleset_fingerprint=RULESET_FINGERPRINT,
        payload=PointAwardedPayload(winner, ("artifact:frame:1",)),
        created_at_ns=900,
        related_rally_id="rally-1",
    )


def seed_event() -> RuleEvent:
    return RuleEvent(
        event_id="event-seed",
        sequence_number=2,
        match_id="match-1",
        set_number=1,
        event_type=RuleEventType.SET_SEED,
        ruleset_id="FIVB_BEACH",
        ruleset_version="2025-2028",
        ruleset_fingerprint=RULESET_FINGERPRINT,
        payload=SetSeedPayload(
            ("a1", "a2"),
            ("b1", "b2"),
            Team.A,
            "a1",
            CourtSide.NEAR,
            CourtSide.FAR,
        ),
        created_at_ns=900,
    )


def assessment(*, winner: Team = Team.A) -> PolicyAssessment:
    return PolicyAssessment(
        hypothesis_id="hypothesis-1",
        hypothesis_fingerprint=HYPOTHESIS_FINGERPRINT,
        match_id="match-1",
        rally_id="rally-1",
        set_number=1,
        state_revision=1,
        ruleset_fingerprint=RULESET_FINGERPRINT,
        causal_cutoff_timestamp_ns=800,
        policy_version="scoring-policy-v1",
        policy_fingerprint=SCORING_POLICY_FINGERPRINT,
        status=PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
        reasons=(PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,),
        recommended_intent=ScoringIntent(
            ScoringIntentKind.AWARD_POINT,
            winner,
        ),
        evidence_refs=("artifact:frame:1",),
    )


class AuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.actor_private = Ed25519PrivateKey.generate()
        self.referee_private = Ed25519PrivateKey.generate()
        self.admin_private = Ed25519PrivateKey.generate()
        self.assessment_private = Ed25519PrivateKey.generate()
        self.authorizer_private = Ed25519PrivateKey.generate()
        self.actor_key = TrustedActorKey(
            actor_id="human-scorekeeper-1",
            key_id="actor-key-1",
            role=PrincipalRole.SCOREKEEPER,
            public_key_base64=public_key_base64(self.actor_private),
            valid_from_ns=1,
            valid_until_ns=100_000,
        )
        self.referee_key = TrustedActorKey(
            actor_id="human-referee-1",
            key_id="referee-key-1",
            role=PrincipalRole.REFEREE,
            public_key_base64=public_key_base64(self.referee_private),
            valid_from_ns=1,
            valid_until_ns=100_000,
        )
        self.admin_key = TrustedActorKey(
            actor_id="human-admin-1",
            key_id="admin-key-1",
            role=PrincipalRole.MATCH_ADMIN,
            public_key_base64=public_key_base64(self.admin_private),
            valid_from_ns=1,
            valid_until_ns=100_000,
        )
        self.authorizer_key = TrustedAuthorizerKey(
            authorizer_id="authorization-boundary-1",
            key_id="authorizer-key-1",
            public_key_base64=public_key_base64(self.authorizer_private),
            valid_from_ns=1,
            valid_until_ns=100_000,
        )
        self.assessment_key = TrustedAssessmentKey(
            assessor_id="scoring-policy-service-1",
            key_id="assessment-key-1",
            public_key_base64=public_key_base64(self.assessment_private),
            valid_from_ns=1,
            valid_until_ns=100_000,
        )
        self.policy = AuthorizationPolicy(
            policy_id="authorization-policy-v1",
            trust_domain_id="production-court-control",
            match_id="match-1",
            valid_from_ns=1,
            valid_until_ns=100_000,
            max_command_lifetime_ns=100,
            accepted_assessment_policy_fingerprints=(
                SCORING_POLICY_FINGERPRINT,
            ),
            actor_keys=(self.actor_key, self.referee_key, self.admin_key),
            assessment_keys=(self.assessment_key,),
            authorizer_keys=(self.authorizer_key,),
        )
        self.archive = self.archive_for(self.policy)

    def archive_for(
        self,
        current_policy: AuthorizationPolicy,
        *,
        historical_policies: tuple[AuthorizationPolicy, ...] = (),
        revocation_overrides: dict[
            tuple[TrustedKeyKind, str, str], int | None
        ]
        | None = None,
    ) -> AuthorizationPolicyArchive:
        policies = historical_policies + (current_policy,)
        statuses: dict[
            tuple[TrustedKeyKind, str, str], KeyRevocationStatus
        ] = {}
        overrides = revocation_overrides or {}
        for policy in policies:
            key_groups = (
                (TrustedKeyKind.ACTOR, policy.actor_keys, "actor_id"),
                (
                    TrustedKeyKind.ASSESSMENT,
                    policy.assessment_keys,
                    "assessor_id",
                ),
                (
                    TrustedKeyKind.AUTHORIZER,
                    policy.authorizer_keys,
                    "authorizer_id",
                ),
            )
            for kind, keys, principal_field in key_groups:
                for key in keys:
                    principal_id = getattr(key, principal_field)
                    identity = (kind, principal_id, key.key_id)
                    revoked_at_ns = overrides.get(identity, key.revoked_at_ns)
                    statuses[identity] = KeyRevocationStatus(
                        key_kind=kind,
                        principal_id=principal_id,
                        key_id=key.key_id,
                        public_key_sha256=hashlib.sha256(
                            base64.b64decode(key.public_key_base64)
                        ).hexdigest(),
                        revoked_at_ns=revoked_at_ns,
                    )
        return AuthorizationPolicyArchive(
            archive_id="match-1-authorization-policies",
            trust_domain_id=current_policy.trust_domain_id,
            match_id=current_policy.match_id,
            policies=policies,
            current_policy_fingerprint=current_policy.fingerprint(),
            key_revocations=tuple(statuses.values()),
        )

    def command(
        self,
        *,
        event: RuleEvent | None = None,
        origin: AuthorizationOrigin = AuthorizationOrigin.HUMAN_DIRECT,
        actor_key: TrustedActorKey | None = None,
        assessment_value: PolicyAssessment | None = None,
        expected_revision: int = 1,
        policy: AuthorizationPolicy | None = None,
        signed_assessment_value: SignedPolicyAssessment | None = None,
        issued_at_ns: int = 1_000,
        expires_at_ns: int = 1_050,
    ) -> AuthorizationCommand:
        event = event or point_event()
        actor_key = actor_key or self.actor_key
        policy = policy or self.policy
        if assessment_value is not None and signed_assessment_value is None:
            signed_assessment_value = sign_policy_assessment(
                assessment=assessment_value,
                assessor_id=self.assessment_key.assessor_id,
                assessment_key_id=self.assessment_key.key_id,
                signed_at_ns=850,
                assessment_private_key=self.assessment_private,
            )
        return AuthorizationCommand(
            event=event,
            event_fingerprint=event.fingerprint(),
            expected_revision=expected_revision,
            idempotency_key="match-1:event-2:attempt-1",
            origin=origin,
            actor_id=actor_key.actor_id,
            actor_key_id=actor_key.key_id,
            actor_role=actor_key.role,
            issued_at_ns=issued_at_ns,
            expires_at_ns=expires_at_ns,
            nonce="random-nonce-0000000001",
            policy_id=policy.policy_id,
            policy_fingerprint=policy.fingerprint(),
            trust_domain_id=policy.trust_domain_id,
            assessment=assessment_value,
            assessment_fingerprint=(
                assessment_value.fingerprint()
                if assessment_value is not None
                else None
            ),
            signed_assessment=signed_assessment_value,
        )

    def signed(
        self,
        command: AuthorizationCommand | None = None,
        private_key: Ed25519PrivateKey | None = None,
    ):
        return sign_authorization_command(
            command or self.command(),
            private_key or self.actor_private,
        )

    def authorize(
        self,
        signed_command=None,
        *,
        policy: AuthorizationPolicy | None = None,
        policy_archive: AuthorizationPolicyArchive | None = None,
        private_key: Ed25519PrivateKey | None = None,
        authorized_at_ns: int = 1_020,
    ) -> AuthorizedRuleEvent:
        return authorize_rule_event(
            signed_command=signed_command or self.signed(),
            policy_archive=(
                policy_archive
                or (self.archive_for(policy) if policy is not None else self.archive)
            ),
            authorizer_id=self.authorizer_key.authorizer_id,
            authorizer_key_id=self.authorizer_key.key_id,
            authorizer_private_key=private_key or self.authorizer_private,
            authorized_at_ns=authorized_at_ns,
        )

    def assert_error(self, code: str, operation) -> AuthorizationError:
        with self.assertRaises(AuthorizationError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_human_direct_command_round_trips_and_verifies(self) -> None:
        command = self.command()
        envelope = self.authorize(self.signed(command))
        encoded = encode_authorized_rule_event(envelope)
        parsed = parse_authorized_rule_event(encoded)

        self.assertEqual(parsed, envelope)
        self.assertEqual(encode_authorized_rule_event(parsed), encoded)
        self.assertEqual(
            verify_authorized_rule_event(
                parsed,
                policy_archive=self.archive,
                verified_at_ns=1_030,
            ),
            command.event,
        )
        self.assertEqual(
            encode_authorization_command(command),
            json.dumps(
                command.canonical_dict(),
                sort_keys=True,
                separators=(",", ":"),
            ).encode("ascii"),
        )
        self.assertNotIn(b"private", encoded.lower())

    def test_assessment_assisted_path_binds_exact_intent_and_context(self) -> None:
        exact_assessment = assessment()
        command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=exact_assessment,
        )
        envelope = parse_authorized_rule_event(
            encode_authorized_rule_event(self.authorize(self.signed(command)))
        )

        self.assertEqual(
            envelope.authorization_record.assessment,
            exact_assessment,
        )
        self.assertEqual(
            verify_authorized_rule_event(
                envelope,
                policy_archive=self.archive,
                verified_at_ns=1_030,
            ),
            point_event(),
        )

    def test_human_direct_forbids_assessment_and_assisted_requires_one(self) -> None:
        with self.assertRaisesRegex(ValueError, "human-direct"):
            self.command(assessment_value=assessment())
        with self.assertRaisesRegex(ValueError, "assessment-assisted"):
            self.command(origin=AuthorizationOrigin.ASSESSMENT_ASSISTED)

    def test_public_assessment_verifier_checks_exact_trust_scope_and_causality(self) -> None:
        exact_assessment = assessment()
        signed_assessment = sign_policy_assessment(
            assessment=exact_assessment,
            assessor_id=self.assessment_key.assessor_id,
            assessment_key_id=self.assessment_key.key_id,
            signed_at_ns=850,
            assessment_private_key=self.assessment_private,
        )
        self.assertEqual(
            verify_signed_policy_assessment(
                signed_assessment,
                assessment=exact_assessment,
                policy_archive=self.archive,
                verified_at_ns=900,
            ),
            exact_assessment,
        )

        with self.assertRaisesRegex(AuthorizationError, "ASSESSMENT_TIME"):
            verify_signed_policy_assessment(
                dataclasses.replace(signed_assessment, signed_at_ns=799),
                assessment=exact_assessment,
                policy_archive=self.archive,
                verified_at_ns=900,
            )
        with self.assertRaisesRegex(
            AuthorizationError, "ASSESSMENT_SIGNATURE_REQUIRED"
        ):
            verify_signed_policy_assessment(
                signed_assessment,
                assessment=assessment(winner=Team.B),
                policy_archive=self.archive,
                verified_at_ns=900,
            )

    def test_changed_assessment_intent_is_rejected_even_when_human_signed(self) -> None:
        changed = assessment(winner=Team.B)
        command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=changed,
        )
        self.assert_error(
            "ASSESSMENT_INTENT",
            lambda: self.authorize(self.signed(command)),
        )

    def test_assisted_assessment_status_context_and_evidence_fail_closed(self) -> None:
        untrusted_policy_assessment = dataclasses.replace(
            assessment(), policy_fingerprint="d" * 64
        )
        untrusted_policy_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=untrusted_policy_assessment,
        )
        self.assert_error(
            "ASSESSMENT_POLICY_UNTRUSTED",
            lambda: self.authorize(self.signed(untrusted_policy_command)),
        )

        review_only = dataclasses.replace(
            assessment(),
            status=PolicyAssessmentStatus.REVIEW_REQUIRED,
            reasons=(PolicyReason.INSUFFICIENT_CONFIDENCE,),
        )
        review_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=review_only,
        )
        self.assert_error(
            "ASSESSMENT_NOT_READY",
            lambda: self.authorize(self.signed(review_command)),
        )

        wrong_context = dataclasses.replace(assessment(), match_id="match-other")
        context_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=wrong_context,
        )
        self.assert_error(
            "ASSESSMENT_CONTEXT",
            lambda: self.authorize(self.signed(context_command)),
        )

        wrong_evidence = dataclasses.replace(
            assessment(), evidence_refs=("artifact:frame:other",)
        )
        evidence_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=wrong_evidence,
        )
        self.assert_error(
            "ASSESSMENT_EVIDENCE",
            lambda: self.authorize(self.signed(evidence_command)),
        )

    def test_assisted_provenance_requires_trusted_signature_and_safe_reasons(self) -> None:
        exact_assessment = assessment()
        forged_attestation = sign_policy_assessment(
            assessment=exact_assessment,
            assessor_id=self.assessment_key.assessor_id,
            assessment_key_id=self.assessment_key.key_id,
            signed_at_ns=850,
            assessment_private_key=Ed25519PrivateKey.generate(),
        )
        forged_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=exact_assessment,
            signed_assessment_value=forged_attestation,
        )
        self.assert_error(
            "ASSESSMENT_SIGNATURE_INVALID",
            lambda: self.authorize(self.signed(forged_command)),
        )

        # Simulate a corrupted in-process object; the PolicyAssessment constructor
        # also rejects this combination, but the authorization boundary rechecks it.
        capture_gap = assessment()
        object.__setattr__(
            capture_gap,
            "reasons",
            (
                PolicyReason.CAPTURE_GAP,
                PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,
            ),
        )
        capture_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=capture_gap,
        )
        self.assert_error(
            "ASSESSMENT_EXCEPTION",
            lambda: self.authorize(self.signed(capture_command)),
        )

        contradicts = assessment()
        object.__setattr__(
            contradicts,
            "reconciliation_outcome",
            NextServerOutcome.CONTRADICTS,
        )
        object.__setattr__(contradicts, "reconciliation_fingerprint", "d" * 64)
        contradiction_command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=contradicts,
        )
        self.assert_error(
            "ASSESSMENT_RECONCILIATION",
            lambda: self.authorize(self.signed(contradiction_command)),
        )

    def test_changed_assessment_after_signature_is_rejected_as_forged(self) -> None:
        original = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=assessment(),
        )
        signed = self.signed(original)
        changed_assessment = dataclasses.replace(
            assessment(),
            causal_cutoff_timestamp_ns=801,
        )
        changed_signed_assessment = sign_policy_assessment(
            assessment=changed_assessment,
            assessor_id=self.assessment_key.assessor_id,
            assessment_key_id=self.assessment_key.key_id,
            signed_at_ns=850,
            assessment_private_key=self.assessment_private,
        )
        changed_command = dataclasses.replace(
            original,
            assessment=changed_assessment,
            assessment_fingerprint=changed_assessment.fingerprint(),
            signed_assessment=changed_signed_assessment,
        )
        forged = dataclasses.replace(signed, command=changed_command)
        self.assert_error(
            "ACTOR_SIGNATURE_INVALID",
            lambda: self.authorize(forged),
        )

    def test_forged_actor_signature_is_rejected(self) -> None:
        rogue_key = Ed25519PrivateKey.generate()
        self.assert_error(
            "ACTOR_SIGNATURE_INVALID",
            lambda: self.authorize(self.signed(private_key=rogue_key)),
        )

    def test_changed_event_after_signature_is_rejected(self) -> None:
        command = self.command()
        signed = self.signed(command)
        changed_event = point_event(winner=Team.B)
        changed_command = dataclasses.replace(
            command,
            event=changed_event,
            event_fingerprint=changed_event.fingerprint(),
        )
        forged = dataclasses.replace(signed, command=changed_command)
        self.assert_error(
            "ACTOR_SIGNATURE_INVALID",
            lambda: self.authorize(forged),
        )

    def test_expired_command_and_overlong_capability_are_rejected(self) -> None:
        signed = self.signed()
        self.assert_error(
            "COMMAND_EXPIRED",
            lambda: self.authorize(signed, authorized_at_ns=1_051),
        )
        overlong = self.command(expires_at_ns=1_101)
        self.assert_error(
            "COMMAND_LIFETIME",
            lambda: self.authorize(self.signed(overlong)),
        )

    def test_revoked_actor_and_authorizer_keys_are_rejected(self) -> None:
        revoked_actor = dataclasses.replace(self.actor_key, revoked_at_ns=1_010)
        actor_policy = dataclasses.replace(
            self.policy,
            actor_keys=(revoked_actor, self.referee_key, self.admin_key),
        )
        actor_command = self.command(actor_key=revoked_actor, policy=actor_policy)
        self.assert_error(
            "ACTOR_KEY_REVOKED",
            lambda: self.authorize(
                self.signed(actor_command),
                policy=actor_policy,
            ),
        )

    def test_keys_must_be_valid_at_signature_and_authorization_times(self) -> None:
        future_actor = dataclasses.replace(self.actor_key, valid_from_ns=1_001)
        policy = dataclasses.replace(
            self.policy,
            actor_keys=(future_actor, self.referee_key, self.admin_key),
        )
        command = self.command(actor_key=future_actor, policy=policy)
        self.assert_error(
            "ACTOR_KEY_INACTIVE",
            lambda: self.authorize(self.signed(command), policy=policy),
        )

        revoked_authorizer = dataclasses.replace(
            self.authorizer_key,
            revoked_at_ns=1_010,
        )
        authorizer_policy = dataclasses.replace(
            self.policy,
            authorizer_keys=(revoked_authorizer,),
        )
        authorizer_command = self.command(policy=authorizer_policy)
        self.assert_error(
            "AUTHORIZER_KEY_REVOKED",
            lambda: self.authorize(
                self.signed(authorizer_command),
                policy=authorizer_policy,
            ),
        )

    def test_current_archive_revocation_invalidates_historical_envelope(self) -> None:
        envelope = self.authorize(authorized_at_ns=1_020)
        compromised_archive = self.archive_for(
            self.policy,
            revocation_overrides={
                (
                    TrustedKeyKind.ACTOR,
                    self.actor_key.actor_id,
                    self.actor_key.key_id,
                ): 1_025
            },
        )
        self.assert_error(
            "ACTOR_KEY_REVOKED",
            lambda: verify_authorized_rule_event(
                envelope,
                policy_archive=compromised_archive,
                verified_at_ns=1_030,
            ),
        )

    def test_assessment_key_current_revocation_blocks_assisted_origin(self) -> None:
        exact_assessment = assessment()
        command = self.command(
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=exact_assessment,
        )
        revoked_archive = self.archive_for(
            self.policy,
            revocation_overrides={
                (
                    TrustedKeyKind.ASSESSMENT,
                    self.assessment_key.assessor_id,
                    self.assessment_key.key_id,
                ): 840
            },
        )
        self.assert_error(
            "ASSESSMENT_KEY_REVOKED",
            lambda: self.authorize(
                self.signed(command),
                policy_archive=revoked_archive,
            ),
        )

    def test_wrong_role_cannot_authorize_set_seed(self) -> None:
        command = self.command(event=seed_event(), actor_key=self.actor_key)
        self.assert_error(
            "ROLE_FORBIDDEN",
            lambda: self.authorize(self.signed(command)),
        )

        admin_command = self.command(event=seed_event(), actor_key=self.admin_key)
        envelope = self.authorize(
            self.signed(admin_command, self.admin_private),
        )
        self.assertEqual(envelope.event.event_type, RuleEventType.SET_SEED)

    def test_actor_authority_is_cryptographically_scoped_to_one_match(self) -> None:
        other_match_event = dataclasses.replace(point_event(), match_id="match-2")
        command = self.command(event=other_match_event)
        self.assert_error(
            "RESOURCE_SCOPE",
            lambda: self.authorize(self.signed(command)),
        )

    def test_stale_expected_revision_is_rejected(self) -> None:
        stale = self.command(expected_revision=0)
        self.assert_error(
            "STALE_REVISION",
            lambda: self.authorize(self.signed(stale)),
        )

    def test_unretained_policy_is_rejected(self) -> None:
        different = dataclasses.replace(self.policy, policy_id="other-policy")
        envelope = self.authorize()
        self.assert_error(
            "POLICY_UNTRUSTED",
            lambda: verify_authorized_rule_event(
                envelope,
                policy_archive=self.archive_for(different),
                verified_at_ns=1_030,
            ),
        )
        self.assert_error(
            "POLICY_ARCHIVE_STALE",
            lambda: verify_authorized_rule_event(
                envelope,
                policy_archive=self.archive,
                verified_at_ns=100_001,
            ),
        )

    def test_rotation_and_historical_policy_expiry_do_not_break_replay(self) -> None:
        envelope = self.authorize()
        rotated = dataclasses.replace(
            self.policy,
            policy_id="authorization-policy-v2",
            valid_from_ns=100_001,
            valid_until_ns=200_000,
        )
        archive = self.archive_for(
            rotated,
            historical_policies=(self.policy,),
        )

        self.assertEqual(
            verify_authorized_rule_event(
                envelope,
                policy_archive=archive,
                verified_at_ns=150_000,
            ),
            point_event(),
        )
        self.assertNotEqual(self.archive.fingerprint(), archive.fingerprint())
        old_command = self.command(policy=self.policy)
        self.assert_error(
            "POLICY_MISMATCH",
            lambda: self.authorize(
                self.signed(old_command),
                policy_archive=archive,
            ),
        )

    def test_archive_prevents_revocation_laundering_by_key_rename(self) -> None:
        renamed_same_key = dataclasses.replace(
            self.actor_key,
            actor_id="human-scorekeeper-renamed",
            key_id="actor-key-renamed",
        )
        rotated = dataclasses.replace(
            self.policy,
            policy_id="authorization-policy-renamed-key",
            actor_keys=(renamed_same_key, self.referee_key, self.admin_key),
        )
        with self.assertRaisesRegex(ValueError, "reintroduced"):
            self.archive_for(rotated, historical_policies=(self.policy,))

    def test_verification_rejects_authorization_from_the_future(self) -> None:
        envelope = self.authorize(authorized_at_ns=1_020)
        for verified_at_ns in (999, 1_000, 1_010, 1_019):
            with self.subTest(verified_at_ns=verified_at_ns):
                self.assert_error(
                    "FUTURE_AUTHORIZATION",
                    lambda verified_at_ns=verified_at_ns: (
                        verify_authorized_rule_event(
                            envelope,
                            policy_archive=self.archive,
                            verified_at_ns=verified_at_ns,
                        )
                    ),
                )

    def test_forged_authorizer_and_wrong_private_key_are_rejected(self) -> None:
        self.assert_error(
            "AUTHORIZER_PRIVATE_KEY_MISMATCH",
            lambda: self.authorize(private_key=Ed25519PrivateKey.generate()),
        )
        envelope = self.authorize()
        forged = dataclasses.replace(
            envelope,
            authorizer_signature_base64=base64.b64encode(b"\x00" * 64).decode(
                "ascii"
            ),
        )
        self.assert_error(
            "AUTHORIZER_SIGNATURE_INVALID",
            lambda: verify_authorized_rule_event(
                forged,
                policy_archive=self.archive,
                verified_at_ns=1_030,
            ),
        )

    def test_persisted_codec_rejects_duplicate_noncanonical_and_exact_field_changes(self) -> None:
        encoded = encode_authorized_rule_event(self.authorize())
        duplicate = encoded.replace(
            b'"schema_version":"1.0"',
            b'"schema_version":"1.0","schema_version":"1.0"',
            1,
        )
        self.assert_error(
            "DUPLICATE_KEY",
            lambda: parse_authorized_rule_event(duplicate),
        )
        self.assert_error(
            "NON_CANONICAL",
            lambda: parse_authorized_rule_event(b" " + encoded),
        )

        decoded = json.loads(encoded)
        decoded["unexpected"] = None
        extra = json.dumps(
            decoded,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        self.assert_error(
            "FIELD_SET",
            lambda: parse_authorized_rule_event(extra),
        )

    def test_persisted_codec_rejects_floats_depth_size_and_event_tampering(self) -> None:
        encoded = encode_authorized_rule_event(self.authorize())
        float_value = encoded.replace(
            b'"authorized_at_ns":1020',
            b'"authorized_at_ns":1020.0',
            1,
        )
        self.assert_error(
            "JSON_NUMBER",
            lambda: parse_authorized_rule_event(float_value),
        )
        self.assert_error(
            "JSON_DEPTH",
            lambda: parse_authorized_rule_event(b"[" * 40 + b"0" + b"]" * 40),
        )
        self.assert_error(
            "RAW_SIZE",
            lambda: parse_authorized_rule_event(b"x" * (MAX_AUTHORIZATION_BYTES + 1)),
        )

        decoded = json.loads(encoded)
        decoded["event"]["payload"]["winner_team"] = "B"
        tampered = json.dumps(
            decoded,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        self.assert_error(
            "EVENT_MISMATCH",
            lambda: parse_authorized_rule_event(tampered),
        )

    def test_structures_are_frozen_bounded_and_have_no_service_principal(self) -> None:
        envelope = self.authorize()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            envelope.event = seed_event()  # type: ignore[misc]
        self.assertEqual(set(ROLE_EVENT_ALLOWLISTS), set(PrincipalRole))
        self.assertEqual(
            ROLE_EVENT_ALLOWLISTS[PrincipalRole.MATCH_ADMIN],
            frozenset({RuleEventType.SET_SEED}),
        )
        self.assertFalse(hasattr(PrincipalRole, "SERVICE"))
        for contract in (
            AuthorizationCommand,
            AuthorizationPolicy,
            AuthorizationPolicyArchive,
            AuthorizedRuleEvent,
            SignedPolicyAssessment,
            TrustedActorKey,
            TrustedAssessmentKey,
            TrustedAuthorizerKey,
        ):
            fields = {field.name for field in dataclasses.fields(contract)}
            self.assertFalse(
                {"private_key", "actor_private_key", "authorizer_private_key"}
                & fields
            )


if __name__ == "__main__":
    unittest.main()
