"""Cryptographically trusted review attestations for rights decisions.

``RightsDecision`` describes a review result, but its payload is not trusted by
itself.  This module verifies an Ed25519 attestation from a reviewer key that is
supplied through a separately pinned trust store, checks that the decision is
the store's current decision for the exact asset, rejects revocations, and
resolves every evidence hash to resident immutable bytes.

The trust-store path and expected fingerprint are deployment configuration;
they must never come from the dataset manifest being validated. The methods on
``RightsTrustStore`` verify one already-loaded immutable snapshot. They are not
standalone proof that no newer revocation generation exists. Current
authorization requires the single-use readiness validator's protected
configuration-generation start/end checks (or an equivalent trusted launcher
generation lease).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import multiprocessing
import os
import re
import stat
import time
from dataclasses import dataclass
from datetime import date
from enum import Enum
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .immutable_store import (
    ImmutableStoreError,
    generation_id_for,
    generation_read_lease,
)
from .rights import RightsDecision


SCHEMA_VERSION = "1.0"
_SIGNING_DOMAIN = "multicourt-vision-scoring:rights-attestation:v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ERROR_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ATTESTATION_FIELDS = frozenset(
    {
        "decision_sha256",
        "key_id",
        "schema_version",
        "signature_base64",
        "signed_on",
        "trust_domain_id",
    }
)
_POLICY_FIELDS = frozenset(
    {
        "deployment_geography",
        "policy_id",
        "schema_version",
        "trust_store_sha256",
        "use_profile",
        "valid_from",
        "valid_until",
        "verifier_source_tree_sha256",
    }
)
_KEY_FIELDS = frozenset(
    {
        "compromised_on",
        "key_id",
        "public_key_base64",
        "reviewer_id",
        "valid_from",
        "valid_until",
    }
)
_CURRENT_DECISION_FIELDS = frozenset({"asset_sha256", "decision_sha256"})
_TRUST_STORE_FIELDS = frozenset(
    {
        "current_decisions",
        "keyring_id",
        "keys",
        "revoked_decision_sha256s",
        "schema_version",
    }
)
_MAX_SINGLE_DECISION_EVIDENCE_FILES = 64
_MAX_BATCH_EVIDENCE_FILES = 4096
_MAX_ATTESTATION_PAIRS = 10_000
_MAX_EVIDENCE_BYTES = 32 * 1024 * 1024
_MAX_TOTAL_EVIDENCE_BYTES = 2 * 1024 * 1024 * 1024
_EVIDENCE_TIMEOUT_SECONDS = 30.0
_MAX_TRUST_JSON_BYTES = 4 * 1024 * 1024
_MAX_TRUST_KEYS = 128
_MAX_CURRENT_DECISIONS = 100_000
_MAX_REVOKED_DECISIONS = 100_000


class RightsUseProfile(str, Enum):
    COMMERCIAL_ASSISTIVE_SCORING_V1 = "COMMERCIAL_ASSISTIVE_SCORING_V1"


class RightsTrustError(ValueError):
    """A rights trust-boundary failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require_sha256(value: object, field_name: str) -> None:
    if type(value) is not str or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256")


def _require_stable_id(value: object, field_name: str) -> None:
    if type(value) is not str or not _STABLE_ID_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ASCII stable ID")


def _parse_date(value: object, field_name: str) -> date:
    if type(value) is not str or not _ISO_DATE_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    return parsed


def _canonical_base64(
    value: object,
    field_name: str,
    *,
    expected_bytes: int,
) -> bytes:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        encoded = value.encode("ascii")
        decoded = base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if len(decoded) != expected_bytes or base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError(f"{field_name} must be canonical base64 for {expected_bytes} bytes")
    return decoded


def _exact_fields(
    payload: Mapping[str, Any],
    expected: frozenset[str],
    label: str,
) -> None:
    fields = set(payload)
    unknown = sorted(str(field) for field in fields - expected)
    missing = sorted(expected - fields)
    if unknown:
        raise ValueError(f"{label} has unsupported fields: {', '.join(unknown)}")
    if missing:
        raise ValueError(f"{label} is missing fields: {', '.join(missing)}")


def _exact_list(payload: Mapping[str, Any], field_name: str, label: str) -> list[Any]:
    value = payload.get(field_name)
    if type(value) is not list:
        raise ValueError(f"{label}.{field_name} must be a JSON array")
    return value


