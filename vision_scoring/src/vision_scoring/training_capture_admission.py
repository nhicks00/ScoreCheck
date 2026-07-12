"""Protected acquisition of one current capture-classification receipt.

This module is deliberately a verifier, not an admission decision point.  It
loads publisher-controlled currentness pins, consumes one object under one
immutable-generation lease, and returns only non-authorizing in-memory
evidence.  It cannot persist a manifest, invoke a trainer, or authorize any
downstream action.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .capture_profile_contracts import (
    MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
    CaptureClassificationStatusV1,
    CaptureProfileClassificationV1,
    CaptureSourceClassificationV1,
    LensTopologyV1,
    NominalBitrateBasisV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
    ViewTopologyV1,
)
from .contract_wire import require_sha256, require_stable_id
from .immutable_store import ImmutableStoreError, generation_read_lease
from .training_protected_configuration import (
    CaptureClassificationCurrentPinSetV1,
    ProtectedTrainingConfigurationGenerationV2,
    load_capture_classification_current_pin_set_v1,
    load_protected_training_configuration_generation_v2,
)


TRAINING_CAPTURE_ADMISSION_ERROR_CODES = frozenset(
    {
        "CAPTURE_ADMISSION_INPUT",
        "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION",
        "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION_MISMATCH",
        "CAPTURE_ADMISSION_PIN_SET",
        "CAPTURE_ADMISSION_PIN_SET_MISMATCH",
        "CAPTURE_ADMISSION_GENERATION_MISMATCH",
        "CAPTURE_ADMISSION_SOURCE_NOT_PINNED",
        "CAPTURE_ADMISSION_DESCRIPTOR_SET_MISMATCH",
        "CAPTURE_ADMISSION_STORE",
        "CAPTURE_ADMISSION_OBJECT_WIRE",
        "CAPTURE_ADMISSION_OBJECT_MISMATCH",
        "CAPTURE_ADMISSION_ABSTAINED",
        "CAPTURE_ADMISSION_UNSUPPORTED_MODE",
        "CAPTURE_ADMISSION_INCOMPLETE_PROVENANCE",
        "CAPTURE_ADMISSION_AUTHORITY",
        "CAPTURE_ADMISSION_PROTECTED_RELOAD_CHANGED",
    }
)

_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)

_SUPPORTED_MODES = frozenset(
    {
        TrainingCaptureModeV1.HD_1080P30,
        TrainingCaptureModeV1.HD_1080P60,
        TrainingCaptureModeV1.UHD_4K60,
    }
)


class TrainingCaptureAdmissionError(ValueError):
    """A fail-closed capture-evidence acquisition error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        if code not in TRAINING_CAPTURE_ADMISSION_ERROR_CODES:
            raise ValueError("training capture admission error code is invalid")
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingCaptureAdmissionError(code, message)


