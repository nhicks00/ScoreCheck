from __future__ import annotations

import base64
from dataclasses import replace
from datetime import date
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vision_scoring.annotation_trust as annotation_trust_module
from vision_scoring.annotation_trust import (
    AnnotationAttestation,
    AnnotationAttestationRole,
    AnnotationMinimumTruthPolicy,
    AnnotationTrustError,
    AnnotationTrustStore,
    AnnotationVerificationPolicy,
    CurrentAnnotation,
    ProtectedAnnotationConfigurationGeneration,
    TrustedAnnotationKey,
    annotation_evidence_set_fingerprint,
    annotation_attestation_set_fingerprint,
    annotation_attestation_signing_message,
    annotation_trust_store_from_dict,
    annotation_verification_policy_from_dict,
    current_annotation_from_dict,
    load_annotation_trust_store,
    load_annotation_verification_policy,
    load_protected_annotation_configuration_generation,
    trusted_annotation_key_from_dict,
    verify_annotation_evidence,
)
from vision_scoring.annotations import (
    AnnotationType,
    AutorotationPolicy,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    DecodedColorRange,
    DecodedColorSpace,
    DecodedFrameHashBasis,
    DecodedFrameIdentity,
    DecodedPixelFormat,
    FrameDecodeContract,
    FrameDuplicateKind,
    FrameReference,
    PixelCoordinateSpace,
    PixelPoint,
    ReviewState,
    TimestampBasis,
)
from vision_scoring.protected_file import PROTECTED_FILE_INPUT, ProtectedFileError
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
    generation_id_for,
)


SOURCE = "a" * 64
ONTOLOGY = "b" * 64
REVIEW_BYTES = b"annotation review evidence\n"
ADJUDICATION_BYTES = b"annotation adjudication evidence\n"
CAPTURE_BYTES = b"capture duplicate integrity evidence\n"
REVIEW_SHA = hashlib.sha256(REVIEW_BYTES).hexdigest()
ADJUDICATION_SHA = hashlib.sha256(ADJUDICATION_BYTES).hexdigest()
CAPTURE_SHA = hashlib.sha256(CAPTURE_BYTES).hexdigest()
REVIEW_REF = "sha256:" + REVIEW_SHA
ADJUDICATION_REF = "sha256:" + ADJUDICATION_SHA
CAPTURE_REF = "sha256:" + CAPTURE_SHA
TRUST_DOMAIN_ID = "fixture-annotation-keyring"
EVALUATOR_ARTIFACT_SHA256 = "e" * 64

REVIEW_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x31" * 32)
ADJUDICATION_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x32" * 32)
FORGED_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x33" * 32)
SECOND_REVIEW_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x34" * 32)


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    return base64.b64encode(
        private_key.public_key().public_bytes_raw()
    ).decode("ascii")


def _frame(
    *,
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE,
    duplicate_of_frame_index: int | None = None,
    capture_refs: tuple[str, ...] = (),
) -> FrameReference:
    decode_contract = FrameDecodeContract(
        decoder_artifact_sha256="f" * 64,
        decoder_build_id="ffmpeg-8.1-arm64",
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=1920,
        output_height=1080,
    )
    return FrameReference(
        identity=DecodedFrameIdentity(
            source_sha256=SOURCE,
            selected_video_stream_index=0,
            frame_index=1,
            timestamp_ns=16_666_667,
            timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
            pixel_coordinate_space=(
                PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
            ),
            decode_contract=decode_contract,
            decoded_frame_sha256="d" * 64,
            decoded_frame_hash_basis=(
                DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            ),
        ),
        duplicate_kind=duplicate_kind,
        duplicate_of_frame_index=duplicate_of_frame_index,
        capture_integrity_attestation_refs=capture_refs,
    )


def _annotation(
    *,
    review_state: ReviewState = ReviewState.ADJUDICATED,
    frame: FrameReference | None = None,
    annotation_id: str = "truth-1",
    center: PixelPoint = PixelPoint(100, 200),
) -> BallFrameAnnotationV2:
    values: dict[str, object] = {
        "annotation_id": annotation_id,
        "ontology_sha256": ONTOLOGY,
        "ball_instance_id": "match-ball",
        "frame": frame or _frame(),
        "visibility": BallVisibility.VISIBLE,
        "appearance": BallAppearance.SHARP,
        "role": BallRole.MATCH_BALL,
        "play_state": BallPlayState.IN_PLAY,
        "center": center,
        "apparent_minor_axis_diameter_px": 12.0,
        "track_segment_id": "track-1",
        "review_state": review_state,
    }
    if review_state in {ReviewState.REVIEWED, ReviewState.ADJUDICATED}:
        values["reviewer_ids"] = ("reviewer-1",)
        values["review_evidence_refs"] = (REVIEW_REF,)
    if review_state is ReviewState.ADJUDICATED:
        values["adjudicator_id"] = "adjudicator-1"
        values["adjudication_evidence_refs"] = (ADJUDICATION_REF,)
    return BallFrameAnnotationV2(**values)  # type: ignore[arg-type]


def _attestation(
    annotation: BallFrameAnnotationV2,
    role: AnnotationAttestationRole,
    principal_id: str,
    *,
    private_key: Ed25519PrivateKey | None = None,
    key_id: str | None = None,
    signed_on: str = "2026-07-11",
    trust_domain_id: str = TRUST_DOMAIN_ID,
    message_annotation: BallFrameAnnotationV2 | None = None,
) -> AnnotationAttestation:
    if private_key is None:
        private_key = (
            REVIEW_PRIVATE_KEY
            if role is AnnotationAttestationRole.REVIEWER
            else ADJUDICATION_PRIVATE_KEY
        )
    if key_id is None:
        key_id = (
            "review-key-1"
            if role is AnnotationAttestationRole.REVIEWER
            else "adjudication-key-1"
        )
    signature = private_key.sign(
        annotation_attestation_signing_message(
            message_annotation or annotation,
            role=role,
            principal_id=principal_id,
            key_id=key_id,
            trust_domain_id=trust_domain_id,
            signed_on=signed_on,
        )
    )
    return AnnotationAttestation(
        annotation_type=AnnotationType.BALL_FRAME_OBSERVATION,
        annotation_sha256=annotation.fingerprint(),
        role=role,
        principal_id=principal_id,
        key_id=key_id,
        trust_domain_id=trust_domain_id,
        signed_on=signed_on,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _attestations(
    annotation: BallFrameAnnotationV2,
) -> tuple[AnnotationAttestation, ...]:
    values = [
        _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
        )
    ]
    if annotation.review_state is ReviewState.ADJUDICATED:
        values.append(
            _attestation(
                annotation,
                AnnotationAttestationRole.ADJUDICATOR,
                "adjudicator-1",
            )
        )
    return tuple(values)


def _key(
    role: AnnotationAttestationRole,
    *,
    principal_id: str | None = None,
    permitted_roles: tuple[AnnotationAttestationRole, ...] | None = None,
    valid_from: str = "2026-01-01",
    valid_until: str | None = "2026-12-31",
    compromised_on: str | None = None,
) -> TrustedAnnotationKey:
    reviewer = role is AnnotationAttestationRole.REVIEWER
    return TrustedAnnotationKey(
        key_id="review-key-1" if reviewer else "adjudication-key-1",
        principal_id=(
            principal_id
            if principal_id is not None
            else ("reviewer-1" if reviewer else "adjudicator-1")
        ),
        permitted_roles=permitted_roles or (role,),
        public_key_base64=_public_key_base64(
            REVIEW_PRIVATE_KEY if reviewer else ADJUDICATION_PRIVATE_KEY
        ),
        valid_from=valid_from,
        valid_until=valid_until,
        compromised_on=compromised_on,
    )


