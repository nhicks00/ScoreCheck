"""Trusted Ed25519 review attestations for evaluation annotations.

An annotation's ``REVIEWED`` or ``ADJUDICATED`` enum is descriptive payload,
not authority. This module verifies one detached signature from every declared
reviewer and, for adjudicated truth, the declared adjudicator. Signatures bind
the complete canonical annotation under a domain-separated message. A pinned,
out-of-band trust store binds keys to exact principals and permitted roles,
records the current fingerprint for each annotation ID, and carries revocation
state.

All review, adjudication, and capture-integrity evidence references must resolve
through one exact immutable-store generation. The generation descriptor commits
the complete required raw SHA-256 set, and one shared read lease is held while
every bounded object is staged and verified. The trust store and evidence store
root are deployment inputs; they must not be taken from the dataset being
evaluated.

The verification policy is also a protected deployment input. Its expected
fingerprint must come from an independent protected configuration or release
control; recomputing that expected fingerprint from the caller-supplied policy
does not establish a pin and defeats the boundary this API is designed to hold.
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
from datetime import date, datetime, timezone
from enum import Enum
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .annotations import BallFrameAnnotation, ReviewState
from .immutable_store import (
    ImmutableStoreError,
    generation_id_for,
    generation_read_lease,
)


SCHEMA_VERSION = "1.0"
_SIGNING_DOMAIN = "multicourt-vision-scoring:annotation-attestation:v1"
_ATTESTATION_SET_DOMAIN = (
    "multicourt-vision-scoring:annotation-attestation-set:v1"
)
_EVIDENCE_SET_DOMAIN = "multicourt-vision-scoring:annotation-evidence-set:v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTENT_ADDRESS_RE = re.compile(r"^sha256:([0-9a-f]{64})$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UTC_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$"
)
_WORKER_ERROR_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_MAX_EVIDENCE_FILES = 256
_MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
_MAX_TOTAL_EVIDENCE_BYTES = 64 * 1024 * 1024
_MAX_ANNOTATIONS = 100_000
_MAX_ATTESTATIONS = 200_000
_MAX_REVIEWERS_PER_ANNOTATION = 16
_MAX_EVIDENCE_REFS_PER_ANNOTATION = 64
_MAX_CAPTURE_ATTESTATION_REFS = 16
_MAX_TRUSTED_KEYS = 128
_MAX_CURRENT_ANNOTATIONS = 100_000
_MAX_REVOKED_ANNOTATIONS = 100_000
_MAX_PROTECTED_CONFIGURATION_BYTES = 64 * 1024
_EVIDENCE_TIMEOUT_SECONDS = 30.0

_PROTECTED_CONFIGURATION_FIELDS = frozenset(
    {
        "annotation_trust_store_sha256",
        "annotation_verification_policy_sha256",
        "evaluator_artifact_sha256",
        "governance_domain_id",
        "schema_version",
    }
)

_IMMUTABLE_STORE_ERROR_CODES = {
    "PLATFORM_UNSAFE": "ANNOTATION_EVIDENCE_PLATFORM",
    "STORE_SHAPE": "ANNOTATION_EVIDENCE_STORE",
    "LOCK_MISSING": "ANNOTATION_EVIDENCE_LOCK_MISSING",
    "LOCK_SHAPE": "ANNOTATION_EVIDENCE_LOCK_SHAPE",
    "GENERATION_BUSY": "ANNOTATION_EVIDENCE_GENERATION_BUSY",
    "LOCK_CHANGED": "ANNOTATION_EVIDENCE_LOCK_CHANGED",
    "DESCRIPTOR_OPEN": "ANNOTATION_EVIDENCE_DESCRIPTOR_OPEN",
    "DESCRIPTOR_SHAPE": "ANNOTATION_EVIDENCE_DESCRIPTOR_SHAPE",
    "DESCRIPTOR_CHANGED": "ANNOTATION_EVIDENCE_DESCRIPTOR_CHANGED",
    "GENERATION_MISMATCH": "ANNOTATION_EVIDENCE_GENERATION_MISMATCH",
    "OBJECT_UNDECLARED": "ANNOTATION_EVIDENCE_OBJECT_UNDECLARED",
    "OBJECT_OPEN": "ANNOTATION_EVIDENCE_MISSING",
    "OBJECT_SHAPE": "ANNOTATION_EVIDENCE_SHAPE",
    "OBJECT_SIZE": "ANNOTATION_EVIDENCE_SIZE",
    "OBJECT_REPLACED": "ANNOTATION_EVIDENCE_CHANGED",
    "OBJECT_CHANGED": "ANNOTATION_EVIDENCE_CHANGED",
    "OBJECT_HASH": "ANNOTATION_EVIDENCE_HASH",
    "STAGING_WRITE": "ANNOTATION_EVIDENCE_STAGING",
}


class AnnotationTrustError(ValueError):
    """A trust-boundary failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _validate_annotation_evidence_worker_result(result: object) -> None:
    if type(result) is not dict or set(result) != {"ok", "code", "message"}:
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_WORKER",
            "annotation evidence worker returned an invalid result",
        )
    ok = result["ok"]
    code = result["code"]
    message = result["message"]
    if type(ok) is not bool or type(code) is not str or type(message) is not str:
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_WORKER",
            "annotation evidence worker returned an invalid result",
        )
    if ok is True:
        if code != "" or message != "":
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_WORKER",
                "annotation evidence worker returned an invalid result",
            )
        return
    try:
        message_bytes = message.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        message_bytes = b"x" * 513
    if (
        not _WORKER_ERROR_CODE_RE.fullmatch(code)
        or not message_bytes
        or len(message_bytes) > 512
    ):
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_WORKER",
            "annotation evidence worker returned an invalid result",
        )


class AnnotationAttestationRole(str, Enum):
    REVIEWER = "REVIEWER"
    ADJUDICATOR = "ADJUDICATOR"


class AnnotationMinimumTruthPolicy(str, Enum):
    """Minimum annotation-review state a protected evaluator policy permits."""

    ADJUDICATED_ONLY = "ADJUDICATED_ONLY"
    REVIEWED_OR_ADJUDICATED = "REVIEWED_OR_ADJUDICATED"


def _require_sha256(value: object, field_name: str) -> None:
    if type(value) is not str or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256")


def _require_stable_id(value: object, field_name: str) -> None:
    if type(value) is not str or not _STABLE_ID_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ASCII-stable ID")


def _parse_date(value: object, field_name: str) -> date:
    if type(value) is not str or not _ISO_DATE_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(
            f"{field_name} must be an ISO-8601 calendar date"
        ) from error
    if parsed.isoformat() != value:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    return parsed