def _strict_json_object(path: Path, *, label: str) -> Mapping[str, Any]:
    try:
        path_stat = os.lstat(path)
    except OSError as exc:
        raise ValueError(f"{label} is unavailable") from exc
    if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
        raise ValueError(f"{label} must be a non-symlink regular file")
    if path_stat.st_size > _MAX_TRUST_JSON_BYTES:
        raise ValueError(f"{label} exceeds {_MAX_TRUST_JSON_BYTES} bytes")

    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValueError(f"{label} could not be opened safely") from exc
    try:
        descriptor_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(descriptor_before.st_mode)
            or _stat_identity(path_stat) != _stat_identity(descriptor_before)
            or _stat_state(path_stat) != _stat_state(descriptor_before)
        ):
            raise ValueError(f"{label} changed while opening")
        if descriptor_before.st_size > _MAX_TRUST_JSON_BYTES:
            raise ValueError(f"{label} exceeds {_MAX_TRUST_JSON_BYTES} bytes")

        remaining = descriptor_before.st_size
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError(f"{label} was truncated while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValueError(f"{label} grew while reading")

        descriptor_after = os.fstat(descriptor)
        try:
            final_path_stat = os.lstat(path)
        except OSError as exc:
            raise ValueError(f"{label} changed while reading") from exc
        if (
            not stat.S_ISREG(descriptor_after.st_mode)
            or stat.S_ISLNK(final_path_stat.st_mode)
            or not stat.S_ISREG(final_path_stat.st_mode)
            or _stat_state(descriptor_before) != _stat_state(descriptor_after)
            or _stat_identity(descriptor_after) != _stat_identity(final_path_stat)
            or _stat_state(descriptor_after) != _stat_state(final_path_stat)
        ):
            raise ValueError(f"{label} changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{label} contains duplicate JSON object key: {key}")
            result[key] = value
        return result

    try:
        payload = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} must be valid UTF-8 JSON") from exc
    if not isinstance(payload, Mapping):
        raise ValueError(f"{label} root must be a JSON object")
    return payload


def _stat_identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def _stat_state(value: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


@dataclass(frozen=True, slots=True)
class RightsAttestation:
    """A detached Ed25519 signature for one canonical rights decision."""

    decision_sha256: str
    key_id: str
    trust_domain_id: str
    signed_on: str
    signature_base64: str

    def __post_init__(self) -> None:
        _require_sha256(self.decision_sha256, "decision_sha256")
        _require_stable_id(self.key_id, "key_id")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _parse_date(self.signed_on, "signed_on")
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
            "decision_sha256": self.decision_sha256,
            "key_id": self.key_id,
            "schema_version": SCHEMA_VERSION,
            "signature_base64": self.signature_base64,
            "signed_on": self.signed_on,
            "trust_domain_id": self.trust_domain_id,
        }

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_canonical_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class RightsVerificationPolicy:
    """Protected deployment policy; never loaded from a dataset manifest."""

    policy_id: str
    trust_store_sha256: str
    verifier_source_tree_sha256: str
    deployment_geography: str
    use_profile: RightsUseProfile
    valid_from: str
    valid_until: str

    def __post_init__(self) -> None:
        _require_stable_id(self.policy_id, "policy_id")
        _require_sha256(self.trust_store_sha256, "trust_store_sha256")
        _require_sha256(
            self.verifier_source_tree_sha256,
            "verifier_source_tree_sha256",
        )
        if type(self.deployment_geography) is not str or not re.fullmatch(
            r"[A-Z]{2}",
            self.deployment_geography,
        ):
            raise ValueError("deployment_geography must be an ISO alpha-2 code")
        if type(self.use_profile) is not RightsUseProfile:
            raise ValueError("use_profile must be a RightsUseProfile")
        valid_from = _parse_date(self.valid_from, "valid_from")
        valid_until = _parse_date(self.valid_until, "valid_until")
        if valid_until < valid_from:
            raise ValueError("valid_until cannot precede valid_from")

    def is_active(self, as_of: str) -> bool:
        as_of_date = _parse_date(as_of, "as_of")
        return (
            _parse_date(self.valid_from, "valid_from")
            <= as_of_date
            <= _parse_date(self.valid_until, "valid_until")
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "deployment_geography": self.deployment_geography,
            "policy_id": self.policy_id,
            "schema_version": SCHEMA_VERSION,
            "trust_store_sha256": self.trust_store_sha256,
            "use_profile": self.use_profile.value,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
            "verifier_source_tree_sha256": self.verifier_source_tree_sha256,
        }

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_canonical_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class TrustedReviewerKey:
    key_id: str
    reviewer_id: str
    public_key_base64: str
    valid_from: str
    valid_until: str | None
    compromised_on: str | None

    def __post_init__(self) -> None:
        _require_stable_id(self.key_id, "key_id")
        _require_stable_id(self.reviewer_id, "reviewer_id")
        _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = _parse_date(self.valid_from, "valid_from")
        if self.valid_until is not None:
            valid_until = _parse_date(self.valid_until, "valid_until")
            if valid_until < valid_from:
                raise ValueError("valid_until cannot precede valid_from")
        if self.compromised_on is not None:
            _parse_date(self.compromised_on, "compromised_on")

    @property
    def public_key(self) -> Ed25519PublicKey:
        raw = _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        return Ed25519PublicKey.from_public_bytes(raw)

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "key_id": self.key_id,
            "public_key_base64": self.public_key_base64,
            "reviewer_id": self.reviewer_id,
            "compromised_on": self.compromised_on,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
        }


