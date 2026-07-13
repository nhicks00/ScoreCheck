from __future__ import annotations

from contextlib import contextmanager
import copy
from dataclasses import FrozenInstanceError, replace
import hashlib
from pathlib import Path
import pickle
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import vision_scoring.training_capture_admission as admission_module
from vision_scoring.annotation_trust import AnnotationMinimumTruthPolicy
from vision_scoring.capture_profile_contracts import (
    CadenceTypeV1,
    CaptureClassificationStatusV1,
    CaptureProfileClassificationV1,
    CaptureSourceClassificationV1,
    CompressionStratumV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
    VideoCodecV1,
    avkans_go_owner_live_1080p30_v1,
    classify_capture_profile_v1,
    mevo_core_owner_live_1080p60_v1,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    ImmutableStoreError,
    bootstrap_generation_lock,
)
from vision_scoring.training_capture_admission import (
    TRAINING_CAPTURE_ADMISSION_ERROR_CODES,
    TrainingCaptureAdmissionError,
    VerifiedTrainingCaptureClassificationV1,
    verify_training_capture_classification_v1,
)
from vision_scoring.training_protected_configuration import (
    CaptureClassificationCurrentPinSetV1,
    CaptureClassificationCurrentPinV1,
    ProtectedTrainingConfigurationGenerationV2,
)


def _digest(value: int) -> str:
    return f"{value:064x}"


def _owner_receipt(
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
    )


def _reclassify(
    receipt: CaptureProfileClassificationV1,
    *,
    cadence_type: CadenceTypeV1 | None = None,
    codec: VideoCodecV1 | None = None,
    source_representation: SourceRepresentationV1 | None = None,
    source_classification: CaptureSourceClassificationV1 | None = None,
    source_provenance_complete: bool | None = None,
) -> CaptureProfileClassificationV1:
    encoder_changes: dict[str, object] = {}
    if cadence_type is not None:
        encoder_changes.update(
            cadence_type=cadence_type,
            cadence_numerator=0,
            cadence_denominator=0,
        )
    if codec is not None:
        encoder_changes["codec"] = codec
    if source_representation is not None:
        encoder_changes["source_representation"] = source_representation
    encoder = replace(receipt.encoder_configuration, **encoder_changes)
    profile = replace(
        receipt.capture_profile,
        encoder_configuration_sha256=encoder.fingerprint(),
    )
    source = replace(
        receipt.source_capture_facts,
        capture_profile_sha256=profile.fingerprint(),
        source_classification=(
            receipt.source_capture_facts.source_classification
            if source_classification is None
            else source_classification
        ),
        source_provenance_complete=(
            receipt.source_capture_facts.source_provenance_complete
            if source_provenance_complete is None
            else source_provenance_complete
        ),
    )
    return classify_capture_profile_v1(encoder, profile, source)


