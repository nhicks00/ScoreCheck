"""Out-of-band trust for dataset manifests and readiness verification.

Dataset JSON is untrusted input.  A manifest becomes eligible for readiness
evaluation only when its canonical fingerprint is the current fingerprint in a
separately pinned :class:`DatasetTrustStore` and an authorized curator has
signed that exact dataset/fingerprint pair.  Deployment policy is a second,
independently pinned object; no value in a dataset manifest may select its own
keyring, verifier, runtime, or deployment artifact.

Callers are responsible for obtaining ``verified_on`` from their trusted clock
and every ``actual_*`` fingerprint from the named trusted launcher/runtime
boundary.  This module intentionally provides no fallback or self-pin default.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


SCHEMA_VERSION = "1.0"
_ATTESTATION_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:dataset-manifest-attestation:v1"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAX_TRUST_JSON_BYTES = 4 * 1024 * 1024
_MAX_TRUST_KEYS = 128
_MAX_CURRENT_MANIFESTS = 100_000
_MAX_REVOKED_MANIFESTS = 100_000

_ATTESTATION_FIELDS = frozenset(
    {
        "curator_id",
        "dataset_id",
        "key_id",
        "manifest_sha256",
        "schema_version",
        "signature_base64",
        "signed_on",
        "trust_domain_id",
    }
)
_KEY_FIELDS = frozenset(
    {
        "compromised_on",
        "curator_id",
        "key_id",
        "public_key_base64",
        "valid_from",
        "valid_until",
    }
)
_CURRENT_MANIFEST_FIELDS = frozenset({"dataset_id", "manifest_sha256"})
_TRUST_STORE_FIELDS = frozenset(
    {
        "current_manifests",
        "keyring_id",
        "keys",
        "revoked_manifest_sha256s",
        "schema_version",
    }
)
_POLICY_FIELDS = frozenset(
    {
        "dataset_trust_store_sha256",
        "deployment_artifact_sha256",
        "governance_domain_id",
        "policy_id",
        "require_unseen_test_venue",
        "rights_verification_policy_sha256",
        "runtime_identity_sha256",
        "schema_version",
        "valid_from",
        "valid_until",
        "verifier_source_tree_sha256",
    }
)
_CONFIGURATION_GENERATION_FIELDS = frozenset(
    {
        "dataset_manifest_attestation_sha256",
        "dataset_trust_store_sha256",
        "governance_domain_id",
        "readiness_verification_policy_sha256",
        "rights_trust_store_sha256",
        "rights_verification_policy_sha256",
        "schema_version",
        "trusted_launcher_deployment_artifact_sha256",
    }
)


class ReadinessTrustError(ValueError):
    """A trust-boundary failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or not _STABLE_ID_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


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
        raise ValueError(
            f"{field_name} must be canonical base64 for {expected_bytes} bytes"
        )
    return decoded


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    """Return the deterministic UTF-8 JSON encoding used by this boundary."""

    if not isinstance(value, Mapping):
        raise ValueError("canonical JSON root must be a mapping")
    try:
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError("value must be canonicalizable finite UTF-8 JSON") from exc


def canonical_manifest_sha256(manifest: Mapping[str, Any]) -> str:
    """Fingerprint the exact canonical manifest payload."""

    return hashlib.sha256(canonical_json_bytes(manifest)).hexdigest()


def _canonical_json(value: Mapping[str, Any]) -> str:
    return canonical_json_bytes(value).decode("utf-8")


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


def _strict_json_object(path: Path, *, label: str) -> Mapping[str, Any]:
    """Read one bounded regular file through a stable descriptor."""

    if not isinstance(path, Path):
        raise ValueError(f"{label} path must be a pathlib.Path")
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