@dataclass(frozen=True, slots=True)
class CurrentRightsDecision:
    asset_sha256: str
    decision_sha256: str

    def __post_init__(self) -> None:
        _require_sha256(self.asset_sha256, "asset_sha256")
        _require_sha256(self.decision_sha256, "decision_sha256")

    def to_canonical_dict(self) -> dict[str, str]:
        return {
            "asset_sha256": self.asset_sha256,
            "decision_sha256": self.decision_sha256,
        }


@dataclass(frozen=True, slots=True)
class _IndexedReviewerKey:
    key: TrustedReviewerKey
    public_key: Ed25519PublicKey
    valid_from: date
    valid_until: date | None
    compromised_on: date | None


@dataclass(frozen=True, slots=True)
class _RightsTrustIndexes:
    keys_by_id: Mapping[str, _IndexedReviewerKey]
    current_by_asset: Mapping[str, str]
    revoked_decision_sha256s: frozenset[str]


@dataclass(frozen=True, slots=True)
class RightsTrustStore:
    """One frozen snapshot of trusted keys and current asset decisions.

    Snapshot verification is cryptographic but not a freshness boundary by
    itself. Call it only inside a protected current-generation envelope.
    """

    keyring_id: str
    keys: tuple[TrustedReviewerKey, ...]
    current_decisions: tuple[CurrentRightsDecision, ...]
    revoked_decision_sha256s: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_stable_id(self.keyring_id, "keyring_id")
        if type(self.keys) is not tuple or any(
            type(key) is not TrustedReviewerKey for key in self.keys
        ):
            raise ValueError("keys must be an immutable tuple of TrustedReviewerKey values")
        if not self.keys:
            raise ValueError("keys cannot be empty")
        if len(self.keys) > _MAX_TRUST_KEYS:
            raise ValueError(
                f"rights trust store exceeds {_MAX_TRUST_KEYS} keys"
            )
        if len({key.key_id for key in self.keys}) != len(self.keys):
            raise ValueError("key IDs must be unique")
        if len({key.public_key_base64 for key in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot be assigned to multiple key records")
        if type(self.current_decisions) is not tuple or any(
            type(item) is not CurrentRightsDecision for item in self.current_decisions
        ):
            raise ValueError(
                "current_decisions must be an immutable tuple of CurrentRightsDecision values"
            )
        if len(self.current_decisions) > _MAX_CURRENT_DECISIONS:
            raise ValueError(
                "rights trust store exceeds "
                f"{_MAX_CURRENT_DECISIONS} current decisions"
            )
        if len({item.asset_sha256 for item in self.current_decisions}) != len(
            self.current_decisions
        ):
            raise ValueError("each asset may have only one current rights decision")
        if type(self.revoked_decision_sha256s) is not tuple:
            raise ValueError("revoked_decision_sha256s must be an immutable tuple")
        if len(self.revoked_decision_sha256s) > _MAX_REVOKED_DECISIONS:
            raise ValueError(
                "rights trust store exceeds "
                f"{_MAX_REVOKED_DECISIONS} revoked decisions"
            )
        for fingerprint in self.revoked_decision_sha256s:
            _require_sha256(fingerprint, "revoked decision fingerprint")
        if len(set(self.revoked_decision_sha256s)) != len(
            self.revoked_decision_sha256s
        ):
            raise ValueError("revoked_decision_sha256s cannot contain duplicates")
        current_hashes = {item.decision_sha256 for item in self.current_decisions}
        overlap = current_hashes & set(self.revoked_decision_sha256s)
        if overlap:
            raise ValueError("a revoked decision cannot also be current")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "current_decisions": [
                item.to_canonical_dict()
                for item in sorted(
                    self.current_decisions,
                    key=lambda item: item.asset_sha256,
                )
            ],
            "keyring_id": self.keyring_id,
            "keys": [
                key.to_canonical_dict()
                for key in sorted(self.keys, key=lambda key: key.key_id)
            ],
            "revoked_decision_sha256s": sorted(self.revoked_decision_sha256s),
            "schema_version": SCHEMA_VERSION,
        }

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_canonical_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()

    def verify(
        self,
        decision: RightsDecision,
        attestation: RightsAttestation,
        *,
        verified_on: str,
        evidence_store_root: Path,
    ) -> tuple[str, ...]:
        """Verify against this snapshot and its exact evidence generation.

        This does not discover a trust-store generation published after the
        object was loaded; the caller must hold a protected generation check.
        """

        required = self.verify_attestation(
            decision,
            attestation,
            verified_on=verified_on,
        )
        return verify_rights_evidence_batch(
            required,
            evidence_store_root=evidence_store_root,
        )

    def verify_attestation(
        self,
        decision: RightsDecision,
        attestation: RightsAttestation,
        *,
        verified_on: str,
    ) -> tuple[str, ...]:
        """Verify currentness and signature without opening evidence files.

        The returned tuple is the exact, sorted union of the decision's rights
        evidence and participant-release evidence.  Callers may union the
        tuples from many decisions and pass the resulting sorted, unique tuple
        to :func:`verify_rights_evidence_batch` so a dataset incurs one bounded
        evidence worker rather than one worker per decision.
        """

        return self.verify_attestations_batch(
            ((decision, attestation),),
            verified_on=verified_on,
        )[0]

    def verify_attestations_batch(
        self,
        items: tuple[tuple[RightsDecision, RightsAttestation], ...],
        *,
        verified_on: str,
    ) -> tuple[tuple[str, ...], ...]:
        """Verify up to 10,000 attestations using one set of trust indexes.

        Results remain aligned with ``items``.  Each result is the exact sorted
        evidence tuple for its decision and no evidence file is opened here.
        This verifies the frozen store snapshot only; a protected launcher
        generation must separately establish freshness.
        """

        if type(items) is not tuple:
            raise RightsTrustError(
                "RIGHTS_ATTESTATION_BATCH",
                "rights attestation batch must be an immutable tuple",
            )
        if not items or len(items) > _MAX_ATTESTATION_PAIRS:
            raise RightsTrustError(
                "RIGHTS_ATTESTATION_BATCH_COUNT",
                "rights attestation batch count must be between 1 and "
                f"{_MAX_ATTESTATION_PAIRS}",
            )
        for index, item in enumerate(items):
            if (
                type(item) is not tuple
                or len(item) != 2
                or type(item[0]) is not RightsDecision
                or type(item[1]) is not RightsAttestation
            ):
                raise RightsTrustError(
                    "RIGHTS_ATTESTATION_BATCH",
                    "rights attestation batch item "
                    f"{index} must be an exact "
                    "(RightsDecision, RightsAttestation) pair",
                )

        verified_on_date = _parse_date(verified_on, "verified_on")
        indexes = _build_rights_trust_indexes(self)
        return tuple(
            _verify_rights_attestation_against_indexes(
                self,
                decision,
                attestation,
                verified_on_date=verified_on_date,
                indexes=indexes,
            )
            for decision, attestation in items
        )


def _build_rights_trust_indexes(store: RightsTrustStore) -> _RightsTrustIndexes:
    keys_by_id = {
        key.key_id: _IndexedReviewerKey(
            key=key,
            public_key=key.public_key,
            valid_from=_parse_date(key.valid_from, "valid_from"),
            valid_until=(
                _parse_date(key.valid_until, "valid_until")
                if key.valid_until is not None
                else None
            ),
            compromised_on=(
                _parse_date(key.compromised_on, "compromised_on")
                if key.compromised_on is not None
                else None
            ),
        )
        for key in store.keys
    }
    return _RightsTrustIndexes(
        keys_by_id=keys_by_id,
        current_by_asset={
            item.asset_sha256: item.decision_sha256
            for item in store.current_decisions
        },
        revoked_decision_sha256s=frozenset(store.revoked_decision_sha256s),
    )


def _verify_rights_attestation_against_indexes(
    store: RightsTrustStore,
    decision: RightsDecision,
    attestation: RightsAttestation,
    *,
    verified_on_date: date,
    indexes: _RightsTrustIndexes,
) -> tuple[str, ...]:
    fingerprint = decision.fingerprint()
    if attestation.trust_domain_id != store.keyring_id:
        raise RightsTrustError(
            "RIGHTS_ATTESTATION_DOMAIN",
            "attestation trust domain does not match the pinned keyring",
        )
    if attestation.decision_sha256 != fingerprint:
        raise RightsTrustError(
            "RIGHTS_ATTESTATION_MISMATCH",
            "attestation does not name the canonical rights decision",
        )
    if fingerprint in indexes.revoked_decision_sha256s:
        raise RightsTrustError(
            "RIGHTS_DECISION_REVOKED",
            "the rights decision has been revoked",
        )
    current = indexes.current_by_asset.get(decision.asset_sha256)
    if current is None:
        raise RightsTrustError(
            "RIGHTS_DECISION_UNTRUSTED",
            "the trust store has no current decision for this asset",
        )
    if current != fingerprint:
        raise RightsTrustError(
            "RIGHTS_DECISION_STALE",
            "the supplied decision is not the current decision for this asset",
        )

    indexed_key = indexes.keys_by_id.get(attestation.key_id)
    if indexed_key is None:
        raise RightsTrustError(
            "RIGHTS_REVIEWER_UNTRUSTED",
            "attestation key is not in the pinned trust store",
        )
    key = indexed_key.key
    if key.reviewer_id != decision.reviewer_id:
        raise RightsTrustError(
            "RIGHTS_REVIEWER_MISMATCH",
            "decision reviewer_id does not match the trusted key principal",
        )
    signed_on = _parse_date(attestation.signed_on, "signed_on")
    reviewed_on = _parse_date(decision.reviewed_on, "reviewed_on")
    if signed_on < reviewed_on or signed_on > verified_on_date:
        raise RightsTrustError(
            "RIGHTS_ATTESTATION_DATE",
            "attestation must be signed on/after review and on/before readiness date",
        )
    if signed_on < indexed_key.valid_from or (
        indexed_key.valid_until is not None
        and signed_on > indexed_key.valid_until
    ):
        raise RightsTrustError(
            "RIGHTS_REVIEWER_KEY_DATE",
            "reviewer key was not valid on the attestation date",
        )
    if (
        indexed_key.compromised_on is not None
        and verified_on_date >= indexed_key.compromised_on
    ):
        raise RightsTrustError(
            "RIGHTS_REVIEWER_KEY_REVOKED",
            "reviewer key is marked compromised and is retroactively untrusted",
        )
    try:
        indexed_key.public_key.verify(
            attestation.signature,
            attestation_signing_message(
                decision,
                key_id=attestation.key_id,
                trust_domain_id=attestation.trust_domain_id,
                signed_on=attestation.signed_on,
            ),
        )
    except InvalidSignature as exc:
        raise RightsTrustError(
            "RIGHTS_ATTESTATION_SIGNATURE",
            "rights attestation signature is invalid",
        ) from exc

    return _decision_evidence_digests(decision)


def attestation_signing_message(
    decision: RightsDecision,
    *,
    key_id: str,
    trust_domain_id: str,
    signed_on: str,
) -> bytes:
    """Return the domain-separated bytes an external reviewer signs."""

    if type(decision) is not RightsDecision:
        raise ValueError("decision must be a RightsDecision")
    _require_stable_id(key_id, "key_id")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _parse_date(signed_on, "signed_on")
    payload = {
        "decision": decision.to_canonical_dict(),
        "domain": _SIGNING_DOMAIN,
        "key_id": key_id,
        "signed_on": signed_on,
        "trust_domain_id": trust_domain_id,
    }
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def rights_attestation_from_dict(payload: Mapping[str, Any]) -> RightsAttestation:
    if not isinstance(payload, Mapping):
        raise ValueError("rights attestation must be a JSON object")
    _exact_fields(payload, _ATTESTATION_FIELDS, "rights attestation")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"rights attestation schema_version must be {SCHEMA_VERSION}")
    return RightsAttestation(
        decision_sha256=payload.get("decision_sha256"),
        key_id=payload.get("key_id"),
        trust_domain_id=payload.get("trust_domain_id"),
        signed_on=payload.get("signed_on"),
        signature_base64=payload.get("signature_base64"),
    )


