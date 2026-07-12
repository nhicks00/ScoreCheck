from __future__ import annotations

import base64
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

if __package__:
    from .test_annotation_trust import (
        EVALUATOR_ARTIFACT_SHA256,
        ADJUDICATION_REF,
        REVIEW_REF,
        _annotation,
        _attestations,
        _evidence_store_root,
        _frame,
        _policy,
        _protected_configuration_generation,
        _store,
    )
else:
    from test_annotation_trust import (  # type: ignore[no-redef]
        EVALUATOR_ARTIFACT_SHA256,
        ADJUDICATION_REF,
        REVIEW_REF,
        _annotation,
        _attestations,
        _evidence_store_root,
        _frame,
        _policy,
        _protected_configuration_generation,
        _store,
    )
from vision_scoring.annotation_trust import (
    AnnotationMinimumTruthPolicy,
    annotation_evidence_set_fingerprint,
)
from vision_scoring.annotations import (
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    CaptureUnavailabilityReason,
    PixelPoint,
    PixelRegion,
    SearchRegionObservabilityAttestation,
    SearchRegionScope,
    SearchRegionVisibility,
    TimestampBasis,
    UnavailableFrameReference,
)
from vision_scoring.label_bundle import (
    CausalBallLabelBundleAttestationV1,
    CausalBallLabelBundleTrustSnapshotV1,
    CausalBallLabelBundleV1,
    CurrentCausalBallLabelBundleV1,
    LabelBundleCuratorKeyRole,
    LabelBundleError,
    LabelBundleSplit,
    MatchBallFrameStatus,
    TrustedLabelBundleCuratorKeyV1,
    build_causal_ball_label_bundle_v1,
    causal_ball_label_bundle_signing_message,
    verify_causal_ball_label_bundle_v1,
)
from vision_scoring.immutable_store import generation_id_for


CURATOR_KEY = Ed25519PrivateKey.from_private_bytes(b"\x81" * 32)
OLD_CURATOR_KEY = Ed25519PrivateKey.from_private_bytes(b"\x82" * 32)
SOURCE = "a" * 64
ONTOLOGY = "b" * 64
TRACE = "c" * 64
CAPTURE_POLICY = "d" * 64
CAPTURE_REF = "sha256:" + "9" * 64
GAP_REF = "sha256:" + "8" * 64
PROTECTED_VERIFIED_AT_NS = 1_783_814_400_000_000_000
NANOSECONDS_PER_DAY = 86_400_000_000_000
CURATOR_SIGNED_AT_NS = PROTECTED_VERIFIED_AT_NS - 100


def _public_base64(key: Ed25519PrivateKey) -> str:
    return base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii")


def _ball(
    frame_index: int,
    *,
    annotation_id: str | None = None,
    ball_instance_id: str = "match-ball",
    role: BallRole = BallRole.MATCH_BALL,
    visibility: BallVisibility = BallVisibility.VISIBLE,
) -> BallFrameAnnotationV2:
    base_frame = _frame()
    frame = replace(
        base_frame,
        identity=replace(
            base_frame.identity,
            source_sha256=SOURCE,
            frame_index=frame_index,
            timestamp_ns=100 + 10 * frame_index,
            decoded_frame_sha256=f"{frame_index + 1:064x}",
        ),
    )
    values: dict[str, object] = {
        "annotation_id": annotation_id or f"ball-{frame_index}",
        "frame": frame,
    }
    annotation = _annotation(**values)  # type: ignore[arg-type]
    if (
        ball_instance_id == "match-ball"
        and role is BallRole.MATCH_BALL
        and visibility is BallVisibility.VISIBLE
    ):
        return annotation
    replacements: dict[str, object] = {
        "ball_instance_id": ball_instance_id,
        "role": role,
        "visibility": visibility,
    }
    if visibility is BallVisibility.INDISTINGUISHABLE:
        replacements.update(
            {
                "appearance": BallAppearance.NOT_OBSERVABLE,
                "play_state": BallPlayState.UNKNOWN,
                "center": None,
                "apparent_minor_axis_diameter_px": None,
                "track_segment_id": None,
                "ambiguity_reason": "ball role cannot be distinguished",
            }
        )
    return replace(annotation, **replacements)


