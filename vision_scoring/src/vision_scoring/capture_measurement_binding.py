"""Protected decoded-measurement binding for one current capture segment.

This coordinator never promotes the public, fabricable replay object.  It
starts the protected decoder replay itself, retains the exact replayed rows,
and binds those rows to one already-current private capture-segment evidence
capability plus independently pinned coordinates.  The private result is an
in-process handoff only and grants no training, evaluation, deployment, or
scoring authority.

The selected container stream index is not treated as a logical stream ID.
V1 requires a separately pinned structural mapping record and explicitly does
not claim that the mapped track is semantically or physically equivalent to
the logical camera stream.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
from pathlib import Path
from typing import Any

from .capture_measurement import (
    CaptureMeasurementError,
    _ProtectedCaptureMeasurementRowsV1,
    _replay_protected_capture_measurement_rows_v1,
)
from .capture_measurement_contracts import DecodedCaptureMeasurementReceiptV1
from .capture_measurement_rows import (
    DecodedFrameContentRowV1,
    DecodedMeasurementRecipeV1,
    PresentationTimingRowV1,
    SelectedVideoPacketPayloadRowV1,
    build_decoded_capture_measurement_receipt_v1,
)
from .capture_profile_contracts import VideoCodecV1
from .capture_segment import (
    FinalizedCaptureSegmentStatement,
    _VerifiedCaptureSegmentEvidence,
)
from .contract_wire import (
    MAX_SIGNED_64,
    canonical_json_bytes,
    enum_from_json,
    parse_canonical_json_object,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)


CAPTURE_MEASUREMENT_BINDING_SCHEMA_VERSION = "1.0"
SELECTED_VIDEO_STREAM_BINDING_DOMAIN = (
    "multicourt-vision-scoring:selected-video-stream-binding:v1"
)
LOGICAL_STREAM_EPOCH_DOMAIN = "multicourt-vision-scoring:logical-stream-epoch:v1"
SELECTED_FRAGMENT_SET_DOMAIN = (
    "multicourt-vision-scoring:ordered-selected-fragment-set:v1"
)
MAX_SELECTED_VIDEO_STREAM_BINDING_BYTES = 16 * 1024

_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class CaptureMeasurementBindingError(ValueError):
    """Fail-closed protected binding failure with a stable finite code."""

    _CODES = frozenset(
        {
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "CAPTURE_MEASUREMENT_BINDING_STREAM",
            "CAPTURE_MEASUREMENT_BINDING_REPLAY",
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
        }
    )

    def __init__(self, code: str, message: str) -> None:
        if code not in self._CODES:
            raise ValueError("capture measurement binding code is invalid")
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaptureMeasurementBindingError(code, message)


class SelectedVideoStreamMappingStatusV1(str, Enum):
    PINNED_CONTAINER_INDEX_MAPPING_CONTENT_EQUIVALENCE_NOT_PROVEN = (
        "PINNED_CONTAINER_INDEX_MAPPING_CONTENT_EQUIVALENCE_NOT_PROVEN"
    )


@dataclass(frozen=True, slots=True)
class SelectedVideoStreamBindingV1:
    """Fabricable mapping claim that becomes usable only through an external pin."""

    binding_id: str
    capture_segment_statement_sha256: str
    capture_metadata_sha256: str
    source_asset_sha256: str
    logical_stream_id: str
    selected_video_stream_index: int
    mapping_status: SelectedVideoStreamMappingStatusV1 = SelectedVideoStreamMappingStatusV1.PINNED_CONTAINER_INDEX_MAPPING_CONTENT_EQUIVALENCE_NOT_PROVEN
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_MEASUREMENT_BINDING_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_MEASUREMENT_BINDING_SCHEMA_VERSION:
            raise ValueError("selected stream binding schema is invalid")
        require_stable_id(self.binding_id, "binding_id")
        require_stable_id(self.logical_stream_id, "logical_stream_id")
        for field in (
            "capture_segment_statement_sha256",
            "capture_metadata_sha256",
            "source_asset_sha256",
        ):
            require_sha256(getattr(self, field), field)
        if (
            len(
                {
                    self.capture_segment_statement_sha256,
                    self.capture_metadata_sha256,
                    self.source_asset_sha256,
                }
            )
            != 3
        ):
            raise ValueError("selected stream typed digest roles alias")
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        if (
            type(self.mapping_status) is not SelectedVideoStreamMappingStatusV1
            or self.mapping_status
            is not SelectedVideoStreamMappingStatusV1.PINNED_CONTAINER_INDEX_MAPPING_CONTENT_EQUIVALENCE_NOT_PROVEN
        ):
            raise ValueError("selected stream mapping status is invalid")
        for field in _AUTHORITY_FIELDS:
            if getattr(self, field) is not False:
                raise ValueError(f"{field} must remain exactly false")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "admissible_for_deployment": self.admissible_for_deployment,
            "admissible_for_evaluation": self.admissible_for_evaluation,
            "admissible_for_live_scoring": self.admissible_for_live_scoring,
            "admissible_for_test": self.admissible_for_test,
            "admissible_for_training": self.admissible_for_training,
            "binding_id": self.binding_id,
            "capture_metadata_sha256": self.capture_metadata_sha256,
            "capture_segment_statement_sha256": (self.capture_segment_statement_sha256),
            "domain": SELECTED_VIDEO_STREAM_BINDING_DOMAIN,
            "logical_stream_id": self.logical_stream_id,
            "mapping_status": self.mapping_status.value,
            "schema_version": self.schema_version,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_asset_sha256": self.source_asset_sha256,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="selected video stream binding",
            maximum_bytes=MAX_SELECTED_VIDEO_STREAM_BINDING_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> SelectedVideoStreamBindingV1:
        fields = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label="selected video stream binding",
                maximum_bytes=MAX_SELECTED_VIDEO_STREAM_BINDING_BYTES,
                maximum_depth=3,
                maximum_nodes=32,
                maximum_containers=2,
            ),
            {"domain", *cls.__dataclass_fields__},
            label="selected video stream binding",
        )
        if fields.pop("domain") != SELECTED_VIDEO_STREAM_BINDING_DOMAIN:
            raise ValueError("selected video stream binding domain is invalid")
        fields["mapping_status"] = enum_from_json(
            SelectedVideoStreamMappingStatusV1,
            fields["mapping_status"],
            "mapping_status",
        )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("selected stream binding reconstruction changed bytes")
        return result


def _require_false_authorities(value: object, *, label: str) -> None:
    for field in _AUTHORITY_FIELDS:
        if getattr(value, field, None) is not False:
            _fail(
                "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
                f"{label} authority fields must remain false",
            )


def _require_capture_evidence_no_authority(
    value: _VerifiedCaptureSegmentEvidence,
) -> None:
    for field in (
        "admissible_for_live_scorecheck_presentation",
        "admissible_for_training",
        "admissible_for_evaluation",
        "admissible_for_deployment",
    ):
        if getattr(value, field, None) is not False:
            _fail(
                "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
                "capture segment evidence must remain non-authorizing",
            )


def _canonical_capture_statement(
    value: object,
) -> FinalizedCaptureSegmentStatement:
    if type(value) is not FinalizedCaptureSegmentStatement:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "capture statement has the wrong exact type",
        )
    try:
        reconstructed = FinalizedCaptureSegmentStatement.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "capture statement is not canonical",
        ) from exc
    if reconstructed != value:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "capture statement changed on reconstruction",
        )
    return reconstructed


def _canonical_stream_binding(value: object) -> SelectedVideoStreamBindingV1:
    if type(value) is not SelectedVideoStreamBindingV1:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_STREAM",
            "selected stream binding has the wrong exact type",
        )
    try:
        reconstructed = SelectedVideoStreamBindingV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_STREAM",
            "selected stream binding is not canonical",
        ) from exc
    if reconstructed != value:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_STREAM",
            "selected stream binding changed on reconstruction",
        )
    return reconstructed


def logical_stream_epoch_sha256_v1(statement: FinalizedCaptureSegmentStatement) -> str:
    """Commit one exact logical stream within one capture reconnect epoch."""

    canonical = _canonical_capture_statement(statement)
    metadata = canonical.capture_metadata
    payload = canonical_json_bytes(
        {
            "capture_session_id": metadata.capture_session_id,
            "deployment_id": metadata.deployment_id,
            "domain": LOGICAL_STREAM_EPOCH_DOMAIN,
            "match_id": metadata.match_id,
            "reconnect_epoch": metadata.reconnect_epoch,
            "session_configuration_fingerprint": (
                metadata.session_configuration_fingerprint
            ),
            "session_fingerprint": metadata.session_fingerprint,
            "stream_id": metadata.stream_id,
        },
        label="logical stream epoch",
        maximum_bytes=8 * 1024,
    )
    return hashlib.sha256(payload).hexdigest()


def ordered_selected_fragments_sha256_v1(
    statement: FinalizedCaptureSegmentStatement,
) -> str:
    """Commit ordered selected fragment identities without sorting them."""

    canonical = _canonical_capture_statement(statement)
    metadata = canonical.capture_metadata
    payload = canonical_json_bytes(
        {
            "domain": SELECTED_FRAGMENT_SET_DOMAIN,
            "fragments": [
                {"fragment_id": fragment_id, "fingerprint": fingerprint}
                for fragment_id, fingerprint in zip(
                    metadata.selected_fragment_ids,
                    metadata.selected_fragment_fingerprints,
                    strict=True,
                )
            ],
        },
        label="ordered selected fragment set",
        maximum_bytes=32 * 1024,
    )
    return hashlib.sha256(payload).hexdigest()


class _TransientCaptureMeasurementBindingV1:
    """Internal replay result retained only as canonical immutable row bytes."""

    __slots__ = (
        "_coordinates",
        "_decoded_frame_row_bytes",
        "_measurement_recipe_bytes",
        "_observed_codec_value",
        "_presentation_timing_row_bytes",
        "_receipt_bytes",
        "_selected_video_packet_row_bytes",
    )

    def __init__(
        self,
        *,
        coordinates: tuple[tuple[str, int | str], ...],
        protected_rows: _ProtectedCaptureMeasurementRowsV1,
    ) -> None:
        if (
            type(coordinates) is not tuple
            or not coordinates
            or any(type(item) is not tuple or len(item) != 2 for item in coordinates)
        ):
            raise ValueError("binding coordinates must be an exact tuple")
        keys = tuple(item[0] for item in coordinates)
        if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
            raise ValueError("binding coordinate keys must be unique and sorted")
        if type(protected_rows) is not _ProtectedCaptureMeasurementRowsV1:
            raise ValueError("protected rows have the wrong exact type")
        object.__setattr__(self, "_coordinates", coordinates)
        object.__setattr__(
            self,
            "_receipt_bytes",
            protected_rows.replay.receipt.to_json_bytes(),
        )
        object.__setattr__(
            self,
            "_measurement_recipe_bytes",
            protected_rows.measurement_recipe.to_json_bytes(),
        )
        object.__setattr__(
            self,
            "_observed_codec_value",
            protected_rows.observed_codec.value,
        )
        object.__setattr__(
            self,
            "_presentation_timing_row_bytes",
            tuple(
                row.to_json_bytes() for row in protected_rows.presentation_timing_rows
            ),
        )
        object.__setattr__(
            self,
            "_selected_video_packet_row_bytes",
            tuple(
                row.to_json_bytes() for row in protected_rows.selected_video_packet_rows
            ),
        )
        object.__setattr__(
            self,
            "_decoded_frame_row_bytes",
            tuple(row.to_json_bytes() for row in protected_rows.decoded_frame_rows),
        )
        self._reconstruct_and_validate_rows()

    def __setattr__(self, name: str, value: object) -> None:
        del name, value
        raise AttributeError("transient measurement bindings are immutable")

    def _coordinate(self, name: str) -> int | str:
        return dict(self._coordinates)[name]

    @property
    def capture_segment_statement_sha256(self) -> str:
        return str(self._coordinate("capture_segment_statement_sha256"))

    @property
    def capture_metadata_sha256(self) -> str:
        return str(self._coordinate("capture_metadata_sha256"))

    @property
    def measurement_receipt_sha256(self) -> str:
        return str(self._coordinate("measurement_receipt_sha256"))

    @property
    def logical_stream_epoch_sha256(self) -> str:
        return str(self._coordinate("logical_stream_epoch_sha256"))

    @property
    def decoded_frame_count(self) -> int:
        return int(self._coordinate("decoded_frame_count"))

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_test(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    @property
    def admissible_for_live_scoring(self) -> bool:
        return False

    def _exact_presentation_pts(self) -> tuple[int, ...]:
        presentation_rows, _, _, _ = self._reconstruct_and_validate_rows()
        values = tuple(row.presentation_pts for row in presentation_rows)
        if any(value is None for value in values):
            raise ValueError("transient binding contains missing presentation PTS")
        return values  # type: ignore[return-value]

    def _canonical_receipt(self) -> DecodedCaptureMeasurementReceiptV1:
        _, _, _, receipt = self._reconstruct_and_validate_rows()
        return receipt

    def _reconstruct_and_validate_rows(
        self,
    ) -> tuple[
        tuple[PresentationTimingRowV1, ...],
        tuple[SelectedVideoPacketPayloadRowV1, ...],
        tuple[DecodedFrameContentRowV1, ...],
        DecodedCaptureMeasurementReceiptV1,
    ]:
        try:
            receipt = DecodedCaptureMeasurementReceiptV1.from_json_bytes(
                self._receipt_bytes
            )
            recipe = DecodedMeasurementRecipeV1.from_json_bytes(
                self._measurement_recipe_bytes
            )
            observed_codec = VideoCodecV1(self._observed_codec_value)
            presentation_rows = tuple(
                PresentationTimingRowV1.from_json_bytes(raw)
                for raw in self._presentation_timing_row_bytes
            )
            packet_rows = tuple(
                SelectedVideoPacketPayloadRowV1.from_json_bytes(raw)
                for raw in self._selected_video_packet_row_bytes
            )
            frame_rows = tuple(
                DecodedFrameContentRowV1.from_json_bytes(raw)
                for raw in self._decoded_frame_row_bytes
            )
            rebuilt = build_decoded_capture_measurement_receipt_v1(
                source_id=receipt.source_id,
                source_asset_sha256=receipt.source_asset_sha256,
                source_asset_byte_length=receipt.source_asset_byte_length,
                artifact_generation_id=receipt.artifact_generation_id,
                selected_video_stream_index=receipt.selected_video_stream_index,
                decoder_runtime_manifest_sha256=(
                    receipt.decoder_runtime_manifest_sha256
                ),
                observed_codec=observed_codec,
                recipe=recipe,
                presentation_timing_rows=presentation_rows,
                selected_video_packet_rows=packet_rows,
                decoded_frame_rows=frame_rows,
            )
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("transient measurement row bytes are invalid") from exc
        if (
            rebuilt != receipt
            or receipt.fingerprint() != self.measurement_receipt_sha256
        ):
            raise ValueError("transient measurement rows differ from signed receipt")
        return presentation_rows, packet_rows, frame_rows, receipt

    def __reduce__(self) -> object:
        raise TypeError("transient measurement bindings are not serializable")

    def __reduce_ex__(self, protocol: int) -> object:
        del protocol
        raise TypeError("transient measurement bindings are not serializable")

    def __copy__(self) -> object:
        raise TypeError("transient measurement bindings are not copyable")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("transient measurement bindings are not copyable")


def _require_input_pins(
    *,
    statement: FinalizedCaptureSegmentStatement,
    evidence: _VerifiedCaptureSegmentEvidence,
    stream_binding: SelectedVideoStreamBindingV1,
    expected_capture_segment_statement_sha256: str,
    expected_capture_segment_attestation_sha256: str,
    expected_capture_segment_trust_snapshot_sha256: str,
    expected_capture_segment_trust_snapshot_generation: int,
    expected_capture_metadata_sha256: str,
    expected_selected_video_stream_binding_sha256: str,
    expected_selected_video_stream_index: int,
    expected_measurement_recipe_sha256: str,
) -> None:
    for value, label in (
        (
            expected_capture_segment_statement_sha256,
            "expected_capture_segment_statement_sha256",
        ),
        (
            expected_capture_segment_attestation_sha256,
            "expected_capture_segment_attestation_sha256",
        ),
        (
            expected_capture_segment_trust_snapshot_sha256,
            "expected_capture_segment_trust_snapshot_sha256",
        ),
        (expected_capture_metadata_sha256, "expected_capture_metadata_sha256"),
        (
            expected_selected_video_stream_binding_sha256,
            "expected_selected_video_stream_binding_sha256",
        ),
        (
            expected_measurement_recipe_sha256,
            "expected_measurement_recipe_sha256",
        ),
    ):
        require_sha256(value, label)
    require_exact_int(
        expected_capture_segment_trust_snapshot_generation,
        "expected_capture_segment_trust_snapshot_generation",
    )
    require_exact_int(
        expected_selected_video_stream_index,
        "expected_selected_video_stream_index",
        maximum=MAX_SIGNED_64,
    )
    statement_sha256 = statement.fingerprint()
    metadata_sha256 = statement.capture_metadata.fingerprint()
    if (
        not hmac.compare_digest(
            statement_sha256,
            expected_capture_segment_statement_sha256,
        )
        or not hmac.compare_digest(
            evidence.statement_sha256,
            expected_capture_segment_statement_sha256,
        )
        or not hmac.compare_digest(
            evidence.attestation_sha256,
            expected_capture_segment_attestation_sha256,
        )
        or not hmac.compare_digest(
            evidence.trust_snapshot_sha256,
            expected_capture_segment_trust_snapshot_sha256,
        )
        or evidence.trust_snapshot_generation
        != expected_capture_segment_trust_snapshot_generation
        or not hmac.compare_digest(metadata_sha256, expected_capture_metadata_sha256)
        or not hmac.compare_digest(
            stream_binding.fingerprint(),
            expected_selected_video_stream_binding_sha256,
        )
        or stream_binding.selected_video_stream_index
        != expected_selected_video_stream_index
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            "protected capture or stream pins differ from supplied evidence",
        )


def _replay_and_bind_capture_measurement_v1(
    *,
    capture_segment_statement: FinalizedCaptureSegmentStatement,
    capture_segment_evidence: _VerifiedCaptureSegmentEvidence,
    selected_video_stream_binding: SelectedVideoStreamBindingV1,
    expected_capture_segment_statement_sha256: str,
    expected_capture_segment_attestation_sha256: str,
    expected_capture_segment_trust_snapshot_sha256: str,
    expected_capture_segment_trust_snapshot_generation: int,
    expected_capture_metadata_sha256: str,
    expected_selected_video_stream_binding_sha256: str,
    expected_selected_video_stream_index: int,
    expected_measurement_recipe_sha256: str,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
    recipe: DecodedMeasurementRecipeV1,
) -> _TransientCaptureMeasurementBindingV1:
    """Replay and bind one asset for an immediate signer/verifier transaction."""

    statement = _canonical_capture_statement(capture_segment_statement)
    if type(capture_segment_evidence) is not _VerifiedCaptureSegmentEvidence:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "capture evidence is not the exact private verified capability",
        )
    evidence = capture_segment_evidence
    _require_capture_evidence_no_authority(evidence)
    try:
        require_sha256(evidence.statement_sha256, "capture evidence statement_sha256")
        require_sha256(
            evidence.attestation_sha256,
            "capture evidence attestation_sha256",
        )
        require_sha256(
            evidence.trust_snapshot_sha256,
            "capture evidence trust_snapshot_sha256",
        )
        require_exact_int(
            evidence.trust_snapshot_generation,
            "capture evidence trust_snapshot_generation",
        )
        require_exact_int(
            evidence.verified_at_ns,
            "capture evidence verified_at_ns",
        )
    except (TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "capture evidence coordinates are invalid",
        ) from exc
    if (
        evidence.segment_id != statement.segment_id
        or evidence.segment_sequence != statement.segment_sequence
        or evidence.capture_service_id != statement.capture_service_id
        or evidence.lineage_id != statement.lineage_id
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_CAPTURE",
            "private capture evidence differs from the capture statement",
        )
    stream_binding = _canonical_stream_binding(selected_video_stream_binding)
    _require_input_pins(
        statement=statement,
        evidence=evidence,
        stream_binding=stream_binding,
        expected_capture_segment_statement_sha256=(
            expected_capture_segment_statement_sha256
        ),
        expected_capture_segment_attestation_sha256=(
            expected_capture_segment_attestation_sha256
        ),
        expected_capture_segment_trust_snapshot_sha256=(
            expected_capture_segment_trust_snapshot_sha256
        ),
        expected_capture_segment_trust_snapshot_generation=(
            expected_capture_segment_trust_snapshot_generation
        ),
        expected_capture_metadata_sha256=expected_capture_metadata_sha256,
        expected_selected_video_stream_binding_sha256=(
            expected_selected_video_stream_binding_sha256
        ),
        expected_selected_video_stream_index=expected_selected_video_stream_index,
        expected_measurement_recipe_sha256=expected_measurement_recipe_sha256,
    )
    try:
        canonical_recipe_sha256 = recipe.fingerprint()
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            "measurement recipe is not canonical",
        ) from exc
    if not hmac.compare_digest(
        canonical_recipe_sha256,
        expected_measurement_recipe_sha256,
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_INPUT",
            "measurement recipe differs from its independent pin",
        )
    metadata = statement.capture_metadata
    if (
        stream_binding.capture_segment_statement_sha256 != statement.fingerprint()
        or stream_binding.capture_metadata_sha256 != metadata.fingerprint()
        or stream_binding.source_asset_sha256 != metadata.asset_sha256
        or stream_binding.logical_stream_id != metadata.stream_id
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_STREAM",
            "selected container index is not pinned to the capture asset scope",
        )

    try:
        protected_rows = _replay_protected_capture_measurement_rows_v1(
            source_id=metadata.asset_id,
            artifact_store_root=artifact_store_root,
            artifact_generation_id=artifact_generation_id,
            artifact_sha256s=artifact_sha256s,
            source_asset_sha256=metadata.asset_sha256,
            source_asset_byte_length=metadata.asset_byte_length,
            selected_video_stream_index=expected_selected_video_stream_index,
            runtime_store_root=runtime_store_root,
            runtime_generation_id=runtime_generation_id,
            runtime_manifest_sha256=runtime_manifest_sha256,
            expected_runtime_manifest_sha256=expected_runtime_manifest_sha256,
            expected_platform=expected_platform,
            expected_architecture=expected_architecture,
            expected_abi=expected_abi,
            expected_system_runtime_id=expected_system_runtime_id,
            expected_system_runtime_measurement_sha256=(
                expected_system_runtime_measurement_sha256
            ),
            recipe=recipe,
        )
    except CaptureMeasurementError as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_REPLAY",
            "protected decoded measurement replay failed",
        ) from exc
    if type(protected_rows) is not _ProtectedCaptureMeasurementRowsV1:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
            "protected replay returned the wrong private row capability",
        )
    try:
        protected_rows = _ProtectedCaptureMeasurementRowsV1(
            replay=protected_rows.replay,
            measurement_recipe=protected_rows.measurement_recipe,
            observed_codec=protected_rows.observed_codec,
            presentation_timing_rows=protected_rows.presentation_timing_rows,
            selected_video_packet_rows=protected_rows.selected_video_packet_rows,
            decoded_frame_rows=protected_rows.decoded_frame_rows,
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "protected replay rows failed exact reconstruction",
        ) from exc
    replay = protected_rows.replay
    receipt = replay.receipt
    try:
        receipt = DecodedCaptureMeasurementReceiptV1.from_json_bytes(
            receipt.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "measurement receipt is not canonical",
        ) from exc
    _require_false_authorities(replay, label="measurement replay")
    _require_false_authorities(receipt, label="measurement receipt")
    if (
        receipt.artifact_generation_id != artifact_generation_id
        or receipt.selected_video_stream_index != expected_selected_video_stream_index
        or replay.decoder_runtime_generation_id != runtime_generation_id
        or replay.decoder_runtime_manifest_sha256 != runtime_manifest_sha256
        or receipt.decoder_runtime_manifest_sha256 != runtime_manifest_sha256
        or receipt.measurement_recipe_sha256 != expected_measurement_recipe_sha256
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_REPLAY",
            "protected replay differs from pinned artifact, stream, runtime, or recipe",
        )
    presentation_pts = tuple(
        row.presentation_pts for row in protected_rows.presentation_timing_rows
    )
    if any(value is None for value in presentation_pts) or any(
        current <= previous
        for previous, current in zip(
            presentation_pts,
            presentation_pts[1:],
            strict=False,
        )
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "protected presentation PTS are missing, duplicate, or regressing",
        )
    expected_capture_join = (
        metadata.asset_id,
        metadata.asset_sha256,
        metadata.asset_byte_length,
        metadata.frame_count,
        metadata.source_start_pts,
        metadata.source_end_pts,
        metadata.source_time_base_numerator,
        metadata.source_time_base_denominator,
    )
    observed_measurement_join = (
        receipt.source_id,
        receipt.source_asset_sha256,
        receipt.source_asset_byte_length,
        receipt.decoded_frame_count,
        receipt.first_presentation_pts,
        receipt.last_presentation_pts,
        receipt.source_time_base_numerator,
        receipt.source_time_base_denominator,
    )
    if observed_measurement_join != expected_capture_join:
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "decoded receipt differs from capture asset identity or trace endpoints",
        )
    if (
        presentation_pts[0] != metadata.source_start_pts
        or presentation_pts[-1] != metadata.source_end_pts
        or len(presentation_pts) != metadata.frame_count
    ):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_ROWS",
            "replayed PTS rows differ from capture trace boundaries",
        )

    coordinates: dict[str, int | str] = {
        "actual_end_ns": metadata.actual_end_ns,
        "actual_start_ns": metadata.actual_start_ns,
        "asset_claim_sha256": metadata.asset_claim_sha256,
        "asset_id": metadata.asset_id,
        "artifact_generation_id": receipt.artifact_generation_id,
        "camera_id": metadata.camera_id,
        "capture_metadata_attestation_sha256": (
            statement.capture_metadata_attestation_sha256
        ),
        "capture_metadata_id": metadata.metadata_id,
        "capture_metadata_sha256": metadata.fingerprint(),
        "capture_profile_sha256": metadata.capture_profile_sha256,
        "capture_service_id": statement.capture_service_id,
        "capture_segment_attestation_sha256": evidence.attestation_sha256,
        "capture_segment_statement_sha256": evidence.statement_sha256,
        "capture_segment_trust_snapshot_generation": (
            evidence.trust_snapshot_generation
        ),
        "capture_segment_trust_snapshot_sha256": evidence.trust_snapshot_sha256,
        "capture_segment_verified_at_ns": evidence.verified_at_ns,
        "capture_measurement_command_recipe_sha256": (
            replay.capture_measurement_command_recipe_sha256
        ),
        "capture_session_id": metadata.capture_session_id,
        "clock_mapping_fingerprint": metadata.clock_mapping_fingerprint,
        "constant_presentation_pts_delta": (receipt.constant_presentation_pts_delta),
        "decoded_height_px": receipt.decoded_height_px,
        "decoded_frame_count": receipt.decoded_frame_count,
        "decoded_frame_rows_sha256": receipt.decoded_frame_rows_sha256,
        "decoded_width_px": receipt.decoded_width_px,
        "decoder_runtime_generation_id": replay.decoder_runtime_generation_id,
        "decoder_runtime_id": replay.decoder_runtime_id,
        "decoder_runtime_manifest_sha256": (replay.decoder_runtime_manifest_sha256),
        "evidence_end_ns": metadata.evidence_end_ns,
        "evidence_start_ns": metadata.evidence_start_ns,
        "encoder_configuration_sha256": metadata.encoder_configuration_sha256,
        "finalized_trace_sha256": metadata.finalized_trace_sha256,
        "first_presentation_pts": presentation_pts[0],  # type: ignore[dict-item]
        "first_decoded_pixel_sha256": (
            protected_rows.decoded_frame_rows[0].decoded_pixel_sha256
        ),
        "framehash_output_sha256": replay.framehash_output_sha256,
        "integrity_report_sha256": metadata.integrity_report_sha256,
        "interlace_observation": receipt.interlace_observation.value,
        "last_presentation_pts": presentation_pts[-1],  # type: ignore[dict-item]
        "last_decoded_pixel_sha256": (
            protected_rows.decoded_frame_rows[-1].decoded_pixel_sha256
        ),
        "lineage_id": statement.lineage_id,
        "logical_stream_epoch_sha256": logical_stream_epoch_sha256_v1(statement),
        "match_id": metadata.match_id,
        "measurement_analysis_status": receipt.measurement_analysis_status.value,
        "measurement_receipt_sha256": receipt.fingerprint(),
        "measurement_recipe_sha256": receipt.measurement_recipe_sha256,
        "metadata_output_sha256": replay.metadata_output_sha256,
        "observed_codec": receipt.observed_codec.value,
        "ordered_selected_fragments_sha256": (
            ordered_selected_fragments_sha256_v1(statement)
        ),
        "packet_output_sha256": replay.packet_output_sha256,
        "presentation_timing_rows_sha256": (receipt.presentation_timing_rows_sha256),
        "reconnect_epoch": metadata.reconnect_epoch,
        "sample_aspect_ratio_denominator": receipt.sample_aspect_ratio_denominator,
        "sample_aspect_ratio_numerator": receipt.sample_aspect_ratio_numerator,
        "segment_id": statement.segment_id,
        "segment_sequence": statement.segment_sequence,
        "selected_video_packet_rows_sha256": (
            receipt.selected_video_packet_rows_sha256
        ),
        "selected_video_stream_binding_sha256": stream_binding.fingerprint(),
        "selected_video_stream_index": receipt.selected_video_stream_index,
        "selected_video_stream_mapping_status": stream_binding.mapping_status.value,
        "session_configuration_fingerprint": (
            metadata.session_configuration_fingerprint
        ),
        "session_fingerprint": metadata.session_fingerprint,
        "source_asset_byte_length": receipt.source_asset_byte_length,
        "source_asset_sha256": receipt.source_asset_sha256,
        "source_id": receipt.source_id,
        "source_time_base_denominator": receipt.source_time_base_denominator,
        "source_time_base_numerator": receipt.source_time_base_numerator,
        "stream_id": metadata.stream_id,
        "cadence_denominator": receipt.cadence_denominator,
        "cadence_numerator": receipt.cadence_numerator,
        "cadence_status": receipt.cadence_status.value,
        "display_rotation_degrees": receipt.display_rotation_degrees,
    }
    typed_digest_keys = (
        "asset_claim_sha256",
        "artifact_generation_id",
        "capture_metadata_attestation_sha256",
        "capture_metadata_sha256",
        "capture_profile_sha256",
        "capture_segment_attestation_sha256",
        "capture_segment_statement_sha256",
        "capture_segment_trust_snapshot_sha256",
        "clock_mapping_fingerprint",
        "decoded_frame_rows_sha256",
        "decoder_runtime_generation_id",
        "decoder_runtime_manifest_sha256",
        "encoder_configuration_sha256",
        "finalized_trace_sha256",
        "framehash_output_sha256",
        "integrity_report_sha256",
        "logical_stream_epoch_sha256",
        "measurement_receipt_sha256",
        "measurement_recipe_sha256",
        "metadata_output_sha256",
        "ordered_selected_fragments_sha256",
        "packet_output_sha256",
        "presentation_timing_rows_sha256",
        "selected_video_packet_rows_sha256",
        "selected_video_stream_binding_sha256",
        "session_configuration_fingerprint",
        "session_fingerprint",
        "source_asset_sha256",
        "capture_measurement_command_recipe_sha256",
    )
    typed_digests = tuple(str(coordinates[key]) for key in typed_digest_keys)
    for key, digest in zip(typed_digest_keys, typed_digests, strict=True):
        try:
            require_sha256(digest, key)
        except ValueError as exc:
            raise CaptureMeasurementBindingError(
                "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
                "binding typed digest is invalid",
            ) from exc
    if len(set(typed_digests)) != len(typed_digests):
        _fail(
            "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
            "binding typed digest roles alias",
        )
    try:
        result = _TransientCaptureMeasurementBindingV1(
            coordinates=tuple(sorted(coordinates.items())),
            protected_rows=protected_rows,
        )
    except (TypeError, ValueError) as exc:
        raise CaptureMeasurementBindingError(
            "CAPTURE_MEASUREMENT_BINDING_INTERNAL",
            "transient measurement binding construction failed",
        ) from exc
    _require_false_authorities(result, label="transient measurement binding")
    return result


__all__ = [
    "CAPTURE_MEASUREMENT_BINDING_SCHEMA_VERSION",
    "LOGICAL_STREAM_EPOCH_DOMAIN",
    "SELECTED_FRAGMENT_SET_DOMAIN",
    "SELECTED_VIDEO_STREAM_BINDING_DOMAIN",
    "CaptureMeasurementBindingError",
    "SelectedVideoStreamBindingV1",
    "SelectedVideoStreamMappingStatusV1",
    "logical_stream_epoch_sha256_v1",
    "ordered_selected_fragments_sha256_v1",
]
