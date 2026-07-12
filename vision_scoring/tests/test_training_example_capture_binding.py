from __future__ import annotations

import copy
from dataclasses import replace
import pickle
import unittest

import vision_scoring.training_example_capture_binding as binding_module
from vision_scoring.annotation_trust import AnnotationMinimumTruthPolicy
from vision_scoring.capture_profile_contracts import (
    CadenceTypeV1,
    CaptureClassificationStatusV1,
    CaptureProfileClassificationV1,
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CaptureTransportV1,
    CompressionStratumV1,
    SourceCaptureFactsV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
    avkans_go_owner_live_1080p30_v1,
    classify_capture_profile_v1,
    mevo_core_owner_live_1080p60_v1,
)
from vision_scoring.training_admission_contracts import (
    CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
    CAUSAL_BALL_TARGET_ENCODING_SHA256,
    ExampleStratumTagV1,
    PrimarySamplingStratumV1,
    TargetTensorContentRowV1,
    TargetTensorDTypeV1,
    TargetTensorFieldV1,
    TrainingExampleManifestV3,
    TrainingSplitV1,
    camera_risk_key_sha256_v2,
    leakage_group_sha256_v1,
    target_tensor_set_sha256_v1,
)
from vision_scoring.training_capture_admission import (
    VerifiedTrainingCaptureClassificationV1,
)
from vision_scoring.training_example_capture_binding import (
    TRAINING_EXAMPLE_CAPTURE_BINDING_ERROR_CODES,
    TrainingExampleCaptureBindingEvidenceV1,
    TrainingExampleCaptureBindingError,
    bind_training_example_capture_v1,
)


def _digest(value: int) -> str:
    return f"{value:064x}"


def _target_rows() -> tuple[TargetTensorContentRowV1, ...]:
    frame_count = 2
    width = 16
    height = 16
    candidate_shape = (1, frame_count, 16)
    shapes = {
        TargetTensorFieldV1.HEATMAP_TARGET: (
            1,
            frame_count,
            1,
            height // 4,
            width // 4,
        ),
        TargetTensorFieldV1.HEATMAP_MASK: (1, frame_count),
        TargetTensorFieldV1.MATCH_VISIBILITY_INDEX: (1, frame_count),
        TargetTensorFieldV1.MATCH_VISIBILITY_MASK: (1, frame_count),
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP: (*candidate_shape, 2),
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_ROLE_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET: (*candidate_shape, 2),
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET: (
            candidate_shape
        ),
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_MASK: candidate_shape,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_MASK: candidate_shape,
    }
    float_fields = {
        TargetTensorFieldV1.HEATMAP_TARGET,
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET,
    }
    index_fields = {
        TargetTensorFieldV1.MATCH_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX,
    }
    return tuple(
        TargetTensorContentRowV1(
            field=field,
            dtype=(
                TargetTensorDTypeV1.IEEE754_BINARY32_LE
                if field in float_fields
                else TargetTensorDTypeV1.SIGNED_INT64_LE
                if field in index_fields
                else TargetTensorDTypeV1.BOOL_U8
            ),
            shape=shapes[field],
            content_sha256=_digest(200 + index),
        )
        for index, field in enumerate(TargetTensorFieldV1)
    )


def _live_receipt(
    source_id: str,
    *,
    mevo: bool,
    offset: int,
) -> CaptureProfileClassificationV1:
    factory = (
        mevo_core_owner_live_1080p60_v1
        if mevo
        else avkans_go_owner_live_1080p30_v1
    )
    return factory(
        source_id=source_id,
        encoder_settings_sha256=_digest(offset + 1),
        calibration_sha256=_digest(offset + 2),
        clock_model_sha256=_digest(offset + 3),
        camera_attestation_sha256=_digest(offset + 4),
        exposure_descriptor_sha256=_digest(offset + 5),
        compression_stratum=CompressionStratumV1.CONSTRAINED_INTERFRAME,
        source_risk_tags=(CaptureRiskTagV1.LOW_LIGHT,),
    )