@dataclass(frozen=True, slots=True)
class VerifiedTrainingCaptureClassificationV1:
    """Immutable, non-authorizing evidence for one protected current receipt."""

    source_id: str
    protected_training_configuration_generation_sha256: str
    capture_classification_current_pin_set_sha256: str
    capture_classification_generation_id: str
    capture_profile_classification_sha256: str
    source_classification_proof_set_sha256: str
    capture_classification_proof_set_sha256: str
    source_representation: SourceRepresentationV1
    source_classification: CaptureSourceClassificationV1
    training_capture_mode: TrainingCaptureModeV1
    classification: CaptureProfileClassificationV1
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False

    def __post_init__(self) -> None:
        require_stable_id(self.source_id, "source_id")
        for field_name in (
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
            "source_classification_proof_set_sha256",
            "capture_classification_proof_set_sha256",
        ):
            require_sha256(getattr(self, field_name), field_name)
        if type(self.source_representation) is not SourceRepresentationV1:
            raise ValueError("source_representation must be exact V1")
        if type(self.source_classification) is not CaptureSourceClassificationV1:
            raise ValueError("source_classification must be exact V1")
        if type(self.training_capture_mode) is not TrainingCaptureModeV1:
            raise ValueError("training_capture_mode must be exact V1")
        if type(self.classification) is not CaptureProfileClassificationV1:
            raise ValueError("classification must be an exact V1 receipt")
        if self.classification.status is not CaptureClassificationStatusV1.CLASSIFIED:
            raise ValueError("classification must have exact CLASSIFIED status")
        if self.classification.fingerprint() != self.capture_profile_classification_sha256:
            raise ValueError("classification fingerprint differs from its coordinate")
        if self.classification.source_capture_facts.source_id != self.source_id:
            raise ValueError("classification source differs from its coordinate")
        if (
            self.classification.source_classification_proof_set_sha256
            != self.source_classification_proof_set_sha256
            or self.classification.capture_classification_proof_set_sha256
            != self.capture_classification_proof_set_sha256
        ):
            raise ValueError("classification proof coordinates differ from receipt")
        if (
            self.classification.encoder_configuration.source_representation
            is not self.source_representation
            or self.classification.source_capture_facts.source_classification
            is not self.source_classification
            or self.classification.training_capture_mode is not self.training_capture_mode
        ):
            raise ValueError("classification facts differ from evidence coordinates")
        for field_name in _AUTHORITY_FIELDS:
            if getattr(self, field_name) is not False:
                raise ValueError(f"{field_name} must be exactly false")

    def __reduce__(self) -> object:
        raise TypeError("verified training capture evidence is not serializable")

    def __reduce_ex__(self, protocol: int) -> object:
        del protocol
        raise TypeError("verified training capture evidence is not serializable")

    def __copy__(self) -> object:
        raise TypeError("verified training capture evidence is not copyable")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("verified training capture evidence is not copyable")


def _validate_inputs(
    *,
    protected_training_configuration_path: Path,
    capture_classification_current_pin_set_path: Path,
    capture_classification_store_root: Path,
    capture_classification_generation_id: str,
    source_id: str,
    expected_protected_training_configuration_generation_sha256: str,
) -> None:
    platform_path_type = type(Path())
    for value, label in (
        (protected_training_configuration_path, "protected configuration path"),
        (
            capture_classification_current_pin_set_path,
            "capture classification pin-set path",
        ),
        (capture_classification_store_root, "capture classification store root"),
    ):
        if type(value) is not platform_path_type or not value.is_absolute():
            _fail(
                "CAPTURE_ADMISSION_INPUT",
                f"{label} must be an exact absolute pathlib.Path",
            )
    try:
        require_sha256(
            capture_classification_generation_id,
            "capture_classification_generation_id",
        )
        require_sha256(
            expected_protected_training_configuration_generation_sha256,
            "expected_protected_training_configuration_generation_sha256",
        )
        require_stable_id(source_id, "source_id")
    except ValueError as exc:
        raise TrainingCaptureAdmissionError(
            "CAPTURE_ADMISSION_INPUT", "capture admission coordinates are invalid"
        ) from exc


def _load_protected_configuration(
    path: Path,
) -> ProtectedTrainingConfigurationGenerationV2:
    try:
        result = load_protected_training_configuration_generation_v2(path)
    except (OSError, ValueError) as exc:
        raise TrainingCaptureAdmissionError(
            "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION",
            "protected training configuration could not be loaded exactly",
        ) from exc
    if type(result) is not ProtectedTrainingConfigurationGenerationV2:
        _fail(
            "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION",
            "protected training configuration has the wrong exact type",
        )
    return result


def _load_pin_set(path: Path) -> CaptureClassificationCurrentPinSetV1:
    try:
        result = load_capture_classification_current_pin_set_v1(path)
    except (OSError, ValueError) as exc:
        raise TrainingCaptureAdmissionError(
            "CAPTURE_ADMISSION_PIN_SET",
            "capture classification pin set could not be loaded exactly",
        ) from exc
    if type(result) is not CaptureClassificationCurrentPinSetV1:
        _fail(
            "CAPTURE_ADMISSION_PIN_SET",
            "capture classification pin set has the wrong exact type",
        )
    return result