@dataclass(frozen=True, slots=True)
class DatasetManifestAttestation:
    """Detached curator signature over one canonical dataset manifest."""

    dataset_id: str
    manifest_sha256: str
    curator_id: str
    key_id: str
    trust_domain_id: str
    signed_on: str
    signature_base64: str

    def __post_init__(self) -> None:
        _require_stable_id(self.dataset_id, "dataset_id")
        _require_sha256(self.manifest_sha256, "manifest_sha256")
        _require_stable_id(self.curator_id, "curator_id")
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
            "curator_id": self.curator_id,
            "dataset_id": self.dataset_id,
            "key_id": self.key_id,
            "manifest_sha256": self.manifest_sha256,
            "schema_version": SCHEMA_VERSION,
            "signature_base64": self.signature_base64,
            "signed_on": self.signed_on,
            "trust_domain_id": self.trust_domain_id,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class TrustedDatasetKey:
    key_id: str
    curator_id: str
    public_key_base64: str
    valid_from: str
    valid_until: str | None
    compromised_on: str | None

    def __post_init__(self) -> None:
        _require_stable_id(self.key_id, "key_id")
        _require_stable_id(self.curator_id, "curator_id")
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
            "compromised_on": self.compromised_on,
            "curator_id": self.curator_id,
            "key_id": self.key_id,
            "public_key_base64": self.public_key_base64,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
        }


@dataclass(frozen=True, slots=True)
class CurrentDatasetManifest:
    dataset_id: str
    manifest_sha256: str

    def __post_init__(self) -> None:
        _require_stable_id(self.dataset_id, "dataset_id")
        _require_sha256(self.manifest_sha256, "manifest_sha256")

    def to_canonical_dict(self) -> dict[str, str]:
        return {
            "dataset_id": self.dataset_id,
            "manifest_sha256": self.manifest_sha256,
        }