def _canonical_utc_now() -> tuple[str, date]:
    verified_at = datetime.now(timezone.utc)
    canonical = verified_at.isoformat(timespec="microseconds").replace("+00:00", "Z")
    return canonical, verified_at.date()


def _parse_utc_timestamp(value: object, field_name: str) -> datetime:
    if type(value) is not str or not _UTC_TIMESTAMP_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"{field_name} must be a canonical UTC timestamp") from error
    canonical = parsed.astimezone(timezone.utc).isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")
    if canonical != value:
        raise ValueError(f"{field_name} must be a canonical UTC timestamp")
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
    except (UnicodeEncodeError, binascii.Error, ValueError) as error:
        raise ValueError(f"{field_name} must be canonical base64") from error
    if (
        len(decoded) != expected_bytes
        or base64.b64encode(decoded).decode("ascii") != value
    ):
        raise ValueError(
            f"{field_name} must be canonical base64 for {expected_bytes} bytes"
        )
    return decoded


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


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


def _strict_protected_configuration_json(path: Path) -> Mapping[str, Any]:
    """Read one bounded regular descriptor through a stable file descriptor."""

    label = "protected annotation configuration generation"
    if not isinstance(path, Path):
        raise ValueError(f"{label} path must be a pathlib.Path")
    try:
        path_stat = os.lstat(path)
    except OSError as error:
        raise ValueError(f"{label} is unavailable") from error
    if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
        raise ValueError(f"{label} must be a non-symlink regular file")
    if path_stat.st_size > _MAX_PROTECTED_CONFIGURATION_BYTES:
        raise ValueError(
            f"{label} exceeds {_MAX_PROTECTED_CONFIGURATION_BYTES} bytes"
        )

    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"{label} could not be opened safely") from error
    try:
        descriptor_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(descriptor_before.st_mode)
            or _stat_identity(path_stat) != _stat_identity(descriptor_before)
            or _stat_state(path_stat) != _stat_state(descriptor_before)
        ):
            raise ValueError(f"{label} changed while opening")
        if descriptor_before.st_size > _MAX_PROTECTED_CONFIGURATION_BYTES:
            raise ValueError(
                f"{label} exceeds {_MAX_PROTECTED_CONFIGURATION_BYTES} bytes"
            )

        remaining = descriptor_before.st_size
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                raise ValueError(f"{label} was truncated while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValueError(f"{label} grew while reading")

        descriptor_after = os.fstat(descriptor)
        try:
            final_path_stat = os.lstat(path)
        except OSError as error:
            raise ValueError(f"{label} changed while reading") from error
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
                raise ValueError(
                    f"{label} contains duplicate JSON object key: {key}"
                )
            result[key] = value
        return result

    try:
        payload = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} must be valid UTF-8 JSON") from error
    if not isinstance(payload, Mapping):
        raise ValueError(f"{label} root must be a JSON object")
    return payload


@dataclass(frozen=True, slots=True)
class AnnotationAttestation:
    """Detached signature by one declared annotation principal."""

    annotation_sha256: str
    role: AnnotationAttestationRole
    principal_id: str
    key_id: str
    trust_domain_id: str
    signed_on: str
    signature_base64: str

    def __post_init__(self) -> None:
        _require_sha256(self.annotation_sha256, "annotation_sha256")
        if type(self.role) is not AnnotationAttestationRole:
            raise ValueError("role must be an AnnotationAttestationRole")
        _require_stable_id(self.principal_id, "principal_id")
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
            "annotation_sha256": self.annotation_sha256,
            "key_id": self.key_id,
            "principal_id": self.principal_id,
            "role": self.role.value,
            "schema_version": SCHEMA_VERSION,
            "signature_base64": self.signature_base64,
            "signed_on": self.signed_on,
            "trust_domain_id": self.trust_domain_id,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _canonical_json(self.to_canonical_dict()).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True, slots=True)
class AnnotationVerificationPolicy:
    """Protected evaluator policy; never sourced from an annotation manifest.

    The policy object and its expected fingerprint are deliberately separate
    inputs. Production callers must obtain the expected fingerprint from an
    independently protected configuration, not derive it from this object.
    """

    policy_id: str
    governance_domain_id: str
    trust_store_sha256: str
    evaluator_artifact_sha256: str
    minimum_truth_policy: AnnotationMinimumTruthPolicy
    valid_from: str
    valid_until: str

    def __post_init__(self) -> None:
        _require_stable_id(self.policy_id, "policy_id")
        _require_stable_id(self.governance_domain_id, "governance_domain_id")
        _require_sha256(self.trust_store_sha256, "trust_store_sha256")
        _require_sha256(self.evaluator_artifact_sha256, "evaluator_artifact_sha256")
        if type(self.minimum_truth_policy) is not AnnotationMinimumTruthPolicy:
            raise ValueError(
                "minimum_truth_policy must be an AnnotationMinimumTruthPolicy"
            )
        valid_from = _parse_date(self.valid_from, "valid_from")
        valid_until = _parse_date(self.valid_until, "valid_until")
        if valid_until < valid_from:
            raise ValueError("valid_until cannot precede valid_from")

    def is_active(self, verified_on: date) -> bool:
        if type(verified_on) is not date:
            raise ValueError("verified_on must be a date")
        return (
            _parse_date(self.valid_from, "valid_from")
            <= verified_on
            <= _parse_date(self.valid_until, "valid_until")
        )

    def permits_truth_policy(self, requested_policy: str) -> bool:
        if requested_policy not in {
            policy.value for policy in AnnotationMinimumTruthPolicy
        }:
            raise ValueError("requested truth policy is unsupported")
        if (
            self.minimum_truth_policy
            is AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY
        ):
            return requested_policy == AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY.value
        return True

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "evaluator_artifact_sha256": self.evaluator_artifact_sha256,
            "governance_domain_id": self.governance_domain_id,
            "minimum_truth_policy": self.minimum_truth_policy.value,
            "policy_id": self.policy_id,
            "schema_version": SCHEMA_VERSION,
            "trust_store_sha256": self.trust_store_sha256,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ProtectedAnnotationConfigurationGeneration:
    """Publisher-atomic current generation of protected annotation inputs."""

    annotation_trust_store_sha256: str
    annotation_verification_policy_sha256: str
    evaluator_artifact_sha256: str
    governance_domain_id: str

    def __post_init__(self) -> None:
        _require_sha256(
            self.annotation_trust_store_sha256,
            "annotation_trust_store_sha256",
        )
        _require_sha256(
            self.annotation_verification_policy_sha256,
            "annotation_verification_policy_sha256",
        )
        _require_sha256(
            self.evaluator_artifact_sha256,
            "evaluator_artifact_sha256",
        )
        _require_stable_id(self.governance_domain_id, "governance_domain_id")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "annotation_trust_store_sha256": self.annotation_trust_store_sha256,
            "annotation_verification_policy_sha256": (
                self.annotation_verification_policy_sha256
            ),
            "evaluator_artifact_sha256": self.evaluator_artifact_sha256,
            "governance_domain_id": self.governance_domain_id,
            "schema_version": SCHEMA_VERSION,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def protected_annotation_configuration_generation_from_dict(
    payload: Mapping[str, Any],
) -> ProtectedAnnotationConfigurationGeneration:
    if not isinstance(payload, Mapping):
        raise ValueError(
            "protected annotation configuration generation must be a JSON object"
        )
    _exact_fields(
        payload,
        _PROTECTED_CONFIGURATION_FIELDS,
        "protected annotation configuration generation",
    )
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            "protected annotation configuration generation schema_version must be "
            f"{SCHEMA_VERSION}"
        )
    return ProtectedAnnotationConfigurationGeneration(
        annotation_trust_store_sha256=payload.get(
            "annotation_trust_store_sha256"
        ),
        annotation_verification_policy_sha256=payload.get(
            "annotation_verification_policy_sha256"
        ),
        evaluator_artifact_sha256=payload.get("evaluator_artifact_sha256"),
        governance_domain_id=payload.get("governance_domain_id"),
    )


