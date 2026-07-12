"""Pure, non-authorizing compilers for causal-ball training admission.

This module derives aggregate coverage from exact TRAIN/DEV example manifests.
It opens no stores, performs no readiness checks, and grants no training or
evaluation authority.
"""

from __future__ import annotations

from collections import Counter

from .contract_wire import require_sha256, require_stable_id
from .training_admission_contracts import (
    MAX_SCHEDULE_ROWS,
    MAX_TRAINING_EXAMPLES,
    PPM,
    CoverageRequirementV1,
    DevScheduleEntryV1,
    PrimarySamplingStratumV1,
    StratifiedSamplingPlanV1,
    TrainingAdmissionPolicyV1,
    TrainingCoverageReportV1,
    TrainingDatasetManifestV1,
    TrainingExampleManifestV1,
    TrainingExampleReferenceV1,
    TrainingSamplingScheduleV1,
    TrainingScheduleDrawV1,
    TrainingSplitV1,
    derive_primary_sampling_stratum_v1,
    training_example_reference_set_sha256_v1,
    training_schedule_ranking_sha256_v1,
)


# Search is deliberately bounded across the complete schedule.  The static
# term covers every candidate scan on a maximum-size success path without
# backtracking; the additional term permits bounded feasibility repair.  V1
# returns the lexicographically first rank-ordered solution it can prove within
# this budget.  Exhaustion fails closed and is not an infeasibility claim.
MAX_TRAINING_SCHEDULE_SEARCH_STATES_V1 = (
    MAX_SCHEDULE_ROWS * MAX_TRAINING_EXAMPLES + 1_000_000
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
    for field_name, label in (
        ("leakage_group_sha256", "leakage groups"),
        ("match_id", "matches"),
        ("root_asset_sha256", "root assets"),
        ("synchronized_capture_group_id", "synchronized capture groups"),
        ("split_group_id", "split groups"),
    ):
        train_values = {
            getattr(example, field_name)
            for example, _ in normalized_rows
            if example.split is TrainingSplitV1.TRAIN
        }
        dev_values = {
            getattr(example, field_name)
            for example, _ in normalized_rows
            if example.split is TrainingSplitV1.DEV
        }
        if train_values.intersection(dev_values):
            _fail(
                "TRAIN_COMPILER_INPUT",
                f"TRAIN and DEV {label} must be disjoint",
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


def _normalize_schedule_contracts(
    *,
    dataset_manifest: TrainingDatasetManifestV1,
    admission_policy: TrainingAdmissionPolicyV1,
    sampling_plan: StratifiedSamplingPlanV1,
) -> tuple[
    TrainingDatasetManifestV1,
    TrainingAdmissionPolicyV1,
    StratifiedSamplingPlanV1,
]:
    for value, exact_type, label in (
        (dataset_manifest, TrainingDatasetManifestV1, "dataset_manifest"),
        (admission_policy, TrainingAdmissionPolicyV1, "admission_policy"),
        (sampling_plan, StratifiedSamplingPlanV1, "sampling_plan"),
    ):
        if type(value) is not exact_type:
            _fail("TRAIN_COMPILER_INPUT", f"{label} has the wrong exact type")
    try:
        normalized_dataset = TrainingDatasetManifestV1.from_json_bytes(
            dataset_manifest.to_json_bytes()
        )
        normalized_policy = TrainingAdmissionPolicyV1.from_json_bytes(
            admission_policy.to_json_bytes()
        )
        normalized_plan = StratifiedSamplingPlanV1.from_json_bytes(
            sampling_plan.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_BINDING",
            "schedule contracts are not exact canonical V1 values",
        ) from exc
    if (
        normalized_dataset != dataset_manifest
        or normalized_policy != admission_policy
        or normalized_plan != sampling_plan
    ):
        _fail(
            "TRAIN_COMPILER_BINDING",
            "schedule contracts did not reconstruct exactly",
        )
    return normalized_dataset, normalized_policy, normalized_plan


def _resolve_stratum_draw_counts_v1(
    sampling_plan: StratifiedSamplingPlanV1,
) -> dict[PrimarySamplingStratumV1, int]:
    """Resolve integer quotas by minima followed by canonical Hamilton seats."""

    counts = {
        quota.stratum: quota.minimum_draws_per_epoch
        for quota in sampling_plan.stratum_quotas
    }
    remaining_draws = sampling_plan.train_draws_per_epoch - sum(counts.values())
    remainders: list[tuple[int, int, PrimarySamplingStratumV1]] = []
    canonical_order = {
        stratum: index for index, stratum in enumerate(PrimarySamplingStratumV1)
    }
    allocated = 0
    for quota in sampling_plan.stratum_quotas:
        whole, remainder = divmod(remaining_draws * quota.weight_ppm, PPM)
        counts[quota.stratum] += whole
        allocated += whole
        remainders.append((remainder, canonical_order[quota.stratum], quota.stratum))
    residual_seats = remaining_draws - allocated
    for _, _, stratum in sorted(remainders, key=lambda row: (-row[0], row[1]))[
        :residual_seats
    ]:
        counts[stratum] += 1
    if sum(counts.values()) != sampling_plan.train_draws_per_epoch:
        _fail("TRAIN_COMPILER_CAPACITY", "Hamilton quota resolution failed closed")
    return counts


def _interleave_stratum_draws_v1(
    *,
    quotas: dict[PrimarySamplingStratumV1, int],
    train_draws_per_epoch: int,
) -> tuple[PrimarySamplingStratumV1, ...]:
    """Use largest prefix lag to avoid grouped stratum blocks."""

    canonical_order = {
        stratum: index for index, stratum in enumerate(PrimarySamplingStratumV1)
    }
    selected: Counter[PrimarySamplingStratumV1] = Counter()
    result: list[PrimarySamplingStratumV1] = []
    for draw_index in range(train_draws_per_epoch):
        eligible = tuple(
            stratum
            for stratum in PrimarySamplingStratumV1
            if selected[stratum] < quotas[stratum]
        )
        if not eligible:
            _fail("TRAIN_COMPILER_CAPACITY", "stratum interleaving exhausted early")
        stratum = max(
            eligible,
            key=lambda item: (
                (draw_index + 1) * quotas[item]
                - selected[item] * train_draws_per_epoch,
                -canonical_order[item],
            ),
        )
        selected[stratum] += 1
        result.append(stratum)
    if any(
        selected[stratum] != quotas[stratum]
        for stratum in PrimarySamplingStratumV1
    ):
        _fail("TRAIN_COMPILER_CAPACITY", "stratum interleaving changed a quota")
    return tuple(result)


def _prospective_group_draw_is_allowed(
    *,
    counts: Counter[str],
    key: str,
    maximum_draws_ppm: int,
    train_draws_per_epoch: int,
) -> bool:
    return (counts[key] + 1) * PPM <= (
        maximum_draws_ppm * train_draws_per_epoch
    )


def _group_frame_shares_can_fit_v1(
    *,
    match_frames: Counter[str],
    root_asset_frames: Counter[str],
    leakage_group_frames: Counter[str],
    maximum_total_frames: int,
    admission_policy: TrainingAdmissionPolicyV1,
) -> bool:
    if maximum_total_frames <= 0:
        return False
    return all(
        group_frames * PPM
        <= admission_policy.maximum_match_frames_ppm * maximum_total_frames
        for group_frames in match_frames.values()
    ) and all(
        group_frames * PPM
        <= admission_policy.maximum_root_asset_frames_ppm * maximum_total_frames
        for group_frames in root_asset_frames.values()
    ) and all(
        group_frames * PPM
        <= admission_policy.maximum_leakage_group_frames_ppm
        * maximum_total_frames
        for group_frames in leakage_group_frames.values()
    )


def _decrement_counter(counter: Counter[str], key: str, amount: int) -> None:
    counter[key] -= amount
    if counter[key] == 0:
        del counter[key]


def _compile_epoch_selection_v1(
    *,
    dataset_sha256: str,
    sampling_plan_sha256: str,
    sampling_plan: StratifiedSamplingPlanV1,
    admission_policy: TrainingAdmissionPolicyV1,
    effective_leakage_cap: int,
    epoch_index: int,
    stratum_order: tuple[PrimarySamplingStratumV1, ...],
    example_rows_by_stratum: dict[
        PrimarySamplingStratumV1,
        tuple[tuple[TrainingExampleManifestV1, str], ...],
    ],
    search_states_used: list[int],
) -> tuple[TrainingScheduleDrawV1, ...]:
    """Return the first rank-ordered feasible epoch within the V1 state budget.

    The search is deterministic depth-first backtracking over precomputed rank
    lists.  The fixed global budget is an operational safety boundary: budget
    exhaustion fails closed without asserting that the schedule is infeasible.
    """

    ranked_candidates_by_draw: list[
        tuple[tuple[str, str, TrainingExampleManifestV1], ...]
    ] = []
    for draw_index, stratum in enumerate(stratum_order):
        candidates = tuple(
            sorted(
                (
                    training_schedule_ranking_sha256_v1(
                        dataset_manifest_sha256=dataset_sha256,
                        sampling_plan_sha256=sampling_plan_sha256,
                        seed=sampling_plan.seed,
                        epoch_index=epoch_index,
                        draw_index=draw_index,
                        stratum=stratum,
                        leakage_group_sha256=example.leakage_group_sha256,
                        example_manifest_sha256=example_sha256,
                    ),
                    example_sha256,
                    example,
                )
                for example, example_sha256 in example_rows_by_stratum[stratum]
            )
        )
        ranked_candidates_by_draw.append(candidates)

    frame_ranked_rows_by_stratum = {
        stratum: tuple(
            sorted(
                rows,
                key=lambda row: (-row[0].frame_count, row[1]),
            )
        )
        for stratum, rows in example_rows_by_stratum.items()
    }
    remaining_stratum_draws: list[Counter[PrimarySamplingStratumV1]] = [
        Counter() for _ in range(len(stratum_order) + 1)
    ]
    for draw_index in range(len(stratum_order) - 1, -1, -1):
        remaining_stratum_draws[draw_index] = remaining_stratum_draws[
            draw_index + 1
        ].copy()
        remaining_stratum_draws[draw_index][stratum_order[draw_index]] += 1

    used_example_sha256s: set[str] = set()
    selected: list[tuple[str, str, TrainingExampleManifestV1]] = []
    match_draws: Counter[str] = Counter()
    root_asset_draws: Counter[str] = Counter()
    leakage_group_draws: Counter[str] = Counter()
    match_frames: Counter[str] = Counter()
    root_asset_frames: Counter[str] = Counter()
    leakage_group_frames: Counter[str] = Counter()
    selected_total_frames = 0

    def maximum_possible_final_frames(next_draw_index: int) -> int | None:
        maximum_total = selected_total_frames
        for stratum in PrimarySamplingStratumV1:
            required = remaining_stratum_draws[next_draw_index][stratum]
            if required == 0:
                continue
            found = 0
            for example, example_sha256 in frame_ranked_rows_by_stratum[stratum]:
                if example_sha256 in used_example_sha256s:
                    continue
                maximum_total += example.frame_count
                found += 1
                if found == required:
                    break
            if found != required:
                return None
        return maximum_total

    def search(draw_index: int) -> bool:
        nonlocal selected_total_frames
        if draw_index == len(stratum_order):
            return _group_frame_shares_can_fit_v1(
                match_frames=match_frames,
                root_asset_frames=root_asset_frames,
                leakage_group_frames=leakage_group_frames,
                maximum_total_frames=selected_total_frames,
                admission_policy=admission_policy,
            )

        for candidate in ranked_candidates_by_draw[draw_index]:
            search_states_used[0] += 1
            if (
                search_states_used[0]
                > MAX_TRAINING_SCHEDULE_SEARCH_STATES_V1
            ):
                _fail(
                    "TRAIN_COMPILER_CAPACITY",
                    "bounded schedule feasibility search exhausted",
                )
            ranking_sha256, example_sha256, example = candidate
            if example_sha256 in used_example_sha256s:
                continue
            if not _prospective_group_draw_is_allowed(
                counts=match_draws,
                key=example.match_id,
                maximum_draws_ppm=admission_policy.maximum_match_draws_ppm,
                train_draws_per_epoch=sampling_plan.train_draws_per_epoch,
            ):
                continue
            if not _prospective_group_draw_is_allowed(
                counts=root_asset_draws,
                key=example.root_asset_sha256,
                maximum_draws_ppm=admission_policy.maximum_root_asset_draws_ppm,
                train_draws_per_epoch=sampling_plan.train_draws_per_epoch,
            ):
                continue
            if not _prospective_group_draw_is_allowed(
                counts=leakage_group_draws,
                key=example.leakage_group_sha256,
                maximum_draws_ppm=effective_leakage_cap,
                train_draws_per_epoch=sampling_plan.train_draws_per_epoch,
            ):
                continue

            selected.append((ranking_sha256, example_sha256, example))
            used_example_sha256s.add(example_sha256)
            match_draws[example.match_id] += 1
            root_asset_draws[example.root_asset_sha256] += 1
            leakage_group_draws[example.leakage_group_sha256] += 1
            match_frames[example.match_id] += example.frame_count
            root_asset_frames[example.root_asset_sha256] += example.frame_count
            leakage_group_frames[example.leakage_group_sha256] += example.frame_count
            selected_total_frames += example.frame_count

            maximum_final_frames = maximum_possible_final_frames(draw_index + 1)
            can_still_fit = maximum_final_frames is not None and (
                _group_frame_shares_can_fit_v1(
                    match_frames=match_frames,
                    root_asset_frames=root_asset_frames,
                    leakage_group_frames=leakage_group_frames,
                    maximum_total_frames=maximum_final_frames,
                    admission_policy=admission_policy,
                )
            )
            if can_still_fit and search(draw_index + 1):
                return True

            selected_total_frames -= example.frame_count
            _decrement_counter(match_frames, example.match_id, example.frame_count)
            _decrement_counter(
                root_asset_frames,
                example.root_asset_sha256,
                example.frame_count,
            )
            _decrement_counter(
                leakage_group_frames,
                example.leakage_group_sha256,
                example.frame_count,
            )
            _decrement_counter(match_draws, example.match_id, 1)
            _decrement_counter(root_asset_draws, example.root_asset_sha256, 1)
            _decrement_counter(
                leakage_group_draws,
                example.leakage_group_sha256,
                1,
            )
            used_example_sha256s.remove(example_sha256)
            selected.pop()
        return False

    if not search(0):
        _fail(
            "TRAIN_COMPILER_CAPACITY",
            "no feasible rank-ordered epoch schedule exists within group caps",
        )
    return tuple(
        TrainingScheduleDrawV1(
            epoch_index=epoch_index,
            draw_index=draw_index,
            stratum=stratum_order[draw_index],
            leakage_group_sha256=example.leakage_group_sha256,
            example_manifest_sha256=example_sha256,
            ranking_sha256=ranking_sha256,
        )
        for draw_index, (ranking_sha256, example_sha256, example) in enumerate(
            selected
        )
    )


def compile_training_sampling_schedule_v1(
    *,
    dataset_manifest: TrainingDatasetManifestV1,
    admission_policy: TrainingAdmissionPolicyV1,
    sampling_plan: StratifiedSamplingPlanV1,
    example_manifests: tuple[TrainingExampleManifestV1, ...],
) -> TrainingSamplingScheduleV1:
    """Compile a deterministic TRAIN schedule and exact-once DEV order.

    The result remains non-authorizing.  This pure compiler opens no stores and
    performs no current trust, readiness, publication, or runtime checks.
    """

    normalized_dataset, normalized_policy, normalized_plan = (
        _normalize_schedule_contracts(
            dataset_manifest=dataset_manifest,
            admission_policy=admission_policy,
            sampling_plan=sampling_plan,
        )
    )
    if type(example_manifests) is not tuple:
        _fail("TRAIN_COMPILER_INPUT", "example_manifests must be an exact tuple")
    if not 2 <= len(example_manifests) <= MAX_TRAINING_EXAMPLES:
        _fail("TRAIN_COMPILER_INPUT", "example_manifests exceeds its fixed bound")
    if any(
        type(example) is not TrainingExampleManifestV1
        for example in example_manifests
    ):
        _fail("TRAIN_COMPILER_INPUT", "example_manifests has a wrong exact row type")
    try:
        normalized_examples, references = _normalized_examples_and_references(
            example_manifests
        )
    except TrainingAdmissionCompilerError as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_BINDING",
            "example manifests do not form the exact schedule corpus",
        ) from exc

    dataset_sha256 = normalized_dataset.fingerprint()
    policy_sha256 = normalized_policy.fingerprint()
    sampling_plan_sha256 = normalized_plan.fingerprint()
    reference_set_sha256 = training_example_reference_set_sha256_v1(references)
    train_references = tuple(
        reference
        for reference in references
        if reference.split is TrainingSplitV1.TRAIN
    )
    dev_references = tuple(
        reference for reference in references if reference.split is TrainingSplitV1.DEV
    )
    expected_counts = (
        len(train_references),
        len(dev_references),
        sum(reference.frame_count for reference in train_references),
        sum(reference.frame_count for reference in dev_references),
    )
    actual_counts = (
        normalized_dataset.train_example_count,
        normalized_dataset.dev_example_count,
        normalized_dataset.train_frame_count,
        normalized_dataset.dev_frame_count,
    )
    if normalized_dataset.admission_policy_sha256 != policy_sha256:
        _fail("TRAIN_COMPILER_BINDING", "dataset does not bind the admission policy")
    if (
        normalized_dataset.example_reference_set_sha256 != reference_set_sha256
        or normalized_dataset.example_references != references
        or actual_counts != expected_counts
    ):
        _fail(
            "TRAIN_COMPILER_BINDING",
            "dataset does not bind the exact example corpus",
        )
    if normalized_plan.dataset_manifest_sha256 != dataset_sha256:
        _fail("TRAIN_COMPILER_BINDING", "sampling plan does not bind the dataset")
    schedule_row_count = (
        normalized_plan.epoch_count * normalized_plan.train_draws_per_epoch
    )
    if schedule_row_count > normalized_policy.maximum_schedule_rows:
        _fail("TRAIN_COMPILER_BINDING", "sampling plan exceeds the protected row limit")
    if (
        normalized_plan.maximum_leakage_group_draws_ppm
        > normalized_policy.maximum_leakage_group_draws_ppm
    ):
        _fail("TRAIN_COMPILER_BINDING", "sampling plan weakens the leakage-group cap")

    quota_counts = _resolve_stratum_draw_counts_v1(normalized_plan)
    train_examples = tuple(
        example
        for example in normalized_examples
        if example.split is TrainingSplitV1.TRAIN
    )
    example_rows_by_stratum = {
        stratum: tuple(
            (example, example.fingerprint())
            for example in train_examples
            if example.primary_sampling_stratum is stratum
        )
        for stratum in PrimarySamplingStratumV1
    }
    for stratum in PrimarySamplingStratumV1:
        if quota_counts[stratum] > len(example_rows_by_stratum[stratum]):
            _fail(
                "TRAIN_COMPILER_CAPACITY",
                "a stratum lacks enough unique TRAIN examples for its quota",
            )
    stratum_order = _interleave_stratum_draws_v1(
        quotas=quota_counts,
        train_draws_per_epoch=normalized_plan.train_draws_per_epoch,
    )

    effective_leakage_cap = min(
        normalized_policy.maximum_leakage_group_draws_ppm,
        normalized_plan.maximum_leakage_group_draws_ppm,
    )
    train_draws: list[TrainingScheduleDrawV1] = []
    search_states_used = [0]
    for epoch_index in range(normalized_plan.epoch_count):
        train_draws.extend(
            _compile_epoch_selection_v1(
                dataset_sha256=dataset_sha256,
                sampling_plan_sha256=sampling_plan_sha256,
                sampling_plan=normalized_plan,
                admission_policy=normalized_policy,
                effective_leakage_cap=effective_leakage_cap,
                epoch_index=epoch_index,
                stratum_order=stratum_order,
                example_rows_by_stratum=example_rows_by_stratum,
                search_states_used=search_states_used,
            )
        )

    dev_entries = tuple(
        DevScheduleEntryV1(
            dev_index=index,
            source_id=reference.source_id,
            example_manifest_sha256=reference.example_manifest_sha256,
        )
        for index, reference in enumerate(dev_references)
    )
    try:
        schedule = TrainingSamplingScheduleV1(
            dataset_manifest_sha256=dataset_sha256,
            sampling_plan_sha256=sampling_plan_sha256,
            seed=normalized_plan.seed,
            epoch_count=normalized_plan.epoch_count,
            train_draws_per_epoch=normalized_plan.train_draws_per_epoch,
            train_draws=tuple(train_draws),
            dev_entries=dev_entries,
        )
        reconstructed = TrainingSamplingScheduleV1.from_json_bytes(
            schedule.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise TrainingAdmissionCompilerError(
            "TRAIN_COMPILER_BINDING",
            "compiled schedule failed exact canonical reconstruction",
        ) from exc
    if reconstructed != schedule:
        _fail("TRAIN_COMPILER_BINDING", "compiled schedule did not reconstruct exactly")
    return reconstructed


__all__ = [
    "TrainingAdmissionCompilerError",
    "compile_training_coverage_v1",
    "compile_training_sampling_schedule_v1",
]