def _require_supported_provenance(
    classification: CaptureProfileClassificationV1,
) -> None:
    encoder = classification.encoder_configuration
    profile = classification.capture_profile
    source = classification.source_capture_facts
    pair_is_supported = (
        source.source_classification
        is CaptureSourceClassificationV1.OWNER_PRODUCED_LIVE
        and encoder.source_representation
        is SourceRepresentationV1.LIVE_ENCODER_OUTPUT
    ) or (
        source.source_classification
        is CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE
        and encoder.source_representation
        in {
            SourceRepresentationV1.ORIGINAL_CAMERA_MASTER,
            SourceRepresentationV1.PLATFORM_TRANSCODE,
        }
    ) or (
        source.source_classification
        is CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
        and encoder.source_representation
        is SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE
    )
    if (
        source.source_provenance_complete is not True
        or not pair_is_supported
        or source.source_classification
        is CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
        or encoder.source_representation is SourceRepresentationV1.UNKNOWN
        or encoder.nominal_bitrate_basis is NominalBitrateBasisV1.UNKNOWN
        or profile.lens_topology is LensTopologyV1.UNKNOWN
        or profile.view_topology is not ViewTopologyV1.SINGLE_VIEW
        or profile.view_count != 1
    ):
        _fail(
            "CAPTURE_ADMISSION_INCOMPLETE_PROVENANCE",
            "classification lacks complete supported source provenance",
        )