def load_protected_annotation_configuration_generation(
    path: Path,
) -> ProtectedAnnotationConfigurationGeneration:
    return protected_annotation_configuration_generation_from_dict(
        _strict_protected_configuration_json(path)
    )


@dataclass(frozen=True, slots=True)
class TrustedAnnotationKey:
    """One pinned Ed25519 key bound to an exact principal and role set."""

    key_id: str
    principal_id: str
    permitted_roles: tuple[AnnotationAttestationRole, ...]
    public_key_base64: str
    valid_from: str
    valid_until: str | None
    compromised_on: str | None

    def __post_init__(self) -> None:
        _require_stable_id(self.key_id, "key_id")
        _require_stable_id(self.principal_id, "principal_id")
        if (
            type(self.permitted_roles) is not tuple
            or not self.permitted_roles
            or len(self.permitted_roles) > len(AnnotationAttestationRole)
            or any(
                type(role) is not AnnotationAttestationRole
                for role in self.permitted_roles
            )
            or len(set(self.permitted_roles)) != len(self.permitted_roles)
        ):
            raise ValueError(
                "permitted_roles must be a non-empty immutable tuple of unique "
                "AnnotationAttestationRole values"
            )
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
            "permitted_roles": sorted(role.value for role in self.permitted_roles),
            "principal_id": self.principal_id,
            "public_key_base64": self.public_key_base64,
            "compromised_on": self.compromised_on,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
        }


@dataclass(frozen=True, slots=True)
class CurrentAnnotation:
    annotation_id: str
    annotation_sha256: str

    def __post_init__(self) -> None:
        _require_stable_id(self.annotation_id, "annotation_id")
        _require_sha256(self.annotation_sha256, "annotation_sha256")

    def to_canonical_dict(self) -> dict[str, str]:
        return {
            "annotation_id": self.annotation_id,
            "annotation_sha256": self.annotation_sha256,
        }


@dataclass(frozen=True, slots=True)
class AnnotationTrustVerification:
    verification_policy_sha256: str
    requested_truth_policy: AnnotationMinimumTruthPolicy
    trust_store_sha256: str
    attestation_set_sha256: str
    evidence_set_sha256: str
    evidence_generation_id: str
    evaluator_artifact_sha256: str
    governance_domain_id: str
    protected_configuration_generation: ProtectedAnnotationConfigurationGeneration
    protected_configuration_generation_sha256: str
    verified_at_utc: str
    verified_evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self.requested_truth_policy) is not AnnotationMinimumTruthPolicy:
            raise ValueError(
                "requested_truth_policy must be an AnnotationMinimumTruthPolicy"
            )
        for value, field_name in (
            (self.verification_policy_sha256, "verification_policy_sha256"),
            (self.trust_store_sha256, "trust_store_sha256"),
            (self.attestation_set_sha256, "attestation_set_sha256"),
            (self.evidence_set_sha256, "evidence_set_sha256"),
            (self.evidence_generation_id, "evidence_generation_id"),
            (self.evaluator_artifact_sha256, "evaluator_artifact_sha256"),
            (
                self.protected_configuration_generation_sha256,
                "protected_configuration_generation_sha256",
            ),
        ):
            _require_sha256(value, field_name)
        _require_stable_id(self.governance_domain_id, "governance_domain_id")
        if type(self.protected_configuration_generation) is not (
            ProtectedAnnotationConfigurationGeneration
        ):
            raise ValueError(
                "protected_configuration_generation must be a "
                "ProtectedAnnotationConfigurationGeneration"
            )
        if self.protected_configuration_generation.fingerprint() != (
            self.protected_configuration_generation_sha256
        ):
            raise ValueError(
                "protected_configuration_generation_sha256 must match the exact "
                "protected_configuration_generation"
            )
        generation = self.protected_configuration_generation
        component_comparisons = (
            (
                generation.annotation_trust_store_sha256,
                self.trust_store_sha256,
                "trust_store_sha256",
            ),
            (
                generation.annotation_verification_policy_sha256,
                self.verification_policy_sha256,
                "verification_policy_sha256",
            ),
            (
                generation.evaluator_artifact_sha256,
                self.evaluator_artifact_sha256,
                "evaluator_artifact_sha256",
            ),
            (
                generation.governance_domain_id,
                self.governance_domain_id,
                "governance_domain_id",
            ),
        )
        for declared, reported, field_name in component_comparisons:
            if declared != reported:
                raise ValueError(
                    "protected_configuration_generation must match report "
                    f"{field_name}"
                )
        _parse_utc_timestamp(self.verified_at_utc, "verified_at_utc")
        if type(self.verified_evidence_refs) is not tuple:
            raise ValueError("verified_evidence_refs must be an immutable tuple")
        if (
            not self.verified_evidence_refs
            or len(self.verified_evidence_refs) > _MAX_EVIDENCE_FILES
        ):
            raise ValueError(
                "verified_evidence_refs count must be between 1 and "
                f"{_MAX_EVIDENCE_FILES}"
            )
        for reference in self.verified_evidence_refs:
            if type(reference) is not str or not _CONTENT_ADDRESS_RE.fullmatch(
                reference
            ):
                raise ValueError(
                    "verified_evidence_refs must contain SHA-256 content addresses"
                )
        if tuple(sorted(set(self.verified_evidence_refs))) != (
            self.verified_evidence_refs
        ):
            raise ValueError(
                "verified_evidence_refs must be sorted and contain no duplicates"
            )
        if annotation_evidence_set_fingerprint(self.verified_evidence_refs) != (
            self.evidence_set_sha256
        ):
            raise ValueError(
                "evidence_set_sha256 must match verified_evidence_refs"
            )
        raw_digests = tuple(
            reference.removeprefix("sha256:")
            for reference in self.verified_evidence_refs
        )
        if generation_id_for(raw_digests) != self.evidence_generation_id:
            raise ValueError(
                "evidence_generation_id must commit the exact verified_evidence_refs"
            )


