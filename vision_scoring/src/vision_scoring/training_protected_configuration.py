"""Canonical, non-authorizing pins for protected causal-ball training.

These contracts contain only immutable coordinates and implementation pins.
They do not contain protected object bytes, store paths, secrets, clocks,
capabilities, or admission authority.  A future protected coordinator must
load and revalidate every referenced object and must prove currentness before
and after use.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Any, ClassVar, Iterable

from .annotation_trust import AnnotationMinimumTruthPolicy
from .contract_wire import (
    CanonicalWireError,
    MAX_SIGNED_64,
    canonical_json_bytes,
    enum_from_json,
    exact_list,
    parse_canonical_json_object,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)
from .immutable_store import generation_id_for
from .protected_file import read_protected_file_bytes
from .training_admission_contracts import MAX_TRAINING_EXAMPLES


TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION = "1.0"
PROTECTED_TRAINING_CONFIGURATION_GENERATION_SCHEMA_VERSION = "2.0"

DECODER_RUNTIME_PINS_DOMAIN = "multicourt-vision-scoring:decoder-runtime-pins:v1"
LABEL_BUNDLE_CURRENT_PIN_DOMAIN = (
    "multicourt-vision-scoring:label-bundle-current-pin:v1"
)
LABEL_BUNDLE_CURRENT_PIN_SET_DOMAIN = (
    "multicourt-vision-scoring:label-bundle-current-pin-set:v1"
)
CAPTURE_CLASSIFICATION_CURRENT_PIN_DOMAIN = (
    "multicourt-vision-scoring:capture-classification-current-pin:v1"
)
CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_DOMAIN = (
    "multicourt-vision-scoring:capture-classification-current-pin-set:v1"
)
PROTECTED_TRAINING_CONFIGURATION_GENERATION_DOMAIN = (
    "multicourt-vision-scoring:protected-training-configuration-generation:v2"
)

MAX_DECODER_RUNTIME_PINS_BYTES = 64 * 1024
MAX_LABEL_BUNDLE_CURRENT_PIN_BYTES = 64 * 1024
MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES = 1024 * 1024
MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_BYTES = 64 * 1024
MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_BYTES = 1024 * 1024
MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES = 64 * 1024


class TrainingProtectedConfigurationError(ValueError):
    """A protected-training contract failure with a stable machine code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingProtectedConfigurationError(code, message)


def _require_schema_version(
    value: object,
    *,
    label: str,
    expected: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION,
) -> None:
    if type(value) is not str or value != expected:
        raise ValueError(f"{label} schema_version must be exactly {expected!r}")


def _require_distinct_digests(
    rows: Iterable[tuple[str, object]],
    *,
    label: str,
) -> tuple[str, ...]:
    selected = tuple(require_sha256(value, field_name) for field_name, value in rows)
    if len(selected) != len(set(selected)):
        raise ValueError(f"{label} typed digest roles must not alias")
    return selected


