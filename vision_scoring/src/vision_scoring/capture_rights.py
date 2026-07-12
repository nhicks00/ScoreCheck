"""Signed, bounded pre-capture rights grants for one exact match session.

This module authorizes capture-session processing, not future media bytes.  A
grant binds the people, roster commitment, cameras, venue, session, purposes,
and protected policy in force before capture.  Finalized segment bytes remain
subject to their own capture-integrity and exact-asset rights checks.

All APIs are pure: no filesystem, process, network, media, scoring, or event
store access occurs here.  A caller must obtain the trust snapshot and the
expected protected policy generation through a separately protected channel.
The caller must also supply ``verified_at_ns`` from a trusted, rollback-
protected deployment clock; backdated caller time is not freshness evidence.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .rights import ParticipantAgeStatus, PermittedUse, RightsBasis


CAPTURE_RIGHTS_SCHEMA_VERSION = "1.0"
CAPTURE_RIGHTS_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:capture-session-rights-grant:v1"
)
CAPTURE_OPERATION_REQUIRED_USES = (
    PermittedUse.ASSISTIVE_SCORING_PROCESSING,
    PermittedUse.SCORER_COPILOT_REVIEW,
)

MAX_CAPTURE_RIGHTS_JSON_BYTES = 256 * 1024
MAX_CAPTURE_RIGHTS_JSON_DEPTH = 16
MAX_CAPTURE_RIGHTS_JSON_NODES = 4_096
MAX_CAPTURE_RIGHTS_JSON_CONTAINERS = 1_024
MAX_CAMERA_IDS = 16
MAX_PARTICIPANT_IDS = 64
MAX_EVIDENCE_SHA256S = 128
MAX_PERMITTED_USES = len(PermittedUse)
MAX_GEOGRAPHIES = 64
MAX_TRUST_KEYS = 64
MAX_CURRENT_GRANTS = 256
MAX_REVOKED_GRANTS = 512
MAX_SIGNED_64 = (1 << 63) - 1

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")

_GRANT_FIELDS = frozenset(
    {
        "basis",
        "camera_ids",
        "capture_session_id",
        "evidence_sha256s",
        "geography_scope",
        "grant_id",
        "license_id",
        "match_id",
        "owner_or_licensor",
        "participant_age_status",
        "participant_ids",
        "participant_release_sha256s",
        "permitted_uses",
        "protected_policy_fingerprint",
        "protected_policy_generation",
        "reviewed_at_ns",
        "reviewer_id",
        "roster_scope_sha256",
        "schema_version",
        "valid_from_ns",
        "valid_until_ns",
        "venue_id",
    }
)
_ATTESTATION_FIELDS = frozenset(
    {
        "grant_sha256",
        "key_id",
        "key_role",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
        "trust_domain_id",
    }
)
_KEY_FIELDS = frozenset(
    {
        "key_id",
        "key_role",
        "public_key_base64",
        "reviewer_id",
        "revoked_at_ns",
        "valid_from_ns",
        "valid_until_ns",
    }
)
_CURRENT_GRANT_FIELDS = frozenset(
    {
        "capture_session_id",
        "grant_id",
        "grant_sha256",
        "match_id",
    }
)
_TRUST_SNAPSHOT_FIELDS = frozenset(
    {
        "current_grants",
        "keys",
        "protected_policy_fingerprint",
        "protected_policy_generation",
        "revoked_grant_sha256s",
        "schema_version",
        "trust_domain_id",
    }
)


class CaptureRightsError(ValueError):
    """A capture-rights construction or verification failure with a code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class CaptureRightsKeyRole(str, Enum):
    """The only key role accepted by this signing domain."""

    CAPTURE_SESSION_RIGHTS_GRANT_SIGNER = (
        "CAPTURE_SESSION_RIGHTS_GRANT_SIGNER"
    )


def _fail(code: str, message: str) -> None:
    raise CaptureRightsError(code, message)


def _require_exact_int(
    value: object,
    field_name: str,
    *,
    minimum: int = 0,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{field_name} must be an integer in [{minimum}, {maximum}]"
        )
    return value


def _require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _require_bounded_nfc_text(value: object, field_name: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > 256
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise ValueError(
            f"{field_name} must be bounded, non-empty, trimmed UTF-8 NFC text"
        )
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(
            f"{field_name} must be bounded, non-empty, trimmed UTF-8 NFC text"
        ) from exc
    return value


def _require_canonical_tuple(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
    item_validator: Any,
) -> tuple[Any, ...]:
    if type(value) is not tuple or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{field_name} must be an immutable tuple with {minimum} to {maximum} items"
        )
    for item in value:
        item_validator(item, f"{field_name} item")
    if value != tuple(sorted(value, key=lambda item: item.value if isinstance(item, Enum) else item)):
        raise ValueError(f"{field_name} must be sorted in canonical order")
    if len(set(value)) != len(value):
        raise ValueError(f"{field_name} cannot contain duplicates")
    return value


def _require_country(value: object, field_name: str) -> str:
    if type(value) is not str or _COUNTRY_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ISO alpha-2 country code")
    return value