@dataclass(frozen=True, slots=True)
class AnnotationTrustStore:
    """Pinned principals, keys, current annotations, and revocations."""

    keyring_id: str
    keys: tuple[TrustedAnnotationKey, ...]
    current_annotations: tuple[CurrentAnnotation, ...]
    revoked_annotation_sha256s: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_stable_id(self.keyring_id, "keyring_id")
        if type(self.keys) is not tuple:
            raise ValueError(
                "keys must be an immutable tuple of TrustedAnnotationKey values"
            )
        if not self.keys:
            raise ValueError("keys cannot be empty")
        if len(self.keys) > _MAX_TRUSTED_KEYS:
            raise ValueError(
                f"keys cannot exceed {_MAX_TRUSTED_KEYS} trusted annotation keys"
            )
        if any(type(key) is not TrustedAnnotationKey for key in self.keys):
            raise ValueError(
                "keys must be an immutable tuple of TrustedAnnotationKey values"
            )
        if len({key.key_id for key in self.keys}) != len(self.keys):
            raise ValueError("key IDs must be unique")
        if len({key.public_key_base64 for key in self.keys}) != len(self.keys):
            raise ValueError(
                "one public key cannot be assigned to multiple annotation principals"
            )
        if type(self.current_annotations) is not tuple:
            raise ValueError(
                "current_annotations must be an immutable tuple of "
                "CurrentAnnotation values"
            )
        if len(self.current_annotations) > _MAX_CURRENT_ANNOTATIONS:
            raise ValueError(
                "current_annotations cannot exceed "
                f"{_MAX_CURRENT_ANNOTATIONS} entries"
            )
        if any(
            type(item) is not CurrentAnnotation for item in self.current_annotations
        ):
            raise ValueError(
                "current_annotations must be an immutable tuple of "
                "CurrentAnnotation values"
            )
        if len({item.annotation_id for item in self.current_annotations}) != len(
            self.current_annotations
        ):
            raise ValueError("each annotation ID may have only one current fingerprint")
        if type(self.revoked_annotation_sha256s) is not tuple:
            raise ValueError(
                "revoked_annotation_sha256s must be an immutable tuple"
            )
        if len(self.revoked_annotation_sha256s) > _MAX_REVOKED_ANNOTATIONS:
            raise ValueError(
                "revoked_annotation_sha256s cannot exceed "
                f"{_MAX_REVOKED_ANNOTATIONS} entries"
            )
        for fingerprint in self.revoked_annotation_sha256s:
            _require_sha256(fingerprint, "revoked annotation fingerprint")
        if len(set(self.revoked_annotation_sha256s)) != len(
            self.revoked_annotation_sha256s
        ):
            raise ValueError(
                "revoked_annotation_sha256s cannot contain duplicates"
            )
        current_hashes = {
            item.annotation_sha256 for item in self.current_annotations
        }
        if current_hashes & set(self.revoked_annotation_sha256s):
            raise ValueError("a revoked annotation cannot also be current")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "current_annotations": [
                item.to_canonical_dict()
                for item in sorted(
                    self.current_annotations,
                    key=lambda item: item.annotation_id,
                )
            ],
            "keyring_id": self.keyring_id,
            "keys": [
                key.to_canonical_dict()
                for key in sorted(self.keys, key=lambda key: key.key_id)
            ],
            "revoked_annotation_sha256s": sorted(
                self.revoked_annotation_sha256s
            ),
            "schema_version": SCHEMA_VERSION,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()

    def verify_annotation_set(
        self,
        annotations: tuple[BallFrameAnnotation, ...],
        attestations: tuple[AnnotationAttestation, ...],
        *,
        evidence_store_root: Path,
        verification_policy: AnnotationVerificationPolicy,
        expected_verification_policy_sha256: str,
        protected_configuration_generation_path: Path,
        evaluator_artifact_sha256: str,
        requested_truth_policy: str,
    ) -> AnnotationTrustVerification:
        """Verify one bounded set against one protected generation snapshot.

        The protected current-generation descriptor is loaded and matched
        before any annotation fingerprint or signature work, then reloaded
        after evidence verification even when the UTC date did not change.
        A publisher update invalidates the whole run and requires a fresh call.
        """

        evidence_refs = _preflight_annotation_verification_bounds(
            annotations,
            attestations,
        )

        if type(requested_truth_policy) is not str:
            raise ValueError("requested_truth_policy must be an exact policy string")
        try:
            requested_policy = AnnotationMinimumTruthPolicy(requested_truth_policy)
        except ValueError as error:
            raise ValueError("requested truth policy is unsupported") from error
        if type(verification_policy) is not AnnotationVerificationPolicy:
            raise ValueError(
                "verification_policy must be an AnnotationVerificationPolicy"
            )
        if not isinstance(protected_configuration_generation_path, Path):
            raise ValueError(
                "protected_configuration_generation_path must be a pathlib.Path"
            )
        if not isinstance(evidence_store_root, Path):
            raise ValueError("evidence_store_root must be a pathlib.Path")
        _require_sha256(evaluator_artifact_sha256, "evaluator_artifact_sha256")
        _require_sha256(
            expected_verification_policy_sha256,
            "expected_verification_policy_sha256",
        )
        policy_sha256 = verification_policy.fingerprint()
        if expected_verification_policy_sha256 != policy_sha256:
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_PIN",
                "annotation verification policy does not match the independently "
                "pinned fingerprint",
            )
        store_sha256 = self.fingerprint()
        starting_configuration_generation = (
            load_protected_annotation_configuration_generation(
                protected_configuration_generation_path
            )
        )
        self._verify_protected_configuration_generation(
            starting_configuration_generation,
            verification_policy=verification_policy,
            policy_sha256=policy_sha256,
            store_sha256=store_sha256,
            evaluator_artifact_sha256=evaluator_artifact_sha256,
        )
        protected_configuration_generation_sha256 = (
            starting_configuration_generation.fingerprint()
        )
        if verification_policy.trust_store_sha256 != store_sha256:
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_TRUST_STORE",
                "annotation trust store does not match the protected verification policy",
            )
        if verification_policy.evaluator_artifact_sha256 != evaluator_artifact_sha256:
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_EVALUATOR",
                "annotation evaluator artifact does not match the protected verification policy",
            )
        if verification_policy.governance_domain_id != self.keyring_id:
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_DOMAIN",
                "annotation verification policy governance domain does not match the keyring",
            )
        if not verification_policy.permits_truth_policy(requested_truth_policy):
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_TRUTH",
                "requested truth policy is weaker than the protected minimum",
            )
        verification_started_at_utc, verification_started_on = _canonical_utc_now()
        if not verification_policy.is_active(verification_started_on):
            raise AnnotationTrustError(
                "ANNOTATION_POLICY_DATE",
                "annotation verification policy is not active on the UTC verification date",
            )
        annotation_ids = [annotation.annotation_id for annotation in annotations]
        if len(set(annotation_ids)) != len(annotation_ids):
            raise AnnotationTrustError(
                "ANNOTATION_ID_DUPLICATE",
                "annotation IDs must be unique within an evaluation",
            )

        current_by_id = {
            item.annotation_id: item.annotation_sha256
            for item in self.current_annotations
        }
        revoked = set(self.revoked_annotation_sha256s)
        _enforce_annotation_currentness_and_truth_policy(
            annotations,
            current_by_id=current_by_id,
            revoked=revoked,
            requested_truth_policy=requested_policy,
        )
        expected_signers: dict[
            tuple[str, AnnotationAttestationRole, str],
            BallFrameAnnotation,
        ] = {}
        for annotation in annotations:
            fingerprint = annotation.fingerprint()
            for reviewer_id in annotation.reviewer_ids:
                expected_signers[
                    (
                        fingerprint,
                        AnnotationAttestationRole.REVIEWER,
                        reviewer_id,
                    )
                ] = annotation
            if annotation.review_state is ReviewState.ADJUDICATED:
                assert annotation.adjudicator_id is not None
                expected_signers[
                    (
                        fingerprint,
                        AnnotationAttestationRole.ADJUDICATOR,
                        annotation.adjudicator_id,
                    )
                ] = annotation

        supplied: dict[
            tuple[str, AnnotationAttestationRole, str],
            AnnotationAttestation,
        ] = {}
        for attestation in attestations:
            signer_key = (
                attestation.annotation_sha256,
                attestation.role,
                attestation.principal_id,
            )
            if signer_key in supplied:
                raise AnnotationTrustError(
                    "ANNOTATION_ATTESTATION_DUPLICATE",
                    "duplicate annotation attestation for one principal and role",
                )
            supplied[signer_key] = attestation
        missing = sorted(
            expected_signers.keys() - supplied.keys(),
            key=lambda item: (item[0], item[1].value, item[2]),
        )
        if missing:
            raise AnnotationTrustError(
                "ANNOTATION_ATTESTATION_MISSING",
                "missing required annotation attestation for "
                f"{missing[0][1].value}:{missing[0][2]}",
            )
        extra = sorted(
            supplied.keys() - expected_signers.keys(),
            key=lambda item: (item[0], item[1].value, item[2]),
        )
        if extra:
            raise AnnotationTrustError(
                "ANNOTATION_ATTESTATION_EXTRA",
                "attestation set contains an undeclared or unrelated signer: "
                f"{extra[0][1].value}:{extra[0][2]}",
            )

        keys_by_id = {key.key_id: key for key in self.keys}
        for signer_key in sorted(
            expected_signers,
            key=lambda item: (item[0], item[1].value, item[2]),
        ):
            annotation = expected_signers[signer_key]
            attestation = supplied[signer_key]
            if attestation.trust_domain_id != self.keyring_id:
                raise AnnotationTrustError(
                    "ANNOTATION_ATTESTATION_DOMAIN",
                    "annotation attestation trust domain does not match the keyring",
                )
            trusted_key = keys_by_id.get(attestation.key_id)
            if trusted_key is None:
                raise AnnotationTrustError(
                    "ANNOTATION_KEY_UNTRUSTED",
                    "annotation attestation key is not trusted",
                )
            if trusted_key.principal_id != attestation.principal_id:
                raise AnnotationTrustError(
                    "ANNOTATION_PRINCIPAL_MISMATCH",
                    "attestation principal does not match the trusted key principal",
                )
            if attestation.role not in trusted_key.permitted_roles:
                raise AnnotationTrustError(
                    "ANNOTATION_ROLE_UNTRUSTED",
                    "trusted key is not permitted for the attestation role",
                )
            signed_on = _parse_date(attestation.signed_on, "signed_on")
            if signed_on > verification_started_on:
                raise AnnotationTrustError(
                    "ANNOTATION_ATTESTATION_DATE",
                    "annotation attestation cannot postdate the UTC verification date",
                )
            valid_from = _parse_date(trusted_key.valid_from, "valid_from")
            if signed_on < valid_from or (
                trusted_key.valid_until is not None
                and signed_on
                > _parse_date(trusted_key.valid_until, "valid_until")
            ):
                raise AnnotationTrustError(
                    "ANNOTATION_KEY_DATE",
                    "annotation key was not valid on the attestation date",
                )
            _enforce_key_not_compromised(
                trusted_key,
                verified_on=verification_started_on,
            )
            try:
                trusted_key.public_key.verify(
                    attestation.signature,
                    annotation_attestation_signing_message(
                        annotation,
                        role=attestation.role,
                        principal_id=attestation.principal_id,
                        key_id=attestation.key_id,
                        trust_domain_id=attestation.trust_domain_id,
                        signed_on=attestation.signed_on,
                    ),
                )
            except InvalidSignature as error:
                raise AnnotationTrustError(
                    "ANNOTATION_SIGNATURE_INVALID",
                    "annotation attestation signature is invalid",
                ) from error

        evidence_generation_id = verify_annotation_evidence(
            evidence_refs,
            evidence_store_root=evidence_store_root,
        )
        attestation_set_sha256 = annotation_attestation_set_fingerprint(attestations)
        evidence_set_sha256 = annotation_evidence_set_fingerprint(evidence_refs)
        validated_on = verification_started_on
        previous_timestamp = verification_started_at_utc
        for _ in range(3):
            completed_configuration_generation = (
                load_protected_annotation_configuration_generation(
                    protected_configuration_generation_path
                )
            )
            if completed_configuration_generation.fingerprint() != (
                protected_configuration_generation_sha256
            ):
                raise AnnotationTrustError(
                    "ANNOTATION_PROTECTED_CONFIGURATION_CHANGED",
                    "protected annotation configuration generation changed during "
                    "verification; discard the result and retry",
                )
            self._verify_protected_configuration_generation(
                completed_configuration_generation,
                verification_policy=verification_policy,
                policy_sha256=policy_sha256,
                store_sha256=store_sha256,
                evaluator_artifact_sha256=evaluator_artifact_sha256,
            )
            verified_at_utc, completed_on = _canonical_utc_now()
            if verified_at_utc < previous_timestamp:
                raise AnnotationTrustError(
                    "ANNOTATION_VERIFICATION_CLOCK",
                    "UTC verification time moved backward during annotation verification",
                )
            if completed_on == validated_on:
                break
            if not verification_policy.is_active(completed_on):
                raise AnnotationTrustError(
                    "ANNOTATION_POLICY_DATE",
                    "annotation verification policy is not active on the UTC completion date",
                )
            if self.fingerprint() != store_sha256:
                raise AnnotationTrustError(
                    "ANNOTATION_TRUST_STORE_CHANGED",
                    "annotation trust store changed during verification",
                )
            completion_current_by_id = {
                item.annotation_id: item.annotation_sha256
                for item in self.current_annotations
            }
            completion_revoked = set(self.revoked_annotation_sha256s)
            _enforce_annotation_currentness_and_truth_policy(
                annotations,
                current_by_id=completion_current_by_id,
                revoked=completion_revoked,
                requested_truth_policy=requested_policy,
            )
            completion_keys_by_id = {key.key_id: key for key in self.keys}
            for signer_key in expected_signers:
                attestation = supplied[signer_key]
                trusted_key = completion_keys_by_id.get(attestation.key_id)
                if trusted_key is None:
                    raise AnnotationTrustError(
                        "ANNOTATION_KEY_UNTRUSTED",
                        "annotation attestation key ceased to be trusted during verification",
                    )
                _enforce_key_not_compromised(
                    trusted_key,
                    verified_on=completed_on,
                )
            validated_on = completed_on
            previous_timestamp = verified_at_utc
        else:
            raise AnnotationTrustError(
                "ANNOTATION_VERIFICATION_CLOCK",
                "UTC verification date and protected generation did not stabilize "
                "after annotation verification",
            )
        return AnnotationTrustVerification(
            verification_policy_sha256=policy_sha256,
            requested_truth_policy=requested_policy,
            trust_store_sha256=store_sha256,
            attestation_set_sha256=attestation_set_sha256,
            evidence_set_sha256=evidence_set_sha256,
            evidence_generation_id=evidence_generation_id,
            evaluator_artifact_sha256=evaluator_artifact_sha256,
            governance_domain_id=self.keyring_id,
            protected_configuration_generation=(
                completed_configuration_generation
            ),
            protected_configuration_generation_sha256=(
                protected_configuration_generation_sha256
            ),
            verified_at_utc=verified_at_utc,
            verified_evidence_refs=evidence_refs,
        )

    def _verify_protected_configuration_generation(
        self,
        generation: ProtectedAnnotationConfigurationGeneration,
        *,
        verification_policy: AnnotationVerificationPolicy,
        policy_sha256: str,
        store_sha256: str,
        evaluator_artifact_sha256: str,
    ) -> None:
        if type(generation) is not ProtectedAnnotationConfigurationGeneration:
            raise ValueError(
                "generation must be a ProtectedAnnotationConfigurationGeneration"
            )
        comparisons = (
            (
                generation.annotation_trust_store_sha256,
                store_sha256,
                "annotation trust store",
            ),
            (
                generation.annotation_verification_policy_sha256,
                policy_sha256,
                "annotation verification policy",
            ),
            (
                generation.evaluator_artifact_sha256,
                evaluator_artifact_sha256,
                "evaluator artifact",
            ),
            (
                generation.governance_domain_id,
                self.keyring_id,
                "annotation trust-store governance domain",
            ),
            (
                generation.governance_domain_id,
                verification_policy.governance_domain_id,
                "annotation policy governance domain",
            ),
        )
        for declared, actual, label in comparisons:
            if declared != actual:
                raise AnnotationTrustError(
                    "ANNOTATION_PROTECTED_CONFIGURATION_COMPONENT",
                    "protected annotation configuration generation does not "
                    f"match {label}",
                )