def rights_verification_policy_from_dict(
    payload: Mapping[str, Any],
) -> RightsVerificationPolicy:
    if not isinstance(payload, Mapping):
        raise ValueError("rights verification policy must be a JSON object")
    _exact_fields(payload, _POLICY_FIELDS, "rights verification policy")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"rights verification policy schema_version must be {SCHEMA_VERSION}"
        )
    try:
        use_profile = RightsUseProfile(payload.get("use_profile"))
    except (TypeError, ValueError) as exc:
        raise ValueError("rights verification policy has unsupported use_profile") from exc
    return RightsVerificationPolicy(
        policy_id=payload.get("policy_id"),
        trust_store_sha256=payload.get("trust_store_sha256"),
        verifier_source_tree_sha256=payload.get("verifier_source_tree_sha256"),
        deployment_geography=payload.get("deployment_geography"),
        use_profile=use_profile,
        valid_from=payload.get("valid_from"),
        valid_until=payload.get("valid_until"),
    )


def rights_trust_store_from_dict(payload: Mapping[str, Any]) -> RightsTrustStore:
    if not isinstance(payload, Mapping):
        raise ValueError("rights trust store must be a JSON object")
    _exact_fields(payload, _TRUST_STORE_FIELDS, "rights trust store")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"rights trust store schema_version must be {SCHEMA_VERSION}")

    keys: list[TrustedReviewerKey] = []
    raw_keys = _exact_list(payload, "keys", "rights trust store")
    if len(raw_keys) > _MAX_TRUST_KEYS:
        raise ValueError(f"rights trust store exceeds {_MAX_TRUST_KEYS} keys")
    for index, raw_key in enumerate(raw_keys):
        if not isinstance(raw_key, Mapping):
            raise ValueError(f"rights trust store.keys[{index}] must be an object")
        _exact_fields(raw_key, _KEY_FIELDS, f"rights trust store.keys[{index}]")
        keys.append(
            TrustedReviewerKey(
                key_id=raw_key.get("key_id"),
                reviewer_id=raw_key.get("reviewer_id"),
                public_key_base64=raw_key.get("public_key_base64"),
                valid_from=raw_key.get("valid_from"),
                valid_until=raw_key.get("valid_until"),
                compromised_on=raw_key.get("compromised_on"),
            )
        )

    current: list[CurrentRightsDecision] = []
    raw_current = _exact_list(payload, "current_decisions", "rights trust store")
    if len(raw_current) > _MAX_CURRENT_DECISIONS:
        raise ValueError(
            f"rights trust store exceeds {_MAX_CURRENT_DECISIONS} current decisions"
        )
    for index, raw_item in enumerate(raw_current):
        if not isinstance(raw_item, Mapping):
            raise ValueError(
                f"rights trust store.current_decisions[{index}] must be an object"
            )
        _exact_fields(
            raw_item,
            _CURRENT_DECISION_FIELDS,
            f"rights trust store.current_decisions[{index}]",
        )
        current.append(
            CurrentRightsDecision(
                asset_sha256=raw_item.get("asset_sha256"),
                decision_sha256=raw_item.get("decision_sha256"),
            )
        )

    revoked = _exact_list(payload, "revoked_decision_sha256s", "rights trust store")
    if len(revoked) > _MAX_REVOKED_DECISIONS:
        raise ValueError(
            f"rights trust store exceeds {_MAX_REVOKED_DECISIONS} revoked decisions"
        )
    return RightsTrustStore(
        keyring_id=payload.get("keyring_id"),
        keys=tuple(keys),
        current_decisions=tuple(current),
        revoked_decision_sha256s=tuple(revoked),
    )