def _require_geography(value: object, field_name: str) -> str:
    if type(value) is not str or (
        value != "GLOBAL" and _COUNTRY_RE.fullmatch(value) is None
    ):
        raise ValueError(f"{field_name} must be GLOBAL or an ISO alpha-2 code")
    return value


def _require_permitted_use(value: object, field_name: str) -> PermittedUse:
    if type(value) is not PermittedUse:
        raise ValueError(f"{field_name} must be a PermittedUse")
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


def _canonical_json_bytes(value: Mapping[str, Any], *, label: str) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if len(encoded) > MAX_CAPTURE_RIGHTS_JSON_BYTES:
        raise ValueError(
            f"{label} exceeds {MAX_CAPTURE_RIGHTS_JSON_BYTES} bytes"
        )
    return encoded


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DUPLICATE_JSON_KEY", f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite(token: str) -> None:
    _fail("NONFINITE_JSON_NUMBER", f"nonfinite JSON number: {token}")


def _parse_bounded_json_integer(token: str) -> int:
    if len(token) > 19:
        _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    try:
        value = int(token, 10)
    except ValueError as exc:
        _fail("INVALID_JSON_NUMBER", "JSON integer is invalid")
        raise AssertionError from exc
    if not 0 <= value <= MAX_SIGNED_64:
        _fail("JSON_INTEGER_RANGE", "JSON integer must be nonnegative signed 64-bit")
    return value


def _reject_json_float(token: str) -> None:
    _fail("INVALID_JSON_NUMBER", f"floating JSON number is forbidden: {token}")


def _measure_json(value: object, *, depth: int = 1) -> tuple[int, int]:
    if depth > MAX_CAPTURE_RIGHTS_JSON_DEPTH:
        _fail("JSON_DEPTH_EXCEEDED", "capture-rights JSON is too deeply nested")
    nodes = 1
    containers = 0
    if type(value) is dict:
        containers = 1
        for key, item in value.items():
            if type(key) is not str:
                _fail("INVALID_JSON_KEY", "JSON object keys must be strings")
            child_nodes, child_containers = _measure_json(item, depth=depth + 1)
            nodes += child_nodes
            containers += child_containers
    elif type(value) is list:
        containers = 1
        for item in value:
            child_nodes, child_containers = _measure_json(item, depth=depth + 1)
            nodes += child_nodes
            containers += child_containers
    elif value is not None and type(value) not in (str, int, bool):
        _fail("INVALID_JSON_VALUE", "unsupported JSON value")
    if nodes > MAX_CAPTURE_RIGHTS_JSON_NODES:
        _fail("JSON_NODE_LIMIT_EXCEEDED", "capture-rights JSON has too many nodes")
    if containers > MAX_CAPTURE_RIGHTS_JSON_CONTAINERS:
        _fail(
            "JSON_CONTAINER_LIMIT_EXCEEDED",
            "capture-rights JSON has too many containers",
        )
    return nodes, containers


def _strict_json_object(raw: bytes, *, label: str) -> Mapping[str, Any]:
    if type(raw) is not bytes:
        _fail("JSON_TYPE", f"{label} must be exact bytes")
    if not raw or len(raw) > MAX_CAPTURE_RIGHTS_JSON_BYTES:
        _fail(
            "JSON_SIZE",
            f"{label} must be 1 to {MAX_CAPTURE_RIGHTS_JSON_BYTES} bytes",
        )
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite,
            parse_int=_parse_bounded_json_integer,
            parse_float=_reject_json_float,
        )
    except CaptureRightsError:
        raise
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("INVALID_JSON", f"{label} must be valid UTF-8 JSON")
        raise AssertionError from exc
    try:
        _measure_json(value)
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    if type(value) is not dict:
        _fail("JSON_ROOT", f"{label} root must be an object")
    return value


def _require_exact_fields(
    value: Mapping[str, Any],
    fields: frozenset[str],
    label: str,
) -> None:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an exact JSON object")
    if any(type(key) is not str for key in value):
        raise ValueError(f"{label} keys must be exact strings")
    actual = set(value)
    unknown = sorted(actual - fields)
    missing = sorted(fields - actual)
    if unknown:
        raise ValueError(f"{label} has unsupported fields: {', '.join(unknown)}")
    if missing:
        raise ValueError(f"{label} is missing fields: {', '.join(missing)}")


def _exact_list(value: Mapping[str, Any], field_name: str, label: str) -> list[Any]:
    selected = value[field_name]
    if type(selected) is not list:
        raise ValueError(f"{label}.{field_name} must be a JSON array")
    return selected


def _enum_from_json(enum_type: type[Enum], value: object, field_name: str) -> Enum:
    if type(value) is not str:
        raise ValueError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} has an unsupported enum value") from exc