def _preflight_annotation_verification_bounds(
    annotations: object,
    attestations: object,
) -> tuple[str, ...]:
    """Reject amplification before canonicalization, sorting, or signatures."""

    if type(annotations) is not tuple:
        raise ValueError(
            "annotations must be an immutable tuple of BallFrameAnnotation values"
        )
    if not annotations or len(annotations) > _MAX_ANNOTATIONS:
        raise AnnotationTrustError(
            "ANNOTATION_COUNT",
            "annotation count must be between 1 and "
            f"{_MAX_ANNOTATIONS}",
        )
    if type(attestations) is not tuple:
        raise ValueError(
            "attestations must be an immutable tuple of AnnotationAttestation values"
        )
    if len(attestations) > _MAX_ATTESTATIONS:
        raise AnnotationTrustError(
            "ANNOTATION_ATTESTATION_COUNT",
            f"annotation attestation count cannot exceed {_MAX_ATTESTATIONS}",
        )

    references: set[str] = set()
    expected_attestation_count = 0
    for annotation in annotations:
        if type(annotation) is not BallFrameAnnotation:
            raise ValueError(
                "annotations must be an immutable tuple of "
                "BallFrameAnnotation values"
            )
        if len(annotation.reviewer_ids) > _MAX_REVIEWERS_PER_ANNOTATION:
            raise AnnotationTrustError(
                "ANNOTATION_REVIEWER_COUNT",
                "annotation reviewer count cannot exceed "
                f"{_MAX_REVIEWERS_PER_ANNOTATION}",
            )
        expected_attestation_count += len(annotation.reviewer_ids)
        if annotation.review_state is ReviewState.ADJUDICATED:
            expected_attestation_count += 1
        if expected_attestation_count > _MAX_ATTESTATIONS:
            raise AnnotationTrustError(
                "ANNOTATION_ATTESTATION_COUNT",
                "required annotation attestation count cannot exceed "
                f"{_MAX_ATTESTATIONS}",
            )
        if (
            type(annotation.review_evidence_refs) is not tuple
            or type(annotation.adjudication_evidence_refs) is not tuple
            or type(annotation.frame.capture_integrity_attestation_refs)
            is not tuple
        ):
            raise ValueError(
                "annotation evidence references must be immutable tuples"
            )
        if len(annotation.frame.capture_integrity_attestation_refs) > (
            _MAX_CAPTURE_ATTESTATION_REFS
        ):
            raise AnnotationTrustError(
                "ANNOTATION_CAPTURE_EVIDENCE_COUNT",
                "capture-integrity attestation refs cannot exceed "
                f"{_MAX_CAPTURE_ATTESTATION_REFS} per annotation",
            )
        if (
            len(annotation.review_evidence_refs)
            + len(annotation.adjudication_evidence_refs)
            + len(annotation.frame.capture_integrity_attestation_refs)
            > _MAX_EVIDENCE_REFS_PER_ANNOTATION
        ):
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_COUNT",
                "annotation evidence cannot exceed "
                f"{_MAX_EVIDENCE_REFS_PER_ANNOTATION} refs per annotation",
            )
        for collection in (
            annotation.review_evidence_refs,
            annotation.adjudication_evidence_refs,
            annotation.frame.capture_integrity_attestation_refs,
        ):
            for reference in collection:
                if type(reference) is not str or not _CONTENT_ADDRESS_RE.fullmatch(
                    reference
                ):
                    raise ValueError(
                        "annotation evidence refs must be SHA-256 content addresses"
                    )
                references.add(reference)
                if len(references) > _MAX_EVIDENCE_FILES:
                    raise AnnotationTrustError(
                        "ANNOTATION_EVIDENCE_COUNT",
                        "annotation evidence set cannot exceed "
                        f"{_MAX_EVIDENCE_FILES} unique refs",
                    )

    for attestation in attestations:
        if type(attestation) is not AnnotationAttestation:
            raise ValueError(
                "attestations must be an immutable tuple of "
                "AnnotationAttestation values"
            )
    if not references:
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_COUNT",
            "annotation evidence set cannot be empty",
        )
    return tuple(sorted(references))