def _parse_contract(
    raw: bytes,
    *,
    label: str,
    domain: str,
    fields: set[str],
    maximum_bytes: int,
    maximum_depth: int,
    maximum_nodes: int,
    maximum_containers: int,
) -> dict[str, Any]:
    payload = require_exact_fields(
        parse_canonical_json_object(
            raw,
            label=label,
            maximum_bytes=maximum_bytes,
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


class _CanonicalContract:
    _DOMAIN: ClassVar[str]
    _LABEL: ClassVar[str]
    _MAXIMUM_BYTES: ClassVar[int]

    def to_dict(self) -> dict[str, Any]:
        raise NotImplementedError

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label=self._LABEL,
            maximum_bytes=self._MAXIMUM_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class DecoderRuntimePinsV1(_CanonicalContract):
    """Exact immutable-store and host-runtime coordinates for decode."""

    decoder_runtime_generation_id: str
    decoder_runtime_manifest_sha256: str
    platform: str
    architecture: str
    abi: str
    system_runtime_id: str
    system_runtime_measurement_sha256: str
    schema_version: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = DECODER_RUNTIME_PINS_DOMAIN
    _LABEL: ClassVar[str] = "decoder runtime pins"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_DECODER_RUNTIME_PINS_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label=self._LABEL)
        _require_distinct_digests(
            (
                (
                    "decoder_runtime_generation_id",
                    self.decoder_runtime_generation_id,
                ),
                (
                    "decoder_runtime_manifest_sha256",
                    self.decoder_runtime_manifest_sha256,
                ),
                (
                    "system_runtime_measurement_sha256",
                    self.system_runtime_measurement_sha256,
                ),
            ),
            label=self._LABEL,
        )
        for field_name in (
            "platform",
            "architecture",
            "abi",
            "system_runtime_id",
        ):
            require_stable_id(getattr(self, field_name), field_name)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "abi": self.abi,
            "architecture": self.architecture,
            "decoder_runtime_generation_id": self.decoder_runtime_generation_id,
            "decoder_runtime_manifest_sha256": (self.decoder_runtime_manifest_sha256),
            "domain": self._DOMAIN,
            "platform": self.platform,
            "schema_version": self.schema_version,
            "system_runtime_id": self.system_runtime_id,
            "system_runtime_measurement_sha256": (
                self.system_runtime_measurement_sha256
            ),
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "DecoderRuntimePinsV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={
                    name
                    for name in cls.__dataclass_fields__
                    if not name.startswith("_")
                },
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=2,
                maximum_nodes=32,
                maximum_containers=1,
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "DECODER_RUNTIME_PINS_WIRE",
                "decoder runtime pin fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "DECODER_RUNTIME_PINS_WIRE",
                "decoder runtime pins did not reconstruct exactly",
            )
        return result


@dataclass(frozen=True, slots=True)
class LabelBundleCurrentPinV1(_CanonicalContract):
    """Current curator coordinates for one source's exact label pack."""

    source_id: str
    label_pack_generation_id: str
    label_pack_sha256: str
    bundle_id: str
    curator_trust_snapshot_sha256: str
    curator_trust_snapshot_generation: int
    curator_attestation_sha256: str
    curator_id: str
    trust_domain_id: str
    schema_version: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = LABEL_BUNDLE_CURRENT_PIN_DOMAIN
    _LABEL: ClassVar[str] = "label bundle current pin"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_LABEL_BUNDLE_CURRENT_PIN_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label=self._LABEL)
        for field_name in (
            "source_id",
            "bundle_id",
            "curator_id",
            "trust_domain_id",
        ):
            require_stable_id(getattr(self, field_name), field_name)
        _require_distinct_digests(
            (
                ("label_pack_generation_id", self.label_pack_generation_id),
                ("label_pack_sha256", self.label_pack_sha256),
                (
                    "curator_trust_snapshot_sha256",
                    self.curator_trust_snapshot_sha256,
                ),
                (
                    "curator_attestation_sha256",
                    self.curator_attestation_sha256,
                ),
            ),
            label=self._LABEL,
        )
        require_exact_int(
            self.curator_trust_snapshot_generation,
            "curator_trust_snapshot_generation",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        self.to_json_bytes()

    @property
    def canonical_sort_key(self) -> tuple[str, str, str, str]:
        return (
            self.source_id,
            self.label_pack_generation_id,
            self.label_pack_sha256,
            self.bundle_id,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "bundle_id": self.bundle_id,
            "curator_attestation_sha256": self.curator_attestation_sha256,
            "curator_id": self.curator_id,
            "curator_trust_snapshot_generation": (
                self.curator_trust_snapshot_generation
            ),
            "curator_trust_snapshot_sha256": (self.curator_trust_snapshot_sha256),
            "domain": self._DOMAIN,
            "label_pack_generation_id": self.label_pack_generation_id,
            "label_pack_sha256": self.label_pack_sha256,
            "schema_version": self.schema_version,
            "source_id": self.source_id,
            "trust_domain_id": self.trust_domain_id,
        }

    @classmethod
    def _from_dict(cls, value: object, *, label: str) -> "LabelBundleCurrentPinV1":
        fields = require_exact_fields(
            value,
            {
                "bundle_id",
                "curator_attestation_sha256",
                "curator_id",
                "curator_trust_snapshot_generation",
                "curator_trust_snapshot_sha256",
                "domain",
                "label_pack_generation_id",
                "label_pack_sha256",
                "schema_version",
                "source_id",
                "trust_domain_id",
            },
            label=label,
        )
        if fields.pop("domain") != cls._DOMAIN:
            raise ValueError(f"{label} domain is invalid")
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "LabelBundleCurrentPinV1":
        try:
            payload = parse_canonical_json_object(
                raw,
                label=cls._LABEL,
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=2,
                maximum_nodes=40,
                maximum_containers=1,
            )
            result = cls._from_dict(payload, label=cls._LABEL)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "LABEL_BUNDLE_CURRENT_PIN_WIRE",
                "label bundle current pin fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "LABEL_BUNDLE_CURRENT_PIN_WIRE",
                "label bundle current pin did not reconstruct exactly",
            )
        return result


