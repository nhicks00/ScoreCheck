"""Human-only Ed25519 authorization boundary for typed rule events.

This module deliberately keeps model policy assessment, human authorization,
and event mutation as separate objects.  A :class:`PolicyAssessment` can only
recommend an intent.  A trusted human signs an exact ``AuthorizationCommand``;
an authorizer verifies that command and countersigns an immutable envelope.

Private keys are accepted only as transient function arguments.  Persisted
objects contain public keys and detached signatures, never private key material.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .domain_events import (
    MAX_SEQUENCE_NUMBER,
    PointAwardedPayload,
    ReplayNoPointPayload,
    RuleEvent,
    RuleEventType,
    Team,
    encode_rule_event,
    parse_rule_event,
    rule_event_to_dict,
)
from .policy import (
    PolicyAssessment,
    PolicyAssessmentStatus,
    PolicyReason,
    ScoringIntent,
    ScoringIntentKind,
)
from .reconciliation import NextServerOutcome


AUTHORIZATION_SCHEMA_VERSION = "1.0"
MAX_AUTHORIZATION_BYTES = 512 * 1024
MAX_AUTHORIZATION_JSON_DEPTH = 32
MAX_POLICY_KEYS = 128
MAX_ASSESSMENT_POLICY_FINGERPRINTS = 128
MAX_ID_LENGTH = 128
MAX_NONCE_LENGTH = 128
MIN_NONCE_LENGTH = 16
MAX_COMMAND_LIFETIME_NS = 5 * 60 * 1_000_000_000

_ACTOR_SIGNING_DOMAIN = b"multicourt-vision-scoring:actor-authorization-command:v1\x00"
_ASSESSMENT_SIGNING_DOMAIN = (
    b"multicourt-vision-scoring:policy-assessment-attestation:v1\x00"
)
_AUTHORIZER_SIGNING_DOMAIN = b"multicourt-vision-scoring:authorized-rule-event:v1\x00"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")


class AuthorizationError(ValueError):
    """A fail-closed authorization error with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class PrincipalRole(str, Enum):
    SCOREKEEPER = "SCOREKEEPER"
    REFEREE = "REFEREE"
    MATCH_ADMIN = "MATCH_ADMIN"


class AuthorizationOrigin(str, Enum):
    HUMAN_DIRECT = "HUMAN_DIRECT"
    ASSESSMENT_ASSISTED = "ASSESSMENT_ASSISTED"


class TrustedKeyKind(str, Enum):
    ACTOR = "ACTOR"
    ASSESSMENT = "ASSESSMENT"
    AUTHORIZER = "AUTHORIZER"


# Fixed least-privilege grants.  They are included in every policy fingerprint,
# but are not supplied by untrusted callers and therefore cannot be expanded by
# configuration.  In particular, no service/model principal exists here.
ROLE_EVENT_ALLOWLISTS: Mapping[PrincipalRole, frozenset[RuleEventType]] = (
    MappingProxyType(
        {
            PrincipalRole.SCOREKEEPER: frozenset(
                {
                    RuleEventType.POINT_AWARDED,
                    RuleEventType.REPLAY_NO_POINT,
                    RuleEventType.SIDE_SWITCH_CONFIRMED,
                    RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                }
            ),
            PrincipalRole.REFEREE: frozenset(
                {
                    RuleEventType.POINT_AWARDED,
                    RuleEventType.REPLAY_NO_POINT,
                    RuleEventType.SIDE_SWITCH_CONFIRMED,
                    RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                }
            ),
            PrincipalRole.MATCH_ADMIN: frozenset(
                {
                    RuleEventType.SET_SEED,
                }
            ),
        }
    )
)


def _fail(code: str, message: str) -> None:
    raise AuthorizationError(code, message)


