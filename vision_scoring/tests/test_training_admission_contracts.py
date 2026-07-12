from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import FrozenInstanceError, replace
import hashlib
import inspect
import json
import unittest
from unittest.mock import patch

import vision_scoring.training_admission_compiler as training_admission_compiler
import vision_scoring.training_admission_contracts as training_admission_contracts
from vision_scoring.annotation_trust import AnnotationMinimumTruthPolicy
from vision_scoring.capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from vision_scoring.capture_profile_contracts import (
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CompressionStratumV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
)
from vision_scoring.contract_wire import CanonicalWireError
from vision_scoring.dataset_split import DatasetSplit
from vision_scoring.training_admission_compiler import (
    TrainingAdmissionCompilerError,
    compile_training_coverage_v1,
    compile_training_sampling_schedule_v1,
)
from vision_scoring.training_admission_contracts import (
    CAUSAL_BALL_LOSS_CONFIG_SHA256,
    CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
    CAUSAL_BALL_MODEL_CONFIG_SHA256,
    CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256,
    CAUSAL_BALL_TARGET_ENCODING_SHA256,
    CAUSAL_BALL_LOSS_CONFIG_DOMAIN,
    CAUSAL_BALL_HEATMAP_STRIDE,
    CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME,
    CAUSAL_BALL_MAX_FRAMES,
    CAUSAL_BALL_MAX_HEIGHT,
    CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS,
    CAUSAL_BALL_MAX_WIDTH,
    CAUSAL_BALL_MODEL_CONFIG_DOMAIN,
    CAUSAL_BALL_OPTIMIZER_CONFIG_DOMAIN,
    CoverageRequirementV1,
    DevScheduleEntryV1,
    ExampleStratumTagV1,
    MAX_SCHEDULE_ROWS,
    PPM,
    PrimarySamplingStratumV1,
    StratumQuotaV1,
    StratifiedSamplingPlanV1,
    TargetTensorContentRowV1,
    TargetTensorDTypeV1,
    TargetTensorFieldV1,
    TrainingAdmissionContractError,
    TrainingAdmissionPolicyV1,
    TrainingCoverageReportV1,
    TrainingDatasetManifestV1,
    TRAINING_EXAMPLE_DOMAIN,
    TRAINING_EXAMPLE_SCHEMA_VERSION,
    TrainingExampleManifestV3,
    TrainingExampleReferenceV1,
    TrainingOutputRoleV1,
    TrainingRunManifestV1,
    TrainingRunRequestV1,
    TrainingSamplingScheduleV1,
    TrainingScheduleDrawV1,
    TrainingSplitV1,
    camera_risk_key_sha256_v2,
    causal_ball_loss_config_descriptor_v1,
    causal_ball_model_config_descriptor_v1,
    causal_ball_optimizer_config_descriptor_v1,
    derive_primary_sampling_stratum_v1,
    leakage_group_sha256_v1,
    target_tensor_set_sha256_v1,
    test_exclusion_commitment_sha256_v1,
    training_example_reference_set_sha256_v1,
    training_schedule_ranking_sha256_v1,
)

try:
    import torch

    from vision_scoring.ball_model import (
        MAX_CANDIDATES_PER_FRAME,
        CausalBallLossConfig,
        CausalBallModelConfig,
    )
    from vision_scoring.ball_target_materialization import TARGET_ENCODING_SHA256
    from vision_scoring.clip_input_contract import (
        CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256 as ACTUAL_CLIP_INPUT_ENCODING_SHA256,
        MAX_CLIP_INPUT_FRAMES,
        MAX_CLIP_INPUT_HEIGHT,
        MAX_CLIP_INPUT_PIXELS,
        MAX_CLIP_INPUT_WIDTH,
    )
except ModuleNotFoundError:
    torch = None  # type: ignore[assignment]
    MAX_CANDIDATES_PER_FRAME = None  # type: ignore[assignment]
    CausalBallLossConfig = None  # type: ignore[assignment,misc]
    CausalBallModelConfig = None  # type: ignore[assignment,misc]
    TARGET_ENCODING_SHA256 = None  # type: ignore[assignment]
    ACTUAL_CLIP_INPUT_ENCODING_SHA256 = None  # type: ignore[assignment]
    MAX_CLIP_INPUT_FRAMES = None  # type: ignore[assignment]
    MAX_CLIP_INPUT_HEIGHT = None  # type: ignore[assignment]
    MAX_CLIP_INPUT_PIXELS = None  # type: ignore[assignment]
    MAX_CLIP_INPUT_WIDTH = None  # type: ignore[assignment]


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


def _target_rows(
    *, frame_count: int = 2, width: int = 16, height: int = 16
) -> tuple[TargetTensorContentRowV1, ...]:
    candidate = (1, frame_count, 16)
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
        TargetTensorFieldV1.CANDIDATE_XY_HEATMAP: (*candidate, 2),
        TargetTensorFieldV1.CANDIDATE_VISIBILITY_INDEX: candidate,
        TargetTensorFieldV1.CANDIDATE_MASK: candidate,
        TargetTensorFieldV1.CANDIDATE_ROLE_INDEX: candidate,
        TargetTensorFieldV1.CANDIDATE_ROLE_MASK: candidate,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_TARGET: (*candidate, 2),
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_HEATMAP_PX_TARGET: candidate,
        TargetTensorFieldV1.CANDIDATE_BLUR_AXIS_MASK: candidate,
        TargetTensorFieldV1.CANDIDATE_BLUR_EXTENT_MASK: candidate,
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


def _policy() -> TrainingAdmissionPolicyV1:
    return TrainingAdmissionPolicyV1(
        policy_id="causal-ball-admission-v1",
        valid_from="2026-01-01",
        valid_until="2027-01-01",
        minimum_train_sources=1,
        minimum_dev_sources=1,
        minimum_train_frames=2,
        minimum_dev_frames=2,
        minimum_distinct_matches=2,
        minimum_distinct_venues=1,
        minimum_distinct_camera_setups=1,
        required_capture_modes=(TrainingCaptureModeV1.UHD_4K60,),
        required_capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
        required_example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
        maximum_match_frames_ppm=750_000,
        maximum_root_asset_frames_ppm=500_000,
        maximum_leakage_group_frames_ppm=500_000,
        maximum_match_draws_ppm=750_000,
        maximum_root_asset_draws_ppm=500_000,
        maximum_leakage_group_draws_ppm=500_000,
        maximum_examples=512,
        maximum_total_frames=16_384,
        maximum_schedule_rows=4096,
    )


def _example() -> TrainingExampleManifestV3:
    rows = _target_rows()
    root = _digest(1)
    profile = _digest(10)
    encoder = _digest(11)
    source_representation = SourceRepresentationV1.ORIGINAL_CAMERA_MASTER
    source_classification = CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE
    risk_key = camera_risk_key_sha256_v2(
        capture_mode=TrainingCaptureModeV1.UHD_4K60,
        camera_setup_id="camera-A",
        capture_profile_sha256=profile,
        lighting_condition_id="daylight",
        encoder_configuration_sha256=encoder,
        source_representation=source_representation,
        source_classification=source_classification,
    )
    leakage = leakage_group_sha256_v1(
        match_id="match-A",
        root_asset_sha256=root,
        synchronized_capture_group_id="sync-A",
        split_group_id="split-A",
        venue_id="venue-A",
        camera_setup_id="camera-A",
        recording_date="2026-07-01",
    )
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
        leakage_group_sha256=leakage,
        camera_risk_key_sha256=risk_key,
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
        requested_truth_policy=(
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED
        ),
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


def _references() -> tuple[TrainingExampleReferenceV1, ...]:
    return (
        TrainingExampleReferenceV1(
            source_id="source-train",
            split=TrainingSplitV1.TRAIN,
            example_manifest_sha256=_digest(1000),
            leakage_group_sha256=_digest(1002),
            frame_count=2,
            primary_sampling_stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
            example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
        ),
        TrainingExampleReferenceV1(
            source_id="source-dev",
            split=TrainingSplitV1.DEV,
            example_manifest_sha256=_digest(1001),
            leakage_group_sha256=_digest(1003),
            frame_count=2,
            primary_sampling_stratum=PrimarySamplingStratumV1.OTHER_SUPERVISED,
            example_stratum_tags=(ExampleStratumTagV1.MOTION_BLUR,),
        ),
    )


def _dataset() -> TrainingDatasetManifestV1:
    references = _references()
    return TrainingDatasetManifestV1(
        dataset_id="beach-volleyball-v1",
        readiness_manifest_sha256=_digest(1100),
        readiness_report_sha256=_digest(1101),
        protected_configuration_generation_sha256=_digest(1103),
        admission_policy_sha256=_digest(1104),
        artifact_generation_id=_digest(1105),
        rights_evidence_generation_id=_digest(1106),
        source_rights_proof_set_sha256=_digest(1107),
        source_label_pack_proof_set_sha256=_digest(1108),
        split_manifest_sha256=_digest(1109),
        test_exclusion_commitment_sha256=test_exclusion_commitment_sha256_v1(
            "beach-volleyball-v1", ("secret-test-source",)
        ),
        test_source_count=1,
        test_label_pack_count=1,
        coverage_report_sha256=_digest(1110),
        example_reference_set_sha256=training_example_reference_set_sha256_v1(
            references
        ),
        example_references=references,
        train_example_count=1,
        dev_example_count=1,
        train_frame_count=2,
        dev_frame_count=2,
    )


def _request() -> TrainingRunRequestV1:
    return TrainingRunRequestV1(
        run_id="causal-ball-run-1",
        requested_at_utc="2026-07-12T12:00:00Z",
        not_after_utc="2026-07-12T18:00:00Z",
        model_config_sha256=CAUSAL_BALL_MODEL_CONFIG_SHA256,
        loss_config_sha256=CAUSAL_BALL_LOSS_CONFIG_SHA256,
        optimizer_config_sha256=CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256,
        trainer_source_tree_sha256=_digest(1200),
        environment_lock_sha256=_digest(1201),
        seed=17,
        maximum_epochs=2,
        maximum_steps=8,
        base_weights_sha256=None,
        base_weights_license_proof_sha256=None,
    )


def _compiler_variant(
    base: TrainingExampleManifestV3,
    *,
    suffix: int,
    split: TrainingSplitV1,
    frame_count: int = 2,
) -> TrainingExampleManifestV3:
    root_asset_sha256 = _digest(4_000 + suffix)
    camera_setup_id = f"camera-{suffix}"
    match_id = f"match-{suffix}"
    venue_id = f"venue-{suffix}"
    synchronized_capture_group_id = f"sync-{suffix}"
    split_group_id = f"split-{suffix}"
    rows = _target_rows(frame_count=frame_count)
    leakage_group_sha256 = leakage_group_sha256_v1(
        match_id=match_id,
        root_asset_sha256=root_asset_sha256,
        synchronized_capture_group_id=synchronized_capture_group_id,
        split_group_id=split_group_id,
        venue_id=venue_id,
        camera_setup_id=camera_setup_id,
        recording_date=base.recording_date,
    )
    camera_risk_key_sha256 = camera_risk_key_sha256_v2(
        capture_mode=base.capture_mode,
        camera_setup_id=camera_setup_id,
        capture_profile_sha256=base.capture_profile_sha256,
        lighting_condition_id=base.lighting_condition_id,
        encoder_configuration_sha256=base.encoder_configuration_sha256,
        source_representation=base.source_representation,
        source_classification=base.source_classification,
    )
    return replace(
        base,
        source_id=f"source-{suffix}",
        source_asset_sha256=root_asset_sha256,
        root_asset_sha256=root_asset_sha256,
        split=split,
        match_id=match_id,
        venue_id=venue_id,
        camera_setup_id=camera_setup_id,
        synchronized_capture_group_id=synchronized_capture_group_id,
        split_group_id=split_group_id,
        leakage_group_sha256=leakage_group_sha256,
        camera_risk_key_sha256=camera_risk_key_sha256,
        target_tensor_rows=rows,
        target_tensor_set_sha256=target_tensor_set_sha256_v1(rows),
        frame_count=frame_count,
    )


def _compiler_examples() -> tuple[TrainingExampleManifestV3, ...]:
    train = _example()
    dev = _compiler_variant(
        train,
        suffix=2,
        split=TrainingSplitV1.DEV,
    )
    return train, dev