def _phone_archive_receipt(source_id: str) -> CaptureProfileClassificationV1:
    base = _live_receipt(source_id, mevo=True, offset=80)
    encoder = replace(
        base.encoder_configuration,
        encoder_configuration_id="phone-local-h264-1080p60-v1",
        transport=CaptureTransportV1.LOCAL_CAPTURE,
        source_representation=SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE,
    )
    profile = replace(
        base.capture_profile,
        capture_profile_id="phone-consumer-1080p60-v1",
        device_model_or_class="phone.consumer-camera",
        encoder_configuration_sha256=encoder.fingerprint(),
    )
    source = SourceCaptureFactsV1(
        source_id=source_id,
        capture_profile_sha256=profile.fingerprint(),
        source_classification=(
            CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
        ),
        source_provenance_complete=True,
        source_risk_tags=(CaptureRiskTagV1.MOTION_BLUR,),
    )
    return classify_capture_profile_v1(encoder, profile, source)


def _evidence(
    receipt: CaptureProfileClassificationV1,
) -> VerifiedTrainingCaptureClassificationV1:
    return VerifiedTrainingCaptureClassificationV1(
        source_id=receipt.source_capture_facts.source_id,
        protected_training_configuration_generation_sha256=_digest(40),
        capture_classification_current_pin_set_sha256=_digest(41),
        capture_classification_generation_id=_digest(42),
        capture_profile_classification_sha256=receipt.fingerprint(),
        source_classification_proof_set_sha256=(
            receipt.source_classification_proof_set_sha256
        ),
        capture_classification_proof_set_sha256=(
            receipt.capture_classification_proof_set_sha256
        ),
        source_representation=(
            receipt.encoder_configuration.source_representation
        ),
        source_classification=(
            receipt.source_capture_facts.source_classification
        ),
        training_capture_mode=receipt.training_capture_mode,  # type: ignore[arg-type]
        classification=receipt,
    )