def load_rights_trust_store(path: Path) -> RightsTrustStore:
    return rights_trust_store_from_dict(
        _strict_json_object(path, label="rights trust store")
    )


def load_rights_verification_policy(path: Path) -> RightsVerificationPolicy:
    return rights_verification_policy_from_dict(
        _strict_json_object(path, label="rights verification policy")
    )


def verify_rights_evidence(
    decision: RightsDecision,
    *,
    evidence_store_root: Path,
) -> tuple[str, ...]:
    """Verify one decision's immutable evidence generation in one worker."""

    return verify_rights_evidence_batch(
        _decision_evidence_digests(decision),
        evidence_store_root=evidence_store_root,
    )


def _decision_evidence_digests(decision: RightsDecision) -> tuple[str, ...]:
    required = tuple(
        sorted(
            set(decision.evidence_sha256s)
            | set(decision.participant_release_sha256s)
        )
    )
    if not required or len(required) > _MAX_SINGLE_DECISION_EVIDENCE_FILES:
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_COUNT",
            "one rights decision's evidence count must be between 1 and "
            f"{_MAX_SINGLE_DECISION_EVIDENCE_FILES}",
        )
    return required


def verify_rights_evidence_batch(
    required: tuple[str, ...],
    *,
    evidence_store_root: Path,
) -> tuple[str, ...]:
    """Verify one exact immutable evidence generation in one killable worker.

    ``required`` is deliberately strict: it must already be an immutable,
    sorted, duplicate-free tuple of lowercase SHA-256 digests.  Dataset callers
    therefore make deduplication explicit before crossing this API boundary.
    Its domain-separated generation ID is derived here, never accepted from the
    dataset.  The worker holds one shared generation lease for the complete
    batch, and the descriptor must declare exactly ``required``.  Resource
    limits are fixed production policy and cannot be overridden by a manifest
    or caller.
    """

    if type(required) is not tuple:
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_DIGESTS",
            "batch rights evidence must be an immutable tuple",
        )
    if not required or len(required) > _MAX_BATCH_EVIDENCE_FILES:
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_COUNT",
            "batch rights evidence count must be between 1 and "
            f"{_MAX_BATCH_EVIDENCE_FILES}",
        )
    if any(type(digest) is not str or not _SHA256_RE.fullmatch(digest) for digest in required):
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_DIGESTS",
            "batch rights evidence values must be lowercase SHA-256 digests",
        )
    if required != tuple(sorted(set(required))):
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_DIGESTS",
            "batch rights evidence must be sorted and duplicate-free",
        )
    if not isinstance(evidence_store_root, Path):
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_STORE",
            "rights evidence store root must be a pathlib.Path",
        )

    generation_id = generation_id_for(required)

    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(
        target=_rights_evidence_worker,
        args=(str(evidence_store_root), generation_id, required, sender),
        daemon=True,
    )
    deadline = time.monotonic() + _EVIDENCE_TIMEOUT_SECONDS
    started = False
    result: object | None = None
    try:
        worker.start()
        started = True
        sender.close()
        remaining = max(0.0, deadline - time.monotonic())
        if not receiver.poll(remaining):
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_TIMEOUT",
                f"rights evidence verification exceeded {_EVIDENCE_TIMEOUT_SECONDS} seconds",
            )
        try:
            result = receiver.recv()
        except EOFError as exc:
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_WORKER",
                "rights evidence worker exited without a result",
            ) from exc
        remaining = max(0.0, deadline - time.monotonic())
        worker.join(timeout=remaining)
        if worker.is_alive():
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_TIMEOUT",
                "rights evidence worker did not exit before the absolute deadline",
            )
        if time.monotonic() >= deadline:
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_TIMEOUT",
                "rights evidence worker exceeded the absolute deadline",
            )
        if worker.exitcode != 0:
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_WORKER",
                "rights evidence worker exited unsuccessfully",
            )
    finally:
        try:
            sender.close()
        except OSError:
            pass
        receiver.close()
        if started and worker.is_alive():
            worker.terminate()
            worker.join(timeout=1.0)
            if worker.is_alive():
                worker.kill()
                worker.join(timeout=1.0)
        if started and not worker.is_alive():
            worker.close()
    _validate_rights_worker_result(result)
    return required