def _require_label_pin_set(pins: object) -> tuple[LabelBundleCurrentPinV1, ...]:
    if type(pins) is not tuple or not 1 <= len(pins) <= MAX_TRAINING_EXAMPLES:
        raise ValueError(
            "pins must be an exact tuple containing 1 to "
            f"{MAX_TRAINING_EXAMPLES} label pins"
        )
    if any(type(pin) is not LabelBundleCurrentPinV1 for pin in pins):
        raise ValueError("pins must contain exact LabelBundleCurrentPinV1 rows")
    if pins != tuple(sorted(pins, key=lambda pin: pin.canonical_sort_key)):
        raise ValueError("pins must use canonical source/pack/bundle order")

    source_ids = tuple(pin.source_id for pin in pins)
    pack_generation_ids = tuple(pin.label_pack_generation_id for pin in pins)
    pack_coordinates = tuple(
        (pin.label_pack_generation_id, pin.label_pack_sha256) for pin in pins
    )
    pack_sha256s = tuple(pin.label_pack_sha256 for pin in pins)
    bundle_ids = tuple(pin.bundle_id for pin in pins)
    snapshot_sha256s = tuple(pin.curator_trust_snapshot_sha256 for pin in pins)
    attestation_sha256s = tuple(pin.curator_attestation_sha256 for pin in pins)
    for values, label in (
        (source_ids, "source IDs"),
        (pack_generation_ids, "label-pack generation IDs"),
        (pack_coordinates, "label-pack coordinates"),
        (pack_sha256s, "label-pack digests"),
        (bundle_ids, "bundle IDs"),
        (snapshot_sha256s, "curator trust snapshots"),
        (attestation_sha256s, "curator attestations"),
    ):
        if len(values) != len(set(values)):
            raise ValueError(f"label pin set {label} must be unique")

    digest_roles = (
        {pin.label_pack_generation_id for pin in pins},
        {pin.label_pack_sha256 for pin in pins},
        {pin.curator_trust_snapshot_sha256 for pin in pins},
        {pin.curator_attestation_sha256 for pin in pins},
    )
    for index, values in enumerate(digest_roles):
        for other in digest_roles[index + 1 :]:
            if values.intersection(other):
                raise ValueError(
                    "label pin set digest roles must not alias across rows"
                )
    return pins