class _Fixture:
    def __init__(
        self,
        root: Path,
        receipts: tuple[CaptureProfileClassificationV1, ...],
        *,
        pin_source_ids: tuple[str, ...] | None = None,
        stored_payloads: tuple[bytes, ...] | None = None,
        extra_store_payloads: tuple[bytes, ...] = (),
    ) -> None:
        self.root = root
        self.store_root = root / "classification-store"
        (self.store_root / "locks").mkdir(parents=True)
        (self.store_root / "generations").mkdir()
        payloads = (
            tuple(receipt.to_json_bytes() for receipt in receipts)
            if stored_payloads is None
            else stored_payloads
        )
        if len(payloads) != len(receipts):
            raise ValueError("stored payloads must align one-for-one with receipts")
        object_sha256s = tuple(
            sorted(hashlib.sha256(payload).hexdigest() for payload in payloads)
        )
        self.pins = tuple(
            sorted(
                (
                    CaptureClassificationCurrentPinV1(
                        source_id=(
                            receipt.source_capture_facts.source_id
                            if pin_source_ids is None
                            else pin_source_ids[index]
                        ),
                        capture_profile_classification_sha256=hashlib.sha256(
                            payloads[index]
                        ).hexdigest(),
                    )
                    for index, receipt in enumerate(receipts)
                ),
                key=lambda pin: pin.canonical_sort_key,
            )
        )
        self.descriptor = GenerationDescriptor.build(object_sha256s)
        self.pin_set = CaptureClassificationCurrentPinSetV1(
            capture_classification_generation_id=self.descriptor.generation_id,
            pins=self.pins,
        )
        bootstrap_generation_lock(self.store_root, self.descriptor.generation_id)
        generation = (
            self.store_root / "generations" / self.descriptor.generation_id
        )
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for payload in (*payloads, *extra_store_payloads):
            (objects / hashlib.sha256(payload).hexdigest()).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(
            self.descriptor.canonical_bytes()
        )

        self.pin_set_path = root / "capture-classification-pins.json"
        self.pin_set_path.write_bytes(self.pin_set.to_json_bytes())
        self.configuration = ProtectedTrainingConfigurationGenerationV2(
            readiness_configuration_generation_sha256=_digest(100),
            training_admission_policy_sha256=_digest(101),
            annotation_configuration_generation_sha256=_digest(102),
            label_bundle_current_pin_set_sha256=_digest(103),
            decoder_runtime_pins_sha256=_digest(104),
            capture_classification_current_pin_set_sha256=(
                self.pin_set.fingerprint()
            ),
            coordinator_source_tree_sha256=_digest(106),
            coordinator_deployment_artifact_sha256=_digest(107),
            trainer_source_tree_sha256=_digest(108),
            environment_lock_sha256=_digest(109),
            requested_truth_policy=(
                AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY
            ),
            governance_domain_id="training-governance-v1",
        )
        self.configuration_path = root / "protected-training-config.json"
        self.configuration_path.write_bytes(self.configuration.to_json_bytes())

    def kwargs(self, source_id: str) -> dict[str, object]:
        return {
            "protected_training_configuration_path": self.configuration_path,
            "capture_classification_current_pin_set_path": self.pin_set_path,
            "capture_classification_store_root": self.store_root,
            "capture_classification_generation_id": self.descriptor.generation_id,
            "source_id": source_id,
            "expected_protected_training_configuration_generation_sha256": (
                self.configuration.fingerprint()
            ),
        }


class TrainingCaptureAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def assert_admission_error(
        self,
        expected_code: str,
        operation: object,
    ) -> TrainingCaptureAdmissionError:
        with self.assertRaises(TrainingCaptureAdmissionError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        self.assertIn(caught.exception.code, TRAINING_CAPTURE_ADMISSION_ERROR_CODES)
        return caught.exception

    def test_mevo_and_avkans_acquire_exact_non_authorizing_evidence(self) -> None:
        mevo = _owner_receipt("stream-1-mevo", mevo=True, offset=10)
        avkans = _owner_receipt("stream-3-avkans", mevo=False, offset=20)
        fixture = _Fixture(self.root, (mevo, avkans))

        expected = (
            ("stream-1-mevo", mevo, TrainingCaptureModeV1.HD_1080P60),
            ("stream-3-avkans", avkans, TrainingCaptureModeV1.HD_1080P30),
        )
        for source_id, receipt, mode in expected:
            with self.subTest(source_id=source_id):
                evidence = verify_training_capture_classification_v1(
                    **fixture.kwargs(source_id)  # type: ignore[arg-type]
                )
                self.assertIs(type(evidence), VerifiedTrainingCaptureClassificationV1)
                self.assertIs(type(evidence.classification), CaptureProfileClassificationV1)
                self.assertEqual(evidence.classification, receipt)
                self.assertIs(evidence.training_capture_mode, mode)
                self.assertEqual(
                    evidence.protected_training_configuration_generation_sha256,
                    fixture.configuration.fingerprint(),
                )
                self.assertEqual(
                    evidence.capture_classification_current_pin_set_sha256,
                    fixture.pin_set.fingerprint(),
                )
                self.assertEqual(
                    evidence.source_classification_proof_set_sha256,
                    receipt.source_classification_proof_set_sha256,
                )
                self.assertEqual(
                    evidence.capture_classification_proof_set_sha256,
                    receipt.capture_classification_proof_set_sha256,
                )
                for authority in (
                    "admissible_for_training",
                    "admissible_for_evaluation",
                    "admissible_for_test",
                    "admissible_for_deployment",
                    "admissible_for_live_scoring",
                ):
                    self.assertIs(getattr(evidence, authority), False)

    def test_abstained_vfr_phone_incomplete_and_unknown_codec_reject(self) -> None:
        base = _owner_receipt("source-1", mevo=False, offset=30)
        cases = (
            _reclassify(base, cadence_type=CadenceTypeV1.VFR),
            _reclassify(
                base,
                source_representation=SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE,
                source_classification=(
                    CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
                ),
                source_provenance_complete=False,
            ),
            _reclassify(base, codec=VideoCodecV1.UNKNOWN),
        )
        for index, receipt in enumerate(cases):
            with self.subTest(index=index, reason=receipt.abstention_reason):
                self.assertIs(
                    receipt.status,
                    CaptureClassificationStatusV1.ABSTAINED,
                )
                case_root = self.root / f"case-{index}"
                case_root.mkdir()
                fixture = _Fixture(case_root, (receipt,))
                self.assert_admission_error(
                    "CAPTURE_ADMISSION_ABSTAINED",
                    lambda: verify_training_capture_classification_v1(
                        **fixture.kwargs("source-1")  # type: ignore[arg-type]
                    ),
                )

    def test_wrong_source_pin_and_independent_configuration_digest_reject(self) -> None:
        receipt = _owner_receipt("real-source", mevo=True, offset=40)
        fixture = _Fixture(self.root, (receipt,))
        self.assert_admission_error(
            "CAPTURE_ADMISSION_SOURCE_NOT_PINNED",
            lambda: verify_training_capture_classification_v1(
                **fixture.kwargs("absent-source")  # type: ignore[arg-type]
            ),
        )
        wrong_expected = fixture.kwargs("real-source")
        wrong_expected[
            "expected_protected_training_configuration_generation_sha256"
        ] = _digest(999)
        self.assert_admission_error(
            "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION_MISMATCH",
            lambda: verify_training_capture_classification_v1(
                **wrong_expected  # type: ignore[arg-type]
            ),
        )

        mismatch_root = self.root / "pin-source-mismatch"
        mismatch_root.mkdir()
        mismatch = _Fixture(
            mismatch_root,
            (receipt,),
            pin_source_ids=("pinned-alias",),
        )
        self.assert_admission_error(
            "CAPTURE_ADMISSION_OBJECT_MISMATCH",
            lambda: verify_training_capture_classification_v1(
                **mismatch.kwargs("pinned-alias")  # type: ignore[arg-type]
            ),
        )

    def test_wrong_pin_set_and_requested_generation_reject_before_store_use(self) -> None:
        receipt = _owner_receipt("source-1", mevo=False, offset=50)
        fixture = _Fixture(self.root, (receipt,))
        changed_pin = CaptureClassificationCurrentPinSetV1(
            capture_classification_generation_id=fixture.pin_set.capture_classification_generation_id,
            pins=(
                replace(
                    fixture.pin_set.pins[0],
                    source_id="different-source",
                ),
            ),
        )
        fixture.pin_set_path.write_bytes(changed_pin.to_json_bytes())
        self.assert_admission_error(
            "CAPTURE_ADMISSION_PIN_SET_MISMATCH",
            lambda: verify_training_capture_classification_v1(
                **fixture.kwargs("source-1")  # type: ignore[arg-type]
            ),
        )
        fixture.pin_set_path.write_bytes(fixture.pin_set.to_json_bytes())
        kwargs = fixture.kwargs("source-1")
        kwargs["capture_classification_generation_id"] = _digest(777)
        with patch.object(
            admission_module,
            "generation_read_lease",
        ) as lease_factory:
            self.assert_admission_error(
                "CAPTURE_ADMISSION_GENERATION_MISMATCH",
                lambda: verify_training_capture_classification_v1(
                    **kwargs  # type: ignore[arg-type]
                ),
            )
            lease_factory.assert_not_called()

    def test_descriptor_must_equal_all_and_only_pinned_objects(self) -> None:
        receipt = _owner_receipt("source-1", mevo=True, offset=60)
        fixture = _Fixture(self.root, (receipt,))

        class FakeLease:
            def __enter__(self) -> FakeLease:
                self.descriptor = SimpleNamespace(
                    object_sha256s=(receipt.fingerprint(), _digest(888))
                )
                return self

            def __exit__(self, *args: object) -> None:
                return None

        with patch.object(
            admission_module,
            "generation_read_lease",
            return_value=FakeLease(),
        ):
            self.assert_admission_error(
                "CAPTURE_ADMISSION_DESCRIPTOR_SET_MISMATCH",
                lambda: verify_training_capture_classification_v1(
                    **fixture.kwargs("source-1")  # type: ignore[arg-type]
                ),
            )

    def test_missing_corrupt_or_invalid_wire_objects_fail_closed(self) -> None:
        receipt = _owner_receipt("source-1", mevo=False, offset=70)
        fixture = _Fixture(self.root, (receipt,))
        object_path = (
            fixture.store_root
            / "generations"
            / fixture.descriptor.generation_id
            / "objects"
            / receipt.fingerprint()
        )
        object_path.unlink()
        self.assert_admission_error(
            "CAPTURE_ADMISSION_STORE",
            lambda: verify_training_capture_classification_v1(
                **fixture.kwargs("source-1")  # type: ignore[arg-type]
            ),
        )
        object_path.write_bytes(b"content with the wrong digest")
        self.assert_admission_error(
            "CAPTURE_ADMISSION_STORE",
            lambda: verify_training_capture_classification_v1(
                **fixture.kwargs("source-1")  # type: ignore[arg-type]
            ),
        )

        wire_root = self.root / "invalid-wire"
        wire_root.mkdir()
        invalid_wire = _Fixture(
            wire_root,
            (receipt,),
            stored_payloads=(b'{}',),
        )
        self.assert_admission_error(
            "CAPTURE_ADMISSION_OBJECT_WIRE",
            lambda: verify_training_capture_classification_v1(
                **invalid_wire.kwargs("source-1")  # type: ignore[arg-type]
            ),
        )

    def test_generation_lease_failures_map_to_stable_store_code(self) -> None:
        receipt = _owner_receipt("source-1", mevo=False, offset=75)
        fixture = _Fixture(self.root, (receipt,))
        with patch.object(
            admission_module,
            "generation_read_lease",
            side_effect=ImmutableStoreError("STORE_SHAPE", "unsafe"),
        ):
            self.assert_admission_error(
                "CAPTURE_ADMISSION_STORE",
                lambda: verify_training_capture_classification_v1(
                    **fixture.kwargs("source-1")  # type: ignore[arg-type]
                ),
            )

        with patch.object(
            admission_module,
            "generation_read_lease",
            side_effect=ValueError("malformed descriptor"),
        ):
            self.assert_admission_error(
                "CAPTURE_ADMISSION_STORE",
                lambda: verify_training_capture_classification_v1(
                    **fixture.kwargs("source-1")  # type: ignore[arg-type]
                ),
            )

    def test_only_selected_bounded_object_is_opened_under_one_lease(self) -> None:
        first = _owner_receipt("source-1", mevo=True, offset=80)
        second = _owner_receipt("source-2", mevo=False, offset=90)
        fixture = _Fixture(self.root, (first, second))
        real_factory = admission_module.generation_read_lease
        observed: list[tuple[str, int]] = []
        lease_entries = 0

        class TrackingLease:
            def __init__(self) -> None:
                self._inner = real_factory(
                    fixture.store_root,
                    fixture.descriptor.generation_id,
                )

            def __enter__(self) -> TrackingLease:
                nonlocal lease_entries
                lease_entries += 1
                self._lease = self._inner.__enter__()
                return self

            def __exit__(self, *args: object) -> None:
                return self._inner.__exit__(*args)

            @property
            def descriptor(self) -> GenerationDescriptor:
                return self._lease.descriptor

            @contextmanager
            def open_verified_object(self, digest: str, *, max_bytes: int):
                observed.append((digest, max_bytes))
                with self._lease.open_verified_object(
                    digest,
                    max_bytes=max_bytes,
                ) as staged:
                    yield staged

        with patch.object(
            admission_module,
            "generation_read_lease",
            side_effect=lambda *_args, **_kwargs: TrackingLease(),
        ):
            evidence = verify_training_capture_classification_v1(
                **fixture.kwargs("source-2")  # type: ignore[arg-type]
            )
        self.assertEqual(lease_entries, 1)
        self.assertEqual(
            observed,
            [(second.fingerprint(), admission_module.MAX_CAPTURE_PROFILE_CONTRACT_BYTES)],
        )
        self.assertEqual(evidence.source_id, "source-2")

    def test_protected_configuration_and_pin_set_are_reloaded_unchanged(self) -> None:
        receipt = _owner_receipt("source-1", mevo=True, offset=110)
        fixture = _Fixture(self.root, (receipt,))
        changed_configuration = replace(
            fixture.configuration,
            governance_domain_id="changed-governance-v1",
        )
        with patch.object(
            admission_module,
            "load_protected_training_configuration_generation_v2",
            side_effect=(fixture.configuration, changed_configuration),
        ):
            self.assert_admission_error(
                "CAPTURE_ADMISSION_PROTECTED_RELOAD_CHANGED",
                lambda: verify_training_capture_classification_v1(
                    **fixture.kwargs("source-1")  # type: ignore[arg-type]
                ),
            )
        changed_pin = replace(
            fixture.pin_set,
            pins=(replace(fixture.pins[0], source_id="changed-source"),),
        )
        with patch.object(
            admission_module,
            "load_capture_classification_current_pin_set_v1",
            side_effect=(fixture.pin_set, changed_pin),
        ):
            self.assert_admission_error(
                "CAPTURE_ADMISSION_PROTECTED_RELOAD_CHANGED",
                lambda: verify_training_capture_classification_v1(
                    **fixture.kwargs("source-1")  # type: ignore[arg-type]
                ),
            )

    def test_evidence_and_authority_fields_are_immutable(self) -> None:
        receipt = _owner_receipt("source-1", mevo=False, offset=120)
        fixture = _Fixture(self.root, (receipt,))
        evidence = verify_training_capture_classification_v1(
            **fixture.kwargs("source-1")  # type: ignore[arg-type]
        )
        with self.assertRaises(FrozenInstanceError):
            evidence.admissible_for_training = True  # type: ignore[misc]
        with self.assertRaises(FrozenInstanceError):
            del evidence.classification  # type: ignore[misc]
        with self.assertRaisesRegex(ValueError, "must be exactly false"):
            replace(evidence, admissible_for_test=True)
        for operation in (
            lambda: pickle.dumps(evidence),
            lambda: copy.copy(evidence),
            lambda: copy.deepcopy(evidence),
        ):
            with self.subTest(operation=operation), self.assertRaises(TypeError):
                operation()

    def test_noncanonical_paths_and_invalid_coordinates_fail_closed(self) -> None:
        receipt = _owner_receipt("source-1", mevo=True, offset=130)
        fixture = _Fixture(self.root, (receipt,))
        relative = fixture.kwargs("source-1")
        relative["protected_training_configuration_path"] = Path("relative.json")
        self.assert_admission_error(
            "CAPTURE_ADMISSION_INPUT",
            lambda: verify_training_capture_classification_v1(
                **relative  # type: ignore[arg-type]
            ),
        )
        symlink = self.root / "config-link.json"
        symlink.symlink_to(fixture.configuration_path)
        linked = fixture.kwargs("source-1")
        linked["protected_training_configuration_path"] = symlink
        self.assert_admission_error(
            "CAPTURE_ADMISSION_PROTECTED_CONFIGURATION",
            lambda: verify_training_capture_classification_v1(
                **linked  # type: ignore[arg-type]
            ),
        )
        pin_symlink = self.root / "pin-set-link.json"
        pin_symlink.symlink_to(fixture.pin_set_path)
        linked_pin = fixture.kwargs("source-1")
        linked_pin["capture_classification_current_pin_set_path"] = pin_symlink
        self.assert_admission_error(
            "CAPTURE_ADMISSION_PIN_SET",
            lambda: verify_training_capture_classification_v1(
                **linked_pin  # type: ignore[arg-type]
            ),
        )
        invalid = fixture.kwargs("source-1")
        invalid["source_id"] = "not valid spaces"
        self.assert_admission_error(
            "CAPTURE_ADMISSION_INPUT",
            lambda: verify_training_capture_classification_v1(
                **invalid  # type: ignore[arg-type]
            ),
        )


if __name__ == "__main__":
    unittest.main()