@dataclass(frozen=True, slots=True)
class DatasetTrustStore:
    """Out-of-band curator keys and the sole current manifest per dataset."""

    keyring_id: str
    keys: tuple[TrustedDatasetKey, ...]
    current_manifests: tuple[CurrentDatasetManifest, ...]
    revoked_manifest_sha256s: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_stable_id(self.keyring_id, "keyring_id")
        if type(self.keys) is not tuple or any(
            type(key) is not TrustedDatasetKey for key in self.keys
        ):
            raise ValueError("keys must be an immutable tuple of TrustedDatasetKey values")
        if not self.keys:
            raise ValueError("keys cannot be empty")
        if len(self.keys) > _MAX_TRUST_KEYS:
            raise ValueError(f"dataset trust store exceeds {_MAX_TRUST_KEYS} keys")
        if len({key.key_id for key in self.keys}) != len(self.keys):
            raise ValueError("key IDs must be unique")
        if len({key.public_key_base64 for key in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot be assigned to multiple key records")

        if type(self.current_manifests) is not tuple or any(
            type(item) is not CurrentDatasetManifest for item in self.current_manifests
        ):
            raise ValueError(
                "current_manifests must be an immutable tuple of "
                "CurrentDatasetManifest values"
            )
        if len(self.current_manifests) > _MAX_CURRENT_MANIFESTS:
            raise ValueError(
                f"dataset trust store exceeds {_MAX_CURRENT_MANIFESTS} current manifests"
            )
        if len({item.dataset_id for item in self.current_manifests}) != len(
            self.current_manifests
        ):
            raise ValueError("each dataset may have only one current manifest")

        if type(self.revoked_manifest_sha256s) is not tuple:
            raise ValueError("revoked_manifest_sha256s must be an immutable tuple")
        if len(self.revoked_manifest_sha256s) > _MAX_REVOKED_MANIFESTS:
            raise ValueError(
                f"dataset trust store exceeds {_MAX_REVOKED_MANIFESTS} revocations"
            )
        for fingerprint in self.revoked_manifest_sha256s:
            _require_sha256(fingerprint, "revoked manifest fingerprint")
        if len(set(self.revoked_manifest_sha256s)) != len(
            self.revoked_manifest_sha256s
        ):
            raise ValueError("revoked_manifest_sha256s cannot contain duplicates")
        current_hashes = {
            item.manifest_sha256 for item in self.current_manifests
        }
        if current_hashes & set(self.revoked_manifest_sha256s):
            raise ValueError("a revoked manifest cannot also be current")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "current_manifests": [
                item.to_canonical_dict()
                for item in sorted(
                    self.current_manifests,
                    key=lambda item: item.dataset_id,
                )
            ],
            "keyring_id": self.keyring_id,
            "keys": [
                key.to_canonical_dict()
                for key in sorted(self.keys, key=lambda key: key.key_id)
            ],
            "revoked_manifest_sha256s": sorted(self.revoked_manifest_sha256s),
            "schema_version": SCHEMA_VERSION,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()

    def verify(
        self,
        *,
        dataset_id: str,
        manifest_sha256: str,
        attestation: DatasetManifestAttestation,
        verified_on: str,
    ) -> None:
        """Verify currentness, signer authority, dates, and signature.

        ``verified_on`` must come from the caller's trusted current clock.  Key
        retirement constrains signing time, while ``compromised_on`` invalidates
        the key retroactively once the compromise is known.
        """

        _require_stable_id(dataset_id, "dataset_id")
        _require_sha256(manifest_sha256, "manifest_sha256")
        if type(attestation) is not DatasetManifestAttestation:
            raise ValueError("attestation must be a DatasetManifestAttestation")
        verified_on_date = _parse_date(verified_on, "verified_on")

        if attestation.trust_domain_id != self.keyring_id:
            raise ReadinessTrustError(
                "DATASET_ATTESTATION_DOMAIN",
                "attestation trust domain does not match the pinned keyring",
            )
        if attestation.dataset_id != dataset_id:
            raise ReadinessTrustError(
                "DATASET_ATTESTATION_DATASET",
                "attestation does not name the requested dataset",
            )
        if attestation.manifest_sha256 != manifest_sha256:
            raise ReadinessTrustError(
                "DATASET_ATTESTATION_MANIFEST",
                "attestation does not name the canonical manifest",
            )
        if manifest_sha256 in self.revoked_manifest_sha256s:
            raise ReadinessTrustError(
                "DATASET_MANIFEST_REVOKED",
                "the dataset manifest has been revoked",
            )
        current_by_dataset = {
            item.dataset_id: item.manifest_sha256 for item in self.current_manifests
        }
        current = current_by_dataset.get(dataset_id)
        if current is None:
            raise ReadinessTrustError(
                "DATASET_MANIFEST_UNTRUSTED",
                "the trust store has no current manifest for this dataset",
            )
        if current != manifest_sha256:
            raise ReadinessTrustError(
                "DATASET_MANIFEST_STALE",
                "the supplied manifest is not current for this dataset",
            )

        key = {item.key_id: item for item in self.keys}.get(attestation.key_id)
        if key is None:
            raise ReadinessTrustError(
                "DATASET_CURATOR_UNTRUSTED",
                "attestation key is not in the pinned dataset trust store",
            )
        if key.curator_id != attestation.curator_id:
            raise ReadinessTrustError(
                "DATASET_CURATOR_MISMATCH",
                "attestation curator does not match the trusted key principal",
            )

        signed_on = _parse_date(attestation.signed_on, "signed_on")
        if signed_on > verified_on_date:
            raise ReadinessTrustError(
                "DATASET_ATTESTATION_DATE",
                "attestation cannot be signed after the trusted verification date",
            )
        if signed_on < _parse_date(key.valid_from, "valid_from") or (
            key.valid_until is not None
            and signed_on > _parse_date(key.valid_until, "valid_until")
        ):
            raise ReadinessTrustError(
                "DATASET_CURATOR_KEY_DATE",
                "curator key was not valid on the attestation date",
            )
        if key.compromised_on is not None and verified_on_date >= _parse_date(
            key.compromised_on,
            "compromised_on",
        ):
            raise ReadinessTrustError(
                "DATASET_CURATOR_KEY_COMPROMISED",
                "curator key is compromised and retroactively untrusted",
            )
        try:
            key.public_key.verify(
                attestation.signature,
                dataset_manifest_attestation_signing_message(
                    dataset_id=attestation.dataset_id,
                    manifest_sha256=attestation.manifest_sha256,
                    curator_id=attestation.curator_id,
                    key_id=attestation.key_id,
                    trust_domain_id=attestation.trust_domain_id,
                    signed_on=attestation.signed_on,
                ),
            )
        except InvalidSignature as exc:
            raise ReadinessTrustError(
                "DATASET_ATTESTATION_SIGNATURE",
                "dataset manifest attestation signature is invalid",
            ) from exc


@dataclass(frozen=True, slots=True)
class ReadinessVerificationPolicy:
    """Protected readiness policy supplied and pinned outside the dataset."""

    policy_id: str
    dataset_trust_store_sha256: str
    rights_verification_policy_sha256: str
    verifier_source_tree_sha256: str
    deployment_artifact_sha256: str
    runtime_identity_sha256: str
    governance_domain_id: str
    require_unseen_test_venue: bool
    valid_from: str
    valid_until: str

    def __post_init__(self) -> None:
        _require_stable_id(self.policy_id, "policy_id")
        _require_sha256(
            self.dataset_trust_store_sha256,
            "dataset_trust_store_sha256",
        )
        _require_sha256(
            self.rights_verification_policy_sha256,
            "rights_verification_policy_sha256",
        )
        _require_sha256(
            self.verifier_source_tree_sha256,
            "verifier_source_tree_sha256",
        )
        _require_sha256(
            self.deployment_artifact_sha256,
            "deployment_artifact_sha256",
        )
        _require_sha256(self.runtime_identity_sha256, "runtime_identity_sha256")
        _require_stable_id(self.governance_domain_id, "governance_domain_id")
        if self.require_unseen_test_venue is not True:
            raise ValueError("require_unseen_test_venue must be the JSON boolean true")
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
            "dataset_trust_store_sha256": self.dataset_trust_store_sha256,
            "deployment_artifact_sha256": self.deployment_artifact_sha256,
            "governance_domain_id": self.governance_domain_id,
            "policy_id": self.policy_id,
            "require_unseen_test_venue": self.require_unseen_test_venue,
            "rights_verification_policy_sha256": (
                self.rights_verification_policy_sha256
            ),
            "runtime_identity_sha256": self.runtime_identity_sha256,
            "schema_version": SCHEMA_VERSION,
            "valid_from": self.valid_from,
            "valid_until": self.valid_until,
            "verifier_source_tree_sha256": self.verifier_source_tree_sha256,
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ProtectedConfigurationGeneration:
    """One publisher-atomic generation of protected readiness inputs.

    The descriptor is a current-generation pointer supplied by the trusted
    launcher, never by a dataset.  Its fingerprint is sampled before and after
    a validation run so a concurrently published revocation/policy generation
    forces the result to be discarded and retried.
    """

    dataset_trust_store_sha256: str
    dataset_manifest_attestation_sha256: str
    readiness_verification_policy_sha256: str
    rights_trust_store_sha256: str
    rights_verification_policy_sha256: str
    trusted_launcher_deployment_artifact_sha256: str
    governance_domain_id: str

    def __post_init__(self) -> None:
        for value, label in (
            (self.dataset_trust_store_sha256, "dataset_trust_store_sha256"),
            (
                self.dataset_manifest_attestation_sha256,
                "dataset_manifest_attestation_sha256",
            ),
            (
                self.readiness_verification_policy_sha256,
                "readiness_verification_policy_sha256",
            ),
            (self.rights_trust_store_sha256, "rights_trust_store_sha256"),
            (
                self.rights_verification_policy_sha256,
                "rights_verification_policy_sha256",
            ),
            (
                self.trusted_launcher_deployment_artifact_sha256,
                "trusted_launcher_deployment_artifact_sha256",
            ),
        ):
            _require_sha256(value, label)
        _require_stable_id(self.governance_domain_id, "governance_domain_id")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "dataset_manifest_attestation_sha256": (
                self.dataset_manifest_attestation_sha256
            ),
            "dataset_trust_store_sha256": self.dataset_trust_store_sha256,
            "governance_domain_id": self.governance_domain_id,
            "readiness_verification_policy_sha256": (
                self.readiness_verification_policy_sha256
            ),
            "rights_trust_store_sha256": self.rights_trust_store_sha256,
            "rights_verification_policy_sha256": (
                self.rights_verification_policy_sha256
            ),
            "schema_version": SCHEMA_VERSION,
            "trusted_launcher_deployment_artifact_sha256": (
                self.trusted_launcher_deployment_artifact_sha256
            ),
        }

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def protected_configuration_generation_from_dict(
    payload: Mapping[str, Any],
) -> ProtectedConfigurationGeneration:
    if not isinstance(payload, Mapping):
        raise ValueError("protected configuration generation must be a JSON object")
    _exact_fields(
        payload,
        _CONFIGURATION_GENERATION_FIELDS,
        "protected configuration generation",
    )
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            "protected configuration generation schema_version must be "
            f"{SCHEMA_VERSION}"
        )
    return ProtectedConfigurationGeneration(
        dataset_trust_store_sha256=payload.get("dataset_trust_store_sha256"),
        dataset_manifest_attestation_sha256=payload.get(
            "dataset_manifest_attestation_sha256"
        ),
        readiness_verification_policy_sha256=payload.get(
            "readiness_verification_policy_sha256"
        ),
        rights_trust_store_sha256=payload.get("rights_trust_store_sha256"),
        rights_verification_policy_sha256=payload.get(
            "rights_verification_policy_sha256"
        ),
        trusted_launcher_deployment_artifact_sha256=payload.get(
            "trusted_launcher_deployment_artifact_sha256"
        ),
        governance_domain_id=payload.get("governance_domain_id"),
    )