def _validate_rights_worker_result(result: object) -> None:
    if (
        type(result) is not dict
        or set(result) != {"ok", "code", "message"}
        or type(result.get("ok")) is not bool
    ):
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_WORKER",
            "rights evidence worker returned an invalid result",
        )
    code = result["code"]
    message = result["message"]
    if result["ok"] is True:
        if code != "" or message != "":
            raise RightsTrustError(
                "RIGHTS_EVIDENCE_WORKER",
                "rights evidence worker returned an invalid success result",
            )
        return
    if (
        type(code) is not str
        or _ERROR_CODE_RE.fullmatch(code) is None
        or type(message) is not str
        or not message
        or len(message) > 512
    ):
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_WORKER",
            "rights evidence worker returned an invalid error result",
        )
    raise RightsTrustError(code, message)


def _rights_evidence_worker(
    evidence_store_root: str,
    generation_id: str,
    required: tuple[str, ...],
    sender: Connection,
) -> None:
    try:
        _verify_rights_evidence_generation_sync(
            Path(evidence_store_root),
            generation_id,
            required,
        )
    except RightsTrustError as exc:
        result = {"ok": False, "code": exc.code, "message": str(exc)}
    except BaseException:
        result = {
            "ok": False,
            "code": "RIGHTS_EVIDENCE_WORKER",
            "message": "rights evidence worker failed closed",
        }
    else:
        result = {"ok": True, "code": "", "message": ""}
    try:
        sender.send(result)
    finally:
        sender.close()