_SCHEDULE_STRATUM_TAGS = {
    PrimarySamplingStratumV1.LOCALIZABLE_BALL: (
        ExampleStratumTagV1.VISIBLE_BALL,
    ),
    PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME: (
        ExampleStratumTagV1.BALL_OUT_OF_FRAME,
    ),
    PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE: (
        ExampleStratumTagV1.HARD_NEGATIVE,
        ExampleStratumTagV1.NO_BALL,
    ),
    PrimarySamplingStratumV1.OTHER_SUPERVISED: (
        ExampleStratumTagV1.MOTION_BLUR,
    ),
}


def _schedule_compiler_examples(
    *,
    train_counts: tuple[int, int, int, int] = (2, 2, 2, 2),
    dev_count: int = 2,
) -> tuple[TrainingExampleManifestV3, ...]:
    base = _example()
    examples: list[TrainingExampleManifestV3] = []
    suffix = 100
    for stratum, count in zip(PrimarySamplingStratumV1, train_counts, strict=True):
        for _ in range(count):
            tags = _SCHEDULE_STRATUM_TAGS[stratum]
            examples.append(
                replace(
                    _compiler_variant(
                        base,
                        suffix=suffix,
                        split=TrainingSplitV1.TRAIN,
                    ),
                    primary_sampling_stratum=stratum,
                    example_stratum_tags=tags,
                )
            )
            suffix += 1
    for _ in range(dev_count):
        examples.append(
            _compiler_variant(
                base,
                suffix=suffix,
                split=TrainingSplitV1.DEV,
            )
        )
        suffix += 1
    return tuple(examples)


def _schedule_references(
    examples: tuple[TrainingExampleManifestV3, ...],
) -> tuple[TrainingExampleReferenceV1, ...]:
    split_order = {TrainingSplitV1.TRAIN: 0, TrainingSplitV1.DEV: 1}
    return tuple(
        sorted(
            (
                TrainingExampleReferenceV1(
                    source_id=example.source_id,
                    split=example.split,
                    example_manifest_sha256=example.fingerprint(),
                    leakage_group_sha256=example.leakage_group_sha256,
                    frame_count=example.frame_count,
                    primary_sampling_stratum=example.primary_sampling_stratum,
                    example_stratum_tags=example.example_stratum_tags,
                )
                for example in examples
            ),
            key=lambda value: (
                split_order[value.split],
                value.source_id,
                value.example_manifest_sha256,
            ),
        )
    )


def _schedule_dataset(
    *,
    examples: tuple[TrainingExampleManifestV3, ...],
    policy: TrainingAdmissionPolicyV1,
) -> TrainingDatasetManifestV1:
    references = _schedule_references(examples)
    train_references = tuple(
        item for item in references if item.split is TrainingSplitV1.TRAIN
    )
    dev_references = tuple(
        item for item in references if item.split is TrainingSplitV1.DEV
    )
    return TrainingDatasetManifestV1(
        dataset_id="schedule-dataset-v1",
        readiness_manifest_sha256=_digest(7_000),
        readiness_report_sha256=_digest(7_001),
        protected_configuration_generation_sha256=_digest(7_002),
        admission_policy_sha256=policy.fingerprint(),
        artifact_generation_id=_digest(7_003),
        rights_evidence_generation_id=_digest(7_004),
        source_rights_proof_set_sha256=_digest(7_005),
        source_label_pack_proof_set_sha256=_digest(7_006),
        split_manifest_sha256=_digest(7_007),
        test_exclusion_commitment_sha256=test_exclusion_commitment_sha256_v1(
            "schedule-dataset-v1", ("private-test-source",)
        ),
        test_source_count=1,
        test_label_pack_count=1,
        coverage_report_sha256=_digest(7_008),
        example_reference_set_sha256=training_example_reference_set_sha256_v1(
            references
        ),
        example_references=references,
        train_example_count=len(train_references),
        dev_example_count=len(dev_references),
        train_frame_count=sum(item.frame_count for item in train_references),
        dev_frame_count=sum(item.frame_count for item in dev_references),
    )


def _schedule_plan(
    *,
    dataset: TrainingDatasetManifestV1,
    seed: int = 17,
    epoch_count: int = 2,
    train_draws_per_epoch: int = 8,
    weights: tuple[int, int, int, int] = (400_000, 200_000, 200_000, 200_000),
    minima: tuple[int, int, int, int] = (1, 1, 1, 1),
    maximum_leakage_group_draws_ppm: int = 500_000,
) -> StratifiedSamplingPlanV1:
    return StratifiedSamplingPlanV1(
        dataset_manifest_sha256=dataset.fingerprint(),
        seed=seed,
        epoch_count=epoch_count,
        train_draws_per_epoch=train_draws_per_epoch,
        maximum_leakage_group_draws_ppm=maximum_leakage_group_draws_ppm,
        stratum_quotas=tuple(
            StratumQuotaV1(
                stratum=stratum,
                weight_ppm=weights[index],
                minimum_draws_per_epoch=minima[index],
            )
            for index, stratum in enumerate(PrimarySamplingStratumV1)
        ),
    )


def _quotas() -> tuple[StratumQuotaV1, ...]:
    weights = (400_000, 200_000, 200_000, 200_000)
    return tuple(
        StratumQuotaV1(
            stratum=stratum,
            weight_ppm=weights[index],
            minimum_draws_per_epoch=1,
        )
        for index, stratum in enumerate(PrimarySamplingStratumV1)
    )


def _plan(*, dataset_sha256: str = _digest(1300)) -> StratifiedSamplingPlanV1:
    return StratifiedSamplingPlanV1(
        dataset_manifest_sha256=dataset_sha256,
        seed=17,
        epoch_count=1,
        train_draws_per_epoch=4,
        maximum_leakage_group_draws_ppm=500_000,
        stratum_quotas=_quotas(),
    )


def _schedule() -> TrainingSamplingScheduleV1:
    dataset_sha = _digest(1400)
    plan_sha = _digest(1401)
    seed = 17
    draw_inputs = (
        (PrimarySamplingStratumV1.LOCALIZABLE_BALL, _digest(1402), _digest(1404)),
        (
            PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME,
            _digest(1403),
            _digest(1405),
        ),
    )
    draws = tuple(
        TrainingScheduleDrawV1(
            epoch_index=0,
            draw_index=index,
            stratum=stratum,
            leakage_group_sha256=leakage,
            example_manifest_sha256=example,
            ranking_sha256=training_schedule_ranking_sha256_v1(
                dataset_manifest_sha256=dataset_sha,
                sampling_plan_sha256=plan_sha,
                seed=seed,
                epoch_index=0,
                draw_index=index,
                stratum=stratum,
                leakage_group_sha256=leakage,
                example_manifest_sha256=example,
            ),
        )
        for index, (stratum, leakage, example) in enumerate(draw_inputs)
    )
    return TrainingSamplingScheduleV1(
        dataset_manifest_sha256=dataset_sha,
        sampling_plan_sha256=plan_sha,
        seed=seed,
        epoch_count=1,
        train_draws_per_epoch=2,
        train_draws=draws,
        dev_entries=(DevScheduleEntryV1(0, "source-dev", _digest(1406)),),
    )


def _run_manifest() -> TrainingRunManifestV1:
    request = _request()
    return TrainingRunManifestV1(
        run_id=request.run_id,
        run_request_sha256=request.fingerprint(),
        dataset_manifest_generation_id=_digest(1500),
        dataset_manifest_sha256=_digest(1501),
        sampling_plan_sha256=_digest(1502),
        sampling_schedule_sha256=_digest(1503),
        model_config_sha256=request.model_config_sha256,
        loss_config_sha256=request.loss_config_sha256,
        optimizer_config_sha256=request.optimizer_config_sha256,
        trainer_source_tree_sha256=request.trainer_source_tree_sha256,
        environment_lock_sha256=request.environment_lock_sha256,
        seed=request.seed,
        maximum_epochs=request.maximum_epochs,
        maximum_steps=request.maximum_steps,
        not_after_utc=request.not_after_utc,
        base_weights_sha256=None,
        base_weights_license_proof_sha256=None,
        output_role=TrainingOutputRoleV1.QUARANTINED_TRAINING_CHECKPOINTS,
    )


