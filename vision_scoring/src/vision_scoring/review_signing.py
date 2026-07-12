"""Domain-separated signatures for non-authoritative scorer-copilot review.

Review signatures provide attribution and tamper evidence only.  They are
verified against match-scoped human keys already retained by the protected
``AuthorizationPolicyArchive``, but no function in this module constructs a
rule event, authorization command, authorized envelope, or score transition.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authorization import (
    AuthorizationError,
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    PrincipalRole,
    SignedPolicyAssessment,
    TrustedActorKey,
    TrustedKeyKind,
    verify_signed_policy_assessment,
)
from .domain_events import MAX_SEQUENCE_NUMBER
from .policy import PolicyAssessment
from .review_contracts import (
    MAX_ADJUDICATED_DISPOSITIONS,
    MAX_REVIEW_RECORD_BYTES,
    REVIEW_SCHEMA_VERSION,
    ReviewAdjudication,
    ReviewDisposition,
    ScorerCopilotCase,
    SignedReviewAdjudication,
    SignedReviewDisposition,
)


_REVIEW_SIGNING_DOMAIN = (
    b"multicourt-vision-scoring:scorer-copilot-review:v1\x00"
)
_ADJUDICATION_SIGNING_DOMAIN = (
    b"multicourt-vision-scoring:scorer-copilot-adjudication:v1\x00"
)
_REVIEW_ROLES = frozenset({PrincipalRole.SCOREKEEPER, PrincipalRole.REFEREE})
_ADJUDICATION_ROLES = frozenset({PrincipalRole.REFEREE})


class ReviewSignatureError(ValueError):
    """A signature/trust failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise ReviewSignatureError(code, message)