def _manifest(
    evidence: VerifiedTrainingCaptureClassificationV1,
) -> TrainingExampleManifestV3:
    receipt = evidence.classification
    rows = _target_rows()
    root = _digest(1)
    profile = receipt.capture_profile.fingerprint()
    encoder = receipt.encoder_configuration.fingerprint()
    capture_mode = evidence.training_capture_mode
    source_representation = evidence.source_representation
    source_classification = evidence.source_classification
    camera_setup_id = "camera-A"
    lighting_condition_id = "night-lighting"
    return TrainingExampleManifestV3(
        source_id=evidence.source_id,
        source_asset_sha256=root,
        root_asset_sha256=root,
        parent_asset_sha256=None,
        split=TrainingSplitV1.TRAIN,
        match_id="match-A",
        venue_id="venue-A",
        capture_profile_id=receipt.capture_profile.capture_profile_id,
        capture_profile_sha256=profile,
        capture_mode=capture_mode,
        camera_setup_id=camera_setup_id,
        recording_date="2026-07-01",
        ball_design_id="ball-A",
        lighting_condition_id=lighting_condition_id,
        synchronized_capture_group_id="sync-A",
        split_group_id="split-A",
        leakage_group_sha256=leakage_group_sha256_v1(
            match_id="match-A",
            root_asset_sha256=root,
            synchronized_capture_group_id="sync-A",
            split_group_id="split-A",
            venue_id="venue-A",
            camera_setup_id=camera_setup_id,
            recording_date="2026-07-01",
        ),
        camera_risk_key_sha256=camera_risk_key_sha256_v2(
            capture_mode=capture_mode,
            camera_setup_id=camera_setup_id,
            capture_profile_sha256=profile,
            lighting_condition_id=lighting_condition_id,
            encoder_configuration_sha256=encoder,
            source_representation=source_representation,
            source_classification=source_classification,
        ),
        capture_risk_tags=receipt.capture_risk_tags,
        compression_stratum=receipt.capture_profile.compression_stratum,
        encoder_configuration_sha256=encoder,
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
        source_representation=source_representation,
        source_classification=source_classification,
        artifact_generation_id=_digest(12),
        source_byte_length=8192,
        finalized_trace_sha256=_digest(13),
        capture_policy_sha256=_digest(14),
        capture_policy_generation=7,
        decoder_runtime_generation_id=_digest(15),
        decoder_runtime_manifest_sha256=_digest(16),
        decoder_runtime_id="ffmpeg-static-v1",
        decoder_recipe_sha256=_digest(17),
        decode_contract_sha256=_digest(18),
        selected_video_stream_index=0,
        source_time_base_numerator=1,
        source_time_base_denominator=60,
        label_pack_generation_id=_digest(19),
        label_pack_sha256=_digest(20),
        label_bundle_statement_sha256=_digest(21),
        bundle_id="bundle-A",
        curator_attestation_sha256=_digest(22),
        curator_trust_snapshot_sha256=_digest(23),
        curator_trust_snapshot_generation=4,
        requested_truth_policy=AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        annotation_attestation_set_sha256=_digest(24),
        annotation_trust_store_sha256=_digest(25),
        annotation_verification_policy_sha256=_digest(26),
        annotation_configuration_generation_sha256=_digest(37),
        annotation_evidence_set_sha256=_digest(38),
        annotation_evidence_generation_id=_digest(39),
        protected_verified_at_ns=1_783_814_400_000_000_000,
        rights_decision_sha256=_digest(27),
        rights_attestation_sha256=_digest(28),
        rights_evidence_generation_id=_digest(29),
        rights_trust_store_sha256=_digest(30),
        rights_verification_policy_sha256=_digest(31),
        rights_verified_on="2026-07-12",
        clip_input_receipt_sha256=_digest(32),
        input_encoding_sha256=CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
        input_tensor_sha256=_digest(34),
        frame_identity_sequence_sha256=_digest(35),
        decoded_frame_sequence_sha256=_digest(36),
        target_encoding_sha256=CAUSAL_BALL_TARGET_ENCODING_SHA256,
        target_tensor_set_sha256=target_tensor_set_sha256_v1(rows),
        target_tensor_rows=rows,
        frame_count=2,
        output_width=16,
        output_height=16,
        primary_sampling_stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
        example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
    )


def _replace_camera_dimensions(
    manifest: TrainingExampleManifestV3,
    **changes: object,
) -> TrainingExampleManifestV3:
    capture_mode = changes.get("capture_mode", manifest.capture_mode)
    profile = changes.get("capture_profile_sha256", manifest.capture_profile_sha256)
    encoder = changes.get(
        "encoder_configuration_sha256",
        manifest.encoder_configuration_sha256,
    )
    representation = changes.get(
        "source_representation",
        manifest.source_representation,
    )
    classification = changes.get(
        "source_classification",
        manifest.source_classification,
    )
    changes["camera_risk_key_sha256"] = camera_risk_key_sha256_v2(
        capture_mode=capture_mode,  # type: ignore[arg-type]
        camera_setup_id=manifest.camera_setup_id,
        capture_profile_sha256=profile,  # type: ignore[arg-type]
        lighting_condition_id=manifest.lighting_condition_id,
        encoder_configuration_sha256=encoder,  # type: ignore[arg-type]
        source_representation=representation,  # type: ignore[arg-type]
        source_classification=classification,  # type: ignore[arg-type]
    )
    return replace(manifest, **changes)


