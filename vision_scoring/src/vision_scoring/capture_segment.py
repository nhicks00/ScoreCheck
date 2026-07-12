"""Signed, policy-bounded capture-service evidence for one finalized segment.

The signature authenticated here is a capture service assertion.  It is not
proof of physical-camera identity, clock/UTC truth, resident media, decoded
content, audio absence, or a scoreable sports event.  This module is pure
control plane: callers supply already materialized contracts and metadata
traces; it performs no media, filesystem, network, database, signing, or
ScoreCheck operation.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .capture_assets import (
    AssetResidencyStatus,
    CaptureAssetTrustPolicy,
    FinalizedCaptureMetadataAttestation,
    FinalizedCaptureMetadataTrustSnapshot,
    StructurallyVerifiedCaptureMetadata,
    finalized_trace_fingerprint,
    verify_capture_asset_policy_pin,
    verify_capture_metadata_policy_binding,
    verify_finalized_capture_metadata_attestation,
)
from .capture_contracts import (
    MAX_CLOSED_FRAGMENTS,
    CaptureFragmentDescriptor,
    CaptureSessionDescriptor,
    CaptureSegmentIntegrityReport,
    CaptureSourceKind,
    CaptureTraceRecord,
    CaptureTrustDomain,
    EvidenceWindowPlan,
    EvidenceWindowRequest,
    EvidenceWindowStatus,
    FinalizedSourceFrameSignal,
    IntegrityDisposition,
)
from .capture_integrity import ClockMappingCandidate, evaluate_capture_trace
from .capture_rights import (
    CAPTURE_OPERATION_REQUIRED_USES,
    CaptureRightsTrustSnapshot,
    CaptureSessionRightsGrant,
    CaptureSessionRightsGrantAttestation,
    capture_session_rights_grant_from_json_bytes,
    verify_capture_session_rights,
)
from .capture_windows import plan_evidence_window
from .contract_wire import (
    CanonicalWireError,
    canonical_base64 as _canonical_base64,
    canonical_json_bytes as _canonical_json_bytes,
    enum_from_json as _enum_from_json,
    exact_list as _exact_list,
    parse_canonical_json_object as _parse_canonical_json,
    require_canonical_tuple as _require_canonical_tuple,
    require_exact_fields as _require_fields,
    require_exact_int as _require_exact_int,
    require_sha256 as _require_sha256,
    require_stable_id as _require_stable_id,
)
from .rights import PermittedUse

CAPTURE_SEGMENT_SCHEMA_VERSION = "1.0"
CAPTURE_SEGMENT_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:capture-segment-attestation:v1"
)
MAX_CAPTURE_SEGMENT_STATEMENT_BYTES = 64 * 1024
MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES = 4 * 1024
MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES = 512 * 1024
MAX_CAPTURE_SEGMENT_SIGNER_KEYS = 64
MAX_REVOKED_CAPTURE_SEGMENTS = 512
MAX_RESERVED_NONSEGMENT_KEYS = 256


class CaptureSegmentError(ValueError):
    """Construction, parsing, or verification failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaptureSegmentError(code, message)


class CaptureSegmentKeyRole(str, Enum):
    CAPTURE_SEGMENT_ATTESTATION_SIGNER = "CAPTURE_SEGMENT_ATTESTATION_SIGNER"


class CaptureServiceClaimStatus(str, Enum):
    SERVICE_SIGNED_POLICY_BOUNDED_REFERENCES = (
        "SERVICE_SIGNED_POLICY_BOUNDED_REFERENCES"
    )


class PhysicalCaptureTruthStatus(str, Enum):
    NOT_CLAIMED = "NOT_CLAIMED"


class CaptureSegmentContentStatus(str, Enum):
    NOT_VERIFIED = "NOT_VERIFIED"


class CaptureSegmentAudioStatus(str, Enum):
    OUTSIDE_CAPTURE_SEGMENT_CONTRACT = "OUTSIDE_CAPTURE_SEGMENT_CONTRACT"


class CaptureSegmentAdmissibilityStatus(str, Enum):
    NOT_ADMISSIBLE_PENDING_SOURCE_RESIDENCY_AND_SIGNED_RENDER_VALIDATION = (
        "NOT_ADMISSIBLE_PENDING_SOURCE_RESIDENCY_AND_SIGNED_RENDER_VALIDATION"
    )


_FIXED_SERVICE_STATUS = (
    CaptureServiceClaimStatus.SERVICE_SIGNED_POLICY_BOUNDED_REFERENCES
)
_FIXED_PHYSICAL_STATUS = PhysicalCaptureTruthStatus.NOT_CLAIMED
_FIXED_CONTENT_STATUS = CaptureSegmentContentStatus.NOT_VERIFIED
_FIXED_AUDIO_STATUS = CaptureSegmentAudioStatus.OUTSIDE_CAPTURE_SEGMENT_CONTRACT
_FIXED_ADMISSIBILITY = (
    CaptureSegmentAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_SOURCE_RESIDENCY_AND_SIGNED_RENDER_VALIDATION
)


def _bounded_canonical_json(
    value: Mapping[str, Any], *, label: str, maximum_bytes: int
) -> bytes:
    return _canonical_json_bytes(value, label=label, maximum_bytes=maximum_bytes)


def _parse_bounded_canonical_json(
    raw: bytes, *, label: str, maximum_bytes: int
) -> dict[str, Any]:
    if type(raw) is not bytes or not 1 <= len(raw) <= maximum_bytes:
        _fail("JSON_SIZE", f"{label} must be 1 to {maximum_bytes} exact bytes")
    try:
        return _parse_canonical_json(raw, label=label, maximum_bytes=maximum_bytes)
    except CanonicalWireError as exc:
        _fail(exc.code, str(exc))
        raise AssertionError from exc
    except CaptureSegmentError:
        raise
    except ValueError as exc:
        _fail("INVALID_JSON", str(exc))
        raise AssertionError from exc


def _nested_json_bytes(value: object, *, label: str) -> bytes:
    if type(value) is not dict:
        _fail("INVALID_NESTED_CONTRACT", f"{label} must be an exact JSON object")
    return _canonical_json_bytes(value, label=label)


def _public_key_sha256(public_key_base64: str) -> str:
    raw = _canonical_base64(public_key_base64, "public_key_base64", expected_bytes=32)
    return hashlib.sha256(raw).hexdigest()