def _bundle(
    *,
    split: LabelBundleSplit = LabelBundleSplit.TRAIN,
    all_balls: bool = False,
    indistinguishable_match: bool = False,
) -> tuple[CausalBallLabelBundleV1, tuple[BallFrameAnnotationV2, ...], tuple[object, ...]]:
    match0 = _ball(
        0,
        role=(BallRole.UNKNOWN if indistinguishable_match else BallRole.MATCH_BALL),
        visibility=(
            BallVisibility.INDISTINGUISHABLE
            if indistinguishable_match
            else BallVisibility.VISIBLE
        ),
    )
    annotations: list[BallFrameAnnotationV2] = [match0]
    if all_balls:
        spare = _ball(
            0,
            annotation_id="spare-0",
            ball_instance_id="spare-ball-1",
            role=BallRole.SPARE_BALL,
        )
        annotations.extend((spare, _ball(1)))
    attestations = tuple(
        attestation
        for annotation in annotations
        for attestation in _attestations(annotation)
    )
    statement = build_causal_ball_label_bundle_v1(
        bundle_id="bundle-1",
        source_asset_sha256=SOURCE,
        finalized_trace_sha256=TRACE,
        capture_policy_sha256=CAPTURE_POLICY,
        capture_policy_generation=3,
        split=split,
        ontology_sha256=ONTOLOGY,
        ontology_version="ball-ontology-v2",
        match_ball_instance_id="match-ball",
        annotations=tuple(annotations),
        attestations=attestations,  # type: ignore[arg-type]
        annotation_trust_store_sha256="e" * 64,
        annotation_verification_policy_sha256="f" * 64,
    )
    return statement, tuple(annotations), attestations


def _match_with_visibility(visibility: BallVisibility) -> BallFrameAnnotationV2:
    annotation = _ball(0)
    if visibility is BallVisibility.VISIBLE:
        return annotation
    if visibility in {
        BallVisibility.FULLY_OCCLUDED,
        BallVisibility.OUT_OF_FRAME,
    }:
        return replace(
            annotation,
            visibility=visibility,
            appearance=BallAppearance.NOT_OBSERVABLE,
            center=None,
            apparent_minor_axis_diameter_px=None,
        )
    if visibility is BallVisibility.INDISTINGUISHABLE:
        return replace(
            annotation,
            visibility=visibility,
            appearance=BallAppearance.NOT_OBSERVABLE,
            role=BallRole.UNKNOWN,
            play_state=BallPlayState.UNKNOWN,
            center=None,
            apparent_minor_axis_diameter_px=None,
            track_segment_id=None,
            ambiguity_reason="match-ball role is visually indistinguishable",
        )
    if visibility is BallVisibility.NOT_PRESENT:
        frame = annotation.frame
        assert hasattr(frame, "identity")
        search = SearchRegionObservabilityAttestation(
            source_sha256=frame.source_sha256,
            selected_video_stream_index=frame.selected_video_stream_index,
            frame_index=frame.frame_index,
            decoded_frame_sha256=frame.decoded_frame_sha256,
            frame_identity_sha256=frame.identity.fingerprint(),
            target_role=BallRole.MATCH_BALL,
            region_scope=SearchRegionScope.FULL_DECODED_FRAME,
            searched_region=PixelRegion(0, 0, frame.width - 1, frame.height - 1),
            region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
            capture_integrity_attestation_refs=(CAPTURE_REF,),
            reviewer_ids=annotation.reviewer_ids,
            review_evidence_refs=annotation.review_evidence_refs,
        )
        return replace(
            annotation,
            visibility=visibility,
            appearance=BallAppearance.NOT_OBSERVABLE,
            play_state=BallPlayState.NOT_APPLICABLE,
            center=None,
            apparent_minor_axis_diameter_px=None,
            track_segment_id=None,
            search_region_observability_attestation=search,
        )
    raise AssertionError("unsupported test visibility")


def _capture_unknown_annotation() -> BallFrameAnnotationV2:
    annotation = _ball(0)
    unavailable = UnavailableFrameReference(
        source_sha256=SOURCE,
        selected_video_stream_index=0,
        frame_index=0,
        expected_interval_start_ns=100,
        expected_interval_end_ns=101,
        timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
        capture_segment_ref=CAPTURE_REF,
        unavailability_reason=CaptureUnavailabilityReason.DECODE_FAILED,
        capture_integrity_attestation_refs=(CAPTURE_REF,),
        gap_evidence_refs=(GAP_REF,),
    )
    return replace(
        annotation,
        frame=unavailable,
        visibility=BallVisibility.CAPTURE_UNKNOWN,
        appearance=BallAppearance.NOT_OBSERVABLE,
        play_state=BallPlayState.UNKNOWN,
        center=None,
        apparent_minor_axis_diameter_px=None,
        track_segment_id=None,
        ambiguity_reason="decoded frame unavailable",
    )