@dataclass(frozen=True, slots=True)
class CaptureSessionRightsGrant:
    """A reviewed preauthorization for one exact capture session and roster.

    Every ``*_ns`` value is a nonnegative Unix-epoch nanosecond timestamp.
    """

    grant_id: str
    match_id: str
    capture_session_id: str
    venue_id: str
    camera_ids: tuple[str, ...]
    roster_scope_sha256: str
    participant_ids: tuple[str, ...]
    valid_from_ns: int
    valid_until_ns: int
    geography_scope: tuple[str, ...]
    permitted_uses: tuple[PermittedUse, ...]
    basis: RightsBasis
    owner_or_licensor: str
    license_id: str | None
    participant_age_status: ParticipantAgeStatus
    participant_release_sha256s: tuple[str, ...]
    evidence_sha256s: tuple[str, ...]
    reviewer_id: str
    reviewed_at_ns: int
    protected_policy_fingerprint: str
    protected_policy_generation: int

    def __post_init__(self) -> None:
        for field_name in (
            "grant_id",
            "match_id",
            "capture_session_id",
            "venue_id",
            "reviewer_id",
        ):
            _require_stable_id(getattr(self, field_name), field_name)
        _require_canonical_tuple(
            self.camera_ids,
            "camera_ids",
            minimum=1,
            maximum=MAX_CAMERA_IDS,
            item_validator=_require_stable_id,
        )
        _require_sha256(self.roster_scope_sha256, "roster_scope_sha256")
        _require_canonical_tuple(
            self.participant_ids,
            "participant_ids",
            minimum=1,
            maximum=MAX_PARTICIPANT_IDS,
            item_validator=_require_stable_id,
        )
        valid_from = _require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = _require_exact_int(self.valid_until_ns, "valid_until_ns")
        reviewed_at = _require_exact_int(self.reviewed_at_ns, "reviewed_at_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if reviewed_at > valid_until:
            raise ValueError("reviewed_at_ns cannot follow valid_until_ns")
        _require_canonical_tuple(
            self.geography_scope,
            "geography_scope",
            minimum=1,
            maximum=MAX_GEOGRAPHIES,
            item_validator=_require_geography,
        )
        if "GLOBAL" in self.geography_scope and self.geography_scope != ("GLOBAL",):
            raise ValueError("GLOBAL cannot be combined with country codes")
        _require_canonical_tuple(
            self.permitted_uses,
            "permitted_uses",
            minimum=1,
            maximum=MAX_PERMITTED_USES,
            item_validator=_require_permitted_use,
        )
        if self.permitted_uses != CAPTURE_OPERATION_REQUIRED_USES:
            raise ValueError(
                "a future-byte-free capture grant permits exactly the two "
                "operational capture uses"
            )
        if type(self.basis) is not RightsBasis:
            raise ValueError("basis must be a RightsBasis")
        _require_bounded_nfc_text(self.owner_or_licensor, "owner_or_licensor")
        if self.license_id is not None:
            _require_stable_id(self.license_id, "license_id")
        if self.basis is RightsBasis.LICENSED and self.license_id is None:
            raise ValueError("LICENSED grant requires license_id")
        if self.basis is not RightsBasis.LICENSED and self.license_id is not None:
            raise ValueError("license_id is allowed only for LICENSED grants")
        if type(self.participant_age_status) is not ParticipantAgeStatus:
            raise ValueError(
                "participant_age_status must be a ParticipantAgeStatus"
            )
        _require_canonical_tuple(
            self.participant_release_sha256s,
            "participant_release_sha256s",
            minimum=0,
            maximum=MAX_EVIDENCE_SHA256S,
            item_validator=_require_sha256,
        )
        _require_canonical_tuple(
            self.evidence_sha256s,
            "evidence_sha256s",
            minimum=1,
            maximum=MAX_EVIDENCE_SHA256S,
            item_validator=_require_sha256,
        )
        if self.participant_age_status not in {
            ParticipantAgeStatus.NO_MINORS,
            ParticipantAgeStatus.MINORS_CLEARED,
        }:
            raise ValueError("capture grant requires known participant/minor clearance")
        if (
            self.participant_age_status is ParticipantAgeStatus.MINORS_CLEARED
            and not self.participant_release_sha256s
        ):
            raise ValueError("MINORS_CLEARED requires participant release evidence")
        _require_sha256(
            self.protected_policy_fingerprint,
            "protected_policy_fingerprint",
        )
        _require_exact_int(
            self.protected_policy_generation,
            "protected_policy_generation",
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "basis": self.basis.value,
            "camera_ids": list(self.camera_ids),
            "capture_session_id": self.capture_session_id,
            "evidence_sha256s": list(self.evidence_sha256s),
            "geography_scope": list(self.geography_scope),
            "grant_id": self.grant_id,
            "license_id": self.license_id,
            "match_id": self.match_id,
            "owner_or_licensor": self.owner_or_licensor,
            "participant_age_status": self.participant_age_status.value,
            "participant_ids": list(self.participant_ids),
            "participant_release_sha256s": list(
                self.participant_release_sha256s
            ),
            "permitted_uses": [value.value for value in self.permitted_uses],
            "protected_policy_fingerprint": self.protected_policy_fingerprint,
            "protected_policy_generation": self.protected_policy_generation,
            "reviewed_at_ns": self.reviewed_at_ns,
            "reviewer_id": self.reviewer_id,
            "roster_scope_sha256": self.roster_scope_sha256,
            "schema_version": CAPTURE_RIGHTS_SCHEMA_VERSION,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
            "venue_id": self.venue_id,
        }

    def canonical_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_canonical_dict(),
            label="capture session rights grant",
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class CaptureSessionRightsGrantAttestation:
    """Detached Ed25519 signature over one canonical session grant."""

    grant_sha256: str
    key_id: str
    key_role: CaptureRightsKeyRole
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str

    def __post_init__(self) -> None:
        _require_sha256(self.grant_sha256, "grant_sha256")
        _require_stable_id(self.key_id, "key_id")
        if type(self.key_role) is not CaptureRightsKeyRole:
            raise ValueError("key_role must be a CaptureRightsKeyRole")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_exact_int(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    @property
    def signature(self) -> bytes:
        return _canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "grant_sha256": self.grant_sha256,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "schema_version": CAPTURE_RIGHTS_SCHEMA_VERSION,
            "signature_base64": self.signature_base64,
            "signed_at_ns": self.signed_at_ns,
            "trust_domain_id": self.trust_domain_id,
        }

    def canonical_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_canonical_dict(),
            label="capture session rights grant attestation",
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class TrustedCaptureRightsReviewerKey:
    key_id: str
    reviewer_id: str
    key_role: CaptureRightsKeyRole
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None

    def __post_init__(self) -> None:
        _require_stable_id(self.key_id, "key_id")
        _require_stable_id(self.reviewer_id, "reviewer_id")
        if type(self.key_role) is not CaptureRightsKeyRole:
            raise ValueError("key_role must be a CaptureRightsKeyRole")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = _require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("valid_until_ns cannot precede valid_from_ns")
        if self.revoked_at_ns is not None:
            _require_exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "public_key_base64": self.public_key_base64,
            "reviewer_id": self.reviewer_id,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }


