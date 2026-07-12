"""Validate capture, data-rights, and split readiness before model training."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import stat
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Any, Mapping, Sequence

from cryptography.hazmat.backends.openssl.backend import backend as openssl_backend

from .artifact_store import (
    ArtifactVerificationError,
    DatasetArtifactSetProof,
    MAX_ARTIFACT_FILES,
    verify_dataset_artifacts,
)
from .dataset_split import (
    DatasetSplit,
    SourceSplitRecord,
    SplitContractError,
    SplitManifest,
)
from .immutable_store import generation_id_for
from .rights import PermittedUse, RightsDecision, rights_decision_from_dict
from .rights_trust import (
    RightsAttestation,
    RightsTrustError,
    RightsTrustStore,
    RightsUseProfile,
    RightsVerificationPolicy,
    load_rights_verification_policy,
    load_rights_trust_store,
    rights_attestation_from_dict,
    verify_rights_evidence_batch,
)
from .readiness_trust import (
    DatasetManifestAttestation,
    DatasetTrustStore,
    ProtectedConfigurationGeneration,
    ReadinessTrustError,
    ReadinessVerificationPolicy,
    canonical_json_bytes,
    load_dataset_manifest_attestation,
    load_dataset_trust_store,
    load_protected_configuration_generation,
    load_readiness_verification_policy,
    verify_readiness_policy_pins,
)


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_ISSUE_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_UTC_SECONDS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_REPORT_SCHEMA_VERSION = "2.0"
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024
_MAX_CAPTURE_PROFILES = 256
_MAX_DATA_SOURCES = 10_000
_MAX_COMPLETION_STABILIZATION_ATTEMPTS = 4
_MAX_ISSUE_PATH_CHARS = 512
_MAX_ISSUE_MESSAGE_CHARS = 1024
_MAX_SOURCE_RIGHTS_EVIDENCE_FILES = 64
_REQUIRE_UNSEEN_TEST_VENUE = True
_TRAIN_DEV_REQUIRED_USES = (
    PermittedUse.COMMERCIAL_MODEL_TRAINING,
    PermittedUse.MODEL_DEPLOYMENT,
    PermittedUse.DERIVATIVE_DATASET_CREATION,
    PermittedUse.BIOMETRIC_POSE_ANALYSIS,
)
_TEST_REQUIRED_USES = (
    PermittedUse.COMMERCIAL_MODEL_EVALUATION,
    PermittedUse.DERIVATIVE_DATASET_CREATION,
    PermittedUse.BIOMETRIC_POSE_ANALYSIS,
)
_VERIFIER_DEPENDENCY_NAMES = ("cryptography",)
_VERIFIER_SOURCE_FILES = (
    "__init__.py",
    "artifact_store.py",
    "contracts.py",
    "dataset_split.py",
    "immutable_store.py",
    "readiness.py",
    "readiness_trust.py",
    "rights.py",
    "rights_trust.py",
    "rules.py",
)


class Severity(str, Enum):
    BLOCKER = "BLOCKER"
    WARNING = "WARNING"


class CaptureMode(str, Enum):
    HD_1080P30 = "1080P30"
    UHD_4K60 = "4K60"
    DUAL_4K60 = "DUAL_4K60"


def _bounded_issue_text(value: str, maximum: int) -> str:
    if type(value) is not str or not value:
        raise ValueError("readiness issue text must be a non-empty string")
    if len(value) <= maximum:
        return value
    return value[: maximum - 3] + "..."


@dataclass(frozen=True, slots=True)
class ReadinessIssue:
    code: str
    severity: Severity
    path: str
    message: str

    def __post_init__(self) -> None:
        if type(self.code) is not str or not _ISSUE_CODE_RE.fullmatch(self.code):
            raise ValueError("readiness issue code must be a bounded uppercase code")
        if type(self.severity) is not Severity:
            raise ValueError("readiness issue severity must be a Severity")
        if (
            type(self.path) is not str
            or not self.path
            or len(self.path) > _MAX_ISSUE_PATH_CHARS
        ):
            raise ValueError(
                "readiness issue path must be a bounded non-empty string"
            )
        if (
            type(self.message) is not str
            or not self.message
            or len(self.message) > _MAX_ISSUE_MESSAGE_CHARS
        ):
            raise ValueError(
                "readiness issue message must be a bounded non-empty string"
            )


@dataclass(frozen=True, slots=True)
class SourceRightsProof:
    source_id: str
    asset_sha256: str
    labels_sha256: str
    split: DatasetSplit
    decision_sha256: str
    attestation_sha256: str
    evidence_sha256s: tuple[str, ...]
    rights_reviewed_on: str
    rights_expires_on: str | None
    verified_on: str
    required_uses: tuple[PermittedUse, ...]

    def __post_init__(self) -> None:
        if type(self.source_id) is not str or not _STABLE_ID_RE.fullmatch(
            self.source_id
        ):
            raise ValueError("source proof requires an ASCII-stable source_id")
        for field_name in (
            "asset_sha256",
            "labels_sha256",
            "decision_sha256",
            "attestation_sha256",
        ):
            if type(getattr(self, field_name)) is not str or not _SHA256_RE.fullmatch(
                getattr(self, field_name)
            ):
                raise ValueError(f"source proof {field_name} must be a SHA-256")
        if type(self.split) is not DatasetSplit:
            raise ValueError("source proof split must be a DatasetSplit")
        if (
            type(self.evidence_sha256s) is not tuple
            or not 1 <= len(self.evidence_sha256s) <= (
                _MAX_SOURCE_RIGHTS_EVIDENCE_FILES
            )
            or any(
            type(value) is not str or not _SHA256_RE.fullmatch(value)
            for value in self.evidence_sha256s
            )
        ):
            raise ValueError(
                "source proof evidence hashes must be a bounded non-empty "
                "immutable tuple"
            )
        if self.evidence_sha256s != tuple(sorted(set(self.evidence_sha256s))):
            raise ValueError(
                "source proof evidence hashes must be sorted and duplicate-free"
            )
        parsed_dates: dict[str, Any] = {}
        for value, field_name in (
            (self.rights_reviewed_on, "rights_reviewed_on"),
            (self.verified_on, "verified_on"),
        ):
            if type(value) is not str:
                raise ValueError(f"source proof {field_name} must be an ISO date")
            try:
                parsed = datetime.strptime(value, "%Y-%m-%d").date()
            except ValueError as error:
                raise ValueError(
                    f"source proof {field_name} must be an ISO date"
                ) from error
            if parsed.isoformat() != value:
                raise ValueError(f"source proof {field_name} must be an ISO date")
            parsed_dates[field_name] = parsed
        if parsed_dates["rights_reviewed_on"] > parsed_dates["verified_on"]:
            raise ValueError(
                "source proof rights review cannot occur after verification"
            )
        if self.rights_expires_on is not None:
            try:
                expires = datetime.strptime(
                    self.rights_expires_on,
                    "%Y-%m-%d",
                ).date()
            except (TypeError, ValueError) as error:
                raise ValueError(
                    "source proof rights_expires_on must be an ISO date or null"
                ) from error
            if expires.isoformat() != self.rights_expires_on:
                raise ValueError(
                    "source proof rights_expires_on must be an ISO date or null"
                )
            if parsed_dates["verified_on"] > expires:
                raise ValueError(
                    "source proof rights cannot be expired on verification date"
                )
        if (
            type(self.required_uses) is not tuple
            or not self.required_uses
            or any(type(value) is not PermittedUse for value in self.required_uses)
            or len(set(self.required_uses)) != len(self.required_uses)
        ):
            raise ValueError(
                "source proof required_uses must be unique PermittedUse values"
            )
        expected_uses = (
            _TRAIN_DEV_REQUIRED_USES
            if self.split in {DatasetSplit.TRAIN, DatasetSplit.DEV}
            else _TEST_REQUIRED_USES
        )
        if self.required_uses != expected_uses:
            raise ValueError(
                "source proof required_uses do not match the protected split profile"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "asset_sha256": self.asset_sha256,
            "attestation_sha256": self.attestation_sha256,
            "decision_sha256": self.decision_sha256,
            "evidence_sha256s": list(self.evidence_sha256s),
            "labels_sha256": self.labels_sha256,
            "required_uses": sorted(value.value for value in self.required_uses),
            "rights_expires_on": self.rights_expires_on,
            "rights_reviewed_on": self.rights_reviewed_on,
            "source_id": self.source_id,
            "split": self.split.value,
            "verified_on": self.verified_on,
        }


@dataclass(frozen=True, slots=True)
class _PreparedSourceRights:
    source_id: str
    asset_sha256: str
    labels_sha256: str
    split: DatasetSplit
    decision: RightsDecision
    attestation: RightsAttestation
    required_uses: tuple[PermittedUse, ...]
    path: str


def _source_rights_proof_set_sha256(
    proofs: tuple[SourceRightsProof, ...],
) -> str:
    if type(proofs) is not tuple or any(
        type(proof) is not SourceRightsProof for proof in proofs
    ):
        raise ValueError("source rights proofs must be an immutable proof tuple")
    if len(proofs) > _MAX_DATA_SOURCES:
        raise ValueError(
            f"source rights proofs cannot exceed {_MAX_DATA_SOURCES} entries"
        )
    source_ids = [proof.source_id for proof in proofs]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("source rights proof IDs must be unique")
    payload = {
        "domain": "multicourt-vision-scoring:source-rights-proof-set:v1",
        "proofs": [
            proof.to_dict()
            for proof in sorted(proofs, key=lambda proof: proof.source_id)
        ],
        "schema_version": _REPORT_SCHEMA_VERSION,
    }
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


def _required_artifact_digest_set_sha256(digests: tuple[str, ...]) -> str:
    if (
        type(digests) is not tuple
        or any(type(digest) is not str or not _SHA256_RE.fullmatch(digest) for digest in digests)
        or digests != tuple(sorted(set(digests)))
    ):
        raise ValueError(
            "required artifact digests must be a sorted unique SHA-256 tuple"
        )
    if len(digests) > MAX_ARTIFACT_FILES:
        raise ValueError(
            f"required artifact digests cannot exceed {MAX_ARTIFACT_FILES} entries"
        )
    payload = {
        "digests": list(digests),
        "domain": "multicourt-vision-scoring:required-artifact-digest-set:v1",
        "schema_version": _REPORT_SCHEMA_VERSION,
    }
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


@dataclass(frozen=True, slots=True)
class ReadinessReport:
    """Structured verifier output, never a deserializable authority token.

    Constructor checks prevent accidental proof inconsistency. A caller that
    already controls this Python process can forge objects or remove blockers;
    downstream jobs must invoke the authenticated single-use validator and may
    not authorize work from uploaded report JSON or its self-hash.
    """

    dataset_id: str
    manifest_schema_version: str
    manifest_sha256: str | None
    dataset_trust_store_sha256: str
    dataset_manifest_attestation: DatasetManifestAttestation
    dataset_manifest_attestation_sha256: str
    dataset_manifest_trust_verified: bool
    readiness_verification_policy: ReadinessVerificationPolicy
    readiness_verification_policy_sha256: str
    rights_trust_store_sha256: str
    rights_verification_policy: RightsVerificationPolicy
    rights_verification_policy_sha256: str
    rights_evidence_generation_id: str | None
    protected_configuration_generation: ProtectedConfigurationGeneration
    protected_configuration_generation_sha256: str
    verifier_source_tree_sha256: str
    trusted_launcher_deployment_artifact_sha256: str
    runtime_identity: tuple[tuple[str, str], ...]
    runtime_identity_sha256: str
    verifier_dependency_versions: tuple[tuple[str, str], ...]
    verified_at_utc: str
    require_unseen_test_venue: bool
    required_artifact_sha256s: tuple[str, ...]
    required_artifact_digest_set_sha256: str
    artifact_set_proof: DatasetArtifactSetProof | None
    data_source_count: int
    source_rights_proofs: tuple[SourceRightsProof, ...]
    source_rights_proof_set_sha256: str
    issues: tuple[ReadinessIssue, ...]

    def __post_init__(self) -> None:
        if type(self.dataset_id) is not str or not _STABLE_ID_RE.fullmatch(
            self.dataset_id
        ):
            raise ValueError("report dataset_id must be an ASCII-stable identifier")
        if type(self.manifest_schema_version) is not str or not (
            self.manifest_schema_version
        ):
            raise ValueError("report manifest_schema_version must be non-empty")
        for value, field_name in (
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
                self.protected_configuration_generation_sha256,
                "protected_configuration_generation_sha256",
            ),
            (self.verifier_source_tree_sha256, "verifier_source_tree_sha256"),
            (
                self.trusted_launcher_deployment_artifact_sha256,
                "trusted_launcher_deployment_artifact_sha256",
            ),
            (self.runtime_identity_sha256, "runtime_identity_sha256"),
            (
                self.source_rights_proof_set_sha256,
                "source_rights_proof_set_sha256",
            ),
            (
                self.required_artifact_digest_set_sha256,
                "required_artifact_digest_set_sha256",
            ),
        ):
            if type(value) is not str or not _SHA256_RE.fullmatch(value):
                raise ValueError(f"report {field_name} must be a lowercase SHA-256")
        if self.manifest_sha256 is not None and (
            type(self.manifest_sha256) is not str
            or not _SHA256_RE.fullmatch(self.manifest_sha256)
        ):
            raise ValueError("report manifest_sha256 must be null or a SHA-256")
        if self.rights_evidence_generation_id is not None and (
            type(self.rights_evidence_generation_id) is not str
            or not _SHA256_RE.fullmatch(self.rights_evidence_generation_id)
        ):
            raise ValueError(
                "report rights_evidence_generation_id must be null or a SHA-256"
            )
        if type(self.dataset_manifest_trust_verified) is not bool:
            raise ValueError("dataset_manifest_trust_verified must be a boolean")
        if type(self.dataset_manifest_attestation) is not DatasetManifestAttestation:
            raise ValueError(
                "dataset_manifest_attestation must be a DatasetManifestAttestation"
            )
        if self.dataset_manifest_attestation.fingerprint() != (
            self.dataset_manifest_attestation_sha256
        ):
            raise ValueError(
                "dataset manifest attestation proof does not match the attestation"
            )
        if self.dataset_manifest_trust_verified:
            if self.manifest_schema_version != "1.0":
                raise ValueError(
                    "trusted readiness report requires manifest schema_version 1.0"
                )
            if self.manifest_sha256 is None:
                raise ValueError(
                    "verified dataset trust requires a manifest SHA-256"
                )
            if self.dataset_manifest_attestation.dataset_id != self.dataset_id:
                raise ValueError(
                    "trusted report dataset_id does not match its attestation"
                )
            if self.dataset_manifest_attestation.manifest_sha256 != (
                self.manifest_sha256
            ):
                raise ValueError(
                    "trusted report manifest does not match its attestation"
                )
        if type(self.readiness_verification_policy) is not ReadinessVerificationPolicy:
            raise ValueError(
                "readiness_verification_policy must be a ReadinessVerificationPolicy"
            )
        policy = self.readiness_verification_policy
        if policy.fingerprint() != self.readiness_verification_policy_sha256:
            raise ValueError("readiness policy proof does not match the policy")
        for actual, expected, label in (
            (
                self.dataset_trust_store_sha256,
                policy.dataset_trust_store_sha256,
                "dataset trust store",
            ),
            (
                self.rights_verification_policy_sha256,
                policy.rights_verification_policy_sha256,
                "rights verification policy",
            ),
            (
                self.verifier_source_tree_sha256,
                policy.verifier_source_tree_sha256,
                "verifier source tree",
            ),
            (
                self.trusted_launcher_deployment_artifact_sha256,
                policy.deployment_artifact_sha256,
                "deployment artifact",
            ),
            (
                self.runtime_identity_sha256,
                policy.runtime_identity_sha256,
                "runtime identity",
            ),
        ):
            if actual != expected:
                raise ValueError(f"report {label} proof does not match readiness policy")
        if self.require_unseen_test_venue is not True or (
            self.require_unseen_test_venue
            != policy.require_unseen_test_venue
        ):
            raise ValueError("report split policy does not match readiness policy")
        if readiness_runtime_identity_sha256(self.runtime_identity) != (
            self.runtime_identity_sha256
        ):
            raise ValueError("report runtime identity proof is inconsistent")
        if (
            type(self.verifier_dependency_versions) is not tuple
            or not self.verifier_dependency_versions
            or any(
                type(item) is not tuple
                or len(item) != 2
                or type(item[0]) is not str
                or type(item[1]) is not str
                or not item[0]
                or not item[1]
                or len(item[0]) > 128
                or len(item[1]) > 256
                for item in self.verifier_dependency_versions
            )
            or tuple(sorted(self.verifier_dependency_versions))
            != self.verifier_dependency_versions
            or len({name for name, _ in self.verifier_dependency_versions})
            != len(self.verifier_dependency_versions)
        ):
            raise ValueError(
                "verifier_dependency_versions must be sorted unique bounded "
                "non-empty string pairs"
            )
        runtime_versions = dict(self.runtime_identity)
        if tuple(
            name for name, _ in self.verifier_dependency_versions
        ) != _VERIFIER_DEPENDENCY_NAMES:
            raise ValueError(
                "verifier dependency versions must declare exactly cryptography"
            )
        if any(
            runtime_versions.get(name) != version
            for name, version in self.verifier_dependency_versions
        ):
            raise ValueError(
                "verifier dependency versions do not match the pinned runtime"
            )
        if type(self.rights_verification_policy) is not RightsVerificationPolicy:
            raise ValueError(
                "rights_verification_policy must be a RightsVerificationPolicy"
            )
        if self.rights_verification_policy.fingerprint() != (
            self.rights_verification_policy_sha256
        ):
            raise ValueError("rights policy proof does not match the policy")
        if self.rights_verification_policy.trust_store_sha256 != (
            self.rights_trust_store_sha256
        ):
            raise ValueError("rights trust-store proof does not match its policy")
        if self.rights_verification_policy.verifier_source_tree_sha256 != (
            self.verifier_source_tree_sha256
        ):
            raise ValueError("rights verifier source proof does not match its policy")
        if type(self.protected_configuration_generation) is not (
            ProtectedConfigurationGeneration
        ):
            raise ValueError(
                "protected_configuration_generation must be a "
                "ProtectedConfigurationGeneration"
            )
        if self.protected_configuration_generation.fingerprint() != (
            self.protected_configuration_generation_sha256
        ):
            raise ValueError(
                "protected configuration proof does not match the generation"
            )
        generation = self.protected_configuration_generation
        generation_comparisons = (
            (
                generation.dataset_trust_store_sha256,
                self.dataset_trust_store_sha256,
                "dataset trust store",
            ),
            (
                generation.dataset_manifest_attestation_sha256,
                self.dataset_manifest_attestation_sha256,
                "dataset manifest attestation",
            ),
            (
                generation.readiness_verification_policy_sha256,
                self.readiness_verification_policy_sha256,
                "readiness verification policy",
            ),
            (
                generation.rights_trust_store_sha256,
                self.rights_trust_store_sha256,
                "rights trust store",
            ),
            (
                generation.rights_verification_policy_sha256,
                self.rights_verification_policy_sha256,
                "rights verification policy",
            ),
            (
                generation.trusted_launcher_deployment_artifact_sha256,
                self.trusted_launcher_deployment_artifact_sha256,
                "deployment artifact",
            ),
            (
                generation.governance_domain_id,
                policy.governance_domain_id,
                "governance domain",
            ),
        )
        for declared, actual, label in generation_comparisons:
            if declared != actual:
                raise ValueError(
                    f"protected configuration does not match report {label}"
                )
        if type(self.verified_at_utc) is not str or not _UTC_SECONDS_RE.fullmatch(
            self.verified_at_utc
        ):
            raise ValueError("verified_at_utc must be a canonical UTC timestamp")
        try:
            verified_at = datetime.fromisoformat(
                self.verified_at_utc[:-1] + "+00:00"
            )
        except ValueError as error:
            raise ValueError(
                "verified_at_utc must be a canonical UTC timestamp"
            ) from error
        if verified_at.isoformat(timespec="seconds").replace(
            "+00:00",
            "Z",
        ) != self.verified_at_utc:
            raise ValueError("verified_at_utc must be a canonical UTC timestamp")
        verified_on = verified_at.date().isoformat()
        if not policy.is_active(verified_on):
            raise ValueError("report time falls outside readiness policy validity")
        if not self.rights_verification_policy.is_active(verified_on):
            raise ValueError("report time falls outside rights policy validity")
        if type(self.source_rights_proofs) is not tuple or any(
            type(proof) is not SourceRightsProof for proof in self.source_rights_proofs
        ):
            raise ValueError("source_rights_proofs must be immutable proof values")
        if (
            type(self.data_source_count) is not int
            or not 0 <= self.data_source_count <= _MAX_DATA_SOURCES
        ):
            raise ValueError(
                "data_source_count must be an integer from 0 through "
                f"{_MAX_DATA_SOURCES}"
            )
        if _source_rights_proof_set_sha256(self.source_rights_proofs) != (
            self.source_rights_proof_set_sha256
        ):
            raise ValueError("source rights proof-set commitment is inconsistent")
        evidence_digests = tuple(
            sorted(
                {
                    digest
                    for proof in self.source_rights_proofs
                    for digest in proof.evidence_sha256s
                }
            )
        )
        if evidence_digests:
            if self.rights_evidence_generation_id != generation_id_for(
                evidence_digests
            ):
                raise ValueError(
                    "rights evidence generation does not commit the proof evidence"
                )
        elif self.rights_evidence_generation_id is not None:
            raise ValueError(
                "rights evidence generation requires source rights proofs"
            )
        if type(self.issues) is not tuple or any(
            type(issue) is not ReadinessIssue for issue in self.issues
        ):
            raise ValueError("issues must be immutable ReadinessIssue values")
        if self.artifact_set_proof is not None and type(
            self.artifact_set_proof
        ) is not DatasetArtifactSetProof:
            raise ValueError("artifact_set_proof must be a DatasetArtifactSetProof")
        if _required_artifact_digest_set_sha256(
            self.required_artifact_sha256s
        ) != self.required_artifact_digest_set_sha256:
            raise ValueError("required artifact-set commitment is inconsistent")
        if self.artifact_set_proof is not None and tuple(
            artifact.sha256 for artifact in self.artifact_set_proof.artifacts
        ) != self.required_artifact_sha256s:
            raise ValueError(
                "verified artifact proof does not match the manifest-required digest set"
            )
        if any(proof.verified_on != verified_on for proof in self.source_rights_proofs):
            raise ValueError("source rights proofs must use the report verification date")

    @property
    def blockers(self) -> tuple[ReadinessIssue, ...]:
        return tuple(issue for issue in self.issues if issue.severity is Severity.BLOCKER)

    @property
    def warnings(self) -> tuple[ReadinessIssue, ...]:
        return tuple(issue for issue in self.issues if issue.severity is Severity.WARNING)

    @property
    def ready(self) -> bool:
        return (
            not self.blockers
            and self.dataset_manifest_trust_verified
            and self.manifest_schema_version == "1.0"
            and self.manifest_sha256 is not None
            and self.artifact_set_proof is not None
            and bool(self.required_artifact_sha256s)
            and self.rights_evidence_generation_id is not None
            and len(self.source_rights_proofs) == self.data_source_count
        )

    def to_dict(self) -> dict[str, Any]:
        def issue_dict(issue: ReadinessIssue) -> dict[str, str]:
            return {
                "code": issue.code,
                "severity": issue.severity.value,
                "path": issue.path,
                "message": issue.message,
            }

        payload = {
            "report_schema_version": _REPORT_SCHEMA_VERSION,
            "dataset_id": self.dataset_id,
            "manifest_schema_version": self.manifest_schema_version,
            "manifest_sha256": self.manifest_sha256,
            "dataset_trust": {
                "attestation": (
                    self.dataset_manifest_attestation.to_canonical_dict()
                ),
                "attestation_sha256": self.dataset_manifest_attestation_sha256,
                "manifest_trust_verified": self.dataset_manifest_trust_verified,
                "trust_store_sha256": self.dataset_trust_store_sha256,
            },
            "readiness_verification_policy": (
                self.readiness_verification_policy.to_canonical_dict()
            ),
            "readiness_verification_policy_sha256": (
                self.readiness_verification_policy_sha256
            ),
            "rights_trust": {
                "trust_store_sha256": self.rights_trust_store_sha256,
                "verification_policy": (
                    self.rights_verification_policy.to_canonical_dict()
                ),
                "verification_policy_sha256": (
                    self.rights_verification_policy_sha256
                ),
                "evidence_generation_id": self.rights_evidence_generation_id,
            },
            "protected_configuration_generation": (
                self.protected_configuration_generation.to_canonical_dict()
            ),
            "protected_configuration_generation_sha256": (
                self.protected_configuration_generation_sha256
            ),
            "verifier_source_tree_sha256": self.verifier_source_tree_sha256,
            "trusted_launcher_deployment_artifact_sha256": (
                self.trusted_launcher_deployment_artifact_sha256
            ),
            "runtime_identity": dict(self.runtime_identity),
            "runtime_identity_sha256": self.runtime_identity_sha256,
            "verifier_dependency_versions": dict(self.verifier_dependency_versions),
            "verified_at_utc": self.verified_at_utc,
            "split_policy": {
                "require_unseen_test_venue": self.require_unseen_test_venue,
                "source": "PROTECTED_VERIFIER_POLICY",
            },
            "artifact_set_proof": (
                self.artifact_set_proof.to_canonical_dict()
                if self.artifact_set_proof is not None
                else None
            ),
            "required_artifact_sha256s": list(self.required_artifact_sha256s),
            "required_artifact_digest_set_sha256": (
                self.required_artifact_digest_set_sha256
            ),
            "source_rights_proofs": [
                proof.to_dict() for proof in self.source_rights_proofs
            ],
            "source_rights_proof_set_sha256": (
                self.source_rights_proof_set_sha256
            ),
            "data_source_count": self.data_source_count,
            "ready": self.ready,
            "blockers": [issue_dict(issue) for issue in self.blockers],
            "warnings": [issue_dict(issue) for issue in self.warnings],
        }
        report_sha256 = hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()
        return {**payload, "report_sha256": report_sha256}


class ManifestValidator:
    """Single-use, fail-closed validation for one readiness snapshot.

    The trusted launcher must freshly load one protected configuration
    generation (policies, trust stores, attestations, and revocations) before
    constructing each validator.  Retaining a validator would retain an old
    revocation view, so reuse is rejected even though all inputs are frozen.
    """

    _TOP_LEVEL_FIELDS = frozenset(
        {"schema_version", "dataset_id", "capture_profiles", "data_sources"}
    )
    _CAPTURE_FIELDS = frozenset(
        {
            "profile_id",
            "camera_device_id",
            "lens_configuration_id",
            "mode",
            "width",
            "height",
            "fps",
            "camera_count",
            "bitrate_mbps",
            "shutter_reciprocal",
            "far_ball_processed_pixels_p10",
            "human_resolvable_visible_ball_ratio",
            "visible_serve_frames_meeting_pixel_gate_ratio",
            "sampled_visible_ball_frames",
            "sampled_decisive_event_windows",
            "timestamp_regressions",
            "critical_unexplained_drop_events",
            "unexplained_freeze_events",
            "native_capture_verified",
            "frame_interpolation_detected",
            "upscaled_from_lower_resolution",
            "service_zones_fully_visible",
            "fixed_mount",
            "calibration_profile_sha256",
            "camera_device_attestation_sha256",
            "capture_clock_verification_sha256",
            "encoder_configuration_sha256",
            "visible_ball_blur_to_minor_axis_ratio_p95",
            "usable_observed_positions_per_eligible_event_p10",
            "calibration_holdout_p95_px",
            "court_plane_holdout_p95_cm",
            "capture_soak_minutes",
            "exposure_sync_p95_ms",
        }
    )
    _SOURCE_FIELDS = frozenset(
        {
            "source_id",
            "asset_sha256",
            "root_asset_sha256",
            "parent_asset_sha256",
            "match_id",
            "venue_id",
            "capture_profile_id",
            "camera_setup_id",
            "recording_date",
            "ball_design_id",
            "lighting_condition",
            "synchronized_capture_group_id",
            "split_group_id",
            "split",
            "rights_decision",
            "rights_decision_sha256",
            "rights_attestation",
            "labels_sha256",
        }
    )
    def __init__(
        self,
        *,
        dataset_trust_store: DatasetTrustStore,
        dataset_manifest_attestation: DatasetManifestAttestation,
        readiness_verification_policy: ReadinessVerificationPolicy,
        expected_readiness_verification_policy_sha256: str,
        trusted_launcher_deployment_artifact_sha256: str,
        expected_governance_domain_id: str,
        protected_configuration_generation_path: Path,
        artifact_store_root: Path,
        rights_trust_store: RightsTrustStore,
        rights_evidence_store_root: Path,
        rights_verification_policy: RightsVerificationPolicy,
        expected_rights_verification_policy_sha256: str,
    ) -> None:
        if type(dataset_trust_store) is not DatasetTrustStore:
            raise ValueError("dataset_trust_store must be a DatasetTrustStore")
        if type(dataset_manifest_attestation) is not DatasetManifestAttestation:
            raise ValueError(
                "dataset_manifest_attestation must be a DatasetManifestAttestation"
            )
        if type(readiness_verification_policy) is not ReadinessVerificationPolicy:
            raise ValueError(
                "readiness_verification_policy must be a ReadinessVerificationPolicy"
            )
        for value, field_name in (
            (
                expected_readiness_verification_policy_sha256,
                "expected_readiness_verification_policy_sha256",
            ),
            (
                trusted_launcher_deployment_artifact_sha256,
                "trusted_launcher_deployment_artifact_sha256",
            ),
        ):
            if type(value) is not str or not _SHA256_RE.fullmatch(value):
                raise ValueError(f"{field_name} must be a lowercase SHA-256")
        if (
            expected_readiness_verification_policy_sha256
            != readiness_verification_policy.fingerprint()
        ):
            raise ValueError(
                "readiness verification policy does not match the separately pinned fingerprint"
            )
        if (
            type(expected_governance_domain_id) is not str
            or not _STABLE_ID_RE.fullmatch(expected_governance_domain_id)
        ):
            raise ValueError(
                "expected_governance_domain_id must be an ASCII-stable identifier"
            )
        if not isinstance(artifact_store_root, Path):
            raise ValueError("artifact_store_root must be a pathlib.Path")
        if type(rights_trust_store) is not RightsTrustStore:
            raise ValueError("rights_trust_store must be a RightsTrustStore")
        if not isinstance(protected_configuration_generation_path, Path):
            raise ValueError(
                "protected_configuration_generation_path must be a pathlib.Path"
            )
        if not isinstance(rights_evidence_store_root, Path):
            raise ValueError("rights_evidence_store_root must be a pathlib.Path")
        if type(rights_verification_policy) is not RightsVerificationPolicy:
            raise ValueError(
                "rights_verification_policy must be a RightsVerificationPolicy"
            )
        if (
            type(expected_rights_verification_policy_sha256) is not str
            or not _SHA256_RE.fullmatch(
                expected_rights_verification_policy_sha256
            )
            or expected_rights_verification_policy_sha256
            != rights_verification_policy.fingerprint()
        ):
            raise ValueError(
                "rights verification policy does not match the separately pinned fingerprint"
            )
        if rights_verification_policy.trust_store_sha256 != rights_trust_store.fingerprint():
            raise ValueError(
                "rights trust store does not match the protected verification policy"
            )
        self._dataset_trust_store = dataset_trust_store
        self._dataset_manifest_attestation = dataset_manifest_attestation
        self._readiness_verification_policy = readiness_verification_policy
        self._readiness_verification_policy_sha256 = (
            expected_readiness_verification_policy_sha256
        )
        self._trusted_launcher_deployment_artifact_sha256 = (
            trusted_launcher_deployment_artifact_sha256
        )
        self._expected_governance_domain_id = expected_governance_domain_id
        self._protected_configuration_generation_path = Path(
            os.path.abspath(os.fspath(protected_configuration_generation_path))
        )
        self._artifact_store_root = artifact_store_root
        self._rights_trust_store = rights_trust_store
        self._rights_evidence_store_root = rights_evidence_store_root
        self._rights_verification_policy = rights_verification_policy
        self._rights_verification_policy_sha256 = (
            expected_rights_verification_policy_sha256
        )
        self._use_lock = threading.Lock()
        self._used = False

    def validate(self, manifest: Mapping[str, Any]) -> ReadinessReport:
        with self._use_lock:
            if self._used:
                raise RuntimeError(
                    "ManifestValidator is single-use; freshly load the protected "
                    "configuration generation and construct a new validator"
                )
            self._used = True
        starting_configuration_generation = (
            load_protected_configuration_generation(
                self._protected_configuration_generation_path
            )
        )
        self._verify_protected_configuration_generation(
            starting_configuration_generation
        )
        protected_configuration_generation_sha256 = (
            starting_configuration_generation.fingerprint()
        )
        issues: list[ReadinessIssue] = []
        manifest_sha256: str | None
        try:
            canonical_manifest = canonical_json_bytes(manifest)
            detached_manifest = json.loads(canonical_manifest.decode("utf-8"))
            if not isinstance(detached_manifest, Mapping):
                raise ValueError("manifest root must be a JSON object")
            manifest_sha256 = hashlib.sha256(canonical_manifest).hexdigest()
        except (RuntimeError, TypeError, ValueError, UnicodeEncodeError, json.JSONDecodeError):
            manifest_sha256 = None
            self._block(
                issues,
                "MANIFEST_CANONICALIZATION",
                "manifest",
                "manifest must be canonicalizable finite UTF-8 JSON",
            )
            detached_manifest = {}

        # Trust and time are revalidated for this detached snapshot. The
        # caller-owned mapping is never reread after this point.
        verified_at = datetime.now(timezone.utc)
        verified_on = verified_at.date().isoformat()
        current_verifier_source_tree_sha256 = (
            readiness_verifier_source_tree_sha256()
        )
        runtime_identity = readiness_runtime_identity()
        current_runtime_identity_sha256 = readiness_runtime_identity_sha256(
            runtime_identity
        )
        verify_readiness_policy_pins(
            self._readiness_verification_policy,
            expected_policy_sha256=(
                self._readiness_verification_policy_sha256
            ),
            actual_dataset_trust_store_sha256=(
                self._dataset_trust_store.fingerprint()
            ),
            actual_rights_verification_policy_sha256=(
                self._rights_verification_policy.fingerprint()
            ),
            actual_verifier_source_tree_sha256=(
                current_verifier_source_tree_sha256
            ),
            trusted_launcher_deployment_artifact_sha256=(
                self._trusted_launcher_deployment_artifact_sha256
            ),
            actual_runtime_identity_sha256=current_runtime_identity_sha256,
            expected_governance_domain_id=self._expected_governance_domain_id,
            verified_on=verified_on,
        )
        if self._dataset_trust_store.keyring_id != (
            self._expected_governance_domain_id
        ):
            raise ValueError(
                "dataset trust store does not match the protected governance domain"
            )
        if self._rights_verification_policy.fingerprint() != (
            self._rights_verification_policy_sha256
        ):
            raise ValueError("protected rights verification policy changed")
        if self._rights_verification_policy.trust_store_sha256 != (
            self._rights_trust_store.fingerprint()
        ):
            raise ValueError("protected rights trust store changed")
        if self._rights_verification_policy.verifier_source_tree_sha256 != (
            current_verifier_source_tree_sha256
        ):
            raise ValueError(
                "rights policy verifier source tree does not match the executing deployment"
            )
        if not self._rights_verification_policy.is_active(verified_on):
            raise ValueError(
                "rights verification policy is not active on the trusted UTC clock date"
            )

        self._reject_unknown_fields(
            detached_manifest,
            self._TOP_LEVEL_FIELDS,
            "manifest",
            issues,
        )
        schema_version = detached_manifest.get("schema_version")
        if schema_version != "1.0":
            self._block(issues, "SCHEMA_VERSION", "schema_version", "expected schema_version 1.0")
            schema_version = str(schema_version or "unknown")
        dataset_id = detached_manifest.get("dataset_id")
        dataset_manifest_trust_verified = False
        if type(dataset_id) is not str or not _STABLE_ID_RE.fullmatch(dataset_id):
            self._block(
                issues,
                "DATASET_ID",
                "dataset_id",
                "dataset_id must be a 1-128 character ASCII-stable identifier",
            )
            dataset_id = "invalid-dataset-id"
        elif manifest_sha256 is not None:
            try:
                self._dataset_trust_store.verify(
                    dataset_id=dataset_id,
                    manifest_sha256=manifest_sha256,
                    attestation=self._dataset_manifest_attestation,
                    verified_on=verified_on,
                )
            except ReadinessTrustError as error:
                self._block(
                    issues,
                    error.code,
                    "dataset_manifest_attestation",
                    str(error),
                )
            else:
                dataset_manifest_trust_verified = True

        capture_profiles = detached_manifest.get("capture_profiles")
        if not isinstance(capture_profiles, list) or not capture_profiles:
            self._block(
                issues,
                "CAPTURE_PROFILES",
                "capture_profiles",
                "at least one capture profile is required",
            )
        elif len(capture_profiles) > _MAX_CAPTURE_PROFILES:
            self._block(
                issues,
                "CAPTURE_PROFILE_COUNT",
                "capture_profiles",
                f"at most {_MAX_CAPTURE_PROFILES} capture profiles are allowed",
            )
        else:
            self._validate_capture_profiles(capture_profiles, issues)
        capture_profile_ids = {
            profile.get("profile_id")
            for profile in capture_profiles or []
            if (
                isinstance(profile, Mapping)
                and type(profile.get("profile_id")) is str
                and _STABLE_ID_RE.fullmatch(profile.get("profile_id"))
            )
        }

        data_sources = detached_manifest.get("data_sources")
        source_rights_proofs: tuple[SourceRightsProof, ...] = ()
        rights_evidence_generation_id: str | None = None
        if not isinstance(data_sources, list) or not data_sources:
            self._block(issues, "DATA_SOURCES", "data_sources", "at least one data source is required")
        elif len(data_sources) > _MAX_DATA_SOURCES:
            self._block(
                issues,
                "DATA_SOURCE_COUNT",
                "data_sources",
                f"at most {_MAX_DATA_SOURCES} data sources are allowed",
            )
        else:
            source_rights_proofs = self._validate_data_sources(
                data_sources,
                capture_profile_ids,
                verified_on,
                issues,
                verify_rights=dataset_manifest_trust_verified,
            )
            rights_evidence_generation_id = (
                self._rights_evidence_generation_id(source_rights_proofs)
            )

        artifact_set_proof: DatasetArtifactSetProof | None = None
        required_artifact_sha256s = _required_dataset_artifact_sha256s(
            detached_manifest
        )
        if not required_artifact_sha256s:
            self._block(
                issues,
                "ARTIFACT_SET_EMPTY",
                "manifest",
                "a readiness manifest must reference resident dataset artifacts",
            )
        elif dataset_manifest_trust_verified:
            try:
                artifact_set_proof = verify_dataset_artifacts(
                    required_artifact_sha256s,
                    artifact_store_root=self._artifact_store_root,
                )
            except ArtifactVerificationError as error:
                self._block(
                    issues,
                    error.code,
                    "artifact_store_root",
                    str(error),
                )

        try:
            cryptography_version = package_version("cryptography")
        except PackageNotFoundError:
            cryptography_version = "missing"

        # Authorization time is the final stable time sample after every
        # completion-time trust and configuration check. A long artifact or
        # evidence pass can cross UTC midnight, including while the protected
        # current-generation pointer is being reloaded. Repeat the complete
        # date-governed check until the date is stable on both sides. A clock
        # rollback or repeated non-stabilization fails closed.
        completion_probe = datetime.now(timezone.utc)
        previous_probe = verified_at
        rights_proof_date = verified_on
        completed_at: datetime | None = None
        completed_configuration_generation: ProtectedConfigurationGeneration | None = None
        final_verifier_source_tree_sha256 = ""
        final_runtime_identity: tuple[tuple[str, str], ...] = ()
        final_runtime_identity_sha256 = ""
        for _ in range(_MAX_COMPLETION_STABILIZATION_ATTEMPTS):
            if completion_probe < previous_probe:
                raise ReadinessTrustError(
                    "TRUSTED_CLOCK_ROLLBACK",
                    "trusted UTC clock moved backward during validation",
                )
            completion_on = completion_probe.date().isoformat()
            final_verifier_source_tree_sha256 = (
                readiness_verifier_source_tree_sha256()
            )
            final_runtime_identity = readiness_runtime_identity()
            final_runtime_identity_sha256 = readiness_runtime_identity_sha256(
                final_runtime_identity
            )
            verify_readiness_policy_pins(
                self._readiness_verification_policy,
                expected_policy_sha256=(
                    self._readiness_verification_policy_sha256
                ),
                actual_dataset_trust_store_sha256=(
                    self._dataset_trust_store.fingerprint()
                ),
                actual_rights_verification_policy_sha256=(
                    self._rights_verification_policy.fingerprint()
                ),
                actual_verifier_source_tree_sha256=(
                    final_verifier_source_tree_sha256
                ),
                trusted_launcher_deployment_artifact_sha256=(
                    self._trusted_launcher_deployment_artifact_sha256
                ),
                actual_runtime_identity_sha256=(
                    final_runtime_identity_sha256
                ),
                expected_governance_domain_id=(
                    self._expected_governance_domain_id
                ),
                verified_on=completion_on,
            )
            if not self._rights_verification_policy.is_active(completion_on):
                raise ValueError(
                    "rights verification policy is not active on the "
                    "completion UTC date"
                )
            if (
                manifest_sha256 is not None
                and dataset_id != "invalid-dataset-id"
            ):
                try:
                    self._dataset_trust_store.verify(
                        dataset_id=dataset_id,
                        manifest_sha256=manifest_sha256,
                        attestation=self._dataset_manifest_attestation,
                        verified_on=completion_on,
                    )
                except ReadinessTrustError as error:
                    self._block(
                        issues,
                        error.code,
                        "dataset_manifest_attestation",
                        str(error),
                    )
                    dataset_manifest_trust_verified = False
            if (
                completion_on != rights_proof_date
                and dataset_manifest_trust_verified
                and isinstance(data_sources, list)
                and 0 < len(data_sources) <= _MAX_DATA_SOURCES
            ):
                source_rights_proofs = self._validate_data_sources(
                    data_sources,
                    capture_profile_ids,
                    completion_on,
                    issues,
                    verify_rights=True,
                )
                rights_evidence_generation_id = (
                    self._rights_evidence_generation_id(source_rights_proofs)
                )
                rights_proof_date = completion_on

            candidate_generation = load_protected_configuration_generation(
                self._protected_configuration_generation_path
            )
            if candidate_generation.fingerprint() != (
                protected_configuration_generation_sha256
            ):
                raise ReadinessTrustError(
                    "PROTECTED_CONFIGURATION_CHANGED",
                    "protected configuration generation changed during "
                    "validation; discard the result and retry with freshly "
                    "loaded inputs",
                )
            self._verify_protected_configuration_generation(
                candidate_generation
            )
            post_check = datetime.now(timezone.utc)
            if post_check < completion_probe:
                raise ReadinessTrustError(
                    "TRUSTED_CLOCK_ROLLBACK",
                    "trusted UTC clock moved backward during validation",
                )
            if post_check.date() == completion_probe.date():
                completed_at = post_check
                completed_configuration_generation = candidate_generation
                break
            previous_probe = completion_probe
            completion_probe = post_check
        if completed_at is None or completed_configuration_generation is None:
            raise ReadinessTrustError(
                "TRUSTED_CLOCK_UNSTABLE",
                "trusted UTC date did not stabilize during completion checks",
            )
        return ReadinessReport(
            dataset_id=dataset_id,
            manifest_schema_version=schema_version,
            manifest_sha256=manifest_sha256,
            dataset_trust_store_sha256=self._dataset_trust_store.fingerprint(),
            dataset_manifest_attestation=self._dataset_manifest_attestation,
            dataset_manifest_attestation_sha256=(
                self._dataset_manifest_attestation.fingerprint()
            ),
            dataset_manifest_trust_verified=dataset_manifest_trust_verified,
            readiness_verification_policy=self._readiness_verification_policy,
            readiness_verification_policy_sha256=(
                self._readiness_verification_policy_sha256
            ),
            rights_trust_store_sha256=self._rights_trust_store.fingerprint(),
            rights_verification_policy=self._rights_verification_policy,
            rights_verification_policy_sha256=(
                self._rights_verification_policy_sha256
            ),
            rights_evidence_generation_id=rights_evidence_generation_id,
            protected_configuration_generation=(
                completed_configuration_generation
            ),
            protected_configuration_generation_sha256=(
                protected_configuration_generation_sha256
            ),
            verifier_source_tree_sha256=final_verifier_source_tree_sha256,
            trusted_launcher_deployment_artifact_sha256=(
                self._trusted_launcher_deployment_artifact_sha256
            ),
            runtime_identity=final_runtime_identity,
            runtime_identity_sha256=final_runtime_identity_sha256,
            verifier_dependency_versions=(("cryptography", cryptography_version),),
            verified_at_utc=completed_at.isoformat(timespec="seconds").replace(
                "+00:00",
                "Z",
            ),
            require_unseen_test_venue=_REQUIRE_UNSEEN_TEST_VENUE,
            required_artifact_sha256s=required_artifact_sha256s,
            required_artifact_digest_set_sha256=(
                _required_artifact_digest_set_sha256(
                    required_artifact_sha256s
                )
            ),
            artifact_set_proof=artifact_set_proof,
            data_source_count=(
                len(data_sources) if isinstance(data_sources, list) else 0
            ),
            source_rights_proofs=source_rights_proofs,
            source_rights_proof_set_sha256=(
                _source_rights_proof_set_sha256(source_rights_proofs)
            ),
            issues=tuple(issues),
        )

    @staticmethod
    def _rights_evidence_generation_id(
        proofs: tuple[SourceRightsProof, ...],
    ) -> str | None:
        evidence_digests = tuple(
            sorted(
                {
                    digest
                    for proof in proofs
                    for digest in proof.evidence_sha256s
                }
            )
        )
        return generation_id_for(evidence_digests) if evidence_digests else None

    def _verify_protected_configuration_generation(
        self,
        generation: ProtectedConfigurationGeneration,
    ) -> None:
        if type(generation) is not ProtectedConfigurationGeneration:
            raise ValueError(
                "generation must be a ProtectedConfigurationGeneration"
            )
        comparisons = (
            (
                generation.dataset_trust_store_sha256,
                self._dataset_trust_store.fingerprint(),
                "dataset trust store",
            ),
            (
                generation.dataset_manifest_attestation_sha256,
                self._dataset_manifest_attestation.fingerprint(),
                "dataset manifest attestation",
            ),
            (
                generation.readiness_verification_policy_sha256,
                self._readiness_verification_policy_sha256,
                "readiness verification policy",
            ),
            (
                generation.rights_trust_store_sha256,
                self._rights_trust_store.fingerprint(),
                "rights trust store",
            ),
            (
                generation.rights_verification_policy_sha256,
                self._rights_verification_policy_sha256,
                "rights verification policy",
            ),
            (
                generation.trusted_launcher_deployment_artifact_sha256,
                self._trusted_launcher_deployment_artifact_sha256,
                "trusted launcher deployment artifact",
            ),
            (
                generation.governance_domain_id,
                self._expected_governance_domain_id,
                "governance domain",
            ),
        )
        for declared, actual, label in comparisons:
            if declared != actual:
                raise ReadinessTrustError(
                    "PROTECTED_CONFIGURATION_COMPONENT",
                    f"protected configuration generation does not match {label}",
                )

    def _validate_capture_profiles(
        self,
        profiles: Sequence[Mapping[str, Any]],
        issues: list[ReadinessIssue],
    ) -> None:
        seen_ids: set[str] = set()
        for index, profile in enumerate(profiles):
            path = f"capture_profiles[{index}]"
            if not isinstance(profile, Mapping):
                self._block(issues, "CAPTURE_SHAPE", path, "capture profile must be an object")
                continue
            self._reject_unknown_fields(profile, self._CAPTURE_FIELDS, path, issues)
            profile_id = profile.get("profile_id")
            if type(profile_id) is not str or not _STABLE_ID_RE.fullmatch(profile_id):
                self._block(
                    issues,
                    "CAPTURE_ID",
                    f"{path}.profile_id",
                    "profile_id must be a 1-128 character ASCII-stable identifier",
                )
            elif profile_id in seen_ids:
                self._block(issues, "CAPTURE_ID_DUPLICATE", f"{path}.profile_id", "profile_id must be unique")
            else:
                seen_ids.add(profile_id)

            try:
                mode = CaptureMode(profile.get("mode"))
            except (TypeError, ValueError):
                self._block(issues, "CAPTURE_MODE", f"{path}.mode", "unsupported capture mode")
                continue

            gates = {
                CaptureMode.HD_1080P30: {
                    "width": 1920,
                    "height": 1080,
                    "fps": 29.0,
                    "ball_pixels": 6.0,
                    "shutter": 500.0,
                    "camera_count": 1,
                    "max_blur_ratio": 2.0,
                },
                CaptureMode.UHD_4K60: {
                    "width": 3840,
                    "height": 2160,
                    "fps": 59.0,
                    "ball_pixels": 10.0,
                    "shutter": 1000.0,
                    "camera_count": 1,
                    "max_blur_ratio": 1.0,
                },
                CaptureMode.DUAL_4K60: {
                    "width": 3840,
                    "height": 2160,
                    "fps": 59.0,
                    "ball_pixels": 10.0,
                    "shutter": 1000.0,
                    "camera_count": 2,
                    "max_blur_ratio": 1.0,
                },
            }[mode]

            if mode is CaptureMode.HD_1080P30:
                self._warn(
                    issues,
                    "COMPATIBILITY_CAPTURE",
                    path,
                    "1080p30 is a conditional compatibility profile, not the preferred production baseline",
                )

            for field_name in (
                "width",
                "height",
                "camera_count",
                "sampled_visible_ball_frames",
                "sampled_decisive_event_windows",
            ):
                value = profile.get(field_name)
                if not isinstance(value, int) or isinstance(value, bool):
                    self._block(issues, "CAPTURE_NUMBER", f"{path}.{field_name}", "must be an integer")
            for field_name in (
                "fps",
                "bitrate_mbps",
                "shutter_reciprocal",
                "far_ball_processed_pixels_p10",
                "human_resolvable_visible_ball_ratio",
                "visible_serve_frames_meeting_pixel_gate_ratio",
                "visible_ball_blur_to_minor_axis_ratio_p95",
                "usable_observed_positions_per_eligible_event_p10",
                "calibration_holdout_p95_px",
                "court_plane_holdout_p95_cm",
                "capture_soak_minutes",
            ):
                value = profile.get(field_name)
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    self._block(issues, "CAPTURE_NUMBER", f"{path}.{field_name}", "must be numeric")

            self._minimum(profile, "width", gates["width"], path, issues)
            self._minimum(profile, "height", gates["height"], path, issues)
            self._minimum(profile, "fps", gates["fps"], path, issues)
            self._minimum(profile, "camera_count", gates["camera_count"], path, issues)
            self._minimum(profile, "shutter_reciprocal", gates["shutter"], path, issues)
            self._minimum(profile, "far_ball_processed_pixels_p10", gates["ball_pixels"], path, issues)
            self._minimum(profile, "human_resolvable_visible_ball_ratio", 0.995, path, issues)
            self._minimum(profile, "visible_serve_frames_meeting_pixel_gate_ratio", 0.99, path, issues)
            self._maximum(profile, "human_resolvable_visible_ball_ratio", 1.0, path, issues)
            self._maximum(
                profile,
                "visible_serve_frames_meeting_pixel_gate_ratio",
                1.0,
                path,
                issues,
            )
            self._minimum(profile, "sampled_visible_ball_frames", 1000, path, issues)
            self._minimum(
                profile,
                "sampled_decisive_event_windows",
                1000,
                path,
                issues,
            )
            self._minimum(profile, "bitrate_mbps", 0.001, path, issues)
            self._minimum(
                profile,
                "usable_observed_positions_per_eligible_event_p10",
                3.0,
                path,
                issues,
            )
            for nonnegative_field in (
                "visible_ball_blur_to_minor_axis_ratio_p95",
                "calibration_holdout_p95_px",
                "court_plane_holdout_p95_cm",
            ):
                self._minimum(profile, nonnegative_field, 0.0, path, issues)
            self._minimum(profile, "capture_soak_minutes", 120.0, path, issues)
            self._maximum(
                profile,
                "visible_ball_blur_to_minor_axis_ratio_p95",
                gates["max_blur_ratio"],
                path,
                issues,
            )
            self._maximum(profile, "calibration_holdout_p95_px", 2.0, path, issues)
            self._maximum(profile, "court_plane_holdout_p95_cm", 5.0, path, issues)

            self._must_equal(profile, "timestamp_regressions", 0, path, issues)
            self._must_equal(profile, "critical_unexplained_drop_events", 0, path, issues)
            self._must_equal(profile, "unexplained_freeze_events", 0, path, issues)
            self._must_equal(profile, "native_capture_verified", True, path, issues)
            self._must_equal(profile, "frame_interpolation_detected", False, path, issues)
            self._must_equal(profile, "upscaled_from_lower_resolution", False, path, issues)
            self._must_equal(profile, "service_zones_fully_visible", True, path, issues)
            self._must_equal(profile, "fixed_mount", True, path, issues)

            for checksum_field in (
                "calibration_profile_sha256",
                "camera_device_attestation_sha256",
                "capture_clock_verification_sha256",
                "encoder_configuration_sha256",
            ):
                checksum = profile.get(checksum_field)
                if not isinstance(checksum, str) or not _SHA256_RE.fullmatch(checksum):
                    self._block(
                        issues,
                        "CAPTURE_CHECKSUM",
                        f"{path}.{checksum_field}",
                        f"{checksum_field} requires a lowercase SHA-256",
                    )

            for identity_field in ("camera_device_id", "lens_configuration_id"):
                value = profile.get(identity_field)
                if (
                    type(value) is not str
                    or not _STABLE_ID_RE.fullmatch(value)
                ):
                    self._block(
                        issues,
                        "CAPTURE_IDENTITY",
                        f"{path}.{identity_field}",
                        f"{identity_field} must be a 1-128 character ASCII-stable identifier",
                    )

            if mode is CaptureMode.DUAL_4K60:
                sync_p95 = profile.get("exposure_sync_p95_ms")
                if (
                    not isinstance(sync_p95, (int, float))
                    or isinstance(sync_p95, bool)
                    or not math.isfinite(sync_p95)
                    or sync_p95 < 0
                    or sync_p95 > 1.0
                ):
                    self._block(
                        issues,
                        "EXPOSURE_SYNC",
                        f"{path}.exposure_sync_p95_ms",
                        "dual-view exposure synchronization P95 must be measured at <=1 ms",
                    )

    def _validate_data_sources(
        self,
        sources: Sequence[Mapping[str, Any]],
        capture_profile_ids: set[str],
        verified_on: str,
        issues: list[ReadinessIssue],
        *,
        verify_rights: bool,
    ) -> tuple[SourceRightsProof, ...]:
        if type(verify_rights) is not bool:
            raise ValueError("verify_rights must be a boolean")
        seen_ids: set[str] = set()
        split_records: list[SourceSplitRecord] = []
        rights_proofs: list[SourceRightsProof] = []
        rights_candidates: list[
            tuple[Mapping[str, Any], DatasetSplit, str]
        ] = []

        for index, source in enumerate(sources):
            path = f"data_sources[{index}]"
            if not isinstance(source, Mapping):
                self._block(issues, "SOURCE_SHAPE", path, "data source must be an object")
                continue
            self._reject_unknown_fields(source, self._SOURCE_FIELDS, path, issues)

            source_id = source.get("source_id")
            if (
                type(source_id) is not str
                or not _STABLE_ID_RE.fullmatch(source_id)
            ):
                self._block(
                    issues,
                    "SOURCE_ID",
                    f"{path}.source_id",
                    "source_id must be a 1-128 character ASCII-stable identifier",
                )
            elif source_id in seen_ids:
                self._block(issues, "SOURCE_ID_DUPLICATE", f"{path}.source_id", "source_id must be unique")
            else:
                seen_ids.add(source_id)

            profile_id = source.get("capture_profile_id")
            if not isinstance(profile_id, str) or profile_id not in capture_profile_ids:
                self._block(
                    issues,
                    "CAPTURE_PROFILE_REFERENCE",
                    f"{path}.capture_profile_id",
                    "data source must reference a declared capture profile",
                )
            for field_name in (
                "ball_design_id",
                "lighting_condition",
            ):
                value = source.get(field_name)
                if (
                    type(value) is not str
                    or not _STABLE_ID_RE.fullmatch(value)
                ):
                    self._block(
                        issues,
                        "SOURCE_METADATA",
                        f"{path}.{field_name}",
                        f"{field_name} must be an ASCII-stable identifier for domain-disjoint evaluation",
                    )

            labels_checksum = source.get("labels_sha256")
            if not isinstance(labels_checksum, str) or not _SHA256_RE.fullmatch(labels_checksum):
                self._block(
                    issues,
                    "SOURCE_CHECKSUM",
                    f"{path}.labels_sha256",
                    "labels_sha256 requires a lowercase SHA-256",
                )

            try:
                split = DatasetSplit(source.get("split"))
            except (TypeError, ValueError):
                self._block(issues, "SOURCE_SPLIT", f"{path}.split", "split must be TRAIN, DEV, or TEST")
                continue

            if "parent_asset_sha256" not in source:
                self._block(
                    issues,
                    "SOURCE_SPLIT_RECORD",
                    f"{path}.parent_asset_sha256",
                    "parent_asset_sha256 is required and must be null for a root asset",
                )
                continue

            try:
                split_record = SourceSplitRecord(
                        asset_sha256=source.get("asset_sha256"),
                        root_asset_sha256=source.get("root_asset_sha256"),
                        parent_asset_sha256=source.get("parent_asset_sha256"),
                        match_id=source.get("match_id"),
                        venue_id=source.get("venue_id"),
                        camera_setup_id=source.get("camera_setup_id"),
                        recording_date=source.get("recording_date"),
                        synchronized_capture_group_id=source.get(
                            "synchronized_capture_group_id"
                        ),
                        split_group_id=source.get("split_group_id"),
                        split=split,
                    )
                split_records.append(split_record)
                rights_candidates.append((source, split, path))
            except ValueError as exc:
                self._block(
                    issues,
                    "SOURCE_SPLIT_RECORD",
                    path,
                    str(exc),
                )

        split_is_valid = False
        if len(split_records) == len(sources):
            try:
                SplitManifest(
                    records=tuple(split_records),
                    require_unseen_test_venue=_REQUIRE_UNSEEN_TEST_VENUE,
                )
                split_is_valid = True
            except SplitContractError as exc:
                self._block(issues, exc.code, "data_sources", str(exc))
            except ValueError as exc:
                self._block(issues, "SPLIT_CONTRACT", "data_sources", str(exc))
        if split_is_valid and verify_rights:
            # Do not perform signature/evidence work until every cheap source,
            # lineage, grouping, and leakage invariant has passed. This bounds
            # amplification from structurally invalid manifests.
            prepared_rights: list[_PreparedSourceRights] = []
            for source, split, path in rights_candidates:
                prepared = self._prepare_rights_fields(
                    source,
                    split=split,
                    verified_on=verified_on,
                    path=path,
                    issues=issues,
                )
                if prepared is not None:
                    prepared_rights.append(prepared)
            if prepared_rights:
                evidence_sets: tuple[tuple[str, ...], ...] | None
                try:
                    evidence_sets = self._rights_trust_store.verify_attestations_batch(
                        tuple(
                            (prepared.decision, prepared.attestation)
                            for prepared in prepared_rights
                        ),
                        verified_on=verified_on,
                    )
                except RightsTrustError as exc:
                    self._block(
                        issues,
                        exc.code,
                        "data_sources.rights_attestations",
                        str(exc),
                    )
                    evidence_sets = None
                if evidence_sets is not None:
                    for prepared, evidence_sha256s in zip(
                        prepared_rights,
                        evidence_sets,
                        strict=True,
                    ):
                        try:
                            rights_proofs.append(
                                SourceRightsProof(
                                    source_id=prepared.source_id,
                                    asset_sha256=prepared.asset_sha256,
                                    labels_sha256=prepared.labels_sha256,
                                    split=prepared.split,
                                    decision_sha256=prepared.decision.fingerprint(),
                                    attestation_sha256=(
                                        prepared.attestation.fingerprint()
                                    ),
                                    evidence_sha256s=evidence_sha256s,
                                    rights_reviewed_on=prepared.decision.reviewed_on,
                                    rights_expires_on=prepared.decision.expires_on,
                                    verified_on=verified_on,
                                    required_uses=prepared.required_uses,
                                )
                            )
                        except ValueError as exc:
                            self._block(
                                issues,
                                "RIGHTS_PROOF_SHAPE",
                                prepared.path,
                                str(exc),
                            )
            if rights_proofs:
                evidence_union = tuple(
                    sorted(
                        {
                            digest
                            for proof in rights_proofs
                            for digest in proof.evidence_sha256s
                        }
                    )
                )
                try:
                    verify_rights_evidence_batch(
                        evidence_union,
                        evidence_store_root=self._rights_evidence_store_root,
                    )
                except RightsTrustError as exc:
                    self._block(
                        issues,
                        exc.code,
                        "rights_evidence_store_root",
                        str(exc),
                    )
                    rights_proofs.clear()
        return tuple(rights_proofs)

    def _prepare_rights_fields(
        self,
        source: Mapping[str, Any],
        *,
        split: DatasetSplit,
        verified_on: str,
        path: str,
        issues: list[ReadinessIssue],
    ) -> _PreparedSourceRights | None:
        policy = self._rights_verification_policy
        if policy.use_profile is not RightsUseProfile.COMMERCIAL_ASSISTIVE_SCORING_V1:
            self._block(
                issues,
                "RIGHTS_USE_PROFILE",
                f"{path}.rights_decision",
                "unsupported intended-use profile",
            )
            return None
        try:
            raw_decision = source.get("rights_decision")
            if not isinstance(raw_decision, Mapping):
                raise ValueError("rights_decision must be a JSON object")
            decision = rights_decision_from_dict(raw_decision)
        except ValueError as exc:
            self._block(
                issues,
                "RIGHTS_DECISION_FORMAT",
                f"{path}.rights_decision",
                str(exc),
            )
            return None
        asset_sha256 = source.get("asset_sha256")
        if decision.asset_sha256 != asset_sha256:
            self._block(
                issues,
                "RIGHTS_ASSET_MISMATCH",
                f"{path}.rights_decision.asset_sha256",
                "rights decision must name the exact source asset SHA-256",
            )
            return None
        declared_fingerprint = source.get("rights_decision_sha256")
        if (
            type(declared_fingerprint) is not str
            or not _SHA256_RE.fullmatch(declared_fingerprint)
            or declared_fingerprint != decision.fingerprint()
        ):
            self._block(
                issues,
                "RIGHTS_DECISION_CHECKSUM",
                f"{path}.rights_decision_sha256",
                "rights_decision_sha256 must match the canonical decision",
            )
            return None
        try:
            raw_attestation = source.get("rights_attestation")
            if not isinstance(raw_attestation, Mapping):
                raise ValueError("rights_attestation must be a JSON object")
            attestation = rights_attestation_from_dict(raw_attestation)
        except ValueError as exc:
            self._block(
                issues,
                "RIGHTS_ATTESTATION_FORMAT",
                f"{path}.rights_attestation",
                str(exc),
            )
            return None
        required_uses = (
            _TRAIN_DEV_REQUIRED_USES
            if split in {DatasetSplit.TRAIN, DatasetSplit.DEV}
            else _TEST_REQUIRED_USES
        )
        if not decision.authorizes(
            required_uses,
            as_of=verified_on,
            geography=policy.deployment_geography,
        ):
            self._block(
                issues,
                "SOURCE_RIGHTS",
                f"{path}.rights_decision",
                "current signed decision does not authorize the exact split uses, date, and geography",
            )
            return None
        try:
            return _PreparedSourceRights(
                source_id=source.get("source_id"),
                asset_sha256=source.get("asset_sha256"),
                labels_sha256=source.get("labels_sha256"),
                split=split,
                decision=decision,
                attestation=attestation,
                required_uses=required_uses,
                path=path,
            )
        except ValueError as exc:
            self._block(
                issues,
                "RIGHTS_PROOF_SHAPE",
                path,
                str(exc),
            )
            return None

    @staticmethod
    def _block(issues: list[ReadinessIssue], code: str, path: str, message: str) -> None:
        issues.append(
            ReadinessIssue(
                code=code,
                severity=Severity.BLOCKER,
                path=_bounded_issue_text(path, _MAX_ISSUE_PATH_CHARS),
                message=_bounded_issue_text(
                    message,
                    _MAX_ISSUE_MESSAGE_CHARS,
                ),
            )
        )

    @staticmethod
    def _warn(issues: list[ReadinessIssue], code: str, path: str, message: str) -> None:
        issues.append(
            ReadinessIssue(
                code=code,
                severity=Severity.WARNING,
                path=_bounded_issue_text(path, _MAX_ISSUE_PATH_CHARS),
                message=_bounded_issue_text(
                    message,
                    _MAX_ISSUE_MESSAGE_CHARS,
                ),
            )
        )

    @classmethod
    def _reject_unknown_fields(
        cls,
        data: Mapping[str, Any],
        allowed: frozenset[str],
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        unknown = sorted(str(key) for key in data if key not in allowed)
        if unknown:
            cls._block(
                issues,
                "UNKNOWN_FIELD",
                path,
                f"unsupported fields: {', '.join(unknown)}",
            )

    @classmethod
    def _minimum(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        minimum: float,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < minimum
        ):
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must be >= {minimum}; this is an engineering gate",
            )

    @classmethod
    def _maximum(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        maximum: float,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value > maximum
        ):
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must be <= {maximum}; this is an engineering gate",
            )

    @classmethod
    def _must_equal(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        expected: Any,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if type(value) is not type(expected) or value != expected:
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must equal {expected!r}",
            )


def readiness_runtime_identity() -> tuple[tuple[str, str], ...]:
    """Return the selected executing runtime facts pinned by governance."""

    try:
        cryptography_version = package_version("cryptography")
    except PackageNotFoundError:
        cryptography_version = "missing"
    values = {
        "cryptography": cryptography_version,
        "machine": platform.machine(),
        "openssl": openssl_backend.openssl_version_text(),
        "python_cache_tag": str(sys.implementation.cache_tag),
        "python_compiler": platform.python_compiler(),
        "python_implementation": platform.python_implementation(),
        "python_version": platform.python_version(),
        "system": platform.system(),
        "system_release": platform.release(),
    }
    if any(not value for value in values.values()):
        raise RuntimeError("readiness runtime identity contains an empty value")
    return tuple(sorted(values.items()))


def readiness_runtime_identity_sha256(
    identity: tuple[tuple[str, str], ...] | None = None,
) -> str:
    """Hash the exact canonical runtime identity used by readiness policy."""

    selected = readiness_runtime_identity() if identity is None else identity
    if (
        type(selected) is not tuple
        or any(
            type(item) is not tuple
            or len(item) != 2
            or type(item[0]) is not str
            or type(item[1]) is not str
            or not item[0]
            or not item[1]
            for item in selected
        )
        or tuple(sorted(selected)) != selected
        or len({key for key, _ in selected}) != len(selected)
    ):
        raise ValueError("runtime identity must be sorted unique string pairs")
    return hashlib.sha256(canonical_json_bytes(dict(selected))).hexdigest()


def readiness_verifier_source_tree_sha256() -> str:
    """Hash verifier source bytes; this is not executable-code attestation.

    The separately pinned readiness policy also requires a trusted-launcher
    deployment-artifact digest and an executing runtime digest. This source-tree
    commitment alone must never be represented as proof of loaded code.
    """

    source_root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for filename in _VERIFIER_SOURCE_FILES:
        payload = (source_root / filename).read_bytes()
        encoded_name = filename.encode("utf-8")
        digest.update(len(encoded_name).to_bytes(4, "big"))
        digest.update(encoded_name)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _required_dataset_artifact_sha256s(
    manifest: Mapping[str, Any],
) -> tuple[str, ...]:
    """Collect exact media, label, and capture-evidence content addresses."""

    digests: set[str] = set()
    capture_profiles = manifest.get("capture_profiles")
    if isinstance(capture_profiles, list):
        for profile in capture_profiles:
            if not isinstance(profile, Mapping):
                continue
            for field_name in (
                "calibration_profile_sha256",
                "camera_device_attestation_sha256",
                "capture_clock_verification_sha256",
                "encoder_configuration_sha256",
            ):
                value = profile.get(field_name)
                if type(value) is str and _SHA256_RE.fullmatch(value):
                    digests.add(value)
    data_sources = manifest.get("data_sources")
    if isinstance(data_sources, list):
        for source in data_sources:
            if not isinstance(source, Mapping):
                continue
            for field_name in ("asset_sha256", "labels_sha256"):
                value = source.get(field_name)
                if type(value) is str and _SHA256_RE.fullmatch(value):
                    digests.add(value)
    return tuple(sorted(digests))


def load_manifest(path: Path) -> Mapping[str, Any]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("manifest must be a non-symlink regular file")
        if before.st_size > _MAX_MANIFEST_BYTES:
            raise ValueError(f"manifest exceeds {_MAX_MANIFEST_BYTES} bytes")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError("manifest was truncated while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValueError("manifest grew while reading")
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError("manifest changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"manifest contains duplicate JSON object key: {key}")
            result[key] = value
        return result

    manifest = json.loads(
        raw.decode("utf-8", errors="strict"),
        object_pairs_hook=reject_duplicate_keys,
    )
    if not isinstance(manifest, Mapping):
        raise ValueError("manifest root must be a JSON object")
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="path to readiness manifest JSON")
    parser.add_argument(
        "--dataset-trust-store",
        required=True,
        type=Path,
        help="out-of-band trusted dataset-curator key/current-manifest store",
    )
    parser.add_argument(
        "--dataset-manifest-attestation",
        required=True,
        type=Path,
        help="detached curator signature for the exact canonical manifest",
    )
    parser.add_argument(
        "--readiness-verification-policy",
        required=True,
        type=Path,
        help="protected readiness, artifact, runtime, and split policy",
    )
    parser.add_argument(
        "--expected-readiness-verification-policy-sha256",
        required=True,
        help="separately pinned canonical SHA-256 of the readiness policy",
    )
    parser.add_argument(
        "--trusted-launcher-deployment-artifact-sha256",
        required=True,
        help="deployment artifact digest independently established by the trusted launcher",
    )
    parser.add_argument(
        "--expected-governance-domain-id",
        required=True,
        help="dataset governance domain independently configured by the trusted launcher",
    )
    parser.add_argument(
        "--protected-configuration-generation",
        required=True,
        type=Path,
        help=(
            "trusted current-generation descriptor rechecked after validation "
            "to detect concurrent policy or revocation publication"
        ),
    )
    parser.add_argument(
        "--artifact-store-root",
        required=True,
        type=Path,
        help=(
            "protected immutable store root containing locks/ and exact "
            "generations/ for media, labels, and capture artifacts"
        ),
    )
    parser.add_argument(
        "--rights-trust-store",
        required=True,
        type=Path,
        help="out-of-band trusted reviewer key/current-decision store",
    )
    parser.add_argument(
        "--rights-verification-policy",
        required=True,
        type=Path,
        help="protected deployment rights/use/verification policy",
    )
    parser.add_argument(
        "--expected-rights-verification-policy-sha256",
        required=True,
        help="separately pinned canonical SHA-256 of the protected policy",
    )
    parser.add_argument(
        "--rights-evidence-store-root",
        required=True,
        type=Path,
        help=(
            "protected immutable store root containing the exact leased "
            "rights-evidence generation"
        ),
    )
    args = parser.parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        dataset_trust_store = load_dataset_trust_store(args.dataset_trust_store)
        dataset_manifest_attestation = load_dataset_manifest_attestation(
            args.dataset_manifest_attestation
        )
        readiness_verification_policy = load_readiness_verification_policy(
            args.readiness_verification_policy
        )
        trust_store = load_rights_trust_store(args.rights_trust_store)
        verification_policy = load_rights_verification_policy(
            args.rights_verification_policy
        )
        expected_policy_sha256 = (
            args.expected_rights_verification_policy_sha256
        )
        if (
            type(expected_policy_sha256) is not str
            or not _SHA256_RE.fullmatch(expected_policy_sha256)
        ):
            raise ValueError(
                "expected rights policy fingerprint must be a lowercase SHA-256"
            )
        report = ManifestValidator(
            dataset_trust_store=dataset_trust_store,
            dataset_manifest_attestation=dataset_manifest_attestation,
            readiness_verification_policy=readiness_verification_policy,
            expected_readiness_verification_policy_sha256=(
                args.expected_readiness_verification_policy_sha256
            ),
            trusted_launcher_deployment_artifact_sha256=(
                args.trusted_launcher_deployment_artifact_sha256
            ),
            expected_governance_domain_id=args.expected_governance_domain_id,
            protected_configuration_generation_path=(
                args.protected_configuration_generation
            ),
            artifact_store_root=args.artifact_store_root,
            rights_trust_store=trust_store,
            rights_evidence_store_root=args.rights_evidence_store_root,
            rights_verification_policy=verification_policy,
            expected_rights_verification_policy_sha256=expected_policy_sha256,
        ).validate(manifest)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 2
    print(json.dumps(report.to_dict(), indent=2))
    return 0 if report.ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