def _enforce_annotation_currentness_and_truth_policy(
    annotations: tuple[BallFrameAnnotation, ...],
    *,
    current_by_id: dict[str, str],
    revoked: set[str],
    requested_truth_policy: AnnotationMinimumTruthPolicy,
) -> None:
    """Revalidate mutable-governance facts at one verification date boundary."""

    for annotation in annotations:
        fingerprint = annotation.fingerprint()
        if fingerprint in revoked:
            raise AnnotationTrustError(
                "ANNOTATION_REVOKED",
                f"annotation has been revoked: {annotation.annotation_id}",
            )
        current = current_by_id.get(annotation.annotation_id)
        if current is None:
            raise AnnotationTrustError(
                "ANNOTATION_UNTRUSTED",
                "trust store has no current fingerprint for annotation: "
                f"{annotation.annotation_id}",
            )
        if current != fingerprint:
            raise AnnotationTrustError(
                "ANNOTATION_STALE",
                f"annotation is not current: {annotation.annotation_id}",
            )
        if annotation.review_state is ReviewState.DRAFT:
            raise AnnotationTrustError(
                "ANNOTATION_DRAFT",
                f"DRAFT annotation is not trusted truth: {annotation.annotation_id}",
            )
        if (
            requested_truth_policy
            is AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY
            and annotation.review_state is not ReviewState.ADJUDICATED
        ):
            raise AnnotationTrustError(
                "ANNOTATION_TRUTH_POLICY",
                "annotation is below the requested ADJUDICATED_ONLY truth policy: "
                f"{annotation.annotation_id}",
            )