@dataclass(frozen=True, slots=True)
class LabelBundleCurrentPinSetV1(_CanonicalContract):
    """Canonical current-label coordinates for the bounded source corpus."""

    pins: tuple[LabelBundleCurrentPinV1, ...]
    schema_version: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = LABEL_BUNDLE_CURRENT_PIN_SET_DOMAIN
    _LABEL: ClassVar[str] = "label bundle current pin set"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label=self._LABEL)
        _require_label_pin_set(self.pins)
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": self._DOMAIN,
            "pins": [pin.to_dict() for pin in self.pins],
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "LabelBundleCurrentPinSetV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={"pins", "schema_version"},
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=4,
                maximum_nodes=8_000,
                maximum_containers=1_024,
            )
            raw_pins = exact_list(fields, "pins", label=cls._LABEL)
            if len(raw_pins) > MAX_TRAINING_EXAMPLES:
                raise ValueError("label pin set exceeds its row bound")
            fields["pins"] = tuple(
                LabelBundleCurrentPinV1._from_dict(
                    value,
                    label=f"pins[{index}]",
                )
                for index, value in enumerate(raw_pins)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "LABEL_BUNDLE_CURRENT_PIN_SET_WIRE",
                "label bundle current pin-set fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "LABEL_BUNDLE_CURRENT_PIN_SET_WIRE",
                "label bundle current pin set did not reconstruct exactly",
            )
        return result


@dataclass(frozen=True, slots=True)
class CaptureClassificationCurrentPinV1(_CanonicalContract):
    """One source's exact current classification object coordinate."""

    source_id: str
    capture_profile_classification_sha256: str
    schema_version: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = CAPTURE_CLASSIFICATION_CURRENT_PIN_DOMAIN
    _LABEL: ClassVar[str] = "capture classification current pin"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label=self._LABEL)
        require_stable_id(self.source_id, "source_id")
        require_sha256(
            self.capture_profile_classification_sha256,
            "capture_profile_classification_sha256",
        )
        self.to_json_bytes()

    @property
    def canonical_sort_key(self) -> tuple[str, str]:
        return (self.source_id, self.capture_profile_classification_sha256)

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_profile_classification_sha256": (
                self.capture_profile_classification_sha256
            ),
            "domain": self._DOMAIN,
            "schema_version": self.schema_version,
            "source_id": self.source_id,
        }

    @classmethod
    def _from_dict(
        cls,
        value: object,
        *,
        label: str,
    ) -> "CaptureClassificationCurrentPinV1":
        fields = require_exact_fields(
            value,
            {
                "capture_profile_classification_sha256",
                "domain",
                "schema_version",
                "source_id",
            },
            label=label,
        )
        if fields.pop("domain") != cls._DOMAIN:
            raise ValueError(f"{label} domain is invalid")
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "CaptureClassificationCurrentPinV1":
        try:
            payload = parse_canonical_json_object(
                raw,
                label=cls._LABEL,
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=2,
                maximum_nodes=16,
                maximum_containers=1,
            )
            result = cls._from_dict(payload, label=cls._LABEL)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "CAPTURE_CLASSIFICATION_CURRENT_PIN_WIRE",
                "capture classification current pin fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "CAPTURE_CLASSIFICATION_CURRENT_PIN_WIRE",
                "capture classification current pin did not reconstruct exactly",
            )
        return result


def _require_capture_classification_pin_set(
    pins: object,
) -> tuple[CaptureClassificationCurrentPinV1, ...]:
    if type(pins) is not tuple or not 1 <= len(pins) <= MAX_TRAINING_EXAMPLES:
        raise ValueError(
            "pins must be an exact tuple containing 1 to "
            f"{MAX_TRAINING_EXAMPLES} capture classification pins"
        )
    if any(type(pin) is not CaptureClassificationCurrentPinV1 for pin in pins):
        raise ValueError(
            "pins must contain exact CaptureClassificationCurrentPinV1 rows"
        )
    if pins != tuple(sorted(pins, key=lambda pin: pin.canonical_sort_key)):
        raise ValueError("pins must use canonical source/classification order")
    source_ids = tuple(pin.source_id for pin in pins)
    classification_sha256s = tuple(
        pin.capture_profile_classification_sha256 for pin in pins
    )
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("capture classification pin-set source IDs must be unique")
    if len(classification_sha256s) != len(set(classification_sha256s)):
        raise ValueError("capture classification pin-set object digests must be unique")
    return pins


