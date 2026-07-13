"""Authenticated current trust boundary for protected decoded measurements.

The signing coordinator owns both operations that matter: it freshly verifies
the upstream capture segment under independently pinned current trust and it
runs the protected decoder replay itself.  It never accepts a public replay or
receipt for promotion.  The public verifier checks signature, currentness,
revocation, and independent pins, then repeats both upstream verification and
decode before returning no evidence capability. Exact rows remain internal and
are discarded before the public boundary.

Successful authentication proves only the named verifier's exact replay claim
for the named immutable bytes, runtime, recipe, and externally pinned container
stream mapping.  It does not prove physical capture truth, logical-stream
content equivalence, match completeness, scoring correctness, or any product
admission.  Every authority property remains false.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from .capture_measurement_binding import (
    SelectedVideoStreamBindingV1,
    _TransientCaptureMeasurementBindingV1,
    _replay_and_bind_capture_measurement_v1,
)
from .capture_measurement_contracts import DecodedCaptureMeasurementReceiptV1
from .capture_measurement_rows import DecodedMeasurementRecipeV1
from .capture_segment import (
    CaptureSegmentAttestation,
    CaptureSegmentTrustSnapshot,
    FinalizedCaptureSegmentStatement,
    _VerifiedCaptureSegmentEvidence,
    verify_capture_segment_attestation,
)
from .contract_wire import (
    MAX_SIGNED_64,
    canonical_base64,
    canonical_json_bytes,
    enum_from_json,
    exact_list,
    parse_canonical_json_object,
    require_canonical_tuple,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)
from .immutable_store import generation_id_for


DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION = "1.0"
AUTHENTICATED_DECODED_CAPTURE_MEASUREMENT_STATEMENT_DOMAIN = (
    "multicourt-vision-scoring:authenticated-decoded-capture-measurement-statement:v1"
)
DECODED_CAPTURE_MEASUREMENT_SIGNING_DOMAIN = (
    "multicourt-vision-scoring:decoded-capture-measurement-attestation-signing:v1"
)
DECODED_CAPTURE_MEASUREMENT_ATTESTATION_DOMAIN = (
    "multicourt-vision-scoring:decoded-capture-measurement-attestation:v1"
)
DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_DOMAIN = (
    "multicourt-vision-scoring:decoded-capture-measurement-trust-snapshot:v1"
)
DECODED_CAPTURE_MEASUREMENT_POLICY_DOMAIN = (
    "multicourt-vision-scoring:decoded-capture-measurement-policy:v1"
)
MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES = 256 * 1024
MAX_DECODED_CAPTURE_MEASUREMENT_ATTESTATION_BYTES = 16 * 1024
MAX_DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_BYTES = 512 * 1024
MAX_DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_JSON_NODES = 8_192
MAX_DECODED_CAPTURE_MEASUREMENT_SIGNER_KEYS = 32
MAX_CURRENT_DECODED_CAPTURE_MEASUREMENTS = 256
MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS = 512
MAX_RESERVED_NONMEASUREMENT_KEYS = 256

_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)

_CAPTURE_VERIFY_ARGUMENT_KEYS = frozenset(
    {
        "capture_metadata",
        "capture_metadata_attestation",
        "capture_metadata_trust_snapshot",
        "session",
        "clock_mapping",
        "records",
        "finalized_trace",
        "window_request",
        "fragment_projection",
        "capture_policy",
        "capture_rights_grant",
        "capture_rights_attestation",
        "capture_rights_trust_snapshot",
        "expected_trust_snapshot_sha256",
        "expected_trust_snapshot_generation",
        "expected_capture_service_id",
        "expected_lineage_id",
        "expected_current_attestation_sha256",
        "expected_capture_metadata_trust_snapshot_sha256",
        "expected_capture_rights_trust_snapshot_sha256",
        "expected_capture_policy_sha256",
        "expected_capture_policy_generation",
        "expected_rights_policy_sha256",
        "expected_rights_policy_generation",
        "verified_at_ns",
    }
)


class DecodedCaptureMeasurementTrustError(ValueError):
    """Fail-closed authenticated measurement failure with a finite code."""

    _CODES = frozenset(
        {
            "MEASUREMENT_TRUST_INPUT",
            "MEASUREMENT_TRUST_CAPTURE",
            "MEASUREMENT_TRUST_REPLAY",
            "MEASUREMENT_TRUST_STATEMENT",
            "MEASUREMENT_TRUST_ATTESTATION",
            "MEASUREMENT_TRUST_SNAPSHOT",
            "MEASUREMENT_TRUST_PIN",
            "MEASUREMENT_TRUST_NOT_CURRENT",
            "MEASUREMENT_TRUST_REVOKED",
            "MEASUREMENT_TRUST_KEY",
            "MEASUREMENT_TRUST_SIGNATURE",
            "MEASUREMENT_TRUST_TIME",
            "MEASUREMENT_TRUST_NONDETERMINISM",
            "MEASUREMENT_TRUST_INTERNAL",
        }
    )

    def __init__(self, code: str, message: str) -> None:
        if code not in self._CODES:
            raise ValueError("decoded capture measurement trust code is invalid")
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise DecodedCaptureMeasurementTrustError(code, message)


def _require_false_authorities(value: object, *, label: str) -> None:
    for field in _AUTHORITY_FIELDS:
        if getattr(value, field, None) is not False:
            _fail("MEASUREMENT_TRUST_INTERNAL", f"{label} must remain non-authorizing")


def _public_key_sha256(public_key_base64: str) -> str:
    return hashlib.sha256(
        canonical_base64(public_key_base64, "public_key_base64", expected_bytes=32)
    ).hexdigest()


class DecodedCaptureMeasurementKeyRoleV1(str, Enum):
    DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER = (
        "DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER"
    )


class AuthenticatedDecodedCaptureMeasurementStatusV1(str, Enum):
    PROTECTED_REPLAY_EXACT_ASSET_BINDING_ATTESTED = (
        "PROTECTED_REPLAY_EXACT_ASSET_BINDING_ATTESTED"
    )


class CaptureSegmentVerificationInvocationV1:
    """Transient request that always reruns the upstream public verifier."""

    __slots__ = ("_arguments", "attestation", "statement", "trust_snapshot")

    def __init__(
        self,
        *,
        statement: FinalizedCaptureSegmentStatement,
        attestation: CaptureSegmentAttestation,
        trust_snapshot: CaptureSegmentTrustSnapshot,
        verification_arguments: tuple[tuple[str, object], ...],
    ) -> None:
        if type(statement) is not FinalizedCaptureSegmentStatement:
            raise ValueError("capture statement has the wrong exact type")
        if type(attestation) is not CaptureSegmentAttestation:
            raise ValueError("capture attestation has the wrong exact type")
        if type(trust_snapshot) is not CaptureSegmentTrustSnapshot:
            raise ValueError("capture trust snapshot has the wrong exact type")
        if type(verification_arguments) is not tuple or any(
            type(item) is not tuple or len(item) != 2 or type(item[0]) is not str
            for item in verification_arguments
        ):
            raise ValueError("capture verification arguments must be an exact tuple")
        keys = tuple(item[0] for item in verification_arguments)
        if (
            keys != tuple(sorted(keys))
            or len(keys) != len(set(keys))
            or set(keys) != _CAPTURE_VERIFY_ARGUMENT_KEYS
        ):
            raise ValueError("capture verification argument field set is invalid")
        object.__setattr__(self, "statement", statement)
        object.__setattr__(self, "attestation", attestation)
        object.__setattr__(self, "trust_snapshot", trust_snapshot)
        object.__setattr__(self, "_arguments", verification_arguments)

    def __setattr__(self, name: str, value: object) -> None:
        del name, value
        raise AttributeError("capture verification invocations are immutable")

    def _verify_fresh(self) -> _VerifiedCaptureSegmentEvidence:
        result = verify_capture_segment_attestation(
            self.statement,
            self.attestation,
            self.trust_snapshot,
            **dict(self._arguments),  # type: ignore[arg-type]
        )
        if type(result) is not _VerifiedCaptureSegmentEvidence:
            raise ValueError("capture verifier returned the wrong private type")
        return result

    @property
    def verified_at_ns(self) -> int:
        return require_exact_int(
            dict(self._arguments)["verified_at_ns"], "verified_at_ns"
        )

    def __reduce__(self) -> object:
        raise TypeError("capture verification invocations are not serializable")


@dataclass(frozen=True, slots=True)
class CaptureMeasurementReplayInvocationV1:
    """Independently pinned artifact/runtime/recipe inputs for one replay."""

    artifact_store_root: Path
    artifact_generation_id: str
    artifact_sha256s: tuple[str, ...]
    selected_video_stream_index: int
    runtime_store_root: Path
    runtime_generation_id: str
    runtime_manifest_sha256: str
    expected_runtime_manifest_sha256: str
    expected_platform: str
    expected_architecture: str
    expected_abi: str
    expected_system_runtime_id: str
    expected_system_runtime_measurement_sha256: str
    recipe: DecodedMeasurementRecipeV1
    expected_measurement_recipe_sha256: str

    def __post_init__(self) -> None:
        for root, label in (
            (self.artifact_store_root, "artifact_store_root"),
            (self.runtime_store_root, "runtime_store_root"),
        ):
            if not isinstance(root, Path) or not root.is_absolute():
                raise ValueError(f"{label} must be an absolute Path")
        for field in (
            "artifact_generation_id",
            "runtime_generation_id",
            "runtime_manifest_sha256",
            "expected_runtime_manifest_sha256",
            "expected_system_runtime_measurement_sha256",
            "expected_measurement_recipe_sha256",
        ):
            require_sha256(getattr(self, field), field)
        if self.runtime_manifest_sha256 != self.expected_runtime_manifest_sha256:
            raise ValueError("runtime manifest differs from independent pin")
        if (
            type(self.artifact_sha256s) is not tuple
            or len(self.artifact_sha256s) != 1
            or any(type(item) is not str for item in self.artifact_sha256s)
        ):
            raise ValueError("measurement replay requires one exact source artifact")
        for index, digest in enumerate(self.artifact_sha256s):
            require_sha256(digest, f"artifact_sha256s[{index}]")
        if self.artifact_sha256s != tuple(sorted(set(self.artifact_sha256s))):
            raise ValueError("artifact digests must be unique and sorted")
        if generation_id_for(self.artifact_sha256s) != self.artifact_generation_id:
            raise ValueError("artifact generation ID differs from its exact tuple")
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            maximum=MAX_SIGNED_64,
        )
        for field in (
            "expected_platform",
            "expected_architecture",
            "expected_abi",
            "expected_system_runtime_id",
        ):
            require_stable_id(getattr(self, field), field)
        if type(self.recipe) is not DecodedMeasurementRecipeV1:
            raise ValueError("recipe has the wrong exact type")
        canonical = DecodedMeasurementRecipeV1.from_json_bytes(
            self.recipe.to_json_bytes()
        )
        if (
            canonical != self.recipe
            or canonical.fingerprint() != self.expected_measurement_recipe_sha256
        ):
            raise ValueError("measurement recipe differs from independent pin")

    def _binding_arguments(self) -> dict[str, object]:
        return {
            "artifact_store_root": self.artifact_store_root,
            "artifact_generation_id": self.artifact_generation_id,
            "artifact_sha256s": self.artifact_sha256s,
            "runtime_store_root": self.runtime_store_root,
            "runtime_generation_id": self.runtime_generation_id,
            "runtime_manifest_sha256": self.runtime_manifest_sha256,
            "expected_runtime_manifest_sha256": (self.expected_runtime_manifest_sha256),
            "expected_platform": self.expected_platform,
            "expected_architecture": self.expected_architecture,
            "expected_abi": self.expected_abi,
            "expected_system_runtime_id": self.expected_system_runtime_id,
            "expected_system_runtime_measurement_sha256": (
                self.expected_system_runtime_measurement_sha256
            ),
            "recipe": self.recipe,
            "expected_measurement_recipe_sha256": (
                self.expected_measurement_recipe_sha256
            ),
        }


@dataclass(frozen=True, slots=True)
class DecodedCaptureMeasurementPolicyV1:
    """Exact protected pins authorized for one segment measurement replay."""

    policy_id: str
    policy_generation: int
    measurement_verifier_id: str
    capture_segment_statement_sha256: str
    capture_segment_attestation_sha256: str
    capture_segment_trust_snapshot_sha256: str
    capture_segment_trust_snapshot_generation: int
    capture_metadata_sha256: str
    selected_video_stream_binding_sha256: str
    selected_video_stream_index: int
    source_asset_sha256: str
    source_asset_byte_length: int
    artifact_generation_id: str
    artifact_sha256s: tuple[str, ...]
    runtime_generation_id: str
    runtime_manifest_sha256: str
    expected_platform: str
    expected_architecture: str
    expected_abi: str
    expected_system_runtime_id: str
    expected_system_runtime_measurement_sha256: str
    measurement_recipe_sha256: str
    capture_measurement_command_recipe_sha256: str
    valid_from_ns: int
    valid_until_ns: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION:
            raise ValueError("measurement policy schema is invalid")
        require_stable_id(self.policy_id, "policy_id")
        require_stable_id(self.measurement_verifier_id, "measurement_verifier_id")
        require_exact_int(self.policy_generation, "policy_generation")
        require_exact_int(
            self.capture_segment_trust_snapshot_generation,
            "capture_segment_trust_snapshot_generation",
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.source_asset_byte_length,
            "source_asset_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        valid_from = require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("measurement policy validity interval is reversed")
        for field in (
            "expected_platform",
            "expected_architecture",
            "expected_abi",
            "expected_system_runtime_id",
        ):
            require_stable_id(getattr(self, field), field)
        if (
            type(self.artifact_sha256s) is not tuple
            or self.artifact_sha256s != (self.source_asset_sha256,)
            or any(type(item) is not str for item in self.artifact_sha256s)
        ):
            raise ValueError("measurement policy requires one exact source artifact")
        for index, digest in enumerate(self.artifact_sha256s):
            require_sha256(digest, f"artifact_sha256s[{index}]")
        if self.artifact_sha256s != tuple(sorted(set(self.artifact_sha256s))):
            raise ValueError("policy artifact digests must be unique and sorted")
        if generation_id_for(self.artifact_sha256s) != self.artifact_generation_id:
            raise ValueError("policy artifact generation differs from its exact tuple")
        digest_roles = {
            "capture_segment_statement_sha256": self.capture_segment_statement_sha256,
            "capture_segment_attestation_sha256": (
                self.capture_segment_attestation_sha256
            ),
            "capture_segment_trust_snapshot_sha256": (
                self.capture_segment_trust_snapshot_sha256
            ),
            "capture_metadata_sha256": self.capture_metadata_sha256,
            "selected_video_stream_binding_sha256": (
                self.selected_video_stream_binding_sha256
            ),
            "artifact_generation_id": self.artifact_generation_id,
            "runtime_generation_id": self.runtime_generation_id,
            "runtime_manifest_sha256": self.runtime_manifest_sha256,
            "expected_system_runtime_measurement_sha256": (
                self.expected_system_runtime_measurement_sha256
            ),
            "measurement_recipe_sha256": self.measurement_recipe_sha256,
            "capture_measurement_command_recipe_sha256": (
                self.capture_measurement_command_recipe_sha256
            ),
        }
        for field, digest in digest_roles.items():
            require_sha256(digest, field)
        if len(set(digest_roles.values())) != len(digest_roles):
            raise ValueError("measurement policy typed digest roles alias")
        other_roles = set(digest_roles.values())
        if other_roles.intersection(self.artifact_sha256s):
            raise ValueError("policy artifact objects alias another digest role")
        for field in _AUTHORITY_FIELDS:
            if getattr(self, field) is not False:
                raise ValueError(f"{field} must remain exactly false")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            field: (list(value) if field == "artifact_sha256s" else value)
            for field, value in (
                (name, getattr(self, name)) for name in self.__dataclass_fields__
            )
        } | {"domain": DECODED_CAPTURE_MEASUREMENT_POLICY_DOMAIN}

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="decoded capture measurement policy",
            maximum_bytes=64 * 1024,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> DecodedCaptureMeasurementPolicyV1:
        fields = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label="decoded capture measurement policy",
                maximum_bytes=64 * 1024,
                maximum_depth=4,
                maximum_nodes=512,
                maximum_containers=8,
            ),
            {"domain", *cls.__dataclass_fields__},
            label="decoded capture measurement policy",
        )
        if fields.pop("domain") != DECODED_CAPTURE_MEASUREMENT_POLICY_DOMAIN:
            raise ValueError("measurement policy domain is invalid")
        fields["artifact_sha256s"] = tuple(
            exact_list(fields, "artifact_sha256s", label="measurement policy")
        )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("measurement policy reconstruction changed bytes")
        return result


@dataclass(frozen=True, slots=True)
class AuthenticatedDecodedCaptureMeasurementStatementV1:
    measurement_id: str
    measurement_verifier_id: str
    statement_created_at_ns: int
    capture_service_id: str
    lineage_id: str
    capture_session_id: str
    session_fingerprint: str
    reconnect_epoch: int
    capture_segment_statement_sha256: str
    capture_segment_attestation_sha256: str
    capture_segment_trust_snapshot_sha256: str
    capture_segment_trust_snapshot_generation: int
    capture_segment_verified_at_ns: int
    capture_metadata_sha256: str
    measurement_policy_sha256: str
    measurement_policy_generation: int
    selected_video_stream_binding: SelectedVideoStreamBindingV1
    selected_video_stream_binding_sha256: str
    logical_stream_epoch_sha256: str
    ordered_selected_fragments_sha256: str
    measurement_receipt: DecodedCaptureMeasurementReceiptV1
    measurement_receipt_sha256: str
    decoder_runtime_generation_id: str
    decoder_runtime_id: str
    capture_measurement_command_recipe_sha256: str
    metadata_output_sha256: str
    packet_output_sha256: str
    framehash_output_sha256: str
    status: AuthenticatedDecodedCaptureMeasurementStatusV1 = AuthenticatedDecodedCaptureMeasurementStatusV1.PROTECTED_REPLAY_EXACT_ASSET_BINDING_ATTESTED
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION:
            raise ValueError("authenticated measurement statement schema is invalid")
        for field in (
            "measurement_id",
            "measurement_verifier_id",
            "capture_service_id",
            "lineage_id",
            "capture_session_id",
            "decoder_runtime_id",
        ):
            require_stable_id(getattr(self, field), field)
        created = require_exact_int(
            self.statement_created_at_ns,
            "statement_created_at_ns",
        )
        capture_verified = require_exact_int(
            self.capture_segment_verified_at_ns,
            "capture_segment_verified_at_ns",
        )
        if created < capture_verified:
            raise ValueError(
                "measurement statement predates fresh capture verification"
            )
        require_exact_int(self.reconnect_epoch, "reconnect_epoch")
        require_exact_int(
            self.capture_segment_trust_snapshot_generation,
            "capture_segment_trust_snapshot_generation",
        )
        require_exact_int(
            self.measurement_policy_generation,
            "measurement_policy_generation",
        )
        if type(self.selected_video_stream_binding) is not SelectedVideoStreamBindingV1:
            raise ValueError("selected stream binding has the wrong exact type")
        stream_binding = SelectedVideoStreamBindingV1.from_json_bytes(
            self.selected_video_stream_binding.to_json_bytes()
        )
        if stream_binding != self.selected_video_stream_binding:
            raise ValueError("selected stream binding changed on reconstruction")
        if type(self.measurement_receipt) is not DecodedCaptureMeasurementReceiptV1:
            raise ValueError("measurement receipt has the wrong exact type")
        receipt = DecodedCaptureMeasurementReceiptV1.from_json_bytes(
            self.measurement_receipt.to_json_bytes()
        )
        if receipt != self.measurement_receipt:
            raise ValueError("measurement receipt changed on reconstruction")
        digest_roles = {
            "capture_segment_statement_sha256": self.capture_segment_statement_sha256,
            "capture_segment_attestation_sha256": (
                self.capture_segment_attestation_sha256
            ),
            "capture_segment_trust_snapshot_sha256": (
                self.capture_segment_trust_snapshot_sha256
            ),
            "capture_metadata_sha256": self.capture_metadata_sha256,
            "measurement_policy_sha256": self.measurement_policy_sha256,
            "selected_video_stream_binding_sha256": (
                self.selected_video_stream_binding_sha256
            ),
            "logical_stream_epoch_sha256": self.logical_stream_epoch_sha256,
            "ordered_selected_fragments_sha256": (
                self.ordered_selected_fragments_sha256
            ),
            "measurement_receipt_sha256": self.measurement_receipt_sha256,
            "source_asset_sha256": receipt.source_asset_sha256,
            "artifact_generation_id": receipt.artifact_generation_id,
            "decoder_runtime_generation_id": self.decoder_runtime_generation_id,
            "decoder_runtime_manifest_sha256": (
                receipt.decoder_runtime_manifest_sha256
            ),
            "capture_measurement_command_recipe_sha256": (
                self.capture_measurement_command_recipe_sha256
            ),
            "measurement_recipe_sha256": receipt.measurement_recipe_sha256,
            "presentation_timing_rows_sha256": (
                receipt.presentation_timing_rows_sha256
            ),
            "selected_video_packet_rows_sha256": (
                receipt.selected_video_packet_rows_sha256
            ),
            "decoded_frame_rows_sha256": receipt.decoded_frame_rows_sha256,
            "metadata_output_sha256": self.metadata_output_sha256,
            "packet_output_sha256": self.packet_output_sha256,
            "framehash_output_sha256": self.framehash_output_sha256,
            "session_fingerprint": self.session_fingerprint,
        }
        for field, digest in digest_roles.items():
            require_sha256(digest, field)
        if len(set(digest_roles.values())) != len(digest_roles):
            raise ValueError("authenticated measurement typed digest roles alias")
        if stream_binding.fingerprint() != self.selected_video_stream_binding_sha256:
            raise ValueError("selected stream binding fingerprint differs")
        if receipt.fingerprint() != self.measurement_receipt_sha256:
            raise ValueError("measurement receipt fingerprint differs")
        if (
            stream_binding.capture_segment_statement_sha256
            != self.capture_segment_statement_sha256
            or stream_binding.capture_metadata_sha256 != self.capture_metadata_sha256
            or stream_binding.source_asset_sha256 != receipt.source_asset_sha256
            or stream_binding.selected_video_stream_index
            != receipt.selected_video_stream_index
        ):
            raise ValueError("selected stream binding differs from statement receipt")
        if (
            type(self.status) is not AuthenticatedDecodedCaptureMeasurementStatusV1
            or self.status
            is not AuthenticatedDecodedCaptureMeasurementStatusV1.PROTECTED_REPLAY_EXACT_ASSET_BINDING_ATTESTED
        ):
            raise ValueError("authenticated measurement status is invalid")
        for field in _AUTHORITY_FIELDS:
            if getattr(self, field) is not False:
                raise ValueError(f"{field} must remain exactly false")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            field: (
                self.selected_video_stream_binding.to_dict()
                if field == "selected_video_stream_binding"
                else self.measurement_receipt.to_dict()
                if field == "measurement_receipt"
                else value.value
                if isinstance(value, Enum)
                else value
            )
            for field, value in (
                (name, getattr(self, name)) for name in self.__dataclass_fields__
            )
        } | {"domain": AUTHENTICATED_DECODED_CAPTURE_MEASUREMENT_STATEMENT_DOMAIN}

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="authenticated decoded capture measurement statement",
            maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(
        cls,
        raw: bytes,
    ) -> AuthenticatedDecodedCaptureMeasurementStatementV1:
        fields = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label="authenticated decoded capture measurement statement",
                maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES,
                maximum_depth=8,
                maximum_nodes=512,
                maximum_containers=16,
            ),
            {"domain", *cls.__dataclass_fields__},
            label="authenticated decoded capture measurement statement",
        )
        if (
            fields.pop("domain")
            != AUTHENTICATED_DECODED_CAPTURE_MEASUREMENT_STATEMENT_DOMAIN
        ):
            raise ValueError("authenticated measurement statement domain is invalid")
        fields["selected_video_stream_binding"] = (
            SelectedVideoStreamBindingV1.from_json_bytes(
                canonical_json_bytes(
                    fields["selected_video_stream_binding"],
                    label="embedded selected stream binding",
                    maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES,
                )
            )
        )
        fields["measurement_receipt"] = (
            DecodedCaptureMeasurementReceiptV1.from_json_bytes(
                canonical_json_bytes(
                    fields["measurement_receipt"],
                    label="embedded measurement receipt",
                    maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES,
                )
            )
        )
        fields["status"] = enum_from_json(
            AuthenticatedDecodedCaptureMeasurementStatusV1,
            fields["status"],
            "status",
        )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("authenticated measurement reconstruction changed bytes")
        return result


@dataclass(frozen=True, slots=True)
class DecodedCaptureMeasurementAttestationV1:
    statement_sha256: str
    key_id: str
    key_role: DecodedCaptureMeasurementKeyRoleV1
    measurement_verifier_id: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION:
            raise ValueError("measurement attestation schema is invalid")
        require_sha256(self.statement_sha256, "statement_sha256")
        for field in ("key_id", "measurement_verifier_id", "trust_domain_id"):
            require_stable_id(getattr(self, field), field)
        if (
            self.key_role
            is not DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
        ):
            raise ValueError("measurement attestation key role is invalid")
        require_exact_int(self.signed_at_ns, "signed_at_ns")
        canonical_base64(self.signature_base64, "signature_base64", expected_bytes=64)
        self.to_json_bytes()

    @property
    def signature(self) -> bytes:
        return canonical_base64(
            self.signature_base64,
            "signature_base64",
            expected_bytes=64,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": DECODED_CAPTURE_MEASUREMENT_ATTESTATION_DOMAIN,
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "measurement_verifier_id": self.measurement_verifier_id,
            "schema_version": self.schema_version,
            "signature_base64": self.signature_base64,
            "signed_at_ns": self.signed_at_ns,
            "statement_sha256": self.statement_sha256,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="decoded capture measurement attestation",
            maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_ATTESTATION_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> DecodedCaptureMeasurementAttestationV1:
        fields = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label="decoded capture measurement attestation",
                maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_ATTESTATION_BYTES,
                maximum_depth=3,
                maximum_nodes=32,
                maximum_containers=2,
            ),
            {"domain", *cls.__dataclass_fields__},
            label="decoded capture measurement attestation",
        )
        if fields.pop("domain") != DECODED_CAPTURE_MEASUREMENT_ATTESTATION_DOMAIN:
            raise ValueError("measurement attestation domain is invalid")
        fields["key_role"] = enum_from_json(
            DecodedCaptureMeasurementKeyRoleV1,
            fields["key_role"],
            "key_role",
        )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("measurement attestation reconstruction changed bytes")
        return result


def decoded_capture_measurement_signing_message_v1(
    statement: AuthenticatedDecodedCaptureMeasurementStatementV1,
    *,
    key_id: str,
    key_role: DecodedCaptureMeasurementKeyRoleV1,
    measurement_verifier_id: str,
    trust_domain_id: str,
    signed_at_ns: int,
) -> bytes:
    if type(statement) is not AuthenticatedDecodedCaptureMeasurementStatementV1:
        raise ValueError("measurement statement has the wrong exact type")
    require_stable_id(key_id, "key_id")
    if (
        key_role
        is not DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
    ):
        raise ValueError("measurement signing key role is invalid")
    require_stable_id(measurement_verifier_id, "measurement_verifier_id")
    require_stable_id(trust_domain_id, "trust_domain_id")
    require_exact_int(signed_at_ns, "signed_at_ns")
    return canonical_json_bytes(
        {
            "domain": DECODED_CAPTURE_MEASUREMENT_SIGNING_DOMAIN,
            "key_id": key_id,
            "key_role": key_role.value,
            "measurement_verifier_id": measurement_verifier_id,
            "signed_at_ns": signed_at_ns,
            "statement": statement.to_dict(),
            "trust_domain_id": trust_domain_id,
        },
        label="decoded capture measurement signing message",
        maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_STATEMENT_BYTES,
    )


@dataclass(frozen=True, slots=True)
class TrustedDecodedCaptureMeasurementSignerKeyV1:
    key_id: str
    key_role: DecodedCaptureMeasurementKeyRoleV1
    measurement_verifier_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None

    def __post_init__(self) -> None:
        require_stable_id(self.key_id, "key_id")
        require_stable_id(self.measurement_verifier_id, "measurement_verifier_id")
        if (
            self.key_role
            is not DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
        ):
            raise ValueError("measurement signer key role is invalid")
        canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_bytes=32,
        )
        valid_from = require_exact_int(self.valid_from_ns, "valid_from_ns")
        valid_until = require_exact_int(self.valid_until_ns, "valid_until_ns")
        if valid_until < valid_from:
            raise ValueError("measurement signer validity interval is reversed")
        if self.revoked_at_ns is not None:
            require_exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            canonical_base64(
                self.public_key_base64,
                "public_key_base64",
                expected_bytes=32,
            )
        )

    @property
    def public_key_sha256(self) -> str:
        return _public_key_sha256(self.public_key_base64)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key_id": self.key_id,
            "key_role": self.key_role.value,
            "measurement_verifier_id": self.measurement_verifier_id,
            "public_key_base64": self.public_key_base64,
            "revoked_at_ns": self.revoked_at_ns,
            "valid_from_ns": self.valid_from_ns,
            "valid_until_ns": self.valid_until_ns,
        }


@dataclass(frozen=True, slots=True)
class CurrentDecodedCaptureMeasurementV1:
    measurement_id: str
    capture_segment_statement_sha256: str
    capture_metadata_sha256: str
    source_asset_sha256: str
    selected_video_stream_index: int
    selected_video_stream_binding_sha256: str
    decoder_runtime_manifest_sha256: str
    measurement_recipe_sha256: str
    measurement_receipt_sha256: str
    statement_sha256: str
    attestation_sha256: str

    def __post_init__(self) -> None:
        require_stable_id(self.measurement_id, "measurement_id")
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            maximum=MAX_SIGNED_64,
        )
        digests = {
            field: getattr(self, field)
            for field in self.__dataclass_fields__
            if field != "measurement_id" and field != "selected_video_stream_index"
        }
        for field, digest in digests.items():
            require_sha256(digest, field)
        if len(set(digests.values())) != len(digests):
            raise ValueError("current measurement typed digest roles alias")

    def to_dict(self) -> dict[str, Any]:
        return {field: getattr(self, field) for field in self.__dataclass_fields__}


@dataclass(frozen=True, slots=True)
class DecodedCaptureMeasurementTrustSnapshotV1:
    snapshot_generation: int
    trust_domain_id: str
    measurement_verifier_id: str
    capture_service_id: str
    lineage_id: str
    capture_session_id: str
    session_fingerprint: str
    reconnect_epoch: int
    measurement_policy_sha256: str
    measurement_policy_generation: int
    keys: tuple[TrustedDecodedCaptureMeasurementSignerKeyV1, ...]
    current_measurements: tuple[CurrentDecodedCaptureMeasurementV1, ...]
    revoked_statement_sha256s: tuple[str, ...]
    revoked_measurement_receipt_sha256s: tuple[str, ...]
    reserved_nonmeasurement_public_key_sha256s: tuple[str, ...]
    schema_version: str = DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION:
            raise ValueError("measurement trust snapshot schema is invalid")
        require_exact_int(self.snapshot_generation, "snapshot_generation")
        require_exact_int(self.reconnect_epoch, "reconnect_epoch")
        require_exact_int(
            self.measurement_policy_generation,
            "measurement_policy_generation",
        )
        for field in (
            "trust_domain_id",
            "measurement_verifier_id",
            "capture_service_id",
            "lineage_id",
            "capture_session_id",
        ):
            require_stable_id(getattr(self, field), field)
        require_sha256(self.session_fingerprint, "session_fingerprint")
        require_sha256(self.measurement_policy_sha256, "measurement_policy_sha256")
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_DECODED_CAPTURE_MEASUREMENT_SIGNER_KEYS
            or any(
                type(item) is not TrustedDecodedCaptureMeasurementSignerKeyV1
                for item in self.keys
            )
        ):
            raise ValueError("measurement signer keys must be a bounded exact tuple")
        if self.keys != tuple(sorted(self.keys, key=lambda item: item.key_id)):
            raise ValueError("measurement signer keys must be sorted by key_id")
        if len({item.key_id for item in self.keys}) != len(self.keys):
            raise ValueError("measurement signer key IDs cannot repeat")
        if len({item.public_key_base64 for item in self.keys}) != len(self.keys):
            raise ValueError("one measurement key cannot have multiple identities")
        if any(
            item.measurement_verifier_id != self.measurement_verifier_id
            for item in self.keys
        ):
            raise ValueError("measurement signer key verifier scope differs")
        if (
            type(self.current_measurements) is not tuple
            or not 0
            <= len(self.current_measurements)
            <= MAX_CURRENT_DECODED_CAPTURE_MEASUREMENTS
            or any(
                type(item) is not CurrentDecodedCaptureMeasurementV1
                for item in self.current_measurements
            )
        ):
            raise ValueError("current measurements must be a bounded exact tuple")
        if self.current_measurements != tuple(
            sorted(self.current_measurements, key=lambda item: item.measurement_id)
        ):
            raise ValueError("current measurements must be sorted by measurement_id")
        for field in (
            "measurement_id",
            "capture_segment_statement_sha256",
            "capture_metadata_sha256",
            "source_asset_sha256",
            "selected_video_stream_binding_sha256",
            "measurement_receipt_sha256",
            "statement_sha256",
            "attestation_sha256",
        ):
            values = tuple(getattr(item, field) for item in self.current_measurements)
            if len(set(values)) != len(values):
                raise ValueError(f"current measurement {field} cannot repeat")
        require_canonical_tuple(
            self.revoked_statement_sha256s,
            "revoked_statement_sha256s",
            minimum=0,
            maximum=MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS,
            validator=require_sha256,
        )
        require_canonical_tuple(
            self.revoked_measurement_receipt_sha256s,
            "revoked_measurement_receipt_sha256s",
            minimum=0,
            maximum=MAX_REVOKED_DECODED_CAPTURE_MEASUREMENTS,
            validator=require_sha256,
        )
        current_statements = {
            item.statement_sha256 for item in self.current_measurements
        }
        current_receipts = {
            item.measurement_receipt_sha256 for item in self.current_measurements
        }
        if current_statements.intersection(self.revoked_statement_sha256s):
            raise ValueError("current measurement statement cannot be revoked")
        if current_receipts.intersection(self.revoked_measurement_receipt_sha256s):
            raise ValueError("current measurement receipt cannot be revoked")
        require_canonical_tuple(
            self.reserved_nonmeasurement_public_key_sha256s,
            "reserved_nonmeasurement_public_key_sha256s",
            minimum=1,
            maximum=MAX_RESERVED_NONMEASUREMENT_KEYS,
            validator=require_sha256,
        )
        if {item.public_key_sha256 for item in self.keys}.intersection(
            self.reserved_nonmeasurement_public_key_sha256s
        ):
            raise ValueError("measurement signer key overlaps another key domain")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_service_id": self.capture_service_id,
            "capture_session_id": self.capture_session_id,
            "current_measurements": [
                item.to_dict() for item in self.current_measurements
            ],
            "domain": DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_DOMAIN,
            "keys": [item.to_dict() for item in self.keys],
            "lineage_id": self.lineage_id,
            "measurement_policy_generation": self.measurement_policy_generation,
            "measurement_policy_sha256": self.measurement_policy_sha256,
            "measurement_verifier_id": self.measurement_verifier_id,
            "reconnect_epoch": self.reconnect_epoch,
            "reserved_nonmeasurement_public_key_sha256s": list(
                self.reserved_nonmeasurement_public_key_sha256s
            ),
            "revoked_measurement_receipt_sha256s": list(
                self.revoked_measurement_receipt_sha256s
            ),
            "revoked_statement_sha256s": list(self.revoked_statement_sha256s),
            "schema_version": self.schema_version,
            "session_fingerprint": self.session_fingerprint,
            "snapshot_generation": self.snapshot_generation,
            "trust_domain_id": self.trust_domain_id,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="decoded capture measurement trust snapshot",
            maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(
        cls,
        raw: bytes,
    ) -> DecodedCaptureMeasurementTrustSnapshotV1:
        fields = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label="decoded capture measurement trust snapshot",
                maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_BYTES,
                maximum_depth=8,
                maximum_nodes=(
                    MAX_DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_JSON_NODES
                ),
                maximum_containers=1_024,
            ),
            {"domain", *cls.__dataclass_fields__},
            label="decoded capture measurement trust snapshot",
        )
        if fields.pop("domain") != DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_DOMAIN:
            raise ValueError("measurement trust snapshot domain is invalid")
        raw_keys = exact_list(fields, "keys", label="measurement trust snapshot")
        raw_current = exact_list(
            fields,
            "current_measurements",
            label="measurement trust snapshot",
        )
        fields["keys"] = tuple(
            TrustedDecodedCaptureMeasurementSignerKeyV1(
                **{
                    **require_exact_fields(
                        value,
                        set(
                            TrustedDecodedCaptureMeasurementSignerKeyV1.__dataclass_fields__
                        ),
                        label=f"keys[{index}]",
                    ),
                    "key_role": enum_from_json(
                        DecodedCaptureMeasurementKeyRoleV1,
                        value["key_role"],
                        f"keys[{index}].key_role",
                    ),
                }
            )
            for index, value in enumerate(raw_keys)
        )
        fields["current_measurements"] = tuple(
            CurrentDecodedCaptureMeasurementV1(
                **require_exact_fields(
                    value,
                    set(CurrentDecodedCaptureMeasurementV1.__dataclass_fields__),
                    label=f"current_measurements[{index}]",
                )
            )
            for index, value in enumerate(raw_current)
        )
        for field in (
            "revoked_statement_sha256s",
            "revoked_measurement_receipt_sha256s",
            "reserved_nonmeasurement_public_key_sha256s",
        ):
            fields[field] = tuple(
                exact_list(fields, field, label="measurement trust snapshot")
            )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("measurement trust snapshot reconstruction changed bytes")
        return result


def _canonical_statement(
    value: object,
) -> AuthenticatedDecodedCaptureMeasurementStatementV1:
    if type(value) is not AuthenticatedDecodedCaptureMeasurementStatementV1:
        _fail("MEASUREMENT_TRUST_STATEMENT", "statement has the wrong exact type")
    try:
        result = AuthenticatedDecodedCaptureMeasurementStatementV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_STATEMENT",
            "measurement statement is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_STATEMENT", "statement changed on reconstruction")
    return result


def _canonical_attestation(
    value: object,
) -> DecodedCaptureMeasurementAttestationV1:
    if type(value) is not DecodedCaptureMeasurementAttestationV1:
        _fail("MEASUREMENT_TRUST_ATTESTATION", "attestation has the wrong exact type")
    try:
        result = DecodedCaptureMeasurementAttestationV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_ATTESTATION",
            "measurement attestation is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_ATTESTATION", "attestation changed on reconstruction")
    return result


def _canonical_snapshot(
    value: object,
) -> DecodedCaptureMeasurementTrustSnapshotV1:
    if type(value) is not DecodedCaptureMeasurementTrustSnapshotV1:
        _fail("MEASUREMENT_TRUST_SNAPSHOT", "snapshot has the wrong exact type")
    try:
        result = DecodedCaptureMeasurementTrustSnapshotV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_SNAPSHOT",
            "measurement trust snapshot is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_SNAPSHOT", "snapshot changed on reconstruction")
    return result


def _canonical_replay_invocation(
    value: object,
) -> CaptureMeasurementReplayInvocationV1:
    if type(value) is not CaptureMeasurementReplayInvocationV1:
        _fail("MEASUREMENT_TRUST_INPUT", "replay invocation has the wrong exact type")
    try:
        result = CaptureMeasurementReplayInvocationV1(
            **{field: getattr(value, field) for field in value.__dataclass_fields__}
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "replay invocation is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_INPUT", "replay invocation changed on reconstruction")
    return result


def _canonical_capture_invocation(
    value: object,
) -> CaptureSegmentVerificationInvocationV1:
    if type(value) is not CaptureSegmentVerificationInvocationV1:
        _fail("MEASUREMENT_TRUST_INPUT", "capture invocation has the wrong exact type")
    try:
        result = CaptureSegmentVerificationInvocationV1(
            statement=FinalizedCaptureSegmentStatement.from_json_bytes(
                value.statement.to_json_bytes()
            ),
            attestation=CaptureSegmentAttestation.from_json_bytes(
                value.attestation.to_json_bytes()
            ),
            trust_snapshot=CaptureSegmentTrustSnapshot.from_json_bytes(
                value.trust_snapshot.to_json_bytes()
            ),
            verification_arguments=tuple(value._arguments),
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "capture invocation is not canonical",
        ) from exc
    return result


def _canonical_stream_binding(value: object) -> SelectedVideoStreamBindingV1:
    if type(value) is not SelectedVideoStreamBindingV1:
        _fail("MEASUREMENT_TRUST_INPUT", "stream binding has the wrong exact type")
    try:
        result = SelectedVideoStreamBindingV1.from_json_bytes(value.to_json_bytes())
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "stream binding is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_INPUT", "stream binding changed on reconstruction")
    return result


def _canonical_policy(value: object) -> DecodedCaptureMeasurementPolicyV1:
    if type(value) is not DecodedCaptureMeasurementPolicyV1:
        _fail("MEASUREMENT_TRUST_INPUT", "measurement policy has the wrong exact type")
    try:
        result = DecodedCaptureMeasurementPolicyV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "measurement policy is not canonical",
        ) from exc
    if result != value:
        _fail("MEASUREMENT_TRUST_INPUT", "measurement policy changed on reconstruction")
    return result


def _validate_policy_transaction(
    *,
    policy: DecodedCaptureMeasurementPolicyV1,
    expected_policy_sha256: str,
    expected_policy_generation: int,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    stream_binding: SelectedVideoStreamBindingV1,
    transaction_time_ns: int,
) -> None:
    require_sha256(expected_policy_sha256, "expected_measurement_policy_sha256")
    require_exact_int(
        expected_policy_generation,
        "expected_measurement_policy_generation",
    )
    transaction_time = require_exact_int(transaction_time_ns, "transaction_time_ns")
    if (
        policy.fingerprint() != expected_policy_sha256
        or policy.policy_generation != expected_policy_generation
        or not policy.valid_from_ns <= transaction_time <= policy.valid_until_ns
    ):
        _fail("MEASUREMENT_TRUST_PIN", "measurement policy differs from protected pin")
    replay = _canonical_replay_invocation(replay_invocation)
    capture_arguments = dict(capture_invocation._arguments)
    metadata = capture_invocation.statement.capture_metadata
    expected = (
        capture_invocation.statement.fingerprint(),
        capture_invocation.attestation.fingerprint(),
        capture_invocation.trust_snapshot.fingerprint(),
        capture_invocation.trust_snapshot.snapshot_generation,
        metadata.fingerprint(),
        stream_binding.fingerprint(),
        stream_binding.selected_video_stream_index,
        metadata.asset_sha256,
        metadata.asset_byte_length,
        replay.artifact_generation_id,
        replay.artifact_sha256s,
        replay.runtime_generation_id,
        replay.runtime_manifest_sha256,
        replay.expected_platform,
        replay.expected_architecture,
        replay.expected_abi,
        replay.expected_system_runtime_id,
        replay.expected_system_runtime_measurement_sha256,
        replay.expected_measurement_recipe_sha256,
        replay.recipe.capture_measurement_command_recipe_sha256,
        capture_arguments["expected_current_attestation_sha256"],
        capture_arguments["expected_trust_snapshot_sha256"],
        capture_arguments["expected_trust_snapshot_generation"],
    )
    observed = (
        policy.capture_segment_statement_sha256,
        policy.capture_segment_attestation_sha256,
        policy.capture_segment_trust_snapshot_sha256,
        policy.capture_segment_trust_snapshot_generation,
        policy.capture_metadata_sha256,
        policy.selected_video_stream_binding_sha256,
        policy.selected_video_stream_index,
        policy.source_asset_sha256,
        policy.source_asset_byte_length,
        policy.artifact_generation_id,
        policy.artifact_sha256s,
        policy.runtime_generation_id,
        policy.runtime_manifest_sha256,
        policy.expected_platform,
        policy.expected_architecture,
        policy.expected_abi,
        policy.expected_system_runtime_id,
        policy.expected_system_runtime_measurement_sha256,
        policy.measurement_recipe_sha256,
        policy.capture_measurement_command_recipe_sha256,
        policy.capture_segment_attestation_sha256,
        policy.capture_segment_trust_snapshot_sha256,
        policy.capture_segment_trust_snapshot_generation,
    )
    if observed != expected:
        _fail(
            "MEASUREMENT_TRUST_PIN",
            "measurement policy differs from capture, stream, artifact, or runtime pins",
        )


def _fresh_transient_binding(
    *,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    policy: DecodedCaptureMeasurementPolicyV1,
) -> _TransientCaptureMeasurementBindingV1:
    if type(capture_invocation) is not CaptureSegmentVerificationInvocationV1:
        _fail("MEASUREMENT_TRUST_INPUT", "capture invocation has the wrong exact type")
    replay = _canonical_replay_invocation(replay_invocation)
    try:
        capture_evidence = capture_invocation._verify_fresh()
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_CAPTURE",
            "fresh capture-segment verification failed",
        ) from exc
    try:
        result = _replay_and_bind_capture_measurement_v1(
            capture_segment_statement=capture_invocation.statement,
            capture_segment_evidence=capture_evidence,
            selected_video_stream_binding=selected_video_stream_binding,
            expected_capture_segment_statement_sha256=(
                policy.capture_segment_statement_sha256
            ),
            expected_capture_segment_attestation_sha256=(
                policy.capture_segment_attestation_sha256
            ),
            expected_capture_segment_trust_snapshot_sha256=(
                policy.capture_segment_trust_snapshot_sha256
            ),
            expected_capture_segment_trust_snapshot_generation=(
                policy.capture_segment_trust_snapshot_generation
            ),
            expected_capture_metadata_sha256=policy.capture_metadata_sha256,
            expected_selected_video_stream_binding_sha256=(
                policy.selected_video_stream_binding_sha256
            ),
            expected_selected_video_stream_index=(replay.selected_video_stream_index),
            **replay._binding_arguments(),  # type: ignore[arg-type]
        )
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_REPLAY",
            "protected measurement replay and binding failed",
        ) from exc
    if type(result) is not _TransientCaptureMeasurementBindingV1:
        _fail("MEASUREMENT_TRUST_INTERNAL", "transient binding has the wrong type")
    return result


def _statement_from_transient(
    *,
    transient: _TransientCaptureMeasurementBindingV1,
    stream_binding: SelectedVideoStreamBindingV1,
    measurement_id: str,
    measurement_verifier_id: str,
    statement_created_at_ns: int,
    capture_segment_verified_at_ns: int,
    policy: DecodedCaptureMeasurementPolicyV1,
) -> AuthenticatedDecodedCaptureMeasurementStatementV1:
    if type(transient) is not _TransientCaptureMeasurementBindingV1:
        _fail("MEASUREMENT_TRUST_INTERNAL", "transient binding has the wrong type")
    if stream_binding.fingerprint() != transient._coordinate(
        "selected_video_stream_binding_sha256"
    ):
        _fail(
            "MEASUREMENT_TRUST_INTERNAL",
            "selected stream binding changed after protected replay",
        )
    receipt = transient._canonical_receipt()
    observed_policy_binding = (
        transient._coordinate("capture_segment_statement_sha256"),
        transient._coordinate("capture_segment_attestation_sha256"),
        transient._coordinate("capture_segment_trust_snapshot_sha256"),
        transient._coordinate("capture_segment_trust_snapshot_generation"),
        transient._coordinate("capture_metadata_sha256"),
        transient._coordinate("selected_video_stream_binding_sha256"),
        receipt.selected_video_stream_index,
        receipt.source_asset_sha256,
        receipt.source_asset_byte_length,
        receipt.artifact_generation_id,
        transient._coordinate("decoder_runtime_generation_id"),
        receipt.decoder_runtime_manifest_sha256,
        receipt.measurement_recipe_sha256,
        transient._coordinate("capture_measurement_command_recipe_sha256"),
    )
    expected_policy_binding = (
        policy.capture_segment_statement_sha256,
        policy.capture_segment_attestation_sha256,
        policy.capture_segment_trust_snapshot_sha256,
        policy.capture_segment_trust_snapshot_generation,
        policy.capture_metadata_sha256,
        policy.selected_video_stream_binding_sha256,
        policy.selected_video_stream_index,
        policy.source_asset_sha256,
        policy.source_asset_byte_length,
        policy.artifact_generation_id,
        policy.runtime_generation_id,
        policy.runtime_manifest_sha256,
        policy.measurement_recipe_sha256,
        policy.capture_measurement_command_recipe_sha256,
    )
    if observed_policy_binding != expected_policy_binding:
        _fail(
            "MEASUREMENT_TRUST_PIN",
            "protected replay output differs from measurement policy",
        )
    return AuthenticatedDecodedCaptureMeasurementStatementV1(
        measurement_id=measurement_id,
        measurement_verifier_id=measurement_verifier_id,
        statement_created_at_ns=statement_created_at_ns,
        capture_service_id=str(transient._coordinate("capture_service_id")),
        lineage_id=str(transient._coordinate("lineage_id")),
        capture_session_id=str(transient._coordinate("capture_session_id")),
        session_fingerprint=str(transient._coordinate("session_fingerprint")),
        reconnect_epoch=int(transient._coordinate("reconnect_epoch")),
        capture_segment_statement_sha256=str(
            transient._coordinate("capture_segment_statement_sha256")
        ),
        capture_segment_attestation_sha256=str(
            transient._coordinate("capture_segment_attestation_sha256")
        ),
        capture_segment_trust_snapshot_sha256=str(
            transient._coordinate("capture_segment_trust_snapshot_sha256")
        ),
        capture_segment_trust_snapshot_generation=int(
            transient._coordinate("capture_segment_trust_snapshot_generation")
        ),
        capture_segment_verified_at_ns=capture_segment_verified_at_ns,
        capture_metadata_sha256=str(transient._coordinate("capture_metadata_sha256")),
        measurement_policy_sha256=policy.fingerprint(),
        measurement_policy_generation=policy.policy_generation,
        selected_video_stream_binding=stream_binding,
        selected_video_stream_binding_sha256=stream_binding.fingerprint(),
        logical_stream_epoch_sha256=str(
            transient._coordinate("logical_stream_epoch_sha256")
        ),
        ordered_selected_fragments_sha256=str(
            transient._coordinate("ordered_selected_fragments_sha256")
        ),
        measurement_receipt=receipt,
        measurement_receipt_sha256=receipt.fingerprint(),
        decoder_runtime_generation_id=str(
            transient._coordinate("decoder_runtime_generation_id")
        ),
        decoder_runtime_id=str(transient._coordinate("decoder_runtime_id")),
        capture_measurement_command_recipe_sha256=str(
            transient._coordinate("capture_measurement_command_recipe_sha256")
        ),
        metadata_output_sha256=str(transient._coordinate("metadata_output_sha256")),
        packet_output_sha256=str(transient._coordinate("packet_output_sha256")),
        framehash_output_sha256=str(transient._coordinate("framehash_output_sha256")),
    )


def _sign_protected_decoded_capture_measurement_v1_impl(
    *,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    measurement_policy: DecodedCaptureMeasurementPolicyV1,
    expected_measurement_policy_sha256: str,
    expected_measurement_policy_generation: int,
    measurement_id: str,
    measurement_verifier_id: str,
    statement_created_at_ns: int,
    key_id: str,
    trust_domain_id: str,
    signed_at_ns: int,
    measurement_private_key: Ed25519PrivateKey,
) -> tuple[
    AuthenticatedDecodedCaptureMeasurementStatementV1,
    DecodedCaptureMeasurementAttestationV1,
]:
    """Freshly verify, replay, construct, and sign without accepting a statement."""

    for value, label in (
        (measurement_id, "measurement_id"),
        (measurement_verifier_id, "measurement_verifier_id"),
        (key_id, "key_id"),
        (trust_domain_id, "trust_domain_id"),
    ):
        require_stable_id(value, label)
    created = require_exact_int(statement_created_at_ns, "statement_created_at_ns")
    signed = require_exact_int(signed_at_ns, "signed_at_ns")
    if signed < created:
        _fail("MEASUREMENT_TRUST_TIME", "measurement signing predates statement")
    if not isinstance(measurement_private_key, Ed25519PrivateKey):
        _fail("MEASUREMENT_TRUST_KEY", "measurement private key has wrong type")
    capture = _canonical_capture_invocation(capture_invocation)
    replay = _canonical_replay_invocation(replay_invocation)
    stream_binding = _canonical_stream_binding(selected_video_stream_binding)
    policy = _canonical_policy(measurement_policy)
    if policy.measurement_verifier_id != measurement_verifier_id:
        _fail("MEASUREMENT_TRUST_PIN", "measurement policy verifier differs")
    _validate_policy_transaction(
        policy=policy,
        expected_policy_sha256=expected_measurement_policy_sha256,
        expected_policy_generation=expected_measurement_policy_generation,
        capture_invocation=capture,
        replay_invocation=replay,
        stream_binding=stream_binding,
        transaction_time_ns=created,
    )
    if not policy.valid_from_ns <= created <= signed <= policy.valid_until_ns:
        _fail("MEASUREMENT_TRUST_TIME", "measurement policy is inactive at signing")
    transient = _fresh_transient_binding(
        capture_invocation=capture,
        replay_invocation=replay,
        selected_video_stream_binding=stream_binding,
        policy=policy,
    )
    statement = _statement_from_transient(
        transient=transient,
        stream_binding=stream_binding,
        measurement_id=measurement_id,
        measurement_verifier_id=measurement_verifier_id,
        statement_created_at_ns=created,
        capture_segment_verified_at_ns=int(
            transient._coordinate("capture_segment_verified_at_ns")
        ),
        policy=policy,
    )
    role = DecodedCaptureMeasurementKeyRoleV1.DECODED_CAPTURE_MEASUREMENT_ATTESTATION_SIGNER
    signature = measurement_private_key.sign(
        decoded_capture_measurement_signing_message_v1(
            statement,
            key_id=key_id,
            key_role=role,
            measurement_verifier_id=measurement_verifier_id,
            trust_domain_id=trust_domain_id,
            signed_at_ns=signed,
        )
    )
    attestation = DecodedCaptureMeasurementAttestationV1(
        statement_sha256=statement.fingerprint(),
        key_id=key_id,
        key_role=role,
        measurement_verifier_id=measurement_verifier_id,
        trust_domain_id=trust_domain_id,
        signed_at_ns=signed,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )
    return statement, attestation


def sign_protected_decoded_capture_measurement_v1(
    *,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    measurement_policy: DecodedCaptureMeasurementPolicyV1,
    expected_measurement_policy_sha256: str,
    expected_measurement_policy_generation: int,
    measurement_id: str,
    measurement_verifier_id: str,
    statement_created_at_ns: int,
    key_id: str,
    trust_domain_id: str,
    signed_at_ns: int,
    measurement_private_key: Ed25519PrivateKey,
) -> tuple[
    AuthenticatedDecodedCaptureMeasurementStatementV1,
    DecodedCaptureMeasurementAttestationV1,
]:
    """Expose only finite trust failures from protected measurement signing."""

    try:
        return _sign_protected_decoded_capture_measurement_v1_impl(
            capture_invocation=capture_invocation,
            replay_invocation=replay_invocation,
            selected_video_stream_binding=selected_video_stream_binding,
            measurement_policy=measurement_policy,
            expected_measurement_policy_sha256=expected_measurement_policy_sha256,
            expected_measurement_policy_generation=(
                expected_measurement_policy_generation
            ),
            measurement_id=measurement_id,
            measurement_verifier_id=measurement_verifier_id,
            statement_created_at_ns=statement_created_at_ns,
            key_id=key_id,
            trust_domain_id=trust_domain_id,
            signed_at_ns=signed_at_ns,
            measurement_private_key=measurement_private_key,
        )
    except DecodedCaptureMeasurementTrustError:
        raise
    except (KeyboardInterrupt, SystemExit):
        raise
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "measurement signing input is malformed",
        ) from exc
    except BaseException as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INTERNAL",
            "measurement signing failed internally",
        ) from exc


def current_decoded_capture_measurement_v1(
    statement: AuthenticatedDecodedCaptureMeasurementStatementV1,
    attestation: DecodedCaptureMeasurementAttestationV1,
) -> CurrentDecodedCaptureMeasurementV1:
    canonical_statement = _canonical_statement(statement)
    canonical_attestation = _canonical_attestation(attestation)
    if canonical_attestation.statement_sha256 != canonical_statement.fingerprint():
        _fail("MEASUREMENT_TRUST_ATTESTATION", "attestation names another statement")
    receipt = canonical_statement.measurement_receipt
    return CurrentDecodedCaptureMeasurementV1(
        measurement_id=canonical_statement.measurement_id,
        capture_segment_statement_sha256=(
            canonical_statement.capture_segment_statement_sha256
        ),
        capture_metadata_sha256=canonical_statement.capture_metadata_sha256,
        source_asset_sha256=receipt.source_asset_sha256,
        selected_video_stream_index=receipt.selected_video_stream_index,
        selected_video_stream_binding_sha256=(
            canonical_statement.selected_video_stream_binding_sha256
        ),
        decoder_runtime_manifest_sha256=(receipt.decoder_runtime_manifest_sha256),
        measurement_recipe_sha256=receipt.measurement_recipe_sha256,
        measurement_receipt_sha256=canonical_statement.measurement_receipt_sha256,
        statement_sha256=canonical_statement.fingerprint(),
        attestation_sha256=canonical_attestation.fingerprint(),
    )


def _verify_authenticated_decoded_capture_measurement_v1_impl(
    statement: AuthenticatedDecodedCaptureMeasurementStatementV1,
    attestation: DecodedCaptureMeasurementAttestationV1,
    trust_snapshot: DecodedCaptureMeasurementTrustSnapshotV1,
    *,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    measurement_policy: DecodedCaptureMeasurementPolicyV1,
    expected_trust_snapshot_sha256: str,
    expected_trust_snapshot_generation: int,
    expected_current_attestation_sha256: str,
    expected_measurement_verifier_id: str,
    expected_trust_domain_id: str,
    expected_measurement_policy_sha256: str,
    expected_measurement_policy_generation: int,
    verified_at_ns: int,
) -> None:
    """Verify current authenticated evidence and independently repeat its replay."""

    signed_statement = _canonical_statement(statement)
    signed_attestation = _canonical_attestation(attestation)
    snapshot = _canonical_snapshot(trust_snapshot)
    verified_at = require_exact_int(verified_at_ns, "verified_at_ns")
    for value, label in (
        (expected_trust_snapshot_sha256, "expected_trust_snapshot_sha256"),
        (expected_current_attestation_sha256, "expected_current_attestation_sha256"),
        (expected_measurement_policy_sha256, "expected_measurement_policy_sha256"),
    ):
        require_sha256(value, label)
    require_exact_int(
        expected_trust_snapshot_generation, "expected_trust_snapshot_generation"
    )
    require_exact_int(
        expected_measurement_policy_generation,
        "expected_measurement_policy_generation",
    )
    require_stable_id(
        expected_measurement_verifier_id, "expected_measurement_verifier_id"
    )
    require_stable_id(expected_trust_domain_id, "expected_trust_domain_id")
    if (
        not hmac.compare_digest(snapshot.fingerprint(), expected_trust_snapshot_sha256)
        or snapshot.snapshot_generation != expected_trust_snapshot_generation
        or snapshot.measurement_verifier_id != expected_measurement_verifier_id
        or snapshot.trust_domain_id != expected_trust_domain_id
        or snapshot.measurement_policy_sha256 != expected_measurement_policy_sha256
        or snapshot.measurement_policy_generation
        != expected_measurement_policy_generation
    ):
        _fail("MEASUREMENT_TRUST_PIN", "measurement trust snapshot differs from pins")
    if (
        signed_statement.fingerprint() in snapshot.revoked_statement_sha256s
        or signed_statement.measurement_receipt_sha256
        in snapshot.revoked_measurement_receipt_sha256s
    ):
        _fail(
            "MEASUREMENT_TRUST_REVOKED", "measurement statement or receipt is revoked"
        )
    capture = _canonical_capture_invocation(capture_invocation)
    replay = _canonical_replay_invocation(replay_invocation)
    stream_binding = _canonical_stream_binding(selected_video_stream_binding)
    policy = _canonical_policy(measurement_policy)
    _validate_policy_transaction(
        policy=policy,
        expected_policy_sha256=expected_measurement_policy_sha256,
        expected_policy_generation=expected_measurement_policy_generation,
        capture_invocation=capture,
        replay_invocation=replay,
        stream_binding=stream_binding,
        transaction_time_ns=verified_at,
    )
    if (
        signed_statement.measurement_verifier_id != expected_measurement_verifier_id
        or signed_statement.measurement_policy_sha256
        != expected_measurement_policy_sha256
        or signed_statement.measurement_policy_generation
        != expected_measurement_policy_generation
        or signed_statement.capture_segment_statement_sha256
        != policy.capture_segment_statement_sha256
        or signed_statement.capture_metadata_sha256 != policy.capture_metadata_sha256
        or signed_statement.selected_video_stream_binding_sha256
        != policy.selected_video_stream_binding_sha256
    ):
        _fail("MEASUREMENT_TRUST_PIN", "measurement statement differs from pins")
    raw_capture_statement = capture.statement
    metadata = raw_capture_statement.capture_metadata
    if (
        snapshot.capture_service_id != raw_capture_statement.capture_service_id
        or snapshot.lineage_id != raw_capture_statement.lineage_id
        or snapshot.capture_session_id != metadata.capture_session_id
        or snapshot.session_fingerprint != metadata.session_fingerprint
        or snapshot.reconnect_epoch != metadata.reconnect_epoch
    ):
        _fail("MEASUREMENT_TRUST_SNAPSHOT", "measurement snapshot scope differs")
    upstream_key_hashes = {
        item.public_key_sha256 for item in capture.trust_snapshot.keys
    } | set(capture.trust_snapshot.reserved_nonsegment_public_key_sha256s)
    if not upstream_key_hashes <= set(
        snapshot.reserved_nonmeasurement_public_key_sha256s
    ):
        _fail(
            "MEASUREMENT_TRUST_SNAPSHOT",
            "upstream capture, metadata, or rights keys are not reserved",
        )
    current = next(
        (
            item
            for item in snapshot.current_measurements
            if item.measurement_id == signed_statement.measurement_id
        ),
        None,
    )
    expected_current = current_decoded_capture_measurement_v1(
        signed_statement,
        signed_attestation,
    )
    if current != expected_current:
        _fail("MEASUREMENT_TRUST_NOT_CURRENT", "measurement is not current")
    if current.attestation_sha256 != expected_current_attestation_sha256:
        _fail("MEASUREMENT_TRUST_PIN", "current attestation differs from pin")
    if (
        signed_attestation.statement_sha256 != signed_statement.fingerprint()
        or signed_attestation.fingerprint() != current.attestation_sha256
        or signed_attestation.measurement_verifier_id
        != expected_measurement_verifier_id
        or signed_attestation.trust_domain_id != expected_trust_domain_id
    ):
        _fail("MEASUREMENT_TRUST_ATTESTATION", "measurement attestation differs")
    if not (
        policy.valid_from_ns
        <= signed_statement.capture_segment_verified_at_ns
        <= signed_statement.statement_created_at_ns
        <= signed_attestation.signed_at_ns
        <= verified_at
        <= policy.valid_until_ns
    ):
        _fail("MEASUREMENT_TRUST_TIME", "measurement evidence times are reversed")
    if capture.verified_at_ns != verified_at:
        _fail(
            "MEASUREMENT_TRUST_TIME",
            "fresh capture verification time must equal protected verification time",
        )
    key = next(
        (item for item in snapshot.keys if item.key_id == signed_attestation.key_id),
        None,
    )
    if key is None:
        _fail("MEASUREMENT_TRUST_KEY", "measurement signer key is untrusted")
    if (
        key.key_role is not signed_attestation.key_role
        or key.measurement_verifier_id != signed_attestation.measurement_verifier_id
        or not key.valid_from_ns
        <= signed_attestation.signed_at_ns
        <= verified_at
        <= key.valid_until_ns
        or (key.revoked_at_ns is not None and verified_at >= key.revoked_at_ns)
    ):
        _fail("MEASUREMENT_TRUST_KEY", "measurement signer key is invalid or revoked")
    try:
        key.public_key.verify(
            signed_attestation.signature,
            decoded_capture_measurement_signing_message_v1(
                signed_statement,
                key_id=signed_attestation.key_id,
                key_role=signed_attestation.key_role,
                measurement_verifier_id=signed_attestation.measurement_verifier_id,
                trust_domain_id=signed_attestation.trust_domain_id,
                signed_at_ns=signed_attestation.signed_at_ns,
            ),
        )
    except InvalidSignature as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_SIGNATURE",
            "measurement signature is invalid",
        ) from exc
    transient = _fresh_transient_binding(
        capture_invocation=capture,
        replay_invocation=replay,
        selected_video_stream_binding=stream_binding,
        policy=policy,
    )
    expected_statement = _statement_from_transient(
        transient=transient,
        stream_binding=stream_binding,
        measurement_id=signed_statement.measurement_id,
        measurement_verifier_id=signed_statement.measurement_verifier_id,
        statement_created_at_ns=signed_statement.statement_created_at_ns,
        capture_segment_verified_at_ns=(
            signed_statement.capture_segment_verified_at_ns
        ),
        policy=policy,
    )
    if not hmac.compare_digest(
        expected_statement.to_json_bytes(),
        signed_statement.to_json_bytes(),
    ):
        _fail(
            "MEASUREMENT_TRUST_NONDETERMINISM",
            "fresh protected replay differs from authenticated statement",
        )
    return None


def verify_authenticated_decoded_capture_measurement_v1(
    statement: AuthenticatedDecodedCaptureMeasurementStatementV1,
    attestation: DecodedCaptureMeasurementAttestationV1,
    trust_snapshot: DecodedCaptureMeasurementTrustSnapshotV1,
    *,
    capture_invocation: CaptureSegmentVerificationInvocationV1,
    replay_invocation: CaptureMeasurementReplayInvocationV1,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    measurement_policy: DecodedCaptureMeasurementPolicyV1,
    expected_trust_snapshot_sha256: str,
    expected_trust_snapshot_generation: int,
    expected_current_attestation_sha256: str,
    expected_measurement_verifier_id: str,
    expected_trust_domain_id: str,
    expected_measurement_policy_sha256: str,
    expected_measurement_policy_generation: int,
    verified_at_ns: int,
) -> None:
    """Expose finite trust failures and no fabricable authority capability."""

    try:
        return _verify_authenticated_decoded_capture_measurement_v1_impl(
            statement,
            attestation,
            trust_snapshot,
            capture_invocation=capture_invocation,
            replay_invocation=replay_invocation,
            selected_video_stream_binding=selected_video_stream_binding,
            measurement_policy=measurement_policy,
            expected_trust_snapshot_sha256=expected_trust_snapshot_sha256,
            expected_trust_snapshot_generation=expected_trust_snapshot_generation,
            expected_current_attestation_sha256=(expected_current_attestation_sha256),
            expected_measurement_verifier_id=expected_measurement_verifier_id,
            expected_trust_domain_id=expected_trust_domain_id,
            expected_measurement_policy_sha256=expected_measurement_policy_sha256,
            expected_measurement_policy_generation=(
                expected_measurement_policy_generation
            ),
            verified_at_ns=verified_at_ns,
        )
    except DecodedCaptureMeasurementTrustError:
        raise
    except (KeyboardInterrupt, SystemExit):
        raise
    except (AttributeError, TypeError, ValueError) as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INPUT",
            "measurement verifier input is malformed",
        ) from exc
    except BaseException as exc:
        raise DecodedCaptureMeasurementTrustError(
            "MEASUREMENT_TRUST_INTERNAL",
            "measurement verifier failed internally",
        ) from exc


__all__ = [
    "AUTHENTICATED_DECODED_CAPTURE_MEASUREMENT_STATEMENT_DOMAIN",
    "DECODED_CAPTURE_MEASUREMENT_ATTESTATION_DOMAIN",
    "DECODED_CAPTURE_MEASUREMENT_SIGNING_DOMAIN",
    "DECODED_CAPTURE_MEASUREMENT_POLICY_DOMAIN",
    "DECODED_CAPTURE_MEASUREMENT_TRUST_SCHEMA_VERSION",
    "DECODED_CAPTURE_MEASUREMENT_TRUST_SNAPSHOT_DOMAIN",
    "AuthenticatedDecodedCaptureMeasurementStatementV1",
    "AuthenticatedDecodedCaptureMeasurementStatusV1",
    "CaptureMeasurementReplayInvocationV1",
    "CaptureSegmentVerificationInvocationV1",
    "CurrentDecodedCaptureMeasurementV1",
    "DecodedCaptureMeasurementAttestationV1",
    "DecodedCaptureMeasurementKeyRoleV1",
    "DecodedCaptureMeasurementPolicyV1",
    "DecodedCaptureMeasurementTrustError",
    "DecodedCaptureMeasurementTrustSnapshotV1",
    "TrustedDecodedCaptureMeasurementSignerKeyV1",
    "current_decoded_capture_measurement_v1",
    "decoded_capture_measurement_signing_message_v1",
    "sign_protected_decoded_capture_measurement_v1",
    "verify_authenticated_decoded_capture_measurement_v1",
]