def _timestamp(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(f"{field_name} must be a non-negative signed 64-bit integer")
    return value


def _canonical_json_bytes(value: Mapping[str, Any], label: str) -> bytes:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if len(encoded) > MAX_REVIEW_RECORD_BYTES:
        raise ValueError(f"{label} exceeds {MAX_REVIEW_RECORD_BYTES} bytes")
    return encoded


def _review_message(value: Mapping[str, Any]) -> bytes:
    return _REVIEW_SIGNING_DOMAIN + _canonical_json_bytes(
        value, "review attestation"
    )


def _adjudication_message(value: Mapping[str, Any]) -> bytes:
    return _ADJUDICATION_SIGNING_DOMAIN + _canonical_json_bytes(
        value, "adjudication attestation"
    )


def _policy_from_archive(
    archive: AuthorizationPolicyArchive,
    fingerprint: str,
) -> AuthorizationPolicy:
    try:
        return archive.resolve_policy(fingerprint)
    except AuthorizationError as exc:
        raise ReviewSignatureError(
            "POLICY_UNTRUSTED",
            "review signature policy is not retained by the protected archive",
        ) from exc


def _actor_key(
    policy: AuthorizationPolicy,
    *,
    actor_id: str,
    actor_key_id: str,
    actor_role: PrincipalRole,
) -> TrustedActorKey:
    matches = tuple(
        key
        for key in policy.actor_keys
        if key.actor_id == actor_id
        and key.key_id == actor_key_id
        and key.role is actor_role
    )
    if len(matches) != 1:
        _fail(
            "ACTOR_KEY_UNTRUSTED",
            "review actor key is not retained in the bound policy generation",
        )
    return matches[0]


def _public_key_sha256(key: TrustedActorKey) -> str:
    return hashlib.sha256(base64.b64decode(key.public_key_base64)).hexdigest()


def _check_archive_revocation(
    archive: AuthorizationPolicyArchive,
    key: TrustedActorKey,
    *,
    revoked_as_of_ns: int,
) -> None:
    public_fingerprint = _public_key_sha256(key)
    matches = tuple(
        status
        for status in archive.key_revocations
        if status.key_kind is TrustedKeyKind.ACTOR
        and status.principal_id == key.actor_id
        and status.key_id == key.key_id
        and status.public_key_sha256 == public_fingerprint
    )
    if len(matches) != 1:
        _fail(
            "ACTOR_KEY_STATUS_MISSING",
            "review actor key lacks exact current revocation status",
        )
    revoked_at_ns = matches[0].revoked_at_ns
    if revoked_at_ns is not None and revoked_at_ns <= revoked_as_of_ns:
        _fail("ACTOR_KEY_REVOKED", "review actor key is currently revoked")


def _check_key_use(
    archive: AuthorizationPolicyArchive,
    policy: AuthorizationPolicy,
    key: TrustedActorKey,
    *,
    signed_at_ns: int,
    revoked_as_of_ns: int,
) -> None:
    if not policy.is_active(signed_at_ns):
        _fail("POLICY_INACTIVE", "review policy was not active when signed")
    if not key.valid_from_ns <= signed_at_ns <= key.valid_until_ns:
        _fail("ACTOR_KEY_INACTIVE", "review actor key was not active when signed")
    if key.revoked_at_ns is not None and key.revoked_at_ns <= revoked_as_of_ns:
        _fail("ACTOR_KEY_REVOKED", "review actor key is revoked")
    _check_archive_revocation(
        archive,
        key,
        revoked_as_of_ns=revoked_as_of_ns,
    )


def _check_scope(
    *,
    case: ScorerCopilotCase,
    archive: AuthorizationPolicyArchive,
    policy: AuthorizationPolicy,
    trust_domain_id: str,
) -> None:
    if (
        archive.match_id != case.match_id
        or policy.match_id != case.match_id
        or archive.trust_domain_id != trust_domain_id
        or policy.trust_domain_id != trust_domain_id
    ):
        _fail(
            "REVIEW_SCOPE_MISMATCH",
            "review signature scope does not match the exact scorer-copilot case",
        )


def _signing_actor(
    *,
    case: ScorerCopilotCase,
    archive: AuthorizationPolicyArchive,
    actor_id: str,
    actor_key_id: str,
    actor_role: PrincipalRole,
    signed_at_ns: int,
    allowed_roles: frozenset[PrincipalRole],
) -> tuple[AuthorizationPolicy, TrustedActorKey]:
    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    if type(archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be an exact AuthorizationPolicyArchive")
    if type(actor_role) is not PrincipalRole:
        raise ValueError("actor_role must be a PrincipalRole")
    if actor_role not in allowed_roles:
        _fail("ROLE_FORBIDDEN", "actor role cannot sign this review record")
    signed_at_ns = _timestamp(signed_at_ns, "signed_at_ns")
    if signed_at_ns < case.opened_at_ns:
        _fail("REVIEW_TIME", "review cannot be signed before the case was opened")
    policy = archive.current_policy
    _check_scope(
        case=case,
        archive=archive,
        policy=policy,
        trust_domain_id=archive.trust_domain_id,
    )
    key = _actor_key(
        policy,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
    )
    _check_key_use(
        archive,
        policy,
        key,
        signed_at_ns=signed_at_ns,
        revoked_as_of_ns=signed_at_ns,
    )
    return policy, key


def sign_review_disposition(
    *,
    disposition: ReviewDisposition,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    actor_id: str,
    actor_key_id: str,
    actor_role: PrincipalRole,
    signed_at_ns: int,
    actor_private_key: Ed25519PrivateKey,
) -> SignedReviewDisposition:
    """Sign advisory review metadata without creating score authority."""

    if type(disposition) is not ReviewDisposition:
        raise ValueError("disposition must be an exact ReviewDisposition")
    if disposition.case_fingerprint != case.fingerprint():
        raise ValueError("disposition does not bind the exact case")
    if not isinstance(actor_private_key, Ed25519PrivateKey):
        raise ValueError("actor_private_key must be Ed25519PrivateKey")
    policy, key = _signing_actor(
        case=case,
        archive=policy_archive,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        signed_at_ns=signed_at_ns,
        allowed_roles=_REVIEW_ROLES,
    )
    fingerprint = disposition.fingerprint()
    attestation = SignedReviewDisposition.attestation_dict(
        disposition=disposition,
        disposition_fingerprint=fingerprint,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
    )
    signature = actor_private_key.sign(_review_message(attestation))
    try:
        key.public_key.verify(signature, _review_message(attestation))
    except InvalidSignature as exc:
        raise ReviewSignatureError(
            "PRIVATE_KEY_MISMATCH",
            "private key does not match the protected review actor key",
        ) from exc
    return SignedReviewDisposition(
        disposition=disposition,
        disposition_fingerprint=fingerprint,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def verify_signed_review_disposition(
    signed: SignedReviewDisposition,
    *,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
) -> ReviewDisposition:
    """Verify attribution and current revocation without granting authority."""

    if type(signed) is not SignedReviewDisposition:
        _fail("SIGNED_TYPE", "signed review disposition must be exact")
    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be an exact AuthorizationPolicyArchive")
    verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
    if verified_at_ns < signed.signed_at_ns:
        _fail("FUTURE_SIGNATURE", "review cannot be verified before it was signed")
    if signed.signed_at_ns < case.opened_at_ns:
        _fail("REVIEW_TIME", "review was signed before the case was opened")
    if signed.actor_role not in _REVIEW_ROLES:
        _fail("ROLE_FORBIDDEN", "actor role cannot sign review dispositions")
    if signed.disposition.case_fingerprint != case.fingerprint():
        _fail("CASE_MISMATCH", "signed review does not bind the exact case")
    if not policy_archive.current_policy.is_active(verified_at_ns):
        _fail(
            "POLICY_ARCHIVE_STALE",
            "protected archive has no current policy active at verification time",
        )
    policy = _policy_from_archive(policy_archive, signed.policy_fingerprint)
    _check_scope(
        case=case,
        archive=policy_archive,
        policy=policy,
        trust_domain_id=signed.trust_domain_id,
    )
    key = _actor_key(
        policy,
        actor_id=signed.actor_id,
        actor_key_id=signed.actor_key_id,
        actor_role=signed.actor_role,
    )
    _check_key_use(
        policy_archive,
        policy,
        key,
        signed_at_ns=signed.signed_at_ns,
        revoked_as_of_ns=verified_at_ns,
    )
    try:
        key.public_key.verify(
            base64.b64decode(signed.signature_base64, validate=True),
            _review_message(signed.unsigned_canonical_dict()),
        )
    except (InvalidSignature, ValueError) as exc:
        raise ReviewSignatureError(
            "SIGNATURE_INVALID", "review disposition signature is invalid"
        ) from exc
    return signed.disposition


def verify_case_policy_assessment(
    case: ScorerCopilotCase,
    *,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
) -> PolicyAssessment | None:
    """Verify a present assessment attestation; absence remains human-direct only."""

    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
    if verified_at_ns < case.opened_at_ns:
        _fail("CASE_ADMISSION_TIME", "case cannot be admitted before it was opened")
    signed_assessment = case.signed_assessment
    if signed_assessment is None:
        return None
    if type(signed_assessment) is not SignedPolicyAssessment:
        raise ValueError("case signed_assessment must be exact")
    return verify_signed_policy_assessment(
        signed_assessment,
        assessment=case.assessment,
        policy_archive=policy_archive,
        verified_at_ns=verified_at_ns,
    )


def _verify_considered_signed_dispositions(
    *,
    adjudication: ReviewAdjudication,
    considered_signed_dispositions: tuple[SignedReviewDisposition, ...],
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    adjudicated_at_ns: int,
    verified_at_ns: int,
) -> None:
    if (
        type(considered_signed_dispositions) is not tuple
        or not 1
        <= len(considered_signed_dispositions)
        <= MAX_ADJUDICATED_DISPOSITIONS
        or any(
            type(disposition) is not SignedReviewDisposition
            for disposition in considered_signed_dispositions
        )
    ):
        raise ValueError(
            "considered_signed_dispositions must be a bounded nonempty exact tuple"
        )
    fingerprints = tuple(
        sorted(disposition.fingerprint() for disposition in considered_signed_dispositions)
    )
    if len(set(fingerprints)) != len(fingerprints):
        _fail(
            "ADJUDICATION_DISPOSITIONS",
            "adjudication cannot consider duplicate signed dispositions",
        )
    if fingerprints != adjudication.considered_signed_disposition_fingerprints:
        _fail(
            "ADJUDICATION_DISPOSITIONS",
            "adjudication does not bind the exact considered signed dispositions",
        )
    for disposition in considered_signed_dispositions:
        if disposition.signed_at_ns > adjudicated_at_ns:
            _fail(
                "ADJUDICATION_TIME",
                "adjudication cannot predate a considered signed disposition",
            )
        verify_signed_review_disposition(
            disposition,
            case=case,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
        )


def sign_review_adjudication(
    *,
    adjudication: ReviewAdjudication,
    considered_signed_dispositions: tuple[SignedReviewDisposition, ...],
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    actor_id: str,
    actor_key_id: str,
    actor_role: PrincipalRole,
    signed_at_ns: int,
    actor_private_key: Ed25519PrivateKey,
) -> SignedReviewAdjudication:
    """Sign an advisory adjudication; only a referee key is eligible."""

    if type(adjudication) is not ReviewAdjudication:
        raise ValueError("adjudication must be an exact ReviewAdjudication")
    if adjudication.case_fingerprint != case.fingerprint():
        raise ValueError("adjudication does not bind the exact case")
    if not isinstance(actor_private_key, Ed25519PrivateKey):
        raise ValueError("actor_private_key must be Ed25519PrivateKey")
    signed_at_ns = _timestamp(signed_at_ns, "signed_at_ns")
    policy, key = _signing_actor(
        case=case,
        archive=policy_archive,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        signed_at_ns=signed_at_ns,
        allowed_roles=_ADJUDICATION_ROLES,
    )
    _verify_considered_signed_dispositions(
        adjudication=adjudication,
        considered_signed_dispositions=considered_signed_dispositions,
        case=case,
        policy_archive=policy_archive,
        adjudicated_at_ns=signed_at_ns,
        verified_at_ns=signed_at_ns,
    )
    fingerprint = adjudication.fingerprint()
    attestation = SignedReviewAdjudication.attestation_dict(
        adjudication=adjudication,
        adjudication_fingerprint=fingerprint,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
    )
    signature = actor_private_key.sign(_adjudication_message(attestation))
    try:
        key.public_key.verify(signature, _adjudication_message(attestation))
    except InvalidSignature as exc:
        raise ReviewSignatureError(
            "PRIVATE_KEY_MISMATCH",
            "private key does not match the protected adjudicator key",
        ) from exc
    return SignedReviewAdjudication(
        adjudication=adjudication,
        adjudication_fingerprint=fingerprint,
        actor_id=actor_id,
        actor_key_id=actor_key_id,
        actor_role=actor_role,
        policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def verify_signed_review_adjudication(
    signed: SignedReviewAdjudication,
    *,
    considered_signed_dispositions: tuple[SignedReviewDisposition, ...],
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
) -> ReviewAdjudication:
    """Verify a referee adjudication without converting it into authorization."""

    if type(signed) is not SignedReviewAdjudication:
        _fail("SIGNED_TYPE", "signed review adjudication must be exact")
    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be an exact AuthorizationPolicyArchive")
    verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
    if verified_at_ns < signed.signed_at_ns:
        _fail("FUTURE_SIGNATURE", "adjudication cannot be verified before signing")
    if signed.signed_at_ns < case.opened_at_ns:
        _fail("REVIEW_TIME", "adjudication was signed before the case was opened")
    if signed.actor_role not in _ADJUDICATION_ROLES:
        _fail("ROLE_FORBIDDEN", "only a referee may sign adjudication")
    if signed.adjudication.case_fingerprint != case.fingerprint():
        _fail("CASE_MISMATCH", "signed adjudication does not bind the exact case")
    if not policy_archive.current_policy.is_active(verified_at_ns):
        _fail(
            "POLICY_ARCHIVE_STALE",
            "protected archive has no current policy active at verification time",
        )
    policy = _policy_from_archive(policy_archive, signed.policy_fingerprint)
    _check_scope(
        case=case,
        archive=policy_archive,
        policy=policy,
        trust_domain_id=signed.trust_domain_id,
    )
    key = _actor_key(
        policy,
        actor_id=signed.actor_id,
        actor_key_id=signed.actor_key_id,
        actor_role=signed.actor_role,
    )
    _check_key_use(
        policy_archive,
        policy,
        key,
        signed_at_ns=signed.signed_at_ns,
        revoked_as_of_ns=verified_at_ns,
    )
    try:
        key.public_key.verify(
            base64.b64decode(signed.signature_base64, validate=True),
            _adjudication_message(signed.unsigned_canonical_dict()),
        )
    except (InvalidSignature, ValueError) as exc:
        raise ReviewSignatureError(
            "SIGNATURE_INVALID", "review adjudication signature is invalid"
        ) from exc
    _verify_considered_signed_dispositions(
        adjudication=signed.adjudication,
        considered_signed_dispositions=considered_signed_dispositions,
        case=case,
        policy_archive=policy_archive,
        adjudicated_at_ns=signed.signed_at_ns,
        verified_at_ns=verified_at_ns,
    )
    return signed.adjudication


__all__ = [
    "ReviewSignatureError",
    "sign_review_adjudication",
    "sign_review_disposition",
    "verify_case_policy_assessment",
    "verify_signed_review_adjudication",
    "verify_signed_review_disposition",
]