@dataclass(frozen=True, slots=True)
class CurrentCaptureSessionRightsGrant:
    grant_id: str
    match_id: str
    capture_session_id: str
    grant_sha256: str

    def __post_init__(self) -> None:
        _require_stable_id(self.grant_id, "grant_id")
        _require_stable_id(self.match_id, "match_id")
        _require_stable_id(self.capture_session_id, "capture_session_id")
        _require_sha256(self.grant_sha256, "grant_sha256")

    def to_canonical_dict(self) -> dict[str, str]:
        return {
            "capture_session_id": self.capture_session_id,
            "grant_id": self.grant_id,
            "grant_sha256": self.grant_sha256,
            "match_id": self.match_id,
        }


@dataclass(frozen=True, slots=True)
class CaptureRightsTrustSnapshot:
    """A protected, current trust snapshot supplied outside capture input."""

    trust_domain_id: str
    protected_policy_fingerprint: str
    protected_policy_generation: int
    keys: tuple[TrustedCaptureRightsReviewerKey, ...]
    current_grants: tuple[CurrentCaptureSessionRightsGrant, ...]
    revoked_grant_sha256s: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_sha256(
            self.protected_policy_fingerprint,
            "protected_policy_fingerprint",
        )
        _require_exact_int(
            self.protected_policy_generation,
            "protected_policy_generation",
        )
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_TRUST_KEYS
            or any(type(value) is not TrustedCaptureRightsReviewerKey for value in self.keys)
        ):
            raise ValueError("keys must be a bounded immutable trusted-key tuple")
        if self.keys != tuple(sorted(self.keys, key=lambda value: value.key_id)):
            raise ValueError("keys must be sorted by key_id")
        if len({value.key_id for value in self.keys}) != len(self.keys):
            raise ValueError("key IDs cannot contain duplicates")
        if len({value.public_key_base64 for value in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot be assigned to multiple keys")
        if (
            type(self.current_grants) is not tuple
            or len(self.current_grants) > MAX_CURRENT_GRANTS
            or any(type(value) is not CurrentCaptureSessionRightsGrant for value in self.current_grants)
        ):
            raise ValueError("current_grants must be a bounded immutable tuple")
        current_order = tuple(
            sorted(
                self.current_grants,
                key=lambda value: (
                    value.match_id,
                    value.capture_session_id,
                    value.grant_id,
                ),
            )
        )
        if self.current_grants != current_order:
            raise ValueError("current_grants must be sorted in canonical order")
        identities = [
            (value.match_id, value.capture_session_id)
            for value in self.current_grants
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("each match/session may have only one current grant")
        if len({value.grant_id for value in self.current_grants}) != len(
            self.current_grants
        ):
            raise ValueError("current grant IDs cannot contain duplicates")
        if len({value.grant_sha256 for value in self.current_grants}) != len(
            self.current_grants
        ):
            raise ValueError("one canonical grant cannot be current for multiple sessions")
        _require_canonical_tuple(
            self.revoked_grant_sha256s,
            "revoked_grant_sha256s",
            minimum=0,
            maximum=MAX_REVOKED_GRANTS,
            item_validator=_require_sha256,
        )
        if {value.grant_sha256 for value in self.current_grants} & set(
            self.revoked_grant_sha256s
        ):
            raise ValueError("a revoked grant cannot also be current")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "current_grants": [value.to_canonical_dict() for value in self.current_grants],
            "keys": [value.to_canonical_dict() for value in self.keys],
            "protected_policy_fingerprint": self.protected_policy_fingerprint,
            "protected_policy_generation": self.protected_policy_generation,
            "revoked_grant_sha256s": list(self.revoked_grant_sha256s),
            "schema_version": CAPTURE_RIGHTS_SCHEMA_VERSION,
            "trust_domain_id": self.trust_domain_id,
        }

    def canonical_json_bytes(self) -> bytes:
        return _canonical_json_bytes(
            self.to_canonical_dict(),
            label="capture rights trust snapshot",
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class VerifiedCaptureSessionRights:
    """Non-authoritative proof that one operation passed this pure verifier."""

    grant_sha256: str
    attestation_sha256: str
    trust_snapshot_sha256: str
    verified_at_ns: int
    match_id: str
    capture_session_id: str
    venue_id: str
    camera_ids: tuple[str, ...]
    roster_scope_sha256: str
    participant_ids: tuple[str, ...]
    geography: str
    required_uses: tuple[PermittedUse, ...]
    evidence_sha256s: tuple[str, ...]
    protected_policy_fingerprint: str
    protected_policy_generation: int

    def __post_init__(self) -> None:
        for field_name in (
            "grant_sha256",
            "attestation_sha256",
            "trust_snapshot_sha256",
            "roster_scope_sha256",
            "protected_policy_fingerprint",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_exact_int(self.verified_at_ns, "verified_at_ns")
        for field_name in ("match_id", "capture_session_id", "venue_id"):
            _require_stable_id(getattr(self, field_name), field_name)
        _require_canonical_tuple(
            self.camera_ids,
            "camera_ids",
            minimum=1,
            maximum=MAX_CAMERA_IDS,
            item_validator=_require_stable_id,
        )
        _require_canonical_tuple(
            self.participant_ids,
            "participant_ids",
            minimum=1,
            maximum=MAX_PARTICIPANT_IDS,
            item_validator=_require_stable_id,
        )
        _require_country(self.geography, "geography")
        _require_canonical_tuple(
            self.required_uses,
            "required_uses",
            minimum=2,
            maximum=MAX_PERMITTED_USES,
            item_validator=_require_permitted_use,
        )
        if self.required_uses != CAPTURE_OPERATION_REQUIRED_USES:
            raise ValueError(
                "required_uses must equal the two operational capture uses"
            )
        _require_canonical_tuple(
            self.evidence_sha256s,
            "evidence_sha256s",
            minimum=1,
            maximum=MAX_EVIDENCE_SHA256S * 2,
            item_validator=_require_sha256,
        )
        _require_exact_int(
            self.protected_policy_generation,
            "protected_policy_generation",
        )


def capture_session_rights_grant_signing_message(
    grant: CaptureSessionRightsGrant,
    *,
    key_id: str,
    key_role: CaptureRightsKeyRole,
    trust_domain_id: str,
    signed_at_ns: int,
) -> bytes:
    """Return the only bytes a capture-session rights key may sign."""

    if type(grant) is not CaptureSessionRightsGrant:
        raise ValueError("grant must be a CaptureSessionRightsGrant")
    _require_stable_id(key_id, "key_id")
    if type(key_role) is not CaptureRightsKeyRole:
        raise ValueError("key_role must be a CaptureRightsKeyRole")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _require_exact_int(signed_at_ns, "signed_at_ns")
    return _canonical_json_bytes(
        {
            "domain": CAPTURE_RIGHTS_SIGNING_DOMAIN,
            "grant": grant.to_canonical_dict(),
            "key_id": key_id,
            "key_role": key_role.value,
            "signed_at_ns": signed_at_ns,
            "trust_domain_id": trust_domain_id,
        },
        label="capture session rights grant signing message",
    )


def verify_capture_session_rights(
    grant: CaptureSessionRightsGrant,
    attestation: CaptureSessionRightsGrantAttestation,
    trust_snapshot: CaptureRightsTrustSnapshot,
    *,
    verified_at_ns: int,
    geography: str,
    match_id: str,
    capture_session_id: str,
    venue_id: str,
    camera_ids: tuple[str, ...],
    roster_scope_sha256: str,
    participant_ids: tuple[str, ...],
    required_uses: tuple[PermittedUse, ...],
    expected_trust_snapshot_sha256: str,
    expected_protected_policy_fingerprint: str,
    expected_protected_policy_generation: int,
) -> VerifiedCaptureSessionRights:
    """Verify current rights for one exact operational capture context.

    The expected policy values must come from protected configuration, never
    from a camera, grant, manifest, or request.  This function does not claim
    that a later segment exists or preauthorize any future segment hash.
    ``verified_at_ns`` must come from the coordinator's trusted non-rollback
    clock rather than from the grant, camera, or request.
    """

    if type(grant) is not CaptureSessionRightsGrant:
        _fail("CAPTURE_RIGHTS_GRANT_TYPE", "grant has the wrong exact type")
    if type(attestation) is not CaptureSessionRightsGrantAttestation:
        _fail(
            "CAPTURE_RIGHTS_ATTESTATION_TYPE",
            "attestation has the wrong exact type",
        )
    if type(trust_snapshot) is not CaptureRightsTrustSnapshot:
        _fail("CAPTURE_RIGHTS_TRUST_TYPE", "trust snapshot has the wrong exact type")

    verified_at = _require_exact_int(verified_at_ns, "verified_at_ns")
    _require_country(geography, "geography")
    for value, field_name in (
        (match_id, "match_id"),
        (capture_session_id, "capture_session_id"),
        (venue_id, "venue_id"),
    ):
        _require_stable_id(value, field_name)
    _require_canonical_tuple(
        camera_ids,
        "camera_ids",
        minimum=1,
        maximum=MAX_CAMERA_IDS,
        item_validator=_require_stable_id,
    )
    _require_sha256(roster_scope_sha256, "roster_scope_sha256")
    _require_canonical_tuple(
        participant_ids,
        "participant_ids",
        minimum=1,
        maximum=MAX_PARTICIPANT_IDS,
        item_validator=_require_stable_id,
    )
    _require_canonical_tuple(
        required_uses,
        "required_uses",
        minimum=2,
        maximum=MAX_PERMITTED_USES,
        item_validator=_require_permitted_use,
    )
    if required_uses != CAPTURE_OPERATION_REQUIRED_USES:
        _fail(
            "CAPTURE_RIGHTS_PURPOSE",
            "operational verification requires exactly assistive processing and "
            "scorer review",
        )
    _require_sha256(
        expected_trust_snapshot_sha256,
        "expected_trust_snapshot_sha256",
    )
    _require_sha256(
        expected_protected_policy_fingerprint,
        "expected_protected_policy_fingerprint",
    )
    _require_exact_int(
        expected_protected_policy_generation,
        "expected_protected_policy_generation",
    )

    if trust_snapshot.fingerprint() != expected_trust_snapshot_sha256:
        _fail(
            "CAPTURE_RIGHTS_TRUST_PIN",
            "trust snapshot does not match the protected fingerprint",
        )
    if (
        trust_snapshot.protected_policy_fingerprint
        != expected_protected_policy_fingerprint
        or trust_snapshot.protected_policy_generation
        != expected_protected_policy_generation
        or grant.protected_policy_fingerprint
        != expected_protected_policy_fingerprint
        or grant.protected_policy_generation
        != expected_protected_policy_generation
    ):
        _fail(
            "CAPTURE_RIGHTS_POLICY",
            "grant and trust snapshot must match the protected policy generation",
        )

    grant_sha256 = grant.fingerprint()
    if attestation.grant_sha256 != grant_sha256:
        _fail(
            "CAPTURE_RIGHTS_ATTESTATION_MISMATCH",
            "attestation does not name the exact canonical grant",
        )
    if grant_sha256 in trust_snapshot.revoked_grant_sha256s:
        _fail("CAPTURE_RIGHTS_GRANT_REVOKED", "capture rights grant is revoked")
    current = next(
        (
            value
            for value in trust_snapshot.current_grants
            if value.match_id == grant.match_id
            and value.capture_session_id == grant.capture_session_id
        ),
        None,
    )
    if current is None:
        _fail(
            "CAPTURE_RIGHTS_GRANT_UNTRUSTED",
            "trust snapshot has no current grant for this match/session",
        )
    if current.grant_id != grant.grant_id or current.grant_sha256 != grant_sha256:
        _fail(
            "CAPTURE_RIGHTS_GRANT_STALE",
            "grant is not the current grant for this match/session",
        )

    if attestation.trust_domain_id != trust_snapshot.trust_domain_id:
        _fail(
            "CAPTURE_RIGHTS_TRUST_DOMAIN",
            "attestation trust domain does not match the protected snapshot",
        )
    if (
        attestation.key_role
        is not CaptureRightsKeyRole.CAPTURE_SESSION_RIGHTS_GRANT_SIGNER
    ):
        _fail("CAPTURE_RIGHTS_KEY_ROLE", "attestation has the wrong key role")
    key = next(
        (value for value in trust_snapshot.keys if value.key_id == attestation.key_id),
        None,
    )
    if key is None:
        _fail("CAPTURE_RIGHTS_KEY_UNTRUSTED", "attestation key is not trusted")
    if key.key_role is not attestation.key_role:
        _fail("CAPTURE_RIGHTS_KEY_ROLE", "attestation and trusted key roles differ")
    if key.reviewer_id != grant.reviewer_id:
        _fail(
            "CAPTURE_RIGHTS_REVIEWER",
            "grant reviewer does not match the trusted key principal",
        )
    if not key.valid_from_ns <= attestation.signed_at_ns <= key.valid_until_ns:
        _fail(
            "CAPTURE_RIGHTS_KEY_DATE",
            "key was not valid when the grant was signed",
        )
    if key.revoked_at_ns is not None and verified_at >= key.revoked_at_ns:
        _fail("CAPTURE_RIGHTS_KEY_REVOKED", "capture rights key is revoked")
    if not grant.reviewed_at_ns <= attestation.signed_at_ns <= verified_at:
        _fail(
            "CAPTURE_RIGHTS_ATTESTATION_DATE",
            "signature must follow review and not postdate verification",
        )
    try:
        key.public_key.verify(
            attestation.signature,
            capture_session_rights_grant_signing_message(
                grant,
                key_id=attestation.key_id,
                key_role=attestation.key_role,
                trust_domain_id=attestation.trust_domain_id,
                signed_at_ns=attestation.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        _fail("CAPTURE_RIGHTS_SIGNATURE", "capture rights signature is invalid")
        raise AssertionError from exc

    if not grant.valid_from_ns <= verified_at <= grant.valid_until_ns:
        _fail("CAPTURE_RIGHTS_VALIDITY", "grant is not active at verification time")
    if "GLOBAL" not in grant.geography_scope and geography not in grant.geography_scope:
        _fail("CAPTURE_RIGHTS_GEOGRAPHY", "grant does not cover this geography")
    if match_id != grant.match_id:
        _fail("CAPTURE_RIGHTS_MATCH", "operation match differs from the grant")
    if capture_session_id != grant.capture_session_id:
        _fail("CAPTURE_RIGHTS_SESSION", "operation session differs from the grant")
    if venue_id != grant.venue_id:
        _fail("CAPTURE_RIGHTS_VENUE", "operation venue differs from the grant")
    if camera_ids != grant.camera_ids:
        _fail("CAPTURE_RIGHTS_CAMERAS", "operation cameras differ from the exact grant")
    if roster_scope_sha256 != grant.roster_scope_sha256:
        _fail(
            "CAPTURE_RIGHTS_ROSTER",
            "operation roster commitment differs from the grant",
        )
    if participant_ids != grant.participant_ids:
        _fail(
            "CAPTURE_RIGHTS_PARTICIPANTS",
            "operation participant scope differs from the grant",
        )
    if required_uses != grant.permitted_uses:
        _fail("CAPTURE_RIGHTS_PURPOSE", "grant does not cover every required use")
    if grant.participant_age_status not in {
        ParticipantAgeStatus.NO_MINORS,
        ParticipantAgeStatus.MINORS_CLEARED,
    } or (
        grant.participant_age_status is ParticipantAgeStatus.MINORS_CLEARED
        and not grant.participant_release_sha256s
    ):
        _fail(
            "CAPTURE_RIGHTS_MINOR_CLEARANCE",
            "participant/minor clearance is insufficient",
        )

    evidence = tuple(
        sorted(set(grant.evidence_sha256s) | set(grant.participant_release_sha256s))
    )
    return VerifiedCaptureSessionRights(
        grant_sha256=grant_sha256,
        attestation_sha256=attestation.fingerprint(),
        trust_snapshot_sha256=trust_snapshot.fingerprint(),
        verified_at_ns=verified_at,
        match_id=match_id,
        capture_session_id=capture_session_id,
        venue_id=venue_id,
        camera_ids=camera_ids,
        roster_scope_sha256=roster_scope_sha256,
        participant_ids=participant_ids,
        geography=geography,
        required_uses=required_uses,
        evidence_sha256s=evidence,
        protected_policy_fingerprint=expected_protected_policy_fingerprint,
        protected_policy_generation=expected_protected_policy_generation,
    )


def capture_session_rights_grant_from_dict(
    value: Mapping[str, Any],
) -> CaptureSessionRightsGrant:
    _require_exact_fields(value, _GRANT_FIELDS, "capture session rights grant")
    if value["schema_version"] != CAPTURE_RIGHTS_SCHEMA_VERSION:
        raise ValueError(
            "capture session rights grant schema_version must be "
            f"{CAPTURE_RIGHTS_SCHEMA_VERSION}"
        )
    return CaptureSessionRightsGrant(
        grant_id=value["grant_id"],
        match_id=value["match_id"],
        capture_session_id=value["capture_session_id"],
        venue_id=value["venue_id"],
        camera_ids=tuple(_exact_list(value, "camera_ids", "grant")),
        roster_scope_sha256=value["roster_scope_sha256"],
        participant_ids=tuple(_exact_list(value, "participant_ids", "grant")),
        valid_from_ns=value["valid_from_ns"],
        valid_until_ns=value["valid_until_ns"],
        geography_scope=tuple(
            _exact_list(value, "geography_scope", "grant")
        ),
        permitted_uses=tuple(
            _enum_from_json(PermittedUse, item, "permitted_uses item")
            for item in _exact_list(value, "permitted_uses", "grant")
        ),
        basis=_enum_from_json(RightsBasis, value["basis"], "basis"),
        owner_or_licensor=value["owner_or_licensor"],
        license_id=value["license_id"],
        participant_age_status=_enum_from_json(
            ParticipantAgeStatus,
            value["participant_age_status"],
            "participant_age_status",
        ),
        participant_release_sha256s=tuple(
            _exact_list(value, "participant_release_sha256s", "grant")
        ),
        evidence_sha256s=tuple(
            _exact_list(value, "evidence_sha256s", "grant")
        ),
        reviewer_id=value["reviewer_id"],
        reviewed_at_ns=value["reviewed_at_ns"],
        protected_policy_fingerprint=value["protected_policy_fingerprint"],
        protected_policy_generation=value["protected_policy_generation"],
    )


def capture_session_rights_grant_from_json_bytes(
    raw: bytes,
) -> CaptureSessionRightsGrant:
    value = capture_session_rights_grant_from_dict(
        _strict_json_object(raw, label="capture session rights grant")
    )
    if raw != value.canonical_json_bytes():
        _fail(
            "NONCANONICAL_JSON",
            "capture session rights grant bytes are not canonical",
        )
    return value


def capture_session_rights_grant_attestation_from_dict(
    value: Mapping[str, Any],
) -> CaptureSessionRightsGrantAttestation:
    _require_exact_fields(
        value,
        _ATTESTATION_FIELDS,
        "capture session rights grant attestation",
    )
    if value["schema_version"] != CAPTURE_RIGHTS_SCHEMA_VERSION:
        raise ValueError(
            "capture session rights grant attestation schema_version must be "
            f"{CAPTURE_RIGHTS_SCHEMA_VERSION}"
        )
    return CaptureSessionRightsGrantAttestation(
        grant_sha256=value["grant_sha256"],
        key_id=value["key_id"],
        key_role=_enum_from_json(
            CaptureRightsKeyRole,
            value["key_role"],
            "key_role",
        ),
        trust_domain_id=value["trust_domain_id"],
        signed_at_ns=value["signed_at_ns"],
        signature_base64=value["signature_base64"],
    )


def capture_session_rights_grant_attestation_from_json_bytes(
    raw: bytes,
) -> CaptureSessionRightsGrantAttestation:
    value = capture_session_rights_grant_attestation_from_dict(
        _strict_json_object(
            raw,
            label="capture session rights grant attestation",
        )
    )
    if raw != value.canonical_json_bytes():
        _fail(
            "NONCANONICAL_JSON",
            "capture session rights grant attestation bytes are not canonical",
        )
    return value


def capture_rights_trust_snapshot_from_dict(
    value: Mapping[str, Any],
) -> CaptureRightsTrustSnapshot:
    _require_exact_fields(value, _TRUST_SNAPSHOT_FIELDS, "capture rights trust snapshot")
    if value["schema_version"] != CAPTURE_RIGHTS_SCHEMA_VERSION:
        raise ValueError(
            "capture rights trust snapshot schema_version must be "
            f"{CAPTURE_RIGHTS_SCHEMA_VERSION}"
        )

    keys: list[TrustedCaptureRightsReviewerKey] = []
    raw_keys = _exact_list(value, "keys", "capture rights trust snapshot")
    if len(raw_keys) > MAX_TRUST_KEYS:
        raise ValueError(f"capture rights trust snapshot exceeds {MAX_TRUST_KEYS} keys")
    for index, item in enumerate(raw_keys):
        _require_exact_fields(item, _KEY_FIELDS, f"keys[{index}]")
        keys.append(
            TrustedCaptureRightsReviewerKey(
                key_id=item["key_id"],
                reviewer_id=item["reviewer_id"],
                key_role=_enum_from_json(
                    CaptureRightsKeyRole,
                    item["key_role"],
                    f"keys[{index}].key_role",
                ),
                public_key_base64=item["public_key_base64"],
                valid_from_ns=item["valid_from_ns"],
                valid_until_ns=item["valid_until_ns"],
                revoked_at_ns=item["revoked_at_ns"],
            )
        )

    current: list[CurrentCaptureSessionRightsGrant] = []
    raw_current = _exact_list(
        value,
        "current_grants",
        "capture rights trust snapshot",
    )
    if len(raw_current) > MAX_CURRENT_GRANTS:
        raise ValueError(
            "capture rights trust snapshot exceeds "
            f"{MAX_CURRENT_GRANTS} current grants"
        )
    for index, item in enumerate(raw_current):
        _require_exact_fields(
            item,
            _CURRENT_GRANT_FIELDS,
            f"current_grants[{index}]",
        )
        current.append(
            CurrentCaptureSessionRightsGrant(
                grant_id=item["grant_id"],
                match_id=item["match_id"],
                capture_session_id=item["capture_session_id"],
                grant_sha256=item["grant_sha256"],
            )
        )

    return CaptureRightsTrustSnapshot(
        trust_domain_id=value["trust_domain_id"],
        protected_policy_fingerprint=value["protected_policy_fingerprint"],
        protected_policy_generation=value["protected_policy_generation"],
        keys=tuple(keys),
        current_grants=tuple(current),
        revoked_grant_sha256s=tuple(
            _exact_list(
                value,
                "revoked_grant_sha256s",
                "capture rights trust snapshot",
            )
        ),
    )


def capture_rights_trust_snapshot_from_json_bytes(
    raw: bytes,
) -> CaptureRightsTrustSnapshot:
    value = capture_rights_trust_snapshot_from_dict(
        _strict_json_object(raw, label="capture rights trust snapshot")
    )
    if raw != value.canonical_json_bytes():
        _fail(
            "NONCANONICAL_JSON",
            "capture rights trust snapshot bytes are not canonical",
        )
    return value