def _store(
    annotation: BallFrameAnnotationV2,
    **overrides: object,
) -> AnnotationTrustStore:
    values: dict[str, object] = {
        "keyring_id": TRUST_DOMAIN_ID,
        "keys": (
            _key(AnnotationAttestationRole.REVIEWER),
            _key(AnnotationAttestationRole.ADJUDICATOR),
        ),
        "current_annotations": (
            CurrentAnnotation(
                annotation_type=AnnotationType.BALL_FRAME_OBSERVATION,
                annotation_id=annotation.annotation_id,
                annotation_sha256=annotation.fingerprint(),
            ),
        ),
        "revoked_annotation_sha256s": (),
    }
    values.update(overrides)
    return AnnotationTrustStore(**values)  # type: ignore[arg-type]


def _publish_evidence_generation(
    root: Path,
    payloads: tuple[bytes, ...],
    *,
    path_generation_id: str | None = None,
    descriptor: GenerationDescriptor | None = None,
) -> GenerationDescriptor:
    digests = tuple(
        sorted(hashlib.sha256(payload).hexdigest() for payload in payloads)
    )
    selected = descriptor or GenerationDescriptor.build(digests)
    generation_id = path_generation_id or selected.generation_id
    lock = root / "locks" / f"{generation_id}.lock"
    if not lock.exists():
        bootstrap_generation_lock(root, generation_id)
    generation = root / "generations" / generation_id
    objects = generation / "objects"
    objects.mkdir(parents=True)
    for payload in payloads:
        digest = hashlib.sha256(payload).hexdigest()
        (objects / digest).write_bytes(payload)
    (generation / "descriptor.json").write_bytes(selected.canonical_bytes())
    return selected


def _evidence_store_root(
    directory: str,
    *,
    include_capture: bool = False,
) -> Path:
    root = Path(directory)
    (root / "locks").mkdir(parents=True)
    (root / "generations").mkdir()
    _publish_evidence_generation(root, (REVIEW_BYTES,))
    _publish_evidence_generation(root, (REVIEW_BYTES, ADJUDICATION_BYTES))
    if include_capture:
        _publish_evidence_generation(
            root,
            (REVIEW_BYTES, ADJUDICATION_BYTES, CAPTURE_BYTES),
        )
    return root


def _policy(
    store: AnnotationTrustStore,
    **overrides: object,
) -> AnnotationVerificationPolicy:
    values: dict[str, object] = {
        "policy_id": "fixture-annotation-policy",
        "governance_domain_id": TRUST_DOMAIN_ID,
        "trust_store_sha256": store.fingerprint(),
        "evaluator_artifact_sha256": EVALUATOR_ARTIFACT_SHA256,
        "minimum_truth_policy": AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        "valid_from": "2020-01-01",
        "valid_until": "2099-12-31",
    }
    values.update(overrides)
    return AnnotationVerificationPolicy(**values)  # type: ignore[arg-type]


def _protected_configuration_generation(
    store: AnnotationTrustStore,
    policy: AnnotationVerificationPolicy,
    *,
    policy_sha256: str | None = None,
    evaluator_artifact_sha256: str = EVALUATOR_ARTIFACT_SHA256,
    governance_domain_id: str = TRUST_DOMAIN_ID,
) -> ProtectedAnnotationConfigurationGeneration:
    return ProtectedAnnotationConfigurationGeneration(
        annotation_trust_store_sha256=store.fingerprint(),
        annotation_verification_policy_sha256=(
            policy_sha256 or policy.fingerprint()
        ),
        evaluator_artifact_sha256=evaluator_artifact_sha256,
        governance_domain_id=governance_domain_id,
    )


def _verify(
    store: AnnotationTrustStore,
    annotations: tuple[BallFrameAnnotationV2, ...],
    attestations: tuple[AnnotationAttestation, ...],
    evidence_store_root: Path,
    *,
    policy: AnnotationVerificationPolicy | None = None,
    expected_policy_sha256: str | None = None,
    evaluator_artifact_sha256: str = EVALUATOR_ARTIFACT_SHA256,
    requested_truth_policy: str = "REVIEWED_OR_ADJUDICATED",
    protected_generation: ProtectedAnnotationConfigurationGeneration | None = None,
    protected_generation_path: Path | None = None,
):
    selected_policy = policy or _policy(store)
    selected_generation = protected_generation or _protected_configuration_generation(
        store,
        selected_policy,
        policy_sha256=expected_policy_sha256,
        evaluator_artifact_sha256=evaluator_artifact_sha256,
    )
    selected_generation_path = protected_generation_path or (
        evidence_store_root / "protected-annotation-configuration.json"
    )
    selected_generation_path.write_text(
        selected_generation.canonical_json(),
        encoding="utf-8",
    )
    return store.verify_annotation_set(
        annotations,
        attestations,
        evidence_store_root=evidence_store_root,
        verification_policy=selected_policy,
        expected_verification_policy_sha256=(
            expected_policy_sha256 or selected_policy.fingerprint()
        ),
        protected_configuration_generation_path=selected_generation_path,
        evaluator_artifact_sha256=evaluator_artifact_sha256,
        requested_truth_policy=requested_truth_policy,
    )


