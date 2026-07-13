from __future__ import annotations

from dataclasses import replace
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

if __package__:
    from .test_annotation_trust import REVIEW_BYTES, REVIEW_SHA
    from .test_label_bundle import (
        _attest_bundle,
        _bundle,
        _snapshot,
    )
else:
    from test_annotation_trust import REVIEW_BYTES, REVIEW_SHA  # type: ignore[no-redef]
    from test_label_bundle import (  # type: ignore[no-redef]
        _attest_bundle,
        _bundle,
        _snapshot,
    )

from vision_scoring.annotation_trust import AnnotationAttestation
from vision_scoring.annotations import BallFrameAnnotationV2
from vision_scoring.ball_label_pack import (
    BallLabelPackError,
    BallLabelPackRootV1,
    load_ball_label_pack,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    ImmutableStoreError,
    bootstrap_generation_lock,
)
from vision_scoring.label_bundle import (
    BallAnnotationReferenceV1,
    BallFrameEnumerationV1,
    CausalBallLabelBundleAttestationV1,
    CausalBallLabelBundleTrustSnapshotV1,
    CausalBallLabelBundleV1,
    LabelBundleSplit,
)


def _replace_reference(
    statement: CausalBallLabelBundleV1,
    *,
    frame_index: int,
    reference_index: int,
    reference: BallAnnotationReferenceV1,
) -> CausalBallLabelBundleV1:
    frames = list(statement.frames)
    selected = frames[frame_index]
    references = list(selected.annotations)
    references[reference_index] = reference
    frames[frame_index] = replace(selected, annotations=tuple(references))
    return replace(statement, frames=tuple(frames))


def _contract_payloads(
    statement: CausalBallLabelBundleV1,
    annotations: tuple[BallFrameAnnotationV2, ...],
    annotation_attestations: tuple[AnnotationAttestation, ...],
    *,
    curator_attestation: CausalBallLabelBundleAttestationV1 | None = None,
    curator_snapshot: CausalBallLabelBundleTrustSnapshotV1 | None = None,
) -> tuple[BallLabelPackRootV1, dict[str, bytes]]:
    selected_attestation = curator_attestation or _attest_bundle(statement)
    selected_snapshot = curator_snapshot or _snapshot(
        statement, selected_attestation
    )
    statement_raw = statement.to_json_bytes()
    curator_raw = selected_attestation.to_json_bytes()
    snapshot_raw = selected_snapshot.to_json_bytes()
    root = BallLabelPackRootV1(
        label_bundle_statement_ref=(
            "sha256:" + hashlib.sha256(statement_raw).hexdigest()
        ),
        curator_attestation_ref=(
            "sha256:" + hashlib.sha256(curator_raw).hexdigest()
        ),
        curator_trust_snapshot_ref=(
            "sha256:" + hashlib.sha256(snapshot_raw).hexdigest()
        ),
    )
    payloads = {
        hashlib.sha256(statement_raw).hexdigest(): statement_raw,
        hashlib.sha256(curator_raw).hexdigest(): curator_raw,
        hashlib.sha256(snapshot_raw).hexdigest(): snapshot_raw,
    }
    for annotation in annotations:
        raw = annotation.to_json_bytes()
        payloads[hashlib.sha256(raw).hexdigest()] = raw
    for attestation in annotation_attestations:
        raw = attestation.to_json_bytes()
        payloads[hashlib.sha256(raw).hexdigest()] = raw
    root_raw = root.to_json_bytes()
    payloads[hashlib.sha256(root_raw).hexdigest()] = root_raw
    return root, payloads


class BallLabelPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store_root = Path(self.temporary_directory.name) / "label-store"
        (self.store_root / "locks").mkdir(parents=True)
        (self.store_root / "generations").mkdir()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _publish(
        self,
        payloads: dict[str, bytes],
        *,
        descriptor_sha256s: tuple[str, ...] | None = None,
    ) -> GenerationDescriptor:
        digests = descriptor_sha256s or tuple(sorted(payloads))
        descriptor = GenerationDescriptor.build(digests)
        bootstrap_generation_lock(self.store_root, descriptor.generation_id)
        generation = (
            self.store_root / "generations" / descriptor.generation_id
        )
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for digest, payload in payloads.items():
            if digest in digests:
                (objects / digest).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
        return descriptor

    def _valid_generation(
        self,
        *,
        split: LabelBundleSplit = LabelBundleSplit.TRAIN,
    ) -> tuple[
        CausalBallLabelBundleV1,
        tuple[BallFrameAnnotationV2, ...],
        tuple[AnnotationAttestation, ...],
        BallLabelPackRootV1,
        dict[str, bytes],
        GenerationDescriptor,
    ]:
        statement, annotations, raw_attestations = _bundle(
            split=split, all_balls=True
        )
        attestations = tuple(raw_attestations)
        self.assertTrue(
            all(type(item) is AnnotationAttestation for item in attestations)
        )
        root, payloads = _contract_payloads(
            statement,
            annotations,
            attestations,  # type: ignore[arg-type]
        )
        descriptor = self._publish(payloads)
        return (
            statement,
            annotations,
            attestations,  # type: ignore[return-value]
            root,
            payloads,
            descriptor,
        )

    def assert_pack_error(
        self,
        code: str,
        operation: object,
    ) -> BallLabelPackError:
        assert callable(operation)
        with self.assertRaises(BallLabelPackError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_exact_contract_closure_round_trips_and_grants_no_admission(self) -> None:
        (
            statement,
            annotations,
            attestations,
            root,
            payloads,
            descriptor,
        ) = self._valid_generation()
        pack_sha256 = root.fingerprint()

        evidence = load_ball_label_pack(
            label_store_root=self.store_root,
            generation_id=descriptor.generation_id,
            pack_sha256=pack_sha256,
        )

        self.assertEqual(evidence.statement.to_json_bytes(), statement.to_json_bytes())
        self.assertEqual(evidence.annotations, annotations)
        self.assertEqual(
            tuple(item.fingerprint() for item in evidence.annotation_attestations),
            tuple(
                reference.removeprefix("sha256:")
                for frame in statement.frames
                for annotation in frame.annotations
                for reference in annotation.annotation_attestation_refs
            ),
        )
        self.assertEqual(
            {item.fingerprint() for item in evidence.annotation_attestations},
            {item.fingerprint() for item in attestations},
        )
        self.assertEqual(evidence.generation_id, descriptor.generation_id)
        self.assertEqual(evidence.pack_sha256, pack_sha256)
        self.assertEqual(
            evidence.contract_object_sha256s,
            descriptor.object_sha256s,
        )
        self.assertEqual(
            evidence.total_contract_bytes,
            sum(len(item) for item in payloads.values()),
        )
        self.assertIs(evidence.split, LabelBundleSplit.TRAIN)
        self.assertFalse(evidence.admissible_for_training)
        self.assertFalse(evidence.admissible_for_evaluation)
        self.assertFalse(evidence.admissible_for_test)
        self.assertFalse(evidence.admissible_for_deployment)
        self.assertFalse(evidence.admissible_for_live_scoring)
        with self.assertRaises(AttributeError):
            evidence.pack_sha256 = "0" * 64  # type: ignore[misc]
        with self.assertRaises(AttributeError):
            evidence._statement = statement  # type: ignore[attr-defined]

    def test_test_split_is_still_not_training_or_test_admitted(self) -> None:
        _, _, _, root, _, descriptor = self._valid_generation(
            split=LabelBundleSplit.TEST
        )
        evidence = load_ball_label_pack(
            label_store_root=self.store_root,
            generation_id=descriptor.generation_id,
            pack_sha256=root.fingerprint(),
        )
        self.assertIs(evidence.split, LabelBundleSplit.TEST)
        self.assertFalse(evidence.admissible_for_training)
        self.assertFalse(evidence.admissible_for_test)
        self.assertFalse(evidence.admissible_for_evaluation)

    def test_extra_missing_and_physically_missing_objects_fail_closed(self) -> None:
        statement, annotations, raw_attestations = _bundle(all_balls=True)
        attestations = tuple(raw_attestations)
        root, payloads = _contract_payloads(
            statement,
            annotations,
            attestations,  # type: ignore[arg-type]
        )
        pack_sha256 = root.fingerprint()
        child_digest = statement.frames[0].annotations[0].annotation_sha256

        missing_descriptor = tuple(
            digest for digest in sorted(payloads) if digest != child_digest
        )
        descriptor = self._publish(
            payloads,
            descriptor_sha256s=missing_descriptor,
        )
        self.assert_pack_error(
            "BALL_LABEL_PACK_MEMBERSHIP",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=pack_sha256,
            ),
        )

        extra_payloads = dict(payloads)
        extra_payloads[REVIEW_SHA] = REVIEW_BYTES
        extra_descriptor = self._publish(extra_payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_MEMBERSHIP",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=extra_descriptor.generation_id,
                pack_sha256=pack_sha256,
            ),
        )

        exact_descriptor = self._publish(payloads)
        missing_path = (
            self.store_root
            / "generations"
            / exact_descriptor.generation_id
            / "objects"
            / child_digest
        )
        missing_path.unlink()
        error = self.assert_pack_error(
            "BALL_LABEL_PACK_OBJECT_MISSING",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=exact_descriptor.generation_id,
                pack_sha256=pack_sha256,
            ),
        )
        self.assertIsInstance(error.__cause__, ImmutableStoreError)

    def test_root_and_transitive_cross_type_aliases_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "globally distinct"):
            BallLabelPackRootV1(
                label_bundle_statement_ref="sha256:" + "1" * 64,
                curator_attestation_ref="sha256:" + "1" * 64,
                curator_trust_snapshot_ref="sha256:" + "2" * 64,
            )

        statement, annotations, raw_attestations = _bundle(all_balls=True)
        attestations = tuple(raw_attestations)
        first = statement.frames[0].annotations[0]
        second = statement.frames[0].annotations[1]
        aliased = replace(
            second,
            annotation_attestation_refs=(first.annotation_attestation_refs[0],),
        )
        malicious = _replace_reference(
            statement,
            frame_index=0,
            reference_index=1,
            reference=aliased,
        )
        root, payloads = _contract_payloads(
            malicious,
            annotations,
            attestations,  # type: ignore[arg-type]
        )
        exact_closure = {
            root.fingerprint(),
            root.label_bundle_statement_ref.removeprefix("sha256:"),
            root.curator_attestation_ref.removeprefix("sha256:"),
            root.curator_trust_snapshot_ref.removeprefix("sha256:"),
        }
        exact_closure.update(
            reference.annotation_sha256
            for frame in malicious.frames
            for reference in frame.annotations
        )
        exact_closure.update(
            attestation_ref.removeprefix("sha256:")
            for frame in malicious.frames
            for reference in frame.annotations
            for attestation_ref in reference.annotation_attestation_refs
        )
        payloads = {
            digest: raw
            for digest, raw in payloads.items()
            if digest in exact_closure
        }
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_REFERENCE_ALIAS",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

    def test_wrong_child_type_and_fingerprint_are_rejected(self) -> None:
        statement, annotations, raw_attestations = _bundle(all_balls=True)
        attestations = tuple(raw_attestations)
        reference = statement.frames[0].annotations[0]
        attestation_digest = attestations[0].fingerprint()
        wrong_type = replace(
            reference,
            annotation_sha256=attestation_digest,
            annotation_preimage_ref="sha256:" + attestation_digest,
            annotation_attestation_refs=(
                "sha256:" + annotations[0].fingerprint(),
            ),
        )
        malicious = _replace_reference(
            statement,
            frame_index=0,
            reference_index=0,
            reference=wrong_type,
        )
        root, payloads = _contract_payloads(
            malicious,
            annotations,
            attestations,  # type: ignore[arg-type]
        )
        exact_closure = {
            root.fingerprint(),
            root.label_bundle_statement_ref.removeprefix("sha256:"),
            root.curator_attestation_ref.removeprefix("sha256:"),
            root.curator_trust_snapshot_ref.removeprefix("sha256:"),
        }
        exact_closure.update(
            reference.annotation_sha256
            for frame in malicious.frames
            for reference in frame.annotations
        )
        exact_closure.update(
            attestation_ref.removeprefix("sha256:")
            for frame in malicious.frames
            for reference in frame.annotations
            for attestation_ref in reference.annotation_attestation_refs
        )
        payloads = {
            digest: raw
            for digest, raw in payloads.items()
            if digest in exact_closure
        }
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_ANNOTATION_WIRE",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

        _, _, _, valid_root, _, valid_descriptor = self._valid_generation()
        with patch.object(
            BallFrameAnnotationV2,
            "fingerprint",
            return_value="0" * 64,
        ):
            self.assert_pack_error(
                "BALL_LABEL_PACK_ANNOTATION_FINGERPRINT",
                lambda: load_ball_label_pack(
                    label_store_root=self.store_root,
                    generation_id=valid_descriptor.generation_id,
                    pack_sha256=valid_root.fingerprint(),
                ),
            )

    def test_curator_attestation_and_current_snapshot_bind_exactly(self) -> None:
        statement, annotations, raw_attestations = _bundle(all_balls=True)
        annotation_attestations = tuple(raw_attestations)
        valid_curator = _attest_bundle(statement)
        wrong_statement_curator = replace(
            valid_curator,
            statement_sha256="0" * 64,
        )
        snapshot = _snapshot(statement, wrong_statement_curator)
        root, payloads = _contract_payloads(
            statement,
            annotations,
            annotation_attestations,  # type: ignore[arg-type]
            curator_attestation=wrong_statement_curator,
            curator_snapshot=snapshot,
        )
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

        valid_snapshot = _snapshot(statement, valid_curator)
        wrong_current = replace(
            valid_snapshot.current_bundle,
            statement_sha256="1" * 64,
        )
        wrong_snapshot = replace(valid_snapshot, current_bundle=wrong_current)
        root, payloads = _contract_payloads(
            statement,
            annotations,
            annotation_attestations,  # type: ignore[arg-type]
            curator_attestation=valid_curator,
            curator_snapshot=wrong_snapshot,
        )
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

    def test_detached_annotation_attestation_must_bind_its_reference(self) -> None:
        statement, annotations, raw_attestations = _bundle(all_balls=True)
        attestations = list(raw_attestations)
        original = attestations[0]
        malicious_attestation = replace(original, annotation_sha256="0" * 64)
        attestations[0] = malicious_attestation
        reference = statement.frames[0].annotations[0]
        replacement_refs = tuple(
            sorted(
                "sha256:" + malicious_attestation.fingerprint()
                if item == "sha256:" + original.fingerprint()
                else item
                for item in reference.annotation_attestation_refs
            )
        )
        malicious_reference = replace(
            reference,
            annotation_attestation_refs=replacement_refs,
        )
        malicious_statement = _replace_reference(
            statement,
            frame_index=0,
            reference_index=0,
            reference=malicious_reference,
        )
        root, payloads = _contract_payloads(
            malicious_statement,
            annotations,
            tuple(attestations),
        )
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_ANNOTATION_ATTESTATION_BINDING",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

    def test_statement_is_rebuilt_byte_for_byte(self) -> None:
        statement, _, _, root, _, descriptor = self._valid_generation()
        altered = replace(statement, finalized_trace_sha256="0" * 64)
        with patch(
            "vision_scoring.ball_label_pack.build_causal_ball_label_bundle_v1",
            return_value=altered,
        ):
            self.assert_pack_error(
                "BALL_LABEL_PACK_REBUILD",
                lambda: load_ball_label_pack(
                    label_store_root=self.store_root,
                    generation_id=descriptor.generation_id,
                    pack_sha256=root.fingerprint(),
                ),
            )

    def test_object_count_and_size_preflight_precede_contract_parsing(self) -> None:
        _, _, _, root, payloads, descriptor = self._valid_generation()
        with patch(
            "vision_scoring.ball_label_pack.MAX_BALL_LABEL_PACK_OBJECTS",
            len(descriptor.object_sha256s) - 1,
        ), patch(
            "vision_scoring.ball_label_pack.BallLabelPackRootV1.from_json_bytes"
        ) as parser:
            self.assert_pack_error(
                "BALL_LABEL_PACK_OBJECT_COUNT",
                lambda: load_ball_label_pack(
                    label_store_root=self.store_root,
                    generation_id=descriptor.generation_id,
                    pack_sha256=root.fingerprint(),
                ),
            )
            parser.assert_not_called()

        oversized = b"x" * (4 * 1024 + 1)
        digest = hashlib.sha256(oversized).hexdigest()
        oversized_descriptor = self._publish({digest: oversized})
        with patch(
            "vision_scoring.ball_label_pack.BallLabelPackRootV1.from_json_bytes"
        ) as parser:
            self.assert_pack_error(
                "BALL_LABEL_PACK_OBJECT_SIZE",
                lambda: load_ball_label_pack(
                    label_store_root=self.store_root,
                    generation_id=oversized_descriptor.generation_id,
                    pack_sha256=digest,
                ),
            )
            parser.assert_not_called()

        with patch(
            "vision_scoring.ball_label_pack.MAX_BALL_LABEL_PACK_CONTRACT_BYTES",
            sum(len(item) for item in payloads.values()) - 1,
        ), patch.object(BallFrameAnnotationV2, "from_json_bytes") as parser:
            self.assert_pack_error(
                "BALL_LABEL_PACK_TOTAL_SIZE",
                lambda: load_ball_label_pack(
                    label_store_root=self.store_root,
                    generation_id=descriptor.generation_id,
                    pack_sha256=root.fingerprint(),
                ),
            )
            parser.assert_not_called()

    def test_external_evidence_is_absent_and_inclusion_is_rejected(self) -> None:
        _, annotations, _, root, payloads, descriptor = self._valid_generation()
        self.assertTrue(any(item.review_evidence_refs for item in annotations))
        self.assertNotIn(REVIEW_SHA, descriptor.object_sha256s)
        evidence = load_ball_label_pack(
            label_store_root=self.store_root,
            generation_id=descriptor.generation_id,
            pack_sha256=root.fingerprint(),
        )
        self.assertEqual(evidence.annotations, annotations)

        with_evidence = dict(payloads)
        with_evidence[REVIEW_SHA] = REVIEW_BYTES
        evidence_descriptor = self._publish(with_evidence)
        self.assert_pack_error(
            "BALL_LABEL_PACK_MEMBERSHIP",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=evidence_descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )

    def test_external_domain_digest_cannot_alias_a_contract_object(self) -> None:
        statement, annotations, raw_attestations = _bundle(all_balls=True)
        attestations = tuple(raw_attestations)
        # A deliberate cross-domain alias remains forbidden even though the
        # descriptor is otherwise the exact contract closure.
        first_attestation_digest = attestations[0].fingerprint()
        malicious = replace(
            statement,
            annotation_attestation_set_sha256=first_attestation_digest,
        )
        root, payloads = _contract_payloads(
            malicious,
            annotations,
            attestations,  # type: ignore[arg-type]
        )
        descriptor = self._publish(payloads)
        self.assert_pack_error(
            "BALL_LABEL_PACK_FORBIDDEN_OBJECT_ALIAS",
            lambda: load_ball_label_pack(
                label_store_root=self.store_root,
                generation_id=descriptor.generation_id,
                pack_sha256=root.fingerprint(),
            ),
        )


if __name__ == "__main__":
    unittest.main()
