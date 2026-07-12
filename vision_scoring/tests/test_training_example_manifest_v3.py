from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import hashlib
import inspect
import json
import unittest

import vision_scoring.training_admission_contracts as contracts
from vision_scoring.annotation_trust import AnnotationMinimumTruthPolicy
from vision_scoring.capture_profile_contracts import (
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CompressionStratumV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
)
from vision_scoring.training_admission_contracts import (
    CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
    CAUSAL_BALL_TARGET_ENCODING_SHA256,
    CAMERA_RISK_KEY_DOMAIN,
    CAMERA_RISK_KEY_SCHEMA_VERSION,
    ExampleStratumTagV1,
    PrimarySamplingStratumV1,
    TRAINING_EXAMPLE_DOMAIN,
    TRAINING_EXAMPLE_SCHEMA_VERSION,
    TargetTensorContentRowV1,
    TargetTensorDTypeV1,
    TargetTensorFieldV1,
    TrainingAdmissionContractError,
    TrainingExampleManifestV3,
    TrainingSplitV1,
    camera_risk_key_sha256_v2,
    leakage_group_sha256_v1,
    target_tensor_set_sha256_v1,
)


def _digest(value: int) -> str:
    return f"{value:064x}"


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")


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
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET: candidate_shape,
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


def _example() -> TrainingExampleManifestV3:
    rows = _target_rows()
    root = _digest(1)
    profile = _digest(10)
    encoder = _digest(11)
    source_representation = SourceRepresentationV1.ORIGINAL_CAMERA_MASTER
    source_classification = CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE
    return TrainingExampleManifestV3(
        source_id="source-A",
        source_asset_sha256=root,
        root_asset_sha256=root,
        parent_asset_sha256=None,
        split=TrainingSplitV1.TRAIN,
        match_id="match-A",
        venue_id="venue-A",
        capture_profile_id="profile-A",
        capture_profile_sha256=profile,
        capture_mode=TrainingCaptureModeV1.UHD_4K60,
        camera_setup_id="camera-A",
        recording_date="2026-07-01",
        ball_design_id="ball-A",
        lighting_condition_id="daylight",
        synchronized_capture_group_id="sync-A",
        split_group_id="split-A",
        leakage_group_sha256=leakage_group_sha256_v1(
            match_id="match-A",
            root_asset_sha256=root,
            synchronized_capture_group_id="sync-A",
            split_group_id="split-A",
            venue_id="venue-A",
            camera_setup_id="camera-A",
            recording_date="2026-07-01",
        ),
        camera_risk_key_sha256=camera_risk_key_sha256_v2(
            capture_mode=TrainingCaptureModeV1.UHD_4K60,
            camera_setup_id="camera-A",
            capture_profile_sha256=profile,
            lighting_condition_id="daylight",
            encoder_configuration_sha256=encoder,
            source_representation=source_representation,
            source_classification=source_classification,
        ),
        capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
        compression_stratum=CompressionStratumV1.HIGH_BITRATE_INTERFRAME,
        encoder_configuration_sha256=encoder,
        protected_training_configuration_generation_sha256=_digest(40),
        capture_classification_current_pin_set_sha256=_digest(41),
        capture_classification_generation_id=_digest(42),
        capture_profile_classification_sha256=_digest(43),
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


class TrainingExampleManifestV3Tests(unittest.TestCase):
    def test_v3_round_trips_canonical_capture_classification_bindings(self) -> None:
        example = _example()
        raw = example.to_json_bytes()
        parsed = TrainingExampleManifestV3.from_json_bytes(raw)

        self.assertEqual(parsed, example)
        self.assertEqual(parsed.to_json_bytes(), raw)
        self.assertEqual(example.fingerprint(), hashlib.sha256(raw).hexdigest())
        wire = json.loads(raw)
        self.assertEqual(wire["domain"], TRAINING_EXAMPLE_DOMAIN)
        self.assertEqual(
            wire["domain"], "multicourt-vision-scoring:training-example:v3"
        )
        self.assertEqual(wire["schema_version"], TRAINING_EXAMPLE_SCHEMA_VERSION)
        self.assertEqual(wire["schema_version"], "3.0")
        self.assertEqual(
            wire["source_representation"],
            SourceRepresentationV1.ORIGINAL_CAMERA_MASTER.value,
        )
        self.assertEqual(
            wire["source_classification"],
            CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE.value,
        )
        for field_name in (
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
        ):
            self.assertIn(field_name, wire)
        for redundant_field in (
            "classification_status",
            "abstention_reason",
            "source_classification_proof_set_sha256",
            "capture_classification_proof_set_sha256",
            "codec_family",
            "provenance",
        ):
            self.assertNotIn(redundant_field, wire)

    def test_v2_manifest_and_symbol_are_hard_rejected_without_aliases(self) -> None:
        self.assertFalse(hasattr(contracts, "TrainingExampleManifestV2"))
        self.assertNotIn("TrainingExampleManifestV2", contracts.__all__)
        self.assertFalse(hasattr(contracts, "camera_risk_key_sha256_v1"))
        self.assertNotIn("camera_risk_key_sha256_v1", contracts.__all__)

        stale = _example().to_dict()
        stale["domain"] = "multicourt-vision-scoring:training-example:v2"
        stale["schema_version"] = "2.0"
        for field_name in (
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
            "source_representation",
            "source_classification",
        ):
            stale.pop(field_name)
        with self.assertRaises(TrainingAdmissionContractError):
            TrainingExampleManifestV3.from_json_bytes(_canonical(stale))
        for field_name, stale_value in (
            ("domain", "multicourt-vision-scoring:training-example:v2"),
            ("schema_version", "2.0"),
        ):
            complete_but_stale = _example().to_dict()
            complete_but_stale[field_name] = stale_value
            with (
                self.subTest(field_name=field_name),
                self.assertRaises(TrainingAdmissionContractError),
            ):
                TrainingExampleManifestV3.from_json_bytes(
                    _canonical(complete_but_stale)
                )

    def test_new_digest_roles_are_exact_distinct_and_not_lineage_aliases(self) -> None:
        example = _example()
        new_digest_fields = (
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
        )
        for field_name in new_digest_fields:
            with (
                self.subTest(field_name=field_name),
                self.assertRaisesRegex(ValueError, "digest roles must not alias"),
            ):
                replace(
                    example,
                    **{field_name: example.encoder_configuration_sha256},
                )
            with (
                self.subTest(field_name=field_name),
                self.assertRaisesRegex(ValueError, "proof and asset-lineage"),
            ):
                replace(example, **{field_name: example.root_asset_sha256})
            with self.subTest(field_name=field_name), self.assertRaises(ValueError):
                replace(example, **{field_name: "f" * 63})
        with self.assertRaisesRegex(ValueError, "digest roles must not alias"):
            replace(
                example,
                capture_profile_classification_sha256=(
                    example.capture_classification_generation_id
                ),
            )

    def test_source_enums_are_the_exact_shared_contract_types(self) -> None:
        self.assertIs(contracts.SourceRepresentationV1, SourceRepresentationV1)
        self.assertIs(
            contracts.CaptureSourceClassificationV1,
            CaptureSourceClassificationV1,
        )
        example = _example()
        for field_name, invalid in (
            (
                "source_representation",
                SourceRepresentationV1.ORIGINAL_CAMERA_MASTER.value,
            ),
            (
                "source_classification",
                CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE.value,
            ),
        ):
            with (
                self.subTest(field_name=field_name),
                self.assertRaisesRegex(ValueError, "wrong exact enum type"),
            ):
                replace(example, **{field_name: invalid})

            wire = example.to_dict()
            wire[field_name] = "NOT_A_CANONICAL_VALUE"
            with self.assertRaises(TrainingAdmissionContractError):
                TrainingExampleManifestV3.from_json_bytes(_canonical(wire))

    def test_risk_key_v2_groups_by_source_dimensions_not_receipt_identity(self) -> None:
        example = _example()
        expected_parameters = {
            "capture_mode",
            "camera_setup_id",
            "capture_profile_sha256",
            "lighting_condition_id",
            "encoder_configuration_sha256",
            "source_representation",
            "source_classification",
        }
        self.assertEqual(
            set(inspect.signature(camera_risk_key_sha256_v2).parameters),
            expected_parameters,
        )
        changed_receipt_identity = replace(
            example,
            protected_training_configuration_generation_sha256=_digest(140),
            capture_classification_current_pin_set_sha256=_digest(141),
            capture_classification_generation_id=_digest(142),
            capture_profile_classification_sha256=_digest(143),
        )
        self.assertEqual(
            changed_receipt_identity.camera_risk_key_sha256,
            example.camera_risk_key_sha256,
        )

        changed_representation = SourceRepresentationV1.PLATFORM_TRANSCODE
        changed_classification = CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
        changed_key = camera_risk_key_sha256_v2(
            capture_mode=example.capture_mode,
            camera_setup_id=example.camera_setup_id,
            capture_profile_sha256=example.capture_profile_sha256,
            lighting_condition_id=example.lighting_condition_id,
            encoder_configuration_sha256=example.encoder_configuration_sha256,
            source_representation=changed_representation,
            source_classification=changed_classification,
        )
        self.assertNotEqual(changed_key, example.camera_risk_key_sha256)
        changed_source_dimensions = replace(
            example,
            source_representation=changed_representation,
            source_classification=changed_classification,
            camera_risk_key_sha256=changed_key,
        )
        self.assertEqual(changed_source_dimensions.camera_risk_key_sha256, changed_key)
        with self.assertRaisesRegex(ValueError, "does not bind its exact inputs"):
            replace(example, source_representation=changed_representation)
        for field_name, invalid in (
            ("source_representation", example.source_representation.value),
            ("source_classification", example.source_classification.value),
        ):
            arguments = {
                "capture_mode": example.capture_mode,
                "camera_setup_id": example.camera_setup_id,
                "capture_profile_sha256": example.capture_profile_sha256,
                "lighting_condition_id": example.lighting_condition_id,
                "encoder_configuration_sha256": example.encoder_configuration_sha256,
                "source_representation": example.source_representation,
                "source_classification": example.source_classification,
            }
            arguments[field_name] = invalid
            with self.subTest(field_name=field_name), self.assertRaises(ValueError):
                camera_risk_key_sha256_v2(**arguments)  # type: ignore[arg-type]

        expected_preimage = {
            "camera_setup_id": example.camera_setup_id,
            "capture_mode": example.capture_mode.value,
            "capture_profile_sha256": example.capture_profile_sha256,
            "domain": CAMERA_RISK_KEY_DOMAIN,
            "encoder_configuration_sha256": example.encoder_configuration_sha256,
            "lighting_condition_id": example.lighting_condition_id,
            "schema_version": CAMERA_RISK_KEY_SCHEMA_VERSION,
            "source_classification": example.source_classification.value,
            "source_representation": example.source_representation.value,
        }
        self.assertEqual(
            example.camera_risk_key_sha256,
            hashlib.sha256(_canonical(expected_preimage)).hexdigest(),
        )

    def test_receipt_is_strictly_non_authorizing_and_immutable(self) -> None:
        example = _example()
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(example, field_name), False)
            with self.subTest(field_name=field_name), self.assertRaises(ValueError):
                replace(example, **{field_name: True})
        with self.assertRaises((FrozenInstanceError, AttributeError)):
            example.source_id = "mutated"  # type: ignore[misc]
        with self.assertRaises((FrozenInstanceError, AttributeError)):
            del example.capture_profile_classification_sha256


if __name__ == "__main__":
    unittest.main()
