from __future__ import annotations

import base64
from dataclasses import FrozenInstanceError, fields, replace
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vision_scoring.ball_metrics as ball_metrics_module
import vision_scoring.immutable_store as immutable_store_module
import vision_scoring.domain_events as domain_events_module
from vision_scoring.annotation_trust import (
    AnnotationAttestation,
    AnnotationAttestationRole,
    AnnotationMinimumTruthPolicy,
    AnnotationTrustStore,
    AnnotationVerificationPolicy,
    CurrentAnnotation,
    ProtectedAnnotationConfigurationGeneration,
    TrustedAnnotationKey,
    annotation_attestation_set_fingerprint,
    annotation_attestation_signing_message,
)
from vision_scoring.annotations import (
    AnnotationType,
    AutorotationPolicy,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    CaptureUnavailabilityReason,
    DecodedColorRange,
    DecodedColorSpace,
    DecodedFrameIdentity,
    DecodedFrameHashBasis,
    DecodedPixelFormat,
    FrameDecodeContract,
    FrameDuplicateKind,
    FrameReference,
    PixelRegion,
    PixelCoordinateSpace,
    PixelPoint,
    ReviewState,
    SearchRegionObservabilityAttestation,
    SearchRegionScope,
    SearchRegionVisibility,
    TimestampBasis,
    UnavailableFrameReference,
)
from vision_scoring.ball_metrics import (
    BallPrediction,
    BenchmarkTrustScope,
    ConfidenceRankingPoint,
    TruthPolicy,
    UnitBallEvaluationManifest,
    UnitEvaluationCoverageProof,
    UnitEvaluationSplitProof,
    ball_localization_evaluator_artifact_sha256,
    evaluate_ball_localization as _evaluate_ball_localization,
)
from vision_scoring.dataset_split import (
    DatasetSplit,
    SourceSplitRecord,
    SplitManifest,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
    generation_id_for,
)


SHA = "a" * 64
ONTOLOGY_SHA256 = "b" * 64
REVIEW_EVIDENCE_BYTES = b"ball metric review evidence\n"
ADJUDICATION_EVIDENCE_BYTES = b"ball metric adjudication evidence\n"
CAPTURE_ATTESTATION_BYTES = b"ball metric capture integrity evidence\n"
REVIEW_EVIDENCE_SHA256 = hashlib.sha256(REVIEW_EVIDENCE_BYTES).hexdigest()
ADJUDICATION_EVIDENCE_SHA256 = hashlib.sha256(
    ADJUDICATION_EVIDENCE_BYTES
).hexdigest()
CAPTURE_ATTESTATION_SHA256 = hashlib.sha256(
    CAPTURE_ATTESTATION_BYTES
).hexdigest()
REVIEW_EVIDENCE = "sha256:" + REVIEW_EVIDENCE_SHA256
ADJUDICATION_EVIDENCE = "sha256:" + ADJUDICATION_EVIDENCE_SHA256
CAPTURE_ATTESTATION = "sha256:" + CAPTURE_ATTESTATION_SHA256
REVIEW_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x41" * 32)
ADJUDICATION_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x42" * 32)
UNUSED_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x43" * 32)
DEFAULT_NORMALIZED_TOLERANCE = 5.0 / 12.0


def _decoded_frame_sha256(source_sha256: str, frame_index: int) -> str:
    return hashlib.sha256(
        f"{source_sha256}:{frame_index}:rgb24".encode("utf-8")
    ).hexdigest()


def _decode_contract(
    *,
    width: int = 1920,
    height: int = 1080,
    decoder_artifact_sha256: str = "f" * 64,
) -> FrameDecodeContract:
    return FrameDecodeContract(
        decoder_artifact_sha256=decoder_artifact_sha256,
        decoder_build_id="ffmpeg-8.1-arm64",
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=width,
        output_height=height,
    )


def _frame(
    index: int,
    *,
    source_sha256: str = SHA,
    selected_video_stream_index: int = 0,
    decoded_frame_sha256: str | None = None,
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE,
    duplicate_of_frame_index: int | None = None,
    capture_integrity_attestation_refs: tuple[str, ...] = (),
    width: int = 1920,
    height: int = 1080,
    decode_contract: FrameDecodeContract | None = None,
) -> FrameReference:
    content_index = (
        duplicate_of_frame_index
        if duplicate_of_frame_index is not None
        else index
    )
    return FrameReference(
        identity=DecodedFrameIdentity(
            source_sha256=source_sha256,
            selected_video_stream_index=selected_video_stream_index,
            frame_index=index,
            timestamp_ns=index * 16_666_667,
            timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
            pixel_coordinate_space=(
                PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
            ),
            decode_contract=decode_contract or _decode_contract(width=width, height=height),
            decoded_frame_sha256=(
                decoded_frame_sha256
                if decoded_frame_sha256 is not None
                else _decoded_frame_sha256(source_sha256, content_index)
            ),
            decoded_frame_hash_basis=(
                DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            ),
        ),
        duplicate_kind=duplicate_kind,
        duplicate_of_frame_index=duplicate_of_frame_index,
        capture_integrity_attestation_refs=capture_integrity_attestation_refs,
    )


def _unavailable_frame(
    index: int,
    *,
    source_sha256: str = SHA,
    selected_video_stream_index: int = 0,
) -> UnavailableFrameReference:
    return UnavailableFrameReference(
        source_sha256=source_sha256,
        selected_video_stream_index=selected_video_stream_index,
        frame_index=index,
        expected_interval_start_ns=index * 16_666_667,
        expected_interval_end_ns=(index + 1) * 16_666_667,
        timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        capture_segment_ref=CAPTURE_ATTESTATION,
        unavailability_reason=CaptureUnavailabilityReason.PRESENTATION_GAP,
        capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
        gap_evidence_refs=(REVIEW_EVIDENCE,),
    )


def _search_attestation(
    frame: FrameReference,
    *,
    reviewer_ids: tuple[str, ...],
    review_evidence_refs: tuple[str, ...],
) -> SearchRegionObservabilityAttestation:
    return SearchRegionObservabilityAttestation(
        source_sha256=frame.source_sha256,
        selected_video_stream_index=frame.selected_video_stream_index,
        frame_index=frame.frame_index,
        decoded_frame_sha256=frame.decoded_frame_sha256,
        frame_identity_sha256=frame.identity.fingerprint(),
        target_role=BallRole.MATCH_BALL,
        region_scope=SearchRegionScope.FULL_DECODED_FRAME,
        searched_region=PixelRegion(0, 0, frame.width - 1, frame.height - 1),
        region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
        capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
        reviewer_ids=reviewer_ids,
        review_evidence_refs=review_evidence_refs,
    )


def _truth(
    index: int,
    *,
    visibility: BallVisibility = BallVisibility.VISIBLE,
    appearance: BallAppearance | None = None,
    role: BallRole | None = None,
    play_state: BallPlayState | None = None,
    center: PixelPoint | None = None,
    decoded_frame_sha256: str | None = None,
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE,
    duplicate_of_frame_index: int | None = None,
    capture_integrity_attestation_refs: tuple[str, ...] = (),
    review_state: ReviewState = ReviewState.ADJUDICATED,
    annotation_id: str | None = None,
    source_sha256: str = SHA,
    selected_video_stream_index: int = 0,
    width: int = 1920,
    height: int = 1080,
    decode_contract: FrameDecodeContract | None = None,
    apparent_minor_axis_diameter_px: float = 12.0,
    uncertainty_radius_px: float | None = None,
    ambiguity_reason: str | None = None,
    track_segment_id: str | None = "track-1",
    ball_instance_id: str = "match-ball",
) -> BallFrameAnnotationV2:
    localizable = visibility in {
        BallVisibility.VISIBLE,
        BallVisibility.PARTIALLY_OCCLUDED,
    }
    selected_appearance = appearance or (
        BallAppearance.SHARP if localizable else BallAppearance.NOT_OBSERVABLE
    )
    selected_role = role or (
        BallRole.MATCH_BALL
    )
    selected_play_state = play_state or (
        BallPlayState.NOT_APPLICABLE
        if visibility is BallVisibility.NOT_PRESENT
        else BallPlayState.IN_PLAY
    )
    if center is None and localizable:
        center = PixelPoint(100 + index, 200 + index)
    selected_frame: FrameReference | UnavailableFrameReference
    if visibility is BallVisibility.CAPTURE_UNKNOWN:
        selected_frame = _unavailable_frame(
            index,
            source_sha256=source_sha256,
            selected_video_stream_index=selected_video_stream_index,
        )
    else:
        selected_frame = _frame(
            index,
            source_sha256=source_sha256,
            selected_video_stream_index=selected_video_stream_index,
            decoded_frame_sha256=decoded_frame_sha256,
            duplicate_kind=duplicate_kind,
            duplicate_of_frame_index=duplicate_of_frame_index,
            capture_integrity_attestation_refs=capture_integrity_attestation_refs,
            width=width,
            height=height,
            decode_contract=decode_contract,
        )
    values: dict[str, object] = {
        "annotation_id": annotation_id or f"truth-{source_sha256[:4]}-{index}",
        "ontology_sha256": ONTOLOGY_SHA256,
        "ball_instance_id": ball_instance_id,
        "frame": selected_frame,
        "visibility": visibility,
        "appearance": selected_appearance,
        "role": selected_role,
        "play_state": selected_play_state,
        "center": center,
        "uncertainty_radius_px": uncertainty_radius_px,
        "ambiguity_reason": ambiguity_reason,
        "track_segment_id": (
            None
            if visibility
            in {
                BallVisibility.NOT_PRESENT,
                BallVisibility.INDISTINGUISHABLE,
                BallVisibility.CAPTURE_UNKNOWN,
            }
            else track_segment_id
        ),
        "review_state": review_state,
    }
    if localizable:
        values["apparent_minor_axis_diameter_px"] = (
            apparent_minor_axis_diameter_px
        )
    if selected_appearance is BallAppearance.MOTION_BLURRED:
        assert center is not None
        major_radius = max(5.0, apparent_minor_axis_diameter_px / 2.0)
        values["blur_start"] = PixelPoint(center.x - major_radius, center.y)
        values["blur_end"] = PixelPoint(center.x + major_radius, center.y)
    if review_state in {ReviewState.REVIEWED, ReviewState.ADJUDICATED}:
        values["reviewer_ids"] = ("reviewer-1",)
        values["review_evidence_refs"] = (REVIEW_EVIDENCE,)
    if review_state is ReviewState.ADJUDICATED:
        values["adjudicator_id"] = "adjudicator-1"
        values["adjudication_evidence_refs"] = (ADJUDICATION_EVIDENCE,)
    if visibility is BallVisibility.NOT_PRESENT:
        assert type(selected_frame) is FrameReference
        values["search_region_observability_attestation"] = _search_attestation(
            selected_frame,
            reviewer_ids=values.get("reviewer_ids", ()),  # type: ignore[arg-type]
            review_evidence_refs=values.get("review_evidence_refs", ()),  # type: ignore[arg-type]
        )
    return BallFrameAnnotationV2(**values)  # type: ignore[arg-type]