def _enforce_key_not_compromised(
    trusted_key: TrustedAnnotationKey,
    *,
    verified_on: date,
) -> None:
    if (
        trusted_key.compromised_on is not None
        and _parse_date(trusted_key.compromised_on, "compromised_on") <= verified_on
    ):
        raise AnnotationTrustError(
            "ANNOTATION_KEY_COMPROMISED",
            "annotation key is compromised and every signature is invalidated",
        )


def annotation_attestation_signing_message(
    annotation: BallFrameAnnotation,
    *,
    role: AnnotationAttestationRole,
    principal_id: str,
    key_id: str,
    trust_domain_id: str,
    signed_on: str,
) -> bytes:
    """Return the domain-separated bytes an annotation principal signs."""

    if type(annotation) is not BallFrameAnnotation:
        raise ValueError("annotation must be a BallFrameAnnotation")
    if type(role) is not AnnotationAttestationRole:
        raise ValueError("role must be an AnnotationAttestationRole")
    _require_stable_id(principal_id, "principal_id")
    _require_stable_id(key_id, "key_id")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _parse_date(signed_on, "signed_on")
    return _canonical_json(
        {
            "annotation": annotation.to_canonical_dict(),
            "domain": _SIGNING_DOMAIN,
            "key_id": key_id,
            "principal_id": principal_id,
            "role": role.value,
            "signed_on": signed_on,
            "trust_domain_id": trust_domain_id,
        }
    ).encode("utf-8")


