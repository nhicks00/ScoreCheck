"""Canonical, non-authorizing capture-profile classification contracts.

V1 records capture facts exactly.  It does not estimate cadence, infer a
compression class from bitrate, invent a device-to-stream mapping, or grant
training/live-scoring authority.  Classification is deliberately narrow:
only exact progressive CFR 1080p30, 1080p60, and UHD 4K60 inputs are named.
Everything else produces an explicit abstention receipt.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import math
from typing import Any, ClassVar

from .contract_wire import (
    MAX_SIGNED_64,
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


CAPTURE_PROFILE_SCHEMA_VERSION = "1.0"
MAX_CAPTURE_PROFILE_CONTRACT_BYTES = 128 * 1024
MAX_CAPTURE_VIEWS = 16

ENCODER_CONFIGURATION_DESCRIPTOR_DOMAIN = (
    "multicourt-vision-scoring:encoder-configuration-descriptor:v1"
)
CAPTURE_PROFILE_DESCRIPTOR_DOMAIN = (
    "multicourt-vision-scoring:capture-profile-descriptor:v1"
)
SOURCE_CAPTURE_FACTS_DOMAIN = "multicourt-vision-scoring:source-capture-facts:v1"
SOURCE_CLASSIFICATION_PROOF_SET_DOMAIN = (
    "multicourt-vision-scoring:source-classification-proof-set:v1"
)
CAPTURE_CLASSIFICATION_PROOF_SET_DOMAIN = (
    "multicourt-vision-scoring:capture-classification-proof-set:v1"
)
CAPTURE_PROFILE_CLASSIFICATION_DOMAIN = (
    "multicourt-vision-scoring:capture-profile-classification:v1"
)

_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class TrainingCaptureModeV1(str, Enum):
    """Exact single-encoded-view modes supported by the V1 classifier."""

    HD_1080P30 = "1080P30"
    HD_1080P60 = "1080P60"
    UHD_4K60 = "4K60"


class CompressionStratumV1(str, Enum):
    """Explicit operator classification; never derived from nominal bitrate."""

    LOSSLESS_OR_INTRA = "LOSSLESS_OR_INTRA"
    HIGH_BITRATE_INTERFRAME = "HIGH_BITRATE_INTERFRAME"
    CONSTRAINED_INTERFRAME = "CONSTRAINED_INTERFRAME"


class CaptureRiskTagV1(str, Enum):
    COMPATIBILITY_1080P30 = "COMPATIBILITY_1080P30"
    SINGLE_VIEW_OCCLUSION = "SINGLE_VIEW_OCCLUSION"
    MULTI_VIEW_SYNCHRONIZATION = "MULTI_VIEW_SYNCHRONIZATION"
    LOW_LIGHT = "LOW_LIGHT"
    HIGH_COMPRESSION = "HIGH_COMPRESSION"
    MOTION_BLUR = "MOTION_BLUR"


class VideoCodecV1(str, Enum):
    AVC_H264 = "AVC_H264"
    HEVC_H265 = "HEVC_H265"
    PRORES = "PRORES"
    RAW = "RAW"
    OTHER = "OTHER"
    UNKNOWN = "UNKNOWN"


class CodingStructureV1(str, Enum):
    LOSSLESS = "LOSSLESS"
    INTRA_ONLY = "INTRA_ONLY"
    INTERFRAME = "INTERFRAME"


class CaptureTransportV1(str, Enum):
    RTMP = "RTMP"
    SRT = "SRT"
    FILE = "FILE"
    LOCAL_CAPTURE = "LOCAL_CAPTURE"
    OTHER = "OTHER"


class SourceRepresentationV1(str, Enum):
    LIVE_ENCODER_OUTPUT = "LIVE_ENCODER_OUTPUT"
    ORIGINAL_CAMERA_MASTER = "ORIGINAL_CAMERA_MASTER"
    PLATFORM_TRANSCODE = "PLATFORM_TRANSCODE"
    PHONE_OR_CONSUMER_CAPTURE = "PHONE_OR_CONSUMER_CAPTURE"
    UNKNOWN = "UNKNOWN"


class ScanTypeV1(str, Enum):
    PROGRESSIVE = "PROGRESSIVE"
    INTERLACED = "INTERLACED"
    UNKNOWN = "UNKNOWN"


class CadenceTypeV1(str, Enum):
    CFR = "CFR"
    VFR = "VFR"
    UNKNOWN = "UNKNOWN"


class NominalBitrateBasisV1(str, Enum):
    OWNER_DECLARED = "OWNER_DECLARED"
    ENCODER_CONFIGURATION = "ENCODER_CONFIGURATION"
    CONTAINER_METADATA = "CONTAINER_METADATA"
    MEASURED_PAYLOAD = "MEASURED_PAYLOAD"
    UNKNOWN = "UNKNOWN"


class CaptureSourceClassificationV1(str, Enum):
    OWNER_PRODUCED_LIVE = "OWNER_PRODUCED_LIVE"
    OWNER_PRODUCED_ARCHIVE = "OWNER_PRODUCED_ARCHIVE"
    PHONE_OR_CONSUMER_CAMERA = "PHONE_OR_CONSUMER_CAMERA"
    EXTERNAL_OR_UNKNOWN = "EXTERNAL_OR_UNKNOWN"


class DeviceScopeV1(str, Enum):
    DEVICE_MODEL = "DEVICE_MODEL"
    DEVICE_CLASS = "DEVICE_CLASS"
    EXACT_DEVICE = "EXACT_DEVICE"


class LensTopologyV1(str, Enum):
    SINGLE_LENS = "SINGLE_LENS"
    MULTI_LENS = "MULTI_LENS"
    UNKNOWN = "UNKNOWN"


class ViewTopologyV1(str, Enum):
    SINGLE_VIEW = "SINGLE_VIEW"
    COMPOSITE_MULTI_VIEW = "COMPOSITE_MULTI_VIEW"
    UNKNOWN = "UNKNOWN"


class CaptureClassificationStatusV1(str, Enum):
    CLASSIFIED = "CLASSIFIED"
    ABSTAINED = "ABSTAINED"


class CaptureClassificationAbstentionV1(str, Enum):
    UNSUPPORTED_VIEW_TOPOLOGY = "UNSUPPORTED_VIEW_TOPOLOGY"
    UNSUPPORTED_CODEC = "UNSUPPORTED_CODEC"
    INCOMPLETE_SOURCE_PROVENANCE = "INCOMPLETE_SOURCE_PROVENANCE"
    UNKNOWN_SCAN = "UNKNOWN_SCAN"
    INTERLACED = "INTERLACED"
    UNKNOWN_CADENCE = "UNKNOWN_CADENCE"
    VARIABLE_FRAME_RATE = "VARIABLE_FRAME_RATE"
    UNSUPPORTED_GEOMETRY = "UNSUPPORTED_GEOMETRY"
    UNSUPPORTED_CADENCE = "UNSUPPORTED_CADENCE"


def _require_exact_enum(value: object, enum_type: type[Enum], field_name: str) -> None:
    if type(value) is not enum_type:
        raise ValueError(f"{field_name} must be an exact {enum_type.__name__}")


def _require_schema_version(value: object, label: str) -> None:
    if type(value) is not str or value != CAPTURE_PROFILE_SCHEMA_VERSION:
        raise ValueError(
            f"{label} schema_version must be exactly "
            f"{CAPTURE_PROFILE_SCHEMA_VERSION!r}"
        )


def _require_exact_bool(value: object, field_name: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{field_name} must be an exact boolean")
    return value


def _require_optional_stable_id(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return require_stable_id(value, field_name)


def _require_distinct_digests(
    values: tuple[tuple[str, object], ...], *, label: str
) -> tuple[str, ...]:
    digests = tuple(require_sha256(value, field) for field, value in values)
    if len(digests) != len(set(digests)):
        raise ValueError(f"{label} typed digest roles must not alias")
    return digests


def _require_source_risk_tags(
    value: tuple[CaptureRiskTagV1, ...],
) -> tuple[CaptureRiskTagV1, ...]:
    require_canonical_tuple(
        value,
        "source_risk_tags",
        minimum=0,
        maximum=2,
        validator=lambda item, field: _require_exact_enum(
            item, CaptureRiskTagV1, field
        ),
    )
    permitted = {CaptureRiskTagV1.LOW_LIGHT, CaptureRiskTagV1.MOTION_BLUR}
    if not set(value) <= permitted:
        raise ValueError(
            "source_risk_tags may contain only LOW_LIGHT and MOTION_BLUR"
        )
    return value


def _parse_contract(
    raw: bytes,
    *,
    label: str,
    domain: str,
    fields: set[str],
    maximum_depth: int,
    maximum_nodes: int,
    maximum_containers: int,
) -> dict[str, Any]:
    payload = require_exact_fields(
        parse_canonical_json_object(
            raw,
            label=label,
            maximum_bytes=MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
            maximum_depth=maximum_depth,
            maximum_nodes=maximum_nodes,
            maximum_containers=maximum_containers,
        ),
        {"domain", *fields},
        label=label,
    )
    if payload.pop("domain") != domain:
        raise ValueError(f"{label} domain is invalid")
    return payload


def _contract_field_names(contract_type: type[object]) -> set[str]:
    return {
        name
        for name in contract_type.__dataclass_fields__  # type: ignore[attr-defined]
        if not name.startswith("_")
    }


def _nested_contract_fields(
    value: object,
    *,
    contract_type: type[object],
    domain: str,
    label: str,
) -> dict[str, Any]:
    fields = require_exact_fields(
        value,
        {"domain", *_contract_field_names(contract_type)},
        label=label,
    )
    if fields["domain"] != domain:
        raise ValueError(f"{label} domain is invalid")
    return {key: item for key, item in fields.items() if key != "domain"}


class _CanonicalContract:
    _DOMAIN: ClassVar[str]
    _LABEL: ClassVar[str]

    def to_dict(self) -> dict[str, Any]:
        raise NotImplementedError

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label=self._LABEL,
            maximum_bytes=MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class EncoderConfigurationDescriptorV1(_CanonicalContract):
    """Exact facts for one encoded representation, not a decoder probe."""

    encoder_configuration_id: str
    codec: VideoCodecV1
    coding_structure: CodingStructureV1
    transport: CaptureTransportV1
    source_representation: SourceRepresentationV1
    width_px: int
    height_px: int
    scan_type: ScanTypeV1
    cadence_type: CadenceTypeV1
    cadence_numerator: int
    cadence_denominator: int
    nominal_bitrate_bps: int
    nominal_bitrate_basis: NominalBitrateBasisV1
    encoder_settings_sha256: str
    schema_version: str = CAPTURE_PROFILE_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = ENCODER_CONFIGURATION_DESCRIPTOR_DOMAIN
    _LABEL: ClassVar[str] = "encoder configuration descriptor"

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, self._LABEL)
        require_stable_id(
            self.encoder_configuration_id, "encoder_configuration_id"
        )
        for field_name, enum_type in (
            ("codec", VideoCodecV1),
            ("coding_structure", CodingStructureV1),
            ("transport", CaptureTransportV1),
            ("source_representation", SourceRepresentationV1),
            ("scan_type", ScanTypeV1),
            ("cadence_type", CadenceTypeV1),
            ("nominal_bitrate_basis", NominalBitrateBasisV1),
        ):
            _require_exact_enum(getattr(self, field_name), enum_type, field_name)
        require_exact_int(self.width_px, "width_px", minimum=1, maximum=16_384)
        require_exact_int(self.height_px, "height_px", minimum=1, maximum=16_384)
        if self.cadence_type is CadenceTypeV1.CFR:
            require_exact_int(
                self.cadence_numerator,
                "cadence_numerator",
                minimum=1,
                maximum=1_000_000,
            )
            require_exact_int(
                self.cadence_denominator,
                "cadence_denominator",
                minimum=1,
                maximum=1_000_000,
            )
            if math.gcd(self.cadence_numerator, self.cadence_denominator) != 1:
                raise ValueError("CFR cadence must be an exact reduced rational")
        else:
            require_exact_int(
                self.cadence_numerator,
                "cadence_numerator",
                minimum=0,
                maximum=0,
            )
            require_exact_int(
                self.cadence_denominator,
                "cadence_denominator",
                minimum=0,
                maximum=0,
            )
        if self.nominal_bitrate_basis is NominalBitrateBasisV1.UNKNOWN:
            require_exact_int(
                self.nominal_bitrate_bps,
                "nominal_bitrate_bps",
                minimum=0,
                maximum=0,
            )
        else:
            require_exact_int(
                self.nominal_bitrate_bps,
                "nominal_bitrate_bps",
                minimum=1,
                maximum=MAX_SIGNED_64,
            )
        if (
            self.codec is VideoCodecV1.RAW
            and self.coding_structure is not CodingStructureV1.LOSSLESS
        ):
            raise ValueError("RAW codec requires LOSSLESS coding_structure")
        if (
            self.codec is VideoCodecV1.PRORES
            and self.coding_structure is not CodingStructureV1.INTRA_ONLY
        ):
            raise ValueError("PRORES codec requires INTRA_ONLY coding_structure")
        require_sha256(self.encoder_settings_sha256, "encoder_settings_sha256")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "cadence_denominator": self.cadence_denominator,
            "cadence_numerator": self.cadence_numerator,
            "cadence_type": self.cadence_type.value,
            "codec": self.codec.value,
            "coding_structure": self.coding_structure.value,
            "domain": self._DOMAIN,
            "encoder_configuration_id": self.encoder_configuration_id,
            "encoder_settings_sha256": self.encoder_settings_sha256,
            "height_px": self.height_px,
            "nominal_bitrate_basis": self.nominal_bitrate_basis.value,
            "nominal_bitrate_bps": self.nominal_bitrate_bps,
            "scan_type": self.scan_type.value,
            "schema_version": self.schema_version,
            "source_representation": self.source_representation.value,
            "transport": self.transport.value,
            "width_px": self.width_px,
        }

    @classmethod
    def from_dict(cls, value: object) -> "EncoderConfigurationDescriptorV1":
        fields = require_exact_fields(
            value,
            _contract_field_names(cls),
            label=cls._LABEL,
        )
        for field_name, enum_type in (
            ("codec", VideoCodecV1),
            ("coding_structure", CodingStructureV1),
            ("transport", CaptureTransportV1),
            ("source_representation", SourceRepresentationV1),
            ("scan_type", ScanTypeV1),
            ("cadence_type", CadenceTypeV1),
            ("nominal_bitrate_basis", NominalBitrateBasisV1),
        ):
            fields[field_name] = enum_from_json(
                enum_type, fields[field_name], field_name
            )
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "EncoderConfigurationDescriptorV1":
        fields = _parse_contract(
            raw,
            label=cls._LABEL,
            domain=cls._DOMAIN,
            fields=_contract_field_names(cls),
            maximum_depth=3,
            maximum_nodes=32,
            maximum_containers=2,
        )
        result = cls.from_dict(fields)
        if result.to_json_bytes() != raw:
            raise ValueError(
                "encoder configuration descriptor reconstruction changed bytes"
            )
        return result


@dataclass(frozen=True, slots=True)
class CaptureProfileDescriptorV1(_CanonicalContract):
    """Reusable device/topology facts bound to an encoder descriptor."""

    capture_profile_id: str
    device_scope: DeviceScopeV1
    device_model_or_class: str
    exact_device_id: str | None
    lens_topology: LensTopologyV1
    view_topology: ViewTopologyV1
    view_count: int
    encoder_configuration_sha256: str
    compression_stratum: CompressionStratumV1
    calibration_sha256: str
    clock_model_sha256: str
    camera_attestation_sha256: str
    exposure_descriptor_sha256: str
    schema_version: str = CAPTURE_PROFILE_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = CAPTURE_PROFILE_DESCRIPTOR_DOMAIN
    _LABEL: ClassVar[str] = "capture profile descriptor"

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, self._LABEL)
        require_stable_id(self.capture_profile_id, "capture_profile_id")
        _require_exact_enum(self.device_scope, DeviceScopeV1, "device_scope")
        require_stable_id(self.device_model_or_class, "device_model_or_class")
        _require_optional_stable_id(self.exact_device_id, "exact_device_id")
        if self.device_scope is DeviceScopeV1.EXACT_DEVICE:
            if self.exact_device_id is None:
                raise ValueError("EXACT_DEVICE scope requires exact_device_id")
        elif self.exact_device_id is not None:
            raise ValueError("model/class device scope forbids exact_device_id")
        _require_exact_enum(self.lens_topology, LensTopologyV1, "lens_topology")
        _require_exact_enum(self.view_topology, ViewTopologyV1, "view_topology")
        require_exact_int(
            self.view_count, "view_count", minimum=1, maximum=MAX_CAPTURE_VIEWS
        )
        if (
            self.view_topology is ViewTopologyV1.SINGLE_VIEW
            and self.view_count != 1
        ):
            raise ValueError("SINGLE_VIEW topology requires view_count=1")
        if (
            self.view_topology is ViewTopologyV1.COMPOSITE_MULTI_VIEW
            and self.view_count < 2
        ):
            raise ValueError(
                "COMPOSITE_MULTI_VIEW topology requires at least two views"
            )
        _require_exact_enum(
            self.compression_stratum,
            CompressionStratumV1,
            "compression_stratum",
        )
        _require_distinct_digests(
            (
                (
                    "encoder_configuration_sha256",
                    self.encoder_configuration_sha256,
                ),
                ("calibration_sha256", self.calibration_sha256),
                ("clock_model_sha256", self.clock_model_sha256),
                (
                    "camera_attestation_sha256",
                    self.camera_attestation_sha256,
                ),
                (
                    "exposure_descriptor_sha256",
                    self.exposure_descriptor_sha256,
                ),
            ),
            label=self._LABEL,
        )
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "calibration_sha256": self.calibration_sha256,
            "camera_attestation_sha256": self.camera_attestation_sha256,
            "capture_profile_id": self.capture_profile_id,
            "clock_model_sha256": self.clock_model_sha256,
            "compression_stratum": self.compression_stratum.value,
            "device_model_or_class": self.device_model_or_class,
            "device_scope": self.device_scope.value,
            "domain": self._DOMAIN,
            "encoder_configuration_sha256": self.encoder_configuration_sha256,
            "exact_device_id": self.exact_device_id,
            "exposure_descriptor_sha256": self.exposure_descriptor_sha256,
            "lens_topology": self.lens_topology.value,
            "schema_version": self.schema_version,
            "view_count": self.view_count,
            "view_topology": self.view_topology.value,
        }

    @classmethod
    def from_dict(cls, value: object) -> "CaptureProfileDescriptorV1":
        fields = require_exact_fields(
            value, _contract_field_names(cls), label=cls._LABEL
        )
        for field_name, enum_type in (
            ("device_scope", DeviceScopeV1),
            ("lens_topology", LensTopologyV1),
            ("view_topology", ViewTopologyV1),
            ("compression_stratum", CompressionStratumV1),
        ):
            fields[field_name] = enum_from_json(
                enum_type, fields[field_name], field_name
            )
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureProfileDescriptorV1":
        fields = _parse_contract(
            raw,
            label=cls._LABEL,
            domain=cls._DOMAIN,
            fields=_contract_field_names(cls),
            maximum_depth=4,
            maximum_nodes=48,
            maximum_containers=4,
        )
        result = cls.from_dict(fields)
        if result.to_json_bytes() != raw:
            raise ValueError("capture profile descriptor reconstruction changed bytes")
        return result


@dataclass(frozen=True, slots=True)
class SourceCaptureFactsV1(_CanonicalContract):
    """Per-recording source provenance and observed capture risks."""

    source_id: str
    capture_profile_sha256: str
    source_classification: CaptureSourceClassificationV1
    source_provenance_complete: bool
    source_risk_tags: tuple[CaptureRiskTagV1, ...]
    schema_version: str = CAPTURE_PROFILE_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = SOURCE_CAPTURE_FACTS_DOMAIN
    _LABEL: ClassVar[str] = "source capture facts"

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, self._LABEL)
        require_stable_id(self.source_id, "source_id")
        require_sha256(self.capture_profile_sha256, "capture_profile_sha256")
        _require_exact_enum(
            self.source_classification,
            CaptureSourceClassificationV1,
            "source_classification",
        )
        _require_exact_bool(
            self.source_provenance_complete, "source_provenance_complete"
        )
        _require_source_risk_tags(self.source_risk_tags)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_profile_sha256": self.capture_profile_sha256,
            "domain": self._DOMAIN,
            "schema_version": self.schema_version,
            "source_classification": self.source_classification.value,
            "source_id": self.source_id,
            "source_provenance_complete": self.source_provenance_complete,
            "source_risk_tags": [item.value for item in self.source_risk_tags],
        }

    @classmethod
    def from_dict(cls, value: object) -> "SourceCaptureFactsV1":
        fields = require_exact_fields(
            value, _contract_field_names(cls), label=cls._LABEL
        )
        fields["source_classification"] = enum_from_json(
            CaptureSourceClassificationV1,
            fields["source_classification"],
            "source_classification",
        )
        fields["source_risk_tags"] = tuple(
            enum_from_json(CaptureRiskTagV1, item, "source_risk_tags")
            for item in exact_list(fields, "source_risk_tags", label=cls._LABEL)
        )
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "SourceCaptureFactsV1":
        fields = _parse_contract(
            raw,
            label=cls._LABEL,
            domain=cls._DOMAIN,
            fields=_contract_field_names(cls),
            maximum_depth=4,
            maximum_nodes=24,
            maximum_containers=4,
        )
        result = cls.from_dict(fields)
        if result.to_json_bytes() != raw:
            raise ValueError("source capture facts reconstruction changed bytes")
        return result


def source_classification_proof_set_sha256_v1(
    encoder_configuration: EncoderConfigurationDescriptorV1,
    capture_profile: CaptureProfileDescriptorV1,
    source_capture_facts: SourceCaptureFactsV1,
) -> str:
    if type(encoder_configuration) is not EncoderConfigurationDescriptorV1:
        raise ValueError("encoder_configuration must be an exact V1 descriptor")
    if type(capture_profile) is not CaptureProfileDescriptorV1:
        raise ValueError("capture_profile must be an exact V1 descriptor")
    if type(source_capture_facts) is not SourceCaptureFactsV1:
        raise ValueError("source_capture_facts must be exact V1 facts")
    if (
        capture_profile.encoder_configuration_sha256
        != encoder_configuration.fingerprint()
    ):
        raise ValueError("capture profile does not bind the encoder descriptor")
    if source_capture_facts.capture_profile_sha256 != capture_profile.fingerprint():
        raise ValueError("source capture facts do not bind the capture profile")
    return hashlib.sha256(
        canonical_json_bytes(
            {
                "bitrate_basis": encoder_configuration.nominal_bitrate_basis.value,
                "capture_profile_sha256": source_capture_facts.capture_profile_sha256,
                "domain": SOURCE_CLASSIFICATION_PROOF_SET_DOMAIN,
                "encoder_configuration_sha256": (
                    capture_profile.encoder_configuration_sha256
                ),
                "source_representation": (
                    encoder_configuration.source_representation.value
                ),
                "schema_version": CAPTURE_PROFILE_SCHEMA_VERSION,
                "source_capture_facts_sha256": source_capture_facts.fingerprint(),
                "source_classification": (
                    source_capture_facts.source_classification.value
                ),
                "source_id": source_capture_facts.source_id,
                "source_provenance_complete": (
                    source_capture_facts.source_provenance_complete
                ),
                "source_risk_tags": [
                    item.value for item in source_capture_facts.source_risk_tags
                ],
                "transport": encoder_configuration.transport.value,
            },
            label="source classification proof set",
            maximum_bytes=MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
        )
    ).hexdigest()


def capture_classification_proof_set_sha256_v1(
    encoder_configuration: EncoderConfigurationDescriptorV1,
    capture_profile: CaptureProfileDescriptorV1,
    source_capture_facts: SourceCaptureFactsV1,
) -> str:
    if type(encoder_configuration) is not EncoderConfigurationDescriptorV1:
        raise ValueError("encoder_configuration must be an exact V1 descriptor")
    if type(capture_profile) is not CaptureProfileDescriptorV1:
        raise ValueError("capture_profile must be an exact V1 descriptor")
    if type(source_capture_facts) is not SourceCaptureFactsV1:
        raise ValueError("source_capture_facts must be exact V1 facts")
    if (
        capture_profile.encoder_configuration_sha256
        != encoder_configuration.fingerprint()
    ):
        raise ValueError("capture profile does not bind the encoder descriptor")
    if source_capture_facts.capture_profile_sha256 != capture_profile.fingerprint():
        raise ValueError("source capture facts do not bind the capture profile")
    return hashlib.sha256(
        canonical_json_bytes(
            {
                "capture_profile_sha256": capture_profile.fingerprint(),
                "domain": CAPTURE_CLASSIFICATION_PROOF_SET_DOMAIN,
                "encoder_configuration_sha256": encoder_configuration.fingerprint(),
                "schema_version": CAPTURE_PROFILE_SCHEMA_VERSION,
                "source_capture_facts_sha256": source_capture_facts.fingerprint(),
                "source_classification_proof_set_sha256": (
                    source_classification_proof_set_sha256_v1(
                        encoder_configuration,
                        capture_profile,
                        source_capture_facts,
                    )
                ),
            },
            label="capture classification proof set",
            maximum_bytes=MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
        )
    ).hexdigest()


def _source_provenance_is_complete(
    encoder: EncoderConfigurationDescriptorV1,
    profile: CaptureProfileDescriptorV1,
    source_facts: SourceCaptureFactsV1,
) -> bool:
    source_pair_is_consistent = (
        (
            source_facts.source_classification
            is CaptureSourceClassificationV1.OWNER_PRODUCED_LIVE
            and encoder.source_representation
            is SourceRepresentationV1.LIVE_ENCODER_OUTPUT
        )
        or (
            source_facts.source_classification
            is CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE
            and encoder.source_representation
            in {
                SourceRepresentationV1.ORIGINAL_CAMERA_MASTER,
                SourceRepresentationV1.PLATFORM_TRANSCODE,
            }
        )
        or (
            source_facts.source_classification
            is CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
            and encoder.source_representation
            is SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE
        )
    )
    return (
        source_facts.source_provenance_complete
        and source_pair_is_consistent
        and source_facts.source_classification
        is not CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
        and encoder.source_representation is not SourceRepresentationV1.UNKNOWN
        and encoder.nominal_bitrate_basis is not NominalBitrateBasisV1.UNKNOWN
        and profile.lens_topology is not LensTopologyV1.UNKNOWN
        and profile.view_topology is not ViewTopologyV1.UNKNOWN
    )


def _classify_exact_mode(
    encoder: EncoderConfigurationDescriptorV1,
    profile: CaptureProfileDescriptorV1,
    source_facts: SourceCaptureFactsV1,
) -> tuple[
    CaptureClassificationStatusV1,
    TrainingCaptureModeV1 | None,
    CaptureClassificationAbstentionV1 | None,
]:
    if (
        profile.view_topology is not ViewTopologyV1.SINGLE_VIEW
        or profile.view_count != 1
    ):
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNSUPPORTED_VIEW_TOPOLOGY,
        )
    if encoder.codec in {VideoCodecV1.OTHER, VideoCodecV1.UNKNOWN}:
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNSUPPORTED_CODEC,
        )
    if not _source_provenance_is_complete(encoder, profile, source_facts):
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.INCOMPLETE_SOURCE_PROVENANCE,
        )
    if encoder.scan_type is ScanTypeV1.UNKNOWN:
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNKNOWN_SCAN,
        )
    if encoder.scan_type is ScanTypeV1.INTERLACED:
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.INTERLACED,
        )
    if encoder.cadence_type is CadenceTypeV1.UNKNOWN:
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNKNOWN_CADENCE,
        )
    if encoder.cadence_type is CadenceTypeV1.VFR:
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.VARIABLE_FRAME_RATE,
        )
    geometry = (encoder.width_px, encoder.height_px)
    cadence = (encoder.cadence_numerator, encoder.cadence_denominator)
    if geometry == (1920, 1080):
        if cadence in {(30, 1), (30_000, 1_001)}:
            return (
                CaptureClassificationStatusV1.CLASSIFIED,
                TrainingCaptureModeV1.HD_1080P30,
                None,
            )
        if cadence in {(60, 1), (60_000, 1_001)}:
            return (
                CaptureClassificationStatusV1.CLASSIFIED,
                TrainingCaptureModeV1.HD_1080P60,
                None,
            )
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNSUPPORTED_CADENCE,
        )
    if geometry == (3840, 2160):
        if cadence in {(60, 1), (60_000, 1_001)}:
            return (
                CaptureClassificationStatusV1.CLASSIFIED,
                TrainingCaptureModeV1.UHD_4K60,
                None,
            )
        return (
            CaptureClassificationStatusV1.ABSTAINED,
            None,
            CaptureClassificationAbstentionV1.UNSUPPORTED_CADENCE,
        )
    return (
        CaptureClassificationStatusV1.ABSTAINED,
        None,
        CaptureClassificationAbstentionV1.UNSUPPORTED_GEOMETRY,
    )


def _structural_risk_tags(
    encoder: EncoderConfigurationDescriptorV1,
    mode: TrainingCaptureModeV1 | None,
    profile: CaptureProfileDescriptorV1,
    source_facts: SourceCaptureFactsV1,
) -> tuple[CaptureRiskTagV1, ...]:
    tags = set(source_facts.source_risk_tags)
    if (
        mode is TrainingCaptureModeV1.HD_1080P30
        or (
            (encoder.width_px, encoder.height_px) == (1920, 1080)
            and encoder.scan_type is ScanTypeV1.PROGRESSIVE
            and encoder.cadence_type is CadenceTypeV1.CFR
            and (encoder.cadence_numerator, encoder.cadence_denominator)
            in {(30, 1), (30_000, 1_001)}
        )
    ):
        tags.add(CaptureRiskTagV1.COMPATIBILITY_1080P30)
    if (
        profile.view_topology is ViewTopologyV1.SINGLE_VIEW
        and profile.view_count == 1
    ):
        tags.add(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION)
    else:
        tags.add(CaptureRiskTagV1.MULTI_VIEW_SYNCHRONIZATION)
    if profile.compression_stratum is CompressionStratumV1.CONSTRAINED_INTERFRAME:
        tags.add(CaptureRiskTagV1.HIGH_COMPRESSION)
    return tuple(sorted(tags, key=lambda item: item.value))


def _validate_compression_consistency(
    encoder: EncoderConfigurationDescriptorV1,
    profile: CaptureProfileDescriptorV1,
) -> None:
    intra = encoder.coding_structure in {
        CodingStructureV1.LOSSLESS,
        CodingStructureV1.INTRA_ONLY,
    }
    declared_intra = (
        profile.compression_stratum is CompressionStratumV1.LOSSLESS_OR_INTRA
    )
    if intra != declared_intra:
        raise ValueError(
            "compression_stratum must agree with intra/lossless versus "
            "interframe coding_structure"
        )


@dataclass(frozen=True, slots=True)
class CaptureProfileClassificationV1(_CanonicalContract):
    """Self-verifying classification receipt with no admission authority."""

    encoder_configuration: EncoderConfigurationDescriptorV1
    capture_profile: CaptureProfileDescriptorV1
    source_capture_facts: SourceCaptureFactsV1
    status: CaptureClassificationStatusV1
    training_capture_mode: TrainingCaptureModeV1 | None
    abstention_reason: CaptureClassificationAbstentionV1 | None
    capture_risk_tags: tuple[CaptureRiskTagV1, ...]
    source_classification_proof_set_sha256: str
    capture_classification_proof_set_sha256: str
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_PROFILE_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = CAPTURE_PROFILE_CLASSIFICATION_DOMAIN
    _LABEL: ClassVar[str] = "capture profile classification"

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, self._LABEL)
        if type(self.encoder_configuration) is not EncoderConfigurationDescriptorV1:
            raise ValueError("encoder_configuration must be an exact V1 descriptor")
        if type(self.capture_profile) is not CaptureProfileDescriptorV1:
            raise ValueError("capture_profile must be an exact V1 descriptor")
        if type(self.source_capture_facts) is not SourceCaptureFactsV1:
            raise ValueError("source_capture_facts must be exact V1 facts")
        _require_exact_enum(self.status, CaptureClassificationStatusV1, "status")
        if self.training_capture_mode is not None:
            _require_exact_enum(
                self.training_capture_mode,
                TrainingCaptureModeV1,
                "training_capture_mode",
            )
        if self.abstention_reason is not None:
            _require_exact_enum(
                self.abstention_reason,
                CaptureClassificationAbstentionV1,
                "abstention_reason",
            )
        require_canonical_tuple(
            self.capture_risk_tags,
            "capture_risk_tags",
            minimum=1,
            maximum=len(CaptureRiskTagV1),
            validator=lambda item, field: _require_exact_enum(
                item, CaptureRiskTagV1, field
            ),
        )
        _validate_compression_consistency(
            self.encoder_configuration, self.capture_profile
        )
        if (
            self.capture_profile.encoder_configuration_sha256
            != self.encoder_configuration.fingerprint()
        ):
            raise ValueError("capture profile does not bind the encoder descriptor")
        if (
            self.source_capture_facts.capture_profile_sha256
            != self.capture_profile.fingerprint()
        ):
            raise ValueError("source capture facts do not bind the capture profile")
        if self.encoder_configuration.encoder_settings_sha256 in {
            self.capture_profile.encoder_configuration_sha256,
            self.capture_profile.calibration_sha256,
            self.capture_profile.clock_model_sha256,
            self.capture_profile.camera_attestation_sha256,
            self.capture_profile.exposure_descriptor_sha256,
        }:
            raise ValueError("classification typed digest roles must not alias")
        expected_status, expected_mode, expected_reason = _classify_exact_mode(
            self.encoder_configuration,
            self.capture_profile,
            self.source_capture_facts,
        )
        if (
            self.status is not expected_status
            or self.training_capture_mode is not expected_mode
            or self.abstention_reason is not expected_reason
        ):
            raise ValueError("classification result is not the exact derived result")
        expected_risks = _structural_risk_tags(
            self.encoder_configuration,
            expected_mode,
            self.capture_profile,
            self.source_capture_facts,
        )
        if self.capture_risk_tags != expected_risks:
            raise ValueError("capture_risk_tags are not the exact derived union")
        expected_source_proof = source_classification_proof_set_sha256_v1(
            self.encoder_configuration,
            self.capture_profile,
            self.source_capture_facts,
        )
        expected_classification_proof = (
            capture_classification_proof_set_sha256_v1(
                self.encoder_configuration,
                self.capture_profile,
                self.source_capture_facts,
            )
        )
        if self.source_classification_proof_set_sha256 != expected_source_proof:
            raise ValueError("source classification proof-set hash is invalid")
        if (
            self.capture_classification_proof_set_sha256
            != expected_classification_proof
        ):
            raise ValueError("capture classification proof-set hash is invalid")
        _require_distinct_digests(
            (
                (
                    "encoder_settings_sha256",
                    self.encoder_configuration.encoder_settings_sha256,
                ),
                (
                    "encoder_configuration_sha256",
                    self.capture_profile.encoder_configuration_sha256,
                ),
                (
                    "calibration_sha256",
                    self.capture_profile.calibration_sha256,
                ),
                (
                    "clock_model_sha256",
                    self.capture_profile.clock_model_sha256,
                ),
                (
                    "camera_attestation_sha256",
                    self.capture_profile.camera_attestation_sha256,
                ),
                (
                    "exposure_descriptor_sha256",
                    self.capture_profile.exposure_descriptor_sha256,
                ),
                (
                    "source_classification_proof_set_sha256",
                    self.source_classification_proof_set_sha256,
                ),
                (
                    "capture_classification_proof_set_sha256",
                    self.capture_classification_proof_set_sha256,
                ),
            ),
            label=self._LABEL,
        )
        for field_name in _AUTHORITY_FIELDS:
            if getattr(self, field_name) is not False:
                raise ValueError(f"{field_name} must be exactly false")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "abstention_reason": (
                None if self.abstention_reason is None else self.abstention_reason.value
            ),
            **{field: getattr(self, field) for field in _AUTHORITY_FIELDS},
            "capture_classification_proof_set_sha256": (
                self.capture_classification_proof_set_sha256
            ),
            "capture_profile": self.capture_profile.to_dict(),
            "capture_risk_tags": [item.value for item in self.capture_risk_tags],
            "domain": self._DOMAIN,
            "encoder_configuration": self.encoder_configuration.to_dict(),
            "schema_version": self.schema_version,
            "source_capture_facts": self.source_capture_facts.to_dict(),
            "source_classification_proof_set_sha256": (
                self.source_classification_proof_set_sha256
            ),
            "status": self.status.value,
            "training_capture_mode": (
                None
                if self.training_capture_mode is None
                else self.training_capture_mode.value
            ),
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureProfileClassificationV1":
        fields = _parse_contract(
            raw,
            label=cls._LABEL,
            domain=cls._DOMAIN,
            fields=_contract_field_names(cls),
            maximum_depth=6,
            maximum_nodes=160,
            maximum_containers=14,
        )
        fields["encoder_configuration"] = EncoderConfigurationDescriptorV1.from_dict(
            _nested_contract_fields(
                fields["encoder_configuration"],
                contract_type=EncoderConfigurationDescriptorV1,
                domain=ENCODER_CONFIGURATION_DESCRIPTOR_DOMAIN,
                label=EncoderConfigurationDescriptorV1._LABEL,
            )
        )
        fields["capture_profile"] = CaptureProfileDescriptorV1.from_dict(
            _nested_contract_fields(
                fields["capture_profile"],
                contract_type=CaptureProfileDescriptorV1,
                domain=CAPTURE_PROFILE_DESCRIPTOR_DOMAIN,
                label=CaptureProfileDescriptorV1._LABEL,
            )
        )
        fields["source_capture_facts"] = SourceCaptureFactsV1.from_dict(
            _nested_contract_fields(
                fields["source_capture_facts"],
                contract_type=SourceCaptureFactsV1,
                domain=SOURCE_CAPTURE_FACTS_DOMAIN,
                label=SourceCaptureFactsV1._LABEL,
            )
        )
        fields["status"] = enum_from_json(
            CaptureClassificationStatusV1, fields["status"], "status"
        )
        if fields["training_capture_mode"] is not None:
            fields["training_capture_mode"] = enum_from_json(
                TrainingCaptureModeV1,
                fields["training_capture_mode"],
                "training_capture_mode",
            )
        if fields["abstention_reason"] is not None:
            fields["abstention_reason"] = enum_from_json(
                CaptureClassificationAbstentionV1,
                fields["abstention_reason"],
                "abstention_reason",
            )
        fields["capture_risk_tags"] = tuple(
            enum_from_json(CaptureRiskTagV1, item, "capture_risk_tags")
            for item in exact_list(fields, "capture_risk_tags", label=cls._LABEL)
        )
        result = cls(**fields)
        if result.to_json_bytes() != raw:
            raise ValueError("capture profile classification reconstruction changed bytes")
        return result


def classify_capture_profile_v1(
    encoder_configuration: EncoderConfigurationDescriptorV1,
    capture_profile: CaptureProfileDescriptorV1,
    source_capture_facts: SourceCaptureFactsV1,
) -> CaptureProfileClassificationV1:
    """Derive one exact non-authorizing receipt or raise on inconsistent facts."""

    if type(encoder_configuration) is not EncoderConfigurationDescriptorV1:
        raise ValueError("encoder_configuration must be an exact V1 descriptor")
    if type(capture_profile) is not CaptureProfileDescriptorV1:
        raise ValueError("capture_profile must be an exact V1 descriptor")
    if type(source_capture_facts) is not SourceCaptureFactsV1:
        raise ValueError("source_capture_facts must be exact V1 facts")
    if source_capture_facts.capture_profile_sha256 != capture_profile.fingerprint():
        raise ValueError("source capture facts do not bind the capture profile")
    _validate_compression_consistency(encoder_configuration, capture_profile)
    status, mode, reason = _classify_exact_mode(
        encoder_configuration, capture_profile, source_capture_facts
    )
    return CaptureProfileClassificationV1(
        encoder_configuration=encoder_configuration,
        capture_profile=capture_profile,
        source_capture_facts=source_capture_facts,
        status=status,
        training_capture_mode=mode,
        abstention_reason=reason,
        capture_risk_tags=_structural_risk_tags(
            encoder_configuration,
            mode,
            capture_profile,
            source_capture_facts,
        ),
        source_classification_proof_set_sha256=(
            source_classification_proof_set_sha256_v1(
                encoder_configuration, capture_profile, source_capture_facts
            )
        ),
        capture_classification_proof_set_sha256=(
            capture_classification_proof_set_sha256_v1(
                encoder_configuration, capture_profile, source_capture_facts
            )
        ),
    )


def _owner_live_template_v1(
    *,
    source_id: str,
    capture_profile_id: str,
    encoder_configuration_id: str,
    device_model: str,
    codec: VideoCodecV1,
    transport: CaptureTransportV1,
    cadence_numerator: int,
    nominal_bitrate_bps: int,
    encoder_settings_sha256: str,
    calibration_sha256: str,
    clock_model_sha256: str,
    camera_attestation_sha256: str,
    exposure_descriptor_sha256: str,
    compression_stratum: CompressionStratumV1,
    source_risk_tags: tuple[CaptureRiskTagV1, ...],
) -> CaptureProfileClassificationV1:
    # Compression is an exact caller-supplied fact.  The fixed nominal bitrate
    # below is never consulted to select or validate an interframe stratum.
    encoder = EncoderConfigurationDescriptorV1(
        encoder_configuration_id=encoder_configuration_id,
        codec=codec,
        coding_structure=CodingStructureV1.INTERFRAME,
        transport=transport,
        source_representation=SourceRepresentationV1.LIVE_ENCODER_OUTPUT,
        width_px=1920,
        height_px=1080,
        scan_type=ScanTypeV1.PROGRESSIVE,
        cadence_type=CadenceTypeV1.CFR,
        cadence_numerator=cadence_numerator,
        cadence_denominator=1,
        nominal_bitrate_bps=nominal_bitrate_bps,
        nominal_bitrate_basis=NominalBitrateBasisV1.OWNER_DECLARED,
        encoder_settings_sha256=encoder_settings_sha256,
    )
    profile = CaptureProfileDescriptorV1(
        capture_profile_id=capture_profile_id,
        device_scope=DeviceScopeV1.DEVICE_MODEL,
        device_model_or_class=device_model,
        exact_device_id=None,
        lens_topology=LensTopologyV1.SINGLE_LENS,
        view_topology=ViewTopologyV1.SINGLE_VIEW,
        view_count=1,
        encoder_configuration_sha256=encoder.fingerprint(),
        compression_stratum=compression_stratum,
        calibration_sha256=calibration_sha256,
        clock_model_sha256=clock_model_sha256,
        camera_attestation_sha256=camera_attestation_sha256,
        exposure_descriptor_sha256=exposure_descriptor_sha256,
    )
    source_facts = SourceCaptureFactsV1(
        source_id=source_id,
        capture_profile_sha256=profile.fingerprint(),
        source_classification=CaptureSourceClassificationV1.OWNER_PRODUCED_LIVE,
        source_provenance_complete=True,
        source_risk_tags=source_risk_tags,
    )
    return classify_capture_profile_v1(encoder, profile, source_facts)


def mevo_core_owner_live_1080p60_v1(
    *,
    source_id: str,
    encoder_settings_sha256: str,
    calibration_sha256: str,
    clock_model_sha256: str,
    camera_attestation_sha256: str,
    exposure_descriptor_sha256: str,
    compression_stratum: CompressionStratumV1,
    source_risk_tags: tuple[CaptureRiskTagV1, ...] = (),
) -> CaptureProfileClassificationV1:
    """Owner-declared Mevo Core template: H.264/RTMP 1080p60 at 6 Mbps."""

    return _owner_live_template_v1(
        source_id=source_id,
        capture_profile_id="owner-mevo-core-1080p60-v1",
        encoder_configuration_id="owner-mevo-core-h264-rtmp-1080p60-v1",
        device_model="logitech.mevo-core",
        codec=VideoCodecV1.AVC_H264,
        transport=CaptureTransportV1.RTMP,
        cadence_numerator=60,
        nominal_bitrate_bps=6_000_000,
        encoder_settings_sha256=encoder_settings_sha256,
        calibration_sha256=calibration_sha256,
        clock_model_sha256=clock_model_sha256,
        camera_attestation_sha256=camera_attestation_sha256,
        exposure_descriptor_sha256=exposure_descriptor_sha256,
        compression_stratum=compression_stratum,
        source_risk_tags=source_risk_tags,
    )


def avkans_go_owner_live_1080p30_v1(
    *,
    source_id: str,
    encoder_settings_sha256: str,
    calibration_sha256: str,
    clock_model_sha256: str,
    camera_attestation_sha256: str,
    exposure_descriptor_sha256: str,
    compression_stratum: CompressionStratumV1,
    source_risk_tags: tuple[CaptureRiskTagV1, ...] = (),
) -> CaptureProfileClassificationV1:
    """Owner-declared AVKANS Go template: HEVC/SRT 1080p30 at 3 Mbps.

    The template is intentionally model-scoped.  It contains neither physical
    device identifiers nor a physical-device-to-logical-stream mapping.
    """

    return _owner_live_template_v1(
        source_id=source_id,
        capture_profile_id="owner-avkans-go-1080p30-v1",
        encoder_configuration_id="owner-avkans-go-hevc-srt-1080p30-v1",
        device_model="avkans.go",
        codec=VideoCodecV1.HEVC_H265,
        transport=CaptureTransportV1.SRT,
        cadence_numerator=30,
        nominal_bitrate_bps=3_000_000,
        encoder_settings_sha256=encoder_settings_sha256,
        calibration_sha256=calibration_sha256,
        clock_model_sha256=clock_model_sha256,
        camera_attestation_sha256=camera_attestation_sha256,
        exposure_descriptor_sha256=exposure_descriptor_sha256,
        compression_stratum=compression_stratum,
        source_risk_tags=source_risk_tags,
    )


__all__ = [
    "CAPTURE_PROFILE_SCHEMA_VERSION",
    "CadenceTypeV1",
    "CaptureClassificationAbstentionV1",
    "CaptureClassificationStatusV1",
    "CaptureProfileClassificationV1",
    "CaptureProfileDescriptorV1",
    "CaptureRiskTagV1",
    "CaptureSourceClassificationV1",
    "CaptureTransportV1",
    "CodingStructureV1",
    "CompressionStratumV1",
    "DeviceScopeV1",
    "EncoderConfigurationDescriptorV1",
    "LensTopologyV1",
    "MAX_CAPTURE_PROFILE_CONTRACT_BYTES",
    "NominalBitrateBasisV1",
    "ScanTypeV1",
    "SourceCaptureFactsV1",
    "SourceRepresentationV1",
    "TrainingCaptureModeV1",
    "VideoCodecV1",
    "ViewTopologyV1",
    "avkans_go_owner_live_1080p30_v1",
    "capture_classification_proof_set_sha256_v1",
    "classify_capture_profile_v1",
    "mevo_core_owner_live_1080p60_v1",
    "source_classification_proof_set_sha256_v1",
]
