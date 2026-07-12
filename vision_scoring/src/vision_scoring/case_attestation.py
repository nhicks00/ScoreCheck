"""Trusted provenance for one exact non-authoritative scorer-copilot case.

The producer signature proves which protected assessment key assembled the
exact case bytes.  It deliberately does not create a rule event, authorization
command, authorized envelope, or score transition.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authorization import (
    AuthorizationError,
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    TrustedAssessmentKey,
    TrustedKeyKind,
)
from .domain_events import MAX_SEQUENCE_NUMBER
from .review_contracts import (
    MAX_REVIEW_JSON_CONTAINERS,
    MAX_REVIEW_JSON_DEPTH,
    MAX_REVIEW_JSON_NODES,
    MAX_REVIEW_RECORD_BYTES,
    ReviewContractError,
    ScorerCopilotCase,
    encode_scorer_copilot_case,
    parse_scorer_copilot_case,
)


CASE_ATTESTATION_SCHEMA_VERSION = "1.0"

_CASE_PRODUCER_SIGNING_DOMAIN = (
    b"multicourt-vision-scoring:scorer-copilot-case-producer:v1\x00"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_SIGNED_CASE_FIELDS = frozenset(
    {
        "assessment_key_id",
        "assessor_id",
        "authorization_policy_fingerprint",
        "case",
        "case_fingerprint",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
        "trust_domain_id",
    }
)


class CaseAttestationError(ValueError):
    """A strict case-attestation failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaseAttestationError(code, message)


def _stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(
            f"{field_name} must be a non-negative signed 64-bit integer"
        )
    return value


def _canonical_base64(value: object, field_name: str) -> bytes:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if len(raw) != 64 or base64.b64encode(raw).decode("ascii") != value:
        raise ValueError(f"{field_name} must encode exactly 64 bytes")
    return raw


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


def _fingerprint(value: Mapping[str, Any], label: str) -> str:
    return hashlib.sha256(_canonical_json_bytes(value, label)).hexdigest()


