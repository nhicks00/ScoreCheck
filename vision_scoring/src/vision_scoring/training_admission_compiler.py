"""Pure, non-authorizing compilers for causal-ball training admission.

This module derives aggregate coverage from exact TRAIN/DEV example manifests.
It opens no stores, performs no readiness checks, and grants no training or
evaluation authority.
"""

from __future__ import annotations

from collections import Counter

from .contract_wire import require_sha256, require_stable_id
from .training_admission_contracts import (
    MAX_TRAINING_EXAMPLES,
    PPM,
    CoverageRequirementV1,
    TrainingAdmissionPolicyV1,
    TrainingCoverageReportV1,
    TrainingExampleManifestV1,
    TrainingExampleReferenceV1,
    TrainingSplitV1,
    derive_primary_sampling_stratum_v1,
    training_example_reference_set_sha256_v1,
)


class TrainingAdmissionCompilerError(ValueError):
    """A fail-closed compiler error with a stable, bounded code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise TrainingAdmissionCompilerError(code, message)


def _normalize_policy(
    admission_policy: TrainingAdmissionPolicyV1,
) -> TrainingAdmissionPolicyV1:
    if type(admission_policy) is not TrainingAdmissionPolicyV1:
        _fail("TRAIN_COMPILER_INPUT", "admission_policy has the wrong exact type")
    try:
        normalized = TrainingAdmissionPolicyV1.from_json_bytes(
            admission_policy.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_POLICY_BINDING",
            "admission_policy is not an exact canonical protected policy",
        ) from exc
    if normalized != admission_policy:
        _fail(
            "TRAIN_COMPILER_POLICY_BINDING",
            "admission_policy did not reconstruct exactly",
        )
    return normalized


def _normalized_examples_and_references(
    example_manifests: tuple[TrainingExampleManifestV1, ...],
) -> tuple[
    tuple[TrainingExampleManifestV1, ...],
    tuple[TrainingExampleReferenceV1, ...],
]:
    if type(example_manifests) is not tuple:
        _fail("TRAIN_COMPILER_INPUT", "example_manifests must be an exact tuple")
    if not 2 <= len(example_manifests) <= MAX_TRAINING_EXAMPLES:
        _fail("TRAIN_COMPILER_INPUT", "example_manifests exceeds its fixed bound")

    normalized_rows: list[tuple[TrainingExampleManifestV1, str]] = []
    for example in example_manifests:
        if type(example) is not TrainingExampleManifestV1:
            _fail(
                "TRAIN_COMPILER_INPUT",
                "example_manifests contains a row with the wrong exact type",
            )
        try:
            derived_stratum = derive_primary_sampling_stratum_v1(
                example.example_stratum_tags
            )
        except (AttributeError, TypeError, ValueError) as exc:
            raise TrainingAdmissionCompilerError(
                "TRAIN_COMPILER_STRATUM",
                "an example has invalid V1 stratum tags",
            ) from exc
        if example.primary_sampling_stratum is not derived_stratum:
            _fail(
                "TRAIN_COMPILER_STRATUM",
                "an example primary stratum does not match its tags",
            )
        try:
            normalized = TrainingExampleManifestV1.from_json_bytes(
                example.to_json_bytes()
            )
        except (AttributeError, TypeError, ValueError) as exc:
            raise TrainingAdmissionCompilerError(
                "TRAIN_COMPILER_INPUT",
                "an example manifest is not exact canonical V1",
            ) from exc
        if normalized != example:
            _fail(
                "TRAIN_COMPILER_INPUT",
                "an example manifest did not reconstruct exactly",
            )
        normalized_rows.append((normalized, normalized.fingerprint()))

    source_asset_sha256s = tuple(
        example.source_asset_sha256 for example, _ in normalized_rows
    )
    if len(source_asset_sha256s) != len(set(source_asset_sha256s)):
        _fail(
            "TRAIN_COMPILER_INPUT",
            "source assets must appear exactly once in the example corpus",
        )
    train_leakage_groups = {
        example.leakage_group_sha256
        for example, _ in normalized_rows
        if example.split is TrainingSplitV1.TRAIN
    }
    dev_leakage_groups = {
        example.leakage_group_sha256
        for example, _ in normalized_rows
        if example.split is TrainingSplitV1.DEV
    }
    if train_leakage_groups.intersection(dev_leakage_groups):
        _fail(
            "TRAIN_COMPILER_INPUT",
            "TRAIN and DEV leakage groups must be disjoint",
        )

    split_order = {TrainingSplitV1.TRAIN: 0, TrainingSplitV1.DEV: 1}
    normalized_rows.sort(
        key=lambda row: (split_order[row[0].split], row[0].source_id, row[1])
    )
    normalized_examples = tuple(row[0] for row in normalized_rows)
    try:
        references = tuple(
            TrainingExampleReferenceV1(
                source_id=example.source_id,
                split=example.split,
                example_manifest_sha256=manifest_sha256,
                leakage_group_sha256=example.leakage_group_sha256,
                frame_count=example.frame_count,
                primary_sampling_stratum=example.primary_sampling_stratum,
                example_stratum_tags=example.example_stratum_tags,
            )
            for example, manifest_sha256 in normalized_rows
        )
        training_example_reference_set_sha256_v1(references)
    except (AttributeError, TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_INPUT",
            "example manifests do not form one exact TRAIN/DEV reference set",
        ) from exc
    return normalized_examples, references


def _maximum_group_frames_ppm(
    examples: tuple[TrainingExampleManifestV1, ...],
    *,
    key_name: str,
    total_frames: int,
) -> int:
    group_frames: Counter[str] = Counter()
    for example in examples:
        group_frames[getattr(example, key_name)] += example.frame_count
    maximum_group_frames = max(group_frames.values())
    return (maximum_group_frames * PPM + total_frames - 1) // total_frames


def compile_training_coverage_v1(
    *,
    dataset_id: str,
    readiness_manifest_sha256: str,
    admission_policy: TrainingAdmissionPolicyV1,
    example_manifests: tuple[TrainingExampleManifestV1, ...],
) -> TrainingCoverageReportV1:
    """Compile one exact, non-authorizing TRAIN/DEV aggregate coverage report."""

    try:
        if type(dataset_id) is not str:
            raise ValueError("dataset_id has the wrong exact type")
        require_stable_id(dataset_id, "dataset_id")
        if type(readiness_manifest_sha256) is not str:
            raise ValueError("readiness manifest digest has the wrong exact type")
        require_sha256(readiness_manifest_sha256, "readiness_manifest_sha256")
    except (TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_INPUT", "compiler inputs are invalid"
        ) from exc

    normalized_policy = _normalize_policy(admission_policy)
    normalized_examples, references = _normalized_examples_and_references(
        example_manifests
    )
    policy_sha256 = normalized_policy.fingerprint()
    reference_set_sha256 = training_example_reference_set_sha256_v1(references)
    if len(
        {readiness_manifest_sha256, policy_sha256, reference_set_sha256}
    ) != 3:
        _fail(
            "TRAIN_COMPILER_POLICY_BINDING",
            "coverage typed digest bindings must be distinct",
        )

    train_examples = tuple(
        example
        for example in normalized_examples
        if example.split is TrainingSplitV1.TRAIN
    )
    dev_examples = tuple(
        example
        for example in normalized_examples
        if example.split is TrainingSplitV1.DEV
    )
    train_frame_count = sum(example.frame_count for example in train_examples)
    dev_frame_count = sum(example.frame_count for example in dev_examples)
    total_frames = train_frame_count + dev_frame_count

    covered_capture_modes = tuple(
        sorted(
            {example.capture_mode for example in normalized_examples},
            key=lambda value: value.value,
        )
    )
    covered_capture_risk_tags = tuple(
        sorted(
            {
                tag
                for example in normalized_examples
                for tag in example.capture_risk_tags
            },
            key=lambda value: value.value,
        )
    )
    covered_example_stratum_tags = tuple(
        sorted(
            {
                tag
                for example in normalized_examples
                for tag in example.example_stratum_tags
            },
            key=lambda value: value.value,
        )
    )
    maximum_match_frames_ppm = _maximum_group_frames_ppm(
        normalized_examples, key_name="match_id", total_frames=total_frames
    )
    maximum_root_asset_frames_ppm = _maximum_group_frames_ppm(
        normalized_examples, key_name="root_asset_sha256", total_frames=total_frames
    )
    maximum_leakage_group_frames_ppm = _maximum_group_frames_ppm(
        normalized_examples,
        key_name="leakage_group_sha256",
        total_frames=total_frames,
    )

    issues: set[CoverageRequirementV1] = set()
    if len(normalized_examples) > normalized_policy.maximum_examples:
        issues.add(CoverageRequirementV1.MAXIMUM_EXAMPLES)
    if total_frames > normalized_policy.maximum_total_frames:
        issues.add(CoverageRequirementV1.MAXIMUM_TOTAL_FRAMES)
    if len(train_examples) < normalized_policy.minimum_train_sources:
        issues.add(CoverageRequirementV1.MINIMUM_TRAIN_SOURCES)
    if len(dev_examples) < normalized_policy.minimum_dev_sources:
        issues.add(CoverageRequirementV1.MINIMUM_DEV_SOURCES)
    if train_frame_count < normalized_policy.minimum_train_frames:
        issues.add(CoverageRequirementV1.MINIMUM_TRAIN_FRAMES)
    if dev_frame_count < normalized_policy.minimum_dev_frames:
        issues.add(CoverageRequirementV1.MINIMUM_DEV_FRAMES)

    distinct_matches = {example.match_id for example in normalized_examples}
    distinct_venues = {example.venue_id for example in normalized_examples}
    distinct_camera_setups = {
        example.camera_setup_id for example in normalized_examples
    }
    if len(distinct_matches) < normalized_policy.minimum_distinct_matches:
        issues.add(CoverageRequirementV1.MINIMUM_MATCHES)
    if len(distinct_venues) < normalized_policy.minimum_distinct_venues:
        issues.add(CoverageRequirementV1.MINIMUM_VENUES)
    if (
        len(distinct_camera_setups)
        < normalized_policy.minimum_distinct_camera_setups
    ):
        issues.add(CoverageRequirementV1.MINIMUM_CAMERA_SETUPS)
    if not set(normalized_policy.required_capture_modes).issubset(
        covered_capture_modes
    ):
        issues.add(CoverageRequirementV1.REQUIRED_CAPTURE_MODES)
    if not set(normalized_policy.required_capture_risk_tags).issubset(
        covered_capture_risk_tags
    ):
        issues.add(CoverageRequirementV1.REQUIRED_CAPTURE_RISKS)
    if not set(normalized_policy.required_example_stratum_tags).issubset(
        covered_example_stratum_tags
    ):
        issues.add(CoverageRequirementV1.REQUIRED_EXAMPLE_STRATA)
    if maximum_match_frames_ppm > normalized_policy.maximum_match_frames_ppm:
        issues.add(CoverageRequirementV1.MAXIMUM_MATCH_SHARE)
    if (
        maximum_root_asset_frames_ppm
        > normalized_policy.maximum_root_asset_frames_ppm
    ):
        issues.add(CoverageRequirementV1.MAXIMUM_ROOT_ASSET_SHARE)
    if (
        maximum_leakage_group_frames_ppm
        > normalized_policy.maximum_leakage_group_frames_ppm
    ):
        issues.add(CoverageRequirementV1.MAXIMUM_LEAKAGE_GROUP_SHARE)
    unsatisfied_requirements = tuple(sorted(issues, key=lambda value: value.value))

    try:
        return TrainingCoverageReportV1(
            dataset_id=dataset_id,
            readiness_manifest_sha256=readiness_manifest_sha256,
            admission_policy_sha256=policy_sha256,
            example_reference_set_sha256=reference_set_sha256,
            train_source_count=len(train_examples),
            dev_source_count=len(dev_examples),
            train_frame_count=train_frame_count,
            dev_frame_count=dev_frame_count,
            distinct_match_count=len(distinct_matches),
            distinct_venue_count=len(distinct_venues),
            distinct_camera_setup_count=len(distinct_camera_setups),
            covered_capture_modes=covered_capture_modes,
            covered_capture_risk_tags=covered_capture_risk_tags,
            covered_example_stratum_tags=covered_example_stratum_tags,
            maximum_match_frames_ppm=maximum_match_frames_ppm,
            maximum_root_asset_frames_ppm=maximum_root_asset_frames_ppm,
            maximum_leakage_group_frames_ppm=maximum_leakage_group_frames_ppm,
            unsatisfied_requirements=unsatisfied_requirements,
            coverage_requirements_satisfied=not unsatisfied_requirements,
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_INPUT", "coverage report construction failed closed"
        ) from exc


__all__ = [
    "TrainingAdmissionCompilerError",
    "compile_training_coverage_v1",
]