def load_protected_configuration_generation(
    path: Path,
) -> ProtectedConfigurationGeneration:
    return protected_configuration_generation_from_dict(
        _strict_json_object(path, label="protected configuration generation")
    )


def verify_readiness_policy_pins(
    policy: ReadinessVerificationPolicy,
    *,
    expected_policy_sha256: str,
    actual_dataset_trust_store_sha256: str,
    actual_rights_verification_policy_sha256: str,
    actual_verifier_source_tree_sha256: str,
    trusted_launcher_deployment_artifact_sha256: str,
    actual_runtime_identity_sha256: str,
    expected_governance_domain_id: str,
    verified_on: str,
) -> None:
    """Fail closed unless every independently supplied deployment pin matches."""

    if type(policy) is not ReadinessVerificationPolicy:
        raise ValueError("policy must be a ReadinessVerificationPolicy")
    _require_sha256(expected_policy_sha256, "expected_policy_sha256")
    _require_sha256(
        actual_dataset_trust_store_sha256,
        "actual_dataset_trust_store_sha256",
    )
    _require_sha256(
        actual_rights_verification_policy_sha256,
        "actual_rights_verification_policy_sha256",
    )
    _require_sha256(
        actual_verifier_source_tree_sha256,
        "actual_verifier_source_tree_sha256",
    )
    _require_sha256(
        trusted_launcher_deployment_artifact_sha256,
        "trusted_launcher_deployment_artifact_sha256",
    )
    _require_sha256(
        actual_runtime_identity_sha256,
        "actual_runtime_identity_sha256",
    )
    _require_stable_id(expected_governance_domain_id, "expected_governance_domain_id")
    _parse_date(verified_on, "verified_on")

    if policy.fingerprint() != expected_policy_sha256:
        raise ReadinessTrustError(
            "READINESS_POLICY_UNPINNED",
            "readiness policy does not match its independent expected fingerprint",
        )
    if not policy.is_active(verified_on):
        raise ReadinessTrustError(
            "READINESS_POLICY_DATE",
            "readiness policy is not active on the trusted verification date",
        )
    comparisons = (
        (
            policy.dataset_trust_store_sha256,
            actual_dataset_trust_store_sha256,
            "READINESS_DATASET_TRUST_STORE_PIN",
            "dataset trust store",
        ),
        (
            policy.rights_verification_policy_sha256,
            actual_rights_verification_policy_sha256,
            "READINESS_RIGHTS_POLICY_PIN",
            "rights verification policy",
        ),
        (
            policy.verifier_source_tree_sha256,
            actual_verifier_source_tree_sha256,
            "READINESS_VERIFIER_SOURCE_PIN",
            "verifier source tree",
        ),
        (
            policy.deployment_artifact_sha256,
            trusted_launcher_deployment_artifact_sha256,
            "READINESS_DEPLOYMENT_ARTIFACT_PIN",
            "trusted-launcher deployment artifact",
        ),
        (
            policy.runtime_identity_sha256,
            actual_runtime_identity_sha256,
            "READINESS_RUNTIME_IDENTITY_PIN",
            "runtime identity",
        ),
    )
    for expected, actual, code, label in comparisons:
        if expected != actual:
            raise ReadinessTrustError(code, f"{label} fingerprint does not match policy")
    if policy.governance_domain_id != expected_governance_domain_id:
        raise ReadinessTrustError(
            "READINESS_GOVERNANCE_DOMAIN",
            "governance domain does not match the trusted deployment domain",
        )