@dataclass(frozen=True, slots=True)
class SignedScorerCopilotCase:
    """One exact case and its detached protected-producer signature."""

    case: ScorerCopilotCase
    case_fingerprint: str
    assessor_id: str
    assessment_key_id: str
    authorization_policy_fingerprint: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = CASE_ATTESTATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CASE_ATTESTATION_SCHEMA_VERSION:
            raise ValueError("unsupported signed scorer-copilot case schema")
        if type(self.case) is not ScorerCopilotCase:
            raise ValueError("case must be an exact ScorerCopilotCase")
        _sha256(self.case_fingerprint, "case_fingerprint")
        if self.case_fingerprint != self.case.fingerprint():
            raise ValueError("case_fingerprint does not bind the exact case")
        _stable_id(self.assessor_id, "assessor_id")
        _stable_id(self.assessment_key_id, "assessment_key_id")
        _sha256(
            self.authorization_policy_fingerprint,
            "authorization_policy_fingerprint",
        )
        _stable_id(self.trust_domain_id, "trust_domain_id")
        _timestamp(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(self.signature_base64, "signature_base64")
        _canonical_json_bytes(self.canonical_dict(), "signed scorer-copilot case")

    @staticmethod
    def attestation_dict(
        *,
        case: ScorerCopilotCase,
        case_fingerprint: str,
        assessor_id: str,
        assessment_key_id: str,
        authorization_policy_fingerprint: str,
        trust_domain_id: str,
        signed_at_ns: int,
    ) -> dict[str, object]:
        return {
            "assessment_key_id": assessment_key_id,
            "assessor_id": assessor_id,
            "authorization_policy_fingerprint": (
                authorization_policy_fingerprint
            ),
            "case": case.canonical_dict(),
            "case_fingerprint": case_fingerprint,
            "schema_version": CASE_ATTESTATION_SCHEMA_VERSION,
            "signed_at_ns": signed_at_ns,
            "trust_domain_id": trust_domain_id,
        }

    def unsigned_canonical_dict(self) -> dict[str, object]:
        return self.attestation_dict(
            case=self.case,
            case_fingerprint=self.case_fingerprint,
            assessor_id=self.assessor_id,
            assessment_key_id=self.assessment_key_id,
            authorization_policy_fingerprint=(
                self.authorization_policy_fingerprint
            ),
            trust_domain_id=self.trust_domain_id,
            signed_at_ns=self.signed_at_ns,
        )

    def canonical_dict(self) -> dict[str, object]:
        value = self.unsigned_canonical_dict()
        value["signature_base64"] = self.signature_base64
        return value

    def fingerprint(self) -> str:
        return _fingerprint(
            self.canonical_dict(),
            "signed scorer-copilot case",
        )


def _signing_message(value: Mapping[str, Any]) -> bytes:
    return _CASE_PRODUCER_SIGNING_DOMAIN + _canonical_json_bytes(
        value,
        "scorer-copilot case producer attestation",
    )


def _case_time_bounds(case: ScorerCopilotCase) -> tuple[int, int]:
    lower = max(
        case.assessment.causal_cutoff_timestamp_ns,
        *(clip.manifest.end_timestamp_ns for clip in case.clips),
    )
    if case.signed_assessment is not None:
        lower = max(lower, case.signed_assessment.signed_at_ns)
    return lower, case.opened_at_ns


def _check_case_time(case: ScorerCopilotCase, signed_at_ns: int) -> None:
    lower, upper = _case_time_bounds(case)
    if not lower <= signed_at_ns <= upper:
        _fail(
            "CASE_PRODUCER_TIME",
            "producer signature must follow all case inputs and not exceed case open",
        )


def _resolve_policy(
    archive: AuthorizationPolicyArchive,
    fingerprint: str,
) -> AuthorizationPolicy:
    try:
        return archive.resolve_policy(fingerprint)
    except AuthorizationError as exc:
        raise CaseAttestationError(
            "POLICY_UNTRUSTED",
            "producer policy is not retained by the protected archive",
        ) from exc


def _assessment_key(
    policy: AuthorizationPolicy,
    *,
    assessor_id: str,
    assessment_key_id: str,
) -> TrustedAssessmentKey:
    matches = tuple(
        key
        for key in policy.assessment_keys
        if key.assessor_id == assessor_id and key.key_id == assessment_key_id
    )
    if len(matches) != 1:
        _fail(
            "ASSESSMENT_KEY_UNTRUSTED",
            "producer assessment key is not retained in the bound policy",
        )
    return matches[0]


def _public_key_sha256(key: TrustedAssessmentKey) -> str:
    return hashlib.sha256(base64.b64decode(key.public_key_base64)).hexdigest()


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
            "CASE_PRODUCER_SCOPE_MISMATCH",
            "producer trust scope does not match the exact case",
        )


def _check_archive_revocation(
    archive: AuthorizationPolicyArchive,
    key: TrustedAssessmentKey,
    *,
    revoked_as_of_ns: int,
) -> None:
    matches = tuple(
        status
        for status in archive.key_revocations
        if status.key_kind is TrustedKeyKind.ASSESSMENT
        and status.principal_id == key.assessor_id
        and status.key_id == key.key_id
        and status.public_key_sha256 == _public_key_sha256(key)
    )
    if len(matches) != 1:
        _fail(
            "ASSESSMENT_KEY_STATUS_MISSING",
            "producer key lacks exact current revocation status",
        )
    revoked_at_ns = matches[0].revoked_at_ns
    if revoked_at_ns is not None and revoked_at_ns <= revoked_as_of_ns:
        _fail("ASSESSMENT_KEY_REVOKED", "producer key is currently revoked")