@dataclass(frozen=True, slots=True)
class CaptureClassificationCurrentPinSetV1(_CanonicalContract):
    """One exact immutable generation of current source classifications."""

    capture_classification_generation_id: str
    pins: tuple[CaptureClassificationCurrentPinV1, ...]
    schema_version: str = TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_DOMAIN
    _LABEL: ClassVar[str] = "capture classification current pin set"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(self.schema_version, label=self._LABEL)
        pins = _require_capture_classification_pin_set(self.pins)
        generation_id = require_sha256(
            self.capture_classification_generation_id,
            "capture_classification_generation_id",
        )
        object_sha256s = tuple(
            sorted(pin.capture_profile_classification_sha256 for pin in pins)
        )
        if generation_id in object_sha256s:
            raise ValueError(
                "capture classification generation and object digest roles "
                "must not alias"
            )
        if generation_id != generation_id_for(object_sha256s):
            raise ValueError(
                "capture_classification_generation_id must commit the exact "
                "classification object set"
            )
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "capture_classification_generation_id": (
                self.capture_classification_generation_id
            ),
            "domain": self._DOMAIN,
            "pins": [pin.to_dict() for pin in self.pins],
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_json_bytes(
        cls,
        raw: bytes,
    ) -> "CaptureClassificationCurrentPinSetV1":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={
                    "capture_classification_generation_id",
                    "pins",
                    "schema_version",
                },
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=4,
                maximum_nodes=8_000,
                maximum_containers=1_024,
            )
            raw_pins = exact_list(fields, "pins", label=cls._LABEL)
            if len(raw_pins) > MAX_TRAINING_EXAMPLES:
                raise ValueError("capture classification pin set exceeds its row bound")
            fields["pins"] = tuple(
                CaptureClassificationCurrentPinV1._from_dict(
                    value,
                    label=f"pins[{index}]",
                )
                for index, value in enumerate(raw_pins)
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_WIRE",
                "capture classification current pin-set fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_WIRE",
                "capture classification current pin set did not reconstruct exactly",
            )
        return result