def dataset_manifest_attestation_signing_message(
    *,
    dataset_id: str,
    manifest_sha256: str,
    curator_id: str,
    key_id: str,
    trust_domain_id: str,
    signed_on: str,
) -> bytes:
    """Return domain-separated canonical bytes for an external curator to sign."""

    _require_stable_id(dataset_id, "dataset_id")
    _require_sha256(manifest_sha256, "manifest_sha256")
    _require_stable_id(curator_id, "curator_id")
    _require_stable_id(key_id, "key_id")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _parse_date(signed_on, "signed_on")
    return canonical_json_bytes(
        {
            "curator_id": curator_id,
            "dataset_id": dataset_id,
            "domain": _ATTESTATION_SIGNING_DOMAIN,
            "key_id": key_id,
            "manifest_sha256": manifest_sha256,
            "signed_on": signed_on,
            "trust_domain_id": trust_domain_id,
        }
    )


def dataset_manifest_attestation_from_dict(
    payload: Mapping[str, Any],
) -> DatasetManifestAttestation:
    if not isinstance(payload, Mapping):
        raise ValueError("dataset manifest attestation must be a JSON object")
    _exact_fields(payload, _ATTESTATION_FIELDS, "dataset manifest attestation")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"dataset manifest attestation schema_version must be {SCHEMA_VERSION}"
        )
    return DatasetManifestAttestation(
        dataset_id=payload.get("dataset_id"),
        manifest_sha256=payload.get("manifest_sha256"),
        curator_id=payload.get("curator_id"),
        key_id=payload.get("key_id"),
        trust_domain_id=payload.get("trust_domain_id"),
        signed_on=payload.get("signed_on"),
        signature_base64=payload.get("signature_base64"),
    )