def _verify_rights_evidence_generation_sync(
    evidence_store_root: Path,
    generation_id: str,
    required: tuple[str, ...],
) -> None:
    deadline = time.monotonic() + _EVIDENCE_TIMEOUT_SECONDS
    total_bytes = 0
    try:
        with generation_read_lease(
            evidence_store_root,
            generation_id,
        ) as lease:
            if lease.descriptor.object_sha256s != required:
                raise RightsTrustError(
                    "RIGHTS_EVIDENCE_GENERATION_MEMBERSHIP",
                    "rights evidence generation does not declare the exact required object set",
                )
            for expected_sha256 in required:
                _require_evidence_deadline(deadline)
                with lease.open_verified_object(
                    expected_sha256,
                    max_bytes=_MAX_EVIDENCE_BYTES,
                ) as staged:
                    staged_size = os.fstat(staged.fileno()).st_size
                    if staged_size < 0 or staged_size > _MAX_EVIDENCE_BYTES:
                        raise RightsTrustError(
                            "RIGHTS_EVIDENCE_SIZE",
                            f"rights evidence exceeds {_MAX_EVIDENCE_BYTES} bytes",
                        )
                    total_bytes += staged_size
                    if total_bytes > _MAX_TOTAL_EVIDENCE_BYTES:
                        raise RightsTrustError(
                            "RIGHTS_EVIDENCE_TOTAL_SIZE",
                            "total rights evidence exceeds "
                            f"{_MAX_TOTAL_EVIDENCE_BYTES} bytes",
                        )
                _require_evidence_deadline(deadline)
    except RightsTrustError:
        raise
    except ImmutableStoreError as exc:
        raise _map_immutable_store_error(exc) from exc
    except ValueError as exc:
        # Generation descriptor parsing errors originate in store-controlled
        # bytes.  Do not reflect parser details across the trust boundary.
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation metadata is invalid",
        ) from exc