def annotation_attestation_set_fingerprint(
    attestations: tuple[AnnotationAttestation, ...],
) -> str:
    if type(attestations) is not tuple:
        raise ValueError(
            "attestations must be an immutable tuple of AnnotationAttestation values"
        )
    if len(attestations) > _MAX_ATTESTATIONS:
        raise ValueError(
            f"attestations cannot exceed {_MAX_ATTESTATIONS} entries"
        )
    if any(
        type(attestation) is not AnnotationAttestation
        for attestation in attestations
    ):
        raise ValueError(
            "attestations must be an immutable tuple of AnnotationAttestation values"
        )
    ordered = sorted(
        attestations,
        key=lambda attestation: (
            attestation.annotation_sha256,
            attestation.role.value,
            attestation.principal_id,
            attestation.key_id,
            attestation.trust_domain_id,
            attestation.signed_on,
            attestation.signature_base64,
        ),
    )
    payload = {
        "attestations": [item.to_canonical_dict() for item in ordered],
        "domain": _ATTESTATION_SET_DOMAIN,
        "schema_version": SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def annotation_evidence_set_fingerprint(
    evidence_refs: tuple[str, ...],
) -> str:
    if type(evidence_refs) is not tuple:
        raise ValueError("evidence_refs must be an immutable tuple")
    if not evidence_refs:
        raise ValueError("evidence_refs cannot be empty")
    if len(evidence_refs) > _MAX_EVIDENCE_FILES:
        raise ValueError(
            f"evidence_refs cannot exceed {_MAX_EVIDENCE_FILES} entries"
        )
    canonical_refs = tuple(sorted(evidence_refs))
    if canonical_refs != evidence_refs or len(set(evidence_refs)) != len(evidence_refs):
        raise ValueError("evidence_refs must be sorted and contain no duplicates")
    for reference in evidence_refs:
        if type(reference) is not str or not _CONTENT_ADDRESS_RE.fullmatch(reference):
            raise ValueError("evidence refs must be SHA-256 content addresses")
    payload = {
        "domain": _EVIDENCE_SET_DOMAIN,
        "evidence_refs": list(evidence_refs),
        "schema_version": SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def verify_annotation_evidence(
    evidence_refs: tuple[str, ...],
    *,
    evidence_store_root: Path,
) -> str:
    """Verify one exact immutable evidence generation in a killable worker.

    Returns the generation ID derived from the complete required raw digest
    tuple. The protected publisher must have published exactly that generation;
    a superset, subset, or mutable flat directory is rejected.
    """

    if type(evidence_refs) is not tuple:
        raise ValueError("evidence_refs must be an immutable tuple")
    if not evidence_refs or len(evidence_refs) > _MAX_EVIDENCE_FILES:
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_COUNT",
            "annotation evidence count must be between 1 and "
            f"{_MAX_EVIDENCE_FILES}",
        )
    digests: list[str] = []
    for reference in evidence_refs:
        if type(reference) is not str:
            raise ValueError("evidence refs must be SHA-256 content addresses")
        match = _CONTENT_ADDRESS_RE.fullmatch(reference)
        if match is None:
            raise ValueError("evidence refs must be SHA-256 content addresses")
        digests.append(match.group(1))
    if tuple(sorted(evidence_refs)) != evidence_refs or len(set(digests)) != len(
        digests
    ):
        raise ValueError("evidence refs must be sorted and contain no duplicates")
    required_digests = tuple(digests)
    if not isinstance(evidence_store_root, Path):
        raise ValueError("evidence_store_root must be a pathlib.Path")
    absolute_evidence_store_root = Path(
        os.path.abspath(os.fspath(evidence_store_root))
    )
    evidence_generation_id = generation_id_for(required_digests)
    deadline = time.monotonic() + _EVIDENCE_TIMEOUT_SECONDS
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(
        target=_annotation_evidence_worker,
        args=(
            str(absolute_evidence_store_root),
            required_digests,
            evidence_generation_id,
            sender,
        ),
        daemon=True,
    )
    started = False
    result: object | None = None
    try:
        worker.start()
        started = True
        sender.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0.0 or not receiver.poll(remaining):
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_TIMEOUT",
                "annotation evidence verification exceeded the absolute deadline",
            )
        try:
            result = receiver.recv()
        except EOFError as error:
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_WORKER",
                "annotation evidence worker exited without a result",
            ) from error
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_TIMEOUT",
                "annotation evidence verification exceeded the absolute deadline",
            )
        worker.join(timeout=remaining)
        if worker.is_alive():
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_TIMEOUT",
                "annotation evidence worker did not exit before the absolute deadline",
            )
        if time.monotonic() > deadline:
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_TIMEOUT",
                "annotation evidence verification exceeded the absolute deadline",
            )
        if worker.exitcode != 0:
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_WORKER",
                "annotation evidence worker exited unsuccessfully",
            )
        _validate_annotation_evidence_worker_result(result)
        assert type(result) is dict
        if result["ok"] is not True:
            raise AnnotationTrustError(result["code"], result["message"])
        if time.monotonic() > deadline:
            raise AnnotationTrustError(
                "ANNOTATION_EVIDENCE_TIMEOUT",
                "annotation evidence verification exceeded the absolute deadline",
            )
        return evidence_generation_id
    finally:
        receiver.close()
        sender.close()
        if started and worker.is_alive():
            worker.terminate()
            worker.join(timeout=1.0)
            if worker.is_alive():
                worker.kill()
                worker.join(timeout=1.0)
        if started and not worker.is_alive():
            worker.close()


def _annotation_evidence_worker(
    evidence_store_root: str,
    digests: tuple[str, ...],
    evidence_generation_id: str,
    sender: Connection,
) -> None:
    try:
        _verify_annotation_evidence_sync(
            Path(evidence_store_root),
            digests,
            evidence_generation_id,
        )
    except AnnotationTrustError as error:
        result = {"ok": False, "code": error.code, "message": str(error)}
    except BaseException:
        result = {
            "ok": False,
            "code": "ANNOTATION_EVIDENCE_WORKER",
            "message": "annotation evidence worker failed closed",
        }
    else:
        result = {"ok": True, "code": "", "message": ""}
    try:
        sender.send(result)
    finally:
        sender.close()


def _verify_annotation_evidence_sync(
    evidence_store_root: Path,
    digests: tuple[str, ...],
    evidence_generation_id: str,
) -> None:
    """Verify and size one exact evidence set under a single shared lease."""

    started = time.monotonic()
    try:
        with generation_read_lease(
            evidence_store_root,
            evidence_generation_id,
        ) as lease:
            if lease.descriptor.object_sha256s != digests:
                raise AnnotationTrustError(
                    "ANNOTATION_EVIDENCE_GENERATION_MEMBERSHIP",
                    "annotation evidence generation must contain exactly the required digest set",
                )
            total_bytes = 0
            for expected_sha256 in digests:
                _check_evidence_deadline(started)
                with lease.open_verified_object(
                    expected_sha256,
                    max_bytes=_MAX_EVIDENCE_BYTES,
                ) as staged:
                    staged_stat = os.fstat(staged.fileno())
                    if not stat.S_ISREG(staged_stat.st_mode) or staged_stat.st_size < 0:
                        raise AnnotationTrustError(
                            "ANNOTATION_EVIDENCE_STAGING",
                            "verified annotation evidence staging is not a regular file",
                        )
                    if staged_stat.st_size > _MAX_EVIDENCE_BYTES:
                        raise AnnotationTrustError(
                            "ANNOTATION_EVIDENCE_SIZE",
                            "annotation evidence exceeds the per-object byte limit",
                        )
                    total_bytes += staged_stat.st_size
                    if total_bytes > _MAX_TOTAL_EVIDENCE_BYTES:
                        raise AnnotationTrustError(
                            "ANNOTATION_EVIDENCE_TOTAL_SIZE",
                            "annotation evidence exceeds the total byte limit",
                        )
                _check_evidence_deadline(started)
    except ImmutableStoreError as error:
        raise AnnotationTrustError(
            _IMMUTABLE_STORE_ERROR_CODES.get(
                error.code,
                "ANNOTATION_EVIDENCE_STORE",
            ),
            f"immutable annotation evidence store rejected the generation: {error}",
        ) from error


def _check_evidence_deadline(started: float) -> None:
    if time.monotonic() - started > _EVIDENCE_TIMEOUT_SECONDS:
        raise AnnotationTrustError(
            "ANNOTATION_EVIDENCE_TIMEOUT",
            "annotation evidence verification exceeded the absolute deadline",
        )