def verify_training_capture_classification_v1(
    *,
    protected_training_configuration_path: Path,
    capture_classification_current_pin_set_path: Path,
    capture_classification_store_root: Path,
    capture_classification_generation_id: str,
    source_id: str,
    expected_protected_training_configuration_generation_sha256: str,
) -> VerifiedTrainingCaptureClassificationV1:
    """Acquire one exact current classification without granting authority."""

    _validate_inputs(
        protected_training_configuration_path=protected_training_configuration_path,
        capture_classification_current_pin_set_path=(
            capture_classification_current_pin_set_path
        ),
        capture_classification_store_root=capture_classification_store_root,
        capture_classification_generation_id=(capture_classification_generation_id),
        source_id=source_id,
        expected_protected_training_configuration_generation_sha256=(
            expected_protected_training_configuration_generation_sha256
        ),
    )
    protected_configuration = _load_protected_configuration(
        protected_training_configuration_path
    )
    protected_configuration_sha256 = protected_configuration.fingerprint()
    if (
        protected_configuration_sha256
        != expected_protected_training_configuration_generation_sha256
    ):
        _fail(
            "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION_MISMATCH",
            "protected configuration differs from the independent expected pin",
        )

    pin_set = _load_pin_set(capture_classification_current_pin_set_path)
    pin_set_sha256 = pin_set.fingerprint()
    if (
        protected_configuration.capture_classification_current_pin_set_sha256
        != pin_set_sha256
    ):
        _fail(
            "CAPTURE_ADMISSION_PIN_SET_MISMATCH",
            "protected configuration does not bind the loaded pin set",
        )
    if (
        pin_set.capture_classification_generation_id
        != capture_classification_generation_id
    ):
        _fail(
            "CAPTURE_ADMISSION_GENERATION_MISMATCH",
            "pin-set generation differs from the requested leased generation",
        )

    selected_pin = next(
        (pin for pin in pin_set.pins if pin.source_id == source_id),
        None,
    )
    if selected_pin is None:
        _fail(
            "CAPTURE_ADMISSION_SOURCE_NOT_PINNED",
            "source is absent from the protected current pin set",
        )
    exact_object_set = tuple(
        sorted(pin.capture_profile_classification_sha256 for pin in pin_set.pins)
    )

    try:
        with generation_read_lease(
            capture_classification_store_root,
            capture_classification_generation_id,
        ) as lease:
            if lease.descriptor.object_sha256s != exact_object_set:
                _fail(
                    "CAPTURE_ADMISSION_DESCRIPTOR_SET_MISMATCH",
                    "classification generation has missing or extra objects",
                )
            try:
                with lease.open_verified_object(
                    selected_pin.capture_profile_classification_sha256,
                    max_bytes=MAX_CAPTURE_PROFILE_CONTRACT_BYTES,
                ) as staged:
                    raw = staged.read(MAX_CAPTURE_PROFILE_CONTRACT_BYTES + 1)
            except (ImmutableStoreError, OSError, RuntimeError, ValueError) as exc:
                raise TrainingCaptureAdmissionError(
                    "CAPTURE_ADMISSION_STORE",
                    "classification object verification failed closed",
                ) from exc
            if len(raw) > MAX_CAPTURE_PROFILE_CONTRACT_BYTES:
                _fail(
                    "CAPTURE_ADMISSION_OBJECT_WIRE",
                    "classification object exceeds its fixed byte limit",
                )
            try:
                classification = CaptureProfileClassificationV1.from_json_bytes(raw)
            except (KeyError, TypeError, ValueError) as exc:
                raise TrainingCaptureAdmissionError(
                    "CAPTURE_ADMISSION_OBJECT_WIRE",
                    "classification object did not reconstruct exactly",
                ) from exc
            if type(classification) is not CaptureProfileClassificationV1 or (
                classification.to_json_bytes() != raw
                or classification.fingerprint()
                != selected_pin.capture_profile_classification_sha256
                or classification.source_capture_facts.source_id != source_id
                or selected_pin.source_id != source_id
            ):
                _fail(
                    "CAPTURE_ADMISSION_OBJECT_MISMATCH",
                    "classification object differs from its protected coordinates",
                )

            if classification.status is not CaptureClassificationStatusV1.CLASSIFIED:
                _fail(
                    "CAPTURE_ADMISSION_ABSTAINED",
                    "classification receipt abstained from naming a capture mode",
                )
            if (
                type(classification.training_capture_mode)
                is not TrainingCaptureModeV1
                or classification.training_capture_mode not in _SUPPORTED_MODES
            ):
                _fail(
                    "CAPTURE_ADMISSION_UNSUPPORTED_MODE",
                    "classification does not name an exact supported capture mode",
                )
            _require_supported_provenance(classification)
            if any(
                getattr(classification, field_name) is not False
                for field_name in _AUTHORITY_FIELDS
            ):
                _fail(
                    "CAPTURE_ADMISSION_AUTHORITY",
                    "classification receipt contains an authority assertion",
                )

            try:
                reloaded_configuration = _load_protected_configuration(
                    protected_training_configuration_path
                )
                reloaded_pin_set = _load_pin_set(
                    capture_classification_current_pin_set_path
                )
            except TrainingCaptureAdmissionError as exc:
                raise TrainingCaptureAdmissionError(
                    "CAPTURE_ADMISSION_PROTECTED_RELOAD_CHANGED",
                    "protected inputs became unavailable or invalid during use",
                ) from exc
            if (
                reloaded_configuration != protected_configuration
                or reloaded_configuration.fingerprint()
                != protected_configuration_sha256
                or reloaded_pin_set != pin_set
                or reloaded_pin_set.fingerprint() != pin_set_sha256
            ):
                _fail(
                    "CAPTURE_ADMISSION_PROTECTED_RELOAD_CHANGED",
                    "protected configuration or current pin set changed during use",
                )
    except TrainingCaptureAdmissionError:
        raise
    except (ImmutableStoreError, OSError, RuntimeError, ValueError) as exc:
        raise TrainingCaptureAdmissionError(
            "CAPTURE_ADMISSION_STORE",
            "classification generation lease failed closed",
        ) from exc

    return VerifiedTrainingCaptureClassificationV1(
        source_id=source_id,
        protected_training_configuration_generation_sha256=(
            protected_configuration_sha256
        ),
        capture_classification_current_pin_set_sha256=pin_set_sha256,
        capture_classification_generation_id=capture_classification_generation_id,
        capture_profile_classification_sha256=(
            selected_pin.capture_profile_classification_sha256
        ),
        source_classification_proof_set_sha256=(
            classification.source_classification_proof_set_sha256
        ),
        capture_classification_proof_set_sha256=(
            classification.capture_classification_proof_set_sha256
        ),
        source_representation=(
            classification.encoder_configuration.source_representation
        ),
        source_classification=(
            classification.source_capture_facts.source_classification
        ),
        training_capture_mode=classification.training_capture_mode,
        classification=classification,
    )


__all__ = [
    "TRAINING_CAPTURE_ADMISSION_ERROR_CODES",
    "TrainingCaptureAdmissionError",
    "VerifiedTrainingCaptureClassificationV1",
    "verify_training_capture_classification_v1",
]