def _prediction(
    candidate_id: str,
    index: int,
    *,
    center: PixelPoint | None = None,
    confidence: float = 0.9,
    source_sha256: str = SHA,
    selected_video_stream_index: int = 0,
    frame_identity: DecodedFrameIdentity | None = None,
) -> BallPrediction:
    return BallPrediction(
        frame_identity=(
            frame_identity
            if frame_identity is not None
            else _frame(
                index,
                source_sha256=source_sha256,
                selected_video_stream_index=selected_video_stream_index,
            ).identity
        ),
        candidate_id=candidate_id,
        center=center or PixelPoint(100 + index, 200 + index),
        confidence=confidence,
    )


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    return base64.b64encode(
        private_key.public_key().public_bytes_raw()
    ).decode("ascii")


def _annotation_attestation(
    annotation: BallFrameAnnotationV2,
    role: AnnotationAttestationRole,
    principal_id: str,
) -> AnnotationAttestation:
    reviewer = role is AnnotationAttestationRole.REVIEWER
    private_key = REVIEW_PRIVATE_KEY if reviewer else ADJUDICATION_PRIVATE_KEY
    key_id = "review-key-1" if reviewer else "adjudication-key-1"
    signed_on = "2026-07-11"
    signature = private_key.sign(
        annotation_attestation_signing_message(
            annotation,
            role=role,
            principal_id=principal_id,
            key_id=key_id,
            trust_domain_id="ball-metric-fixture-keyring",
            signed_on=signed_on,
        )
    )
    return AnnotationAttestation(
        annotation_type=AnnotationType.BALL_FRAME_OBSERVATION,
        annotation_sha256=annotation.fingerprint(),
        role=role,
        principal_id=principal_id,
        key_id=key_id,
        trust_domain_id="ball-metric-fixture-keyring",
        signed_on=signed_on,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _annotation_trust_store(
    truth: tuple[BallFrameAnnotationV2, ...] | list[BallFrameAnnotationV2],
) -> AnnotationTrustStore:
    current_by_id: dict[str, CurrentAnnotation] = {}
    for annotation in truth:
        current_by_id.setdefault(
            annotation.annotation_id,
            CurrentAnnotation(
                AnnotationType.BALL_FRAME_OBSERVATION,
                annotation.annotation_id,
                annotation.fingerprint(),
            ),
        )
    return AnnotationTrustStore(
        keyring_id="ball-metric-fixture-keyring",
        keys=(
            TrustedAnnotationKey(
                key_id="review-key-1",
                principal_id="reviewer-1",
                permitted_roles=(AnnotationAttestationRole.REVIEWER,),
                public_key_base64=_public_key_base64(REVIEW_PRIVATE_KEY),
                valid_from="2026-01-01",
                valid_until="2026-12-31",
                compromised_on=None,
            ),
            TrustedAnnotationKey(
                key_id="adjudication-key-1",
                principal_id="adjudicator-1",
                permitted_roles=(AnnotationAttestationRole.ADJUDICATOR,),
                public_key_base64=_public_key_base64(
                    ADJUDICATION_PRIVATE_KEY
                ),
                valid_from="2026-01-01",
                valid_until="2026-12-31",
                compromised_on=None,
            ),
        ),
        current_annotations=tuple(current_by_id.values()),
        revoked_annotation_sha256s=(),
    )


def _annotation_attestations(
    truth: tuple[BallFrameAnnotationV2, ...] | list[BallFrameAnnotationV2],
) -> tuple[AnnotationAttestation, ...]:
    attestations: list[AnnotationAttestation] = []
    for annotation in truth:
        for reviewer_id in annotation.reviewer_ids:
            attestations.append(
                _annotation_attestation(
                    annotation,
                    AnnotationAttestationRole.REVIEWER,
                    reviewer_id,
                )
            )
        if annotation.adjudicator_id is not None:
            attestations.append(
                _annotation_attestation(
                    annotation,
                    AnnotationAttestationRole.ADJUDICATOR,
                    annotation.adjudicator_id,
                )
            )
    return tuple(attestations)


def _annotation_verification_policy(
    store: AnnotationTrustStore,
    *,
    minimum_truth_policy: AnnotationMinimumTruthPolicy = (
        AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED
    ),
    **overrides: object,
) -> AnnotationVerificationPolicy:
    values: dict[str, object] = {
        "policy_id": "ball-metric-fixture-policy",
        "governance_domain_id": store.keyring_id,
        "trust_store_sha256": store.fingerprint(),
        "evaluator_artifact_sha256": (
            ball_localization_evaluator_artifact_sha256()
        ),
        "minimum_truth_policy": minimum_truth_policy,
        "valid_from": "2020-01-01",
        "valid_until": "2099-12-31",
    }
    values.update(overrides)
    return AnnotationVerificationPolicy(**values)  # type: ignore[arg-type]


def _publish_annotation_evidence_store(
    directory: str,
    truth: tuple[BallFrameAnnotationV2, ...] | list[BallFrameAnnotationV2],
) -> tuple[Path, GenerationDescriptor]:
    root = Path(directory)
    (root / "locks").mkdir()
    (root / "generations").mkdir()
    payload_by_reference = {
        REVIEW_EVIDENCE: REVIEW_EVIDENCE_BYTES,
        ADJUDICATION_EVIDENCE: ADJUDICATION_EVIDENCE_BYTES,
        CAPTURE_ATTESTATION: CAPTURE_ATTESTATION_BYTES,
    }
    required_references = tuple(
        sorted(
            {
                reference
                for annotation in truth
                for reference in (
                    annotation.review_evidence_refs
                    + annotation.adjudication_evidence_refs
                    + annotation.frame.capture_integrity_attestation_refs
                    + (
                        annotation.search_region_observability_attestation.review_evidence_refs
                        + (
                            annotation.search_region_observability_attestation
                            .capture_integrity_attestation_refs
                        )
                        if annotation.search_region_observability_attestation is not None
                        else ()
                    )
                    + (
                        (annotation.frame.capture_segment_ref,)
                        + annotation.frame.gap_evidence_refs
                        if type(annotation.frame) is UnavailableFrameReference
                        else ()
                    )
                )
            }
        )
    )
    payloads: tuple[bytes, ...]
    try:
        payloads = tuple(
            payload_by_reference[reference]
            for reference in required_references
        )
    except KeyError as error:
        raise AssertionError(
            f"fixture has no payload for evidence reference {error.args[0]!r}"
        ) from error
    digests = tuple(
        sorted(hashlib.sha256(payload).hexdigest() for payload in payloads)
    )
    descriptor = GenerationDescriptor.build(digests)
    bootstrap_generation_lock(root, descriptor.generation_id)
    generation = root / "generations" / descriptor.generation_id
    objects = generation / "objects"
    objects.mkdir(parents=True)
    for payload in payloads:
        digest = hashlib.sha256(payload).hexdigest()
        (objects / digest).write_bytes(payload)
    (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
    return root, descriptor


def _write_protected_annotation_configuration_generation(
    directory: str,
    store: AnnotationTrustStore,
    policy: AnnotationVerificationPolicy,
    *,
    filename: str = "launcher-protected-annotation-configuration.json",
) -> tuple[Path, ProtectedAnnotationConfigurationGeneration]:
    generation = ProtectedAnnotationConfigurationGeneration(
        annotation_trust_store_sha256=store.fingerprint(),
        annotation_verification_policy_sha256=policy.fingerprint(),
        evaluator_artifact_sha256=ball_localization_evaluator_artifact_sha256(),
        governance_domain_id=store.keyring_id,
    )
    path = Path(directory) / filename
    path.write_text(generation.canonical_json(), encoding="utf-8")
    return path, generation


def _unit_evaluation_manifest(
    truth: tuple[BallFrameAnnotationV2, ...] | list[BallFrameAnnotationV2],
) -> UnitBallEvaluationManifest:
    sources = tuple(sorted({annotation.frame.source_sha256 for annotation in truth}))
    records: list[SourceSplitRecord] = []
    for index, source in enumerate(sources):
        records.append(
            SourceSplitRecord(
                asset_sha256=source,
                root_asset_sha256=source,
                parent_asset_sha256=None,
                match_id=f"test-match-{index}",
                venue_id=f"test-venue-{index}",
                camera_setup_id=f"test-camera-{index}",
                recording_date="2026-07-11",
                synchronized_capture_group_id=f"test-sync-{index}",
                split_group_id=f"test-group-{index}",
                split=DatasetSplit.TEST,
            )
        )
    for split, digest, suffix in (
        (DatasetSplit.TRAIN, "c" * 64, "train"),
        (DatasetSplit.DEV, "e" * 64, "dev"),
    ):
        while digest in sources:
            digest = hashlib.sha256((digest + suffix).encode("ascii")).hexdigest()
        records.append(
            SourceSplitRecord(
                asset_sha256=digest,
                root_asset_sha256=digest,
                parent_asset_sha256=None,
                match_id=f"{suffix}-match",
                venue_id=f"{suffix}-venue",
                camera_setup_id=f"{suffix}-camera",
                recording_date="2026-07-10",
                synchronized_capture_group_id=f"{suffix}-sync",
                split_group_id=f"{suffix}-group",
                split=split,
            )
        )
    split_manifest = SplitManifest(records=tuple(records))
    match_frames = {
        (
            annotation.frame.source_sha256,
            annotation.frame.selected_video_stream_index,
            annotation.frame.frame_index,
        )
        for annotation in truth
        if annotation.ball_instance_id == "match-ball"
    }
    coverage = UnitEvaluationCoverageProof(
        ontology_sha256=ONTOLOGY_SHA256,
        annotation_sha256s=tuple(
            sorted(annotation.fingerprint() for annotation in truth)
        ),
        match_ball_frame_count=len(match_frames),
        non_match_ball_annotation_count=len(truth) - len(match_frames),
    )
    return UnitBallEvaluationManifest(
        manifest_id="fixture-unit-benchmark",
        ontology_sha256=ONTOLOGY_SHA256,
        split_proof=UnitEvaluationSplitProof(
            split_manifest=split_manifest,
            evaluated_source_sha256s=sources,
        ),
        coverage_proof=coverage,
        trust_scope=BenchmarkTrustScope.UNVERIFIED_UNIT_BENCHMARK,
    )


def evaluate_ball_localization(
    truth: tuple[BallFrameAnnotationV2, ...] | list[BallFrameAnnotationV2],
    predictions: tuple[BallPrediction, ...] | list[BallPrediction],
    normalized_tolerance_ball_diameters: float,
    *,
    operating_confidence_threshold: float = 0.0,
    truth_policy: TruthPolicy = TruthPolicy.ADJUDICATED_ONLY,
    evaluation_manifest: UnitBallEvaluationManifest | None = None,
):
    """Test-only alias supplying fixture trust, including a fixture-local pin.

    Production callers use the original function imported as
    ``_evaluate_ball_localization`` and must load the pin independently.
    """

    store = _annotation_trust_store(truth)
    policy = _annotation_verification_policy(store)
    with tempfile.TemporaryDirectory() as directory:
        evidence_store_root, _ = _publish_annotation_evidence_store(
            directory,
            truth,
        )
        protected_configuration_path, _ = (
            _write_protected_annotation_configuration_generation(
                directory,
                store,
                policy,
            )
        )
        return _evaluate_ball_localization(
            truth,  # type: ignore[arg-type]
            predictions,  # type: ignore[arg-type]
            normalized_tolerance_ball_diameters=(
                normalized_tolerance_ball_diameters
            ),
            operating_confidence_threshold=operating_confidence_threshold,
            truth_policy=truth_policy,
            evaluation_manifest=(
                evaluation_manifest or _unit_evaluation_manifest(truth)
            ),
            annotation_attestations=_annotation_attestations(truth),
            annotation_trust_store=store,
            annotation_evidence_store_root=evidence_store_root,
            annotation_protected_configuration_generation_path=(
                protected_configuration_path
            ),
            annotation_verification_policy=policy,
            expected_annotation_verification_policy_sha256=policy.fingerprint(),
        )


class BallMetricsTests(unittest.TestCase):
    def test_evaluator_artifact_binds_loaded_code_and_runtime_scope(self) -> None:
        baseline = ball_localization_evaluator_artifact_sha256()
        self.assertRegex(baseline, r"^[0-9a-f]{64}$")
        self.assertEqual(baseline, ball_localization_evaluator_artifact_sha256())

        def altered_safe_ratio(
            numerator: int | float,
            denominator: int | float,
        ) -> float:
            return 1.0

        with patch.object(
            ball_metrics_module,
            "_safe_ratio",
            altered_safe_ratio,
        ):
            self.assertNotEqual(
                baseline,
                ball_localization_evaluator_artifact_sha256(),
            )
        self.assertEqual(baseline, ball_localization_evaluator_artifact_sha256())

        def altered_store_read(descriptor: int, count: int) -> bytes:
            return b""

        with patch.object(
            immutable_store_module,
            "_read_chunk",
            altered_store_read,
        ):
            self.assertNotEqual(
                baseline,
                ball_localization_evaluator_artifact_sha256(),
            )
        self.assertEqual(baseline, ball_localization_evaluator_artifact_sha256())

        def altered_domain_integer(value: object, name: str, maximum: int) -> int:
            return 0

        with patch.object(
            domain_events_module,
            "_positive_int",
            altered_domain_integer,
        ):
            self.assertNotEqual(
                baseline,
                ball_localization_evaluator_artifact_sha256(),
            )
        self.assertEqual(baseline, ball_localization_evaluator_artifact_sha256())

    def test_typed_unit_manifest_binds_ontology_split_and_exact_coverage(self) -> None:
        truth = (_truth(0),)
        manifest = _unit_evaluation_manifest(truth)
        self.assertFalse(manifest.readiness_claim_permitted)
        self.assertIs(
            manifest.trust_scope,
            BenchmarkTrustScope.UNVERIFIED_UNIT_BENCHMARK,
        )

        bad_coverage = replace(
            manifest.coverage_proof,
            annotation_sha256s=("0" * 64,),
        )
        with self.assertRaisesRegex(ValueError, "exact annotation set"):
            evaluate_ball_localization(
                truth,
                (),
                DEFAULT_NORMALIZED_TOLERANCE,
                evaluation_manifest=replace(
                    manifest,
                    coverage_proof=bad_coverage,
                ),
            )

        other_ontology = "7" * 64
        with self.assertRaisesRegex(ValueError, "manifest ontology"):
            evaluate_ball_localization(
                truth,
                (),
                DEFAULT_NORMALIZED_TOLERANCE,
                evaluation_manifest=replace(
                    manifest,
                    ontology_sha256=other_ontology,
                    coverage_proof=replace(
                        manifest.coverage_proof,
                        ontology_sha256=other_ontology,
                    ),
                ),
            )

        train_source = next(
            record.asset_sha256
            for record in manifest.split_proof.split_manifest.records
            if record.split is DatasetSplit.TRAIN
        )
        with self.assertRaisesRegex(ValueError, "exact TEST assignment"):
            UnitEvaluationSplitProof(
                split_manifest=manifest.split_proof.split_manifest,
                evaluated_source_sha256s=(train_source,),
            )
        with self.assertRaisesRegex(ValueError, "unseen TEST venue"):
            UnitEvaluationSplitProof(
                split_manifest=replace(
                    manifest.split_proof.split_manifest,
                    require_unseen_test_venue=False,
                ),
                evaluated_source_sha256s=(SHA,),
            )

    def test_perfect_localization_reports_exact_metrics(self) -> None:
        truth = (_truth(0), _truth(1))
        predictions = (_prediction("candidate-0", 0), _prediction("candidate-1", 1))

        report = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (2, 0, 0),
        )
        self.assertEqual((report.precision, report.recall, report.f1), (1.0, 1.0, 1.0))
        self.assertEqual(report.average_precision_101, 1.0)
        self.assertEqual(report.matched_center_error_mean_px, 0.0)
        self.assertEqual(report.matched_center_error_p50_px, 0.0)
        self.assertEqual(report.matched_center_error_p95_px, 0.0)
        self.assertEqual(report.matched_center_error_max_px, 0.0)

    def test_extra_candidates_confident_negatives_and_misses_are_fp_and_fn(self) -> None:
        truth = (
            _truth(0),
            _truth(1),
            _truth(2, visibility=BallVisibility.NOT_PRESENT),
        )
        predictions = (
            _prediction("correct", 0, confidence=0.9),
            _prediction("extra", 0, center=PixelPoint(110, 210), confidence=0.8),
            _prediction("negative", 2, confidence=0.7),
        )

        report = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (1, 2, 1),
        )
        self.assertAlmostEqual(report.precision, 1 / 3)
        self.assertAlmostEqual(report.recall, 1 / 2)
        self.assertAlmostEqual(report.f1, 0.4)
        self.assertEqual(report.evaluated_confident_negative_frame_count, 1)
        self.assertIn(CAPTURE_ATTESTATION, report.annotation_evidence_refs)
        self.assertIn(REVIEW_EVIDENCE, report.annotation_evidence_refs)
        self.assertEqual(
            report.evaluated_confident_negative_frame_identities,
            (truth[2].frame.identity,),
        )
        with self.assertRaisesRegex(ValueError, "exact subset"):
            replace(
                report,
                activated_confident_negative_frame_identities=(
                    truth[0].frame.identity,
                ),
            )
        with self.assertRaisesRegex(ValueError, "identity commitment"):
            replace(
                report,
                evaluated_confident_negative_frame_identity_set_sha256="0" * 64,
            )
        outside_identity = replace(
            truth[2].frame.identity,
            source_sha256="f" * 64,
        )
        outside_identities = (outside_identity,)
        outside_commitment = ball_metrics_module._frame_identity_set_sha256(
            outside_identities,
            domain=(
                ball_metrics_module._EVALUATED_NEGATIVE_IDENTITY_SET_DOMAIN
            ),
        )
        with self.assertRaisesRegex(ValueError, "exact subset"):
            replace(
                report,
                evaluated_confident_negative_frame_identities=outside_identities,
                evaluated_confident_negative_frame_identity_set_sha256=(
                    outside_commitment
                ),
                activated_confident_negative_frame_identities=outside_identities,
            )

    def test_confidence_order_controls_interpolated_ap(self) -> None:
        truth = (_truth(0), _truth(1, visibility=BallVisibility.NOT_PRESENT))
        tp_first = (
            _prediction("tp", 0, confidence=0.9),
            _prediction("fp", 1, confidence=0.1),
        )
        fp_first = (
            _prediction("tp", 0, confidence=0.1),
            _prediction("fp", 1, confidence=0.9),
        )

        high_ap = evaluate_ball_localization(truth, tp_first, DEFAULT_NORMALIZED_TOLERANCE)
        low_ap = evaluate_ball_localization(truth, fp_first, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(high_ap.average_precision_101, 1.0)
        self.assertEqual(low_ap.average_precision_101, 0.5)

    def test_operating_threshold_between_groups_leaves_full_ranking_ap_intact(
        self,
    ) -> None:
        truth = (
            _truth(0),
            _truth(1),
            _truth(2, visibility=BallVisibility.NOT_PRESENT),
        )
        predictions = (
            _prediction("high-tp", 0, confidence=0.9),
            _prediction("middle-negative", 2, confidence=0.6),
            _prediction("low-tp", 1, confidence=0.4),
        )

        full = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
            operating_confidence_threshold=0.0,
        )
        between = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
            operating_confidence_threshold=0.75,
        )
        middle = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
            operating_confidence_threshold=0.5,
        )

        self.assertEqual(full.average_precision_101, between.average_precision_101)
        self.assertEqual(full.average_precision_101, middle.average_precision_101)
        self.assertEqual(between.full_ranking_true_positive_count, 2)
        self.assertEqual(between.operating_prediction_count, 1)
        self.assertEqual(
            (between.true_positives, between.false_positives, between.false_negatives),
            (1, 0, 1),
        )
        self.assertEqual(
            (middle.true_positives, middle.false_positives, middle.false_negatives),
            (1, 1, 1),
        )
        self.assertEqual(middle.confident_negative_frame_activation_count, 1)
        self.assertNotEqual(
            full.evaluation_input_sha256,
            between.evaluation_input_sha256,
        )

    def test_no_predictions_above_operating_threshold_is_fail_closed(self) -> None:
        truth = (_truth(0),)
        prediction = (_prediction("below-threshold-tp", 0, confidence=0.8),)

        report = evaluate_ball_localization(
            truth,
            prediction,
            DEFAULT_NORMALIZED_TOLERANCE,
            operating_confidence_threshold=0.9,
        )

        self.assertEqual(report.operating_prediction_count, 0)
        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (0, 0, 1),
        )
        self.assertEqual((report.precision, report.recall, report.f1), (0.0, 0.0, 0.0))
        self.assertEqual(report.average_precision_101, 1.0)
        self.assertEqual(report.full_ranking_true_positive_count, 1)
        self.assertEqual(report.matched_center_errors_px, ())
        self.assertEqual(report.matched_center_errors_normalized, ())

    def test_normalized_center_error_is_scale_invariant(self) -> None:
        small_truth = (_truth(0, apparent_minor_axis_diameter_px=10.0),)
        large_truth = (_truth(0, apparent_minor_axis_diameter_px=20.0),)
        small_report = evaluate_ball_localization(
            small_truth,
            (_prediction("small", 0, center=PixelPoint(105, 200)),),
            0.5,
            operating_confidence_threshold=0.5,
        )
        large_report = evaluate_ball_localization(
            large_truth,
            (_prediction("large", 0, center=PixelPoint(110, 200)),),
            0.5,
            operating_confidence_threshold=0.5,
        )

        self.assertEqual(small_report.matched_center_error_mean_px, 5.0)
        self.assertEqual(large_report.matched_center_error_mean_px, 10.0)
        self.assertEqual(small_report.matched_center_errors_normalized, (0.5,))
        self.assertEqual(large_report.matched_center_errors_normalized, (0.5,))
        self.assertEqual(
            small_report.matched_center_error_normalized_mean,
            large_report.matched_center_error_normalized_mean,
        )

    def test_normalized_matching_treats_equal_relative_errors_identically(self) -> None:
        truth = (
            _truth(0, apparent_minor_axis_diameter_px=10.0),
            _truth(1, apparent_minor_axis_diameter_px=100.0),
        )
        predictions = (
            _prediction("small-half-diameter", 0, center=PixelPoint(105, 200)),
            _prediction("large-half-diameter", 1, center=PixelPoint(151, 201)),
        )

        report = evaluate_ball_localization(truth, predictions, 0.5)

        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (2, 0, 0),
        )
        self.assertEqual(report.matched_center_errors_px, (5.0, 50.0))
        self.assertEqual(report.matched_center_errors_normalized, (0.5, 0.5))
        self.assertEqual(report.average_precision_101, 1.0)

    def test_negative_only_suite_reports_operating_activation_without_readiness(
        self,
    ) -> None:
        truth = (
            _truth(0, visibility=BallVisibility.NOT_PRESENT),
            _truth(1, visibility=BallVisibility.FULLY_OCCLUDED),
        )
        predictions = (
            _prediction("activation-a", 0, confidence=0.8),
            _prediction("activation-b", 0, confidence=0.7),
            _prediction("below-threshold", 1, confidence=0.4),
        )

        report = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
            operating_confidence_threshold=0.5,
        )

        self.assertFalse(report.localization_metrics_defined)
        self.assertEqual(report.evaluated_localizable_frame_count, 0)
        self.assertEqual(report.evaluated_confident_negative_frame_count, 1)
        self.assertEqual(report.evaluated_nonlocalizable_frame_count, 1)
        self.assertEqual(report.ignored_nonlocalizable_prediction_count, 1)
        self.assertEqual(report.operating_prediction_count, 2)
        self.assertEqual(report.confident_negative_frame_activation_count, 1)
        self.assertEqual(report.confident_negative_frame_activation_rate, 1.0)
        self.assertEqual(
            report.activated_confident_negative_frame_identities,
            (truth[0].frame.identity,),
        )
        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (0, 2, 0),
        )
        self.assertEqual(
            (report.precision, report.recall, report.f1, report.average_precision_101),
            (0.0, 0.0, 0.0, 0.0),
        )
        self.assertIsNone(report.matched_center_error_normalized_mean)
        self.assertFalse(
            json.loads(report.canonical_json())["localization_metrics_defined"]
        )

    def test_equal_confidence_group_is_invariant_to_ids_and_input_order(self) -> None:
        truth = (_truth(0), _truth(1, visibility=BallVisibility.NOT_PRESENT))
        correct = _prediction("a-correct", 0, confidence=0.5)
        false = _prediction("z-false", 1, confidence=0.5)

        first = evaluate_ball_localization(truth, (false, correct), DEFAULT_NORMALIZED_TOLERANCE)
        reordered = evaluate_ball_localization(
            truth,
            (correct, false),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        renamed = evaluate_ball_localization(
            truth,
            (
                replace(false, candidate_id="a-false"),
                replace(correct, candidate_id="z-correct"),
            ),
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        metric_fields = (
            "true_positives",
            "false_positives",
            "false_negatives",
            "precision",
            "recall",
            "f1",
            "average_precision_101",
            "matched_center_error_mean_px",
            "matched_center_error_p50_px",
            "matched_center_error_p95_px",
            "matched_center_error_max_px",
        )
        expected = tuple(getattr(first, field) for field in metric_fields)
        self.assertEqual(first.average_precision_101, 0.5)
        normalized_reordered = replace(
            reordered,
            verified_at_utc=first.verified_at_utc,
            evaluation_input_sha256=first.evaluation_input_sha256,
        )
        self.assertEqual(first.canonical_json(), normalized_reordered.canonical_json())
        self.assertEqual(
            expected,
            tuple(getattr(renamed, field) for field in metric_fields),
        )

    def test_equal_confidence_group_uses_minimum_valid_error_per_frame(self) -> None:
        truth = (_truth(0),)
        farther = _prediction(
            "a-farther",
            0,
            center=PixelPoint(104, 200),
            confidence=0.5,
        )
        nearer = _prediction(
            "z-nearer",
            0,
            center=PixelPoint(101, 200),
            confidence=0.5,
        )

        first = evaluate_ball_localization(truth, (farther, nearer), DEFAULT_NORMALIZED_TOLERANCE)
        renamed_and_reordered = evaluate_ball_localization(
            truth,
            (
                replace(nearer, candidate_id="a-nearer"),
                replace(farther, candidate_id="z-farther"),
            ),
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        self.assertEqual((first.true_positives, first.false_positives), (1, 1))
        self.assertEqual(first.average_precision_101, 0.5)
        self.assertEqual(
            (
                first.matched_center_error_mean_px,
                first.matched_center_error_p50_px,
                first.matched_center_error_p95_px,
                first.matched_center_error_max_px,
            ),
            (1.0, 1.0, 1.0, 1.0),
        )
        self.assertEqual(
            first.to_canonical_dict()["center_error_px"],
            renamed_and_reordered.to_canonical_dict()["center_error_px"],
        )
        self.assertEqual(
            first.to_canonical_dict()["metrics"],
            renamed_and_reordered.to_canonical_dict()["metrics"],
        )

    def test_motion_blurred_truth_is_localizable_at_its_center(self) -> None:
        truth = (_truth(0, appearance=BallAppearance.MOTION_BLURRED),)
        prediction = _prediction("blur-center", 0, center=PixelPoint(103, 204))

        report = evaluate_ball_localization(truth, (prediction,), DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(report.true_positives, 1)
        self.assertEqual(report.matched_center_error_mean_px, 5.0)
        self.assertEqual(
            dict(report.appearance_counts)[BallAppearance.MOTION_BLURRED],
            1,
        )

    def test_nonlocalizable_strata_are_disclosed_not_scored_as_negatives(self) -> None:
        truth = (
            _truth(0),
            _truth(1, visibility=BallVisibility.FULLY_OCCLUDED),
            _truth(2, visibility=BallVisibility.OUT_OF_FRAME),
            _truth(3, visibility=BallVisibility.NOT_PRESENT),
        )
        predictions = tuple(
            _prediction(f"candidate-{index}", index) for index in range(4)
        )

        report = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(report.true_positives, 1)
        self.assertEqual(report.false_positives, 1)
        self.assertEqual(report.evaluated_confident_negative_frame_count, 1)
        self.assertEqual(report.evaluated_nonlocalizable_frame_count, 2)
        self.assertEqual(report.ignored_nonlocalizable_prediction_count, 2)
        self.assertEqual(
            dict(report.nonlocalizable_visibility_activation_counts),
            {
                BallVisibility.FULLY_OCCLUDED: 1,
                BallVisibility.OUT_OF_FRAME: 1,
                BallVisibility.INDISTINGUISHABLE: 0,
                BallVisibility.CAPTURE_UNKNOWN: 0,
            },
        )
        counts = dict(report.visibility_counts)
        self.assertEqual(counts[BallVisibility.FULLY_OCCLUDED], 1)
        self.assertEqual(counts[BallVisibility.OUT_OF_FRAME], 1)
        self.assertEqual(counts[BallVisibility.NOT_PRESENT], 1)

    def test_v2_visibility_appearance_role_and_play_strata_are_complete(self) -> None:
        truth = (
            _truth(0),
            _truth(
                1,
                visibility=BallVisibility.PARTIALLY_OCCLUDED,
                appearance=BallAppearance.MOTION_BLURRED,
            ),
            _truth(2, visibility=BallVisibility.FULLY_OCCLUDED),
            _truth(3, visibility=BallVisibility.OUT_OF_FRAME),
            _truth(4, visibility=BallVisibility.NOT_PRESENT),
            _truth(
                5,
                visibility=BallVisibility.INDISTINGUISHABLE,
                role=BallRole.UNKNOWN,
                play_state=BallPlayState.UNKNOWN,
                ambiguity_reason="multiple ball candidates cannot be separated",
            ),
            _truth(
                6,
                visibility=BallVisibility.CAPTURE_UNKNOWN,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.UNKNOWN,
                ambiguity_reason="capture continuity is unknown",
            ),
        )
        predictions = tuple(
            _prediction(f"candidate-{index}", index)
            for index in range(len(truth) - 1)
        )

        report = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        self.assertEqual(report.evaluated_localizable_frame_count, 2)
        self.assertEqual(report.evaluated_confident_negative_frame_count, 1)
        self.assertEqual(report.evaluated_nonlocalizable_frame_count, 3)
        self.assertEqual(report.unresolved_role_frame_count, 1)
        self.assertEqual(report.evaluated_prediction_count, 3)
        self.assertEqual(report.ignored_nonlocalizable_prediction_count, 2)
        self.assertEqual(report.unresolved_role_prediction_count, 1)
        self.assertEqual(report.operating_unresolved_role_prediction_count, 1)
        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (2, 1, 0),
        )
        self.assertEqual(
            dict(report.visibility_counts),
            {visibility: 1 for visibility in BallVisibility},
        )
        self.assertEqual(
            dict(report.appearance_counts),
            {
                BallAppearance.SHARP: 1,
                BallAppearance.MOTION_BLURRED: 1,
                BallAppearance.NOT_OBSERVABLE: 5,
            },
        )
        self.assertEqual(dict(report.role_counts)[BallRole.UNKNOWN], 1)
        self.assertEqual(
            dict(report.play_state_counts)[BallPlayState.UNKNOWN],
            2,
        )

    def test_duplicate_frames_and_predictions_are_excluded_and_counted(self) -> None:
        truth = (
            _truth(0),
            _truth(
                1,
                center=PixelPoint(100, 200),
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=0,
                capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
            ),
            _truth(2, visibility=BallVisibility.NOT_PRESENT),
            _truth(
                3,
                visibility=BallVisibility.NOT_PRESENT,
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=2,
                capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
            ),
        )
        predictions = (
            _prediction("evaluated", 0, confidence=0.1),
            _prediction(
                "duplicate-tp",
                1,
                confidence=1.0,
                frame_identity=truth[1].frame.identity,
            ),
            _prediction(
                "duplicate-negative",
                3,
                confidence=1.0,
                frame_identity=truth[3].frame.identity,
            ),
        )

        report = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (1, 0, 0),
        )
        self.assertEqual(report.excluded_duplicate_frame_count, 2)
        self.assertEqual(report.excluded_duplicate_prediction_count, 2)
        self.assertEqual(report.evaluated_frame_count, 2)
        self.assertEqual(report.evaluated_prediction_count, 1)
        self.assertEqual(report.confident_negative_frame_activation_count, 0)
        self.assertEqual(sum(dict(report.visibility_counts).values()), 2)

    def test_verified_duplicate_rejects_semantic_disagreement(self) -> None:
        truth = (
            _truth(0, visibility=BallVisibility.NOT_PRESENT),
            _truth(
                1,
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=0,
                capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
            ),
        )
        with self.assertRaisesRegex(ValueError, "disagrees.*visibility"):
            evaluate_ball_localization(truth, (), DEFAULT_NORMALIZED_TOLERANCE)

    def test_verified_duplicate_checks_every_semantic_field_and_adjudication(self) -> None:
        original = _truth(
            0,
            center=PixelPoint(100, 200),
            uncertainty_radius_px=1.0,
            ambiguity_reason="reviewed baseline",
            track_segment_id="track-1",
        )
        duplicate = _truth(
            1,
            center=PixelPoint(100, 200),
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=0,
            capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
            uncertainty_radius_px=1.0,
            ambiguity_reason="reviewed baseline",
            track_segment_id="track-1",
        )
        disagreements = (
            (replace(duplicate, center=PixelPoint(101, 200)), "center"),
            (
                replace(duplicate, apparent_minor_axis_diameter_px=11.0),
                "apparent_minor_axis_diameter_px",
            ),
            (replace(duplicate, uncertainty_radius_px=2.0), "uncertainty_radius_px"),
            (replace(duplicate, ambiguity_reason="different"), "ambiguity_reason"),
            (replace(duplicate, track_segment_id="track-2"), "track_segment_id"),
        )
        for changed, field_name in disagreements:
            with self.subTest(field_name=field_name), self.assertRaisesRegex(
                ValueError,
                field_name,
            ):
                evaluate_ball_localization(
                    (original, changed),
                    (),
                    DEFAULT_NORMALIZED_TOLERANCE,
                )

        blur_original = _truth(
            0,
            appearance=BallAppearance.MOTION_BLURRED,
            center=PixelPoint(100, 200),
        )
        blur_duplicate = _truth(
            1,
            appearance=BallAppearance.MOTION_BLURRED,
            center=PixelPoint(100, 200),
            duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
            duplicate_of_frame_index=0,
            capture_integrity_attestation_refs=(CAPTURE_ATTESTATION,),
        )
        changed_blur = replace(
            blur_duplicate,
            blur_start=PixelPoint(93, 200),
            blur_end=PixelPoint(107, 200),
        )
        with self.assertRaisesRegex(ValueError, "blur_start"):
            evaluate_ball_localization(
                (blur_original, changed_blur),
                (),
                DEFAULT_NORMALIZED_TOLERANCE,
            )

        reviewed_duplicate = replace(
            duplicate,
            review_state=ReviewState.REVIEWED,
            adjudicator_id=None,
            adjudication_evidence_refs=(),
        )
        with self.assertRaisesRegex(ValueError, "must be ADJUDICATED"):
            evaluate_ball_localization(
                (original, reviewed_duplicate),
                (),
                DEFAULT_NORMALIZED_TOLERANCE,
                truth_policy=TruthPolicy.REVIEWED_OR_ADJUDICATED,
            )

    def test_duplicate_claims_reject_orphans_chains_and_identity_mismatches(self) -> None:
        other_source = "b" * 64
        invalid_cases = (
            (
                (
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                    ),
                ),
                "missing original frame in the same source",
            ),
            (
                (
                    _truth(0, source_sha256=other_source),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                    ),
                ),
                "missing original frame in the same source",
            ),
            (
                (
                    _truth(0),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                    ),
                    _truth(
                        2,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=1,
                    ),
                ),
                "cannot reference another duplicate",
            ),
            (
                (
                    _truth(0),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                        decoded_frame_sha256="f" * 64,
                    ),
                ),
                "decoded_frame_sha256",
            ),
            (
                (
                    _truth(0),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                        width=1280,
                    ),
                ),
                "width",
            ),
            (
                (
                    _truth(0, selected_video_stream_index=1),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                    ),
                ),
                "selected video stream",
            ),
            (
                (
                    _truth(0),
                    _truth(
                        1,
                        duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                        duplicate_of_frame_index=0,
                        decode_contract=_decode_contract(
                            decoder_artifact_sha256="e" * 64
                        ),
                    ),
                ),
                "decode_contract",
            ),
        )
        for truth, message in invalid_cases:
            with self.subTest(message=message), self.assertRaisesRegex(
                ValueError,
                message,
            ):
                evaluate_ball_localization(truth, (), DEFAULT_NORMALIZED_TOLERANCE)

    def test_pixel_equivalence_without_capture_attestation_is_not_excluded(self) -> None:
        truth = (
            _truth(0),
            _truth(
                1,
                center=PixelPoint(100, 200),
                duplicate_kind=FrameDuplicateKind.PIXEL_EQUIVALENT,
                duplicate_of_frame_index=0,
            ),
        )
        predictions = (
            _prediction("original", 0),
            _prediction(
                "pixel-equivalent",
                1,
                center=PixelPoint(100, 200),
                frame_identity=truth[1].frame.identity,
            ),
        )

        report = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual(report.excluded_duplicate_frame_count, 0)
        self.assertEqual(report.excluded_duplicate_prediction_count, 0)
        self.assertEqual(report.evaluated_frame_count, 2)
        self.assertEqual(report.true_positives, 2)

    def test_truth_policy_rejects_draft_and_controls_reviewed_truth(self) -> None:
        draft = (_truth(0, review_state=ReviewState.DRAFT),)
        reviewed = (_truth(0, review_state=ReviewState.REVIEWED),)
        with self.assertRaisesRegex(ValueError, "DRAFT annotation"):
            evaluate_ball_localization(draft, (), DEFAULT_NORMALIZED_TOLERANCE)
        with self.assertRaisesRegex(ValueError, "below.*ADJUDICATED_ONLY"):
            evaluate_ball_localization(reviewed, (), DEFAULT_NORMALIZED_TOLERANCE)

        report = evaluate_ball_localization(
            reviewed,
            (),
            DEFAULT_NORMALIZED_TOLERANCE,
            truth_policy=TruthPolicy.REVIEWED_OR_ADJUDICATED,
        )
        self.assertEqual(report.false_negatives, 1)
        self.assertEqual(report.truth_policy, TruthPolicy.REVIEWED_OR_ADJUDICATED)

        with self.assertRaisesRegex(ValueError, "TruthPolicy enum"):
            evaluate_ball_localization(
                reviewed,
                (),
                DEFAULT_NORMALIZED_TOLERANCE,
                truth_policy="REVIEWED_OR_ADJUDICATED",  # type: ignore[arg-type]
            )

    def test_predictions_must_reference_unique_known_frames_and_candidates(self) -> None:
        truth = (_truth(0),)
        duplicate_id = (
            _prediction("same", 0),
            _prediction("same", 0, center=PixelPoint(101, 201)),
        )
        with self.assertRaisesRegex(ValueError, "duplicate candidate_id"):
            evaluate_ball_localization(truth, duplicate_id, DEFAULT_NORMALIZED_TOLERANCE)
        with self.assertRaisesRegex(ValueError, "unknown truth frame"):
            evaluate_ball_localization(
                truth,
                (_prediction("unknown", 99),),
                DEFAULT_NORMALIZED_TOLERANCE,
            )
        mismatched_identity = replace(
            truth[0].frame.identity,
            decode_contract=_decode_contract(decoder_artifact_sha256="e" * 64),
        )
        with self.assertRaisesRegex(ValueError, "full decoded-frame identity"):
            evaluate_ball_localization(
                truth,
                (
                    _prediction(
                        "wrong-decode",
                        0,
                        frame_identity=mismatched_identity,
                    ),
                ),
                DEFAULT_NORMALIZED_TOLERANCE,
            )
        with self.assertRaisesRegex(ValueError, "unknown truth frame"):
            evaluate_ball_localization(
                truth,
                (_prediction("wrong-stream", 0, selected_video_stream_index=1),),
                DEFAULT_NORMALIZED_TOLERANCE,
            )
        with self.assertRaisesRegex(ValueError, "outside source frame bounds"):
            evaluate_ball_localization(
                truth,
                (_prediction("outside", 0, center=PixelPoint(1920, 20)),),
                DEFAULT_NORMALIZED_TOLERANCE,
            )

    def test_truth_ball_keys_and_annotation_ids_must_be_unique(self) -> None:
        first = _truth(0)
        same_frame = _truth(0, annotation_id="other")
        with self.assertRaisesRegex(ValueError, "unique by source frame"):
            evaluate_ball_localization((first, same_frame), (), DEFAULT_NORMALIZED_TOLERANCE)

        same_id = _truth(1, annotation_id=first.annotation_id)
        with self.assertRaisesRegex(ValueError, "annotation IDs must be unique"):
            evaluate_ball_localization((first, same_id), (), DEFAULT_NORMALIZED_TOLERANCE)

    def test_multiple_ball_instances_do_not_mask_match_ball_failure(self) -> None:
        match_ball = _truth(0, center=PixelPoint(100, 200))
        spare_ball = _truth(
            0,
            annotation_id="spare-ball-0",
            ball_instance_id="spare-1",
            role=BallRole.SPARE_BALL,
            play_state=BallPlayState.NOT_IN_PLAY,
            center=PixelPoint(300, 300),
        )
        prediction = _prediction(
            "spare-only",
            0,
            center=PixelPoint(300, 300),
        )

        report = evaluate_ball_localization(
            (match_ball, spare_ball),
            (prediction,),
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        self.assertEqual(report.truth_annotation_count, 2)
        self.assertEqual(report.truth_frame_count, 1)
        self.assertEqual(report.non_match_ball_annotation_count, 1)
        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (0, 1, 1),
        )
        self.assertEqual(
            dict(report.non_match_role_activation_counts)[BallRole.SPARE_BALL],
            1,
        )
        self.assertFalse(
            report.to_canonical_dict()["claim_scope"]["readiness_claim_permitted"]
        )

    def test_unknown_logical_match_ball_is_diagnostic_and_never_a_primary_tp(self) -> None:
        truth = (
            _truth(
                0,
                role=BallRole.UNKNOWN,
                ambiguity_reason="visible ball role cannot be resolved",
            ),
        )
        prediction = (_prediction("role-unresolved", 0),)

        report = evaluate_ball_localization(
            truth,
            prediction,
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        self.assertEqual(report.evaluated_localizable_frame_count, 0)
        self.assertEqual(report.unresolved_role_frame_count, 1)
        self.assertEqual(report.evaluated_prediction_count, 0)
        self.assertEqual(report.unresolved_role_prediction_count, 1)
        self.assertEqual(report.operating_unresolved_role_prediction_count, 1)
        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (0, 0, 0),
        )
        unknown_slice = dict(
            (item.slice_value, item) for item in report.role_performance_slices
        )[BallRole.UNKNOWN.value]
        self.assertIs(
            unknown_slice.semantics,
            ball_metrics_module.PerformanceSliceSemantics.UNRESOLVED_ROLE_DIAGNOSTIC,
        )
        self.assertEqual(unknown_slice.evaluated_prediction_count, 0)
        self.assertEqual(unknown_slice.ignored_prediction_count, 1)

    def test_non_match_activation_uses_predictions_on_primary_ignored_frames(self) -> None:
        primary = _truth(
            0,
            visibility=BallVisibility.FULLY_OCCLUDED,
            center=None,
            apparent_minor_axis_diameter_px=12.0,
        )
        spare = _truth(
            0,
            annotation_id="spare-on-occluded-primary",
            ball_instance_id="spare-on-ignored-frame",
            role=BallRole.SPARE_BALL,
            play_state=BallPlayState.NOT_IN_PLAY,
            center=PixelPoint(300, 300),
        )
        prediction = (
            _prediction(
                "spare-activation",
                0,
                center=PixelPoint(300, 300),
            ),
        )

        report = evaluate_ball_localization(
            (primary, spare),
            prediction,
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        self.assertEqual(report.evaluated_prediction_count, 0)
        self.assertEqual(report.ignored_nonlocalizable_prediction_count, 1)
        self.assertEqual(
            dict(report.non_match_role_activation_counts)[BallRole.SPARE_BALL],
            1,
        )
        spare_slice = dict(
            (item.slice_value, item) for item in report.role_performance_slices
        )[BallRole.SPARE_BALL.value]
        self.assertEqual(spare_slice.false_positives, 1)
        self.assertEqual(spare_slice.activated_negative_target_count, 1)

    def test_typed_performance_slices_partition_primary_and_disclose_roles(self) -> None:
        match_sharp = _truth(0, center=PixelPoint(100, 200))
        match_blurred = _truth(
            1,
            appearance=BallAppearance.MOTION_BLURRED,
            center=PixelPoint(101, 201),
        )
        negative = _truth(2, visibility=BallVisibility.NOT_PRESENT)
        spare = _truth(
            0,
            annotation_id="spare-slice",
            ball_instance_id="spare-slice-instance",
            role=BallRole.SPARE_BALL,
            play_state=BallPlayState.NOT_IN_PLAY,
            center=PixelPoint(300, 300),
        )
        predictions = (
            _prediction("match-tp", 0, center=PixelPoint(100, 200)),
            _prediction("spare-hard-negative", 0, center=PixelPoint(300, 300)),
            _prediction("empty-frame-fp", 2),
        )

        report = evaluate_ball_localization(
            (match_sharp, match_blurred, negative, spare),
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        appearance = {
            item.slice_value: item for item in report.appearance_performance_slices
        }
        role = {item.slice_value: item for item in report.role_performance_slices}
        play = {
            item.slice_value: item for item in report.play_state_performance_slices
        }

        self.assertEqual(
            (report.true_positives, report.false_positives, report.false_negatives),
            (1, 2, 1),
        )
        self.assertEqual(
            (
                appearance[BallAppearance.SHARP.value].true_positives,
                appearance[BallAppearance.SHARP.value].false_positives,
                appearance[BallAppearance.SHARP.value].false_negatives,
            ),
            (1, 1, 0),
        )
        self.assertEqual(
            appearance[BallAppearance.MOTION_BLURRED.value].false_negatives,
            1,
        )
        self.assertEqual(
            appearance[BallAppearance.NOT_OBSERVABLE.value].false_positives,
            1,
        )
        self.assertEqual(
            role[BallRole.MATCH_BALL.value].matched_center_errors_px,
            report.matched_center_errors_px,
        )
        self.assertEqual(role[BallRole.SPARE_BALL.value].false_positives, 1)
        self.assertEqual(
            play[BallPlayState.IN_PLAY.value].false_negatives,
            1,
        )
        claims = report.to_canonical_dict()["claim_scope"]
        self.assertTrue(claims["appearance_performance_claimed"])
        self.assertTrue(claims["role_performance_claimed"])
        self.assertTrue(claims["play_state_performance_claimed"])
        self.assertFalse(claims["readiness_claim_permitted"])
        with self.assertRaisesRegex(ValueError, "slice precision"):
            replace(
                appearance[BallAppearance.SHARP.value],
                precision=0.0,
            )
        with self.assertRaisesRegex(ValueError, "enum order"):
            replace(
                report,
                appearance_performance_slices=tuple(
                    reversed(report.appearance_performance_slices)
                ),
            )

        def transplanted_evidence(target, source):
            return replace(
                target,
                **{
                    item.name: getattr(source, item.name)
                    for item in fields(target)
                    if item.name not in {"dimension", "slice_value"}
                },
            )

        sharp = appearance[BallAppearance.SHARP.value]
        blurred = appearance[BallAppearance.MOTION_BLURRED.value]
        swapped_appearance = tuple(
            transplanted_evidence(item, blurred)
            if item.slice_value == BallAppearance.SHARP.value
            else transplanted_evidence(item, sharp)
            if item.slice_value == BallAppearance.MOTION_BLURRED.value
            else item
            for item in report.appearance_performance_slices
        )
        with self.assertRaisesRegex(ValueError, "retained evaluation preimages"):
            replace(report, appearance_performance_slices=swapped_appearance)

        absent_role = role[BallRole.ADJACENT_COURT_BALL.value]
        forged_absent_role = replace(
            absent_role,
            operating_prediction_count=1,
            evaluated_prediction_count=1,
            false_positives=1,
        )
        forged_roles = tuple(
            forged_absent_role
            if item.slice_value == BallRole.ADJACENT_COURT_BALL.value
            else item
            for item in report.role_performance_slices
        )
        with self.assertRaisesRegex(ValueError, "retained evaluation preimages"):
            replace(report, role_performance_slices=forged_roles)

        visible_count = dict(report.visibility_counts)[BallVisibility.VISIBLE]
        forged_visibility_counts = tuple(
            (
                visibility,
                0
                if visibility is BallVisibility.VISIBLE
                else count + visible_count
                if visibility is BallVisibility.PARTIALLY_OCCLUDED
                else count,
            )
            for visibility, count in report.visibility_counts
        )
        with self.assertRaisesRegex(ValueError, "retained evaluation preimages"):
            replace(
                report,
                visibility_counts=forged_visibility_counts,
            )

        with self.assertRaisesRegex(ValueError, "requires an evaluated prediction"):
            replace(
                role[BallRole.SPARE_BALL.value],
                operating_prediction_count=0,
                evaluated_prediction_count=0,
                false_positives=0,
            )

    def test_unresolved_role_slice_is_bound_to_retained_prediction_preimage(self) -> None:
        truth = (
            _truth(
                0,
                role=BallRole.UNKNOWN,
                ambiguity_reason="visible ball role cannot be resolved",
            ),
        )
        predictions = (_prediction("unresolved", 0),)
        report = evaluate_ball_localization(
            truth,
            predictions,
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        unknown_slice = next(
            item
            for item in report.role_performance_slices
            if item.slice_value == BallRole.UNKNOWN.value
        )
        forged_unknown_slice = replace(
            unknown_slice,
            operating_prediction_count=0,
            ignored_prediction_count=0,
        )
        forged_roles = tuple(
            forged_unknown_slice
            if item.slice_value == BallRole.UNKNOWN.value
            else item
            for item in report.role_performance_slices
        )
        with self.assertRaisesRegex(ValueError, "retained evaluation preimages"):
            replace(report, role_performance_slices=forged_roles)

        def move_visible_count(values):
            visible_count = dict(values)[BallVisibility.VISIBLE]
            return tuple(
                (
                    visibility,
                    0
                    if visibility is BallVisibility.VISIBLE
                    else count + visible_count
                    if visibility is BallVisibility.PARTIALLY_OCCLUDED
                    else count,
                )
                for visibility, count in values
            )

        with self.assertRaisesRegex(ValueError, "retained evaluation preimages"):
            replace(
                report,
                visibility_counts=move_visible_count(report.visibility_counts),
                unresolved_role_visibility_counts=move_visible_count(
                    report.unresolved_role_visibility_counts
                ),
            )

    def test_prediction_and_evaluator_inputs_fail_closed(self) -> None:
        valid = _prediction("valid", 0)
        invalid_predictions = (
            {"confidence": True},
            {"confidence": float("nan")},
            {"confidence": -0.1},
            {"confidence": 1.1},
            {"candidate_id": " "},
            {"candidate_id": "cándidate"},
            {"candidate_id": "bad\ud800id"},
            {"candidate_id": "a" * 129},
            {"frame_identity": {"frame_index": 0}},
            {"center": {"x": 1, "y": 2}},
        )
        for overrides in invalid_predictions:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                replace(valid, **overrides)
        self.assertEqual(
            replace(valid, candidate_id="a" * 128).candidate_id,
            "a" * 128,
        )

        truth = (_truth(0),)
        for tolerance in (0, -1, True, float("nan"), float("inf")):
            with self.subTest(tolerance=tolerance), self.assertRaisesRegex(
                ValueError, "finite positive"
            ):
                evaluate_ball_localization(truth, (), tolerance)
        for threshold in (-0.1, 1.1, True, float("nan"), float("inf"), "0.5"):
            with self.subTest(threshold=threshold), self.assertRaisesRegex(
                ValueError,
                "finite probability",
            ):
                evaluate_ball_localization(
                    truth,
                    (),
                    DEFAULT_NORMALIZED_TOLERANCE,
                    operating_confidence_threshold=threshold,  # type: ignore[arg-type]
                )
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            evaluate_ball_localization(list(truth), (), DEFAULT_NORMALIZED_TOLERANCE)
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            evaluate_ball_localization(truth, [], DEFAULT_NORMALIZED_TOLERANCE)

    def test_fixed_global_and_per_frame_input_bounds_fail_closed(self) -> None:
        direct_arguments = {
            "normalized_tolerance_ball_diameters": DEFAULT_NORMALIZED_TOLERANCE,
            "operating_confidence_threshold": 0.0,
            "evaluation_manifest": None,
            "annotation_attestations": (),
            "annotation_trust_store": None,
            "annotation_evidence_store_root": Path("unused"),
            "annotation_protected_configuration_generation_path": Path("unused"),
            "annotation_verification_policy": None,
            "expected_annotation_verification_policy_sha256": "0" * 64,
        }
        truth = (_truth(0), _truth(1))
        direct_arguments["evaluation_manifest"] = _unit_evaluation_manifest(truth)
        predictions = (
            _prediction("candidate-0", 0),
            _prediction("candidate-1", 1),
        )
        with patch.object(ball_metrics_module, "_MAX_TRUTH_ANNOTATION_COUNT", 1):
            with self.assertRaisesRegex(ValueError, "truth cannot exceed 1"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    **direct_arguments,  # type: ignore[arg-type]
                )
        with patch.object(ball_metrics_module, "_MAX_PREDICTION_COUNT", 1):
            with self.assertRaisesRegex(
                ValueError,
                "predictions cannot exceed 1",
            ):
                _evaluate_ball_localization(
                    (truth[0],),
                    predictions,
                    **direct_arguments,  # type: ignore[arg-type]
                )

        same_frame_predictions = (
            _prediction("candidate-a", 0),
            _prediction("candidate-b", 0),
        )
        with patch.object(ball_metrics_module, "_MAX_PREDICTIONS_PER_FRAME", 2):
            report = evaluate_ball_localization(
                (truth[0],),
                same_frame_predictions,
                DEFAULT_NORMALIZED_TOLERANCE,
            )
            self.assertEqual(report.prediction_count, 2)
        with patch.object(ball_metrics_module, "_MAX_PREDICTIONS_PER_FRAME", 1):
            with self.assertRaisesRegex(ValueError, "1 candidates per frame"):
                evaluate_ball_localization(
                    (truth[0],),
                    same_frame_predictions,
                    DEFAULT_NORMALIZED_TOLERANCE,
                )

    def test_no_predictions_report_zero_metrics_and_null_errors(self) -> None:
        report = evaluate_ball_localization((_truth(0),), (), DEFAULT_NORMALIZED_TOLERANCE)

        self.assertEqual((report.precision, report.recall, report.f1), (0.0, 0.0, 0.0))
        self.assertEqual(report.average_precision_101, 0.0)
        self.assertIsNone(report.matched_center_error_mean_px)
        self.assertIsNone(report.matched_center_error_p50_px)
        self.assertIsNone(report.matched_center_error_p95_px)
        self.assertIsNone(report.matched_center_error_max_px)
        self.assertIsNone(report.matched_center_error_normalized_mean)
        self.assertIsNone(report.matched_center_error_normalized_p50)
        self.assertIsNone(report.matched_center_error_normalized_p95)
        self.assertIsNone(report.matched_center_error_normalized_max)
        self.assertEqual(report.confidence_ranking_points, ())
        self.assertEqual(report.matched_center_errors_px, ())
        self.assertEqual(report.matched_center_errors_normalized, ())
        self.assertRegex(report.annotation_trust_store_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(
            report.annotation_attestation_set_sha256,
            r"^[0-9a-f]{64}$",
        )
        self.assertRegex(report.annotation_evidence_set_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(
            report.annotation_evidence_generation_id,
            r"^[0-9a-f]{64}$",
        )
        self.assertEqual(
            report.annotation_evidence_generation_id,
            generation_id_for(
                tuple(
                    reference.removeprefix("sha256:")
                    for reference in report.annotation_evidence_refs
                )
            ),
        )
        self.assertEqual(
            report.protected_configuration_generation_sha256,
            report.protected_configuration_generation.fingerprint(),
        )
        self.assertEqual(
            report.governance_domain_id,
            report.protected_configuration_generation.governance_domain_id,
        )
        self.assertRegex(report.evaluator_artifact_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(report.truth_set_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(report.prediction_set_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(report.verified_at_utc, r"^\d{4}-\d{2}-\d{2}T.*Z$")
        self.assertEqual(
            report.evaluation_manifest_sha256,
            report.evaluation_manifest.fingerprint(),
        )
        self.assertFalse(report.evaluation_manifest.readiness_claim_permitted)

    def test_annotation_payload_review_state_cannot_bypass_missing_trust_args(self) -> None:
        truth = (_truth(0),)
        prediction = (_prediction("candidate", 0),)
        missing_arguments = (
            {},
            {"annotation_attestations": ()},
            {
                "annotation_attestations": (),
                "annotation_trust_store": _annotation_trust_store(truth),
            },
        )
        for arguments in missing_arguments:
            with self.subTest(arguments=arguments), self.assertRaisesRegex(
                TypeError,
                "required keyword-only",
            ):
                _evaluate_ball_localization(
                    truth,
                    prediction,
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    **arguments,
                )

    def test_direct_evaluator_rejects_policy_pin_artifact_and_weaker_truth(self) -> None:
        truth = (_truth(0, review_state=ReviewState.REVIEWED),)
        store = _annotation_trust_store(truth)
        attestations = _annotation_attestations(truth)
        policy = _annotation_verification_policy(store)
        protected_pin = policy.fingerprint()
        with tempfile.TemporaryDirectory() as directory:
            evidence_store_root, _ = _publish_annotation_evidence_store(
                directory,
                truth,
            )
            protected_configuration_path, _ = (
                _write_protected_annotation_configuration_generation(
                    directory,
                    store,
                    policy,
                )
            )
            common = {
                "operating_confidence_threshold": 0.0,
                "truth_policy": TruthPolicy.REVIEWED_OR_ADJUDICATED,
                "evaluation_manifest": _unit_evaluation_manifest(truth),
                "annotation_attestations": attestations,
                "annotation_trust_store": store,
                "annotation_evidence_store_root": evidence_store_root,
                "annotation_protected_configuration_generation_path": (
                    protected_configuration_path
                ),
            }
            with self.assertRaisesRegex(
                ValueError,
                "annotation_protected_configuration_generation_path must be",
            ):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=policy,
                    expected_annotation_verification_policy_sha256=protected_pin,
                    **(
                        common
                        | {
                            "annotation_protected_configuration_generation_path": (
                                "not-a-path"
                            ),
                        }
                    ),
                )
            with self.assertRaisesRegex(
                TypeError,
                "normalized_tolerance_ball_diameters",
            ):
                _evaluate_ball_localization(
                    truth,
                    (),
                    annotation_verification_policy=policy,
                    expected_annotation_verification_policy_sha256=protected_pin,
                    **common,
                )
            without_threshold = dict(common)
            del without_threshold["operating_confidence_threshold"]
            with self.assertRaisesRegex(
                TypeError,
                "operating_confidence_threshold",
            ):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=policy,
                    expected_annotation_verification_policy_sha256=protected_pin,
                    **without_threshold,
                )
            with self.assertRaisesRegex(ValueError, "pinned fingerprint"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=policy,
                    expected_annotation_verification_policy_sha256="0" * 64,
                    **common,
                )

            substituted_policy = replace(policy, valid_until="2098-12-31")
            with self.assertRaisesRegex(ValueError, "pinned fingerprint"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=substituted_policy,
                    expected_annotation_verification_policy_sha256=protected_pin,
                    **common,
                )

            wrong_artifact_policy = _annotation_verification_policy(
                store,
                evaluator_artifact_sha256="0" * 64,
            )
            wrong_artifact_configuration_path, _ = (
                _write_protected_annotation_configuration_generation(
                    directory,
                    store,
                    wrong_artifact_policy,
                    filename="wrong-artifact-configuration.json",
                )
            )
            with self.assertRaisesRegex(ValueError, "evaluator artifact"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=wrong_artifact_policy,
                    expected_annotation_verification_policy_sha256=(
                        wrong_artifact_policy.fingerprint()
                    ),
                    **(
                        common
                        | {
                            "annotation_protected_configuration_generation_path": (
                                wrong_artifact_configuration_path
                            ),
                        }
                    ),
                )

            strict_policy = _annotation_verification_policy(
                store,
                minimum_truth_policy=AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY,
            )
            strict_configuration_path, _ = (
                _write_protected_annotation_configuration_generation(
                    directory,
                    store,
                    strict_policy,
                    filename="strict-configuration.json",
                )
            )
            with self.assertRaisesRegex(ValueError, "weaker"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    annotation_verification_policy=strict_policy,
                    expected_annotation_verification_policy_sha256=(
                        strict_policy.fingerprint()
                    ),
                    **(
                        common
                        | {
                            "annotation_protected_configuration_generation_path": (
                                strict_configuration_path
                            ),
                        }
                    ),
                )

    def test_report_and_evaluation_input_bind_exact_annotation_trust(self) -> None:
        truth = (_truth(0),)
        attestations = _annotation_attestations(truth)
        store = _annotation_trust_store(truth)
        policy = _annotation_verification_policy(store)
        changed_store = replace(
            store,
            keys=store.keys
            + (
                TrustedAnnotationKey(
                    key_id="unused-review-key",
                    principal_id="unused-reviewer",
                    permitted_roles=(AnnotationAttestationRole.REVIEWER,),
                    public_key_base64=_public_key_base64(UNUSED_PRIVATE_KEY),
                    valid_from="2026-01-01",
                    valid_until="2026-12-31",
                    compromised_on=None,
                ),
            ),
        )
        changed_policy = _annotation_verification_policy(changed_store)
        with tempfile.TemporaryDirectory() as directory:
            evidence_store_root, evidence_descriptor = (
                _publish_annotation_evidence_store(directory, truth)
            )
            protected_configuration_path, protected_configuration = (
                _write_protected_annotation_configuration_generation(
                    directory,
                    store,
                    policy,
                )
            )
            changed_protected_configuration_path, changed_protected_configuration = (
                _write_protected_annotation_configuration_generation(
                    directory,
                    changed_store,
                    changed_policy,
                    filename="changed-launcher-configuration.json",
                )
            )
            report = _evaluate_ball_localization(
                truth,
                (),
                normalized_tolerance_ball_diameters=(
                    DEFAULT_NORMALIZED_TOLERANCE
                ),
                operating_confidence_threshold=0.0,
                evaluation_manifest=_unit_evaluation_manifest(truth),
                annotation_attestations=attestations,
                annotation_trust_store=store,
                annotation_evidence_store_root=evidence_store_root,
                annotation_protected_configuration_generation_path=(
                    protected_configuration_path
                ),
                annotation_verification_policy=policy,
                expected_annotation_verification_policy_sha256=policy.fingerprint(),
            )
            with self.assertRaisesRegex(ValueError, "trust store"):
                _evaluate_ball_localization(
                    truth,
                    (),
                    normalized_tolerance_ball_diameters=(
                        DEFAULT_NORMALIZED_TOLERANCE
                    ),
                    operating_confidence_threshold=0.0,
                    evaluation_manifest=_unit_evaluation_manifest(truth),
                    annotation_attestations=attestations,
                    annotation_trust_store=changed_store,
                    annotation_evidence_store_root=evidence_store_root,
                    annotation_protected_configuration_generation_path=(
                        protected_configuration_path
                    ),
                    annotation_verification_policy=policy,
                    expected_annotation_verification_policy_sha256=policy.fingerprint(),
                )
            changed_store_report = _evaluate_ball_localization(
                truth,
                (),
                normalized_tolerance_ball_diameters=(
                    DEFAULT_NORMALIZED_TOLERANCE
                ),
                operating_confidence_threshold=0.0,
                evaluation_manifest=_unit_evaluation_manifest(truth),
                annotation_attestations=attestations,
                annotation_trust_store=changed_store,
                annotation_evidence_store_root=evidence_store_root,
                annotation_protected_configuration_generation_path=(
                    changed_protected_configuration_path
                ),
                annotation_verification_policy=changed_policy,
                expected_annotation_verification_policy_sha256=(
                    changed_policy.fingerprint()
                ),
            )

        self.assertEqual(report.annotation_trust_store_sha256, store.fingerprint())
        self.assertEqual(
            report.annotation_attestation_set_sha256,
            annotation_attestation_set_fingerprint(attestations),
        )
        self.assertEqual(
            report.annotation_verification_policy_sha256,
            policy.fingerprint(),
        )
        self.assertEqual(
            report.annotation_evidence_generation_id,
            evidence_descriptor.generation_id,
        )
        self.assertEqual(
            report.protected_configuration_generation,
            protected_configuration,
        )
        self.assertEqual(
            report.protected_configuration_generation_sha256,
            protected_configuration.fingerprint(),
        )
        self.assertEqual(report.governance_domain_id, store.keyring_id)
        self.assertEqual(
            changed_store_report.annotation_trust_store_sha256,
            changed_store.fingerprint(),
        )
        self.assertEqual(
            changed_store_report.protected_configuration_generation,
            changed_protected_configuration,
        )
        self.assertNotEqual(
            report.evaluation_input_sha256,
            changed_store_report.evaluation_input_sha256,
        )

    def test_evaluation_input_commitment_binds_evidence_generation(self) -> None:
        report = evaluate_ball_localization(
            (_truth(0),),
            (),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        commitments = {
            "truth_set_sha256": report.truth_set_sha256,
            "prediction_set_sha256": report.prediction_set_sha256,
            "truth_annotation_count": report.truth_annotation_count,
            "truth_frame_count": report.truth_frame_count,
            "prediction_count": report.prediction_count,
            "normalized_tolerance_ball_diameters": (
                report.normalized_tolerance_ball_diameters
            ),
            "operating_confidence_threshold": (
                report.operating_confidence_threshold
            ),
            "truth_policy": report.truth_policy,
            "evaluation_manifest": report.evaluation_manifest,
            "annotation_verification_policy": (
                report.annotation_verification_policy
            ),
            "annotation_verification_policy_sha256": (
                report.annotation_verification_policy_sha256
            ),
            "annotation_trust_store_sha256": (
                report.annotation_trust_store_sha256
            ),
            "annotation_attestation_set_sha256": (
                report.annotation_attestation_set_sha256
            ),
            "annotation_evidence_set_sha256": (
                report.annotation_evidence_set_sha256
            ),
            "annotation_evidence_generation_id": (
                report.annotation_evidence_generation_id
            ),
            "annotation_evidence_refs": report.annotation_evidence_refs,
            "protected_configuration_generation": (
                report.protected_configuration_generation
            ),
            "protected_configuration_generation_sha256": (
                report.protected_configuration_generation_sha256
            ),
            "governance_domain_id": report.governance_domain_id,
            "evaluator_artifact_sha256": report.evaluator_artifact_sha256,
            "verified_at_utc": report.verified_at_utc,
        }
        self.assertEqual(
            ball_metrics_module._evaluation_input_sha256_from_commitments(
                **commitments,
            ),
            report.evaluation_input_sha256,
        )
        changed_generation = generation_id_for(("0" * 64,))
        self.assertNotEqual(
            ball_metrics_module._evaluation_input_sha256_from_commitments(
                **(
                    commitments
                    | {
                        "annotation_evidence_generation_id": changed_generation,
                    }
                ),
            ),
            report.evaluation_input_sha256,
        )
        changed_protected_configuration = replace(
            report.protected_configuration_generation,
            governance_domain_id="another-governance-domain",
        )
        changed_protected_commitments = commitments | {
            "protected_configuration_generation": changed_protected_configuration,
            "protected_configuration_generation_sha256": (
                changed_protected_configuration.fingerprint()
            ),
            "governance_domain_id": "another-governance-domain",
        }
        self.assertNotEqual(
            ball_metrics_module._evaluation_input_sha256_from_commitments(
                **changed_protected_commitments,
            ),
            report.evaluation_input_sha256,
        )

        forged_ontology = "d" * 64
        forged_manifest = replace(
            report.evaluation_manifest,
            ontology_sha256=forged_ontology,
            coverage_proof=replace(
                report.evaluation_manifest.coverage_proof,
                ontology_sha256=forged_ontology,
            ),
        )
        forged_manifest_commitments = commitments | {
            "evaluation_manifest": forged_manifest,
        }
        with self.assertRaisesRegex(
            ValueError,
            "manifest does not match retained truth preimage",
        ):
            replace(
                report,
                evaluation_manifest=forged_manifest,
                evaluation_manifest_sha256=forged_manifest.fingerprint(),
                evaluation_input_sha256=(
                    ball_metrics_module._evaluation_input_sha256_from_commitments(
                        **forged_manifest_commitments,
                    )
                ),
            )

    def test_report_constructor_rejects_forged_derived_metrics_and_errors(self) -> None:
        report = evaluate_ball_localization(
            (_truth(0),),
            (_prediction("candidate", 0, center=PixelPoint(101, 200)),),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        forged_protected_configuration = replace(
            report.protected_configuration_generation,
            evaluator_artifact_sha256="0" * 64,
        )
        for overrides in (
            {"precision": 0.0},
            {"recall": 0.0},
            {"f1": 0.0},
            {"average_precision_101": 0.0},
            {"operating_confidence_threshold": 0.5},
            {"operating_confidence_threshold": -0.1},
            {"normalized_tolerance_ball_diameters": 0.0},
            {"normalized_tolerance_ball_diameters": 0.5},
            {"operating_prediction_count": 0},
            {"full_ranking_true_positive_count": 0},
            {"truth_annotation_count": 2},
            {"truth_frame_count": 2},
            {"non_match_ball_annotation_count": 1},
            {"evaluated_nonlocalizable_frame_count": 1},
            {"ignored_nonlocalizable_prediction_count": 1},
            {"confident_negative_frame_activation_count": 1},
            {"confident_negative_frame_activation_rate": 0.5},
            {"activated_confident_negative_frame_identities": (_truth(0).frame.identity,)},
            {"matched_center_errors_px": (999.0,)},
            {"matched_apparent_minor_axis_diameters_px": (6.0,)},
            {"matched_center_errors_normalized": (999.0,)},
            {"matched_center_error_mean_px": 999.0},
            {"matched_center_error_normalized_mean": 999.0},
            {
                "appearance_counts": (
                    (BallAppearance.SHARP, 0),
                    (BallAppearance.MOTION_BLURRED, 0),
                    (BallAppearance.NOT_OBSERVABLE, 1),
                )
            },
            {
                "nonlocalizable_visibility_activation_counts": (
                    (BallVisibility.FULLY_OCCLUDED, 1),
                    (BallVisibility.OUT_OF_FRAME, 0),
                    (BallVisibility.INDISTINGUISHABLE, 0),
                    (BallVisibility.CAPTURE_UNKNOWN, 0),
                )
            },
            {
                "non_match_role_activation_counts": tuple(
                    (
                        role,
                        1 if role is BallRole.SPARE_BALL else 0,
                    )
                    for role in BallRole
                )
            },
            {
                "evaluation_manifest": replace(
                    report.evaluation_manifest,
                    manifest_id="forged-unit-benchmark",
                )
            },
            {"evaluation_manifest_sha256": "A" * 64},
            {"evaluation_manifest_sha256": "0" * 64},
            {"annotation_verification_policy_sha256": "A" * 64},
            {"annotation_trust_store_sha256": "A" * 64},
            {"annotation_attestation_set_sha256": "A" * 64},
            {"annotation_attestation_set_sha256": "0" * 64},
            {"annotation_evidence_set_sha256": "A" * 64},
            {"annotation_evidence_generation_id": "A" * 64},
            {"annotation_evidence_generation_id": "0" * 64},
            {"annotation_evidence_refs": ()},
            {"protected_configuration_generation": None},
            {"protected_configuration_generation_sha256": "A" * 64},
            {"protected_configuration_generation_sha256": "0" * 64},
            {
                "protected_configuration_generation": (
                    forged_protected_configuration
                ),
                "protected_configuration_generation_sha256": (
                    forged_protected_configuration.fingerprint()
                ),
            },
            {"governance_domain_id": " "},
            {"governance_domain_id": "another-governance-domain"},
            {"evaluator_artifact_sha256": "A" * 64},
            {"truth_set_sha256": "0" * 64},
            {"prediction_set_sha256": "0" * 64},
            {"evaluation_input_sha256": "0" * 64},
            {"verified_at_utc": "2026-02-30T00:00:00.000000Z"},
            {"verified_at_utc": "2019-01-01T00:00:00.000000Z"},
            {"verified_at_utc": "2025-01-01T00:00:00.000000Z"},
            {
                "confidence_ranking_points": (
                    ConfidenceRankingPoint(
                        confidence_threshold=0.9,
                        cumulative_prediction_count=1,
                        cumulative_true_positive_count=0,
                    ),
                )
            },
        ):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                replace(report, **overrides)

    def test_report_count_pairs_and_slice_collections_are_deeply_immutable(self) -> None:
        class TupleSubclass(tuple):
            pass

        report = evaluate_ball_localization(
            (_truth(0),),
            (_prediction("candidate", 0),),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        mutable_pair_counts = (
            [*report.visibility_counts[0]],
            *report.visibility_counts[1:],
        )
        with self.assertRaisesRegex(ValueError, "exact two-item"):
            replace(report, visibility_counts=mutable_pair_counts)
        subclass_pair_counts = (
            TupleSubclass(report.role_counts[0]),
            *report.role_counts[1:],
        )
        with self.assertRaisesRegex(ValueError, "exact two-item"):
            replace(report, role_counts=subclass_pair_counts)
        with self.assertRaisesRegex(ValueError, "exact built-in tuple"):
            replace(
                report,
                non_match_role_counts=TupleSubclass(
                    report.non_match_role_counts
                ),
            )
        with self.assertRaisesRegex(ValueError, "exact tuple of performance"):
            replace(
                report,
                appearance_performance_slices=TupleSubclass(
                    report.appearance_performance_slices
                ),
            )

    def test_percentiles_use_documented_linear_interpolation(self) -> None:
        truth = tuple(_truth(index) for index in range(3))
        predictions = (
            _prediction("candidate-0", 0),
            _prediction("candidate-1", 1, center=PixelPoint(104, 201)),
            _prediction("candidate-2", 2, center=PixelPoint(108, 202)),
        )

        report = evaluate_ball_localization(truth, predictions, 10.0 / 12.0)

        self.assertEqual(report.matched_center_error_mean_px, 3.0)
        self.assertEqual(report.matched_center_error_p50_px, 3.0)
        self.assertAlmostEqual(report.matched_center_error_p95_px, 5.7)
        self.assertEqual(report.matched_center_error_max_px, 6.0)
        self.assertEqual(report.matched_center_error_normalized_mean, 0.25)
        self.assertEqual(report.matched_center_error_normalized_p50, 0.25)
        self.assertAlmostEqual(report.matched_center_error_normalized_p95, 0.475)
        self.assertEqual(report.matched_center_error_normalized_max, 0.5)

    def test_canonical_report_and_fingerprint_are_order_independent(self) -> None:
        truth = (_truth(0), _truth(1, visibility=BallVisibility.NOT_PRESENT))
        predictions = (
            _prediction("a", 0, confidence=0.8),
            _prediction("b", 1, confidence=0.2),
        )

        first = evaluate_ball_localization(truth, predictions, DEFAULT_NORMALIZED_TOLERANCE)
        reordered = evaluate_ball_localization(
            tuple(reversed(truth)),
            tuple(reversed(predictions)),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        renamed = evaluate_ball_localization(
            truth,
            (replace(predictions[0], candidate_id="renamed"), predictions[1]),
            DEFAULT_NORMALIZED_TOLERANCE,
        )

        normalized_reordered = replace(
            reordered,
            verified_at_utc=first.verified_at_utc,
            evaluation_input_sha256=first.evaluation_input_sha256,
        )
        self.assertEqual(first.canonical_json(), normalized_reordered.canonical_json())
        self.assertEqual(first.fingerprint(), normalized_reordered.fingerprint())
        self.assertNotEqual(first.fingerprint(), renamed.fingerprint())
        self.assertRegex(first.fingerprint(), r"^[0-9a-f]{64}$")
        payload = json.loads(first.canonical_json())
        self.assertEqual(payload["schema_version"], "7.0")
        self.assertEqual(
            payload["metric"],
            "MATCH_BALL_CENTER_LOCALIZATION_V2",
        )
        self.assertEqual(payload["annotation_schema_version"], "2.0")
        self.assertEqual(
            payload["annotation_trust"]["evaluation_manifest_sha256"],
            first.evaluation_manifest.fingerprint(),
        )
        self.assertFalse(payload["claim_scope"]["readiness_claim_permitted"])
        self.assertEqual(
            payload["annotation_trust"]["evaluator_artifact_sha256"],
            ball_localization_evaluator_artifact_sha256(),
        )
        self.assertRegex(
            payload["annotation_trust"]["verified_at_utc"],
            r"^\d{4}-\d{2}-\d{2}T.*Z$",
        )
        self.assertEqual(
            payload["annotation_trust"]["evidence_generation_id"],
            first.annotation_evidence_generation_id,
        )
        self.assertEqual(
            payload["annotation_trust"]["protected_configuration_generation"],
            first.protected_configuration_generation.to_canonical_dict(),
        )
        self.assertEqual(
            payload["annotation_trust"][
                "protected_configuration_generation_sha256"
            ],
            first.protected_configuration_generation_sha256,
        )
        self.assertEqual(
            payload["annotation_trust"]["governance_domain_id"],
            first.governance_domain_id,
        )
        self.assertEqual(
            payload["input_commitments"],
            {
                "prediction_set_sha256": first.prediction_set_sha256,
                "truth_set_sha256": first.truth_set_sha256,
            },
        )
        self.assertTrue(payload["localization_metrics_defined"])
        self.assertEqual(
            payload["normalized_tolerance_ball_diameters"],
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        self.assertNotIn("pixel_tolerance", payload)
        self.assertEqual(payload["operating_point"]["confidence_threshold"], 0.0)
        self.assertEqual(
            payload["center_error_normalized_by_apparent_minor_axis"][
                "matched_values"
            ],
            list(first.matched_center_errors_normalized),
        )
        self.assertTrue(math.isfinite(payload["metrics"]["average_precision_101"]))

    def test_prediction_and_report_are_frozen_and_slotted(self) -> None:
        prediction = _prediction("candidate", 0)
        report = evaluate_ball_localization(
            (_truth(0),),
            (prediction,),
            DEFAULT_NORMALIZED_TOLERANCE,
        )
        self.assertFalse(hasattr(prediction, "__dict__"))
        self.assertFalse(hasattr(report, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            prediction.confidence = 0.1
        with self.assertRaises(FrozenInstanceError):
            report.precision = 0.5


if __name__ == "__main__":
    unittest.main()