@dataclass(frozen=True, slots=True)
class ProtectedTrainingConfigurationGenerationV2(_CanonicalContract):
    """Publisher-atomic pins consumed by a future trusted coordinator."""

    readiness_configuration_generation_sha256: str
    training_admission_policy_sha256: str
    annotation_configuration_generation_sha256: str
    label_bundle_current_pin_set_sha256: str
    decoder_runtime_pins_sha256: str
    capture_classification_current_pin_set_sha256: str
    coordinator_source_tree_sha256: str
    coordinator_deployment_artifact_sha256: str
    trainer_source_tree_sha256: str
    environment_lock_sha256: str
    requested_truth_policy: AnnotationMinimumTruthPolicy
    governance_domain_id: str
    schema_version: str = PROTECTED_TRAINING_CONFIGURATION_GENERATION_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = PROTECTED_TRAINING_CONFIGURATION_GENERATION_DOMAIN
    _LABEL: ClassVar[str] = "protected training configuration generation"
    _MAXIMUM_BYTES: ClassVar[int] = MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES

    def __post_init__(self) -> None:
        _require_schema_version(
            self.schema_version,
            label=self._LABEL,
            expected=PROTECTED_TRAINING_CONFIGURATION_GENERATION_SCHEMA_VERSION,
        )
        # Every digest is a role-specific, domain-separated commitment.  Even
        # when coordinator and trainer source live in one checkout, their
        # measured role commitments must not be an undifferentiated tree hash.
        _require_distinct_digests(
            (
                (
                    "readiness_configuration_generation_sha256",
                    self.readiness_configuration_generation_sha256,
                ),
                (
                    "training_admission_policy_sha256",
                    self.training_admission_policy_sha256,
                ),
                (
                    "annotation_configuration_generation_sha256",
                    self.annotation_configuration_generation_sha256,
                ),
                (
                    "label_bundle_current_pin_set_sha256",
                    self.label_bundle_current_pin_set_sha256,
                ),
                (
                    "decoder_runtime_pins_sha256",
                    self.decoder_runtime_pins_sha256,
                ),
                (
                    "capture_classification_current_pin_set_sha256",
                    self.capture_classification_current_pin_set_sha256,
                ),
                (
                    "coordinator_source_tree_sha256",
                    self.coordinator_source_tree_sha256,
                ),
                (
                    "coordinator_deployment_artifact_sha256",
                    self.coordinator_deployment_artifact_sha256,
                ),
                ("trainer_source_tree_sha256", self.trainer_source_tree_sha256),
                ("environment_lock_sha256", self.environment_lock_sha256),
            ),
            label=self._LABEL,
        )
        if type(self.requested_truth_policy) is not AnnotationMinimumTruthPolicy:
            raise ValueError(
                "requested_truth_policy must be an exact AnnotationMinimumTruthPolicy"
            )
        require_stable_id(self.governance_domain_id, "governance_domain_id")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "annotation_configuration_generation_sha256": (
                self.annotation_configuration_generation_sha256
            ),
            "capture_classification_current_pin_set_sha256": (
                self.capture_classification_current_pin_set_sha256
            ),
            "coordinator_deployment_artifact_sha256": (
                self.coordinator_deployment_artifact_sha256
            ),
            "coordinator_source_tree_sha256": self.coordinator_source_tree_sha256,
            "decoder_runtime_pins_sha256": self.decoder_runtime_pins_sha256,
            "domain": self._DOMAIN,
            "environment_lock_sha256": self.environment_lock_sha256,
            "governance_domain_id": self.governance_domain_id,
            "label_bundle_current_pin_set_sha256": (
                self.label_bundle_current_pin_set_sha256
            ),
            "readiness_configuration_generation_sha256": (
                self.readiness_configuration_generation_sha256
            ),
            "requested_truth_policy": self.requested_truth_policy.value,
            "schema_version": self.schema_version,
            "trainer_source_tree_sha256": self.trainer_source_tree_sha256,
            "training_admission_policy_sha256": (self.training_admission_policy_sha256),
        }

    @classmethod
    def from_json_bytes(
        cls,
        raw: bytes,
    ) -> "ProtectedTrainingConfigurationGenerationV2":
        try:
            fields = _parse_contract(
                raw,
                label=cls._LABEL,
                domain=cls._DOMAIN,
                fields={
                    name
                    for name in cls.__dataclass_fields__
                    if not name.startswith("_")
                },
                maximum_bytes=cls._MAXIMUM_BYTES,
                maximum_depth=2,
                maximum_nodes=48,
                maximum_containers=1,
            )
            fields["requested_truth_policy"] = enum_from_json(
                AnnotationMinimumTruthPolicy,
                fields["requested_truth_policy"],
                "requested_truth_policy",
            )
            result = cls(**fields)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingProtectedConfigurationError(
                "PROTECTED_TRAINING_CONFIGURATION_WIRE",
                "protected training configuration fields are invalid",
            ) from exc
        if result.to_json_bytes() != raw:
            _fail(
                "PROTECTED_TRAINING_CONFIGURATION_WIRE",
                "protected training configuration did not reconstruct exactly",
            )
        return result


