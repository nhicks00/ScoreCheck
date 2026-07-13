"""Pure, non-authorizing join of one training example to capture evidence.

The protected acquisition boundary returns a
``VerifiedTrainingCaptureClassificationV1``.  This module checks that one
canonical ``TrainingExampleManifestV3`` names that exact evidence and its
nested capture facts.  It performs no I/O, persists nothing, and cannot admit
an example to any dataset or consumer.
"""

from __future__ import annotations

from .capture_profile_contracts import (
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
from .training_admission_contracts import (
    TrainingExampleManifestV3,
    camera_risk_key_sha256_v2,
)
from .training_capture_admission import VerifiedTrainingCaptureClassificationV1


TRAINING_EXAMPLE_CAPTURE_BINDING_ERROR_CODES = frozenset(
    {
        "EXAMPLE_CAPTURE_BINDING_INPUT",
        "EXAMPLE_CAPTURE_BINDING_MANIFEST",
        "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
        "EXAMPLE_CAPTURE_BINDING_AUTHORITY",
        "EXAMPLE_CAPTURE_BINDING_PROVENANCE",
        "EXAMPLE_CAPTURE_BINDING_JOIN",
        "EXAMPLE_CAPTURE_BINDING_CONTRACT",
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


class TrainingExampleCaptureBindingError(ValueError):
    """A fail-closed example/capture join error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        if code not in TRAINING_EXAMPLE_CAPTURE_BINDING_ERROR_CODES:
            raise ValueError("training example capture binding error code is invalid")
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingExampleCaptureBindingError(code, message)


def _require_false_authority(value: object, *, label: str) -> None:
    try:
        values = tuple(getattr(value, field_name) for field_name in _AUTHORITY_FIELDS)
    except (AttributeError, TypeError) as exc:
        raise TrainingExampleCaptureBindingError(
            "EXAMPLE_CAPTURE_BINDING_AUTHORITY",
            f"{label} authority coordinates are unavailable",
        ) from exc
    if any(type(selected) is not bool or selected is not False for selected in values):
        _fail(
            "EXAMPLE_CAPTURE_BINDING_AUTHORITY",
            f"{label} authority coordinates must remain exactly false",
        )


def _revalidate_manifest(
    manifest: TrainingExampleManifestV3,
) -> tuple[TrainingExampleManifestV3, str]:
    if type(manifest) is not TrainingExampleManifestV3:
        _fail(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            "manifest has the wrong exact type",
        )
    _require_false_authority(manifest, label="manifest")
    try:
        raw = manifest.to_json_bytes()
        normalized = TrainingExampleManifestV3.from_json_bytes(raw)
        if (
            type(raw) is not bytes
            or type(normalized) is not TrainingExampleManifestV3
            or normalized != manifest
            or normalized.to_json_bytes() != raw
        ):
            raise ValueError("manifest did not reconstruct exactly")
        fingerprint = manifest.fingerprint()
        if normalized.fingerprint() != fingerprint:
            raise ValueError("manifest fingerprint changed during reconstruction")
    except (AttributeError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingExampleCaptureBindingError(
            "EXAMPLE_CAPTURE_BINDING_MANIFEST",
            "manifest bytes or fields no longer validate canonically",
        ) from exc
    return normalized, fingerprint


def _revalidate_evidence(
    evidence: VerifiedTrainingCaptureClassificationV1,
) -> tuple[VerifiedTrainingCaptureClassificationV1, CaptureProfileClassificationV1]:
    if type(evidence) is not VerifiedTrainingCaptureClassificationV1:
        _fail(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            "capture evidence has the wrong exact type",
        )
    _require_false_authority(evidence, label="capture evidence")
    try:
        classification = evidence.classification
        if type(classification) is not CaptureProfileClassificationV1:
            raise TypeError("classification receipt has the wrong exact type")
        _require_false_authority(classification, label="classification receipt")
        raw = classification.to_json_bytes()
        normalized_classification = (
            CaptureProfileClassificationV1.from_json_bytes(raw)
        )
        if (
            type(raw) is not bytes
            or type(normalized_classification) is not CaptureProfileClassificationV1
            or normalized_classification != classification
            or normalized_classification.to_json_bytes() != raw
            or normalized_classification.fingerprint()
            != evidence.capture_profile_classification_sha256
        ):
            raise ValueError("classification receipt did not reconstruct exactly")
        normalized_evidence = VerifiedTrainingCaptureClassificationV1(
            source_id=evidence.source_id,
            protected_training_configuration_generation_sha256=(
                evidence.protected_training_configuration_generation_sha256
            ),
            capture_classification_current_pin_set_sha256=(
                evidence.capture_classification_current_pin_set_sha256
            ),
            capture_classification_generation_id=(
                evidence.capture_classification_generation_id
            ),
            capture_profile_classification_sha256=(
                evidence.capture_profile_classification_sha256
            ),
            source_classification_proof_set_sha256=(
                evidence.source_classification_proof_set_sha256
            ),
            capture_classification_proof_set_sha256=(
                evidence.capture_classification_proof_set_sha256
            ),
            source_representation=evidence.source_representation,
            source_classification=evidence.source_classification,
            training_capture_mode=evidence.training_capture_mode,
            classification=normalized_classification,
            admissible_for_training=evidence.admissible_for_training,
            admissible_for_evaluation=evidence.admissible_for_evaluation,
            admissible_for_test=evidence.admissible_for_test,
            admissible_for_deployment=evidence.admissible_for_deployment,
            admissible_for_live_scoring=evidence.admissible_for_live_scoring,
        )
        if normalized_evidence != evidence:
            raise ValueError("capture evidence did not reconstruct exactly")
    except TrainingExampleCaptureBindingError:
        raise
    except (AttributeError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingExampleCaptureBindingError(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            "capture evidence or receipt no longer validates exactly",
        ) from exc
    return normalized_evidence, normalized_classification


def _require_supported_provenance(
    classification: CaptureProfileClassificationV1,
) -> None:
    encoder = classification.encoder_configuration
    profile = classification.capture_profile
    source = classification.source_capture_facts
    source_pair_is_supported = (
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
        classification.status is not CaptureClassificationStatusV1.CLASSIFIED
        or type(classification.training_capture_mode) is not TrainingCaptureModeV1
        or classification.training_capture_mode not in _SUPPORTED_MODES
        or classification.abstention_reason is not None
        or source.source_provenance_complete is not True
        or not source_pair_is_supported
        or source.source_classification
        is CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
        or encoder.source_representation is SourceRepresentationV1.UNKNOWN
        or encoder.nominal_bitrate_basis is NominalBitrateBasisV1.UNKNOWN
        or profile.lens_topology is LensTopologyV1.UNKNOWN
        or profile.view_topology is not ViewTopologyV1.SINGLE_VIEW
        or profile.view_count != 1
    ):
        _fail(
            "EXAMPLE_CAPTURE_BINDING_PROVENANCE",
            "capture evidence lacks one complete supported classified provenance",
        )


def _require_exact_join(
    *,
    manifest: TrainingExampleManifestV3,
    evidence: VerifiedTrainingCaptureClassificationV1,
    classification: CaptureProfileClassificationV1,
) -> None:
    encoder = classification.encoder_configuration
    profile = classification.capture_profile
    source = classification.source_capture_facts
    profile_sha256 = profile.fingerprint()
    encoder_sha256 = encoder.fingerprint()
    joined_coordinates = (
        manifest.source_id == evidence.source_id == source.source_id,
        manifest.protected_training_configuration_generation_sha256
        == evidence.protected_training_configuration_generation_sha256,
        manifest.capture_classification_current_pin_set_sha256
        == evidence.capture_classification_current_pin_set_sha256,
        manifest.capture_classification_generation_id
        == evidence.capture_classification_generation_id,
        manifest.capture_profile_classification_sha256
        == evidence.capture_profile_classification_sha256
        == classification.fingerprint(),
        manifest.capture_profile_id == profile.capture_profile_id,
        manifest.capture_profile_sha256
        == profile_sha256
        == source.capture_profile_sha256,
        manifest.encoder_configuration_sha256
        == encoder_sha256
        == profile.encoder_configuration_sha256,
        manifest.capture_mode
        is evidence.training_capture_mode
        is classification.training_capture_mode,
        manifest.compression_stratum is profile.compression_stratum,
        manifest.source_representation
        is evidence.source_representation
        is encoder.source_representation,
        manifest.source_classification
        is evidence.source_classification
        is source.source_classification,
        manifest.capture_risk_tags == classification.capture_risk_tags,
        evidence.source_classification_proof_set_sha256
        == classification.source_classification_proof_set_sha256,
        evidence.capture_classification_proof_set_sha256
        == classification.capture_classification_proof_set_sha256,
    )
    if not all(joined_coordinates):
        _fail(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            "manifest and protected capture evidence differ on an exact coordinate",
        )
    try:
        expected_camera_risk_key = camera_risk_key_sha256_v2(
            capture_mode=evidence.training_capture_mode,
            camera_setup_id=manifest.camera_setup_id,
            capture_profile_sha256=profile_sha256,
            lighting_condition_id=manifest.lighting_condition_id,
            encoder_configuration_sha256=encoder_sha256,
            source_representation=evidence.source_representation,
            source_classification=evidence.source_classification,
        )
    except (AttributeError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingExampleCaptureBindingError(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            "camera-risk inputs could not be recomputed from the joined evidence",
        ) from exc
    if manifest.camera_risk_key_sha256 != expected_camera_risk_key:
        _fail(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            "camera-risk key does not bind the joined capture evidence",
        )


class TrainingExampleCaptureBindingEvidenceV1(tuple[object, ...]):
    """Structural, non-authorizing evidence for a manifest/capture join.

    This type is publicly constructible and is neither verified nor a
    capability.  A downstream consumer must call :meth:`validate_against`
    with the original exact manifest and capture evidence immediately before
    use.  Type identity and stored coordinates alone prove nothing.  Tuple
    storage prevents field injection or mutation through ``object.__setattr__``.
    """

    __slots__ = ()

    _SOURCE_ID = 0
    _MANIFEST = 1
    _PROTECTED_CONFIGURATION = 2
    _PIN_SET = 3
    _GENERATION = 4
    _CLASSIFICATION = 5
    _SOURCE_PROOF = 6
    _CAPTURE_PROOF = 7
    _PROFILE = 8
    _ENCODER = 9
    _LENGTH = 10

    def __new__(
        cls,
        *,
        source_id: str,
        training_example_manifest_sha256: str,
        protected_training_configuration_generation_sha256: str,
        capture_classification_current_pin_set_sha256: str,
        capture_classification_generation_id: str,
        capture_profile_classification_sha256: str,
        source_classification_proof_set_sha256: str,
        capture_classification_proof_set_sha256: str,
        capture_profile_sha256: str,
        encoder_configuration_sha256: str,
    ) -> TrainingExampleCaptureBindingEvidenceV1:
        if cls is not TrainingExampleCaptureBindingEvidenceV1:
            raise TypeError("example/capture binding evidence cannot be subclassed")
        require_stable_id(source_id, "source_id")
        digests = (
            require_sha256(
                training_example_manifest_sha256,
                "training_example_manifest_sha256",
            ),
            require_sha256(
                protected_training_configuration_generation_sha256,
                "protected_training_configuration_generation_sha256",
            ),
            require_sha256(
                capture_classification_current_pin_set_sha256,
                "capture_classification_current_pin_set_sha256",
            ),
            require_sha256(
                capture_classification_generation_id,
                "capture_classification_generation_id",
            ),
            require_sha256(
                capture_profile_classification_sha256,
                "capture_profile_classification_sha256",
            ),
            require_sha256(
                source_classification_proof_set_sha256,
                "source_classification_proof_set_sha256",
            ),
            require_sha256(
                capture_classification_proof_set_sha256,
                "capture_classification_proof_set_sha256",
            ),
            require_sha256(
                capture_profile_sha256,
                "capture_profile_sha256",
            ),
            require_sha256(
                encoder_configuration_sha256,
                "encoder_configuration_sha256",
            ),
        )
        if len(digests) != len(set(digests)):
            raise ValueError("typed example/capture binding digest roles must not alias")
        return tuple.__new__(
            cls,
            (
                source_id,
                *digests,
            ),
        )

    @property
    def source_id(self) -> str:
        return self[self._SOURCE_ID]  # type: ignore[return-value]

    @property
    def training_example_manifest_sha256(self) -> str:
        return self[self._MANIFEST]  # type: ignore[return-value]

    @property
    def protected_training_configuration_generation_sha256(self) -> str:
        return self[self._PROTECTED_CONFIGURATION]  # type: ignore[return-value]

    @property
    def capture_classification_current_pin_set_sha256(self) -> str:
        return self[self._PIN_SET]  # type: ignore[return-value]

    @property
    def capture_classification_generation_id(self) -> str:
        return self[self._GENERATION]  # type: ignore[return-value]

    @property
    def capture_profile_classification_sha256(self) -> str:
        return self[self._CLASSIFICATION]  # type: ignore[return-value]

    @property
    def source_classification_proof_set_sha256(self) -> str:
        return self[self._SOURCE_PROOF]  # type: ignore[return-value]

    @property
    def capture_classification_proof_set_sha256(self) -> str:
        return self[self._CAPTURE_PROOF]  # type: ignore[return-value]

    @property
    def capture_profile_sha256(self) -> str:
        return self[self._PROFILE]  # type: ignore[return-value]

    @property
    def encoder_configuration_sha256(self) -> str:
        return self[self._ENCODER]  # type: ignore[return-value]

    def _has_valid_structure(self) -> bool:
        try:
            if (
                type(self) is not TrainingExampleCaptureBindingEvidenceV1
                or len(self) != self._LENGTH
            ):
                return False
            require_stable_id(self.source_id, "source_id")
            digests = tuple(
                require_sha256(value, "binding evidence digest")
                for value in self[1:10]
            )
            return len(digests) == len(set(digests))
        except (IndexError, TypeError, ValueError):
            return False

    def validate_against(
        self,
        *,
        manifest: TrainingExampleManifestV3,
        capture_evidence: VerifiedTrainingCaptureClassificationV1,
    ) -> None:
        """Revalidate exact originals at a downstream consumption boundary."""

        if not self._has_valid_structure():
            _fail(
                "EXAMPLE_CAPTURE_BINDING_CONTRACT",
                "example/capture binding evidence structure is invalid",
            )
        expected = bind_training_example_capture_v1(
            manifest=manifest,
            capture_evidence=capture_evidence,
        )
        if self != expected:
            _fail(
                "EXAMPLE_CAPTURE_BINDING_JOIN",
                "binding evidence differs from the current manifest/evidence join",
            )

    def __reduce__(self) -> object:
        raise TypeError("example/capture binding evidence is not serializable")

    def __reduce_ex__(self, protocol: int) -> object:
        del protocol
        raise TypeError("example/capture binding evidence is not serializable")

    def __copy__(self) -> object:
        raise TypeError("example/capture binding evidence is not copyable")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("example/capture binding evidence is not copyable")


def bind_training_example_capture_v1(
    *,
    manifest: TrainingExampleManifestV3,
    capture_evidence: VerifiedTrainingCaptureClassificationV1,
) -> TrainingExampleCaptureBindingEvidenceV1:
    """Construct convenience evidence after one exact non-authorizing join.

    Consumers must still call ``result.validate_against(...)`` at their own
    consumption boundary; the returned structural type is not trustworthy by
    identity.
    """

    normalized_manifest, manifest_sha256 = _revalidate_manifest(manifest)
    normalized_evidence, classification = _revalidate_evidence(capture_evidence)
    _require_supported_provenance(classification)
    _require_exact_join(
        manifest=normalized_manifest,
        evidence=normalized_evidence,
        classification=classification,
    )
    try:
        result = TrainingExampleCaptureBindingEvidenceV1(
            source_id=normalized_manifest.source_id,
            training_example_manifest_sha256=manifest_sha256,
            protected_training_configuration_generation_sha256=(
                normalized_evidence.protected_training_configuration_generation_sha256
            ),
            capture_classification_current_pin_set_sha256=(
                normalized_evidence.capture_classification_current_pin_set_sha256
            ),
            capture_classification_generation_id=(
                normalized_evidence.capture_classification_generation_id
            ),
            capture_profile_classification_sha256=(
                normalized_evidence.capture_profile_classification_sha256
            ),
            source_classification_proof_set_sha256=(
                normalized_evidence.source_classification_proof_set_sha256
            ),
            capture_classification_proof_set_sha256=(
                normalized_evidence.capture_classification_proof_set_sha256
            ),
            capture_profile_sha256=(
                classification.capture_profile.fingerprint()
            ),
            encoder_configuration_sha256=(
                classification.encoder_configuration.fingerprint()
            ),
        )
    except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise TrainingExampleCaptureBindingError(
            "EXAMPLE_CAPTURE_BINDING_CONTRACT",
            "example/capture binding evidence could not be constructed",
        ) from exc
    return result


__all__ = (
    "TRAINING_EXAMPLE_CAPTURE_BINDING_ERROR_CODES",
    "TrainingExampleCaptureBindingEvidenceV1",
    "TrainingExampleCaptureBindingError",
    "bind_training_example_capture_v1",
)