def dataset_trust_store_from_dict(payload: Mapping[str, Any]) -> DatasetTrustStore:
    if not isinstance(payload, Mapping):
        raise ValueError("dataset trust store must be a JSON object")
    _exact_fields(payload, _TRUST_STORE_FIELDS, "dataset trust store")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"dataset trust store schema_version must be {SCHEMA_VERSION}")

    raw_keys = _exact_list(payload, "keys", "dataset trust store")
    if len(raw_keys) > _MAX_TRUST_KEYS:
        raise ValueError(f"dataset trust store exceeds {_MAX_TRUST_KEYS} keys")
    keys: list[TrustedDatasetKey] = []
    for index, raw_key in enumerate(raw_keys):
        if not isinstance(raw_key, Mapping):
            raise ValueError(f"dataset trust store.keys[{index}] must be an object")
        _exact_fields(raw_key, _KEY_FIELDS, f"dataset trust store.keys[{index}]")
        keys.append(
            TrustedDatasetKey(
                key_id=raw_key.get("key_id"),
                curator_id=raw_key.get("curator_id"),
                public_key_base64=raw_key.get("public_key_base64"),
                valid_from=raw_key.get("valid_from"),
                valid_until=raw_key.get("valid_until"),
                compromised_on=raw_key.get("compromised_on"),
            )
        )

    raw_current = _exact_list(payload, "current_manifests", "dataset trust store")
    if len(raw_current) > _MAX_CURRENT_MANIFESTS:
        raise ValueError(
            f"dataset trust store exceeds {_MAX_CURRENT_MANIFESTS} current manifests"
        )
    current: list[CurrentDatasetManifest] = []
    for index, raw_item in enumerate(raw_current):
        if not isinstance(raw_item, Mapping):
            raise ValueError(
                f"dataset trust store.current_manifests[{index}] must be an object"
            )
        _exact_fields(
            raw_item,
            _CURRENT_MANIFEST_FIELDS,
            f"dataset trust store.current_manifests[{index}]",
        )
        current.append(
            CurrentDatasetManifest(
                dataset_id=raw_item.get("dataset_id"),
                manifest_sha256=raw_item.get("manifest_sha256"),
            )
        )

    revoked = _exact_list(
        payload,
        "revoked_manifest_sha256s",
        "dataset trust store",
    )
    if len(revoked) > _MAX_REVOKED_MANIFESTS:
        raise ValueError(
            f"dataset trust store exceeds {_MAX_REVOKED_MANIFESTS} revocations"
        )
    return DatasetTrustStore(
        keyring_id=payload.get("keyring_id"),
        keys=tuple(keys),
        current_manifests=tuple(current),
        revoked_manifest_sha256s=tuple(revoked),
    )