def _check_key_use(
    *,
    archive: AuthorizationPolicyArchive,
    policy: AuthorizationPolicy,
    key: TrustedAssessmentKey,
    signed_at_ns: int,
    revoked_as_of_ns: int,
) -> None:
    if not policy.is_active(signed_at_ns):
        _fail("POLICY_INACTIVE", "producer policy was not active when signed")
    if not key.valid_from_ns <= signed_at_ns <= key.valid_until_ns:
        _fail(
            "ASSESSMENT_KEY_INACTIVE",
            "producer assessment key was not active when signed",
        )
    if key.revoked_at_ns is not None and key.revoked_at_ns <= revoked_as_of_ns:
        _fail("ASSESSMENT_KEY_REVOKED", "producer key is revoked")
    _check_archive_revocation(
        archive,
        key,
        revoked_as_of_ns=revoked_as_of_ns,
    )


def sign_scorer_copilot_case(
    *,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    assessor_id: str,
    assessment_key_id: str,
    signed_at_ns: int,
    assessment_private_key: Ed25519PrivateKey,
) -> SignedScorerCopilotCase:
    """Sign exact case provenance with the current protected policy."""

    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be an exact AuthorizationPolicyArchive")
    _stable_id(assessor_id, "assessor_id")
    _stable_id(assessment_key_id, "assessment_key_id")
    signed_at_ns = _timestamp(signed_at_ns, "signed_at_ns")
    if not isinstance(assessment_private_key, Ed25519PrivateKey):
        raise ValueError("assessment_private_key must be Ed25519PrivateKey")
    _check_case_time(case, signed_at_ns)

    policy = policy_archive.current_policy
    _check_scope(
        case=case,
        archive=policy_archive,
        policy=policy,
        trust_domain_id=policy.trust_domain_id,
    )
    key = _assessment_key(
        policy,
        assessor_id=assessor_id,
        assessment_key_id=assessment_key_id,
    )
    _check_key_use(
        archive=policy_archive,
        policy=policy,
        key=key,
        signed_at_ns=signed_at_ns,
        revoked_as_of_ns=signed_at_ns,
    )
    case_fingerprint = case.fingerprint()
    attestation = SignedScorerCopilotCase.attestation_dict(
        case=case,
        case_fingerprint=case_fingerprint,
        assessor_id=assessor_id,
        assessment_key_id=assessment_key_id,
        authorization_policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
    )
    signature = assessment_private_key.sign(_signing_message(attestation))
    try:
        key.public_key.verify(signature, _signing_message(attestation))
    except InvalidSignature as exc:
        raise CaseAttestationError(
            "PRIVATE_KEY_MISMATCH",
            "private key does not match the protected producer key",
        ) from exc
    return SignedScorerCopilotCase(
        case=case,
        case_fingerprint=case_fingerprint,
        assessor_id=assessor_id,
        assessment_key_id=assessment_key_id,
        authorization_policy_fingerprint=policy.fingerprint(),
        trust_domain_id=policy.trust_domain_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _verify_signed_scorer_copilot_case(
    signed: SignedScorerCopilotCase,
    *,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
    revoked_as_of_ns: int,
) -> ScorerCopilotCase:
    """Shared exact verifier with an explicitly selected revocation horizon."""

    if type(signed) is not SignedScorerCopilotCase:
        _fail("SIGNED_TYPE", "signed scorer-copilot case must be exact")
    if type(case) is not ScorerCopilotCase:
        raise ValueError("case must be an exact ScorerCopilotCase")
    if type(policy_archive) is not AuthorizationPolicyArchive:
        raise ValueError("policy_archive must be an exact AuthorizationPolicyArchive")
    verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
    revoked_as_of_ns = _timestamp(revoked_as_of_ns, "revoked_as_of_ns")
    if not signed.signed_at_ns <= revoked_as_of_ns <= verified_at_ns:
        _fail(
            "CASE_PRODUCER_TIME",
            "revocation verification time must follow signing and not exceed verification",
        )
    if revoked_as_of_ns < case.opened_at_ns or verified_at_ns < case.opened_at_ns:
        _fail(
            "CASE_ADMISSION_TIME",
            "case acceptance and verification cannot predate case open",
        )
    if signed.case != case or signed.case_fingerprint != case.fingerprint():
        _fail("CASE_MISMATCH", "producer signature does not bind the exact case")
    _check_case_time(case, signed.signed_at_ns)
    if not policy_archive.current_policy.is_active(verified_at_ns):
        _fail(
            "POLICY_ARCHIVE_STALE",
            "protected archive has no current policy active at verification time",
        )

    policy = _resolve_policy(
        policy_archive,
        signed.authorization_policy_fingerprint,
    )
    _check_scope(
        case=case,
        archive=policy_archive,
        policy=policy,
        trust_domain_id=signed.trust_domain_id,
    )
    key = _assessment_key(
        policy,
        assessor_id=signed.assessor_id,
        assessment_key_id=signed.assessment_key_id,
    )
    _check_key_use(
        archive=policy_archive,
        policy=policy,
        key=key,
        signed_at_ns=signed.signed_at_ns,
        revoked_as_of_ns=revoked_as_of_ns,
    )
    try:
        key.public_key.verify(
            _canonical_base64(signed.signature_base64, "signature_base64"),
            _signing_message(signed.unsigned_canonical_dict()),
        )
    except (InvalidSignature, ValueError) as exc:
        raise CaseAttestationError(
            "SIGNATURE_INVALID",
            "scorer-copilot case producer signature is invalid",
        ) from exc
    return signed.case


def verify_signed_scorer_copilot_case(
    signed: SignedScorerCopilotCase,
    *,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
) -> ScorerCopilotCase:
    """Verify case provenance using current revocation truth."""

    return _verify_signed_scorer_copilot_case(
        signed,
        case=case,
        policy_archive=policy_archive,
        verified_at_ns=verified_at_ns,
        revoked_as_of_ns=verified_at_ns,
    )


def verify_signed_scorer_copilot_case_at_historical_acceptance(
    signed: SignedScorerCopilotCase,
    *,
    case: ScorerCopilotCase,
    policy_archive: AuthorizationPolicyArchive,
    verified_at_ns: int,
    accepted_at_ns: int,
) -> ScorerCopilotCase:
    """Replay a prior acceptance using its persisted revocation horizon.

    This does not establish current usability.  Callers must separately invoke
    :func:`verify_signed_scorer_copilot_case` before a new presentation/action.
    """

    return _verify_signed_scorer_copilot_case(
        signed,
        case=case,
        policy_archive=policy_archive,
        verified_at_ns=verified_at_ns,
        revoked_as_of_ns=accepted_at_ns,
    )


class _DuplicateKey(ValueError):
    pass


def _object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise _DuplicateKey(key)
        value[key] = item
    return value


def _validate_json_shape(value: object, label: str) -> None:
    stack: list[tuple[object, int]] = [(value, 0)]
    nodes = 0
    containers = 0
    while stack:
        current, parent_depth = stack.pop()
        nodes += 1
        if nodes > MAX_REVIEW_JSON_NODES:
            _fail("JSON_NODES", f"{label} exceeds maximum JSON node count")
        if type(current) is dict or type(current) is list:
            containers += 1
            depth = parent_depth + 1
            if depth > MAX_REVIEW_JSON_DEPTH:
                _fail("JSON_DEPTH", f"{label} exceeds maximum JSON depth")
            if containers > MAX_REVIEW_JSON_CONTAINERS:
                _fail(
                    "JSON_CONTAINERS",
                    f"{label} exceeds maximum JSON container count",
                )
            children = current.values() if type(current) is dict else current
            stack.extend((item, depth) for item in children)


def _reject_noninteger_number(token: str) -> object:
    raise ValueError(f"non-integer JSON number is forbidden: {token}")


def _load_raw(raw: bytes, label: str) -> dict[str, object]:
    if type(raw) is not bytes:
        _fail("RAW_TYPE", f"{label} must be bytes")
    if not raw or len(raw) > MAX_REVIEW_RECORD_BYTES:
        _fail(
            "RAW_SIZE",
            f"{label} must contain 1..{MAX_REVIEW_RECORD_BYTES} bytes",
        )
    try:
        text = raw.decode("ascii", errors="strict")
    except UnicodeDecodeError as exc:
        raise CaseAttestationError(
            "INVALID_ASCII",
            f"{label} must be canonical ASCII JSON",
        ) from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=_reject_noninteger_number,
            parse_constant=_reject_noninteger_number,
        )
    except _DuplicateKey as exc:
        raise CaseAttestationError(
            "DUPLICATE_KEY",
            f"{label} contains duplicate key {exc}",
        ) from exc
    except RecursionError as exc:
        raise CaseAttestationError(
            "JSON_DEPTH",
            f"{label} exceeds parser nesting limits",
        ) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise CaseAttestationError(
            "INVALID_JSON",
            f"{label} is invalid JSON",
        ) from exc
    if type(value) is not dict:
        _fail("TOP_LEVEL_TYPE", f"{label} must be a JSON object")
    _validate_json_shape(value, label)
    return value