def load_decoder_runtime_pins_v1(path: Path) -> DecoderRuntimePinsV1:
    """Read one protected decoder-runtime pin contract from an exact path."""

    raw = read_protected_file_bytes(
        path,
        max_bytes=MAX_DECODER_RUNTIME_PINS_BYTES,
        label="decoder runtime pins",
    )
    result = DecoderRuntimePinsV1.from_json_bytes(raw)
    if type(result) is not DecoderRuntimePinsV1 or result.to_json_bytes() != raw:
        _fail(
            "DECODER_RUNTIME_PINS_WIRE",
            "loaded decoder runtime pins did not reconstruct exactly",
        )
    return result


def load_label_bundle_current_pin_set_v1(
    path: Path,
) -> LabelBundleCurrentPinSetV1:
    """Read one protected current-label pin set from an exact path."""

    raw = read_protected_file_bytes(
        path,
        max_bytes=MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES,
        label="label bundle current pin set",
    )
    result = LabelBundleCurrentPinSetV1.from_json_bytes(raw)
    if type(result) is not LabelBundleCurrentPinSetV1 or (
        result.to_json_bytes() != raw
    ):
        _fail(
            "LABEL_BUNDLE_CURRENT_PIN_SET_WIRE",
            "loaded label bundle current pin set did not reconstruct exactly",
        )
    return result


def load_capture_classification_current_pin_set_v1(
    path: Path,
) -> CaptureClassificationCurrentPinSetV1:
    """Read one protected current capture-classification pin set."""

    raw = read_protected_file_bytes(
        path,
        max_bytes=MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_BYTES,
        label="capture classification current pin set",
    )
    result = CaptureClassificationCurrentPinSetV1.from_json_bytes(raw)
    if type(result) is not CaptureClassificationCurrentPinSetV1 or (
        result.to_json_bytes() != raw
    ):
        _fail(
            "CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_WIRE",
            "loaded capture classification pin set did not reconstruct exactly",
        )
    return result


def load_protected_training_configuration_generation_v2(
    path: Path,
) -> ProtectedTrainingConfigurationGenerationV2:
    """Read one protected training configuration generation from an exact path."""

    raw = read_protected_file_bytes(
        path,
        max_bytes=MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES,
        label="protected training configuration generation",
    )
    result = ProtectedTrainingConfigurationGenerationV2.from_json_bytes(raw)
    if type(result) is not ProtectedTrainingConfigurationGenerationV2 or (
        result.to_json_bytes() != raw
    ):
        _fail(
            "PROTECTED_TRAINING_CONFIGURATION_WIRE",
            "loaded protected training configuration did not reconstruct exactly",
        )
    return result


__all__ = [
    "CAPTURE_CLASSIFICATION_CURRENT_PIN_DOMAIN",
    "CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_DOMAIN",
    "DECODER_RUNTIME_PINS_DOMAIN",
    "LABEL_BUNDLE_CURRENT_PIN_DOMAIN",
    "LABEL_BUNDLE_CURRENT_PIN_SET_DOMAIN",
    "MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_BYTES",
    "MAX_CAPTURE_CLASSIFICATION_CURRENT_PIN_SET_BYTES",
    "MAX_DECODER_RUNTIME_PINS_BYTES",
    "MAX_LABEL_BUNDLE_CURRENT_PIN_BYTES",
    "MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES",
    "MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES",
    "PROTECTED_TRAINING_CONFIGURATION_GENERATION_DOMAIN",
    "PROTECTED_TRAINING_CONFIGURATION_GENERATION_SCHEMA_VERSION",
    "TRAINING_PROTECTED_CONFIGURATION_SCHEMA_VERSION",
    "CaptureClassificationCurrentPinSetV1",
    "CaptureClassificationCurrentPinV1",
    "DecoderRuntimePinsV1",
    "LabelBundleCurrentPinSetV1",
    "LabelBundleCurrentPinV1",
    "ProtectedTrainingConfigurationGenerationV2",
    "TrainingProtectedConfigurationError",
    "load_capture_classification_current_pin_set_v1",
    "load_decoder_runtime_pins_v1",
    "load_label_bundle_current_pin_set_v1",
    "load_protected_training_configuration_generation_v2",
]