def _require_evidence_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise RightsTrustError(
            "RIGHTS_EVIDENCE_TIMEOUT",
            "rights evidence verification deadline elapsed",
        )


def _map_immutable_store_error(error: ImmutableStoreError) -> RightsTrustError:
    """Translate store failures without reflecting store-controlled text."""

    code_map = {
        "PLATFORM_UNSAFE": (
            "RIGHTS_EVIDENCE_PLATFORM",
            "rights evidence immutable storage is unsupported on this platform",
        ),
        "STORE_SHAPE": (
            "RIGHTS_EVIDENCE_STORE",
            "rights evidence store is unavailable or unsafe",
        ),
        "LOCK_MISSING": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation lock is unavailable",
        ),
        "LOCK_SHAPE": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation lock is unsafe",
        ),
        "LOCK_CHANGED": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation lock changed",
        ),
        "GENERATION_BUSY": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation is unavailable",
        ),
        "DESCRIPTOR_MISSING": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation descriptor is unavailable",
        ),
        "DESCRIPTOR_OPEN": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation descriptor is unsafe",
        ),
        "DESCRIPTOR_SHAPE": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation descriptor is invalid",
        ),
        "DESCRIPTOR_CHANGED": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation descriptor changed",
        ),
        "GENERATION_MISMATCH": (
            "RIGHTS_EVIDENCE_GENERATION",
            "rights evidence generation identifier is inconsistent",
        ),
        "OBJECT_UNDECLARED": (
            "RIGHTS_EVIDENCE_GENERATION_MEMBERSHIP",
            "rights evidence object is not declared by the generation",
        ),
        "OBJECT_OPEN": (
            "RIGHTS_EVIDENCE_MISSING",
            "rights evidence object is missing or unsafe",
        ),
        "OBJECT_SHAPE": (
            "RIGHTS_EVIDENCE_SHAPE",
            "rights evidence object must be a resident non-symlink regular file",
        ),
        "OBJECT_SIZE": (
            "RIGHTS_EVIDENCE_SIZE",
            f"rights evidence exceeds {_MAX_EVIDENCE_BYTES} bytes",
        ),
        "OBJECT_CHANGED": (
            "RIGHTS_EVIDENCE_CHANGED",
            "rights evidence object changed while being staged",
        ),
        "OBJECT_REPLACED": (
            "RIGHTS_EVIDENCE_CHANGED",
            "rights evidence object path changed while being staged",
        ),
        "OBJECT_HASH": (
            "RIGHTS_EVIDENCE_HASH",
            "rights evidence bytes do not match the declared digest",
        ),
        "STAGING_WRITE": (
            "RIGHTS_EVIDENCE_STAGING",
            "rights evidence could not be staged completely",
        ),
    }
    mapped = code_map.get(
        error.code,
        (
            "RIGHTS_EVIDENCE_STORE",
            "rights evidence immutable-store verification failed",
        ),
    )
    return RightsTrustError(*mapped)