class AnnotationTrustTests(unittest.TestCase):
    def test_v2_trust_is_typed_and_fails_closed_for_unimplemented_layers(self) -> None:
        annotation = _annotation()
        attestation = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
        )
        current = CurrentAnnotation(
            AnnotationType.BALL_FRAME_OBSERVATION,
            annotation.annotation_id,
            annotation.fingerprint(),
        )
        self.assertIs(
            attestation.annotation_type,
            AnnotationType.BALL_FRAME_OBSERVATION,
        )
        self.assertIs(
            current.annotation_type,
            AnnotationType.BALL_FRAME_OBSERVATION,
        )
        for annotation_type in (
            AnnotationType.OBSERVED_TEMPORAL_EVENT,
            AnnotationType.PHYSICAL_EVENT_ADJUDICATION,
            AnnotationType.REPORTED_OFFICIAL_EVENT,
        ):
            with self.subTest(annotation_type=annotation_type), self.assertRaisesRegex(
                ValueError,
                "supports BALL_FRAME_OBSERVATION only",
            ):
                replace(attestation, annotation_type=annotation_type)
            with self.subTest(
                current_annotation_type=annotation_type
            ), self.assertRaisesRegex(
                ValueError,
                "supports BALL_FRAME_OBSERVATION only",
            ):
                replace(current, annotation_type=annotation_type)

    def test_valid_exact_signers_current_annotation_and_evidence_verify(self) -> None:
        annotation = _annotation()
        attestations = _attestations(annotation)
        with tempfile.TemporaryDirectory() as directory:
            store = _store(annotation)
            verified = _verify(
                store,
                (annotation,),
                attestations,
                _evidence_store_root(directory),
            )

        self.assertEqual(verified.trust_store_sha256, store.fingerprint())
        self.assertEqual(
            verified.attestation_set_sha256,
            annotation_attestation_set_fingerprint(attestations),
        )
        self.assertEqual(
            verified.verified_evidence_refs,
            tuple(sorted((REVIEW_REF, ADJUDICATION_REF))),
        )
        self.assertEqual(
            verified.evidence_set_sha256,
            annotation_evidence_set_fingerprint(verified.verified_evidence_refs),
        )
        expected_evidence_digests = tuple(
            reference.removeprefix("sha256:")
            for reference in verified.verified_evidence_refs
        )
        self.assertEqual(
            verified.evidence_generation_id,
            generation_id_for(expected_evidence_digests),
        )
        with self.assertRaisesRegex(ValueError, "exact verified_evidence_refs"):
            replace(verified, evidence_generation_id="0" * 64)
        self.assertEqual(verified.evaluator_artifact_sha256, EVALUATOR_ARTIFACT_SHA256)
        self.assertEqual(verified.governance_domain_id, TRUST_DOMAIN_ID)
        self.assertEqual(
            verified.protected_configuration_generation_sha256,
            verified.protected_configuration_generation.fingerprint(),
        )
        self.assertEqual(
            verified.protected_configuration_generation.annotation_trust_store_sha256,
            verified.trust_store_sha256,
        )
        with self.assertRaisesRegex(ValueError, "must match the exact"):
            replace(
                verified,
                protected_configuration_generation_sha256="0" * 64,
            )
        forged_generation = replace(
            verified.protected_configuration_generation,
            evaluator_artifact_sha256="0" * 64,
        )
        with self.assertRaisesRegex(ValueError, "must match report"):
            replace(
                verified,
                protected_configuration_generation=forged_generation,
                protected_configuration_generation_sha256=(
                    forged_generation.fingerprint()
                ),
            )
        self.assertIs(
            verified.requested_truth_policy,
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        )
        with self.assertRaisesRegex(ValueError, "requested_truth_policy"):
            replace(
                verified,
                requested_truth_policy="REVIEWED_OR_ADJUDICATED",  # type: ignore[arg-type]
            )
        self.assertRegex(
            verified.verified_at_utc,
            r"^\d{4}-\d{2}-\d{2}T.*Z$",
        )
        self.assertEqual(
            annotation_attestation_set_fingerprint(attestations),
            annotation_attestation_set_fingerprint(tuple(reversed(attestations))),
        )

    def test_protected_policy_pin_store_artifact_domain_truth_and_date_fail_closed(
        self,
    ) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        store = _store(annotation)
        attestations = _attestations(annotation)
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            policy = _policy(store)
            protected_pin = policy.fingerprint()
            with self.assertRaisesRegex(AnnotationTrustError, "pinned fingerprint"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=policy,
                    expected_policy_sha256="0" * 64,
                )

            substituted_policy = replace(policy, valid_until="2098-12-31")
            with self.assertRaisesRegex(AnnotationTrustError, "pinned fingerprint"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=substituted_policy,
                    expected_policy_sha256=protected_pin,
                )

            wrong_store_policy = _policy(store, trust_store_sha256="0" * 64)
            with self.assertRaisesRegex(AnnotationTrustError, "trust store"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=wrong_store_policy,
                )

            wrong_artifact_policy = _policy(
                store,
                evaluator_artifact_sha256="0" * 64,
            )
            with self.assertRaisesRegex(AnnotationTrustError, "evaluator artifact"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=wrong_artifact_policy,
                )

            wrong_domain_policy = _policy(
                store,
                governance_domain_id="another-governance-domain",
            )
            with self.assertRaisesRegex(AnnotationTrustError, "governance domain"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=wrong_domain_policy,
                )

            strict_policy = _policy(
                store,
                minimum_truth_policy=AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY,
            )
            with self.assertRaisesRegex(AnnotationTrustError, "weaker"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=strict_policy,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "below.*requested"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=strict_policy,
                    requested_truth_policy="ADJUDICATED_ONLY",
                )

            expired_policy = _policy(
                store,
                valid_from="2000-01-01",
                valid_until="2000-12-31",
            )
            with self.assertRaisesRegex(AnnotationTrustError, "not active"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=expired_policy,
                )

    def test_protected_generation_start_mismatch_and_same_day_change_fail_closed(
        self,
    ) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        store = _store(annotation)
        policy = _policy(store)
        attestations = _attestations(annotation)
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            mismatched = replace(
                _protected_configuration_generation(store, policy),
                annotation_trust_store_sha256="0" * 64,
            )
            with self.assertRaises(AnnotationTrustError) as start_mismatch:
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=policy,
                    protected_generation=mismatched,
                )
            self.assertEqual(
                start_mismatch.exception.code,
                "ANNOTATION_PROTECTED_CONFIGURATION_COMPONENT",
            )

            generation_path = root / "current-annotation-generation.json"
            starting = _protected_configuration_generation(store, policy)
            replacement_generation = replace(
                starting,
                annotation_trust_store_sha256="f" * 64,
            )

            def publish_revocation_generation(
                evidence_refs: tuple[str, ...],
                *,
                evidence_store_root: Path,
            ) -> str:
                self.assertEqual(evidence_store_root, root)
                generation_path.write_text(
                    replacement_generation.canonical_json(),
                    encoding="utf-8",
                )
                return generation_id_for(
                    tuple(
                        reference.removeprefix("sha256:")
                        for reference in evidence_refs
                    )
                )

            with patch.object(
                annotation_trust_module,
                "verify_annotation_evidence",
                side_effect=publish_revocation_generation,
            ), patch.object(
                annotation_trust_module,
                "load_protected_annotation_configuration_generation",
                wraps=load_protected_annotation_configuration_generation,
            ) as loader, patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-12T12:00:00.000000Z", date(2026, 7, 12)),
                ),
            ), self.assertRaises(AnnotationTrustError) as changed:
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=policy,
                    protected_generation=starting,
                    protected_generation_path=generation_path,
                )
            self.assertEqual(
                changed.exception.code,
                "ANNOTATION_PROTECTED_CONFIGURATION_CHANGED",
            )
            self.assertEqual(loader.call_count, 2)

    def test_protected_generation_reload_clock_order_closes_midnight_window(
        self,
    ) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        store = _store(annotation)
        policy = _policy(
            store,
            valid_from="2026-07-12",
            valid_until="2026-07-12",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-12T23:59:59.999999Z", date(2026, 7, 12)),
                    ("2026-07-13T00:00:00.000000Z", date(2026, 7, 13)),
                ),
            ), patch.object(
                annotation_trust_module,
                "load_protected_annotation_configuration_generation",
                wraps=load_protected_annotation_configuration_generation,
            ) as loader, self.assertRaisesRegex(
                AnnotationTrustError,
                "completion date",
            ):
                _verify(
                    store,
                    (annotation,),
                    _attestations(annotation),
                    root,
                    policy=policy,
                )
            self.assertEqual(loader.call_count, 2)

    def test_protected_policy_loader_is_exact_canonical_and_typed(self) -> None:
        annotation = _annotation()
        store = _store(annotation)
        policy = _policy(store)
        self.assertEqual(
            annotation_verification_policy_from_dict(policy.to_canonical_dict()),
            policy,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "annotation-policy.json"
            path.write_text(policy.canonical_json(), encoding="utf-8")
            loaded = load_annotation_verification_policy(path)
            self.assertEqual(loaded, policy)
            self.assertEqual(loaded.fingerprint(), policy.fingerprint())
            self.assertIs(
                loaded.minimum_truth_policy,
                AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
            )

            duplicate = root / "duplicate-policy.json"
            duplicate.write_text(
                policy.canonical_json().replace(
                    '"policy_id":"fixture-annotation-policy"',
                    '"policy_id":"fixture-annotation-policy","policy_id":"hidden"',
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                load_annotation_verification_policy(duplicate)

            for name, raw in (
                ("pretty", policy.canonical_json().replace(",", ", ", 1)),
                ("trailing", policy.canonical_json() + "\n"),
            ):
                with self.subTest(name=name):
                    candidate = root / f"{name}-policy.json"
                    candidate.write_text(raw, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "NONCANONICAL_JSON"):
                        load_annotation_verification_policy(candidate)

            invalid_payloads = (
                (
                    "unknown",
                    {**policy.to_canonical_dict(), "dataset_pin": "forbidden"},
                    "unsupported fields",
                ),
                (
                    "wrong-enum",
                    {
                        **policy.to_canonical_dict(),
                        "minimum_truth_policy": "DRAFT_ALLOWED",
                    },
                    "unsupported enum",
                ),
                (
                    "bool-enum",
                    {
                        **policy.to_canonical_dict(),
                        "minimum_truth_policy": True,
                    },
                    "must be a string",
                ),
            )
            for name, payload, message in invalid_payloads:
                with self.subTest(name=name):
                    candidate = root / f"{name}-policy.json"
                    candidate.write_text(
                        json.dumps(
                            payload,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                            allow_nan=False,
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, message):
                        load_annotation_verification_policy(candidate)

            oversize = root / "oversize-policy.json"
            with oversize.open("wb") as output:
                output.truncate(
                    annotation_trust_module._MAX_ANNOTATION_POLICY_BYTES + 1
                )
            with self.assertRaisesRegex(ValueError, "byte limit"):
                load_annotation_verification_policy(oversize)

    def test_protected_trust_store_loader_reconstructs_exact_nested_rows(self) -> None:
        annotation = _annotation()
        store = _store(
            annotation,
            keys=(
                _key(
                    AnnotationAttestationRole.REVIEWER,
                    permitted_roles=(
                        AnnotationAttestationRole.REVIEWER,
                        AnnotationAttestationRole.ADJUDICATOR,
                    ),
                ),
                _key(AnnotationAttestationRole.ADJUDICATOR),
            ),
            revoked_annotation_sha256s=("f" * 64,),
        )
        canonical = store.to_canonical_dict()
        self.assertIsInstance(
            trusted_annotation_key_from_dict(canonical["keys"][0]),
            TrustedAnnotationKey,
        )
        self.assertIsInstance(
            current_annotation_from_dict(canonical["current_annotations"][0]),
            CurrentAnnotation,
        )
        reconstructed = annotation_trust_store_from_dict(canonical)
        self.assertEqual(reconstructed.canonical_json(), store.canonical_json())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "annotation-trust-store.json"
            path.write_text(store.canonical_json(), encoding="utf-8")
            loaded = load_annotation_trust_store(path)
            self.assertEqual(loaded.canonical_json(), store.canonical_json())
            self.assertEqual(loaded.fingerprint(), store.fingerprint())
            self.assertTrue(
                all(type(key) is TrustedAnnotationKey for key in loaded.keys)
            )
            self.assertTrue(
                all(
                    type(item) is CurrentAnnotation
                    for item in loaded.current_annotations
                )
            )
            self.assertTrue(any(len(key.permitted_roles) == 2 for key in loaded.keys))
            self.assertEqual(loaded.revoked_annotation_sha256s, ("f" * 64,))

            duplicate = root / "duplicate-nested-key.json"
            duplicate.write_text(
                store.canonical_json().replace(
                    '"key_id":"adjudication-key-1"',
                    '"key_id":"adjudication-key-1","key_id":"hidden"',
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                load_annotation_trust_store(duplicate)

            for name, raw in (
                ("pretty", store.canonical_json().replace(",", ", ", 1)),
                ("trailing", store.canonical_json() + "\n"),
            ):
                with self.subTest(name=name):
                    candidate = root / f"{name}-trust-store.json"
                    candidate.write_text(raw, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "not canonical"):
                        load_annotation_trust_store(candidate)

            invalid_payloads = []
            unknown = store.to_canonical_dict()
            unknown["keys"][0]["unknown"] = "forbidden"
            invalid_payloads.append(("nested-unknown", unknown, "unsupported fields"))

            wrong_role = store.to_canonical_dict()
            wrong_role["keys"][0]["permitted_roles"] = ["OWNER"]
            invalid_payloads.append(("wrong-role", wrong_role, "unsupported enum"))

            wrong_annotation_type = store.to_canonical_dict()
            wrong_annotation_type["current_annotations"][0][
                "annotation_type"
            ] = AnnotationType.OBSERVED_TEMPORAL_EVENT.value
            invalid_payloads.append(
                (
                    "wrong-annotation-type",
                    wrong_annotation_type,
                    "supports BALL_FRAME_OBSERVATION only",
                )
            )

            bool_array = store.to_canonical_dict()
            bool_array["current_annotations"] = True
            invalid_payloads.append(("bool-array", bool_array, "must be a JSON array"))

            too_deep = store.to_canonical_dict()
            too_deep["keys"][0]["permitted_roles"] = [
                [[AnnotationAttestationRole.ADJUDICATOR.value]]
            ]
            invalid_payloads.append(("too-deep", too_deep, "exceeds JSON depth"))

            for name, payload, message in invalid_payloads:
                with self.subTest(name=name):
                    candidate = root / f"{name}.json"
                    candidate.write_text(
                        json.dumps(
                            payload,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                            allow_nan=False,
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, message):
                        load_annotation_trust_store(candidate)

            invalid_raw_payloads = (
                ("invalid-utf8", b"\xff", "valid UTF-8 JSON"),
                ("array-root", b"[]", "root must be an object"),
                (
                    "json-number",
                    b'{"current_annotations":[],"keyring_id":"keyring",'
                    b'"keys":[],"revoked_annotation_sha256s":[],'
                    b'"schema_version":2}',
                    "cannot contain JSON numbers",
                ),
            )
            for name, raw, message in invalid_raw_payloads:
                with self.subTest(name=name):
                    candidate = root / f"{name}.json"
                    candidate.write_bytes(raw)
                    with self.assertRaisesRegex(ValueError, message):
                        load_annotation_trust_store(candidate)

            unsorted_keys = store.to_canonical_dict()
            unsorted_keys["keys"].reverse()
            unsorted_path = root / "unsorted-keys.json"
            unsorted_path.write_text(
                json.dumps(
                    unsorted_keys,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "did not reconstruct exactly"):
                load_annotation_trust_store(unsorted_path)

            unsorted_roles = store.to_canonical_dict()
            unsorted_roles["keys"][0]["permitted_roles"] = [
                AnnotationAttestationRole.REVIEWER.value,
                AnnotationAttestationRole.ADJUDICATOR.value,
            ]
            unsorted_roles_path = root / "unsorted-roles.json"
            unsorted_roles_path.write_text(
                json.dumps(
                    unsorted_roles,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "did not reconstruct exactly"):
                load_annotation_trust_store(unsorted_roles_path)

            unsorted_current = store.to_canonical_dict()
            second_current = dict(unsorted_current["current_annotations"][0])
            second_current["annotation_id"] = "truth-0"
            second_current["annotation_sha256"] = "e" * 64
            unsorted_current["current_annotations"] = [
                unsorted_current["current_annotations"][0],
                second_current,
            ]
            unsorted_current_path = root / "unsorted-current.json"
            unsorted_current_path.write_text(
                json.dumps(
                    unsorted_current,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "did not reconstruct exactly"):
                load_annotation_trust_store(unsorted_current_path)

            unsorted_revoked = store.to_canonical_dict()
            unsorted_revoked["revoked_annotation_sha256s"] = ["f" * 64, "e" * 64]
            unsorted_revoked_path = root / "unsorted-revoked.json"
            unsorted_revoked_path.write_text(
                json.dumps(
                    unsorted_revoked,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "did not reconstruct exactly"):
                load_annotation_trust_store(unsorted_revoked_path)

            with patch.object(
                annotation_trust_module,
                "_MAX_ANNOTATION_TRUST_STORE_JSON_NODES",
                1,
            ), self.assertRaisesRegex(ValueError, "JSON node limit"):
                load_annotation_trust_store(path)

            with patch.object(
                annotation_trust_module,
                "_MAX_ANNOTATION_TRUST_STORE_JSON_CONTAINERS",
                1,
            ), self.assertRaisesRegex(ValueError, "JSON container limit"):
                load_annotation_trust_store(path)

    def test_trust_store_arrays_are_preflighted_before_object_construction(
        self,
    ) -> None:
        payload = _store(_annotation()).to_canonical_dict()
        with (
            patch.object(annotation_trust_module, "_MAX_CURRENT_ANNOTATIONS", 0),
            patch.object(
                annotation_trust_module,
                "trusted_annotation_key_from_dict",
            ) as key_parser,
            self.assertRaisesRegex(ValueError, "exceeds 0 current annotations"),
        ):
            annotation_trust_store_from_dict(payload)
        key_parser.assert_not_called()

        self.assertGreater(
            annotation_trust_module._MAX_ANNOTATION_TRUST_STORE_BYTES,
            2 * 1024 * 1024,
        )
        self.assertGreater(
            annotation_trust_module._MAX_ANNOTATION_TRUST_STORE_JSON_NODES,
            50_000,
        )
        self.assertEqual(
            annotation_trust_module._MAX_ANNOTATION_TRUST_STORE_JSON_CONTAINERS,
            4
            + (2 * annotation_trust_module._MAX_TRUSTED_KEYS)
            + annotation_trust_module._MAX_CURRENT_ANNOTATIONS,
        )
        with tempfile.TemporaryDirectory() as directory:
            oversized = Path(directory) / "oversized-trust-store.json"
            with oversized.open("wb") as output:
                output.truncate(
                    annotation_trust_module._MAX_ANNOTATION_TRUST_STORE_BYTES + 1
                )
            with self.assertRaisesRegex(ValueError, "byte limit"):
                load_annotation_trust_store(oversized)

    def test_policy_and_trust_store_loaders_reject_links_and_replacement(self) -> None:
        store = _store(_annotation())
        policy = _policy(store)
        cases = (
            (
                "policy",
                policy.canonical_json().encode("utf-8"),
                load_annotation_verification_policy,
            ),
            (
                "trust-store",
                store.canonical_json().encode("utf-8"),
                load_annotation_trust_store,
            ),
        )
        for _, _, loader in cases:
            with self.subTest(loader=loader.__name__, shape="relative-path"):
                with self.assertRaises(ProtectedFileError) as caught:
                    loader(Path("relative-protected-input.json"))
                self.assertEqual(caught.exception.code, PROTECTED_FILE_INPUT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, raw, loader in cases:
                with self.subTest(name=name):
                    path = root / f"{name}.json"
                    path.write_bytes(raw)

                    symlink = root / f"{name}-symlink.json"
                    symlink.symlink_to(path)
                    with self.assertRaisesRegex(
                        ValueError,
                        "non-symlink regular file",
                    ):
                        loader(symlink)

                    hardlink = root / f"{name}-hardlink.json"
                    os.link(path, hardlink)
                    try:
                        with self.assertRaisesRegex(
                            ValueError,
                            "exactly one filesystem link",
                        ):
                            loader(hardlink)
                    finally:
                        hardlink.unlink()

                    replacement = root / f"{name}-replacement.json"
                    replacement.write_bytes(raw)
                    real_open = os.open
                    replaced = False

                    def replace_after_open(target: object, flags: int) -> int:
                        nonlocal replaced
                        descriptor = real_open(target, flags)
                        if not replaced:
                            os.replace(replacement, path)
                            replaced = True
                        return descriptor

                    with (
                        patch.object(
                            annotation_trust_module.os,
                            "open",
                            side_effect=replace_after_open,
                        ),
                        self.assertRaisesRegex(ValueError, "changed"),
                    ):
                        loader(path)

    def test_trust_store_growth_during_read_is_rejected(self) -> None:
        store = _store(_annotation())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "annotation-trust-store.json"
            path.write_text(store.canonical_json(), encoding="utf-8")
            real_read = os.read
            mutated = False

            def grow_after_read(descriptor: int, count: int) -> bytes:
                nonlocal mutated
                chunk = real_read(descriptor, count)
                if chunk and not mutated:
                    mutated = True
                    with path.open("ab") as output:
                        output.write(b" ")
                return chunk

            with (
                patch.object(
                    annotation_trust_module.os,
                    "read",
                    side_effect=grow_after_read,
                ),
                self.assertRaisesRegex(ValueError, "grew while being read"),
            ):
                load_annotation_trust_store(path)

    def test_protected_generation_loader_is_exact_bounded_and_race_safe(self) -> None:
        annotation = _annotation()
        store = _store(annotation)
        policy = _policy(store)
        generation = _protected_configuration_generation(store, policy)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "current-generation.json"
            path.write_text(generation.canonical_json(), encoding="utf-8")
            self.assertEqual(
                load_protected_annotation_configuration_generation(path),
                generation,
            )

            duplicate = root / "duplicate.json"
            duplicate.write_text(
                generation.canonical_json().replace(
                    '"schema_version":"2.0"',
                    '"schema_version":"2.0","schema_version":"hidden"',
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                load_protected_annotation_configuration_generation(duplicate)

            noncanonical = root / "noncanonical.json"
            noncanonical.write_text(
                generation.canonical_json().replace(",", ", ", 1),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "NONCANONICAL_JSON"):
                load_protected_annotation_configuration_generation(noncanonical)

            trailing = root / "trailing.json"
            trailing.write_text(
                generation.canonical_json() + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "NONCANONICAL_JSON"):
                load_protected_annotation_configuration_generation(trailing)

            unknown = root / "unknown.json"
            unknown_payload = generation.to_canonical_dict()
            unknown_payload["dataset_pin"] = "bad"
            unknown.write_text(
                json.dumps(
                    unknown_payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unsupported fields"):
                load_protected_annotation_configuration_generation(unknown)

            array = root / "array.json"
            array.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "root must be an object"):
                load_protected_annotation_configuration_generation(array)

            invalid_utf8 = root / "invalid-utf8.json"
            invalid_utf8.write_bytes(b'{"bad":"\xff"}')
            with self.assertRaisesRegex(ValueError, "valid UTF-8 JSON"):
                load_protected_annotation_configuration_generation(invalid_utf8)

            oversize = root / "oversize.json"
            with oversize.open("wb") as output:
                output.truncate(64 * 1024 + 1)
            with self.assertRaisesRegex(ValueError, "byte limit"):
                load_protected_annotation_configuration_generation(oversize)

            symlink = root / "symlink.json"
            symlink.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                load_protected_annotation_configuration_generation(symlink)

            hardlink = root / "hardlink.json"
            os.link(path, hardlink)
            try:
                with self.assertRaisesRegex(ValueError, "exactly one filesystem link"):
                    load_protected_annotation_configuration_generation(hardlink)
            finally:
                hardlink.unlink()

            if hasattr(os, "mkfifo"):
                fifo = root / "generation.fifo"
                os.mkfifo(fifo)
                started = time.monotonic()
                with self.assertRaisesRegex(
                    ValueError,
                    "non-symlink regular file",
                ):
                    load_protected_annotation_configuration_generation(fifo)
                self.assertLess(time.monotonic() - started, 2.0)

            replacement = root / "replacement.json"
            replacement.write_text(
                replace(
                    generation,
                    evaluator_artifact_sha256="f" * 64,
                ).canonical_json(),
                encoding="utf-8",
            )
            path.write_text(generation.canonical_json(), encoding="utf-8")
            real_open = os.open

            def replace_after_open(target: object, flags: int) -> int:
                descriptor = real_open(target, flags)
                os.replace(replacement, path)
                return descriptor

            with patch.object(
                annotation_trust_module.os,
                "open",
                side_effect=replace_after_open,
            ), self.assertRaisesRegex(ValueError, "changed"):
                load_protected_annotation_configuration_generation(path)

            path.write_text(generation.canonical_json(), encoding="utf-8")
            real_read = os.read
            mutated = False

            def grow_after_read(descriptor: int, count: int) -> bytes:
                nonlocal mutated
                chunk = real_read(descriptor, count)
                if chunk and not mutated:
                    mutated = True
                    with path.open("ab") as output:
                        output.write(b" ")
                return chunk

            with patch.object(
                annotation_trust_module.os,
                "read",
                side_effect=grow_after_read,
            ), self.assertRaisesRegex(ValueError, "grew while being read"):
                load_protected_annotation_configuration_generation(path)

    def test_forged_signature_and_principal_key_binding_are_rejected(self) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        forged = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
            private_key=FORGED_PRIVATE_KEY,
        )
        mismatched_principal_key = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
            private_key=ADJUDICATION_PRIVATE_KEY,
            key_id="adjudication-key-1",
        )
        wrong_domain = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
            trust_domain_id="another-annotation-keyring",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaisesRegex(
                AnnotationTrustError,
                "signature is invalid",
            ):
                _verify(
                    _store(annotation),
                    (annotation,),
                    (forged,),
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "trust domain"):
                _verify(
                    _store(annotation),
                    (annotation,),
                    (wrong_domain,),
                    root,
                )
            with self.assertRaisesRegex(
                AnnotationTrustError,
                "trusted key principal",
            ):
                _verify(
                    _store(annotation),
                    (annotation,),
                    (mismatched_principal_key,),
                    root,
                )

        reviewer_key = _key(AnnotationAttestationRole.REVIEWER)
        adjudicator_key = _key(AnnotationAttestationRole.ADJUDICATOR)
        with self.assertRaisesRegex(ValueError, "one public key"):
            _store(
                annotation,
                keys=(
                    reviewer_key,
                    replace(
                        adjudicator_key,
                        public_key_base64=reviewer_key.public_key_base64,
                    ),
                ),
            )

    def test_trust_store_collection_limits_accept_boundary_and_reject_overflow(self) -> None:
        annotation = _annotation()
        store = _store(annotation)
        extra_key = TrustedAnnotationKey(
            key_id="extra-review-key",
            principal_id="extra-reviewer",
            permitted_roles=(AnnotationAttestationRole.REVIEWER,),
            public_key_base64=_public_key_base64(FORGED_PRIVATE_KEY),
            valid_from="2026-01-01",
            valid_until="2026-12-31",
            compromised_on=None,
        )
        with patch.object(annotation_trust_module, "_MAX_TRUSTED_KEYS", 2):
            self.assertEqual(replace(store, keys=store.keys).keys, store.keys)
            with self.assertRaisesRegex(ValueError, "cannot exceed 2"):
                replace(store, keys=store.keys + (extra_key,))

        extra_current = CurrentAnnotation(
            AnnotationType.BALL_FRAME_OBSERVATION,
            "truth-extra",
            "b" * 64,
        )
        with patch.object(annotation_trust_module, "_MAX_CURRENT_ANNOTATIONS", 1):
            self.assertEqual(
                replace(store, current_annotations=store.current_annotations).current_annotations,
                store.current_annotations,
            )
            with self.assertRaisesRegex(ValueError, "cannot exceed 1"):
                replace(
                    store,
                    current_annotations=store.current_annotations + (extra_current,),
                )

        with patch.object(annotation_trust_module, "_MAX_REVOKED_ANNOTATIONS", 1):
            boundary = replace(store, revoked_annotation_sha256s=("b" * 64,))
            self.assertEqual(boundary.revoked_annotation_sha256s, ("b" * 64,))
            with self.assertRaisesRegex(ValueError, "cannot exceed 1"):
                replace(
                    store,
                    revoked_annotation_sha256s=("b" * 64, "c" * 64),
                )

    def test_verification_bounds_run_before_fingerprints_and_signatures(self) -> None:
        self.assertEqual(annotation_trust_module._MAX_ANNOTATIONS, 100_000)
        self.assertEqual(annotation_trust_module._MAX_ATTESTATIONS, 200_000)
        self.assertEqual(annotation_trust_module._MAX_EVIDENCE_FILES, 256)
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        attestation = _attestations(annotation)[0]
        bounded_store = _store(annotation)
        bounded_policy = _policy(bounded_store)
        with patch.object(
            annotation_trust_module,
            "_MAX_ANNOTATIONS",
            1,
        ), patch.object(
            annotation_trust_module,
            "_MAX_ATTESTATIONS",
            1,
        ), patch.object(
            annotation_trust_module,
            "_MAX_EVIDENCE_FILES",
            1,
        ):
            self.assertEqual(
                annotation_trust_module._preflight_annotation_verification_bounds(
                    (annotation,),
                    (attestation,),
                ),
                (REVIEW_REF,),
            )
            with patch.object(
                BallFrameAnnotationV2,
                "fingerprint",
                side_effect=AssertionError("fingerprint must not run"),
            ):
                with self.assertRaises(AnnotationTrustError) as annotations_over:
                    bounded_store.verify_annotation_set(
                        (annotation, annotation),
                        (),
                        evidence_store_root=Path("unused"),
                        verification_policy=bounded_policy,
                        expected_verification_policy_sha256="0" * 64,
                        protected_configuration_generation_path=Path("unused"),
                        evaluator_artifact_sha256=EVALUATOR_ARTIFACT_SHA256,
                        requested_truth_policy="REVIEWED_OR_ADJUDICATED",
                    )
                self.assertEqual(annotations_over.exception.code, "ANNOTATION_COUNT")

                with self.assertRaises(AnnotationTrustError) as attestations_over:
                    bounded_store.verify_annotation_set(
                        (annotation,),
                        (attestation, attestation),
                        evidence_store_root=Path("unused"),
                        verification_policy=bounded_policy,
                        expected_verification_policy_sha256="0" * 64,
                        protected_configuration_generation_path=Path("unused"),
                        evaluator_artifact_sha256=EVALUATOR_ARTIFACT_SHA256,
                        requested_truth_policy="REVIEWED_OR_ADJUDICATED",
                    )
                self.assertEqual(
                    attestations_over.exception.code,
                    "ANNOTATION_ATTESTATION_COUNT",
                )

            second = replace(
                annotation,
                annotation_id="truth-2",
                review_evidence_refs=("sha256:" + "f" * 64,),
            )
            with self.assertRaises(AnnotationTrustError) as evidence_over:
                annotation_trust_module._preflight_annotation_verification_bounds(
                    (annotation, second),
                    (),
                )
            self.assertEqual(
                evidence_over.exception.code,
                "ANNOTATION_COUNT",
            )

        with patch.object(annotation_trust_module, "_MAX_EVIDENCE_FILES", 1):
            second = replace(
                annotation,
                annotation_id="truth-2",
                review_evidence_refs=("sha256:" + "f" * 64,),
            )
            with self.assertRaises(AnnotationTrustError) as evidence_over:
                annotation_trust_module._preflight_annotation_verification_bounds(
                    (annotation, second),
                    (),
                )
            self.assertEqual(
                evidence_over.exception.code,
                "ANNOTATION_EVIDENCE_COUNT",
            )

        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            annotation_trust_module._preflight_annotation_verification_bounds(
                [annotation],
                (),
            )

        attestations = _attestations(_annotation())
        with patch.object(annotation_trust_module, "_MAX_ATTESTATIONS", 2):
            self.assertRegex(
                annotation_attestation_set_fingerprint(attestations),
                r"^[0-9a-f]{64}$",
            )
            with self.assertRaisesRegex(ValueError, "cannot exceed 2"):
                annotation_attestation_set_fingerprint(
                    attestations + (attestations[0],)
                )

    def test_changed_annotation_and_stale_or_revoked_versions_are_rejected(self) -> None:
        original = _annotation()
        changed = replace(original, center=PixelPoint(101, 200))
        changed_attestations = tuple(
            _attestation(
                changed,
                attestation.role,
                attestation.principal_id,
                message_annotation=original,
            )
            for attestation in _attestations(changed)
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaisesRegex(AnnotationTrustError, "signature is invalid"):
                _verify(
                    _store(changed),
                    (changed,),
                    changed_attestations,
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "not current"):
                _verify(
                    _store(original),
                    (changed,),
                    _attestations(changed),
                    root,
                )
            revoked_store = _store(
                original,
                current_annotations=(),
                revoked_annotation_sha256s=(original.fingerprint(),),
            )
            with self.assertRaisesRegex(AnnotationTrustError, "revoked"):
                _verify(
                    revoked_store,
                    (original,),
                    _attestations(original),
                    root,
                )

    def test_missing_extra_and_role_inappropriate_attestations_fail_closed(self) -> None:
        annotation = _annotation()
        reviewer, adjudicator = _attestations(annotation)
        reviewer_only_adjudication_key = _key(
            AnnotationAttestationRole.ADJUDICATOR,
            permitted_roles=(AnnotationAttestationRole.REVIEWER,),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaisesRegex(AnnotationTrustError, "missing required"):
                _verify(
                    _store(annotation),
                    (annotation,),
                    (reviewer,),
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "undeclared"):
                reviewed = _annotation(review_state=ReviewState.REVIEWED)
                _verify(
                    _store(reviewed),
                    (reviewed,),
                    _attestations(reviewed) + (adjudicator,),
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "not permitted"):
                store = _store(
                    annotation,
                    keys=(
                        _key(AnnotationAttestationRole.REVIEWER),
                        reviewer_only_adjudication_key,
                    ),
                )
                _verify(
                    store,
                    (annotation,),
                    (reviewer, adjudicator),
                    root,
                )

    def test_every_declared_reviewer_requires_an_individual_trusted_signature(self) -> None:
        annotation = replace(
            _annotation(review_state=ReviewState.REVIEWED),
            reviewer_ids=("reviewer-1", "reviewer-2"),
        )
        first = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-1",
        )
        second = _attestation(
            annotation,
            AnnotationAttestationRole.REVIEWER,
            "reviewer-2",
            private_key=SECOND_REVIEW_PRIVATE_KEY,
            key_id="review-key-2",
        )
        store = _store(
            annotation,
            keys=(
                _key(AnnotationAttestationRole.REVIEWER),
                TrustedAnnotationKey(
                    key_id="review-key-2",
                    principal_id="reviewer-2",
                    permitted_roles=(AnnotationAttestationRole.REVIEWER,),
                    public_key_base64=_public_key_base64(
                        SECOND_REVIEW_PRIVATE_KEY
                    ),
                    valid_from="2026-01-01",
                    valid_until="2026-12-31",
                    compromised_on=None,
                ),
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaisesRegex(AnnotationTrustError, "reviewer-2"):
                _verify(
                    store,
                    (annotation,),
                    (first,),
                    root,
                )
            verified = _verify(
                store,
                (annotation,),
                (first, second),
                root,
            )
        self.assertRegex(verified.attestation_set_sha256, r"^[0-9a-f]{64}$")

    def test_key_dates_future_signatures_and_compromise_are_enforced(self) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        base_attestation = _attestations(annotation)
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaisesRegex(AnnotationTrustError, "not valid"):
                store = _store(
                    annotation,
                    keys=(
                        _key(
                            AnnotationAttestationRole.REVIEWER,
                            valid_from="2027-01-01",
                            valid_until=None,
                        ),
                    ),
                )
                _verify(
                    store,
                    (annotation,),
                    base_attestation,
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "postdate"):
                _verify(
                    _store(annotation),
                    (annotation,),
                    (
                        _attestation(
                            annotation,
                            AnnotationAttestationRole.REVIEWER,
                            "reviewer-1",
                            signed_on="2099-12-31",
                        ),
                    ),
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "compromised"):
                store = _store(
                    annotation,
                    keys=(
                        _key(
                            AnnotationAttestationRole.REVIEWER,
                            compromised_on="2020-01-01",
                        ),
                    ),
                )
                _verify(
                    store,
                    (annotation,),
                    base_attestation,
                    root,
                )
            with self.assertRaisesRegex(AnnotationTrustError, "not valid"):
                store = _store(
                    annotation,
                    keys=(
                        _key(
                            AnnotationAttestationRole.REVIEWER,
                            valid_from="2025-01-01",
                            valid_until="2025-12-31",
                        ),
                    ),
                )
                _verify(store, (annotation,), base_attestation, root)

    def test_completion_time_is_reported_and_midnight_expiry_fails_closed(self) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        store = _store(annotation)
        attestations = _attestations(annotation)
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            active_policy = _policy(
                store,
                valid_from="2026-07-11",
                valid_until="2026-07-12",
            )
            with patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-11T23:59:59.900000Z", date(2026, 7, 11)),
                    ("2026-07-11T23:59:59.950000Z", date(2026, 7, 11)),
                ),
            ):
                verified = _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=active_policy,
                )
            self.assertEqual(
                verified.verified_at_utc,
                "2026-07-11T23:59:59.950000Z",
            )

            expiring_policy = _policy(
                store,
                valid_from="2026-07-11",
                valid_until="2026-07-11",
            )
            with patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-11T23:59:59.900000Z", date(2026, 7, 11)),
                    ("2026-07-12T00:00:00.100000Z", date(2026, 7, 12)),
                ),
            ), self.assertRaisesRegex(AnnotationTrustError, "completion date"):
                _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=expiring_policy,
                )

    def test_midnight_rechecks_currentness_and_key_compromise(self) -> None:
        annotation = _annotation(review_state=ReviewState.REVIEWED)
        store = _store(annotation)
        policy = _policy(
            store,
            valid_from="2026-07-11",
            valid_until="2026-07-12",
        )
        attestations = _attestations(annotation)
        currentness_check = (
            annotation_trust_module._enforce_annotation_currentness_and_truth_policy
        )
        key_check = annotation_trust_module._enforce_key_not_compromised
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-11T23:59:59.900000Z", date(2026, 7, 11)),
                    ("2026-07-12T00:00:00.100000Z", date(2026, 7, 12)),
                    ("2026-07-12T00:00:00.200000Z", date(2026, 7, 12)),
                ),
            ), patch.object(
                annotation_trust_module,
                "_enforce_annotation_currentness_and_truth_policy",
                wraps=currentness_check,
            ) as currentness_mock, patch.object(
                annotation_trust_module,
                "_enforce_key_not_compromised",
                wraps=key_check,
            ) as key_mock:
                verified = _verify(
                    store,
                    (annotation,),
                    attestations,
                    root,
                    policy=policy,
                )
            self.assertEqual(currentness_mock.call_count, 2)
            self.assertEqual(key_mock.call_count, 2)
            self.assertEqual(
                verified.verified_at_utc,
                "2026-07-12T00:00:00.200000Z",
            )

            compromised_store = _store(
                annotation,
                keys=(
                    _key(
                        AnnotationAttestationRole.REVIEWER,
                        compromised_on="2026-07-12",
                    ),
                ),
            )
            compromised_policy = _policy(
                compromised_store,
                valid_from="2026-07-11",
                valid_until="2026-07-12",
            )
            with patch.object(
                annotation_trust_module,
                "_canonical_utc_now",
                side_effect=(
                    ("2026-07-11T23:59:59.900000Z", date(2026, 7, 11)),
                    ("2026-07-12T00:00:00.100000Z", date(2026, 7, 12)),
                ),
            ), self.assertRaisesRegex(AnnotationTrustError, "compromised"):
                _verify(
                    compromised_store,
                    (annotation,),
                    attestations,
                    root,
                    policy=compromised_policy,
                )

    def test_missing_wrong_generation_and_capture_evidence_are_rejected(self) -> None:
        annotation = _annotation()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            with self.assertRaises(AnnotationTrustError) as missing:
                _verify(
                    _store(annotation),
                    (annotation,),
                    _attestations(annotation),
                    root,
                )
            self.assertEqual(
                missing.exception.code,
                "ANNOTATION_EVIDENCE_LOCK_MISSING",
            )

        required_digests = tuple(sorted((REVIEW_SHA, ADJUDICATION_SHA)))
        required_generation_id = generation_id_for(required_digests)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            wrong_descriptor = GenerationDescriptor.build((REVIEW_SHA,))
            _publish_evidence_generation(
                root,
                (REVIEW_BYTES,),
                path_generation_id=required_generation_id,
                descriptor=wrong_descriptor,
            )
            with self.assertRaises(AnnotationTrustError) as mismatch:
                _verify(
                    _store(annotation),
                    (annotation,),
                    _attestations(annotation),
                    root,
                )
            self.assertEqual(
                mismatch.exception.code,
                "ANNOTATION_EVIDENCE_GENERATION_MISMATCH",
            )

        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            object_path = (
                root
                / "generations"
                / required_generation_id
                / "objects"
                / REVIEW_SHA
            )
            object_path.write_bytes(b"wrong")
            with self.assertRaises(AnnotationTrustError) as wrong_hash:
                _verify(
                    _store(annotation),
                    (annotation,),
                    _attestations(annotation),
                    root,
                )
            self.assertEqual(
                wrong_hash.exception.code,
                "ANNOTATION_EVIDENCE_HASH",
            )

        capture_annotation = _annotation(
            frame=_frame(
                duplicate_kind=FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE,
                duplicate_of_frame_index=0,
                capture_refs=(CAPTURE_REF,),
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            with self.assertRaises(AnnotationTrustError) as missing_capture_generation:
                _verify(
                    _store(capture_annotation),
                    (capture_annotation,),
                    _attestations(capture_annotation),
                    root,
                )
            self.assertEqual(
                missing_capture_generation.exception.code,
                "ANNOTATION_EVIDENCE_LOCK_MISSING",
            )
            _publish_evidence_generation(
                root,
                (REVIEW_BYTES, ADJUDICATION_BYTES, CAPTURE_BYTES),
            )
            verified = _verify(
                _store(capture_annotation),
                (capture_annotation,),
                _attestations(capture_annotation),
                root,
            )
            self.assertIn(CAPTURE_REF, verified.verified_evidence_refs)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires POSIX FIFO support")
    def test_fifo_race_shape_and_excessive_evidence_count_fail_without_blocking(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            generation_id = generation_id_for((REVIEW_SHA,))
            evidence_object = (
                root / "generations" / generation_id / "objects" / REVIEW_SHA
            )
            evidence_object.unlink()
            os.mkfifo(evidence_object)
            started = time.monotonic()
            with self.assertRaises(AnnotationTrustError) as fifo:
                verify_annotation_evidence(
                    (REVIEW_REF,),
                    evidence_store_root=root,
                )
            self.assertEqual(fifo.exception.code, "ANNOTATION_EVIDENCE_SHAPE")
            self.assertLess(time.monotonic() - started, 5.0)

        too_many = tuple(
            "sha256:" + f"{index:064x}" for index in range(257)
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(AnnotationTrustError, "between 1 and 256"):
                verify_annotation_evidence(
                    too_many,
                    evidence_store_root=Path(directory),
                )

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_evidence_store_root_symlink_and_per_file_size_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            resident_root = parent / "resident"
            _evidence_store_root(str(resident_root))
            linked_root = parent / "linked"
            linked_root.symlink_to(resident_root, target_is_directory=True)
            with self.assertRaises(AnnotationTrustError) as linked:
                verify_annotation_evidence(
                    (REVIEW_REF,),
                    evidence_store_root=linked_root,
                )
            self.assertEqual(linked.exception.code, "ANNOTATION_EVIDENCE_STORE")

        oversized_payload = b"x" * (16 * 1024 * 1024 + 1)
        oversized_sha256 = hashlib.sha256(oversized_payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            _publish_evidence_generation(root, (oversized_payload,))
            with self.assertRaises(AnnotationTrustError) as oversized:
                verify_annotation_evidence(
                    ("sha256:" + oversized_sha256,),
                    evidence_store_root=root,
                )
            self.assertEqual(oversized.exception.code, "ANNOTATION_EVIDENCE_SIZE")

    def test_evidence_exact_membership_single_lease_and_aggregate_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            contents = (b"first!", b"second")
            descriptor = _publish_evidence_generation(root, contents)
            digests = descriptor.object_sha256s
            with patch.object(
                annotation_trust_module,
                "generation_read_lease",
                wraps=annotation_trust_module.generation_read_lease,
            ) as lease_mock, patch.object(
                annotation_trust_module,
                "_MAX_TOTAL_EVIDENCE_BYTES",
                10,
            ), self.assertRaisesRegex(AnnotationTrustError, "total byte limit"):
                annotation_trust_module._verify_annotation_evidence_sync(
                    root,
                    digests,
                    descriptor.generation_id,
                )
            lease_mock.assert_called_once_with(root, descriptor.generation_id)

            with patch.object(
                annotation_trust_module,
                "_MAX_TOTAL_EVIDENCE_BYTES",
                100,
            ), self.assertRaises(AnnotationTrustError) as membership:
                annotation_trust_module._verify_annotation_evidence_sync(
                    root,
                    (digests[0],),
                    descriptor.generation_id,
                )
            self.assertEqual(
                membership.exception.code,
                "ANNOTATION_EVIDENCE_GENERATION_MEMBERSHIP",
            )

    def test_evidence_absolute_timeout_terminates_worker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = _evidence_store_root(directory)
            children_before = {
                child.pid for child in multiprocessing.active_children()
            }
            started = time.monotonic()
            with patch.object(
                annotation_trust_module,
                "_EVIDENCE_TIMEOUT_SECONDS",
                1e-9,
            ), self.assertRaisesRegex(AnnotationTrustError, "absolute deadline"):
                verify_annotation_evidence(
                    (REVIEW_REF,),
                    evidence_store_root=root,
                )
            self.assertLess(time.monotonic() - started, 5.0)
            leaked_children = [
                child
                for child in multiprocessing.active_children()
                if child.pid not in children_before
            ]
            self.assertEqual(leaked_children, [])

    def test_evidence_worker_ipc_schema_is_strict_and_bounded(self) -> None:
        annotation_trust_module._validate_annotation_evidence_worker_result(
            {"ok": True, "code": "", "message": ""}
        )
        annotation_trust_module._validate_annotation_evidence_worker_result(
            {
                "ok": False,
                "code": "ANNOTATION_EVIDENCE_HASH",
                "message": "hash mismatch",
            }
        )
        invalid = (
            {"ok": 1, "code": "", "message": ""},
            {"ok": True, "code": "SUCCESS", "message": ""},
            {"ok": False, "code": "lowercase", "message": "bad"},
            {"ok": False, "code": "A" * 65, "message": "bad"},
            {"ok": False, "code": "ERROR", "message": ""},
            {"ok": False, "code": "ERROR", "message": "x" * 513},
            {"ok": False, "code": "ERROR", "message": "bad", "extra": True},
        )
        for result in invalid:
            with self.subTest(result=result), self.assertRaises(
                AnnotationTrustError
            ) as caught:
                annotation_trust_module._validate_annotation_evidence_worker_result(
                    result
                )
            self.assertEqual(caught.exception.code, "ANNOTATION_EVIDENCE_WORKER")


if __name__ == "__main__":
    unittest.main()