def readiness_verification_policy_from_dict(
    payload: Mapping[str, Any],
) -> ReadinessVerificationPolicy:
    if not isinstance(payload, Mapping):
        raise ValueError("readiness verification policy must be a JSON object")
    _exact_fields(payload, _POLICY_FIELDS, "readiness verification policy")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"readiness verification policy schema_version must be {SCHEMA_VERSION}"
        )
    return ReadinessVerificationPolicy(
        policy_id=payload.get("policy_id"),
        dataset_trust_store_sha256=payload.get("dataset_trust_store_sha256"),
        rights_verification_policy_sha256=payload.get(
            "rights_verification_policy_sha256"
        ),
        verifier_source_tree_sha256=payload.get("verifier_source_tree_sha256"),
        deployment_artifact_sha256=payload.get("deployment_artifact_sha256"),
        runtime_identity_sha256=payload.get("runtime_identity_sha256"),
        governance_domain_id=payload.get("governance_domain_id"),
        require_unseen_test_venue=payload.get("require_unseen_test_venue"),
        valid_from=payload.get("valid_from"),
        valid_until=payload.get("valid_until"),
    )


def load_dataset_manifest_attestation(path: Path) -> DatasetManifestAttestation:
    return dataset_manifest_attestation_from_dict(
        _strict_json_object(path, label="dataset manifest attestation")
    )


def load_dataset_trust_store(path: Path) -> DatasetTrustStore:
    return dataset_trust_store_from_dict(
        _strict_json_object(path, label="dataset trust store")
    )


def load_readiness_verification_policy(path: Path) -> ReadinessVerificationPolicy:
    return readiness_verification_policy_from_dict(
        _strict_json_object(path, label="readiness verification policy")
    )