class TrainingAdmissionContractTests(unittest.TestCase):
    def assert_all_authority_false(self, value: object) -> None:
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(value, field_name), False)

    def assert_contract_error(self, code: str, operation: object) -> None:
        self.assertTrue(callable(operation))
        with self.assertRaises(TrainingAdmissionContractError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)

    def test_fixed_configuration_descriptors_have_pinned_domains_and_hashes(self) -> None:
        values = (
            (
                causal_ball_model_config_descriptor_v1,
                CAUSAL_BALL_MODEL_CONFIG_DOMAIN,
                CAUSAL_BALL_MODEL_CONFIG_SHA256,
                "d6d590c22efeb15ae3eb8abc3cf679b7b95167fe338c4693f7b8ee5e6aad0b25",
            ),
            (
                causal_ball_loss_config_descriptor_v1,
                CAUSAL_BALL_LOSS_CONFIG_DOMAIN,
                CAUSAL_BALL_LOSS_CONFIG_SHA256,
                "0a68f75e80b1297588819f7eee8ffcce8b57fcfddf8f2cbc0368c73fa5627a7e",
            ),
            (
                causal_ball_optimizer_config_descriptor_v1,
                CAUSAL_BALL_OPTIMIZER_CONFIG_DOMAIN,
                CAUSAL_BALL_OPTIMIZER_CONFIG_SHA256,
                "ae8ba3aa857e057b49b201b030831e8b0840cc49596956ecba3db8989b1befe6",
            ),
        )
        for factory, domain, actual, expected in values:
            descriptor = factory()
            self.assertEqual(descriptor["domain"], domain)
            self.assertEqual(hashlib.sha256(_canonical(descriptor)).hexdigest(), actual)
            self.assertEqual(actual, expected)
            descriptor["domain"] = "mutated"
            self.assertEqual(factory()["domain"], domain)

    @unittest.skipIf(torch is None, "optional training dependency is not installed")
    def test_fixed_optimizer_descriptor_covers_the_complete_adam_signature(self) -> None:
        assert torch is not None
        signature = inspect.signature(torch.optim.Adam)
        self.assertEqual(
            set(signature.parameters) - {"params"},
            {
                "lr",
                "betas",
                "eps",
                "weight_decay",
                "amsgrad",
                "foreach",
                "maximize",
                "capturable",
                "differentiable",
                "fused",
                "decoupled_weight_decay",
            },
        )
        descriptor = causal_ball_optimizer_config_descriptor_v1()
        self.assertIs(descriptor["maximize"], False)
        self.assertIs(descriptor["decoupled_weight_decay"], False)
        parameter = torch.nn.Parameter(torch.zeros(()))
        optimizer = torch.optim.Adam(
            [parameter],
            lr=float(descriptor["learning_rate_decimal"]),
            betas=(
                float(descriptor["beta1_decimal"]),
                float(descriptor["beta2_decimal"]),
            ),
            eps=float(descriptor["epsilon_decimal"]),
            weight_decay=float(descriptor["weight_decay_decimal"]),
            amsgrad=descriptor["amsgrad"],
            foreach=descriptor["foreach"],
            maximize=descriptor["maximize"],
            capturable=descriptor["capturable"],
            differentiable=descriptor["differentiable"],
            fused=descriptor["fused"],
            decoupled_weight_decay=descriptor["decoupled_weight_decay"],
        )
        self.assertIs(optimizer.defaults["maximize"], False)
        self.assertIs(optimizer.defaults["decoupled_weight_decay"], False)

    @unittest.skipIf(
        CausalBallModelConfig is None,
        "optional training dependency is not installed",
    )
    def test_fixed_model_descriptor_matches_actual_model_defaults(self) -> None:
        assert CausalBallModelConfig is not None
        actual = CausalBallModelConfig()
        descriptor = causal_ball_model_config_descriptor_v1()
        self.assertEqual(descriptor["spatial_channels"], actual.spatial_channels)
        self.assertEqual(descriptor["temporal_channels"], actual.temporal_channels)
        self.assertEqual(descriptor["residual_blocks"], actual.residual_blocks)
        self.assertEqual(descriptor["heatmap_stride"], actual.heatmap_stride)
        self.assertEqual(descriptor["max_batch_size"], actual.max_batch_size)
        self.assertEqual(descriptor["max_frames"], actual.max_frames)
        self.assertEqual(descriptor["max_height"], actual.max_height)
        self.assertEqual(descriptor["max_width"], actual.max_width)
        self.assertEqual(
            descriptor["max_total_input_pixels"], actual.max_total_input_pixels
        )
        self.assertEqual(
            descriptor["min_log_variance_decimal"], format(actual.min_log_variance, "g")
        )
        self.assertEqual(
            descriptor["max_log_variance_decimal"], format(actual.max_log_variance, "g")
        )
        self.assertEqual(
            descriptor["max_blur_extent_heatmap_px_decimal"],
            format(actual.max_blur_extent_heatmap_px, "g"),
        )

    @unittest.skipIf(
        CausalBallLossConfig is None,
        "optional training dependency is not installed",
    )
    def test_fixed_loss_descriptor_matches_actual_loss_defaults(self) -> None:
        assert CausalBallLossConfig is not None
        actual = CausalBallLossConfig()
        descriptor = causal_ball_loss_config_descriptor_v1()
        mapping = {
            "heatmap_weight_decimal": actual.heatmap_weight,
            "visibility_weight_decimal": actual.visibility_weight,
            "role_weight_decimal": actual.role_weight,
            "blur_axis_weight_decimal": actual.blur_axis_weight,
            "blur_extent_weight_decimal": actual.blur_extent_weight,
            "uncertainty_weight_decimal": actual.uncertainty_weight,
            "heatmap_focal_alpha_decimal": actual.heatmap_focal_alpha,
            "heatmap_focal_gamma_decimal": actual.heatmap_focal_gamma,
        }
        for field_name, value in mapping.items():
            self.assertEqual(descriptor[field_name], format(value, "g"))

    @unittest.skipIf(
        TARGET_ENCODING_SHA256 is None,
        "optional training dependency is not installed",
    )
    def test_fixed_input_and_target_encoding_pins_match_implementations(self) -> None:
        self.assertEqual(
            CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
            ACTUAL_CLIP_INPUT_ENCODING_SHA256,
        )
        self.assertEqual(CAUSAL_BALL_TARGET_ENCODING_SHA256, TARGET_ENCODING_SHA256)

    @unittest.skipIf(
        CausalBallModelConfig is None,
        "optional training dependency is not installed",
    )
    def test_fixed_geometry_bounds_match_loader_model_and_target_implementations(self) -> None:
        assert CausalBallModelConfig is not None
        actual = CausalBallModelConfig()
        self.assertEqual(CAUSAL_BALL_HEATMAP_STRIDE, actual.heatmap_stride)
        self.assertEqual(CAUSAL_BALL_MAX_FRAMES, actual.max_frames)
        self.assertEqual(CAUSAL_BALL_MAX_HEIGHT, actual.max_height)
        self.assertEqual(CAUSAL_BALL_MAX_WIDTH, actual.max_width)
        self.assertEqual(
            CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS,
            actual.max_total_input_pixels,
        )
        self.assertEqual(CAUSAL_BALL_MAX_FRAMES, MAX_CLIP_INPUT_FRAMES)
        self.assertEqual(CAUSAL_BALL_MAX_HEIGHT, MAX_CLIP_INPUT_HEIGHT)
        self.assertEqual(CAUSAL_BALL_MAX_WIDTH, MAX_CLIP_INPUT_WIDTH)
        self.assertEqual(CAUSAL_BALL_MAX_TOTAL_INPUT_PIXELS, MAX_CLIP_INPUT_PIXELS)
        self.assertEqual(
            CAUSAL_BALL_MAX_CANDIDATES_PER_FRAME,
            MAX_CANDIDATES_PER_FRAME,
        )

    def test_training_split_is_closed_and_cannot_represent_test(self) -> None:
        self.assertEqual(tuple(item.value for item in TrainingSplitV1), ("TRAIN", "DEV"))
        with self.assertRaises(ValueError):
            TrainingSplitV1("TEST")
        with self.assertRaises(ValueError):
            replace(_example(), split=DatasetSplit.TEST)  # type: ignore[arg-type]

    def test_capture_enums_are_shared_and_dual_mode_is_unrepresentable(self) -> None:
        self.assertIs(
            training_admission_contracts.TrainingCaptureModeV1,
            TrainingCaptureModeV1,
        )
        self.assertIs(
            training_admission_contracts.CompressionStratumV1,
            CompressionStratumV1,
        )
        self.assertIs(
            training_admission_contracts.CaptureRiskTagV1,
            CaptureRiskTagV1,
        )
        self.assertNotIn(
            "DUAL_4K60",
            {item.value for item in TrainingCaptureModeV1},
        )
        with self.assertRaises(ValueError):
            TrainingCaptureModeV1("DUAL_4K60")

    def test_test_exclusion_commitment_is_deterministic_and_omits_ids(self) -> None:
        first = test_exclusion_commitment_sha256_v1(
            "dataset-A", ("private-source-A", "private-source-B")
        )
        second = test_exclusion_commitment_sha256_v1(
            "dataset-A", ("private-source-A", "private-source-B")
        )
        self.assertEqual(first, second)
        self.assertNotEqual(
            first,
            test_exclusion_commitment_sha256_v1(
                "dataset-B", ("private-source-A", "private-source-B")
            ),
        )
        with self.assertRaises(ValueError):
            test_exclusion_commitment_sha256_v1(
                "dataset-A", ("private-source-B", "private-source-A")
            )
        raw = _dataset().to_json_bytes()
        self.assertNotIn(b"secret-test-source", raw)

    def test_test_exclusion_commitment_supports_every_bounded_maximum_id(self) -> None:
        source_ids = tuple(
            f"s{index:03d}-" + "a" * 123 for index in range(512)
        )
        self.assertTrue(all(len(source_id) == 128 for source_id in source_ids))
        self.assertEqual(
            len(
                test_exclusion_commitment_sha256_v1(
                    "dataset-A",
                    source_ids,
                )
            ),
            64,
        )

    def test_policy_round_trips_with_integer_ppm_and_false_authority(self) -> None:
        policy = _policy()
        parsed = TrainingAdmissionPolicyV1.from_json_bytes(policy.to_json_bytes())
        self.assertEqual(parsed, policy)
        self.assertEqual(parsed.fingerprint(), policy.fingerprint())
        self.assert_all_authority_false(parsed)
        with self.assertRaises(FrozenInstanceError):
            parsed.maximum_examples = 1  # type: ignore[misc]
        with self.assertRaises(ValueError):
            replace(policy, maximum_match_frames_ppm=True)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            replace(policy, maximum_match_frames_ppm=PPM + 1)
        with self.assertRaises(ValueError):
            replace(policy, maximum_match_draws_ppm=True)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            replace(policy, maximum_root_asset_draws_ppm=PPM + 1)
        with self.assertRaises(ValueError):
            replace(
                policy,
                required_capture_risk_tags=(
                    CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,
                    CaptureRiskTagV1.HIGH_COMPRESSION,
                ),
            )

    def test_policy_rejects_structurally_impossible_corpus_minima(self) -> None:
        policy = _policy()
        with self.assertRaises(ValueError):
            replace(
                policy,
                maximum_examples=2,
                required_capture_modes=tuple(TrainingCaptureModeV1),
            )
        with self.assertRaises(ValueError):
            replace(
                policy,
                maximum_examples=2,
                minimum_train_frames=33,
                minimum_dev_frames=1,
                maximum_total_frames=34,
            )
        with self.assertRaisesRegex(ValueError, "combined TRAIN/DEV"):
            replace(
                policy,
                maximum_examples=3,
                minimum_train_frames=33,
                minimum_dev_frames=33,
                maximum_total_frames=96,
            )
        with self.assertRaises(ValueError):
            replace(
                policy,
                minimum_train_sources=256,
                minimum_dev_sources=256,
                minimum_train_frames=1,
                minimum_dev_frames=1,
                maximum_total_frames=2,
            )

    def test_policy_wire_rejects_extra_missing_duplicate_and_noncanonical_fields(self) -> None:
        payload = _policy().to_dict()
        extra = dict(payload, surprise=False)
        self.assert_contract_error(
            "TRAIN_ADMISSION_POLICY_SHAPE",
            lambda: TrainingAdmissionPolicyV1.from_json_bytes(_canonical(extra)),
        )
        missing = dict(payload)
        missing.pop("minimum_train_sources")
        self.assert_contract_error(
            "TRAIN_ADMISSION_POLICY_SHAPE",
            lambda: TrainingAdmissionPolicyV1.from_json_bytes(_canonical(missing)),
        )
        with self.assertRaises(CanonicalWireError):
            TrainingAdmissionPolicyV1.from_json_bytes(
                _policy().to_json_bytes().replace(b'"policy_id"', b'"policy_id" ', 1)
            )
        duplicate = b'{"domain":"x","domain":"y"}'
        with self.assertRaises(CanonicalWireError):
            TrainingAdmissionPolicyV1.from_json_bytes(duplicate)

    def test_coverage_report_round_trip_and_satisfaction_equivalence(self) -> None:
        report = TrainingCoverageReportV1(
            dataset_id="dataset-A",
            readiness_manifest_sha256=_digest(500),
            admission_policy_sha256=_digest(501),
            example_reference_set_sha256=_digest(502),
            train_source_count=2,
            dev_source_count=1,
            train_frame_count=4,
            dev_frame_count=2,
            distinct_match_count=3,
            distinct_venue_count=2,
            distinct_camera_setup_count=1,
            covered_capture_modes=(TrainingCaptureModeV1.UHD_4K60,),
            covered_capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
            covered_example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
            maximum_match_frames_ppm=500_000,
            maximum_root_asset_frames_ppm=500_000,
            maximum_leakage_group_frames_ppm=500_000,
            unsatisfied_requirements=(),
            coverage_requirements_satisfied=True,
        )
        self.assertEqual(
            TrainingCoverageReportV1.from_json_bytes(report.to_json_bytes()), report
        )
        self.assert_all_authority_false(report)
        with self.assertRaises(ValueError):
            replace(
                report,
                unsatisfied_requirements=(CoverageRequirementV1.MINIMUM_MATCHES,),
            )
        with self.assertRaises(ValueError):
            replace(report, admission_policy_sha256=report.readiness_manifest_sha256)

    def test_target_tensor_rows_bind_order_dtype_shape_and_field_context(self) -> None:
        rows = _target_rows()
        first = target_tensor_set_sha256_v1(rows)
        changed = list(rows)
        changed[0] = replace(changed[0], content_sha256=_digest(999))
        self.assertNotEqual(first, target_tensor_set_sha256_v1(tuple(changed)))
        with self.assertRaises(ValueError):
            target_tensor_set_sha256_v1(tuple(reversed(rows)))
        with self.assertRaises(ValueError):
            replace(_example(), target_tensor_rows=tuple(reversed(rows)))
        wrong_dtype = list(rows)
        wrong_dtype[0] = replace(wrong_dtype[0], dtype=TargetTensorDTypeV1.BOOL_U8)
        with self.assertRaises(ValueError):
            replace(
                _example(),
                target_tensor_rows=tuple(wrong_dtype),
                target_tensor_set_sha256=target_tensor_set_sha256_v1(tuple(wrong_dtype)),
            )

    def test_example_round_trips_with_exact_derived_joins_and_no_authority(self) -> None:
        example = _example()
        parsed = TrainingExampleManifestV3.from_json_bytes(example.to_json_bytes())
        self.assertEqual(parsed, example)
        self.assert_all_authority_false(parsed)
        self.assertEqual(parsed.schema_version, TRAINING_EXAMPLE_SCHEMA_VERSION)
        wire = json.loads(parsed.to_json_bytes())
        self.assertEqual(wire["domain"], TRAINING_EXAMPLE_DOMAIN)
        self.assertEqual(
            wire["domain"], "multicourt-vision-scoring:training-example:v3"
        )
        self.assertEqual(wire["schema_version"], TRAINING_EXAMPLE_SCHEMA_VERSION)
        self.assertEqual(wire["schema_version"], "3.0")
        self.assertFalse(
            hasattr(training_admission_contracts, "TrainingExampleManifestV2")
        )
        self.assertNotIn(
            "TrainingExampleManifestV2", training_admission_contracts.__all__
        )
        self.assertFalse(
            hasattr(training_admission_contracts, "camera_risk_key_sha256_v1")
        )
        for field_name, stale_value in (
            ("domain", "multicourt-vision-scoring:training-example:v2"),
            ("schema_version", "2.0"),
        ):
            stale = dict(wire)
            stale[field_name] = stale_value
            with self.subTest(field_name=field_name), self.assertRaises(
                TrainingAdmissionContractError
            ):
                TrainingExampleManifestV3.from_json_bytes(
                    json.dumps(
                        stale,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode("utf-8")
                )
        self.assertEqual(
            parsed.leakage_group_sha256,
            leakage_group_sha256_v1(
                match_id=parsed.match_id,
                root_asset_sha256=parsed.root_asset_sha256,
                synchronized_capture_group_id=parsed.synchronized_capture_group_id,
                split_group_id=parsed.split_group_id,
                venue_id=parsed.venue_id,
                camera_setup_id=parsed.camera_setup_id,
                recording_date=parsed.recording_date,
            ),
        )
        self.assertNotIn(b'"split":"TEST"', parsed.to_json_bytes())
        self.assertIs(
            parsed.requested_truth_policy,
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        )
        self.assertEqual(parsed.curator_trust_snapshot_generation, 4)
        self.assertEqual(parsed.protected_verified_at_ns, 1_783_814_400_000_000_000)
        for field_name in (
            "annotation_configuration_generation_sha256",
            "annotation_evidence_set_sha256",
            "annotation_evidence_generation_id",
            "protected_training_configuration_generation_sha256",
            "capture_classification_current_pin_set_sha256",
            "capture_classification_generation_id",
            "capture_profile_classification_sha256",
            "source_representation",
            "source_classification",
            "curator_trust_snapshot_generation",
            "protected_verified_at_ns",
            "requested_truth_policy",
        ):
            self.assertIn(field_name, wire)

    def test_example_protected_provenance_types_bounds_and_roles_are_exact(
        self,
    ) -> None:
        example = _example()
        for field_name in (
            "curator_trust_snapshot_generation",
            "protected_verified_at_ns",
        ):
            for invalid in (True, -1, 1 << 63):
                with self.subTest(
                    field_name=field_name,
                    invalid=invalid,
                ), self.assertRaises(ValueError):
                    replace(example, **{field_name: invalid})
        with self.assertRaisesRegex(ValueError, "requested_truth_policy"):
            replace(
                example,
                requested_truth_policy="REVIEWED_OR_ADJUDICATED",  # type: ignore[arg-type]
            )
        for invalid in (True, "DRAFT_ALLOWED"):
            payload = json.loads(example.to_json_bytes())
            payload["requested_truth_policy"] = invalid
            with self.subTest(wire_truth_policy=invalid), self.assertRaises(
                TrainingAdmissionContractError
            ):
                TrainingExampleManifestV3.from_json_bytes(
                    json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode("utf-8")
                )
        for field_name in (
            "annotation_configuration_generation_sha256",
            "annotation_evidence_set_sha256",
            "annotation_evidence_generation_id",
        ):
            with self.subTest(field_name=field_name), self.assertRaisesRegex(
                ValueError,
                "digest roles must not alias",
            ):
                replace(
                    example,
                    **{field_name: example.annotation_attestation_set_sha256},
                )

    def test_primary_sampling_stratum_is_fully_derived_from_exact_tags(self) -> None:
        self.assertIs(
            derive_primary_sampling_stratum_v1(
                (
                    ExampleStratumTagV1.PARTIALLY_OCCLUDED_BALL,
                    ExampleStratumTagV1.VISIBLE_BALL,
                )
            ),
            PrimarySamplingStratumV1.LOCALIZABLE_BALL,
        )
        self.assertIs(
            derive_primary_sampling_stratum_v1(
                (
                    ExampleStratumTagV1.BALL_OUT_OF_FRAME,
                    ExampleStratumTagV1.FULLY_OCCLUDED_BALL,
                )
            ),
            PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME,
        )
        self.assertIs(
            derive_primary_sampling_stratum_v1(
                (
                    ExampleStratumTagV1.HARD_NEGATIVE,
                    ExampleStratumTagV1.NO_BALL,
                )
            ),
            PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE,
        )
        self.assertIs(
            derive_primary_sampling_stratum_v1((ExampleStratumTagV1.NO_BALL,)),
            PrimarySamplingStratumV1.OTHER_SUPERVISED,
        )
        with self.assertRaises(ValueError):
            derive_primary_sampling_stratum_v1(
                (ExampleStratumTagV1.HARD_NEGATIVE,)
            )
        with self.assertRaises(ValueError):
            derive_primary_sampling_stratum_v1(
                (
                    ExampleStratumTagV1.HARD_NEGATIVE,
                    ExampleStratumTagV1.NO_BALL,
                    ExampleStratumTagV1.VISIBLE_BALL,
                )
            )
        with self.assertRaises(ValueError):
            replace(
                _example(),
                primary_sampling_stratum=PrimarySamplingStratumV1.OTHER_SUPERVISED,
            )
        with self.assertRaises(ValueError):
            replace(
                _references()[0],
                primary_sampling_stratum=PrimarySamplingStratumV1.OTHER_SUPERVISED,
            )

    def test_1080p60_is_single_view_without_compatibility_tier(self) -> None:
        example = _example()
        risk_key = camera_risk_key_sha256_v2(
            capture_mode=TrainingCaptureModeV1.HD_1080P60,
            camera_setup_id=example.camera_setup_id,
            capture_profile_sha256=example.capture_profile_sha256,
            lighting_condition_id=example.lighting_condition_id,
            encoder_configuration_sha256=example.encoder_configuration_sha256,
            source_representation=example.source_representation,
            source_classification=example.source_classification,
        )
        sixty = replace(
            example,
            capture_mode=TrainingCaptureModeV1.HD_1080P60,
            camera_risk_key_sha256=risk_key,
        )
        self.assertNotIn(
            CaptureRiskTagV1.COMPATIBILITY_1080P30,
            sixty.capture_risk_tags,
        )
        with self.assertRaises(ValueError):
            replace(sixty, capture_risk_tags=())

        thirty_risk_key = camera_risk_key_sha256_v2(
            capture_mode=TrainingCaptureModeV1.HD_1080P30,
            camera_setup_id=example.camera_setup_id,
            capture_profile_sha256=example.capture_profile_sha256,
            lighting_condition_id=example.lighting_condition_id,
            encoder_configuration_sha256=example.encoder_configuration_sha256,
            source_representation=example.source_representation,
            source_classification=example.source_classification,
        )
        thirty = replace(
            example,
            capture_mode=TrainingCaptureModeV1.HD_1080P30,
            camera_risk_key_sha256=thirty_risk_key,
            capture_risk_tags=(
                CaptureRiskTagV1.COMPATIBILITY_1080P30,
                CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,
            ),
        )
        self.assertIn(CaptureRiskTagV1.COMPATIBILITY_1080P30, thirty.capture_risk_tags)
        with self.assertRaises(ValueError):
            replace(
                thirty,
                capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
            )

    def test_example_rejects_digest_alias_join_mismatch_and_risk_mismatch(self) -> None:
        example = _example()
        with self.assertRaises(ValueError):
            replace(example, input_tensor_sha256=example.input_encoding_sha256)
        with self.assertRaises(ValueError):
            replace(example, label_pack_sha256=example.root_asset_sha256)
        with self.assertRaises(ValueError):
            replace(example, leakage_group_sha256=_digest(800))
        with self.assertRaises(ValueError):
            replace(example, camera_risk_key_sha256=_digest(801))
        with self.assertRaises(ValueError):
            replace(
                example,
                compression_stratum=CompressionStratumV1.CONSTRAINED_INTERFRAME,
            )
        with self.assertRaises(ValueError):
            replace(example, admissible_for_training=True)
        with self.assertRaises(ValueError):
            replace(example, source_byte_length=MAX_FINALIZED_SOURCE_BYTES + 1)

    def test_example_allows_intentional_source_root_and_parent_root_lineage(self) -> None:
        root = _example()
        self.assertEqual(root.source_asset_sha256, root.root_asset_sha256)
        derived = replace(
            root,
            source_id="source-derived",
            source_asset_sha256=_digest(2),
            parent_asset_sha256=root.root_asset_sha256,
        )
        self.assertEqual(derived.parent_asset_sha256, derived.root_asset_sha256)
        self.assertNotEqual(derived.source_asset_sha256, derived.root_asset_sha256)

    def test_dataset_round_trips_and_binds_canonical_reference_totals(self) -> None:
        dataset = _dataset()
        parsed = TrainingDatasetManifestV1.from_json_bytes(dataset.to_json_bytes())
        self.assertEqual(parsed, dataset)
        self.assert_all_authority_false(parsed)
        self.assertEqual(parsed.train_example_count, 1)
        self.assertEqual(parsed.dev_example_count, 1)
        self.assertNotIn(b"secret-test-source", parsed.to_json_bytes())
        self.assertEqual(parsed.test_source_count, 1)
        self.assertEqual(parsed.test_label_pack_count, 1)
        with self.assertRaises(ValueError):
            replace(dataset, train_frame_count=3)
        with self.assertRaises(ValueError):
            replace(dataset, example_references=tuple(reversed(dataset.example_references)))
        with self.assertRaises(ValueError):
            replace(dataset, coverage_report_sha256=dataset.readiness_report_sha256)
        with self.assertRaises(ValueError):
            replace(dataset, test_label_pack_count=2)
        with self.assertRaises(ValueError):
            replace(dataset, test_source_count=511, test_label_pack_count=511)
        with self.assertRaises(ValueError):
            replace(
                dataset,
                coverage_report_sha256=(
                    dataset.example_references[0].leakage_group_sha256
                ),
            )

    def test_direct_contract_construction_requires_exact_schema_string_type(self) -> None:
        class StringSubclass(str):
            pass

        values = (
            _policy(),
            TrainingCoverageReportV1(
                dataset_id="dataset-A",
                readiness_manifest_sha256=_digest(2100),
                admission_policy_sha256=_digest(2101),
                example_reference_set_sha256=_digest(2102),
                train_source_count=1,
                dev_source_count=1,
                train_frame_count=2,
                dev_frame_count=2,
                distinct_match_count=2,
                distinct_venue_count=1,
                distinct_camera_setup_count=1,
                covered_capture_modes=(TrainingCaptureModeV1.UHD_4K60,),
                covered_capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
                covered_example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
                maximum_match_frames_ppm=500_000,
                maximum_root_asset_frames_ppm=500_000,
                maximum_leakage_group_frames_ppm=500_000,
                unsatisfied_requirements=(),
                coverage_requirements_satisfied=True,
            ),
            _example(),
            _dataset(),
            _request(),
            _plan(),
            _schedule(),
            _run_manifest(),
        )
        for value in values:
            with self.subTest(contract=type(value).__name__):
                with self.assertRaises(ValueError):
                    replace(value, schema_version=StringSubclass("1.0"))

    def test_run_request_round_trips_and_accepts_only_fixed_configs(self) -> None:
        request = _request()
        self.assertEqual(TrainingRunRequestV1.from_json_bytes(request.to_json_bytes()), request)
        self.assert_all_authority_false(request)
        with self.assertRaises(ValueError):
            replace(request, model_config_sha256=_digest(1600))
        with self.assertRaises(ValueError):
            replace(request, maximum_epochs=True)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            replace(request, base_weights_sha256=_digest(1601))
        with self.assertRaises(ValueError):
            replace(request, not_after_utc=request.requested_at_utc)

    def test_sampling_plan_is_integer_only_canonical_and_bounded(self) -> None:
        plan = _plan()
        self.assertEqual(StratifiedSamplingPlanV1.from_json_bytes(plan.to_json_bytes()), plan)
        self.assert_all_authority_false(plan)
        bad_weights = list(plan.stratum_quotas)
        bad_weights[0] = replace(bad_weights[0], weight_ppm=399_999)
        with self.assertRaises(ValueError):
            replace(plan, stratum_quotas=tuple(bad_weights))
        with self.assertRaises(ValueError):
            replace(plan, stratum_quotas=tuple(reversed(plan.stratum_quotas)))
        with self.assertRaises(ValueError):
            replace(plan, epoch_count=64, train_draws_per_epoch=512)
        payload = plan.to_dict()
        payload["sampling_unit"] = "FRAME"
        self.assert_contract_error(
            "TRAIN_ADMISSION_SAMPLING_PLAN_SHAPE",
            lambda: StratifiedSamplingPlanV1.from_json_bytes(_canonical(payload)),
        )

    def test_ranking_is_deterministic_order_independent_and_input_sensitive(self) -> None:
        inputs = {
            "dataset_manifest_sha256": _digest(1700),
            "sampling_plan_sha256": _digest(1701),
            "seed": 23,
            "epoch_index": 0,
            "draw_index": 0,
            "stratum": PrimarySamplingStratumV1.LOCALIZABLE_BALL,
            "leakage_group_sha256": _digest(1702),
            "example_manifest_sha256": _digest(1703),
        }
        first = training_schedule_ranking_sha256_v1(**inputs)
        self.assertEqual(
            first,
            training_schedule_ranking_sha256_v1(
                **dict(reversed(tuple(inputs.items())))
            ),
        )
        self.assertNotEqual(
            first,
            training_schedule_ranking_sha256_v1(**{**inputs, "seed": 24}),
        )
        self.assertNotEqual(
            first,
            training_schedule_ranking_sha256_v1(**{**inputs, "draw_index": 1}),
        )
        self.assertNotEqual(
            first,
            training_schedule_ranking_sha256_v1(
                **{
                    **inputs,
                    "stratum": PrimarySamplingStratumV1.OTHER_SUPERVISED,
                }
            ),
        )

    def test_schedule_round_trips_and_binds_every_ranking(self) -> None:
        schedule = _schedule()
        parsed = TrainingSamplingScheduleV1.from_json_bytes(schedule.to_json_bytes())
        self.assertEqual(parsed, schedule)
        self.assert_all_authority_false(parsed)
        changed_draws = list(schedule.train_draws)
        changed_draws[0] = replace(changed_draws[0], ranking_sha256=_digest(1800))
        with self.assertRaises(ValueError):
            replace(schedule, train_draws=tuple(changed_draws))
        duplicated = list(schedule.train_draws)
        second = duplicated[1]
        duplicate_example = duplicated[0].example_manifest_sha256
        duplicated[1] = replace(
            second,
            example_manifest_sha256=duplicate_example,
            ranking_sha256=training_schedule_ranking_sha256_v1(
                dataset_manifest_sha256=schedule.dataset_manifest_sha256,
                sampling_plan_sha256=schedule.sampling_plan_sha256,
                seed=schedule.seed,
                epoch_index=second.epoch_index,
                draw_index=second.draw_index,
                stratum=second.stratum,
                leakage_group_sha256=second.leakage_group_sha256,
                example_manifest_sha256=duplicate_example,
            ),
        )
        with self.assertRaises(ValueError):
            replace(schedule, train_draws=tuple(duplicated))

    def test_schedule_rejects_test_or_dev_leakage_and_noncanonical_dev_order(self) -> None:
        schedule = _schedule()
        with self.assertRaises(ValueError):
            replace(
                schedule,
                dev_entries=(
                    DevScheduleEntryV1(0, "source-Z", _digest(1901)),
                    DevScheduleEntryV1(1, "source-A", _digest(1900)),
                ),
            )
        train_example = schedule.train_draws[0].example_manifest_sha256
        with self.assertRaises(ValueError):
            replace(
                schedule,
                dev_entries=(DevScheduleEntryV1(0, "source-dev", train_example),),
            )
        self.assertNotIn(b'"split":"TEST"', schedule.to_json_bytes())

    def test_maximum_schedule_round_trips_with_maximum_dev_set(self) -> None:
        dataset_sha = _digest(30_000)
        plan_sha = _digest(30_001)
        seed = 29
        train_draws = tuple(
            TrainingScheduleDrawV1(
                epoch_index=epoch_index,
                draw_index=draw_index,
                stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                leakage_group_sha256=_digest(31_000 + draw_index),
                example_manifest_sha256=_digest(32_000 + draw_index),
                ranking_sha256=training_schedule_ranking_sha256_v1(
                    dataset_manifest_sha256=dataset_sha,
                    sampling_plan_sha256=plan_sha,
                    seed=seed,
                    epoch_index=epoch_index,
                    draw_index=draw_index,
                    stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                    leakage_group_sha256=_digest(31_000 + draw_index),
                    example_manifest_sha256=_digest(32_000 + draw_index),
                ),
            )
            for epoch_index in range(8)
            for draw_index in range(512)
        )
        dev_entries = tuple(
            DevScheduleEntryV1(
                dev_index=index,
                source_id=f"dev-{index:03d}",
                example_manifest_sha256=_digest(33_000 + index),
            )
            for index in range(512)
        )
        schedule = TrainingSamplingScheduleV1(
            dataset_manifest_sha256=dataset_sha,
            sampling_plan_sha256=plan_sha,
            seed=seed,
            epoch_count=8,
            train_draws_per_epoch=512,
            train_draws=train_draws,
            dev_entries=dev_entries,
        )
        raw = schedule.to_json_bytes()
        self.assertLess(len(raw), 2 * 1024 * 1024)
        self.assertEqual(TrainingSamplingScheduleV1.from_json_bytes(raw), schedule)

    def test_run_manifest_round_trips_and_can_only_name_quarantined_outputs(self) -> None:
        run = _run_manifest()
        self.assertEqual(TrainingRunManifestV1.from_json_bytes(run.to_json_bytes()), run)
        self.assert_all_authority_false(run)
        self.assertIs(
            run.output_role,
            TrainingOutputRoleV1.QUARANTINED_TRAINING_CHECKPOINTS,
        )
        with self.assertRaises(ValueError):
            replace(run, output_role="DEPLOYMENT")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            replace(run, admissible_for_deployment=True)

    def test_all_eight_persisted_contracts_keep_authority_false(self) -> None:
        coverage = TrainingCoverageReportV1(
            dataset_id="dataset-A",
            readiness_manifest_sha256=_digest(2000),
            admission_policy_sha256=_digest(2001),
            example_reference_set_sha256=_digest(2002),
            train_source_count=1,
            dev_source_count=1,
            train_frame_count=2,
            dev_frame_count=2,
            distinct_match_count=2,
            distinct_venue_count=1,
            distinct_camera_setup_count=1,
            covered_capture_modes=(TrainingCaptureModeV1.UHD_4K60,),
            covered_capture_risk_tags=(CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,),
            covered_example_stratum_tags=(ExampleStratumTagV1.VISIBLE_BALL,),
            maximum_match_frames_ppm=500_000,
            maximum_root_asset_frames_ppm=500_000,
            maximum_leakage_group_frames_ppm=500_000,
            unsatisfied_requirements=(),
            coverage_requirements_satisfied=True,
        )
        values = (
            _policy(),
            coverage,
            _example(),
            _dataset(),
            _request(),
            _plan(),
            _schedule(),
            _run_manifest(),
        )
        for value in values:
            self.assert_all_authority_false(value)
            payload = json.loads(value.to_json_bytes())
            for field_name in (
                "admissible_for_training",
                "admissible_for_evaluation",
                "admissible_for_test",
                "admissible_for_deployment",
                "admissible_for_live_scoring",
            ):
                self.assertIs(payload[field_name], False)

    def test_exact_integer_and_size_boundaries_reject_bool_and_oversized_plan(self) -> None:
        with self.assertRaises(ValueError):
            StratumQuotaV1(
                stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                weight_ppm=True,  # type: ignore[arg-type]
                minimum_draws_per_epoch=0,
            )
        plan = _plan()
        with self.assertRaises(ValueError):
            replace(
                plan,
                epoch_count=MAX_SCHEDULE_ROWS,
                train_draws_per_epoch=2,
            )


class TrainingAdmissionCoverageCompilerTests(unittest.TestCase):
    def assert_compiler_error(
        self, code: str, callback: Callable[[], object]
    ) -> None:
        with self.assertRaises(TrainingAdmissionCompilerError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        self.assertLess(len(str(caught.exception)), 160)

    def compile(
        self,
        *,
        policy: TrainingAdmissionPolicyV1 | None = None,
        examples: tuple[TrainingExampleManifestV3, ...] | None = None,
        readiness_manifest_sha256: str = _digest(5_000),
    ) -> TrainingCoverageReportV1:
        return compile_training_coverage_v1(
            dataset_id="coverage-dataset-v1",
            readiness_manifest_sha256=readiness_manifest_sha256,
            admission_policy=_policy() if policy is None else policy,
            example_manifests=_compiler_examples() if examples is None else examples,
        )

    def test_compiler_normalizes_order_and_binds_exact_references(self) -> None:
        examples = _compiler_examples()
        report = self.compile(examples=examples)
        reversed_report = self.compile(examples=tuple(reversed(examples)))
        self.assertEqual(report, reversed_report)
        self.assertTrue(report.coverage_requirements_satisfied)
        self.assertEqual(report.unsatisfied_requirements, ())
        self.assertEqual(report.admission_policy_sha256, _policy().fingerprint())
        self.assertEqual(report.train_source_count, 1)
        self.assertEqual(report.dev_source_count, 1)
        self.assertEqual(report.train_frame_count, 2)
        self.assertEqual(report.dev_frame_count, 2)
        self.assertEqual(report.distinct_match_count, 2)
        self.assertEqual(report.distinct_venue_count, 2)
        self.assertEqual(report.distinct_camera_setup_count, 2)
        self.assertEqual(report.maximum_match_frames_ppm, 500_000)
        self.assertEqual(report.maximum_root_asset_frames_ppm, 500_000)
        self.assertEqual(report.maximum_leakage_group_frames_ppm, 500_000)

        split_order = {TrainingSplitV1.TRAIN: 0, TrainingSplitV1.DEV: 1}
        references = tuple(
            sorted(
                (
                    TrainingExampleReferenceV1(
                        source_id=example.source_id,
                        split=example.split,
                        example_manifest_sha256=example.fingerprint(),
                        leakage_group_sha256=example.leakage_group_sha256,
                        frame_count=example.frame_count,
                        primary_sampling_stratum=example.primary_sampling_stratum,
                        example_stratum_tags=example.example_stratum_tags,
                    )
                    for example in examples
                ),
                key=lambda value: (
                    split_order[value.split],
                    value.source_id,
                    value.example_manifest_sha256,
                ),
            )
        )
        self.assertEqual(
            report.example_reference_set_sha256,
            training_example_reference_set_sha256_v1(references),
        )
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(report, field_name), False)

    def test_compiler_uses_integer_ceiling_for_every_group_share(self) -> None:
        train, dev = _compiler_examples()
        rows = _target_rows(frame_count=1)
        train = replace(
            train,
            frame_count=1,
            target_tensor_rows=rows,
            target_tensor_set_sha256=target_tensor_set_sha256_v1(rows),
        )
        policy = replace(
            _policy(),
            minimum_train_frames=1,
            maximum_match_frames_ppm=700_000,
            maximum_root_asset_frames_ppm=700_000,
            maximum_leakage_group_frames_ppm=700_000,
        )
        report = self.compile(policy=policy, examples=(train, dev))
        self.assertEqual(report.train_frame_count + report.dev_frame_count, 3)
        self.assertEqual(report.maximum_match_frames_ppm, 666_667)
        self.assertEqual(report.maximum_root_asset_frames_ppm, 666_667)
        self.assertEqual(report.maximum_leakage_group_frames_ppm, 666_667)
        self.assertTrue(report.coverage_requirements_satisfied)

    def test_compiler_derives_every_policy_coverage_issue(self) -> None:
        policy = _policy()
        examples = _compiler_examples()
        extra = _compiler_variant(
            examples[0], suffix=3, split=TrainingSplitV1.TRAIN
        )
        canonical_modes = tuple(
            sorted(
                (
                    TrainingCaptureModeV1.HD_1080P60,
                    TrainingCaptureModeV1.UHD_4K60,
                ),
                key=lambda value: value.value,
            )
        )
        canonical_risks = tuple(
            sorted(
                (
                    CaptureRiskTagV1.LOW_LIGHT,
                    CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,
                ),
                key=lambda value: value.value,
            )
        )
        canonical_strata = tuple(
            sorted(
                (
                    ExampleStratumTagV1.BALL_OUT_OF_FRAME,
                    ExampleStratumTagV1.VISIBLE_BALL,
                ),
                key=lambda value: value.value,
            )
        )
        scenarios = (
            (
                CoverageRequirementV1.MAXIMUM_EXAMPLES,
                replace(policy, maximum_examples=2),
                (*examples, extra),
            ),
            (
                CoverageRequirementV1.MAXIMUM_TOTAL_FRAMES,
                replace(
                    policy,
                    minimum_train_frames=1,
                    minimum_dev_frames=1,
                    maximum_total_frames=3,
                ),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_TRAIN_SOURCES,
                replace(policy, minimum_train_sources=2),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_DEV_SOURCES,
                replace(policy, minimum_dev_sources=2),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_TRAIN_FRAMES,
                replace(policy, minimum_train_frames=3),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_DEV_FRAMES,
                replace(policy, minimum_dev_frames=3),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_MATCHES,
                replace(policy, minimum_distinct_matches=3),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_VENUES,
                replace(policy, minimum_distinct_venues=3),
                examples,
            ),
            (
                CoverageRequirementV1.MINIMUM_CAMERA_SETUPS,
                replace(policy, minimum_distinct_camera_setups=3),
                examples,
            ),
            (
                CoverageRequirementV1.REQUIRED_CAPTURE_MODES,
                replace(policy, required_capture_modes=canonical_modes),
                examples,
            ),
            (
                CoverageRequirementV1.REQUIRED_CAPTURE_RISKS,
                replace(policy, required_capture_risk_tags=canonical_risks),
                examples,
            ),
            (
                CoverageRequirementV1.REQUIRED_EXAMPLE_STRATA,
                replace(policy, required_example_stratum_tags=canonical_strata),
                examples,
            ),
            (
                CoverageRequirementV1.MAXIMUM_MATCH_SHARE,
                replace(policy, maximum_match_frames_ppm=499_999),
                examples,
            ),
            (
                CoverageRequirementV1.MAXIMUM_ROOT_ASSET_SHARE,
                replace(policy, maximum_root_asset_frames_ppm=499_999),
                examples,
            ),
            (
                CoverageRequirementV1.MAXIMUM_LEAKAGE_GROUP_SHARE,
                replace(policy, maximum_leakage_group_frames_ppm=499_999),
                examples,
            ),
        )
        observed: set[CoverageRequirementV1] = set()
        for expected, selected_policy, selected_examples in scenarios:
            with self.subTest(requirement=expected.value):
                report = self.compile(
                    policy=selected_policy,
                    examples=selected_examples,
                )
                self.assertIn(expected, report.unsatisfied_requirements)
                self.assertEqual(
                    report.unsatisfied_requirements,
                    tuple(
                        sorted(
                            report.unsatisfied_requirements,
                            key=lambda value: value.value,
                        )
                    ),
                )
                self.assertFalse(report.coverage_requirements_satisfied)
                observed.update(report.unsatisfied_requirements)
        self.assertEqual(observed, set(CoverageRequirementV1))

    def test_compiler_rejects_wrong_types_bounds_and_reference_sets(self) -> None:
        examples = _compiler_examples()

        class StringSubclass(str):
            pass

        class TupleSubclass(tuple):
            pass

        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: compile_training_coverage_v1(
                dataset_id=StringSubclass("coverage-dataset-v1"),
                readiness_manifest_sha256=_digest(5_000),
                admission_policy=_policy(),
                example_manifests=examples,
            ),
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: compile_training_coverage_v1(
                dataset_id="coverage-dataset-v1",
                readiness_manifest_sha256=_digest(5_000),
                admission_policy=_policy(),
                example_manifests=TupleSubclass(examples),  # type: ignore[arg-type]
            ),
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: compile_training_coverage_v1(
                dataset_id="coverage-dataset-v1",
                readiness_manifest_sha256=_digest(5_000),
                admission_policy=object(),  # type: ignore[arg-type]
                example_manifests=examples,
            ),
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: self.compile(examples=(examples[0], examples[0])),
        )
        duplicate_source_asset = replace(
            examples[0],
            source_id="source-duplicate-asset",
            split=TrainingSplitV1.DEV,
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: self.compile(examples=(examples[0], duplicate_source_asset)),
        )
        cross_split_leakage = replace(
            examples[0],
            source_id="source-cross-split-leakage",
            source_asset_sha256=_digest(6_000),
            parent_asset_sha256=examples[0].root_asset_sha256,
            split=TrainingSplitV1.DEV,
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: self.compile(examples=(examples[0], cross_split_leakage)),
        )
        second_train = _compiler_variant(
            examples[0], suffix=4, split=TrainingSplitV1.TRAIN
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: self.compile(examples=(examples[0], second_train)),
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_INPUT",
            lambda: self.compile(examples=(examples[0],) * 513),
        )

    def test_compiler_emits_stable_stratum_and_policy_binding_errors(self) -> None:
        examples = _compiler_examples()
        corrupted_example = replace(examples[0])
        object.__setattr__(
            corrupted_example,
            "primary_sampling_stratum",
            PrimarySamplingStratumV1.OTHER_SUPERVISED,
        )
        self.assert_compiler_error(
            "TRAIN_COMPILER_STRATUM",
            lambda: self.compile(examples=(corrupted_example, examples[1])),
        )

        policy = _policy()
        self.assert_compiler_error(
            "TRAIN_COMPILER_POLICY_BINDING",
            lambda: self.compile(
                policy=policy,
                readiness_manifest_sha256=policy.fingerprint(),
            ),
        )
        corrupted_policy = replace(policy)
        object.__setattr__(corrupted_policy, "maximum_match_frames_ppm", 0)
        self.assert_compiler_error(
            "TRAIN_COMPILER_POLICY_BINDING",
            lambda: self.compile(policy=corrupted_policy),
        )

    def test_canonical_train_dev_group_overlaps_fail_independently(self) -> None:
        train, dev = _compiler_examples()

        def replace_and_rebind_leakage(
            example: TrainingExampleManifestV3,
            **changes: object,
        ) -> TrainingExampleManifestV3:
            values = {
                "match_id": changes.get("match_id", example.match_id),
                "root_asset_sha256": changes.get(
                    "root_asset_sha256", example.root_asset_sha256
                ),
                "synchronized_capture_group_id": changes.get(
                    "synchronized_capture_group_id",
                    example.synchronized_capture_group_id,
                ),
                "split_group_id": changes.get(
                    "split_group_id", example.split_group_id
                ),
                "venue_id": changes.get("venue_id", example.venue_id),
                "camera_setup_id": changes.get(
                    "camera_setup_id", example.camera_setup_id
                ),
                "recording_date": changes.get(
                    "recording_date", example.recording_date
                ),
            }
            return replace(
                example,
                **changes,  # type: ignore[arg-type]
                leakage_group_sha256=leakage_group_sha256_v1(**values),
            )

        overlaps = (
            replace_and_rebind_leakage(dev, match_id=train.match_id),
            replace_and_rebind_leakage(
                dev,
                root_asset_sha256=train.root_asset_sha256,
                parent_asset_sha256=train.root_asset_sha256,
            ),
            replace_and_rebind_leakage(
                dev,
                synchronized_capture_group_id=(
                    train.synchronized_capture_group_id
                ),
            ),
            replace_and_rebind_leakage(
                dev,
                split_group_id=train.split_group_id,
            ),
        )
        for candidate in overlaps:
            with self.subTest(candidate=candidate.source_id):
                self.assertNotEqual(
                    candidate.leakage_group_sha256,
                    train.leakage_group_sha256,
                )
                self.assertEqual(
                    TrainingExampleManifestV3.from_json_bytes(
                        candidate.to_json_bytes()
                    ),
                    candidate,
                )
                self.assert_compiler_error(
                    "TRAIN_COMPILER_INPUT",
                    lambda candidate=candidate: self.compile(
                        examples=(train, candidate)
                    ),
                )
                policy = _policy()
                schedule_examples = (train, candidate)
                dataset = _schedule_dataset(
                    examples=schedule_examples,
                    policy=policy,
                )
                plan = _schedule_plan(
                    dataset=dataset,
                    epoch_count=1,
                    train_draws_per_epoch=1,
                    weights=(PPM, 0, 0, 0),
                    minima=(0, 0, 0, 0),
                )
                self.assert_compiler_error(
                    "TRAIN_COMPILER_BINDING",
                    lambda candidate=candidate,
                    dataset=dataset,
                    plan=plan,
                    policy=policy: compile_training_sampling_schedule_v1(
                        dataset_manifest=dataset,
                        admission_policy=policy,
                        sampling_plan=plan,
                        example_manifests=(train, candidate),
                    ),
                )

        allowed = replace_and_rebind_leakage(
            dev,
            venue_id=train.venue_id,
            camera_setup_id=train.camera_setup_id,
            camera_risk_key_sha256=camera_risk_key_sha256_v2(
                capture_mode=dev.capture_mode,
                camera_setup_id=train.camera_setup_id,
                capture_profile_sha256=dev.capture_profile_sha256,
                lighting_condition_id=dev.lighting_condition_id,
                encoder_configuration_sha256=dev.encoder_configuration_sha256,
                source_representation=dev.source_representation,
                source_classification=dev.source_classification,
            ),
        )
        report = self.compile(examples=(train, allowed))
        self.assertTrue(report.coverage_requirements_satisfied)