def _stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _printable_ascii(
    value: object,
    field_name: str,
    *,
    minimum: int = 1,
    maximum: int = MAX_ID_LENGTH,
) -> str:
    if (
        type(value) is not str
        or not minimum <= len(value) <= maximum
        or value != value.strip()
        or not value.isascii()
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        raise ValueError(
            f"{field_name} must contain {minimum}..{maximum} printable ASCII characters"
        )
    return value


def _sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(f"{field_name} must be a non-negative signed 64-bit integer")
    return value


def _canonical_base64(
    value: object,
    field_name: str,
    *,
    expected_bytes: int,
) -> bytes:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if (
        len(raw) != expected_bytes
        or base64.b64encode(raw).decode("ascii") != value
    ):
        raise ValueError(
            f"{field_name} must be canonical base64 for {expected_bytes} bytes"
        )
    return raw


def _canonical_json_bytes(
    value: Mapping[str, Any],
    *,
    maximum: int,
    label: str,
) -> bytes:
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
    if len(encoded) > maximum:
        raise ValueError(f"{label} exceeds {maximum} bytes")
    return encoded


def _fingerprint(value: Mapping[str, Any], *, label: str) -> str:
    return hashlib.sha256(
        _canonical_json_bytes(value, maximum=MAX_AUTHORIZATION_BYTES, label=label)
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class TrustedActorKey:
    actor_id: str
    key_id: str
    role: PrincipalRole
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None = None

    def __post_init__(self) -> None:
        _stable_id(self.actor_id, "actor_id")
        _stable_id(self.key_id, "key_id")
        if not isinstance(self.role, PrincipalRole):
            raise ValueError("role must be a PrincipalRole")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _timestamp(self.valid_from_ns, "valid_from_ns")
        valid_until = _timestamp(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if self.revoked_at_ns is not None:
            revoked_at = _timestamp(self.revoked_at_ns, "revoked_at_ns")
            if revoked_at < valid_from:
                raise ValueError("revoked_at_ns cannot precede valid_from_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "actor_id": self.actor_id,
            "key_id": self.key_id,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "role": self.role.value,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="trusted actor key")


@dataclass(frozen=True, slots=True)
class TrustedAuthorizerKey:
    authorizer_id: str
    key_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None = None

    def __post_init__(self) -> None:
        _stable_id(self.authorizer_id, "authorizer_id")
        _stable_id(self.key_id, "key_id")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _timestamp(self.valid_from_ns, "valid_from_ns")
        valid_until = _timestamp(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if self.revoked_at_ns is not None:
            revoked_at = _timestamp(self.revoked_at_ns, "revoked_at_ns")
            if revoked_at < valid_from:
                raise ValueError("revoked_at_ns cannot precede valid_from_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "authorizer_id": self.authorizer_id,
            "key_id": self.key_id,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="trusted authorizer key")


@dataclass(frozen=True, slots=True)
class TrustedAssessmentKey:
    assessor_id: str
    key_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None = None

    def __post_init__(self) -> None:
        _stable_id(self.assessor_id, "assessor_id")
        _stable_id(self.key_id, "key_id")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _timestamp(self.valid_from_ns, "valid_from_ns")
        valid_until = _timestamp(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if self.revoked_at_ns is not None:
            revoked_at = _timestamp(self.revoked_at_ns, "revoked_at_ns")
            if revoked_at < valid_from:
                raise ValueError("revoked_at_ns cannot precede valid_from_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "assessor_id": self.assessor_id,
            "key_id": self.key_id,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="trusted assessment key")


def _role_allowlists_wire() -> list[dict[str, object]]:
    return [
        {
            "event_types": sorted(
                event_type.value for event_type in ROLE_EVENT_ALLOWLISTS[role]
            ),
            "role": role.value,
        }
        for role in sorted(PrincipalRole, key=lambda item: item.value)
    ]


@dataclass(frozen=True, slots=True)
class AuthorizationPolicy:
    """Protected policy containing the complete current human/key trust root."""

    policy_id: str
    trust_domain_id: str
    match_id: str
    valid_from_ns: int
    valid_until_ns: int
    max_command_lifetime_ns: int
    accepted_assessment_policy_fingerprints: tuple[str, ...]
    actor_keys: tuple[TrustedActorKey, ...]
    assessment_keys: tuple[TrustedAssessmentKey, ...]
    authorizer_keys: tuple[TrustedAuthorizerKey, ...]
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported authorization policy schema")
        _stable_id(self.policy_id, "policy_id")
        _stable_id(self.trust_domain_id, "trust_domain_id")
        _stable_id(self.match_id, "match_id")
        valid_from = _timestamp(self.valid_from_ns, "valid_from_ns")
        valid_until = _timestamp(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if (
            type(self.max_command_lifetime_ns) is not int
            or not 1
            <= self.max_command_lifetime_ns
            <= MAX_COMMAND_LIFETIME_NS
        ):
            raise ValueError(
                "max_command_lifetime_ns must be in "
                f"[1, {MAX_COMMAND_LIFETIME_NS}]"
            )
        if (
            type(self.accepted_assessment_policy_fingerprints) is not tuple
            or len(self.accepted_assessment_policy_fingerprints)
            > MAX_ASSESSMENT_POLICY_FINGERPRINTS
        ):
            raise ValueError(
                "accepted_assessment_policy_fingerprints must be a bounded tuple"
            )
        for fingerprint in self.accepted_assessment_policy_fingerprints:
            _sha256(fingerprint, "accepted assessment policy fingerprint")
        if len(set(self.accepted_assessment_policy_fingerprints)) != len(
            self.accepted_assessment_policy_fingerprints
        ):
            raise ValueError(
                "accepted assessment policy fingerprints must be unique"
            )
        object.__setattr__(
            self,
            "accepted_assessment_policy_fingerprints",
            tuple(sorted(self.accepted_assessment_policy_fingerprints)),
        )
        if (
            type(self.actor_keys) is not tuple
            or not self.actor_keys
            or len(self.actor_keys) > MAX_POLICY_KEYS
            or any(type(key) is not TrustedActorKey for key in self.actor_keys)
        ):
            raise ValueError(
                f"actor_keys must contain 1..{MAX_POLICY_KEYS} trusted actor keys"
            )
        if (
            type(self.authorizer_keys) is not tuple
            or not self.authorizer_keys
            or len(self.authorizer_keys) > MAX_POLICY_KEYS
            or any(
                type(key) is not TrustedAuthorizerKey
                for key in self.authorizer_keys
            )
        ):
            raise ValueError(
                "authorizer_keys must contain "
                f"1..{MAX_POLICY_KEYS} trusted authorizer keys"
            )
        if (
            type(self.assessment_keys) is not tuple
            or len(self.assessment_keys) > MAX_POLICY_KEYS
            or any(
                type(key) is not TrustedAssessmentKey
                for key in self.assessment_keys
            )
        ):
            raise ValueError(
                f"assessment_keys must contain 0..{MAX_POLICY_KEYS} trusted keys"
            )
        if (
            self.accepted_assessment_policy_fingerprints
            and not self.assessment_keys
        ):
            raise ValueError(
                "accepted assessment policies require trusted assessment keys"
            )
        actor_pairs = [(key.actor_id, key.key_id) for key in self.actor_keys]
        assessment_pairs = [
            (key.assessor_id, key.key_id) for key in self.assessment_keys
        ]
        authorizer_pairs = [
            (key.authorizer_id, key.key_id) for key in self.authorizer_keys
        ]
        if len(set(actor_pairs)) != len(actor_pairs):
            raise ValueError("actor key identities must be unique")
        if len(set(assessment_pairs)) != len(assessment_pairs):
            raise ValueError("assessment key identities must be unique")
        if len(set(authorizer_pairs)) != len(authorizer_pairs):
            raise ValueError("authorizer key identities must be unique")
        public_keys = (
            [key.public_key_base64 for key in self.actor_keys]
            + [key.public_key_base64 for key in self.assessment_keys]
            + [key.public_key_base64 for key in self.authorizer_keys]
        )
        if len(set(public_keys)) != len(public_keys):
            raise ValueError("one public key cannot serve multiple trust records")
        actor_ids = {key.actor_id for key in self.actor_keys}
        assessor_ids = {key.assessor_id for key in self.assessment_keys}
        authorizer_ids = {key.authorizer_id for key in self.authorizer_keys}
        if (actor_ids & authorizer_ids) or (actor_ids & assessor_ids) or (
            assessor_ids & authorizer_ids
        ):
            raise ValueError("actor, assessor, and authorizer identities must be disjoint")
        object.__setattr__(
            self,
            "actor_keys",
            tuple(sorted(self.actor_keys, key=lambda key: (key.actor_id, key.key_id))),
        )
        object.__setattr__(
            self,
            "assessment_keys",
            tuple(
                sorted(
                    self.assessment_keys,
                    key=lambda key: (key.assessor_id, key.key_id),
                )
            ),
        )
        object.__setattr__(
            self,
            "authorizer_keys",
            tuple(
                sorted(
                    self.authorizer_keys,
                    key=lambda key: (key.authorizer_id, key.key_id),
                )
            ),
        )
        _canonical_json_bytes(
            self.canonical_dict(), maximum=MAX_AUTHORIZATION_BYTES, label="policy"
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "accepted_assessment_policy_fingerprints": list(
                self.accepted_assessment_policy_fingerprints
            ),
            "actor_keys": [key.canonical_dict() for key in self.actor_keys],
            "assessment_keys": [
                key.canonical_dict() for key in self.assessment_keys
            ],
            "authorizer_keys": [
                key.canonical_dict() for key in self.authorizer_keys
            ],
            "max_command_lifetime_ns": self.max_command_lifetime_ns,
            "match_id": self.match_id,
            "policy_id": self.policy_id,
            "role_event_allowlists": _role_allowlists_wire(),
            "schema_version": self.schema_version,
            "trust_domain_id": self.trust_domain_id,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="authorization policy")

    def is_active(self, at_ns: int) -> bool:
        _timestamp(at_ns, "at_ns")
        return self.valid_from_ns <= at_ns <= self.valid_until_ns


def _public_key_sha256(
    key: TrustedActorKey | TrustedAssessmentKey | TrustedAuthorizerKey,
) -> str:
    return hashlib.sha256(
        _canonical_base64(
            key.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class KeyRevocationStatus:
    """Current revocation status for one immutable key identity/material pair."""

    key_kind: TrustedKeyKind
    principal_id: str
    key_id: str
    public_key_sha256: str
    revoked_at_ns: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.key_kind, TrustedKeyKind):
            raise ValueError("key_kind must be a TrustedKeyKind")
        _stable_id(self.principal_id, "principal_id")
        _stable_id(self.key_id, "key_id")
        _sha256(self.public_key_sha256, "public_key_sha256")
        if self.revoked_at_ns is not None:
            _timestamp(self.revoked_at_ns, "revoked_at_ns")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "key_id": self.key_id,
            "key_kind": self.key_kind.value,
            "principal_id": self.principal_id,
            "public_key_sha256": self.public_key_sha256,
            "revoked_at_ns": self.revoked_at_ns,
        }


def _key_identity(
    key: TrustedActorKey | TrustedAssessmentKey | TrustedAuthorizerKey,
) -> tuple[TrustedKeyKind, str, str, str]:
    if type(key) is TrustedActorKey:
        return (
            TrustedKeyKind.ACTOR,
            key.actor_id,
            key.key_id,
            _public_key_sha256(key),
        )
    if type(key) is TrustedAssessmentKey:
        return (
            TrustedKeyKind.ASSESSMENT,
            key.assessor_id,
            key.key_id,
            _public_key_sha256(key),
        )
    if type(key) is TrustedAuthorizerKey:
        return (
            TrustedKeyKind.AUTHORIZER,
            key.authorizer_id,
            key.key_id,
            _public_key_sha256(key),
        )
    raise ValueError("unsupported trusted key type")


@dataclass(frozen=True, slots=True)
class AuthorizationPolicyArchive:
    """Protected per-match policy generations plus current revocation truth.

    The caller must load this object through a rollback-protected configuration
    boundary and pin its exact fingerprint.  Its current policy validity window
    bounds freshness, but cannot by itself detect rollback within that window.
    """

    archive_id: str
    trust_domain_id: str
    match_id: str
    policies: tuple[AuthorizationPolicy, ...]
    current_policy_fingerprint: str
    key_revocations: tuple[KeyRevocationStatus, ...]
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported authorization policy archive schema")
        _stable_id(self.archive_id, "archive_id")
        _stable_id(self.trust_domain_id, "trust_domain_id")
        _stable_id(self.match_id, "match_id")
        if (
            type(self.policies) is not tuple
            or not self.policies
            or len(self.policies) > MAX_POLICY_KEYS
            or any(type(policy) is not AuthorizationPolicy for policy in self.policies)
        ):
            raise ValueError(
                f"policies must contain 1..{MAX_POLICY_KEYS} exact generations"
            )
        _sha256(self.current_policy_fingerprint, "current_policy_fingerprint")
        policy_fingerprints = [policy.fingerprint() for policy in self.policies]
        if len(set(policy_fingerprints)) != len(policy_fingerprints):
            raise ValueError("policy generation fingerprints must be unique")
        if policy_fingerprints.count(self.current_policy_fingerprint) != 1:
            raise ValueError("current policy fingerprint must resolve exactly once")
        if any(
            policy.trust_domain_id != self.trust_domain_id
            or policy.match_id != self.match_id
            for policy in self.policies
        ):
            raise ValueError("all policy generations must share archive scope")

        expected_key_identities: dict[
            tuple[TrustedKeyKind, str, str], str
        ] = {}
        public_material_identities: dict[
            str, tuple[TrustedKeyKind, str, str]
        ] = {}
        for policy in self.policies:
            for key in (
                *policy.actor_keys,
                *policy.assessment_keys,
                *policy.authorizer_keys,
            ):
                kind, principal_id, key_id, public_fingerprint = _key_identity(key)
                identity = (kind, principal_id, key_id)
                prior = expected_key_identities.setdefault(identity, public_fingerprint)
                if prior != public_fingerprint:
                    raise ValueError(
                        "one immutable key identity cannot change public material"
                    )
                prior_identity = public_material_identities.setdefault(
                    public_fingerprint,
                    identity,
                )
                if prior_identity != identity:
                    raise ValueError(
                        "one public key cannot be reintroduced under a new identity"
                    )
        if (
            type(self.key_revocations) is not tuple
            or len(self.key_revocations) > MAX_POLICY_KEYS * 3
            or any(
                type(status) is not KeyRevocationStatus
                for status in self.key_revocations
            )
        ):
            raise ValueError("key_revocations must be a bounded immutable tuple")
        actual: dict[tuple[TrustedKeyKind, str, str], str] = {}
        for status in self.key_revocations:
            identity = (status.key_kind, status.principal_id, status.key_id)
            if identity in actual:
                raise ValueError("key revocation identities must be unique")
            actual[identity] = status.public_key_sha256
        if actual != expected_key_identities:
            raise ValueError(
                "key revocations must exactly cover every historical trusted key"
            )
        object.__setattr__(
            self,
            "policies",
            tuple(sorted(self.policies, key=lambda policy: policy.fingerprint())),
        )
        object.__setattr__(
            self,
            "key_revocations",
            tuple(
                sorted(
                    self.key_revocations,
                    key=lambda status: (
                        status.key_kind.value,
                        status.principal_id,
                        status.key_id,
                    ),
                )
            ),
        )
        _canonical_json_bytes(
            self.canonical_dict(),
            maximum=MAX_AUTHORIZATION_BYTES,
            label="authorization policy archive",
        )

    @property
    def current_policy(self) -> AuthorizationPolicy:
        return next(
            policy
            for policy in self.policies
            if policy.fingerprint() == self.current_policy_fingerprint
        )

    def resolve_policy(self, fingerprint: str) -> AuthorizationPolicy:
        _sha256(fingerprint, "policy fingerprint")
        matches = [
            policy for policy in self.policies if policy.fingerprint() == fingerprint
        ]
        if len(matches) != 1:
            _fail(
                "POLICY_UNTRUSTED",
                "envelope policy is not retained in the protected archive",
            )
        return matches[0]

    def canonical_dict(self) -> dict[str, object]:
        return {
            "archive_id": self.archive_id,
            "current_policy_fingerprint": self.current_policy_fingerprint,
            "key_revocations": [
                status.canonical_dict() for status in self.key_revocations
            ],
            "match_id": self.match_id,
            "policies": [policy.canonical_dict() for policy in self.policies],
            "schema_version": self.schema_version,
            "trust_domain_id": self.trust_domain_id,
        }

    def fingerprint(self) -> str:
        return _fingerprint(
            self.canonical_dict(), label="authorization policy archive"
        )


def _assessment_attestation_payload(
    *,
    assessment: PolicyAssessment,
    assessment_fingerprint: str,
    assessor_id: str,
    assessment_key_id: str,
    signed_at_ns: int,
) -> dict[str, object]:
    return {
        "assessment": assessment.canonical_dict(),
        "assessment_fingerprint": assessment_fingerprint,
        "assessment_key_id": assessment_key_id,
        "assessor_id": assessor_id,
        "schema_version": AUTHORIZATION_SCHEMA_VERSION,
        "signed_at_ns": signed_at_ns,
    }


@dataclass(frozen=True, slots=True)
class SignedPolicyAssessment:
    """A detached trusted-assessor signature over one exact assessment."""

    assessment: PolicyAssessment
    assessment_fingerprint: str
    assessor_id: str
    assessment_key_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported signed-assessment schema")
        if type(self.assessment) is not PolicyAssessment:
            raise ValueError("assessment must be an exact PolicyAssessment")
        _sha256(self.assessment_fingerprint, "assessment_fingerprint")
        if self.assessment_fingerprint != self.assessment.fingerprint():
            raise ValueError("assessment_fingerprint does not bind the assessment")
        _stable_id(self.assessor_id, "assessor_id")
        _stable_id(self.assessment_key_id, "assessment_key_id")
        _timestamp(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    def canonical_dict(self) -> dict[str, object]:
        value = _assessment_attestation_payload(
            assessment=self.assessment,
            assessment_fingerprint=self.assessment_fingerprint,
            assessor_id=self.assessor_id,
            assessment_key_id=self.assessment_key_id,
            signed_at_ns=self.signed_at_ns,
        )
        value["signature_base64"] = self.signature_base64
        return value

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="signed policy assessment")


def _assessment_signing_message(
    *,
    assessment: PolicyAssessment,
    assessment_fingerprint: str,
    assessor_id: str,
    assessment_key_id: str,
    signed_at_ns: int,
) -> bytes:
    return _ASSESSMENT_SIGNING_DOMAIN + _canonical_json_bytes(
        _assessment_attestation_payload(
            assessment=assessment,
            assessment_fingerprint=assessment_fingerprint,
            assessor_id=assessor_id,
            assessment_key_id=assessment_key_id,
            signed_at_ns=signed_at_ns,
        ),
        maximum=MAX_AUTHORIZATION_BYTES,
        label="assessment attestation",
    )


def sign_policy_assessment(
    *,
    assessment: PolicyAssessment,
    assessor_id: str,
    assessment_key_id: str,
    signed_at_ns: int,
    assessment_private_key: Ed25519PrivateKey,
) -> SignedPolicyAssessment:
    """Attest one exact policy assessment without retaining private material."""

    if type(assessment) is not PolicyAssessment:
        raise ValueError("assessment must be an exact PolicyAssessment")
    _stable_id(assessor_id, "assessor_id")
    _stable_id(assessment_key_id, "assessment_key_id")
    signed_at_ns = _timestamp(signed_at_ns, "signed_at_ns")
    if not isinstance(assessment_private_key, Ed25519PrivateKey):
        raise ValueError("assessment_private_key must be Ed25519PrivateKey")
    fingerprint = assessment.fingerprint()
    signature = assessment_private_key.sign(
        _assessment_signing_message(
            assessment=assessment,
            assessment_fingerprint=fingerprint,
            assessor_id=assessor_id,
            assessment_key_id=assessment_key_id,
            signed_at_ns=signed_at_ns,
        )
    )
    return SignedPolicyAssessment(
        assessment=assessment,
        assessment_fingerprint=fingerprint,
        assessor_id=assessor_id,
        assessment_key_id=assessment_key_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


@dataclass(frozen=True, slots=True)
class AuthorizationCommand:
    """Exact human instruction to authorize one already-typed RuleEvent."""

    event: RuleEvent
    event_fingerprint: str
    expected_revision: int
    idempotency_key: str
    origin: AuthorizationOrigin
    actor_id: str
    actor_key_id: str
    actor_role: PrincipalRole
    issued_at_ns: int
    expires_at_ns: int
    nonce: str
    policy_id: str
    policy_fingerprint: str
    trust_domain_id: str
    assessment: PolicyAssessment | None = None
    assessment_fingerprint: str | None = None
    signed_assessment: SignedPolicyAssessment | None = None
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported authorization command schema")
        if type(self.event) is not RuleEvent:
            raise ValueError("event must be an exact RuleEvent")
        _sha256(self.event_fingerprint, "event_fingerprint")
        if self.event_fingerprint != self.event.fingerprint():
            raise ValueError("event_fingerprint does not bind the exact event")
        _timestamp(self.expected_revision, "expected_revision")
        _stable_id(self.idempotency_key, "idempotency_key")
        if not isinstance(self.origin, AuthorizationOrigin):
            raise ValueError("origin must be an AuthorizationOrigin")
        _stable_id(self.actor_id, "actor_id")
        _stable_id(self.actor_key_id, "actor_key_id")
        if not isinstance(self.actor_role, PrincipalRole):
            raise ValueError("actor_role must be a PrincipalRole")
        issued = _timestamp(self.issued_at_ns, "issued_at_ns")
        expires = _timestamp(self.expires_at_ns, "expires_at_ns")
        if expires <= issued:
            raise ValueError("expires_at_ns must be after issued_at_ns")
        _printable_ascii(
            self.nonce,
            "nonce",
            minimum=MIN_NONCE_LENGTH,
            maximum=MAX_NONCE_LENGTH,
        )
        _stable_id(self.policy_id, "policy_id")
        _sha256(self.policy_fingerprint, "policy_fingerprint")
        _stable_id(self.trust_domain_id, "trust_domain_id")
        if self.origin is AuthorizationOrigin.HUMAN_DIRECT:
            if (
                self.assessment is not None
                or self.assessment_fingerprint is not None
                or self.signed_assessment is not None
            ):
                raise ValueError("human-direct commands forbid policy assessments")
        else:
            if type(self.assessment) is not PolicyAssessment:
                raise ValueError(
                    "assessment-assisted commands require an exact PolicyAssessment"
                )
            _sha256(self.assessment_fingerprint, "assessment_fingerprint")
            if self.assessment_fingerprint != self.assessment.fingerprint():
                raise ValueError(
                    "assessment_fingerprint does not bind the exact assessment"
                )
            if (
                type(self.signed_assessment) is not SignedPolicyAssessment
                or self.signed_assessment.assessment != self.assessment
                or self.signed_assessment.assessment_fingerprint
                != self.assessment_fingerprint
            ):
                raise ValueError(
                    "assessment-assisted commands require the exact signed assessment"
                )
        _canonical_json_bytes(
            self.canonical_dict(),
            maximum=MAX_AUTHORIZATION_BYTES,
            label="authorization command",
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "actor_id": self.actor_id,
            "actor_key_id": self.actor_key_id,
            "actor_role": self.actor_role.value,
            "assessment": (
                self.assessment.canonical_dict()
                if self.assessment is not None
                else None
            ),
            "assessment_fingerprint": self.assessment_fingerprint,
            "event": rule_event_to_dict(self.event),
            "event_fingerprint": self.event_fingerprint,
            "expected_revision": self.expected_revision,
            "expires_at_ns": self.expires_at_ns,
            "idempotency_key": self.idempotency_key,
            "issued_at_ns": self.issued_at_ns,
            "nonce": self.nonce,
            "origin": self.origin.value,
            "policy_fingerprint": self.policy_fingerprint,
            "policy_id": self.policy_id,
            "schema_version": self.schema_version,
            "signed_assessment": (
                self.signed_assessment.canonical_dict()
                if self.signed_assessment is not None
                else None
            ),
            "trust_domain_id": self.trust_domain_id,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(encode_authorization_command(self)).hexdigest()


def encode_authorization_command(command: AuthorizationCommand) -> bytes:
    """Canonical actor-signature bytes for one immutable command."""

    if type(command) is not AuthorizationCommand:
        raise ValueError("command must be an exact AuthorizationCommand")
    return _canonical_json_bytes(
        command.canonical_dict(),
        maximum=MAX_AUTHORIZATION_BYTES,
        label="authorization command",
    )


@dataclass(frozen=True, slots=True)
class SignedAuthorizationCommand:
    command: AuthorizationCommand
    actor_signature_base64: str
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported signed-command schema")
        if type(self.command) is not AuthorizationCommand:
            raise ValueError("command must be an exact AuthorizationCommand")
        _canonical_base64(
            self.actor_signature_base64,
            "actor_signature_base64",
            expected_bytes=64,
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "actor_signature_base64": self.actor_signature_base64,
            "command": self.command.canonical_dict(),
            "schema_version": self.schema_version,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="signed command")


@dataclass(frozen=True, slots=True)
class AuthorizationRecord:
    """Authorizer decision linking every exact trust and intent input."""

    signed_command: SignedAuthorizationCommand
    event: RuleEvent
    assessment: PolicyAssessment | None
    policy: AuthorizationPolicy
    actor_key: TrustedActorKey
    authorizer_key: TrustedAuthorizerKey
    authorized_at_ns: int
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported authorization record schema")
        if type(self.signed_command) is not SignedAuthorizationCommand:
            raise ValueError("signed_command must be exact")
        command = self.signed_command.command
        if type(self.event) is not RuleEvent or self.event != command.event:
            raise ValueError("record event must equal the exact command event")
        if self.assessment != command.assessment:
            raise ValueError("record assessment must equal the exact command assessment")
        if type(self.policy) is not AuthorizationPolicy:
            raise ValueError("policy must be exact")
        if (
            command.policy_id != self.policy.policy_id
            or command.policy_fingerprint != self.policy.fingerprint()
            or command.trust_domain_id != self.policy.trust_domain_id
        ):
            raise ValueError("record policy does not match the command")
        if type(self.actor_key) is not TrustedActorKey or (
            self.actor_key.actor_id != command.actor_id
            or self.actor_key.key_id != command.actor_key_id
            or self.actor_key.role is not command.actor_role
        ):
            raise ValueError("record actor key does not match the command")
        if type(self.authorizer_key) is not TrustedAuthorizerKey:
            raise ValueError("authorizer_key must be exact")
        _timestamp(self.authorized_at_ns, "authorized_at_ns")
        _canonical_json_bytes(
            self.canonical_dict(),
            maximum=MAX_AUTHORIZATION_BYTES,
            label="authorization record",
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "actor_key": self.actor_key.canonical_dict(),
            "assessment": (
                self.assessment.canonical_dict()
                if self.assessment is not None
                else None
            ),
            "authorized_at_ns": self.authorized_at_ns,
            "authorizer_key": self.authorizer_key.canonical_dict(),
            "event": rule_event_to_dict(self.event),
            "policy": self.policy.canonical_dict(),
            "schema_version": self.schema_version,
            "signed_command": self.signed_command.canonical_dict(),
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="authorization record")


@dataclass(frozen=True, slots=True)
class AuthorizedRuleEvent:
    """Persistable event plus complete human and authorizer proof envelope."""

    event: RuleEvent
    authorization_record: AuthorizationRecord
    authorizer_signature_base64: str
    schema_version: str = AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != AUTHORIZATION_SCHEMA_VERSION:
            raise ValueError("unsupported authorized-event schema")
        if type(self.event) is not RuleEvent:
            raise ValueError("event must be an exact RuleEvent")
        if (
            type(self.authorization_record) is not AuthorizationRecord
            or self.authorization_record.event != self.event
        ):
            raise ValueError("authorization_record must bind the exact event")
        _canonical_base64(
            self.authorizer_signature_base64,
            "authorizer_signature_base64",
            expected_bytes=64,
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "authorization_record": self.authorization_record.canonical_dict(),
            "authorizer_signature_base64": self.authorizer_signature_base64,
            "event": rule_event_to_dict(self.event),
            "schema_version": self.schema_version,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(encode_authorized_rule_event(self)).hexdigest()


def _actor_signing_message(command: AuthorizationCommand) -> bytes:
    return _ACTOR_SIGNING_DOMAIN + encode_authorization_command(command)


def _authorizer_signing_message(record: AuthorizationRecord) -> bytes:
    return _AUTHORIZER_SIGNING_DOMAIN + _canonical_json_bytes(
        record.canonical_dict(),
        maximum=MAX_AUTHORIZATION_BYTES,
        label="authorization record",
    )


def sign_authorization_command(
    command: AuthorizationCommand,
    actor_private_key: Ed25519PrivateKey,
) -> SignedAuthorizationCommand:
    """Sign an exact command without retaining the actor's private key."""

    if type(command) is not AuthorizationCommand:
        raise ValueError("command must be an exact AuthorizationCommand")
    if not isinstance(actor_private_key, Ed25519PrivateKey):
        raise ValueError("actor_private_key must be Ed25519PrivateKey")
    signature = actor_private_key.sign(_actor_signing_message(command))
    return SignedAuthorizationCommand(
        command=command,
        actor_signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _actor_key(policy: AuthorizationPolicy, command: AuthorizationCommand) -> TrustedActorKey:
    matches = [
        key
        for key in policy.actor_keys
        if key.actor_id == command.actor_id and key.key_id == command.actor_key_id
    ]
    if len(matches) != 1:
        _fail("ACTOR_KEY_UNTRUSTED", "actor key is not in the protected policy")
    return matches[0]


def _authorizer_key(
    policy: AuthorizationPolicy,
    *,
    authorizer_id: str,
    key_id: str,
) -> TrustedAuthorizerKey:
    matches = [
        key
        for key in policy.authorizer_keys
        if key.authorizer_id == authorizer_id and key.key_id == key_id
    ]
    if len(matches) != 1:
        _fail(
            "AUTHORIZER_KEY_UNTRUSTED",
            "authorizer key is not in the protected policy",
        )
    return matches[0]


def _assessment_key(
    policy: AuthorizationPolicy,
    signed_assessment: SignedPolicyAssessment,
) -> TrustedAssessmentKey:
    matches = [
        key
        for key in policy.assessment_keys
        if key.assessor_id == signed_assessment.assessor_id
        and key.key_id == signed_assessment.assessment_key_id
    ]
    if len(matches) != 1:
        _fail(
            "ASSESSMENT_KEY_UNTRUSTED",
            "assessment key is not in the protected historical policy",
        )
    return matches[0]


def _check_key_time(
    key: TrustedActorKey | TrustedAssessmentKey | TrustedAuthorizerKey,
    *,
    used_at_ns: int,
    revoked_as_of_ns: int,
    label: str,
) -> None:
    if not key.valid_from_ns <= used_at_ns <= key.valid_until_ns:
        _fail(f"{label}_KEY_INACTIVE", f"{label.lower()} key was not valid at use")
    if key.revoked_at_ns is not None and key.revoked_at_ns <= revoked_as_of_ns:
        _fail(f"{label}_KEY_REVOKED", f"{label.lower()} key is revoked")


def _check_archive_revocation(
    archive: AuthorizationPolicyArchive,
    key: TrustedActorKey | TrustedAssessmentKey | TrustedAuthorizerKey,
    *,
    revoked_as_of_ns: int,
    label: str,
) -> None:
    kind, principal_id, key_id, public_fingerprint = _key_identity(key)
    matches = [
        status
        for status in archive.key_revocations
        if status.key_kind is kind
        and status.principal_id == principal_id
        and status.key_id == key_id
        and status.public_key_sha256 == public_fingerprint
    ]
    if len(matches) != 1:
        _fail(
            f"{label}_KEY_STATUS_MISSING",
            f"{label.lower()} key lacks exact current revocation status",
        )
    revoked_at_ns = matches[0].revoked_at_ns
    if revoked_at_ns is not None and revoked_at_ns <= revoked_as_of_ns:
        _fail(f"{label}_KEY_REVOKED", f"{label.lower()} key is currently revoked")


def _assessment_evidence(event: RuleEvent) -> tuple[str, ...] | None:
    payload = event.payload
    if isinstance(payload, (PointAwardedPayload, ReplayNoPointPayload)):
        return payload.evidence_refs
    return None


def _check_assessment_context(
    command: AuthorizationCommand,
    policy: AuthorizationPolicy,
    archive: AuthorizationPolicyArchive,
    *,
    revoked_as_of_ns: int,
) -> None:
    assessment = command.assessment
    if command.origin is AuthorizationOrigin.HUMAN_DIRECT:
        if assessment is not None:
            _fail("ASSESSMENT_FORBIDDEN", "human-direct command contains assessment")
        return
    if type(assessment) is not PolicyAssessment:
        _fail("ASSESSMENT_REQUIRED", "assisted command requires exact assessment")
    signed_assessment = command.signed_assessment
    if (
        type(signed_assessment) is not SignedPolicyAssessment
        or signed_assessment.assessment != assessment
        or signed_assessment.assessment_fingerprint != assessment.fingerprint()
    ):
        _fail(
            "ASSESSMENT_SIGNATURE_REQUIRED",
            "assisted command requires the exact signed assessment",
        )
    assessment_key = _assessment_key(policy, signed_assessment)
    if not (
        assessment.causal_cutoff_timestamp_ns
        <= signed_assessment.signed_at_ns
        <= command.issued_at_ns
    ) or not policy.is_active(signed_assessment.signed_at_ns):
        _fail("ASSESSMENT_TIME", "assessment signature has invalid causality")
    _check_key_time(
        assessment_key,
        used_at_ns=signed_assessment.signed_at_ns,
        revoked_as_of_ns=revoked_as_of_ns,
        label="ASSESSMENT",
    )
    _check_archive_revocation(
        archive,
        assessment_key,
        revoked_as_of_ns=revoked_as_of_ns,
        label="ASSESSMENT",
    )
    try:
        assessment_key.public_key.verify(
            _canonical_base64(
                signed_assessment.signature_base64,
                "assessment signature_base64",
                expected_bytes=64,
            ),
            _assessment_signing_message(
                assessment=assessment,
                assessment_fingerprint=signed_assessment.assessment_fingerprint,
                assessor_id=signed_assessment.assessor_id,
                assessment_key_id=signed_assessment.assessment_key_id,
                signed_at_ns=signed_assessment.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        raise AuthorizationError(
            "ASSESSMENT_SIGNATURE_INVALID",
            "assessment signature is invalid",
        ) from exc
    if assessment.status is not PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED:
        _fail(
            "ASSESSMENT_NOT_READY",
            "assisted assessment does not require human authorization",
        )
    if (
        assessment.policy_fingerprint
        not in policy.accepted_assessment_policy_fingerprints
    ):
        _fail(
            "ASSESSMENT_POLICY_UNTRUSTED",
            "assisted assessment policy is not protected by authorization policy",
        )
    allowed_reasons = {
        PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,
        PolicyReason.NEXT_SERVER_AMBIGUOUS,
    }
    if not set(assessment.reasons) <= allowed_reasons:
        _fail(
            "ASSESSMENT_EXCEPTION",
            "assisted assessment contains fatal or review-only reasons",
        )
    if assessment.reconciliation_outcome in {
        NextServerOutcome.CONTRADICTS,
        NextServerOutcome.SERVICE_ORDER_CONFLICT,
        NextServerOutcome.NOT_APPLICABLE_TERMINAL,
    }:
        _fail(
            "ASSESSMENT_RECONCILIATION",
            "assisted assessment has a contradictory or terminal reconciliation",
        )
    ambiguous = (
        assessment.reconciliation_outcome
        is NextServerOutcome.AMBIGUOUS_SAME_SERVER
    )
    if ambiguous != (PolicyReason.NEXT_SERVER_AMBIGUOUS in assessment.reasons):
        _fail(
            "ASSESSMENT_RECONCILIATION",
            "next-server ambiguity reason and outcome must agree",
        )
    intent = assessment.recommended_intent
    if intent is None:
        _fail("ASSESSMENT_INTENT", "assisted assessment has no intent")
    event = command.event
    if (
        assessment.match_id != event.match_id
        or assessment.set_number != event.set_number
        or assessment.ruleset_fingerprint != event.ruleset_fingerprint
        or assessment.state_revision != command.expected_revision
        or assessment.rally_id != event.related_rally_id
        or event.created_at_ns < assessment.causal_cutoff_timestamp_ns
        or command.issued_at_ns < assessment.causal_cutoff_timestamp_ns
    ):
        _fail("ASSESSMENT_CONTEXT", "assessment and event context do not match")
    if intent.kind is ScoringIntentKind.AWARD_POINT:
        if (
            event.event_type is not RuleEventType.POINT_AWARDED
            or type(event.payload) is not PointAwardedPayload
            or event.payload.winner_team is not intent.winner_team
        ):
            _fail("ASSESSMENT_INTENT", "point event differs from assessed intent")
    elif intent.kind is ScoringIntentKind.RECORD_REPLAY_NO_POINT:
        if event.event_type is not RuleEventType.REPLAY_NO_POINT:
            _fail("ASSESSMENT_INTENT", "replay event differs from assessed intent")
    else:  # pragma: no cover - enum exhaustiveness guard
        _fail("ASSESSMENT_INTENT", "unsupported assessment intent")
    if _assessment_evidence(event) != assessment.evidence_refs:
        _fail(
            "ASSESSMENT_EVIDENCE",
            "event evidence must exactly equal assessed evidence",
        )


def _verify_actor_command(
    signed_command: SignedAuthorizationCommand,
    *,
    policy: AuthorizationPolicy,
    policy_archive: AuthorizationPolicyArchive,
    authorized_at_ns: int,
    revoked_as_of_ns: int,
) -> TrustedActorKey:
    if type(signed_command) is not SignedAuthorizationCommand:
        _fail("COMMAND_TYPE", "signed command must be exact")
    command = signed_command.command
    if (
        command.policy_id != policy.policy_id
        or command.policy_fingerprint != policy.fingerprint()
        or command.trust_domain_id != policy.trust_domain_id
    ):
        _fail("POLICY_MISMATCH", "command does not bind the protected policy")
    if not policy.is_active(command.issued_at_ns) or not policy.is_active(
        authorized_at_ns
    ):
        _fail("POLICY_INACTIVE", "policy was not active for the command")
    if not command.issued_at_ns <= authorized_at_ns <= command.expires_at_ns:
        _fail("COMMAND_EXPIRED", "command is not live at authorization time")
    if command.expires_at_ns - command.issued_at_ns > policy.max_command_lifetime_ns:
        _fail("COMMAND_LIFETIME", "command lifetime exceeds protected policy")
    if command.event.created_at_ns > command.issued_at_ns:
        _fail("COMMAND_TIME", "actor cannot sign an event from the future")
    if command.event.match_id != policy.match_id:
        _fail(
            "RESOURCE_SCOPE",
            "actor authorization policy is not scoped to the event match",
        )
    if command.expected_revision != command.event.sequence_number - 1:
        _fail("STALE_REVISION", "expected revision does not precede event sequence")
    if command.event.event_type not in ROLE_EVENT_ALLOWLISTS[command.actor_role]:
        _fail("ROLE_FORBIDDEN", "actor role cannot authorize this event type")
    actor_key = _actor_key(policy, command)
    if actor_key.role is not command.actor_role:
        _fail("ACTOR_ROLE_MISMATCH", "command role differs from trusted actor key")
    _check_key_time(
        actor_key,
        used_at_ns=command.issued_at_ns,
        revoked_as_of_ns=revoked_as_of_ns,
        label="ACTOR",
    )
    _check_archive_revocation(
        policy_archive,
        actor_key,
        revoked_as_of_ns=revoked_as_of_ns,
        label="ACTOR",
    )
    _check_key_time(
        actor_key,
        used_at_ns=authorized_at_ns,
        revoked_as_of_ns=revoked_as_of_ns,
        label="ACTOR",
    )
    try:
        actor_key.public_key.verify(
            _canonical_base64(
                signed_command.actor_signature_base64,
                "actor_signature_base64",
                expected_bytes=64,
            ),
            _actor_signing_message(command),
        )
    except InvalidSignature as exc:
        raise AuthorizationError(
            "ACTOR_SIGNATURE_INVALID", "actor signature is invalid"
        ) from exc
    _check_assessment_context(
        command,
        policy,
        policy_archive,
        revoked_as_of_ns=revoked_as_of_ns,
    )
    return actor_key


def authorize_rule_event(
    *,
    signed_command: SignedAuthorizationCommand,
    policy_archive: AuthorizationPolicyArchive,
    authorizer_id: str,
    authorizer_key_id: str,
    authorizer_private_key: Ed25519PrivateKey,
    authorized_at_ns: int,
) -> AuthorizedRuleEvent:
    """Verify the human command and countersign its exact event envelope."""

    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be exact")
    policy = policy_archive.current_policy
    _stable_id(authorizer_id, "authorizer_id")
    _stable_id(authorizer_key_id, "authorizer_key_id")
    authorized_at_ns = _timestamp(authorized_at_ns, "authorized_at_ns")
    if not isinstance(authorizer_private_key, Ed25519PrivateKey):
        raise ValueError("authorizer_private_key must be Ed25519PrivateKey")
    actor_key = _verify_actor_command(
        signed_command,
        policy=policy,
        policy_archive=policy_archive,
        authorized_at_ns=authorized_at_ns,
        revoked_as_of_ns=authorized_at_ns,
    )
    authorizer_key = _authorizer_key(
        policy,
        authorizer_id=authorizer_id,
        key_id=authorizer_key_id,
    )
    _check_key_time(
        authorizer_key,
        used_at_ns=authorized_at_ns,
        revoked_as_of_ns=authorized_at_ns,
        label="AUTHORIZER",
    )
    _check_archive_revocation(
        policy_archive,
        authorizer_key,
        revoked_as_of_ns=authorized_at_ns,
        label="AUTHORIZER",
    )
    command = signed_command.command
    record = AuthorizationRecord(
        signed_command=signed_command,
        event=command.event,
        assessment=command.assessment,
        policy=policy,
        actor_key=actor_key,
        authorizer_key=authorizer_key,
        authorized_at_ns=authorized_at_ns,
    )
    signature = authorizer_private_key.sign(_authorizer_signing_message(record))
    try:
        authorizer_key.public_key.verify(signature, _authorizer_signing_message(record))
    except InvalidSignature as exc:
        raise AuthorizationError(
            "AUTHORIZER_PRIVATE_KEY_MISMATCH",
            "private key does not match protected authorizer key",
        ) from exc
    return AuthorizedRuleEvent(
        event=command.event,
        authorization_record=record,
        authorizer_signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def verify_authorized_rule_event(
    envelope: AuthorizedRuleEvent,
    *,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
) -> RuleEvent:
    """Recheck an envelope against the exact current policy and trust root."""

    if type(envelope) is not AuthorizedRuleEvent:
        _fail("ENVELOPE_TYPE", "envelope must be exact")
    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be exact")
    verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
    record = envelope.authorization_record
    if verified_at_ns < record.authorized_at_ns:
        _fail(
            "FUTURE_AUTHORIZATION",
            "envelope cannot be verified before its authorization time",
        )
    if not policy_archive.current_policy.is_active(verified_at_ns):
        _fail(
            "POLICY_ARCHIVE_STALE",
            "protected archive has no current policy active at verification time",
        )
    historical_policy = policy_archive.resolve_policy(record.policy.fingerprint())
    if record.policy != historical_policy:
        _fail(
            "POLICY_MISMATCH",
            "envelope policy differs from its protected historical generation",
        )
    if envelope.event != record.event or record.event != record.signed_command.command.event:
        _fail("EVENT_MISMATCH", "envelope event linkage is inconsistent")
    actor_key = _verify_actor_command(
        record.signed_command,
        policy=historical_policy,
        policy_archive=policy_archive,
        authorized_at_ns=record.authorized_at_ns,
        revoked_as_of_ns=verified_at_ns,
    )
    if actor_key != record.actor_key:
        _fail("ACTOR_KEY_MISMATCH", "record does not embed the current actor key")
    authorizer_key = _authorizer_key(
        historical_policy,
        authorizer_id=record.authorizer_key.authorizer_id,
        key_id=record.authorizer_key.key_id,
    )
    if authorizer_key != record.authorizer_key:
        _fail(
            "AUTHORIZER_KEY_MISMATCH",
            "record does not embed the current authorizer key",
        )
    _check_key_time(
        authorizer_key,
        used_at_ns=record.authorized_at_ns,
        revoked_as_of_ns=verified_at_ns,
        label="AUTHORIZER",
    )
    _check_archive_revocation(
        policy_archive,
        authorizer_key,
        revoked_as_of_ns=verified_at_ns,
        label="AUTHORIZER",
    )
    try:
        authorizer_key.public_key.verify(
            _canonical_base64(
                envelope.authorizer_signature_base64,
                "authorizer_signature_base64",
                expected_bytes=64,
            ),
            _authorizer_signing_message(record),
        )
    except InvalidSignature as exc:
        raise AuthorizationError(
            "AUTHORIZER_SIGNATURE_INVALID", "authorizer signature is invalid"
        ) from exc
    return envelope.event


def encode_authorized_rule_event(envelope: AuthorizedRuleEvent) -> bytes:
    """Return the only persisted canonical encoding of an authorized event."""

    if type(envelope) is not AuthorizedRuleEvent:
        raise ValueError("envelope must be an exact AuthorizedRuleEvent")
    return _canonical_json_bytes(
        envelope.canonical_dict(),
        maximum=MAX_AUTHORIZATION_BYTES,
        label="authorized rule event",
    )


class _DuplicateKey(Exception):
    pass


class _UnsupportedNumber(Exception):
    pass


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _check_json_depth(raw: bytes) -> None:
    depth = 0
    in_string = False
    escaped = False
    for byte in raw:
        character = chr(byte)
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_AUTHORIZATION_JSON_DEPTH:
                _fail("JSON_DEPTH", "authorization JSON nesting is too deep")
        elif character in "]}":
            depth = max(0, depth - 1)


def _exact_dict(
    value: object,
    fields: frozenset[str],
    label: str,
) -> dict[str, Any]:
    if type(value) is not dict:
        _fail("FIELD_TYPE", f"{label} must be an object")
    if frozenset(value) != fields:
        _fail("FIELD_SET", f"{label} does not have its exact field set")
    return value


def _exact_list(value: object, label: str, *, maximum: int) -> list[Any]:
    if type(value) is not list or len(value) > maximum:
        _fail("FIELD_TYPE", f"{label} must be a bounded array")
    return value


_ACTOR_KEY_FIELDS = frozenset(
    {
        "actor_id",
        "key_id",
        "public_key_base64",
        "revoked_at_ns",
        "role",
        "valid_from_ns",
        "valid_until_ns",
    }
)
_AUTHORIZER_KEY_FIELDS = frozenset(
    {
        "authorizer_id",
        "key_id",
        "public_key_base64",
        "revoked_at_ns",
        "valid_from_ns",
        "valid_until_ns",
    }
)
_ASSESSMENT_KEY_FIELDS = frozenset(
    {
        "assessor_id",
        "key_id",
        "public_key_base64",
        "revoked_at_ns",
        "valid_from_ns",
        "valid_until_ns",
    }
)
_POLICY_FIELDS = frozenset(
    {
        "accepted_assessment_policy_fingerprints",
        "actor_keys",
        "assessment_keys",
        "authorizer_keys",
        "max_command_lifetime_ns",
        "match_id",
        "policy_id",
        "role_event_allowlists",
        "schema_version",
        "trust_domain_id",
        "valid_from_ns",
        "valid_until_ns",
    }
)
_ASSESSMENT_FIELDS = frozenset(
    {
        "causal_cutoff_timestamp_ns",
        "evidence_refs",
        "hypothesis_fingerprint",
        "hypothesis_id",
        "match_id",
        "policy_version",
        "policy_fingerprint",
        "rally_id",
        "reasons",
        "recommended_intent",
        "reconciliation_fingerprint",
        "reconciliation_outcome",
        "ruleset_fingerprint",
        "schema_version",
        "set_number",
        "state_revision",
        "status",
    }
)
_INTENT_FIELDS = frozenset({"kind", "winner_team"})
_SIGNED_ASSESSMENT_FIELDS = frozenset(
    {
        "assessment",
        "assessment_fingerprint",
        "assessment_key_id",
        "assessor_id",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
    }
)
_COMMAND_FIELDS = frozenset(
    {
        "actor_id",
        "actor_key_id",
        "actor_role",
        "assessment",
        "assessment_fingerprint",
        "event",
        "event_fingerprint",
        "expected_revision",
        "expires_at_ns",
        "idempotency_key",
        "issued_at_ns",
        "nonce",
        "origin",
        "policy_fingerprint",
        "policy_id",
        "schema_version",
        "signed_assessment",
        "trust_domain_id",
    }
)
_SIGNED_COMMAND_FIELDS = frozenset(
    {"actor_signature_base64", "command", "schema_version"}
)
_RECORD_FIELDS = frozenset(
    {
        "actor_key",
        "assessment",
        "authorized_at_ns",
        "authorizer_key",
        "event",
        "policy",
        "schema_version",
        "signed_command",
    }
)
_ENVELOPE_FIELDS = frozenset(
    {
        "authorization_record",
        "authorizer_signature_base64",
        "event",
        "schema_version",
    }
)


def _event_from_dict(value: object, label: str) -> RuleEvent:
    if type(value) is not dict:
        _fail("FIELD_TYPE", f"{label} must be an event object")
    try:
        return parse_rule_event(
            _canonical_json_bytes(
                value,
                maximum=MAX_AUTHORIZATION_BYTES,
                label=label,
            )
        )
    except ValueError as exc:
        raise AuthorizationError("EVENT_INVALID", f"{label} is invalid") from exc


def _assessment_from_dict(value: object, label: str) -> PolicyAssessment | None:
    if value is None:
        return None
    data = _exact_dict(value, _ASSESSMENT_FIELDS, label)
    intent_raw = data["recommended_intent"]
    intent: ScoringIntent | None
    if intent_raw is None:
        intent = None
    else:
        intent_data = _exact_dict(intent_raw, _INTENT_FIELDS, f"{label}.intent")
        try:
            winner = (
                Team(intent_data["winner_team"])
                if intent_data["winner_team"] is not None
                else None
            )
            intent = ScoringIntent(ScoringIntentKind(intent_data["kind"]), winner)
        except (TypeError, ValueError) as exc:
            raise AuthorizationError("ASSESSMENT_INVALID", "invalid intent") from exc
    try:
        reasons = tuple(
            PolicyReason(item)
            for item in _exact_list(
                data["reasons"], f"{label}.reasons", maximum=64
            )
        )
        evidence_refs = tuple(
            _exact_list(
                data["evidence_refs"], f"{label}.evidence_refs", maximum=64
            )
        )
        reconciliation = (
            NextServerOutcome(data["reconciliation_outcome"])
            if data["reconciliation_outcome"] is not None
            else None
        )
        return PolicyAssessment(
            hypothesis_id=data["hypothesis_id"],
            hypothesis_fingerprint=data["hypothesis_fingerprint"],
            match_id=data["match_id"],
            rally_id=data["rally_id"],
            set_number=data["set_number"],
            state_revision=data["state_revision"],
            ruleset_fingerprint=data["ruleset_fingerprint"],
            causal_cutoff_timestamp_ns=data["causal_cutoff_timestamp_ns"],
            policy_version=data["policy_version"],
            policy_fingerprint=data["policy_fingerprint"],
            status=PolicyAssessmentStatus(data["status"]),
            reasons=reasons,
            recommended_intent=intent,
            evidence_refs=evidence_refs,
            reconciliation_outcome=reconciliation,
            reconciliation_fingerprint=data["reconciliation_fingerprint"],
            schema_version=data["schema_version"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("ASSESSMENT_INVALID", "invalid assessment") from exc


def _actor_key_from_dict(value: object, label: str) -> TrustedActorKey:
    data = _exact_dict(value, _ACTOR_KEY_FIELDS, label)
    try:
        return TrustedActorKey(
            actor_id=data["actor_id"],
            key_id=data["key_id"],
            role=PrincipalRole(data["role"]),
            public_key_base64=data["public_key_base64"],
            valid_from_ns=data["valid_from_ns"],
            valid_until_ns=data["valid_until_ns"],
            revoked_at_ns=data["revoked_at_ns"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("ACTOR_KEY_INVALID", f"{label} is invalid") from exc


def _authorizer_key_from_dict(value: object, label: str) -> TrustedAuthorizerKey:
    data = _exact_dict(value, _AUTHORIZER_KEY_FIELDS, label)
    try:
        return TrustedAuthorizerKey(
            authorizer_id=data["authorizer_id"],
            key_id=data["key_id"],
            public_key_base64=data["public_key_base64"],
            valid_from_ns=data["valid_from_ns"],
            valid_until_ns=data["valid_until_ns"],
            revoked_at_ns=data["revoked_at_ns"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError(
            "AUTHORIZER_KEY_INVALID", f"{label} is invalid"
        ) from exc


def _assessment_key_from_dict(value: object, label: str) -> TrustedAssessmentKey:
    data = _exact_dict(value, _ASSESSMENT_KEY_FIELDS, label)
    try:
        return TrustedAssessmentKey(
            assessor_id=data["assessor_id"],
            key_id=data["key_id"],
            public_key_base64=data["public_key_base64"],
            valid_from_ns=data["valid_from_ns"],
            valid_until_ns=data["valid_until_ns"],
            revoked_at_ns=data["revoked_at_ns"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError(
            "ASSESSMENT_KEY_INVALID", f"{label} is invalid"
        ) from exc


def _policy_from_dict(value: object, label: str) -> AuthorizationPolicy:
    data = _exact_dict(value, _POLICY_FIELDS, label)
    if data["role_event_allowlists"] != _role_allowlists_wire():
        _fail("POLICY_ALLOWLIST", "policy role allowlists are not exact")
    actors = tuple(
        _actor_key_from_dict(item, f"{label}.actor_keys[{index}]")
        for index, item in enumerate(
            _exact_list(data["actor_keys"], f"{label}.actor_keys", maximum=MAX_POLICY_KEYS)
        )
    )
    assessment_keys = tuple(
        _assessment_key_from_dict(item, f"{label}.assessment_keys[{index}]")
        for index, item in enumerate(
            _exact_list(
                data["assessment_keys"],
                f"{label}.assessment_keys",
                maximum=MAX_POLICY_KEYS,
            )
        )
    )
    authorizers = tuple(
        _authorizer_key_from_dict(item, f"{label}.authorizer_keys[{index}]")
        for index, item in enumerate(
            _exact_list(
                data["authorizer_keys"],
                f"{label}.authorizer_keys",
                maximum=MAX_POLICY_KEYS,
            )
        )
    )
    try:
        accepted_assessment_policies = tuple(
            _exact_list(
                data["accepted_assessment_policy_fingerprints"],
                f"{label}.accepted_assessment_policy_fingerprints",
                maximum=MAX_ASSESSMENT_POLICY_FINGERPRINTS,
            )
        )
        return AuthorizationPolicy(
            policy_id=data["policy_id"],
            trust_domain_id=data["trust_domain_id"],
            match_id=data["match_id"],
            valid_from_ns=data["valid_from_ns"],
            valid_until_ns=data["valid_until_ns"],
            max_command_lifetime_ns=data["max_command_lifetime_ns"],
            accepted_assessment_policy_fingerprints=(
                accepted_assessment_policies
            ),
            actor_keys=actors,
            assessment_keys=assessment_keys,
            authorizer_keys=authorizers,
            schema_version=data["schema_version"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("POLICY_INVALID", f"{label} is invalid") from exc


def _signed_assessment_from_dict(
    value: object,
    label: str,
) -> SignedPolicyAssessment | None:
    if value is None:
        return None
    data = _exact_dict(value, _SIGNED_ASSESSMENT_FIELDS, label)
    assessment = _assessment_from_dict(data["assessment"], f"{label}.assessment")
    if assessment is None:
        _fail("SIGNED_ASSESSMENT_INVALID", "signed assessment cannot be null")
    try:
        return SignedPolicyAssessment(
            assessment=assessment,
            assessment_fingerprint=data["assessment_fingerprint"],
            assessor_id=data["assessor_id"],
            assessment_key_id=data["assessment_key_id"],
            signed_at_ns=data["signed_at_ns"],
            signature_base64=data["signature_base64"],
            schema_version=data["schema_version"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError(
            "SIGNED_ASSESSMENT_INVALID", f"{label} is invalid"
        ) from exc


def _command_from_dict(value: object, label: str) -> AuthorizationCommand:
    data = _exact_dict(value, _COMMAND_FIELDS, label)
    assessment = _assessment_from_dict(data["assessment"], f"{label}.assessment")
    try:
        return AuthorizationCommand(
            event=_event_from_dict(data["event"], f"{label}.event"),
            event_fingerprint=data["event_fingerprint"],
            expected_revision=data["expected_revision"],
            idempotency_key=data["idempotency_key"],
            origin=AuthorizationOrigin(data["origin"]),
            actor_id=data["actor_id"],
            actor_key_id=data["actor_key_id"],
            actor_role=PrincipalRole(data["actor_role"]),
            issued_at_ns=data["issued_at_ns"],
            expires_at_ns=data["expires_at_ns"],
            nonce=data["nonce"],
            policy_id=data["policy_id"],
            policy_fingerprint=data["policy_fingerprint"],
            trust_domain_id=data["trust_domain_id"],
            assessment=assessment,
            assessment_fingerprint=data["assessment_fingerprint"],
            signed_assessment=_signed_assessment_from_dict(
                data["signed_assessment"], f"{label}.signed_assessment"
            ),
            schema_version=data["schema_version"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("COMMAND_INVALID", f"{label} is invalid") from exc


def _signed_command_from_dict(
    value: object, label: str
) -> SignedAuthorizationCommand:
    data = _exact_dict(value, _SIGNED_COMMAND_FIELDS, label)
    try:
        return SignedAuthorizationCommand(
            command=_command_from_dict(data["command"], f"{label}.command"),
            actor_signature_base64=data["actor_signature_base64"],
            schema_version=data["schema_version"],
        )
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("SIGNED_COMMAND_INVALID", f"{label} is invalid") from exc


def _record_from_dict(value: object, label: str) -> AuthorizationRecord:
    data = _exact_dict(value, _RECORD_FIELDS, label)
    try:
        return AuthorizationRecord(
            signed_command=_signed_command_from_dict(
                data["signed_command"], f"{label}.signed_command"
            ),
            event=_event_from_dict(data["event"], f"{label}.event"),
            assessment=_assessment_from_dict(
                data["assessment"], f"{label}.assessment"
            ),
            policy=_policy_from_dict(data["policy"], f"{label}.policy"),
            actor_key=_actor_key_from_dict(data["actor_key"], f"{label}.actor_key"),
            authorizer_key=_authorizer_key_from_dict(
                data["authorizer_key"], f"{label}.authorizer_key"
            ),
            authorized_at_ns=data["authorized_at_ns"],
            schema_version=data["schema_version"],
        )
    except AuthorizationError:
        raise
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("RECORD_INVALID", f"{label} is invalid") from exc


def parse_authorized_rule_event(raw: bytes) -> AuthorizedRuleEvent:
    """Parse only the strict, bounded canonical persisted envelope encoding."""

    if type(raw) is not bytes:
        _fail("RAW_TYPE", "authorized event must be bytes")
    if not raw or len(raw) > MAX_AUTHORIZATION_BYTES:
        _fail("RAW_SIZE", "authorized event bytes are empty or too large")
    if any(byte > 0x7F for byte in raw):
        _fail("RAW_ASCII", "authorized event must be ASCII JSON")
    _check_json_depth(raw)
    try:
        decoded = json.loads(
            raw.decode("ascii"),
            object_pairs_hook=_object_pairs,
            parse_float=lambda _: (_ for _ in ()).throw(_UnsupportedNumber()),
            parse_constant=lambda _: (_ for _ in ()).throw(_UnsupportedNumber()),
        )
    except _DuplicateKey as exc:
        raise AuthorizationError("DUPLICATE_KEY", f"duplicate key: {exc}") from exc
    except _UnsupportedNumber as exc:
        raise AuthorizationError("JSON_NUMBER", "non-integer number is forbidden") from exc
    except RecursionError as exc:
        raise AuthorizationError("JSON_DEPTH", "authorization JSON is too deep") from exc
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise AuthorizationError("INVALID_JSON", "invalid authorization JSON") from exc
    data = _exact_dict(decoded, _ENVELOPE_FIELDS, "authorized rule event")
    try:
        event = _event_from_dict(data["event"], "authorized rule event.event")
        record = _record_from_dict(
            data["authorization_record"],
            "authorized rule event.authorization_record",
        )
        if event != record.event:
            _fail("EVENT_MISMATCH", "envelope event differs from its record")
        envelope = AuthorizedRuleEvent(
            event=event,
            authorization_record=record,
            authorizer_signature_base64=data["authorizer_signature_base64"],
            schema_version=data["schema_version"],
        )
    except AuthorizationError:
        raise
    except (TypeError, ValueError) as exc:
        raise AuthorizationError("ENVELOPE_INVALID", "invalid envelope") from exc
    if encode_authorized_rule_event(envelope) != raw:
        _fail("NON_CANONICAL", "authorized event is not canonical JSON")
    return envelope


__all__ = [
    "AUTHORIZATION_SCHEMA_VERSION",
    "AuthorizationCommand",
    "AuthorizationError",
    "AuthorizationOrigin",
    "AuthorizationPolicy",
    "AuthorizationPolicyArchive",
    "AuthorizationRecord",
    "AuthorizedRuleEvent",
    "KeyRevocationStatus",
    "MAX_AUTHORIZATION_BYTES",
    "MAX_AUTHORIZATION_JSON_DEPTH",
    "MAX_ASSESSMENT_POLICY_FINGERPRINTS",
    "PrincipalRole",
    "ROLE_EVENT_ALLOWLISTS",
    "SignedAuthorizationCommand",
    "SignedPolicyAssessment",
    "TrustedActorKey",
    "TrustedAssessmentKey",
    "TrustedAuthorizerKey",
    "TrustedKeyKind",
    "authorize_rule_event",
    "encode_authorization_command",
    "encode_authorized_rule_event",
    "parse_authorized_rule_event",
    "sign_authorization_command",
    "sign_policy_assessment",
    "verify_authorized_rule_event",
]