def _exact_dict(
    value: object,
    fields: frozenset[str],
    label: str,
) -> dict[str, object]:
    if type(value) is not dict:
        _fail("FIELD_TYPE", f"{label} must be an object")
    missing = sorted(fields - set(value))
    unknown = sorted(set(value) - fields)
    if missing or unknown:
        _fail(
            "FIELD_SET",
            f"{label} has missing={missing!r} unknown={unknown!r}",
        )
    return value


def encode_signed_scorer_copilot_case(value: SignedScorerCopilotCase) -> bytes:
    if type(value) is not SignedScorerCopilotCase:
        raise ValueError("value must be an exact SignedScorerCopilotCase")
    return _canonical_json_bytes(
        value.canonical_dict(),
        "signed scorer-copilot case",
    )


def parse_signed_scorer_copilot_case(raw: bytes) -> SignedScorerCopilotCase:
    label = "signed scorer-copilot case"
    data = _exact_dict(_load_raw(raw, label), _SIGNED_CASE_FIELDS, label)
    try:
        case_value = data["case"]
        if type(case_value) is not dict:
            _fail("FIELD_TYPE", f"{label}.case must be an object")
        case = parse_scorer_copilot_case(
            _canonical_json_bytes(case_value, f"{label}.case")
        )
        signed = SignedScorerCopilotCase(
            case=case,
            case_fingerprint=data["case_fingerprint"],
            assessor_id=data["assessor_id"],
            assessment_key_id=data["assessment_key_id"],
            authorization_policy_fingerprint=(
                data["authorization_policy_fingerprint"]
            ),
            trust_domain_id=data["trust_domain_id"],
            signed_at_ns=data["signed_at_ns"],
            signature_base64=data["signature_base64"],
            schema_version=data["schema_version"],
        )
    except CaseAttestationError:
        raise
    except ReviewContractError as exc:
        raise CaseAttestationError(
            "RECORD_INVALID",
            f"{label} contains an invalid case",
        ) from exc
    except (TypeError, ValueError, KeyError) as exc:
        raise CaseAttestationError(
            "RECORD_INVALID",
            f"{label} is invalid",
        ) from exc
    if encode_signed_scorer_copilot_case(signed) != raw:
        _fail("NON_CANONICAL", f"{label} is not canonical")
    return signed


__all__ = [
    "CASE_ATTESTATION_SCHEMA_VERSION",
    "CaseAttestationError",
    "SignedScorerCopilotCase",
    "encode_signed_scorer_copilot_case",
    "parse_signed_scorer_copilot_case",
    "sign_scorer_copilot_case",
    "verify_signed_scorer_copilot_case",
    "verify_signed_scorer_copilot_case_at_historical_acceptance",
]