def _attest_bundle(
    statement: CausalBallLabelBundleV1,
    *,
    key: Ed25519PrivateKey = CURATOR_KEY,
    key_id: str = "curator-key-current",
) -> CausalBallLabelBundleAttestationV1:
    role = LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR
    signed_at_ns = CURATOR_SIGNED_AT_NS
    signature = key.sign(
        causal_ball_label_bundle_signing_message(
            statement,
            key_id=key_id,
            key_role=role,
            curator_id="dataset-curator-1",
            trust_domain_id="label-curation-domain",
            signed_at_ns=signed_at_ns,
        )
    )
    return CausalBallLabelBundleAttestationV1(
        statement_sha256=statement.fingerprint(),
        key_id=key_id,
        key_role=role,
        curator_id="dataset-curator-1",
        trust_domain_id="label-curation-domain",
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _snapshot(
    statement: CausalBallLabelBundleV1,
    attestation: CausalBallLabelBundleAttestationV1,
    *,
    current_key_id: str = "curator-key-current",
    include_old_key: bool = False,
    current_key_valid_until_ns: int = (
        PROTECTED_VERIFIED_AT_NS + NANOSECONDS_PER_DAY
    ),
    current_key_revoked_at_ns: int | None = None,
) -> CausalBallLabelBundleTrustSnapshotV1:
    role = LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR
    keys = [
        TrustedLabelBundleCuratorKeyV1(
            key_id="curator-key-current",
            key_role=role,
            curator_id="dataset-curator-1",
            public_key_base64=_public_base64(CURATOR_KEY),
            valid_from_ns=PROTECTED_VERIFIED_AT_NS - NANOSECONDS_PER_DAY,
            valid_until_ns=current_key_valid_until_ns,
            revoked_at_ns=current_key_revoked_at_ns,
        )
    ]
    if include_old_key:
        keys.append(
            TrustedLabelBundleCuratorKeyV1(
                key_id="curator-key-old",
                key_role=role,
                curator_id="dataset-curator-1",
                public_key_base64=_public_base64(OLD_CURATOR_KEY),
                valid_from_ns=PROTECTED_VERIFIED_AT_NS - NANOSECONDS_PER_DAY,
                valid_until_ns=PROTECTED_VERIFIED_AT_NS + NANOSECONDS_PER_DAY,
                revoked_at_ns=None,
            )
        )
    return CausalBallLabelBundleTrustSnapshotV1(
        snapshot_generation=4,
        trust_domain_id="label-curation-domain",
        curator_id="dataset-curator-1",
        keys=tuple(sorted(keys, key=lambda item: item.key_id)),
        current_key_id=current_key_id,
        current_bundle=CurrentCausalBallLabelBundleV1(
            bundle_id=statement.bundle_id,
            statement_sha256=statement.fingerprint(),
            attestation_sha256=attestation.fingerprint(),
        ),
        revoked_statement_sha256s=(),
    )


class CausalBallLabelBundleTests(unittest.TestCase):
    def test_all_ball_statement_is_canonical_complete_and_round_trips(self) -> None:
        statement, _, _ = _bundle(all_balls=True)

        self.assertEqual(statement.frame_count, 2)
        self.assertEqual(statement.annotation_count, 3)
        self.assertEqual(statement.frames[0].match_ball_annotation.role, BallRole.MATCH_BALL)
        self.assertEqual(
            {item.role for item in statement.frames[0].annotations},
            {BallRole.MATCH_BALL, BallRole.SPARE_BALL},
        )
        self.assertEqual(
            CausalBallLabelBundleV1.from_json_bytes(statement.to_json_bytes()),
            statement,
        )
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        self.assertEqual(
            CausalBallLabelBundleAttestationV1.from_json_bytes(
                attestation.to_json_bytes()
            ),
            attestation,
        )
        self.assertEqual(
            CausalBallLabelBundleTrustSnapshotV1.from_json_bytes(
                snapshot.to_json_bytes()
            ),
            snapshot,
        )

    def test_frame_omission_duplication_and_reorder_fail_closed(self) -> None:
        statement, _, _ = _bundle(all_balls=True)
        with self.assertRaisesRegex(ValueError, "frame_count"):
            replace(statement, frames=statement.frames[:-1])
        duplicate = replace(
            statement.frames[0],
            sequence=1,
            frame_index=1,
            timestamp_ns=110,
        )
        with self.assertRaisesRegex(ValueError, "annotation IDs must be unique"):
            replace(statement, frames=(statement.frames[0], duplicate))
        with self.assertRaisesRegex(ValueError, "complete, contiguous, and ordered"):
            replace(statement, frames=tuple(reversed(statement.frames)))

    def test_annotation_duplication_order_and_frame_mismatch_fail_closed(self) -> None:
        statement, _, _ = _bundle(all_balls=True)
        frame = statement.frames[0]
        with self.assertRaisesRegex(ValueError, "annotation IDs cannot repeat"):
            replace(frame, annotations=(frame.annotations[0], frame.annotations[0]))
        with self.assertRaisesRegex(ValueError, "canonical match-first ordering"):
            replace(frame, annotations=tuple(reversed(frame.annotations)))
        with self.assertRaisesRegex(ValueError, "frame preimage"):
            match = _ball(0)
            spare = replace(
                _ball(
                    0,
                    annotation_id="spare-0",
                    ball_instance_id="spare-ball-1",
                    role=BallRole.SPARE_BALL,
                ),
                frame=replace(
                    _frame(),
                    identity=replace(
                        _frame().identity,
                        source_sha256=SOURCE,
                        frame_index=0,
                        timestamp_ns=101,
                        decoded_frame_sha256="2" * 64,
                    ),
                ),
            )
            attestations = _attestations(match) + _attestations(spare)
            build_causal_ball_label_bundle_v1(
                bundle_id="bundle-1",
                source_asset_sha256=SOURCE,
                finalized_trace_sha256=TRACE,
                capture_policy_sha256=CAPTURE_POLICY,
                capture_policy_generation=3,
                split=LabelBundleSplit.TRAIN,
                ontology_sha256=ONTOLOGY,
                ontology_version="ball-ontology-v2",
                match_ball_instance_id="match-ball",
                annotations=(match, spare),
                attestations=attestations,
                annotation_trust_store_sha256="e" * 64,
                annotation_verification_policy_sha256="f" * 64,
            )

    def test_match_statuses_are_explicit_and_capture_unknown_is_forbidden(self) -> None:
        statement, _, _ = _bundle(indistinguishable_match=True)
        target = statement.frames[0].match_ball_annotation
        self.assertIs(target.role, BallRole.UNKNOWN)
        self.assertIs(target.visibility, BallVisibility.INDISTINGUISHABLE)
        self.assertIs(
            statement.frames[0].match_ball_status,
            MatchBallFrameStatus.UNSEEN_UNKNOWN,
        )
        reference = statement.frames[0].match_ball_annotation
        capture_unknown = replace(
            reference,
            visibility=BallVisibility.CAPTURE_UNKNOWN,
            role=BallRole.MATCH_BALL,
        )
        with self.assertRaisesRegex(ValueError, "complete decoded-frame"):
            replace(
                statement.frames[0],
                annotations=(capture_unknown,),
                match_ball_annotation_id=capture_unknown.annotation_id,
            )

    def test_actual_v2_match_statuses_round_trip_and_unavailable_truth_is_rejected(
        self,
    ) -> None:
        cases = (
            (BallVisibility.VISIBLE, MatchBallFrameStatus.PRESENT),
            (BallVisibility.NOT_PRESENT, MatchBallFrameStatus.ABSENT),
            (
                BallVisibility.FULLY_OCCLUDED,
                MatchBallFrameStatus.UNSEEN_UNKNOWN,
            ),
            (BallVisibility.OUT_OF_FRAME, MatchBallFrameStatus.UNSEEN_UNKNOWN),
            (
                BallVisibility.INDISTINGUISHABLE,
                MatchBallFrameStatus.UNSEEN_UNKNOWN,
            ),
        )
        for visibility, expected_status in cases:
            with self.subTest(visibility=visibility):
                annotation = _match_with_visibility(visibility)
                attestations = _attestations(annotation)
                statement = build_causal_ball_label_bundle_v1(
                    bundle_id=f"bundle-{visibility.value.lower()}",
                    source_asset_sha256=SOURCE,
                    finalized_trace_sha256=TRACE,
                    capture_policy_sha256=CAPTURE_POLICY,
                    capture_policy_generation=3,
                    split=LabelBundleSplit.DEV,
                    ontology_sha256=ONTOLOGY,
                    ontology_version="ball-ontology-v2",
                    match_ball_instance_id="match-ball",
                    annotations=(annotation,),
                    attestations=attestations,
                    annotation_trust_store_sha256="e" * 64,
                    annotation_verification_policy_sha256="f" * 64,
                )
                self.assertIs(statement.frames[0].match_ball_status, expected_status)
                self.assertEqual(
                    CausalBallLabelBundleV1.from_json_bytes(
                        statement.to_json_bytes()
                    ),
                    statement,
                )

        unavailable = _capture_unknown_annotation()
        with self.assertRaisesRegex(ValueError, "cannot contain unavailable frames"):
            build_causal_ball_label_bundle_v1(
                bundle_id="bundle-capture-unknown",
                source_asset_sha256=SOURCE,
                finalized_trace_sha256=TRACE,
                capture_policy_sha256=CAPTURE_POLICY,
                capture_policy_generation=3,
                split=LabelBundleSplit.DEV,
                ontology_sha256=ONTOLOGY,
                ontology_version="ball-ontology-v2",
                match_ball_instance_id="match-ball",
                annotations=(unavailable,),
                attestations=_attestations(unavailable),
                annotation_trust_store_sha256="e" * 64,
                annotation_verification_policy_sha256="f" * 64,
            )

    def test_nonmatch_entries_must_be_localizable_and_unique(self) -> None:
        statement, _, _ = _bundle(all_balls=True)
        frame = statement.frames[0]
        spare = frame.annotations[1]
        with self.assertRaisesRegex(ValueError, "must be localizable"):
            replace(
                frame,
                annotations=(
                    frame.annotations[0],
                    replace(spare, visibility=BallVisibility.FULLY_OCCLUDED),
                ),
            )
        with self.assertRaisesRegex(ValueError, "ball_instance_id values cannot repeat"):
            replace(
                frame,
                annotations=(
                    frame.annotations[0],
                    replace(spare, ball_instance_id="match-ball"),
                ),
            )

    def test_unknown_enums_and_noncanonical_wire_encodings_are_rejected(self) -> None:
        statement, _, _ = _bundle()
        payload = statement.to_dict()
        payload["split"] = "TUNE"
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(LabelBundleError, "unsupported enum"):
            CausalBallLabelBundleV1.from_json_bytes(raw)

        canonical = statement.to_json_bytes()
        duplicate = canonical.replace(
            b'{"annotation_attestation_set_sha256":',
            b'{"bundle_id":"duplicate","annotation_attestation_set_sha256":',
            1,
        )
        with self.assertRaisesRegex(LabelBundleError, "DUPLICATE_JSON_KEY"):
            # Add a second bundle_id next to the existing canonical key.
            duplicated_id = duplicate.replace(
                b'"capture_policy_generation":',
                b'"bundle_id":"bundle-1","capture_policy_generation":',
                1,
            )
            CausalBallLabelBundleV1.from_json_bytes(duplicated_id)
        with self.assertRaisesRegex(LabelBundleError, "floating JSON number"):
            CausalBallLabelBundleV1.from_json_bytes(
                canonical.replace(b'"frame_count":1', b'"frame_count":1.0')
            )
        with self.assertRaisesRegex(LabelBundleError, "NONCANONICAL_JSON"):
            CausalBallLabelBundleV1.from_json_bytes(
                json.dumps(statement.to_dict(), indent=2, sort_keys=True).encode()
            )
        with self.assertRaisesRegex(LabelBundleError, "signed 64-bit"):
            CausalBallLabelBundleV1.from_json_bytes(
                canonical.replace(
                    b'"capture_policy_generation":3',
                    b'"capture_policy_generation":9223372036854775808',
                )
            )

    def test_depth_and_node_limits_are_applied_before_contract_construction(self) -> None:
        statement, _, _ = _bundle()
        payload = statement.to_dict()
        nested: object = 0
        for _ in range(18):
            nested = [nested]
        payload["unsupported"] = nested
        with self.assertRaisesRegex(LabelBundleError, "JSON_DEPTH_EXCEEDED"):
            CausalBallLabelBundleV1.from_json_bytes(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            )
        payload = statement.to_dict()
        payload["unsupported"] = [0] * 50_001
        with self.assertRaisesRegex(LabelBundleError, "JSON_NODE_LIMIT_EXCEEDED"):
            CausalBallLabelBundleV1.from_json_bytes(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            )

    def test_preimage_and_attestation_references_are_exact_canonical_addresses(self) -> None:
        statement, _, _ = _bundle()
        reference = statement.frames[0].annotations[0]
        with self.assertRaisesRegex(ValueError, "exact annotation SHA-256"):
            replace(reference, annotation_preimage_ref="sha256:" + "0" * 64)
        with self.assertRaisesRegex(ValueError, "canonically sorted"):
            replace(
                reference,
                annotation_attestation_refs=tuple(
                    reversed(reference.annotation_attestation_refs)
                ),
            )
        with self.assertRaisesRegex(ValueError, "unique and canonically sorted"):
            replace(
                reference,
                annotation_attestation_refs=(
                    reference.annotation_attestation_refs[0],
                    reference.annotation_attestation_refs[0],
                ),
            )

    def test_invalid_count_bounds_fail_before_expensive_fingerprints(self) -> None:
        annotation = _ball(0)
        too_many_in_frame = tuple(
            replace(annotation, annotation_id=f"ball-overflow-{index}")
            for index in range(65)
        )
        with patch.object(
            BallFrameAnnotationV2,
            "fingerprint",
            side_effect=AssertionError("annotation fingerprint should not run"),
        ), self.assertRaisesRegex(ValueError, "per-frame ball-annotation bound"):
            build_causal_ball_label_bundle_v1(
                bundle_id="bundle-overflow",
                source_asset_sha256=SOURCE,
                finalized_trace_sha256=TRACE,
                capture_policy_sha256=CAPTURE_POLICY,
                capture_policy_generation=3,
                split=LabelBundleSplit.TRAIN,
                ontology_sha256=ONTOLOGY,
                ontology_version="ball-ontology-v2",
                match_ball_instance_id="match-ball",
                annotations=too_many_in_frame,
                attestations=(),
                annotation_trust_store_sha256="e" * 64,
                annotation_verification_policy_sha256="f" * 64,
            )

        detached = _attestations(annotation)[0]
        with patch.object(
            BallFrameAnnotationV2,
            "fingerprint",
            side_effect=AssertionError("annotation fingerprint should not run"),
        ), patch.object(
            type(detached),
            "fingerprint",
            side_effect=AssertionError("attestation fingerprint should not run"),
        ), self.assertRaisesRegex(ValueError, "attestation reference bound"):
            build_causal_ball_label_bundle_v1(
                bundle_id="bundle-attestation-overflow",
                source_asset_sha256=SOURCE,
                finalized_trace_sha256=TRACE,
                capture_policy_sha256=CAPTURE_POLICY,
                capture_policy_generation=3,
                split=LabelBundleSplit.TRAIN,
                ontology_sha256=ONTOLOGY,
                ontology_version="ball-ontology-v2",
                match_ball_instance_id="match-ball",
                annotations=(annotation,),
                attestations=(detached,) * 18,
                annotation_trust_store_sha256="e" * 64,
                annotation_verification_policy_sha256="f" * 64,
            )
    def test_invalid_signature_and_noncurrent_key_fail_before_annotation_io(self) -> None:
        statement, _, _ = _bundle()
        valid = _attest_bundle(statement)
        forged = replace(
            valid,
            signature_base64=base64.b64encode(b"\x00" * 64).decode("ascii"),
        )
        forged_snapshot = _snapshot(statement, forged)
        with self.assertRaisesRegex(LabelBundleError, "signature is invalid"):
            self._verify_without_reaching_annotation_io(
                statement,
                forged,
                forged_snapshot,
            )

        old = _attest_bundle(
            statement,
            key=OLD_CURATOR_KEY,
            key_id="curator-key-old",
        )
        snapshot = _snapshot(statement, old, include_old_key=True)
        with self.assertRaisesRegex(LabelBundleError, "current key"):
            self._verify_without_reaching_annotation_io(statement, old, snapshot)

    def test_trust_pin_and_current_statement_are_strict(self) -> None:
        statement, _, _ = _bundle()
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        with self.assertRaisesRegex(LabelBundleError, "protected pin"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                snapshot,
                expected_snapshot="0" * 64,
            )
        stale = replace(statement, finalized_trace_sha256="0" * 64)
        with self.assertRaisesRegex(LabelBundleError, "not exactly current"):
            self._verify_without_reaching_annotation_io(stale, attestation, snapshot)

    def test_protected_time_rejects_future_signature_expired_and_revoked_keys(self) -> None:
        statement, _, _ = _bundle()
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        for invalid in (True, -1, 1 << 63):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ValueError,
                "protected_verified_at_ns",
            ):
                self._verify_without_reaching_annotation_io(
                    statement,
                    attestation,
                    snapshot,
                    protected_time=invalid,
                )
        with self.assertRaisesRegex(LabelBundleError, "not current at verification"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                snapshot,
                protected_time=CURATOR_SIGNED_AT_NS - 1,
            )

        expired = _snapshot(
            statement,
            attestation,
            current_key_valid_until_ns=PROTECTED_VERIFIED_AT_NS - 1,
        )
        with self.assertRaisesRegex(LabelBundleError, "not current at verification"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                expired,
            )

        revoked = _snapshot(
            statement,
            attestation,
            current_key_revoked_at_ns=PROTECTED_VERIFIED_AT_NS - 1,
        )
        with self.assertRaisesRegex(LabelBundleError, "current curator key is revoked"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                revoked,
            )

    def test_curator_and_annotation_authority_public_keys_must_be_disjoint(self) -> None:
        annotation = _ball(0)
        annotation_attestations = _attestations(annotation)
        base_store = _store(annotation)
        overlapping_reviewer_key = replace(
            base_store.keys[0],
            public_key_base64=_public_base64(CURATOR_KEY),
        )
        store = replace(
            base_store,
            keys=(overlapping_reviewer_key, base_store.keys[1]),
        )
        policy = _policy(store)
        statement = build_causal_ball_label_bundle_v1(
            bundle_id="bundle-overlapping-authority",
            source_asset_sha256=SOURCE,
            finalized_trace_sha256=TRACE,
            capture_policy_sha256=CAPTURE_POLICY,
            capture_policy_generation=3,
            split=LabelBundleSplit.TRAIN,
            ontology_sha256=ONTOLOGY,
            ontology_version="ball-ontology-v2",
            match_ball_instance_id="match-ball",
            annotations=(annotation,),
            attestations=annotation_attestations,
            annotation_trust_store_sha256=store.fingerprint(),
            annotation_verification_policy_sha256=policy.fingerprint(),
        )
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        with self.assertRaisesRegex(LabelBundleError, "must use disjoint keys"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                snapshot,
                annotations=(annotation,),
                annotation_attestations=annotation_attestations,
                store=store,
                policy=policy,
            )

    def test_test_split_verifies_but_receipt_cannot_authorize_any_consumer(self) -> None:
        annotation = _ball(0)
        attestations = _attestations(annotation)
        store = _store(annotation)
        policy = _policy(store)
        statement = build_causal_ball_label_bundle_v1(
            bundle_id="bundle-test",
            source_asset_sha256=SOURCE,
            finalized_trace_sha256=TRACE,
            capture_policy_sha256=CAPTURE_POLICY,
            capture_policy_generation=3,
            split=LabelBundleSplit.TEST,
            ontology_sha256=ONTOLOGY,
            ontology_version="ball-ontology-v2",
            match_ball_instance_id="match-ball",
            annotations=(annotation,),
            attestations=attestations,
            annotation_trust_store_sha256=store.fingerprint(),
            annotation_verification_policy_sha256=policy.fingerprint(),
        )
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        with tempfile.TemporaryDirectory() as directory:
            evidence_root = _evidence_store_root(directory)
            protected_path = Path(directory) / "protected-configuration.json"
            protected_configuration = _protected_configuration_generation(
                store,
                policy,
            )
            protected_path.write_text(
                protected_configuration.canonical_json(),
                encoding="utf-8",
            )
            receipt = verify_causal_ball_label_bundle_v1(
                statement,
                attestation,
                snapshot,
                annotations=(annotation,),
                annotation_attestations=attestations,
                annotation_trust_store=store,
                annotation_verification_policy=policy,
                evidence_store_root=evidence_root,
                protected_annotation_configuration_generation_path=protected_path,
                evaluator_artifact_sha256=EVALUATOR_ARTIFACT_SHA256,
                requested_truth_policy=(
                    AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED
                ),
                expected_trust_snapshot_sha256=snapshot.fingerprint(),
                expected_trust_snapshot_generation=4,
                expected_current_attestation_sha256=attestation.fingerprint(),
                expected_curator_id="dataset-curator-1",
                expected_trust_domain_id="label-curation-domain",
                protected_verified_at_ns=PROTECTED_VERIFIED_AT_NS,
            )
            annotation_verification = store.verify_annotation_set(
                (annotation,),
                attestations,
                evidence_store_root=evidence_root,
                verification_policy=policy,
                expected_verification_policy_sha256=policy.fingerprint(),
                protected_configuration_generation_path=protected_path,
                evaluator_artifact_sha256=EVALUATOR_ARTIFACT_SHA256,
                requested_truth_policy=(
                    AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED.value
                ),
                protected_verified_at_ns=PROTECTED_VERIFIED_AT_NS,
            )

        self.assertIs(receipt.split, LabelBundleSplit.TEST)
        self.assertEqual(receipt.trust_snapshot_generation, 4)
        self.assertEqual(
            receipt.protected_verified_at_ns,
            PROTECTED_VERIFIED_AT_NS,
        )
        self.assertIs(
            receipt.requested_truth_policy,
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        )
        self.assertEqual(
            receipt.annotation_configuration_generation_sha256,
            protected_configuration.fingerprint(),
        )
        expected_evidence_refs = tuple(sorted((REVIEW_REF, ADJUDICATION_REF)))
        self.assertEqual(
            receipt.annotation_evidence_set_sha256,
            annotation_evidence_set_fingerprint(expected_evidence_refs),
        )
        self.assertEqual(
            receipt.annotation_evidence_generation_id,
            generation_id_for(
                tuple(
                    reference.removeprefix("sha256:")
                    for reference in expected_evidence_refs
                )
            ),
        )
        self.assertFalse(receipt.admissible_for_training)
        self.assertFalse(receipt.admissible_for_evaluation)
        self.assertFalse(receipt.admissible_for_test)
        self.assertFalse(receipt.admissible_for_deployment)
        self.assertFalse(receipt.admissible_for_live_scoring)
        with patch.object(
            type(store),
            "verify_annotation_set",
            return_value=replace(
                annotation_verification,
                protected_verified_at_ns=PROTECTED_VERIFIED_AT_NS + 1,
            ),
        ), self.assertRaisesRegex(
            LabelBundleError,
            "annotation verification result differs",
        ):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                snapshot,
                annotations=(annotation,),
                annotation_attestations=attestations,
                store=store,
                policy=policy,
                protected_time=PROTECTED_VERIFIED_AT_NS,
            )
        with self.assertRaises(AttributeError):
            receipt._split = LabelBundleSplit.TRAIN  # type: ignore[attr-defined]
        with self.assertRaises(AttributeError):
            del receipt._split  # type: ignore[attr-defined]
        with self.assertRaises(AttributeError):
            del receipt._requested_truth_policy  # type: ignore[attr-defined]
        self.assertFalse(hasattr(receipt, "__dict__"))

    def test_concrete_annotation_mismatch_is_rejected_even_if_curator_signature_is_valid(
        self,
    ) -> None:
        annotation = _ball(0)
        attestations = _attestations(annotation)
        store = _store(annotation)
        policy = _policy(store)
        statement = build_causal_ball_label_bundle_v1(
            bundle_id="bundle-1",
            source_asset_sha256=SOURCE,
            finalized_trace_sha256=TRACE,
            capture_policy_sha256=CAPTURE_POLICY,
            capture_policy_generation=3,
            split=LabelBundleSplit.TRAIN,
            ontology_sha256=ONTOLOGY,
            ontology_version="ball-ontology-v2",
            match_ball_instance_id="match-ball",
            annotations=(annotation,),
            attestations=attestations,
            annotation_trust_store_sha256=store.fingerprint(),
            annotation_verification_policy_sha256=policy.fingerprint(),
        )
        attestation = _attest_bundle(statement)
        snapshot = _snapshot(statement, attestation)
        altered = replace(annotation, center=PixelPoint(101, 200))
        with self.assertRaisesRegex(LabelBundleError, "CONCRETE_BINDING"):
            self._verify_without_reaching_annotation_io(
                statement,
                attestation,
                snapshot,
                annotations=(altered,),
                annotation_attestations=attestations,
                store=store,
                policy=policy,
            )

    def _verify_without_reaching_annotation_io(
        self,
        statement: CausalBallLabelBundleV1,
        attestation: CausalBallLabelBundleAttestationV1,
        snapshot: CausalBallLabelBundleTrustSnapshotV1,
        *,
        expected_snapshot: str | None = None,
        annotations: tuple[BallFrameAnnotationV2, ...] = (),
        annotation_attestations: tuple[object, ...] = (),
        store: object | None = None,
        policy: object | None = None,
        protected_time: int = PROTECTED_VERIFIED_AT_NS,
    ) -> None:
        if store is None or policy is None:
            annotation = _ball(0)
            selected_store = _store(annotation)
            selected_policy = _policy(selected_store)
        else:
            selected_store = store
            selected_policy = policy
        verify_causal_ball_label_bundle_v1(
            statement,
            attestation,
            snapshot,
            annotations=annotations,
            annotation_attestations=annotation_attestations,  # type: ignore[arg-type]
            annotation_trust_store=selected_store,  # type: ignore[arg-type]
            annotation_verification_policy=selected_policy,  # type: ignore[arg-type]
            evidence_store_root=Path("/must-not-be-opened"),
            protected_annotation_configuration_generation_path=Path(
                "/must-not-be-opened"
            ),
            evaluator_artifact_sha256=EVALUATOR_ARTIFACT_SHA256,
            requested_truth_policy=(
                AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED
            ),
            expected_trust_snapshot_sha256=(
                expected_snapshot or snapshot.fingerprint()
            ),
            expected_trust_snapshot_generation=4,
            expected_current_attestation_sha256=attestation.fingerprint(),
            expected_curator_id="dataset-curator-1",
            expected_trust_domain_id="label-curation-domain",
            protected_verified_at_ns=protected_time,
        )


if __name__ == "__main__":
    unittest.main()