class TrainingSamplingScheduleCompilerTests(unittest.TestCase):
    def assert_schedule_error(
        self, code: str, callback: Callable[[], object]
    ) -> None:
        with self.assertRaises(TrainingAdmissionCompilerError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        self.assertLess(len(str(caught.exception)), 160)

    def test_schedule_is_canonical_order_independent_exact_dev_and_non_authorizing(
        self,
    ) -> None:
        policy = _policy()
        examples = _schedule_compiler_examples()
        dataset = _schedule_dataset(examples=examples, policy=policy)
        plan = _schedule_plan(dataset=dataset)
        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=dataset,
            admission_policy=policy,
            sampling_plan=plan,
            example_manifests=examples,
        )
        reversed_schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=dataset,
            admission_policy=policy,
            sampling_plan=plan,
            example_manifests=tuple(reversed(examples)),
        )
        self.assertEqual(schedule, reversed_schedule)
        self.assertEqual(
            TrainingSamplingScheduleV1.from_json_bytes(schedule.to_json_bytes()),
            schedule,
        )
        self.assertEqual(schedule.dataset_manifest_sha256, dataset.fingerprint())
        self.assertEqual(schedule.sampling_plan_sha256, plan.fingerprint())
        self.assertEqual(len(schedule.train_draws), 16)
        for epoch_index in range(2):
            epoch_draws = tuple(
                item
                for item in schedule.train_draws
                if item.epoch_index == epoch_index
            )
            self.assertEqual(len(epoch_draws), 8)
            self.assertEqual(
                len({item.example_manifest_sha256 for item in epoch_draws}),
                8,
            )
            self.assertEqual(
                Counter(item.stratum for item in epoch_draws),
                Counter({stratum: 2 for stratum in PrimarySamplingStratumV1}),
            )
        expected_dev = tuple(
            (reference.source_id, reference.example_manifest_sha256)
            for reference in dataset.example_references
            if reference.split is TrainingSplitV1.DEV
        )
        self.assertEqual(
            tuple(
                (entry.source_id, entry.example_manifest_sha256)
                for entry in schedule.dev_entries
            ),
            expected_dev,
        )
        self.assertEqual(
            tuple(entry.dev_index for entry in schedule.dev_entries),
            tuple(range(len(expected_dev))),
        )
        self.assertNotIn(b"TEST", schedule.to_json_bytes())
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(schedule, field_name), False)

    def test_hamilton_minima_ties_and_prefix_deficit_interleaving(self) -> None:
        policy = _policy()
        examples = _schedule_compiler_examples(
            train_counts=(2, 2, 2, 1), dev_count=1
        )
        dataset = _schedule_dataset(examples=examples, policy=policy)
        plan = _schedule_plan(
            dataset=dataset,
            epoch_count=1,
            train_draws_per_epoch=7,
            weights=(400_000, 200_000, 200_000, 200_000),
            minima=(1, 1, 1, 1),
        )
        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=dataset,
            admission_policy=policy,
            sampling_plan=plan,
            example_manifests=examples,
        )
        expected = (
            PrimarySamplingStratumV1.LOCALIZABLE_BALL,
            PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME,
            PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE,
            PrimarySamplingStratumV1.OTHER_SUPERVISED,
            PrimarySamplingStratumV1.LOCALIZABLE_BALL,
            PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME,
            PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE,
        )
        self.assertEqual(tuple(item.stratum for item in schedule.train_draws), expected)
        self.assertEqual(
            Counter(item.stratum for item in schedule.train_draws),
            Counter(
                {
                    PrimarySamplingStratumV1.LOCALIZABLE_BALL: 2,
                    PrimarySamplingStratumV1.OCCLUDED_OR_OUT_OF_FRAME: 2,
                    PrimarySamplingStratumV1.NO_BALL_HARD_NEGATIVE: 2,
                    PrimarySamplingStratumV1.OTHER_SUPERVISED: 1,
                }
            ),
        )

    def test_ranked_search_chooses_exact_lowest_digest_and_seed_is_effective(
        self,
    ) -> None:
        policy = replace(
            _policy(),
            maximum_match_frames_ppm=PPM,
            maximum_root_asset_frames_ppm=PPM,
            maximum_leakage_group_frames_ppm=PPM,
            maximum_match_draws_ppm=PPM,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        examples = _schedule_compiler_examples(
            train_counts=(8, 0, 0, 0), dev_count=1
        )
        dataset = _schedule_dataset(examples=examples, policy=policy)
        train_examples = tuple(
            item for item in examples if item.split is TrainingSplitV1.TRAIN
        )
        selected_examples: set[str] = set()
        for seed in range(16):
            plan = _schedule_plan(
                dataset=dataset,
                seed=seed,
                epoch_count=1,
                train_draws_per_epoch=1,
                weights=(PPM, 0, 0, 0),
                minima=(0, 0, 0, 0),
                maximum_leakage_group_draws_ppm=PPM,
            )
            schedule = compile_training_sampling_schedule_v1(
                dataset_manifest=dataset,
                admission_policy=policy,
                sampling_plan=plan,
                example_manifests=tuple(reversed(examples)),
            )
            ranked = tuple(
                sorted(
                    (
                        training_schedule_ranking_sha256_v1(
                            dataset_manifest_sha256=dataset.fingerprint(),
                            sampling_plan_sha256=plan.fingerprint(),
                            seed=seed,
                            epoch_index=0,
                            draw_index=0,
                            stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                            leakage_group_sha256=example.leakage_group_sha256,
                            example_manifest_sha256=example.fingerprint(),
                        ),
                        example.fingerprint(),
                    )
                    for example in train_examples
                )
            )
            self.assertEqual(
                schedule.train_draws[0].ranking_sha256,
                ranked[0][0],
            )
            self.assertEqual(
                schedule.train_draws[0].example_manifest_sha256,
                ranked[0][1],
            )
            selected_examples.add(schedule.train_draws[0].example_manifest_sha256)
        self.assertGreater(len(selected_examples), 1)

    def test_ranked_search_skips_lower_ranked_candidate_blocked_by_match_cap(
        self,
    ) -> None:
        policy = replace(
            _policy(),
            maximum_match_draws_ppm=500_000,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        original_examples = _schedule_compiler_examples(
            train_counts=(3, 0, 0, 0), dev_count=1
        )
        original_train = tuple(
            item
            for item in original_examples
            if item.split is TrainingSplitV1.TRAIN
        )
        shared_match = "ranked-search-shared-match"
        adjusted_train = tuple(
            replace(
                example,
                match_id=shared_match,
                leakage_group_sha256=leakage_group_sha256_v1(
                    match_id=shared_match,
                    root_asset_sha256=example.root_asset_sha256,
                    synchronized_capture_group_id=example.synchronized_capture_group_id,
                    split_group_id=example.split_group_id,
                    venue_id=example.venue_id,
                    camera_setup_id=example.camera_setup_id,
                    recording_date=example.recording_date,
                ),
            )
            if index < 2
            else example
            for index, example in enumerate(original_train)
        )
        examples = adjusted_train + tuple(
            item
            for item in original_examples
            if item.split is TrainingSplitV1.DEV
        )
        dataset = _schedule_dataset(examples=examples, policy=policy)

        found: tuple[
            StratifiedSamplingPlanV1,
            tuple[tuple[str, TrainingExampleManifestV3], ...],
        ] | None = None
        for seed in range(64):
            plan = _schedule_plan(
                dataset=dataset,
                seed=seed,
                epoch_count=1,
                train_draws_per_epoch=2,
                weights=(PPM, 0, 0, 0),
                minima=(0, 0, 0, 0),
                maximum_leakage_group_draws_ppm=PPM,
            )
            first_ranked = tuple(
                sorted(
                    (
                        training_schedule_ranking_sha256_v1(
                            dataset_manifest_sha256=dataset.fingerprint(),
                            sampling_plan_sha256=plan.fingerprint(),
                            seed=seed,
                            epoch_index=0,
                            draw_index=0,
                            stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                            leakage_group_sha256=example.leakage_group_sha256,
                            example_manifest_sha256=example.fingerprint(),
                        ),
                        example,
                    )
                    for example in adjusted_train
                )
            )
            first = first_ranked[0][1]
            remaining = tuple(example for example in adjusted_train if example != first)
            second_ranked = tuple(
                sorted(
                    (
                        training_schedule_ranking_sha256_v1(
                            dataset_manifest_sha256=dataset.fingerprint(),
                            sampling_plan_sha256=plan.fingerprint(),
                            seed=seed,
                            epoch_index=0,
                            draw_index=1,
                            stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                            leakage_group_sha256=example.leakage_group_sha256,
                            example_manifest_sha256=example.fingerprint(),
                        ),
                        example,
                    )
                    for example in remaining
                )
            )
            if (
                first.match_id == shared_match
                and second_ranked[0][1].match_id == shared_match
            ):
                found = plan, second_ranked
                break
        self.assertIsNotNone(found)
        assert found is not None
        plan, second_ranked = found
        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=dataset,
            admission_policy=policy,
            sampling_plan=plan,
            example_manifests=examples,
        )
        self.assertNotEqual(
            schedule.train_draws[1].example_manifest_sha256,
            second_ranked[0][1].fingerprint(),
        )
        allowed = tuple(
            row for row in second_ranked if row[1].match_id != shared_match
        )
        self.assertEqual(schedule.train_draws[1].ranking_sha256, allowed[0][0])
        self.assertEqual(
            schedule.train_draws[1].example_manifest_sha256,
            allowed[0][1].fingerprint(),
        )

    def test_ranked_search_backtracks_when_top_first_draw_causes_dead_end(
        self,
    ) -> None:
        policy = replace(
            _policy(),
            maximum_match_frames_ppm=PPM,
            maximum_root_asset_frames_ppm=PPM,
            maximum_leakage_group_frames_ppm=PPM,
            maximum_match_draws_ppm=500_000,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        original = _schedule_compiler_examples(
            train_counts=(2, 1, 0, 0), dev_count=1
        )
        train = tuple(
            example for example in original if example.split is TrainingSplitV1.TRAIN
        )
        dev = tuple(
            example for example in original if example.split is TrainingSplitV1.DEV
        )
        local_shared, local_unique, occluded_shared = train
        shared_match = "two-draw-dead-end-match"

        def share_match(
            example: TrainingExampleManifestV3,
        ) -> TrainingExampleManifestV3:
            return replace(
                example,
                match_id=shared_match,
                leakage_group_sha256=leakage_group_sha256_v1(
                    match_id=shared_match,
                    root_asset_sha256=example.root_asset_sha256,
                    synchronized_capture_group_id=example.synchronized_capture_group_id,
                    split_group_id=example.split_group_id,
                    venue_id=example.venue_id,
                    camera_setup_id=example.camera_setup_id,
                    recording_date=example.recording_date,
                ),
            )

        local_shared = share_match(local_shared)
        occluded_shared = share_match(occluded_shared)
        examples = (local_shared, local_unique, occluded_shared, *dev)
        dataset = _schedule_dataset(examples=examples, policy=policy)

        selected_plan: StratifiedSamplingPlanV1 | None = None
        for seed in range(64):
            plan = _schedule_plan(
                dataset=dataset,
                seed=seed,
                epoch_count=1,
                train_draws_per_epoch=2,
                weights=(500_000, 500_000, 0, 0),
                minima=(1, 1, 0, 0),
                maximum_leakage_group_draws_ppm=PPM,
            )
            ranked_local = tuple(
                sorted(
                    (
                        training_schedule_ranking_sha256_v1(
                            dataset_manifest_sha256=dataset.fingerprint(),
                            sampling_plan_sha256=plan.fingerprint(),
                            seed=seed,
                            epoch_index=0,
                            draw_index=0,
                            stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                            leakage_group_sha256=example.leakage_group_sha256,
                            example_manifest_sha256=example.fingerprint(),
                        ),
                        example,
                    )
                    for example in (local_shared, local_unique)
                )
            )
            if ranked_local[0][1] == local_shared:
                selected_plan = plan
                break
        self.assertIsNotNone(selected_plan)
        assert selected_plan is not None

        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=dataset,
            admission_policy=policy,
            sampling_plan=selected_plan,
            example_manifests=examples,
        )
        self.assertEqual(
            schedule.train_draws[0].example_manifest_sha256,
            local_unique.fingerprint(),
        )
        self.assertEqual(
            schedule.train_draws[1].example_manifest_sha256,
            occluded_shared.fingerprint(),
        )

    def test_match_root_leakage_and_stricter_plan_caps_fail_closed(self) -> None:
        base_examples = _schedule_compiler_examples(
            train_counts=(4, 0, 0, 0), dev_count=1
        )
        train = tuple(
            item for item in base_examples if item.split is TrainingSplitV1.TRAIN
        )
        dev = tuple(
            item for item in base_examples if item.split is TrainingSplitV1.DEV
        )

        same_match: list[TrainingExampleManifestV3] = []
        for example in train:
            match_id = "shared-match"
            same_match.append(
                replace(
                    example,
                    match_id=match_id,
                    leakage_group_sha256=leakage_group_sha256_v1(
                        match_id=match_id,
                        root_asset_sha256=example.root_asset_sha256,
                        synchronized_capture_group_id=(
                            example.synchronized_capture_group_id
                        ),
                        split_group_id=example.split_group_id,
                        venue_id=example.venue_id,
                        camera_setup_id=example.camera_setup_id,
                        recording_date=example.recording_date,
                    ),
                )
            )

        shared_root = _digest(9_000)
        same_root = tuple(
            replace(
                example,
                root_asset_sha256=shared_root,
                parent_asset_sha256=shared_root,
                leakage_group_sha256=leakage_group_sha256_v1(
                    match_id=example.match_id,
                    root_asset_sha256=shared_root,
                    synchronized_capture_group_id=example.synchronized_capture_group_id,
                    split_group_id=example.split_group_id,
                    venue_id=example.venue_id,
                    camera_setup_id=example.camera_setup_id,
                    recording_date=example.recording_date,
                ),
            )
            for example in train
        )

        first = train[0]
        shared_match = "shared-leak-match"
        shared_venue = "shared-leak-venue"
        shared_camera = "shared-leak-camera"
        shared_sync = "shared-leak-sync"
        shared_split = "shared-leak-split"
        shared_leakage = leakage_group_sha256_v1(
            match_id=shared_match,
            root_asset_sha256=shared_root,
            synchronized_capture_group_id=shared_sync,
            split_group_id=shared_split,
            venue_id=shared_venue,
            camera_setup_id=shared_camera,
            recording_date=first.recording_date,
        )
        same_leakage = tuple(
            replace(
                example,
                root_asset_sha256=shared_root,
                parent_asset_sha256=shared_root,
                match_id=shared_match,
                venue_id=shared_venue,
                camera_setup_id=shared_camera,
                synchronized_capture_group_id=shared_sync,
                split_group_id=shared_split,
                leakage_group_sha256=shared_leakage,
                camera_risk_key_sha256=camera_risk_key_sha256_v2(
                    capture_mode=example.capture_mode,
                    camera_setup_id=shared_camera,
                    capture_profile_sha256=example.capture_profile_sha256,
                    lighting_condition_id=example.lighting_condition_id,
                    encoder_configuration_sha256=example.encoder_configuration_sha256,
                    source_representation=example.source_representation,
                    source_classification=example.source_classification,
                ),
            )
            for example in train
        )

        scenarios = (
            (
                tuple(same_match) + dev,
                replace(
                    _policy(),
                    maximum_match_draws_ppm=250_000,
                    maximum_root_asset_draws_ppm=PPM,
                    maximum_leakage_group_draws_ppm=PPM,
                ),
                PPM,
            ),
            (
                same_root + dev,
                replace(
                    _policy(),
                    maximum_match_draws_ppm=PPM,
                    maximum_root_asset_draws_ppm=250_000,
                    maximum_leakage_group_draws_ppm=PPM,
                ),
                PPM,
            ),
            (
                same_leakage + dev,
                replace(
                    _policy(),
                    maximum_match_draws_ppm=PPM,
                    maximum_root_asset_draws_ppm=PPM,
                    maximum_leakage_group_draws_ppm=250_000,
                ),
                250_000,
            ),
            (
                same_leakage + dev,
                replace(
                    _policy(),
                    maximum_match_draws_ppm=PPM,
                    maximum_root_asset_draws_ppm=PPM,
                    maximum_leakage_group_draws_ppm=PPM,
                ),
                250_000,
            ),
        )
        for examples, policy, plan_leakage_cap in scenarios:
            with self.subTest(
                policy_match_cap=policy.maximum_match_draws_ppm,
                policy_root_cap=policy.maximum_root_asset_draws_ppm,
                policy_leakage_cap=policy.maximum_leakage_group_draws_ppm,
                plan_leakage_cap=plan_leakage_cap,
            ):
                dataset = _schedule_dataset(examples=examples, policy=policy)
                plan = _schedule_plan(
                    dataset=dataset,
                    epoch_count=1,
                    train_draws_per_epoch=4,
                    weights=(PPM, 0, 0, 0),
                    minima=(0, 0, 0, 0),
                    maximum_leakage_group_draws_ppm=plan_leakage_cap,
                )
                self.assert_schedule_error(
                    "TRAIN_COMPILER_CAPACITY",
                    lambda: compile_training_sampling_schedule_v1(
                        dataset_manifest=dataset,
                        admission_policy=policy,
                        sampling_plan=plan,
                        example_manifests=examples,
                    ),
                )

    def test_unequal_frame_share_backtracks_to_feasible_pair_and_rejects_forced_pair(
        self,
    ) -> None:
        policy = replace(
            _policy(),
            maximum_match_frames_ppm=750_000,
            maximum_root_asset_frames_ppm=PPM,
            maximum_leakage_group_frames_ppm=PPM,
            maximum_match_draws_ppm=PPM,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        base = _example()
        heavy = _compiler_variant(
            base,
            suffix=500,
            split=TrainingSplitV1.TRAIN,
            frame_count=32,
        )
        light_one = _compiler_variant(
            base,
            suffix=501,
            split=TrainingSplitV1.TRAIN,
            frame_count=1,
        )
        light_two = _compiler_variant(
            base,
            suffix=502,
            split=TrainingSplitV1.TRAIN,
            frame_count=1,
        )
        dev = _compiler_variant(
            base,
            suffix=503,
            split=TrainingSplitV1.DEV,
        )
        feasible_examples = (heavy, light_one, light_two, dev)
        feasible_dataset = _schedule_dataset(
            examples=feasible_examples,
            policy=policy,
        )
        selected_plan: StratifiedSamplingPlanV1 | None = None
        for seed in range(64):
            plan = _schedule_plan(
                dataset=feasible_dataset,
                seed=seed,
                epoch_count=1,
                train_draws_per_epoch=2,
                weights=(PPM, 0, 0, 0),
                minima=(0, 0, 0, 0),
                maximum_leakage_group_draws_ppm=PPM,
            )
            first_ranked = min(
                (
                    training_schedule_ranking_sha256_v1(
                        dataset_manifest_sha256=feasible_dataset.fingerprint(),
                        sampling_plan_sha256=plan.fingerprint(),
                        seed=seed,
                        epoch_index=0,
                        draw_index=0,
                        stratum=PrimarySamplingStratumV1.LOCALIZABLE_BALL,
                        leakage_group_sha256=example.leakage_group_sha256,
                        example_manifest_sha256=example.fingerprint(),
                    ),
                    example,
                )
                for example in (heavy, light_one, light_two)
            )
            if first_ranked[1] == heavy:
                selected_plan = plan
                break
        self.assertIsNotNone(selected_plan)
        assert selected_plan is not None

        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=feasible_dataset,
            admission_policy=policy,
            sampling_plan=selected_plan,
            example_manifests=feasible_examples,
        )
        selected_sha256s = {
            draw.example_manifest_sha256 for draw in schedule.train_draws
        }
        self.assertNotIn(heavy.fingerprint(), selected_sha256s)
        self.assertEqual(
            selected_sha256s,
            {light_one.fingerprint(), light_two.fingerprint()},
        )

        infeasible_examples = (heavy, light_one, dev)
        infeasible_dataset = _schedule_dataset(
            examples=infeasible_examples,
            policy=policy,
        )
        infeasible_plan = _schedule_plan(
            dataset=infeasible_dataset,
            epoch_count=1,
            train_draws_per_epoch=2,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        self.assert_schedule_error(
            "TRAIN_COMPILER_CAPACITY",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=infeasible_dataset,
                admission_policy=policy,
                sampling_plan=infeasible_plan,
                example_manifests=infeasible_examples,
            ),
        )

        for frame_cap_field in (
            "maximum_root_asset_frames_ppm",
            "maximum_leakage_group_frames_ppm",
        ):
            selected_policy = replace(
                policy,
                maximum_match_frames_ppm=PPM,
                **{frame_cap_field: 750_000},
            )
            selected_dataset = _schedule_dataset(
                examples=infeasible_examples,
                policy=selected_policy,
            )
            selected_plan = _schedule_plan(
                dataset=selected_dataset,
                epoch_count=1,
                train_draws_per_epoch=2,
                weights=(PPM, 0, 0, 0),
                minima=(0, 0, 0, 0),
                maximum_leakage_group_draws_ppm=PPM,
            )
            self.assert_schedule_error(
                "TRAIN_COMPILER_CAPACITY",
                lambda selected_dataset=selected_dataset,
                selected_plan=selected_plan,
                selected_policy=selected_policy: (
                    compile_training_sampling_schedule_v1(
                        dataset_manifest=selected_dataset,
                        admission_policy=selected_policy,
                        sampling_plan=selected_plan,
                        example_manifests=infeasible_examples,
                    )
                ),
            )

    def test_insufficient_stratum_and_ranked_search_dead_end_are_capacity_errors(
        self,
    ) -> None:
        policy = replace(
            _policy(),
            maximum_match_draws_ppm=PPM,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        examples = _schedule_compiler_examples(
            train_counts=(1, 0, 0, 0), dev_count=1
        )
        dataset = _schedule_dataset(examples=examples, policy=policy)
        plan = _schedule_plan(
            dataset=dataset,
            epoch_count=1,
            train_draws_per_epoch=2,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        self.assert_schedule_error(
            "TRAIN_COMPILER_CAPACITY",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=dataset,
                admission_policy=policy,
                sampling_plan=plan,
                example_manifests=examples,
            ),
        )

    def test_group_caps_use_exact_cross_multiplication_without_rounding(self) -> None:
        examples = _schedule_compiler_examples(
            train_counts=(3, 0, 0, 0), dev_count=1
        )
        rejected_policy = replace(
            _policy(),
            maximum_match_draws_ppm=333_333,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        rejected_dataset = _schedule_dataset(
            examples=examples, policy=rejected_policy
        )
        rejected_plan = _schedule_plan(
            dataset=rejected_dataset,
            epoch_count=1,
            train_draws_per_epoch=3,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        self.assert_schedule_error(
            "TRAIN_COMPILER_CAPACITY",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=rejected_dataset,
                admission_policy=rejected_policy,
                sampling_plan=rejected_plan,
                example_manifests=examples,
            ),
        )

        accepted_policy = replace(
            rejected_policy, maximum_match_draws_ppm=333_334
        )
        accepted_dataset = _schedule_dataset(
            examples=examples, policy=accepted_policy
        )
        accepted_plan = _schedule_plan(
            dataset=accepted_dataset,
            epoch_count=1,
            train_draws_per_epoch=3,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=accepted_dataset,
            admission_policy=accepted_policy,
            sampling_plan=accepted_plan,
            example_manifests=examples,
        )
        self.assertEqual(len(schedule.train_draws), 3)

        frame_rejected_policy = replace(
            _policy(),
            maximum_match_frames_ppm=333_333,
            maximum_root_asset_frames_ppm=PPM,
            maximum_leakage_group_frames_ppm=PPM,
            maximum_match_draws_ppm=PPM,
            maximum_root_asset_draws_ppm=PPM,
            maximum_leakage_group_draws_ppm=PPM,
        )
        frame_rejected_dataset = _schedule_dataset(
            examples=examples,
            policy=frame_rejected_policy,
        )
        frame_rejected_plan = _schedule_plan(
            dataset=frame_rejected_dataset,
            epoch_count=1,
            train_draws_per_epoch=3,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        self.assert_schedule_error(
            "TRAIN_COMPILER_CAPACITY",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=frame_rejected_dataset,
                admission_policy=frame_rejected_policy,
                sampling_plan=frame_rejected_plan,
                example_manifests=examples,
            ),
        )

        frame_accepted_policy = replace(
            frame_rejected_policy,
            maximum_match_frames_ppm=333_334,
        )
        frame_accepted_dataset = _schedule_dataset(
            examples=examples,
            policy=frame_accepted_policy,
        )
        frame_accepted_plan = _schedule_plan(
            dataset=frame_accepted_dataset,
            epoch_count=1,
            train_draws_per_epoch=3,
            weights=(PPM, 0, 0, 0),
            minima=(0, 0, 0, 0),
            maximum_leakage_group_draws_ppm=PPM,
        )
        frame_schedule = compile_training_sampling_schedule_v1(
            dataset_manifest=frame_accepted_dataset,
            admission_policy=frame_accepted_policy,
            sampling_plan=frame_accepted_plan,
            example_manifests=examples,
        )
        self.assertEqual(len(frame_schedule.train_draws), 3)

    def test_exact_types_and_every_cross_contract_join_fail_closed(self) -> None:
        examples = _schedule_compiler_examples()
        policy = _policy()
        dataset = _schedule_dataset(examples=examples, policy=policy)
        plan = _schedule_plan(dataset=dataset)

        class TupleSubclass(tuple):
            pass

        input_scenarios = (
            {"dataset_manifest": object()},
            {"admission_policy": object()},
            {"sampling_plan": object()},
            {"example_manifests": TupleSubclass(examples)},
            {"example_manifests": (examples[0], object())},
        )
        for overrides in input_scenarios:
            arguments: dict[str, object] = {
                "dataset_manifest": dataset,
                "admission_policy": policy,
                "sampling_plan": plan,
                "example_manifests": examples,
            }
            arguments.update(overrides)
            self.assert_schedule_error(
                "TRAIN_COMPILER_INPUT",
                lambda arguments=arguments: compile_training_sampling_schedule_v1(
                    **arguments  # type: ignore[arg-type]
                ),
            )

        other_policy = replace(policy, maximum_match_draws_ppm=700_000)
        other_dataset = _schedule_dataset(examples=examples, policy=other_policy)
        binding_scenarios = (
            (other_dataset, policy, _schedule_plan(dataset=other_dataset), examples),
            (
                dataset,
                policy,
                replace(plan, dataset_manifest_sha256=_digest(8_000)),
                examples,
            ),
            (
                dataset,
                policy,
                replace(plan, maximum_leakage_group_draws_ppm=750_000),
                examples,
            ),
            (
                dataset,
                policy,
                plan,
                _schedule_compiler_examples(train_counts=(3, 2, 2, 1)),
            ),
        )
        for selected_dataset, selected_policy, selected_plan, selected_examples in (
            binding_scenarios
        ):
            self.assert_schedule_error(
                "TRAIN_COMPILER_BINDING",
                lambda selected_dataset=selected_dataset,
                selected_policy=selected_policy,
                selected_plan=selected_plan,
                selected_examples=selected_examples: (
                    compile_training_sampling_schedule_v1(
                        dataset_manifest=selected_dataset,
                        admission_policy=selected_policy,
                        sampling_plan=selected_plan,
                        example_manifests=selected_examples,
                    )
                ),
            )

        bounded_policy = replace(policy, maximum_schedule_rows=4)
        bounded_dataset = _schedule_dataset(examples=examples, policy=bounded_policy)
        oversized_plan = _schedule_plan(
            dataset=bounded_dataset,
            epoch_count=2,
            train_draws_per_epoch=4,
        )
        self.assert_schedule_error(
            "TRAIN_COMPILER_BINDING",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=bounded_dataset,
                admission_policy=bounded_policy,
                sampling_plan=oversized_plan,
                example_manifests=examples,
            ),
        )

    def test_bounded_feasibility_search_exhaustion_fails_closed(self) -> None:
        policy = _policy()
        examples = _schedule_compiler_examples()
        dataset = _schedule_dataset(examples=examples, policy=policy)
        plan = _schedule_plan(dataset=dataset)
        with patch.object(
            training_admission_compiler,
            "MAX_TRAINING_SCHEDULE_SEARCH_STATES_V1",
            0,
        ):
            self.assert_schedule_error(
                "TRAIN_COMPILER_CAPACITY",
                lambda: compile_training_sampling_schedule_v1(
                    dataset_manifest=dataset,
                    admission_policy=policy,
                    sampling_plan=plan,
                    example_manifests=examples,
                ),
            )

        corrupted_dataset = replace(dataset)
        object.__setattr__(corrupted_dataset, "train_example_count", 7)
        self.assert_schedule_error(
            "TRAIN_COMPILER_BINDING",
            lambda: compile_training_sampling_schedule_v1(
                dataset_manifest=corrupted_dataset,
                admission_policy=policy,
                sampling_plan=plan,
                example_manifests=examples,
            ),
        )


if __name__ == "__main__":
    unittest.main()