class TrainingExampleCaptureBindingTests(unittest.TestCase):
    def assert_binding_error(
        self,
        expected_code: str,
        callback: object,
    ) -> TrainingExampleCaptureBindingError:
        with self.assertRaises(TrainingExampleCaptureBindingError) as caught:
            callback()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        self.assertIn(
            caught.exception.code,
            TRAINING_EXAMPLE_CAPTURE_BINDING_ERROR_CODES,
        )
        self.assertLess(len(str(caught.exception)), 200)
        return caught.exception

    def test_mevo_avkans_and_phone_archive_bind_exactly_without_authority(
        self,
    ) -> None:
        receipts = (
            _live_receipt("stream-1-mevo", mevo=True, offset=50),
            _live_receipt("stream-3-avkans", mevo=False, offset=60),
            _phone_archive_receipt("phone-archive-1"),
        )
        expected_modes = (
            TrainingCaptureModeV1.HD_1080P60,
            TrainingCaptureModeV1.HD_1080P30,
            TrainingCaptureModeV1.HD_1080P60,
        )
        for receipt, expected_mode in zip(receipts, expected_modes, strict=True):
            evidence = _evidence(receipt)
            manifest = _manifest(evidence)
            with self.subTest(source_id=evidence.source_id):
                binding = bind_training_example_capture_v1(
                    manifest=manifest,
                    capture_evidence=evidence,
                )
                self.assertIs(
                    type(binding),
                    TrainingExampleCaptureBindingEvidenceV1,
                )
                self.assertIs(evidence.training_capture_mode, expected_mode)
                self.assertEqual(
                    binding.training_example_manifest_sha256,
                    manifest.fingerprint(),
                )
                self.assertEqual(
                    binding.capture_profile_classification_sha256,
                    receipt.fingerprint(),
                )
                self.assertEqual(
                    binding.source_classification_proof_set_sha256,
                    receipt.source_classification_proof_set_sha256,
                )
                self.assertEqual(
                    binding.capture_classification_proof_set_sha256,
                    receipt.capture_classification_proof_set_sha256,
                )
                for field_name in (
                    "admissible_for_training",
                    "admissible_for_evaluation",
                    "admissible_for_test",
                    "admissible_for_deployment",
                    "admissible_for_live_scoring",
                ):
                    self.assertFalse(hasattr(binding, field_name))
                self.assertFalse(hasattr(binding, "to_dict"))
                self.assertFalse(hasattr(binding, "to_json_bytes"))
                self.assertFalse(hasattr(binding, "fingerprint"))
                binding.validate_against(
                    manifest=manifest,
                    capture_evidence=evidence,
                )

    def test_every_manifest_evidence_join_coordinate_fails_closed(self) -> None:
        receipt = _live_receipt("stream-1", mevo=True, offset=100)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        mismatches = {
            "source_id": replace(manifest, source_id="other-source"),
            "protected_configuration": replace(
                manifest,
                protected_training_configuration_generation_sha256=_digest(500),
            ),
            "pin_set": replace(
                manifest,
                capture_classification_current_pin_set_sha256=_digest(501),
            ),
            "classification_generation": replace(
                manifest,
                capture_classification_generation_id=_digest(502),
            ),
            "classification_fingerprint": replace(
                manifest,
                capture_profile_classification_sha256=_digest(503),
            ),
            "capture_profile_id": replace(
                manifest,
                capture_profile_id="different-profile",
            ),
            "capture_profile_fingerprint": _replace_camera_dimensions(
                manifest,
                capture_profile_sha256=_digest(504),
            ),
            "encoder_fingerprint": _replace_camera_dimensions(
                manifest,
                encoder_configuration_sha256=_digest(505),
            ),
            "capture_mode": _replace_camera_dimensions(
                manifest,
                capture_mode=TrainingCaptureModeV1.UHD_4K60,
            ),
            "compression_stratum": replace(
                manifest,
                compression_stratum=(
                    CompressionStratumV1.HIGH_BITRATE_INTERFRAME
                ),
            ),
            "source_representation": _replace_camera_dimensions(
                manifest,
                source_representation=SourceRepresentationV1.PLATFORM_TRANSCODE,
            ),
            "source_classification": _replace_camera_dimensions(
                manifest,
                source_classification=(
                    CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
                ),
            ),
            "capture_risk_tags": replace(
                manifest,
                capture_risk_tags=tuple(
                    tag
                    for tag in manifest.capture_risk_tags
                    if tag is not CaptureRiskTagV1.LOW_LIGHT
                ),
            ),
        }
        for field_name, mismatch in mismatches.items():
            with self.subTest(field_name=field_name):
                self.assert_binding_error(
                    "EXAMPLE_CAPTURE_BINDING_JOIN",
                    lambda mismatch=mismatch: bind_training_example_capture_v1(
                        manifest=mismatch,
                        capture_evidence=evidence,
                    ),
                )

    def test_evidence_coordinate_drift_and_proof_drift_reject(self) -> None:
        receipt = _live_receipt("stream-1", mevo=True, offset=120)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        drifted = replace(
            evidence,
            protected_training_configuration_generation_sha256=_digest(510),
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=drifted,
            ),
        )

        object.__setattr__(
            evidence,
            "source_classification_proof_set_sha256",
            _digest(511),
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

    def test_abstention_incomplete_provenance_and_field_mutation_reject(self) -> None:
        receipt = _live_receipt("stream-1", mevo=True, offset=140)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        object.__setattr__(
            evidence.classification,
            "status",
            CaptureClassificationStatusV1.ABSTAINED,
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

        receipt = _live_receipt("stream-2", mevo=True, offset=160)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        object.__setattr__(
            evidence.classification.source_capture_facts,
            "source_provenance_complete",
            False,
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

        receipt = _live_receipt("stream-3", mevo=True, offset=180)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        object.__setattr__(manifest, "camera_risk_key_sha256", _digest(512))
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_MANIFEST",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

    def test_wrong_deleted_subclass_alias_and_authority_inputs_reject(self) -> None:
        receipt = _live_receipt("stream-1", mevo=True, offset=200)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            lambda: bind_training_example_capture_v1(  # type: ignore[arg-type]
                manifest=object(),
                capture_evidence=evidence,
            ),
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            lambda: bind_training_example_capture_v1(  # type: ignore[arg-type]
                manifest=manifest,
                capture_evidence=object(),
            ),
        )

        class ManifestSubclass(TrainingExampleManifestV3):
            pass

        class EvidenceSubclass(VerifiedTrainingCaptureClassificationV1):
            pass

        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            lambda: bind_training_example_capture_v1(
                manifest=object.__new__(ManifestSubclass),
                capture_evidence=evidence,
            ),
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_INPUT",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=object.__new__(EvidenceSubclass),
            ),
        )

        evidence = _evidence(receipt)
        deleted_manifest = _manifest(evidence)
        object.__delattr__(deleted_manifest, "source_id")
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_MANIFEST",
            lambda: bind_training_example_capture_v1(
                manifest=deleted_manifest,
                capture_evidence=evidence,
            ),
        )
        manifest = _manifest(evidence)
        object.__delattr__(evidence, "classification")
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

        evidence = _evidence(receipt)
        aliased_manifest = _manifest(evidence)
        object.__setattr__(
            aliased_manifest,
            "protected_training_configuration_generation_sha256",
            aliased_manifest.capture_classification_current_pin_set_sha256,
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_MANIFEST",
            lambda: bind_training_example_capture_v1(
                manifest=aliased_manifest,
                capture_evidence=evidence,
            ),
        )

        evidence = _evidence(receipt)
        authority_manifest = _manifest(evidence)
        object.__setattr__(authority_manifest, "admissible_for_training", True)
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_AUTHORITY",
            lambda: bind_training_example_capture_v1(
                manifest=authority_manifest,
                capture_evidence=evidence,
            ),
        )
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        object.__setattr__(evidence, "admissible_for_test", True)
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_AUTHORITY",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

    def test_result_is_immutable_noncopyable_nonpickleable_and_in_memory_only(
        self,
    ) -> None:
        receipt = _phone_archive_receipt("phone-archive-1")
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        binding = bind_training_example_capture_v1(
            manifest=manifest,
            capture_evidence=evidence,
        )
        with self.assertRaises((AttributeError, TypeError)):
            binding.source_id = "other"  # type: ignore[misc]
        with self.assertRaises((AttributeError, TypeError)):
            object.__setattr__(binding, "admissible_for_training", True)
        with self.assertRaises(TypeError):
            copy.copy(binding)
        with self.assertRaises(TypeError):
            copy.deepcopy(binding)
        with self.assertRaises(TypeError):
            pickle.dumps(binding)
        self.assertNotIn("__dict__", dir(binding))
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertFalse(hasattr(binding, field_name))

        arbitrary = TrainingExampleCaptureBindingEvidenceV1(
            source_id="forged-source",
            training_example_manifest_sha256=_digest(500),
            protected_training_configuration_generation_sha256=_digest(501),
            capture_classification_current_pin_set_sha256=_digest(502),
            capture_classification_generation_id=_digest(503),
            capture_profile_classification_sha256=_digest(504),
            source_classification_proof_set_sha256=_digest(505),
            capture_classification_proof_set_sha256=_digest(506),
            capture_profile_sha256=_digest(507),
            encoder_configuration_sha256=_digest(508),
        )
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            lambda: arbitrary.validate_against(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )
        self.assertFalse(
            any("TOKEN" in name or "CAPABILITY" in name for name in dir(binding_module))
        )

        reused = TrainingExampleCaptureBindingEvidenceV1(
            source_id=binding.source_id,
            training_example_manifest_sha256=(
                binding.training_example_manifest_sha256
            ),
            protected_training_configuration_generation_sha256=(
                binding.protected_training_configuration_generation_sha256
            ),
            capture_classification_current_pin_set_sha256=(
                binding.capture_classification_current_pin_set_sha256
            ),
            capture_classification_generation_id=(
                binding.capture_classification_generation_id
            ),
            capture_profile_classification_sha256=(
                binding.capture_profile_classification_sha256
            ),
            source_classification_proof_set_sha256=(
                binding.source_classification_proof_set_sha256
            ),
            capture_classification_proof_set_sha256=(
                binding.capture_classification_proof_set_sha256
            ),
            capture_profile_sha256=binding.capture_profile_sha256,
            encoder_configuration_sha256=binding.encoder_configuration_sha256,
        )
        reused.validate_against(manifest=manifest, capture_evidence=evidence)
        other_receipt = _live_receipt("other-stream", mevo=False, offset=240)
        other_evidence = _evidence(other_receipt)
        other_manifest = _manifest(other_evidence)
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            lambda: reused.validate_against(
                manifest=other_manifest,
                capture_evidence=other_evidence,
            ),
        )

        object.__setattr__(manifest, "capture_profile_id", "mutated-profile")
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_JOIN",
            lambda: binding.validate_against(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )

    def test_noncanonical_cadence_receipt_cannot_be_smuggled_as_evidence(self) -> None:
        receipt = _live_receipt("stream-1", mevo=True, offset=220)
        evidence = _evidence(receipt)
        manifest = _manifest(evidence)
        encoder = replace(
            receipt.encoder_configuration,
            cadence_type=CadenceTypeV1.VFR,
            cadence_numerator=0,
            cadence_denominator=0,
        )
        profile = replace(
            receipt.capture_profile,
            encoder_configuration_sha256=encoder.fingerprint(),
        )
        source = replace(
            receipt.source_capture_facts,
            capture_profile_sha256=profile.fingerprint(),
        )
        abstained = classify_capture_profile_v1(encoder, profile, source)
        self.assertIs(
            abstained.status,
            CaptureClassificationStatusV1.ABSTAINED,
        )
        object.__setattr__(evidence, "classification", abstained)
        self.assert_binding_error(
            "EXAMPLE_CAPTURE_BINDING_EVIDENCE",
            lambda: bind_training_example_capture_v1(
                manifest=manifest,
                capture_evidence=evidence,
            ),
        )


if __name__ == "__main__":
    unittest.main()