def _clock_mapping_from_dict(value: object) -> ClockMappingCandidate:
    if type(value) is not dict:
        _fail("INVALID_CLOCK_MAPPING", "clock_mapping must be an exact object")
    try:
        _require_fields(
            value,
            set(ClockMappingCandidate.__dataclass_fields__),
            label="clock_mapping",
        )
        return ClockMappingCandidate(
            **{
                **value,
                "trust_domain": _enum_from_json(
                    CaptureTrustDomain, value["trust_domain"], "trust_domain"
                ),
            }
        )
    except CaptureSegmentError:
        raise
    except (TypeError, ValueError) as exc:
        _fail("INVALID_CLOCK_MAPPING", str(exc))
        raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class FinalizedCaptureSegmentStatement:
    """Canonical full statement signed by the isolated capture service."""

    segment_id: str
    lineage_id: str
    capture_service_id: str
    reconnect_epoch: int
    segment_sequence: int
    finalized_at_ns: int
    rights_verified_at_ns: int
    capture_metadata: StructurallyVerifiedCaptureMetadata
    capture_metadata_sha256: str
    capture_metadata_attestation_sha256: str
    capture_metadata_trust_snapshot_sha256: str
    session: CaptureSessionDescriptor
    clock_mapping: ClockMappingCandidate
    clock_mapping_sha256: str
    window_request: EvidenceWindowRequest
    window_plan: EvidenceWindowPlan
    finalized_trace_sha256: str
    integrity_report: CaptureSegmentIntegrityReport
    capture_policy: CaptureAssetTrustPolicy
    capture_policy_sha256: str
    capture_policy_generation: int
    capture_rights_grant: CaptureSessionRightsGrant
    capture_rights_grant_sha256: str
    capture_rights_attestation_sha256: str
    capture_rights_trust_snapshot_sha256: str
    rights_policy_sha256: str
    rights_policy_generation: int
    intended_uses: tuple[PermittedUse, ...]
    service_claim_status: CaptureServiceClaimStatus = _FIXED_SERVICE_STATUS
    physical_capture_truth_status: PhysicalCaptureTruthStatus = _FIXED_PHYSICAL_STATUS
    asset_residency_status: AssetResidencyStatus = AssetResidencyStatus.NOT_VERIFIED
    content_status: CaptureSegmentContentStatus = _FIXED_CONTENT_STATUS
    audio_status: CaptureSegmentAudioStatus = _FIXED_AUDIO_STATUS
    admissibility_status: CaptureSegmentAdmissibilityStatus = _FIXED_ADMISSIBILITY
    schema_version: str = CAPTURE_SEGMENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SEGMENT_SCHEMA_VERSION:
            raise ValueError("unsupported capture-segment-statement schema")
        for field_name in ("segment_id", "lineage_id", "capture_service_id"):
            _require_stable_id(getattr(self, field_name), field_name)
        reconnect_epoch = _require_exact_int(self.reconnect_epoch, "reconnect_epoch")
        if reconnect_epoch != 0:
            raise ValueError(
                "schema 1 rejects reconnect epochs until protected checkpoint semantics exist"
            )
        if _require_exact_int(self.segment_sequence, "segment_sequence") != 0:
            raise ValueError("schema 1 permits only one sequence-zero genesis segment")
        finalized_at = _require_exact_int(self.finalized_at_ns, "finalized_at_ns")
        rights_verified_at = _require_exact_int(
            self.rights_verified_at_ns, "rights_verified_at_ns"
        )
        if rights_verified_at < finalized_at:
            raise ValueError("rights verification cannot precede finalization")
        if type(self.capture_metadata) is not StructurallyVerifiedCaptureMetadata:
            raise ValueError("capture_metadata has the wrong exact type")
        if type(self.session) is not CaptureSessionDescriptor:
            raise ValueError("session has the wrong exact type")
        if type(self.clock_mapping) is not ClockMappingCandidate:
            raise ValueError("clock_mapping has the wrong exact type")
        if type(self.window_request) is not EvidenceWindowRequest:
            raise ValueError("window_request has the wrong exact type")
        if type(self.window_plan) is not EvidenceWindowPlan:
            raise ValueError("window_plan has the wrong exact type")
        if type(self.integrity_report) is not CaptureSegmentIntegrityReport:
            raise ValueError("integrity_report has the wrong exact type")
        if type(self.capture_policy) is not CaptureAssetTrustPolicy:
            raise ValueError("capture_policy has the wrong exact type")
        if type(self.capture_rights_grant) is not CaptureSessionRightsGrant:
            raise ValueError("capture_rights_grant has the wrong exact type")
        for field_name in (
            "capture_metadata_sha256",
            "capture_metadata_attestation_sha256",
            "capture_metadata_trust_snapshot_sha256",
            "clock_mapping_sha256",
            "finalized_trace_sha256",
            "capture_policy_sha256",
            "capture_rights_grant_sha256",
            "capture_rights_attestation_sha256",
            "capture_rights_trust_snapshot_sha256",
            "rights_policy_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        _require_exact_int(self.capture_policy_generation, "capture_policy_generation")
        _require_exact_int(self.rights_policy_generation, "rights_policy_generation")
        if self.capture_metadata.fingerprint() != self.capture_metadata_sha256:
            raise ValueError("capture_metadata_sha256 differs from embedded metadata")
        if self.session.fingerprint() != self.capture_metadata.session_fingerprint:
            raise ValueError("session differs from capture metadata")
        if (
            self.session.configuration_fingerprint
            != self.capture_metadata.session_configuration_fingerprint
        ):
            raise ValueError("session configuration differs from capture metadata")
        if self.clock_mapping.fingerprint() != self.clock_mapping_sha256:
            raise ValueError("clock_mapping_sha256 differs from embedded mapping")
        if self.clock_mapping_sha256 != self.capture_metadata.clock_mapping_fingerprint:
            raise ValueError("clock mapping differs from capture metadata")
        if (
            self.window_request.fingerprint()
            != self.capture_metadata.window_request_fingerprint
        ):
            raise ValueError("window request differs from capture metadata")
        if (
            self.window_plan.fingerprint()
            != self.capture_metadata.window_plan_fingerprint
        ):
            raise ValueError("window plan differs from capture metadata")
        if self.window_plan.status is not EvidenceWindowStatus.PLANNED:
            raise ValueError("capture segment requires a fully planned window")
        if self.finalized_trace_sha256 != self.capture_metadata.finalized_trace_sha256:
            raise ValueError("finalized trace differs from capture metadata")
        if (
            self.integrity_report.fingerprint()
            != self.capture_metadata.integrity_report_sha256
        ):
            raise ValueError("integrity report differs from capture metadata")
        if (
            self.integrity_report.window_fingerprint
            != self.capture_metadata.integrity_window_sha256
        ):
            raise ValueError("integrity window differs from capture metadata")
        if (
            self.integrity_report.disposition is not IntegrityDisposition.OBSERVED_CLEAN
            or not self.integrity_report.finalized_trace_structurally_valid
            or not self.integrity_report.structurally_eligible_for_trust_verification
            or not self.integrity_report.video_only
        ):
            raise ValueError(
                "only clean structurally eligible video reports may be signed"
            )
        if self.capture_policy.fingerprint() != self.capture_policy_sha256:
            raise ValueError("capture policy fingerprint differs from embedded policy")
        if self.capture_policy.policy_generation != self.capture_policy_generation:
            raise ValueError("capture policy generation differs from embedded policy")
        if (
            self.capture_metadata.capture_policy_sha256 != self.capture_policy_sha256
            or self.capture_metadata.capture_policy_generation
            != self.capture_policy_generation
        ):
            raise ValueError("capture policy differs from capture metadata")
        verify_capture_metadata_policy_binding(
            self.capture_metadata, self.capture_policy
        )
        if (
            self.clock_mapping.claimed_max_absolute_error_ns
            > self.capture_policy.max_clock_absolute_error_ns
        ):
            raise ValueError("claimed clock error exceeds the policy ceiling")
        if self.capture_rights_grant.fingerprint() != self.capture_rights_grant_sha256:
            raise ValueError("capture rights fingerprint differs from embedded grant")
        if (
            self.capture_rights_grant_sha256
            != self.capture_metadata.capture_rights_grant_sha256
        ):
            raise ValueError("capture rights grant differs from capture metadata")
        if (
            self.capture_rights_attestation_sha256
            != self.capture_metadata.capture_rights_attestation_sha256
        ):
            raise ValueError("capture rights attestation differs from capture metadata")
        if (
            self.capture_rights_trust_snapshot_sha256
            != self.capture_metadata.capture_rights_trust_snapshot_sha256
        ):
            raise ValueError("capture rights trust differs from capture metadata")
        if (
            self.rights_policy_sha256 != self.capture_metadata.rights_policy_sha256
            or self.rights_policy_generation
            != self.capture_metadata.rights_policy_generation
        ):
            raise ValueError("rights policy differs from capture metadata")
        if self.intended_uses != CAPTURE_OPERATION_REQUIRED_USES:
            raise ValueError("capture segment permits exactly the two operational uses")
        if self.capture_rights_grant.permitted_uses != self.intended_uses:
            raise ValueError("capture grant uses differ from segment uses")
        if self.capture_metadata.verified_at_ns > finalized_at:
            raise ValueError(
                "segment finalization cannot precede structural verification"
            )
        if self.service_claim_status is not _FIXED_SERVICE_STATUS:
            raise ValueError("service claim status is fixed")
        if self.physical_capture_truth_status is not _FIXED_PHYSICAL_STATUS:
            raise ValueError("physical capture truth is not claimed")
        if self.asset_residency_status is not AssetResidencyStatus.NOT_VERIFIED:
            raise ValueError("asset residency is not verified by this boundary")
        if self.content_status is not _FIXED_CONTENT_STATUS:
            raise ValueError("media content is not verified by this boundary")
        if self.audio_status is not _FIXED_AUDIO_STATUS:
            raise ValueError("audio is outside this boundary")
        if self.admissibility_status is not _FIXED_ADMISSIBILITY:
            raise ValueError("capture-segment evidence is not product-admissible")
        _bounded_canonical_json(
            self.to_dict(),
            label="finalized capture segment statement",
            maximum_bytes=MAX_CAPTURE_SEGMENT_STATEMENT_BYTES,
        )

    @property
    def admissible_for_live_scorecheck_presentation(self) -> bool:
        return False

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    def to_dict(self) -> dict[str, Any]:
        return {
            "admissibility_status": self.admissibility_status.value,
            "asset_residency_status": self.asset_residency_status.value,
            "audio_status": self.audio_status.value,
            "capture_metadata": self.capture_metadata.to_dict(),
            "capture_metadata_attestation_sha256": self.capture_metadata_attestation_sha256,
            "capture_metadata_sha256": self.capture_metadata_sha256,
            "capture_metadata_trust_snapshot_sha256": self.capture_metadata_trust_snapshot_sha256,
            "capture_policy": self.capture_policy.to_dict(),
            "capture_policy_generation": self.capture_policy_generation,
            "capture_policy_sha256": self.capture_policy_sha256,
            "capture_rights_attestation_sha256": self.capture_rights_attestation_sha256,
            "capture_rights_grant": self.capture_rights_grant.to_canonical_dict(),
            "capture_rights_grant_sha256": self.capture_rights_grant_sha256,
            "capture_rights_trust_snapshot_sha256": self.capture_rights_trust_snapshot_sha256,
            "capture_service_id": self.capture_service_id,
            "clock_mapping": self.clock_mapping.to_dict(),
            "clock_mapping_sha256": self.clock_mapping_sha256,
            "content_status": self.content_status.value,
            "finalized_at_ns": self.finalized_at_ns,
            "finalized_trace_sha256": self.finalized_trace_sha256,
            "integrity_report": self.integrity_report.to_dict(),
            "intended_uses": [item.value for item in self.intended_uses],
            "lineage_id": self.lineage_id,
            "physical_capture_truth_status": self.physical_capture_truth_status.value,
            "reconnect_epoch": self.reconnect_epoch,
            "rights_policy_generation": self.rights_policy_generation,
            "rights_policy_sha256": self.rights_policy_sha256,
            "rights_verified_at_ns": self.rights_verified_at_ns,
            "schema_version": self.schema_version,
            "segment_id": self.segment_id,
            "segment_sequence": self.segment_sequence,
            "service_claim_status": self.service_claim_status.value,
            "session": self.session.to_dict(),
            "window_plan": self.window_plan.to_dict(),
            "window_request": self.window_request.to_dict(),
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_canonical_json(
            self.to_dict(),
            label="finalized capture segment statement",
            maximum_bytes=MAX_CAPTURE_SEGMENT_STATEMENT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "FinalizedCaptureSegmentStatement":
        value = _parse_bounded_canonical_json(
            raw,
            label="finalized capture segment statement",
            maximum_bytes=MAX_CAPTURE_SEGMENT_STATEMENT_BYTES,
        )
        try:
            _require_fields(
                value, set(cls.__dataclass_fields__), label="capture segment statement"
            )
            return cls(
                **{
                    **value,
                    "capture_metadata": StructurallyVerifiedCaptureMetadata.from_json_bytes(
                        _nested_json_bytes(
                            value["capture_metadata"], label="capture_metadata"
                        )
                    ),
                    "session": CaptureSessionDescriptor.from_json_bytes(
                        _nested_json_bytes(value["session"], label="session")
                    ),
                    "clock_mapping": _clock_mapping_from_dict(value["clock_mapping"]),
                    "window_request": EvidenceWindowRequest.from_json_bytes(
                        _nested_json_bytes(
                            value["window_request"], label="window_request"
                        )
                    ),
                    "window_plan": EvidenceWindowPlan.from_json_bytes(
                        _nested_json_bytes(value["window_plan"], label="window_plan")
                    ),
                    "integrity_report": CaptureSegmentIntegrityReport.from_json_bytes(
                        _nested_json_bytes(
                            value["integrity_report"], label="integrity_report"
                        )
                    ),
                    "capture_policy": CaptureAssetTrustPolicy.from_json_bytes(
                        _nested_json_bytes(
                            value["capture_policy"], label="capture_policy"
                        )
                    ),
                    "capture_rights_grant": capture_session_rights_grant_from_json_bytes(
                        _nested_json_bytes(
                            value["capture_rights_grant"], label="capture_rights_grant"
                        )
                    ),
                    "intended_uses": tuple(
                        _enum_from_json(PermittedUse, item, "intended_uses item")
                        for item in _exact_list(
                            value, "intended_uses", label="capture segment statement"
                        )
                    ),
                    "service_claim_status": _enum_from_json(
                        CaptureServiceClaimStatus,
                        value["service_claim_status"],
                        "service_claim_status",
                    ),
                    "physical_capture_truth_status": _enum_from_json(
                        PhysicalCaptureTruthStatus,
                        value["physical_capture_truth_status"],
                        "physical_capture_truth_status",
                    ),
                    "asset_residency_status": _enum_from_json(
                        AssetResidencyStatus,
                        value["asset_residency_status"],
                        "asset_residency_status",
                    ),
                    "content_status": _enum_from_json(
                        CaptureSegmentContentStatus,
                        value["content_status"],
                        "content_status",
                    ),
                    "audio_status": _enum_from_json(
                        CaptureSegmentAudioStatus, value["audio_status"], "audio_status"
                    ),
                    "admissibility_status": _enum_from_json(
                        CaptureSegmentAdmissibilityStatus,
                        value["admissibility_status"],
                        "admissibility_status",
                    ),
                }
            )
        except CaptureSegmentError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_SEGMENT_STATEMENT", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class CaptureSegmentAttestation:
    statement_sha256: str
    key_id: str
    key_role: CaptureSegmentKeyRole
    capture_service_id: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = CAPTURE_SEGMENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SEGMENT_SCHEMA_VERSION:
            raise ValueError("unsupported capture-segment-attestation schema")
        _require_sha256(self.statement_sha256, "statement_sha256")
        for field_name in ("key_id", "capture_service_id", "trust_domain_id"):
            _require_stable_id(getattr(self, field_name), field_name)
        if type(self.key_role) is not CaptureSegmentKeyRole:
            raise ValueError("key_role must be a CaptureSegmentKeyRole")
        if (
            self.key_role
            is not CaptureSegmentKeyRole.CAPTURE_SEGMENT_ATTESTATION_SIGNER
        ):
            raise ValueError("capture segment attestation has the wrong key role")
        _require_exact_int(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(self.signature_base64, "signature_base64", expected_bytes=64)
        _bounded_canonical_json(
            self.to_dict(),
            label="capture segment attestation",
            maximum_bytes=MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES,
        )

    @property
    def signature(self) -> bytes:
        return _canonical_base64(
            self.signature_base64, "signature_base64", expected_bytes=64
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_service_id": self.capture_service_id,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "schema_version": self.schema_version,
            "signature_base64": self.signature_base64,
            "signed_at_ns": self.signed_at_ns,
            "statement_sha256": self.statement_sha256,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_canonical_json(
            self.to_dict(),
            label="capture segment attestation",
            maximum_bytes=MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureSegmentAttestation":
        value = _parse_bounded_canonical_json(
            raw,
            label="capture segment attestation",
            maximum_bytes=MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES,
        )
        try:
            _require_fields(
                value,
                set(cls.__dataclass_fields__),
                label="capture segment attestation",
            )
            return cls(
                **{
                    **value,
                    "key_role": _enum_from_json(
                        CaptureSegmentKeyRole, value["key_role"], "key_role"
                    ),
                }
            )
        except CaptureSegmentError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_SEGMENT_ATTESTATION", str(exc))
            raise AssertionError from exc


@dataclass(frozen=True, slots=True)
class TrustedCaptureSegmentSignerKey:
    key_id: str
    key_role: CaptureSegmentKeyRole
    capture_service_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None

    def __post_init__(self) -> None:
        for field_name in ("key_id", "capture_service_id"):
            _require_stable_id(getattr(self, field_name), field_name)
        if (
            self.key_role
            is not CaptureSegmentKeyRole.CAPTURE_SEGMENT_ATTESTATION_SIGNER
        ):
            raise ValueError("segment signer key has the wrong role")
        _canonical_base64(
            self.public_key_base64, "public_key_base64", expected_bytes=32
        )
        valid_from = _require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = _require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("segment signer validity interval is reversed")
        if self.revoked_at_ns is not None:
            _require_exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            _canonical_base64(
                self.public_key_base64, "public_key_base64", expected_bytes=32
            )
        )

    @property
    def public_key_sha256(self) -> str:
        return _public_key_sha256(self.public_key_base64)

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_service_id": self.capture_service_id,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }


@dataclass(frozen=True, slots=True)
class CurrentCaptureSegment:
    segment_id: str
    segment_sequence: int
    capture_metadata_sha256: str
    statement_sha256: str
    attestation_sha256: str

    def __post_init__(self) -> None:
        _require_stable_id(self.segment_id, "segment_id")
        if _require_exact_int(self.segment_sequence, "segment_sequence") != 0:
            raise ValueError("current genesis segment_sequence must be zero")
        _require_sha256(self.capture_metadata_sha256, "capture_metadata_sha256")
        _require_sha256(self.statement_sha256, "statement_sha256")
        _require_sha256(self.attestation_sha256, "attestation_sha256")

    def to_dict(self) -> dict[str, Any]:
        return {
            "attestation_sha256": self.attestation_sha256,
            "capture_metadata_sha256": self.capture_metadata_sha256,
            "segment_id": self.segment_id,
            "segment_sequence": self.segment_sequence,
            "statement_sha256": self.statement_sha256,
        }


@dataclass(frozen=True, slots=True)
class CaptureSegmentTrustSnapshot:
    snapshot_generation: int
    trust_domain_id: str
    capture_service_id: str
    lineage_id: str
    reconnect_epoch: int
    capture_session_id: str
    session_fingerprint: str
    capture_policy_sha256: str
    capture_policy_generation: int
    keys: tuple[TrustedCaptureSegmentSignerKey, ...]
    current_segment: CurrentCaptureSegment
    revoked_statement_sha256s: tuple[str, ...]
    reserved_nonsegment_public_key_sha256s: tuple[str, ...]
    schema_version: str = CAPTURE_SEGMENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SEGMENT_SCHEMA_VERSION:
            raise ValueError("unsupported capture-segment-trust-snapshot schema")
        _require_exact_int(self.snapshot_generation, "snapshot_generation")
        for field_name in (
            "trust_domain_id",
            "capture_service_id",
            "lineage_id",
            "capture_session_id",
        ):
            _require_stable_id(getattr(self, field_name), field_name)
        if _require_exact_int(self.reconnect_epoch, "reconnect_epoch") != 0:
            raise ValueError("schema 1 supports only the initial reconnect epoch")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_sha256(self.capture_policy_sha256, "capture_policy_sha256")
        _require_exact_int(self.capture_policy_generation, "capture_policy_generation")
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_CAPTURE_SEGMENT_SIGNER_KEYS
            or any(
                type(item) is not TrustedCaptureSegmentSignerKey for item in self.keys
            )
        ):
            raise ValueError("keys must be a bounded immutable segment-key tuple")
        if self.keys != tuple(sorted(self.keys, key=lambda item: item.key_id)):
            raise ValueError("keys must be sorted by key_id")
        if len({item.key_id for item in self.keys}) != len(self.keys):
            raise ValueError("segment signer key IDs cannot repeat")
        if len({item.public_key_base64 for item in self.keys}) != len(self.keys):
            raise ValueError("one public key cannot have multiple segment identities")
        if any(
            item.capture_service_id != self.capture_service_id for item in self.keys
        ):
            raise ValueError("every segment signer key must bind the snapshot service")
        if type(self.current_segment) is not CurrentCaptureSegment:
            raise ValueError("current_segment must be one exact genesis entry")
        _require_canonical_tuple(
            self.revoked_statement_sha256s,
            "revoked_statement_sha256s",
            minimum=0,
            maximum=MAX_REVOKED_CAPTURE_SEGMENTS,
            validator=_require_sha256,
        )
        if self.current_segment.statement_sha256 in self.revoked_statement_sha256s:
            raise ValueError("the current genesis statement cannot be revoked")
        _require_canonical_tuple(
            self.reserved_nonsegment_public_key_sha256s,
            "reserved_nonsegment_public_key_sha256s",
            minimum=1,
            maximum=MAX_RESERVED_NONSEGMENT_KEYS,
            validator=_require_sha256,
        )
        if {item.public_key_sha256 for item in self.keys} & set(
            self.reserved_nonsegment_public_key_sha256s
        ):
            raise ValueError(
                "capture segment keys cannot overlap reserved nonsegment keys"
            )
        _bounded_canonical_json(
            self.to_dict(),
            label="capture segment trust snapshot",
            maximum_bytes=MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_policy_generation": self.capture_policy_generation,
            "capture_policy_sha256": self.capture_policy_sha256,
            "capture_service_id": self.capture_service_id,
            "capture_session_id": self.capture_session_id,
            "current_segment": self.current_segment.to_dict(),
            "keys": [item.to_dict() for item in self.keys],
            "lineage_id": self.lineage_id,
            "reconnect_epoch": self.reconnect_epoch,
            "reserved_nonsegment_public_key_sha256s": list(
                self.reserved_nonsegment_public_key_sha256s
            ),
            "revoked_statement_sha256s": list(self.revoked_statement_sha256s),
            "schema_version": self.schema_version,
            "session_fingerprint": self.session_fingerprint,
            "snapshot_generation": self.snapshot_generation,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return _bounded_canonical_json(
            self.to_dict(),
            label="capture segment trust snapshot",
            maximum_bytes=MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureSegmentTrustSnapshot":
        value = _parse_bounded_canonical_json(
            raw,
            label="capture segment trust snapshot",
            maximum_bytes=MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES,
        )
        try:
            _require_fields(
                value,
                set(cls.__dataclass_fields__),
                label="capture segment trust snapshot",
            )
            raw_keys = _exact_list(
                value, "keys", label="capture segment trust snapshot"
            )
            if len(raw_keys) > MAX_CAPTURE_SEGMENT_SIGNER_KEYS:
                raise ValueError("capture segment trust snapshot has too many keys")
            keys = tuple(
                TrustedCaptureSegmentSignerKey(
                    **{
                        **_require_fields(
                            item,
                            set(TrustedCaptureSegmentSignerKey.__dataclass_fields__),
                            label=f"keys[{index}]",
                        ),
                        "key_role": _enum_from_json(
                            CaptureSegmentKeyRole,
                            item["key_role"],
                            f"keys[{index}].key_role",
                        ),
                    }
                )
                for index, item in enumerate(raw_keys)
            )
            current = CurrentCaptureSegment(
                **_require_fields(
                    value["current_segment"],
                    set(CurrentCaptureSegment.__dataclass_fields__),
                    label="current_segment",
                )
            )
            return cls(
                **{
                    **value,
                    "keys": keys,
                    "current_segment": current,
                    "revoked_statement_sha256s": tuple(
                        _exact_list(
                            value,
                            "revoked_statement_sha256s",
                            label="capture segment trust snapshot",
                        )
                    ),
                    "reserved_nonsegment_public_key_sha256s": tuple(
                        _exact_list(
                            value,
                            "reserved_nonsegment_public_key_sha256s",
                            label="capture segment trust snapshot",
                        )
                    ),
                }
            )
        except CaptureSegmentError:
            raise
        except (TypeError, ValueError) as exc:
            _fail("INVALID_CAPTURE_SEGMENT_TRUST_SNAPSHOT", str(exc))
            raise AssertionError from exc


class VerifiedCaptureSegmentEvidence(Protocol):
    """Read-only receipt shape; membership is never an authority decision."""

    @property
    def statement_sha256(self) -> str: ...

    @property
    def attestation_sha256(self) -> str: ...

    @property
    def trust_snapshot_sha256(self) -> str: ...

    @property
    def trust_snapshot_generation(self) -> int: ...

    @property
    def verified_at_ns(self) -> int: ...

    @property
    def segment_id(self) -> str: ...

    @property
    def segment_sequence(self) -> int: ...

    @property
    def capture_service_id(self) -> str: ...

    @property
    def lineage_id(self) -> str: ...

    @property
    def service_claim_status(self) -> CaptureServiceClaimStatus: ...

    @property
    def physical_capture_truth_status(self) -> PhysicalCaptureTruthStatus: ...

    @property
    def asset_residency_status(self) -> AssetResidencyStatus: ...

    @property
    def content_status(self) -> CaptureSegmentContentStatus: ...

    @property
    def audio_status(self) -> CaptureSegmentAudioStatus: ...

    @property
    def admissibility_status(self) -> CaptureSegmentAdmissibilityStatus: ...

    @property
    def admissible_for_live_scorecheck_presentation(self) -> bool: ...

    @property
    def admissible_for_training(self) -> bool: ...

    @property
    def admissible_for_evaluation(self) -> bool: ...

    @property
    def admissible_for_deployment(self) -> bool: ...


class _VerifiedCaptureSegmentEvidence:
    """Private immutable implementation returned only after full verification."""

    __slots__ = (
        "_statement_sha256",
        "_attestation_sha256",
        "_trust_snapshot_sha256",
        "_trust_snapshot_generation",
        "_verified_at_ns",
        "_segment_id",
        "_capture_service_id",
        "_lineage_id",
        "_sealed",
    )

    def __init__(
        self,
        *,
        statement_sha256: str,
        attestation_sha256: str,
        trust_snapshot_sha256: str,
        trust_snapshot_generation: int,
        verified_at_ns: int,
        segment_id: str,
        capture_service_id: str,
        lineage_id: str,
    ) -> None:
        for field_name, value in (
            ("statement_sha256", statement_sha256),
            ("attestation_sha256", attestation_sha256),
            ("trust_snapshot_sha256", trust_snapshot_sha256),
        ):
            _require_sha256(value, field_name)
        _require_exact_int(trust_snapshot_generation, "trust_snapshot_generation")
        _require_exact_int(verified_at_ns, "verified_at_ns")
        for field_name, value in (
            ("segment_id", segment_id),
            ("capture_service_id", capture_service_id),
            ("lineage_id", lineage_id),
        ):
            _require_stable_id(value, field_name)
        object.__setattr__(self, "_statement_sha256", statement_sha256)
        object.__setattr__(self, "_attestation_sha256", attestation_sha256)
        object.__setattr__(self, "_trust_snapshot_sha256", trust_snapshot_sha256)
        object.__setattr__(
            self, "_trust_snapshot_generation", trust_snapshot_generation
        )
        object.__setattr__(self, "_verified_at_ns", verified_at_ns)
        object.__setattr__(self, "_segment_id", segment_id)
        object.__setattr__(self, "_capture_service_id", capture_service_id)
        object.__setattr__(self, "_lineage_id", lineage_id)
        object.__setattr__(self, "_sealed", True)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("verified capture segment receipts are immutable")

    @property
    def statement_sha256(self) -> str:
        return self._statement_sha256

    @property
    def attestation_sha256(self) -> str:
        return self._attestation_sha256

    @property
    def trust_snapshot_sha256(self) -> str:
        return self._trust_snapshot_sha256

    @property
    def trust_snapshot_generation(self) -> int:
        return self._trust_snapshot_generation

    @property
    def verified_at_ns(self) -> int:
        return self._verified_at_ns

    @property
    def segment_id(self) -> str:
        return self._segment_id

    @property
    def segment_sequence(self) -> int:
        return 0

    @property
    def capture_service_id(self) -> str:
        return self._capture_service_id

    @property
    def lineage_id(self) -> str:
        return self._lineage_id

    @property
    def service_claim_status(self) -> CaptureServiceClaimStatus:
        return _FIXED_SERVICE_STATUS

    @property
    def physical_capture_truth_status(self) -> PhysicalCaptureTruthStatus:
        return _FIXED_PHYSICAL_STATUS

    @property
    def asset_residency_status(self) -> AssetResidencyStatus:
        return AssetResidencyStatus.NOT_VERIFIED

    @property
    def content_status(self) -> CaptureSegmentContentStatus:
        return _FIXED_CONTENT_STATUS

    @property
    def audio_status(self) -> CaptureSegmentAudioStatus:
        return _FIXED_AUDIO_STATUS

    @property
    def admissibility_status(self) -> CaptureSegmentAdmissibilityStatus:
        return _FIXED_ADMISSIBILITY

    @property
    def admissible_for_live_scorecheck_presentation(self) -> bool:
        return False

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False


def capture_segment_signing_message(
    statement: FinalizedCaptureSegmentStatement,
    *,
    key_id: str,
    key_role: CaptureSegmentKeyRole,
    trust_domain_id: str,
    signed_at_ns: int,
) -> bytes:
    """Return the only domain-separated bytes a segment key may sign."""

    if type(statement) is not FinalizedCaptureSegmentStatement:
        raise ValueError("statement must be a FinalizedCaptureSegmentStatement")
    _require_stable_id(key_id, "key_id")
    if key_role is not CaptureSegmentKeyRole.CAPTURE_SEGMENT_ATTESTATION_SIGNER:
        raise ValueError("key_role must be CAPTURE_SEGMENT_ATTESTATION_SIGNER")
    _require_stable_id(trust_domain_id, "trust_domain_id")
    _require_exact_int(signed_at_ns, "signed_at_ns")
    return _bounded_canonical_json(
        {
            "domain": CAPTURE_SEGMENT_SIGNING_DOMAIN,
            "key_id": key_id,
            "key_role": key_role.value,
            "signed_at_ns": signed_at_ns,
            "statement": statement.to_dict(),
            "trust_domain_id": trust_domain_id,
        },
        label="capture segment signing message",
        maximum_bytes=MAX_CAPTURE_SEGMENT_STATEMENT_BYTES
        + MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES,
    )


def _verify_evidence_inputs(
    *,
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    capture_metadata_attestation: FinalizedCaptureMetadataAttestation,
    capture_metadata_trust_snapshot: FinalizedCaptureMetadataTrustSnapshot,
    session: CaptureSessionDescriptor,
    clock_mapping: ClockMappingCandidate,
    records: tuple[CaptureTraceRecord, ...],
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
    window_request: EvidenceWindowRequest,
    fragment_projection: tuple[CaptureFragmentDescriptor, ...],
    capture_policy: CaptureAssetTrustPolicy,
    capture_rights_grant: CaptureSessionRightsGrant,
    capture_rights_attestation: CaptureSessionRightsGrantAttestation,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_capture_metadata_trust_snapshot_sha256: str,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    expected_rights_policy_sha256: str,
    expected_rights_policy_generation: int,
    verified_at_ns: int,
) -> tuple[EvidenceWindowPlan, CaptureSegmentIntegrityReport, str]:
    verified_at = _require_exact_int(verified_at_ns, "verified_at_ns")
    verify_capture_asset_policy_pin(
        capture_policy,
        expected_policy_sha256=expected_capture_policy_sha256,
        expected_policy_generation=expected_capture_policy_generation,
        verified_at_ns=verified_at,
    )
    verify_capture_metadata_policy_binding(capture_metadata, capture_policy)
    verify_finalized_capture_metadata_attestation(
        capture_metadata,
        capture_metadata_attestation,
        capture_metadata_trust_snapshot,
        capture_rights_trust_snapshot=capture_rights_trust_snapshot,
        expected_capture_rights_trust_snapshot_sha256=expected_capture_rights_trust_snapshot_sha256,
        expected_trust_snapshot_sha256=expected_capture_metadata_trust_snapshot_sha256,
        expected_capture_policy_sha256=expected_capture_policy_sha256,
        expected_capture_policy_generation=expected_capture_policy_generation,
        verified_at_ns=verified_at,
    )
    rights = verify_capture_session_rights(
        capture_rights_grant,
        capture_rights_attestation,
        capture_rights_trust_snapshot,
        verified_at_ns=verified_at,
        geography=capture_metadata.geography,
        match_id=capture_metadata.match_id,
        capture_session_id=capture_metadata.capture_session_id,
        venue_id=capture_metadata.venue_id,
        camera_ids=capture_metadata.camera_ids,
        roster_scope_sha256=capture_metadata.roster_scope_sha256,
        participant_ids=capture_metadata.participant_ids,
        required_uses=CAPTURE_OPERATION_REQUIRED_USES,
        expected_trust_snapshot_sha256=expected_capture_rights_trust_snapshot_sha256,
        expected_protected_policy_fingerprint=expected_rights_policy_sha256,
        expected_protected_policy_generation=expected_rights_policy_generation,
    )
    if (
        capture_metadata.capture_rights_grant_sha256 != rights.grant_sha256
        or capture_metadata.capture_rights_attestation_sha256
        != rights.attestation_sha256
        or capture_metadata.capture_rights_trust_snapshot_sha256
        != rights.trust_snapshot_sha256
    ):
        _fail(
            "CAPTURE_SEGMENT_RIGHTS_BINDING",
            "current rights evidence differs from capture metadata",
        )
    if (
        type(session) is not CaptureSessionDescriptor
        or session.fingerprint() != capture_metadata.session_fingerprint
    ):
        _fail("CAPTURE_SEGMENT_SESSION", "session differs from capture metadata")
    if (
        session.source_kind is not CaptureSourceKind.LIVE_CAMERA
        or session.trust_domain is not CaptureTrustDomain.PRODUCTION_CAPTURE
        or session.configuration_fingerprint
        != capture_metadata.session_configuration_fingerprint
        or session.session_id != capture_metadata.capture_session_id
        or session.match_id != capture_metadata.match_id
        or session.stream_id != capture_metadata.stream_id
    ):
        _fail("CAPTURE_SEGMENT_SESSION", "session scope or configuration differs")
    if (
        type(clock_mapping) is not ClockMappingCandidate
        or clock_mapping.fingerprint() != capture_metadata.clock_mapping_fingerprint
    ):
        _fail("CAPTURE_SEGMENT_CLOCK", "clock mapping differs from capture metadata")
    if (
        clock_mapping.claimed_max_absolute_error_ns
        > capture_policy.max_clock_absolute_error_ns
    ):
        _fail(
            "CAPTURE_SEGMENT_CLOCK_ERROR",
            "clock claim exceeds protected policy ceiling",
        )
    if (
        type(window_request) is not EvidenceWindowRequest
        or window_request.fingerprint() != capture_metadata.window_request_fingerprint
    ):
        _fail(
            "CAPTURE_SEGMENT_WINDOW_REQUEST",
            "window request differs from capture metadata",
        )
    if (
        type(fragment_projection) is not tuple
        or not 1 <= len(fragment_projection) <= MAX_CLOSED_FRAGMENTS
    ):
        _fail(
            "CAPTURE_SEGMENT_FRAGMENTS",
            "fragment projection has the wrong bound or type",
        )
    if any(type(item) is not CaptureFragmentDescriptor for item in fragment_projection):
        _fail("CAPTURE_SEGMENT_FRAGMENTS", "fragment projection contains a wrong type")
    plan = plan_evidence_window(window_request, fragment_projection)
    if (
        plan.status is not EvidenceWindowStatus.PLANNED
        or plan.fingerprint() != capture_metadata.window_plan_fingerprint
    ):
        _fail(
            "CAPTURE_SEGMENT_WINDOW_PLAN",
            "recomputed window plan differs from capture metadata",
        )
    projection_by_id = {item.fragment_id: item for item in fragment_projection}
    try:
        selected = tuple(projection_by_id[item] for item in plan.selected_fragment_ids)
    except KeyError as exc:
        _fail("CAPTURE_SEGMENT_FRAGMENT_MISSING", "selected fragment is absent")
        raise AssertionError from exc
    if (
        tuple(item.fingerprint() for item in selected)
        != plan.selected_fragment_fingerprints
    ):
        _fail(
            "CAPTURE_SEGMENT_FRAGMENT_SUBSTITUTION",
            "selected fragment fingerprint differs",
        )
    if type(records) is not tuple or type(finalized_trace) is not tuple:
        _fail(
            "CAPTURE_SEGMENT_TRACE_TYPE",
            "records and finalized_trace must be immutable tuples",
        )
    if any(type(item) is not FinalizedSourceFrameSignal for item in finalized_trace):
        _fail("CAPTURE_SEGMENT_TRACE_TYPE", "finalized trace contains a wrong type")
    try:
        report = evaluate_capture_trace(
            session, clock_mapping, records, finalized_trace
        )
    except ValueError as exc:
        _fail("CAPTURE_SEGMENT_TRACE_INVALID", str(exc))
        raise AssertionError from exc
    trace_sha256 = finalized_trace_fingerprint(finalized_trace)
    if (
        report.disposition is not IntegrityDisposition.OBSERVED_CLEAN
        or not report.finalized_trace_structurally_valid
        or not report.structurally_eligible_for_trust_verification
        or not report.video_only
        or report.fingerprint() != capture_metadata.integrity_report_sha256
        or report.window_fingerprint != capture_metadata.integrity_window_sha256
        or trace_sha256 != capture_metadata.finalized_trace_sha256
        or report.finalized_frame_count != capture_metadata.frame_count
    ):
        _fail(
            "CAPTURE_SEGMENT_INTEGRITY",
            "recomputed trace/report is not the exact clean metadata binding",
        )
    return plan, report, trace_sha256


def build_finalized_capture_segment_statement(
    *,
    segment_id: str,
    lineage_id: str,
    capture_service_id: str,
    finalized_at_ns: int,
    rights_verified_at_ns: int,
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    capture_metadata_attestation: FinalizedCaptureMetadataAttestation,
    capture_metadata_trust_snapshot: FinalizedCaptureMetadataTrustSnapshot,
    session: CaptureSessionDescriptor,
    clock_mapping: ClockMappingCandidate,
    records: tuple[CaptureTraceRecord, ...],
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
    window_request: EvidenceWindowRequest,
    fragment_projection: tuple[CaptureFragmentDescriptor, ...],
    capture_policy: CaptureAssetTrustPolicy,
    capture_rights_grant: CaptureSessionRightsGrant,
    capture_rights_attestation: CaptureSessionRightsGrantAttestation,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_capture_metadata_trust_snapshot_sha256: str,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    expected_rights_policy_sha256: str,
    expected_rights_policy_generation: int,
) -> FinalizedCaptureSegmentStatement:
    """Recompute all pure bindings and construct the unsigned service statement."""

    plan, report, trace_sha256 = _verify_evidence_inputs(
        capture_metadata=capture_metadata,
        capture_metadata_attestation=capture_metadata_attestation,
        capture_metadata_trust_snapshot=capture_metadata_trust_snapshot,
        session=session,
        clock_mapping=clock_mapping,
        records=records,
        finalized_trace=finalized_trace,
        window_request=window_request,
        fragment_projection=fragment_projection,
        capture_policy=capture_policy,
        capture_rights_grant=capture_rights_grant,
        capture_rights_attestation=capture_rights_attestation,
        capture_rights_trust_snapshot=capture_rights_trust_snapshot,
        expected_capture_metadata_trust_snapshot_sha256=expected_capture_metadata_trust_snapshot_sha256,
        expected_capture_rights_trust_snapshot_sha256=expected_capture_rights_trust_snapshot_sha256,
        expected_capture_policy_sha256=expected_capture_policy_sha256,
        expected_capture_policy_generation=expected_capture_policy_generation,
        expected_rights_policy_sha256=expected_rights_policy_sha256,
        expected_rights_policy_generation=expected_rights_policy_generation,
        verified_at_ns=rights_verified_at_ns,
    )
    return FinalizedCaptureSegmentStatement(
        segment_id=segment_id,
        lineage_id=lineage_id,
        capture_service_id=capture_service_id,
        reconnect_epoch=capture_metadata.reconnect_epoch,
        segment_sequence=0,
        finalized_at_ns=finalized_at_ns,
        rights_verified_at_ns=rights_verified_at_ns,
        capture_metadata=capture_metadata,
        capture_metadata_sha256=capture_metadata.fingerprint(),
        capture_metadata_attestation_sha256=capture_metadata_attestation.fingerprint(),
        capture_metadata_trust_snapshot_sha256=capture_metadata_trust_snapshot.fingerprint(),
        session=session,
        clock_mapping=clock_mapping,
        clock_mapping_sha256=clock_mapping.fingerprint(),
        window_request=window_request,
        window_plan=plan,
        finalized_trace_sha256=trace_sha256,
        integrity_report=report,
        capture_policy=capture_policy,
        capture_policy_sha256=capture_policy.fingerprint(),
        capture_policy_generation=capture_policy.policy_generation,
        capture_rights_grant=capture_rights_grant,
        capture_rights_grant_sha256=capture_rights_grant.fingerprint(),
        capture_rights_attestation_sha256=capture_rights_attestation.fingerprint(),
        capture_rights_trust_snapshot_sha256=capture_rights_trust_snapshot.fingerprint(),
        rights_policy_sha256=expected_rights_policy_sha256,
        rights_policy_generation=expected_rights_policy_generation,
        intended_uses=CAPTURE_OPERATION_REQUIRED_USES,
    )


def verify_capture_segment_attestation(
    statement: FinalizedCaptureSegmentStatement,
    attestation: CaptureSegmentAttestation,
    trust_snapshot: CaptureSegmentTrustSnapshot,
    *,
    capture_metadata: StructurallyVerifiedCaptureMetadata,
    capture_metadata_attestation: FinalizedCaptureMetadataAttestation,
    capture_metadata_trust_snapshot: FinalizedCaptureMetadataTrustSnapshot,
    session: CaptureSessionDescriptor,
    clock_mapping: ClockMappingCandidate,
    records: tuple[CaptureTraceRecord, ...],
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
    window_request: EvidenceWindowRequest,
    fragment_projection: tuple[CaptureFragmentDescriptor, ...],
    capture_policy: CaptureAssetTrustPolicy,
    capture_rights_grant: CaptureSessionRightsGrant,
    capture_rights_attestation: CaptureSessionRightsGrantAttestation,
    capture_rights_trust_snapshot: CaptureRightsTrustSnapshot,
    expected_trust_snapshot_sha256: str,
    expected_trust_snapshot_generation: int,
    expected_capture_service_id: str,
    expected_lineage_id: str,
    expected_current_attestation_sha256: str,
    expected_capture_metadata_trust_snapshot_sha256: str,
    expected_capture_rights_trust_snapshot_sha256: str,
    expected_capture_policy_sha256: str,
    expected_capture_policy_generation: int,
    expected_rights_policy_sha256: str,
    expected_rights_policy_generation: int,
    verified_at_ns: int,
) -> VerifiedCaptureSegmentEvidence:
    """Verify current service assertions and return an always-inadmissible receipt."""

    if type(statement) is not FinalizedCaptureSegmentStatement:
        _fail("CAPTURE_SEGMENT_STATEMENT_TYPE", "statement has the wrong exact type")
    if type(attestation) is not CaptureSegmentAttestation:
        _fail(
            "CAPTURE_SEGMENT_ATTESTATION_TYPE", "attestation has the wrong exact type"
        )
    if type(trust_snapshot) is not CaptureSegmentTrustSnapshot:
        _fail("CAPTURE_SEGMENT_TRUST_TYPE", "trust snapshot has the wrong exact type")
    verified_at = _require_exact_int(verified_at_ns, "verified_at_ns")
    _require_sha256(expected_trust_snapshot_sha256, "expected_trust_snapshot_sha256")
    _require_exact_int(
        expected_trust_snapshot_generation, "expected_trust_snapshot_generation"
    )
    _require_stable_id(expected_capture_service_id, "expected_capture_service_id")
    _require_stable_id(expected_lineage_id, "expected_lineage_id")
    _require_sha256(
        expected_current_attestation_sha256,
        "expected_current_attestation_sha256",
    )
    if trust_snapshot.fingerprint() != expected_trust_snapshot_sha256:
        _fail(
            "CAPTURE_SEGMENT_TRUST_PIN",
            "segment trust snapshot differs from protected pin",
        )
    if trust_snapshot.snapshot_generation != expected_trust_snapshot_generation:
        _fail(
            "CAPTURE_SEGMENT_TRUST_GENERATION",
            "segment trust generation differs from protected pin",
        )
    if (
        trust_snapshot.capture_service_id != expected_capture_service_id
        or trust_snapshot.lineage_id != expected_lineage_id
        or statement.capture_service_id != expected_capture_service_id
        or statement.lineage_id != expected_lineage_id
        or attestation.capture_service_id != expected_capture_service_id
    ):
        _fail(
            "CAPTURE_SEGMENT_SCOPE", "service or lineage differs from protected scope"
        )
    if (
        trust_snapshot.capture_session_id
        != statement.capture_metadata.capture_session_id
        or trust_snapshot.session_fingerprint != statement.session.fingerprint()
        or trust_snapshot.reconnect_epoch != statement.reconnect_epoch
        or trust_snapshot.capture_policy_sha256 != expected_capture_policy_sha256
        or trust_snapshot.capture_policy_generation
        != expected_capture_policy_generation
    ):
        _fail("CAPTURE_SEGMENT_SCOPE", "snapshot session, epoch, or policy differs")
    current = trust_snapshot.current_segment
    if current.attestation_sha256 != expected_current_attestation_sha256:
        _fail(
            "CAPTURE_SEGMENT_CURRENT_PIN",
            "current genesis attestation differs from the protected pin",
        )
    if (
        statement.segment_sequence != 0
        or statement.segment_id != current.segment_id
        or statement.capture_metadata_sha256 != current.capture_metadata_sha256
        or statement.fingerprint() != current.statement_sha256
        or attestation.fingerprint() != current.attestation_sha256
    ):
        _fail(
            "CAPTURE_SEGMENT_NOT_CURRENT",
            "statement and attestation are not the one current exact genesis",
        )
    if attestation.statement_sha256 != statement.fingerprint():
        _fail(
            "CAPTURE_SEGMENT_ATTESTATION_MISMATCH",
            "attestation does not name the exact statement",
        )
    if attestation.trust_domain_id != trust_snapshot.trust_domain_id:
        _fail("CAPTURE_SEGMENT_TRUST_DOMAIN", "attestation trust domain differs")
    if (
        not statement.finalized_at_ns
        <= statement.rights_verified_at_ns
        <= attestation.signed_at_ns
        <= verified_at
    ):
        _fail(
            "CAPTURE_SEGMENT_TIME",
            "finalize, evidence verification, signing, or trusted time is reversed",
        )
    metadata_key_hashes = {
        _public_key_sha256(item.public_key_base64)
        for item in capture_metadata_trust_snapshot.keys
    }
    rights_key_hashes = {
        _public_key_sha256(item.public_key_base64)
        for item in capture_rights_trust_snapshot.keys
    }
    reserved = set(trust_snapshot.reserved_nonsegment_public_key_sha256s)
    if not metadata_key_hashes | rights_key_hashes <= reserved:
        _fail(
            "CAPTURE_SEGMENT_RESERVED_KEYS",
            "metadata and rights keys are not protected as nonsegment roles",
        )
    segment_key_hashes = {item.public_key_sha256 for item in trust_snapshot.keys}
    if segment_key_hashes & (metadata_key_hashes | rights_key_hashes | reserved):
        _fail(
            "CAPTURE_SEGMENT_KEY_DOMAIN_OVERLAP",
            "segment key overlaps another trust role",
        )
    key = next(
        (item for item in trust_snapshot.keys if item.key_id == attestation.key_id),
        None,
    )
    if key is None:
        _fail("CAPTURE_SEGMENT_KEY_UNTRUSTED", "segment signer key is untrusted")
    if (
        key.key_role is not attestation.key_role
        or key.capture_service_id != attestation.capture_service_id
    ):
        _fail("CAPTURE_SEGMENT_KEY_ROLE", "trusted key role or service differs")
    if not key.valid_from_ns <= attestation.signed_at_ns <= key.valid_until_ns:
        _fail("CAPTURE_SEGMENT_KEY_DATE", "segment signer key was not valid at signing")
    if key.revoked_at_ns is not None and verified_at >= key.revoked_at_ns:
        _fail("CAPTURE_SEGMENT_KEY_REVOKED", "segment signer key is revoked")
    try:
        key.public_key.verify(
            attestation.signature,
            capture_segment_signing_message(
                statement,
                key_id=attestation.key_id,
                key_role=attestation.key_role,
                trust_domain_id=attestation.trust_domain_id,
                signed_at_ns=attestation.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        _fail("CAPTURE_SEGMENT_SIGNATURE", "segment signature is invalid")
        raise AssertionError from exc
    if (
        capture_metadata != statement.capture_metadata
        or capture_metadata_attestation.fingerprint()
        != statement.capture_metadata_attestation_sha256
        or capture_metadata_trust_snapshot.fingerprint()
        != statement.capture_metadata_trust_snapshot_sha256
        or session != statement.session
        or clock_mapping != statement.clock_mapping
        or window_request != statement.window_request
        or capture_policy != statement.capture_policy
        or capture_rights_grant != statement.capture_rights_grant
        or capture_rights_attestation.fingerprint()
        != statement.capture_rights_attestation_sha256
        or capture_rights_trust_snapshot.fingerprint()
        != statement.capture_rights_trust_snapshot_sha256
    ):
        _fail(
            "CAPTURE_SEGMENT_EVIDENCE_SUBSTITUTION",
            "supplied evidence differs from the signed statement",
        )
    plan, report, trace_sha256 = _verify_evidence_inputs(
        capture_metadata=capture_metadata,
        capture_metadata_attestation=capture_metadata_attestation,
        capture_metadata_trust_snapshot=capture_metadata_trust_snapshot,
        session=session,
        clock_mapping=clock_mapping,
        records=records,
        finalized_trace=finalized_trace,
        window_request=window_request,
        fragment_projection=fragment_projection,
        capture_policy=capture_policy,
        capture_rights_grant=capture_rights_grant,
        capture_rights_attestation=capture_rights_attestation,
        capture_rights_trust_snapshot=capture_rights_trust_snapshot,
        expected_capture_metadata_trust_snapshot_sha256=expected_capture_metadata_trust_snapshot_sha256,
        expected_capture_rights_trust_snapshot_sha256=expected_capture_rights_trust_snapshot_sha256,
        expected_capture_policy_sha256=expected_capture_policy_sha256,
        expected_capture_policy_generation=expected_capture_policy_generation,
        expected_rights_policy_sha256=expected_rights_policy_sha256,
        expected_rights_policy_generation=expected_rights_policy_generation,
        verified_at_ns=verified_at,
    )
    if (
        plan != statement.window_plan
        or report != statement.integrity_report
        or trace_sha256 != statement.finalized_trace_sha256
    ):
        _fail(
            "CAPTURE_SEGMENT_RECOMPUTATION",
            "recomputed plan, report, or trace differs from statement",
        )
    return _VerifiedCaptureSegmentEvidence(
        statement_sha256=statement.fingerprint(),
        attestation_sha256=attestation.fingerprint(),
        trust_snapshot_sha256=trust_snapshot.fingerprint(),
        trust_snapshot_generation=trust_snapshot.snapshot_generation,
        verified_at_ns=verified_at,
        segment_id=statement.segment_id,
        capture_service_id=statement.capture_service_id,
        lineage_id=statement.lineage_id,
    )


__all__ = [
    "CAPTURE_SEGMENT_SCHEMA_VERSION",
    "CAPTURE_SEGMENT_SIGNING_DOMAIN",
    "MAX_CAPTURE_SEGMENT_ATTESTATION_BYTES",
    "MAX_CAPTURE_SEGMENT_STATEMENT_BYTES",
    "MAX_CAPTURE_SEGMENT_TRUST_SNAPSHOT_BYTES",
    "CaptureSegmentAdmissibilityStatus",
    "CaptureSegmentAttestation",
    "CaptureSegmentAudioStatus",
    "CaptureSegmentContentStatus",
    "CaptureSegmentError",
    "CaptureSegmentKeyRole",
    "CaptureSegmentTrustSnapshot",
    "CaptureServiceClaimStatus",
    "CurrentCaptureSegment",
    "FinalizedCaptureSegmentStatement",
    "PhysicalCaptureTruthStatus",
    "TrustedCaptureSegmentSignerKey",
    "VerifiedCaptureSegmentEvidence",
    "build_finalized_capture_segment_statement",
    "capture_segment_signing_message",
    "verify_capture_segment_attestation",
]
