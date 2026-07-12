from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import replace
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

import vision_scoring.rights_trust as rights_trust_module
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    ImmutableStoreError,
    bootstrap_generation_lock,
    generation_id_for,
    generation_read_lease,
    generation_write_lock,
)
from vision_scoring.rights import (
    ParticipantAgeStatus,
    PermittedUse,
    RightsBasis,
    RightsDecision,
    RightsDecisionState,
)
from vision_scoring.rights_trust import (
    CurrentRightsDecision,
    RightsAttestation,
    RightsTrustError,
    RightsTrustStore,
    RightsUseProfile,
    RightsVerificationPolicy,
    TrustedReviewerKey,
    attestation_signing_message,
    load_rights_verification_policy,
    load_rights_trust_store,
    rights_attestation_from_dict,
    rights_verification_policy_from_dict,
    rights_trust_store_from_dict,
    verify_rights_evidence_batch,
)


ASSET = "a" * 64
EVIDENCE_BYTES = b"fixture rights evidence\n"
EVIDENCE = hashlib.sha256(EVIDENCE_BYTES).hexdigest()
PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x11" * 32)
PUBLIC_KEY_BASE64 = base64.b64encode(
    PRIVATE_KEY.public_key().public_bytes_raw()
).decode("ascii")


def _decision(**overrides: object) -> RightsDecision:
    values: dict[str, object] = {
        "asset_sha256": ASSET,
        "state": RightsDecisionState.ACCEPTED,
        "basis": RightsBasis.OWNED,
        "owner_or_licensor": "Fixture Media LLC",
        "license_id": None,
        "evidence_sha256s": (EVIDENCE,),
        "permitted_uses": (
            PermittedUse.COMMERCIAL_MODEL_TRAINING,
            PermittedUse.DERIVATIVE_DATASET_CREATION,
            PermittedUse.MODEL_DEPLOYMENT,
            PermittedUse.BIOMETRIC_POSE_ANALYSIS,
        ),
        "geography_scope": ("US",),
        "participant_age_status": ParticipantAgeStatus.NO_MINORS,
        "participant_release_sha256s": (),
        "reviewer_id": "rights-reviewer-1",
        "reviewed_on": "2026-07-10",
        "expires_on": "2026-12-31",
    }
    values.update(overrides)
    return RightsDecision(**values)  # type: ignore[arg-type]


def _attestation(
    decision: RightsDecision,
    *,
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    key_id: str = "rights-key-1",
    signed_on: str = "2026-07-11",
) -> RightsAttestation:
    signature = private_key.sign(
        attestation_signing_message(
            decision,
            key_id=key_id,
            trust_domain_id="fixture-rights-keyring",
            signed_on=signed_on,
        )
    )
    return RightsAttestation(
        decision_sha256=decision.fingerprint(),
        key_id=key_id,
        trust_domain_id="fixture-rights-keyring",
        signed_on=signed_on,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _store(
    decision: RightsDecision,
    **overrides: object,
) -> RightsTrustStore:
    values: dict[str, object] = {
        "keyring_id": "fixture-rights-keyring",
        "keys": (
            TrustedReviewerKey(
                key_id="rights-key-1",
                reviewer_id="rights-reviewer-1",
                public_key_base64=PUBLIC_KEY_BASE64,
                valid_from="2026-01-01",
                valid_until="2026-12-31",
                compromised_on=None,
            ),
        ),
        "current_decisions": (
            CurrentRightsDecision(
                asset_sha256=decision.asset_sha256,
                decision_sha256=decision.fingerprint(),
            ),
        ),
        "revoked_decision_sha256s": (),
    }
    values.update(overrides)
    return RightsTrustStore(**values)  # type: ignore[arg-type]


def _policy(store: RightsTrustStore) -> RightsVerificationPolicy:
    return RightsVerificationPolicy(
        policy_id="fixture-commercial-us",
        trust_store_sha256=store.fingerprint(),
        verifier_source_tree_sha256="d" * 64,
        deployment_geography="US",
        use_profile=RightsUseProfile.COMMERCIAL_ASSISTIVE_SCORING_V1,
        valid_from="2026-01-01",
        valid_until="2026-12-31",
    )


class RightsTrustTests(unittest.TestCase):
    def _evidence_store(
        self,
        directory: str,
        objects: dict[str, bytes | int] | None = None,
    ) -> Path:
        root = Path(directory)
        (root / "locks").mkdir(parents=True)
        (root / "generations").mkdir()
        selected = objects or {EVIDENCE: EVIDENCE_BYTES}
        required = tuple(sorted(selected))
        descriptor = GenerationDescriptor.build(required)
        bootstrap_generation_lock(root, descriptor.generation_id)
        lock_path = root / "locks" / f"{descriptor.generation_id}.lock"
        lock_path.chmod(0o444)
        generation = root / "generations" / descriptor.generation_id
        object_root = generation / "objects"
        object_root.mkdir(parents=True)
        for digest, content in selected.items():
            path = object_root / digest
            if type(content) is int:
                with path.open("wb") as output:
                    output.truncate(content)
            else:
                path.write_bytes(content)
        (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
        return root

    def _evidence_object(
        self,
        store_root: Path,
        digest: str,
        required: tuple[str, ...] = (EVIDENCE,),
    ) -> Path:
        return (
            store_root
            / "generations"
            / generation_id_for(required)
            / "objects"
            / digest
        )

    def test_valid_signature_current_decision_and_evidence_verify(self) -> None:
        decision = _decision()
        with tempfile.TemporaryDirectory() as directory:
            verified = _store(decision).verify(
                decision,
                _attestation(decision),
                verified_on="2026-07-11",
                evidence_store_root=self._evidence_store(directory),
            )
        self.assertEqual(verified, (EVIDENCE,))
        self.assertRegex(_store(decision).fingerprint(), r"^[0-9a-f]{64}$")

    def test_evidence_worker_result_schema_is_exact_and_bounded(self) -> None:
        self.assertIsNone(
            rights_trust_module._validate_rights_worker_result(
                {"ok": True, "code": "", "message": ""}
            )
        )
        malformed = (
            None,
            {"ok": 1, "code": "", "message": ""},
            {"ok": True, "code": "UNEXPECTED", "message": ""},
            {"ok": False, "code": "bad-code", "message": "failure"},
            {"ok": False, "code": "RIGHTS_ERROR", "message": ""},
            {
                "ok": False,
                "code": "RIGHTS_ERROR",
                "message": "x" * 513,
            },
            {"ok": False, "code": "RIGHTS_ERROR", "message": 7},
            {"ok": True, "code": "", "message": "", "extra": True},
        )
        for result in malformed:
            with self.subTest(result=result):
                with self.assertRaisesRegex(
                    RightsTrustError,
                    "invalid",
                ) as caught:
                    rights_trust_module._validate_rights_worker_result(result)
                self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_WORKER")

        with self.assertRaisesRegex(RightsTrustError, "controlled") as caught:
            rights_trust_module._validate_rights_worker_result(
                {
                    "ok": False,
                    "code": "RIGHTS_EVIDENCE_HASH",
                    "message": "controlled failure",
                }
            )
        self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_HASH")

    def test_direct_trust_store_construction_enforces_collection_bounds(self) -> None:
        decision = _decision()
        base = _store(decision)
        second_key = TrustedReviewerKey(
            key_id="rights-key-2",
            reviewer_id="rights-reviewer-2",
            public_key_base64=base64.b64encode(
                Ed25519PrivateKey.from_private_bytes(
                    b"\x22" * 32
                ).public_key().public_bytes_raw()
            ).decode("ascii"),
            valid_from="2026-01-01",
            valid_until="2026-12-31",
            compromised_on=None,
        )
        second_current = CurrentRightsDecision(
            asset_sha256="b" * 64,
            decision_sha256="c" * 64,
        )

        with patch.object(rights_trust_module, "_MAX_TRUST_KEYS", 1):
            with self.assertRaisesRegex(ValueError, "exceeds 1 keys"):
                replace(base, keys=(*base.keys, second_key))
        with patch.object(rights_trust_module, "_MAX_CURRENT_DECISIONS", 1):
            with self.assertRaisesRegex(ValueError, "exceeds 1 current decisions"):
                replace(
                    base,
                    current_decisions=(*base.current_decisions, second_current),
                )
        with patch.object(rights_trust_module, "_MAX_REVOKED_DECISIONS", 1):
            with self.assertRaisesRegex(ValueError, "exceeds 1 revoked decisions"):
                replace(
                    base,
                    revoked_decision_sha256s=("d" * 64, "e" * 64),
                )

    def test_many_attestations_share_one_deduplicated_evidence_worker(self) -> None:
        common_bytes = b"common rights evidence\n"
        common_digest = hashlib.sha256(common_bytes).hexdigest()
        decisions: list[RightsDecision] = []
        attestations: list[RightsAttestation] = []
        evidence_bytes: dict[str, bytes] = {common_digest: common_bytes}
        for index in range(101):
            unique_bytes = f"rights evidence {index}\n".encode("ascii")
            unique_digest = hashlib.sha256(unique_bytes).hexdigest()
            evidence_bytes[unique_digest] = unique_bytes
            decision = _decision(
                asset_sha256=hashlib.sha256(
                    f"source asset {index}".encode("ascii")
                ).hexdigest(),
                evidence_sha256s=tuple(sorted((common_digest, unique_digest))),
            )
            decisions.append(decision)
            attestations.append(_attestation(decision))

        store = _store(
            decisions[0],
            current_decisions=tuple(
                CurrentRightsDecision(
                    asset_sha256=decision.asset_sha256,
                    decision_sha256=decision.fingerprint(),
                )
                for decision in decisions
            ),
        )
        items = tuple(zip(decisions, attestations, strict=True))
        with patch(
            "vision_scoring.rights_trust._build_rights_trust_indexes",
            wraps=rights_trust_module._build_rights_trust_indexes,
        ) as build_indexes:
            references_by_decision = store.verify_attestations_batch(
                items,
                verified_on="2026-07-11",
            )
        self.assertEqual(build_indexes.call_count, 1)

        all_references: list[str] = []
        for verified_references in references_by_decision:
            self.assertEqual(verified_references, tuple(sorted(verified_references)))
            all_references.extend(verified_references)
        required = tuple(sorted(set(all_references)))
        self.assertEqual(len(all_references), 202)
        self.assertEqual(len(required), 102)

        real_context = multiprocessing.get_context("spawn")

        class RecordingContext:
            def __init__(self) -> None:
                self.process_calls = 0
                self.process_arguments: list[tuple[object, ...]] = []

            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                return real_context.Pipe(duplex=duplex)

            def Process(self, **kwargs: object):  # type: ignore[no-untyped-def]
                self.process_calls += 1
                arguments = kwargs.get("args")
                if type(arguments) is tuple:
                    self.process_arguments.append(arguments)
                return real_context.Process(**kwargs)

        recording_context = RecordingContext()
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory, evidence_bytes)
            with patch(
                "vision_scoring.rights_trust.multiprocessing.get_context",
                return_value=recording_context,
            ):
                verified = verify_rights_evidence_batch(
                    required,
                    evidence_store_root=root,
                )

        self.assertEqual(verified, required)
        self.assertEqual(recording_context.process_calls, 1)
        self.assertEqual(len(recording_context.process_arguments), 1)
        self.assertEqual(
            recording_context.process_arguments[0][1],
            generation_id_for(required),
        )
        self.assertEqual(recording_context.process_arguments[0][2], required)

    def test_attestation_batch_shape_and_count_are_bounded(self) -> None:
        decision = _decision()
        attestation = _attestation(decision)
        store = _store(decision)

        with self.assertRaisesRegex(
            RightsTrustError,
            "between 1 and 10000",
        ) as caught:
            store.verify_attestations_batch(
                ((decision, attestation),) * 10_001,
                verified_on="2026-07-11",
            )
        self.assertEqual(caught.exception.code, "RIGHTS_ATTESTATION_BATCH_COUNT")

        invalid_batches: tuple[object, ...] = (
            [(decision, attestation)],
            ((decision,),),
            ((object(), attestation),),
            ((decision, object()),),
        )
        for invalid in invalid_batches:
            with self.subTest(invalid=type(invalid).__name__), self.assertRaisesRegex(
                RightsTrustError,
                "immutable tuple|exact .* pair",
            ) as caught:
                store.verify_attestations_batch(  # type: ignore[arg-type]
                    invalid,
                    verified_on="2026-07-11",
                )
            self.assertEqual(caught.exception.code, "RIGHTS_ATTESTATION_BATCH")

    def test_batch_evidence_limits_and_shape_fail_closed(self) -> None:
        too_many = tuple(
            sorted(
                hashlib.sha256(f"evidence-{index}".encode("ascii")).hexdigest()
                for index in range(4097)
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                RightsTrustError,
                "between 1 and 4096",
            ) as caught:
                verify_rights_evidence_batch(
                    too_many,
                    evidence_store_root=Path(directory),
                )
        self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_COUNT")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                RightsTrustError,
                "sorted and duplicate-free",
            ):
                verify_rights_evidence_batch(
                    (EVIDENCE, EVIDENCE),
                    evidence_store_root=Path(directory),
                )
            with self.assertRaisesRegex(
                RightsTrustError,
                "lowercase SHA-256",
            ):
                verify_rights_evidence_batch(
                    (EVIDENCE.upper(),),
                    evidence_store_root=Path(directory),
                )

        oversized_digest = hashlib.sha256(b"oversized").hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(
                directory,
                {oversized_digest: 32 * 1024 * 1024 + 1},
            )
            with self.assertRaisesRegex(
                RightsTrustError,
                "exceeds 33554432 bytes",
            ) as caught:
                verify_rights_evidence_batch(
                    (oversized_digest,),
                    evidence_store_root=root,
                )
        self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_SIZE")

        with tempfile.TemporaryDirectory() as directory:
            aggregate_objects = {
                hashlib.sha256(payload).hexdigest(): payload
                for payload in (b"aggregate-first", b"aggregate-second")
            }
            root = self._evidence_store(directory, aggregate_objects)
            required = tuple(sorted(aggregate_objects))
            with self.assertRaisesRegex(
                RightsTrustError,
                "total rights evidence exceeds 20 bytes",
            ) as caught:
                with patch.object(
                    rights_trust_module,
                    "_MAX_TOTAL_EVIDENCE_BYTES",
                    20,
                ):
                    rights_trust_module._verify_rights_evidence_generation_sync(
                        root,
                        generation_id_for(required),
                        required,
                    )
        self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_TOTAL_SIZE")

        if hasattr(os, "mkfifo"):
            special_digest = hashlib.sha256(b"special file").hexdigest()
            with tempfile.TemporaryDirectory() as directory:
                root = self._evidence_store(
                    directory,
                    {special_digest: b"special file"},
                )
                special_path = self._evidence_object(
                    root,
                    special_digest,
                    (special_digest,),
                )
                special_path.unlink()
                os.mkfifo(special_path)
                with self.assertRaisesRegex(
                    RightsTrustError,
                    "resident non-symlink regular file",
                ) as caught:
                    verify_rights_evidence_batch(
                        (special_digest,),
                        evidence_store_root=root,
                    )
            self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_SHAPE")

    def test_evidence_deadline_is_enforced_inside_generation_lease(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            with patch.object(
                rights_trust_module,
                "_EVIDENCE_TIMEOUT_SECONDS",
                0.0,
            ), self.assertRaisesRegex(
                RightsTrustError,
                "deadline elapsed",
            ) as caught:
                rights_trust_module._verify_rights_evidence_generation_sync(
                    root,
                    generation_id_for((EVIDENCE,)),
                    (EVIDENCE,),
                )
        self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_TIMEOUT")

    def test_forged_signature_and_changed_decision_are_rejected(self) -> None:
        decision = _decision()
        other_key = Ed25519PrivateKey.from_private_bytes(b"\x22" * 32)
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            with self.assertRaisesRegex(RightsTrustError, "signature is invalid") as caught:
                _store(decision).verify(
                    decision,
                    _attestation(decision, private_key=other_key),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            self.assertEqual(caught.exception.code, "RIGHTS_ATTESTATION_SIGNATURE")

            changed = replace(decision, owner_or_licensor="Changed Media LLC")
            with self.assertRaisesRegex(RightsTrustError, "canonical rights decision"):
                _store(changed).verify(
                    changed,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

    def test_stale_revoked_and_untrusted_decisions_fail_closed(self) -> None:
        decision = _decision()
        replacement = replace(decision, owner_or_licensor="Replacement Media LLC")
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            stale_store = _store(
                decision,
                current_decisions=(
                    CurrentRightsDecision(ASSET, replacement.fingerprint()),
                ),
            )
            with self.assertRaisesRegex(RightsTrustError, "not the current") as caught:
                stale_store.verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            self.assertEqual(caught.exception.code, "RIGHTS_DECISION_STALE")

            revoked_store = _store(
                decision,
                current_decisions=(),
                revoked_decision_sha256s=(decision.fingerprint(),),
            )
            with self.assertRaisesRegex(RightsTrustError, "revoked"):
                revoked_store.verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

            untrusted_store = _store(decision, current_decisions=())
            with self.assertRaisesRegex(RightsTrustError, "no current decision"):
                untrusted_store.verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

    def test_reviewer_identity_key_dates_and_revocation_are_enforced(self) -> None:
        decision = _decision()
        base_key = _store(decision).keys[0]
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            mismatch = _store(
                decision,
                keys=(replace(base_key, reviewer_id="another-reviewer"),),
            )
            with self.assertRaisesRegex(RightsTrustError, "reviewer_id"):
                mismatch.verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

            revoked = _store(
                decision,
                keys=(replace(base_key, compromised_on="2026-07-11"),),
            )
            with self.assertRaisesRegex(RightsTrustError, "compromised"):
                revoked.verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

            with self.assertRaisesRegex(RightsTrustError, "on/after review"):
                _store(decision).verify(
                    decision,
                    _attestation(decision, signed_on="2026-07-09"),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

    def test_missing_hash_mismatch_and_symlink_evidence_are_rejected(self) -> None:
        decision = _decision()
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            evidence_path = self._evidence_object(root, EVIDENCE)
            evidence_path.unlink()
            with self.assertRaisesRegex(RightsTrustError, "missing") as caught:
                _store(decision).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_MISSING")

            evidence_path.write_bytes(b"wrong")
            with self.assertRaisesRegex(RightsTrustError, "declared digest"):
                _store(decision).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

            evidence_path.unlink()
            target = root / "target"
            target.write_bytes(EVIDENCE_BYTES)
            evidence_path.symlink_to(target)
            with self.assertRaisesRegex(RightsTrustError, "missing or unsafe"):
                _store(decision).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

    def test_missing_and_wrong_generation_fail_with_stable_codes(self) -> None:
        decision = _decision()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            with self.assertRaisesRegex(
                RightsTrustError,
                "generation lock is unavailable",
            ) as caught:
                _store(decision).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_GENERATION")

        wrong_bytes = b"wrong generation"
        wrong_digest = hashlib.sha256(wrong_bytes).hexdigest()
        required_generation_id = generation_id_for((EVIDENCE,))
        wrong_descriptor = GenerationDescriptor.build((wrong_digest,))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "locks").mkdir()
            (root / "generations").mkdir()
            bootstrap_generation_lock(root, required_generation_id)
            (root / "locks" / f"{required_generation_id}.lock").chmod(0o444)
            generation = root / "generations" / required_generation_id
            (generation / "objects").mkdir(parents=True)
            (generation / "objects" / wrong_digest).write_bytes(wrong_bytes)
            (generation / "descriptor.json").write_bytes(
                wrong_descriptor.canonical_bytes()
            )
            with self.assertRaisesRegex(
                RightsTrustError,
                "identifier is inconsistent",
            ) as caught:
                _store(decision).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            self.assertEqual(caught.exception.code, "RIGHTS_EVIDENCE_GENERATION")

    def test_immutable_store_error_text_never_crosses_rights_boundary(self) -> None:
        mapped = rights_trust_module._map_immutable_store_error(
            ImmutableStoreError("UNRECOGNIZED", "attacker-controlled secret"),
        )
        self.assertEqual(mapped.code, "RIGHTS_EVIDENCE_STORE")
        self.assertNotIn("attacker-controlled", str(mapped))
        self.assertNotIn("secret", str(mapped))

    def test_exact_membership_is_checked_after_generation_lease_opens(self) -> None:
        extra = hashlib.sha256(b"extra").hexdigest()

        class MismatchedLease:
            descriptor = type(
                "Descriptor",
                (),
                {"object_sha256s": tuple(sorted((EVIDENCE, extra)))},
            )()

        @contextmanager
        def mismatched_lease(
            store_root: Path,
            generation_id: str,
        ):
            del store_root, generation_id
            yield MismatchedLease()

        with patch.object(
            rights_trust_module,
            "generation_read_lease",
            mismatched_lease,
        ), self.assertRaisesRegex(
            RightsTrustError,
            "exact required object set",
        ) as caught:
            rights_trust_module._verify_rights_evidence_generation_sync(
                Path("unused"),
                generation_id_for((EVIDENCE,)),
                (EVIDENCE,),
            )
        self.assertEqual(
            caught.exception.code,
            "RIGHTS_EVIDENCE_GENERATION_MEMBERSHIP",
        )

    def test_one_batch_lease_excludes_cooperative_writer(self) -> None:
        second_bytes = b"second evidence"
        second_digest = hashlib.sha256(second_bytes).hexdigest()
        objects = {EVIDENCE: EVIDENCE_BYTES, second_digest: second_bytes}
        required = tuple(sorted(objects))
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory, objects)
            generation_id = generation_id_for(required)
            # The trusted publisher needs write access to request its exclusive
            # lock; ordinary rights readers work with the 0444 fixture lock.
            (root / "locks" / f"{generation_id}.lock").chmod(0o644)
            lease_entries = 0

            @contextmanager
            def observed_lease(store_root: Path, selected_generation_id: str):
                nonlocal lease_entries
                lease_entries += 1
                with generation_read_lease(
                    store_root,
                    selected_generation_id,
                ) as lease:
                    with self.assertRaises(ImmutableStoreError) as caught:
                        generation_write_lock(
                            store_root,
                            selected_generation_id,
                            blocking=False,
                        ).__enter__()
                    self.assertEqual(caught.exception.code, "GENERATION_BUSY")
                    yield lease

            with patch.object(
                rights_trust_module,
                "generation_read_lease",
                observed_lease,
            ):
                rights_trust_module._verify_rights_evidence_generation_sync(
                    root,
                    generation_id,
                    required,
                )
        self.assertEqual(lease_entries, 1)

    def test_exact_json_loaders_and_canonical_base64_fail_closed(self) -> None:
        decision = _decision()
        attestation = _attestation(decision)
        loaded_attestation = rights_attestation_from_dict(
            attestation.to_canonical_dict()
        )
        self.assertEqual(loaded_attestation, attestation)
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            rights_attestation_from_dict(
                {**attestation.to_canonical_dict(), "trusted": True}
            )
        with self.assertRaisesRegex(ValueError, "canonical base64"):
            rights_attestation_from_dict(
                {**attestation.to_canonical_dict(), "signature_base64": "!!!!"}
            )

        store = _store(decision)
        payload = store.to_canonical_dict()
        self.assertEqual(rights_trust_store_from_dict(payload), store)
        self.assertEqual(
            json.loads(store.canonical_json()),
            payload,
        )
        with self.assertRaisesRegex(ValueError, "JSON array"):
            rights_trust_store_from_dict({**payload, "keys": {}})

    def test_verification_policy_is_canonical_strict_and_time_bounded(self) -> None:
        store = _store(_decision())
        policy = _policy(store)
        self.assertTrue(policy.is_active("2026-01-01"))
        self.assertTrue(policy.is_active("2026-12-31"))
        self.assertFalse(policy.is_active("2027-01-01"))
        self.assertEqual(
            rights_verification_policy_from_dict(policy.to_canonical_dict()),
            policy,
        )
        self.assertRegex(policy.fingerprint(), r"^[0-9a-f]{64}$")
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            rights_verification_policy_from_dict(
                {**policy.to_canonical_dict(), "rights_as_of": "2020-01-01"}
            )
        legacy_payload = policy.to_canonical_dict()
        legacy_payload["verifier_artifact_sha256"] = legacy_payload.pop(
            "verifier_source_tree_sha256"
        )
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            rights_verification_policy_from_dict(legacy_payload)

    def test_domain_key_validity_and_compromise_are_fail_closed(self) -> None:
        decision = _decision()
        base_key = _store(decision).keys[0]
        with tempfile.TemporaryDirectory() as directory:
            root = self._evidence_store(directory)
            wrong_domain = replace(
                _attestation(decision),
                trust_domain_id="different-governance-domain",
            )
            with self.assertRaisesRegex(RightsTrustError, "trust domain"):
                _store(decision).verify(
                    decision,
                    wrong_domain,
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )
            for key in (
                replace(base_key, valid_from="2026-07-12"),
                replace(base_key, valid_until="2026-07-10"),
            ):
                with self.subTest(key=key), self.assertRaisesRegex(
                    RightsTrustError,
                    "not valid",
                ):
                    _store(decision, keys=(key,)).verify(
                        decision,
                        _attestation(decision),
                        verified_on="2026-07-11",
                        evidence_store_root=root,
                    )
            compromised = replace(base_key, compromised_on="2026-07-11")
            with self.assertRaisesRegex(RightsTrustError, "retroactively"):
                _store(decision, keys=(compromised,)).verify(
                    decision,
                    _attestation(decision),
                    verified_on="2026-07-11",
                    evidence_store_root=root,
                )

    def test_strict_loader_rejects_duplicate_keys_and_evidence_fifo(self) -> None:
        decision = _decision()
        with tempfile.TemporaryDirectory() as directory:
            duplicate = Path(directory) / "duplicate.json"
            duplicate.write_text(
                '{"schema_version":"1.0","schema_version":"1.0"}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
                load_rights_trust_store(duplicate)

            root = self._evidence_store(str(Path(directory) / "evidence"))
            fifo = self._evidence_object(root, EVIDENCE)
            if hasattr(os, "mkfifo"):
                fifo.unlink()
                os.mkfifo(fifo)
                with self.assertRaisesRegex(
                    RightsTrustError,
                    "resident non-symlink regular file",
                ):
                    _store(decision).verify(
                        decision,
                        _attestation(decision),
                        verified_on="2026-07-11",
                        evidence_store_root=root,
                    )

    def test_descriptor_bound_store_and_policy_loaders_accept_regular_files(
        self,
    ) -> None:
        store = _store(_decision())
        policy = _policy(store)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store_path = root / "trust-store.json"
            policy_path = root / "policy.json"
            store_path.write_text(store.canonical_json(), encoding="utf-8")
            policy_path.write_text(policy.canonical_json(), encoding="utf-8")

            self.assertEqual(load_rights_trust_store(store_path), store)
            self.assertEqual(load_rights_verification_policy(policy_path), policy)

    def test_json_loaders_reject_symlink_fifo_device_and_oversize_quickly(
        self,
    ) -> None:
        store = _store(_decision())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "trust-store.json"
            target.write_text(store.canonical_json(), encoding="utf-8")

            symlink = root / "symlink.json"
            symlink.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                load_rights_trust_store(symlink)

            oversize = root / "oversize.json"
            with oversize.open("wb") as output:
                output.truncate(4 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(ValueError, "exceeds 4194304 bytes"):
                load_rights_trust_store(oversize)

            if hasattr(os, "mkfifo"):
                fifo = root / "policy.fifo"
                os.mkfifo(fifo)
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                    load_rights_verification_policy(fifo)
                self.assertLess(time.monotonic() - started, 2.0)

            device = Path("/dev/null")
            if device.exists():
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                    load_rights_trust_store(device)
                self.assertLess(time.monotonic() - started, 2.0)

    def test_json_loader_detects_truncation_growth_and_same_inode_mutation(
        self,
    ) -> None:
        store = _store(_decision())
        raw = store.canonical_json().encode("utf-8")
        real_read = os.read
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trust-store.json"

            path.write_bytes(raw)
            truncated = False

            def truncate_before_read(descriptor: int, count: int) -> bytes:
                nonlocal truncated
                if not truncated:
                    truncated = True
                    path.write_bytes(b"")
                return real_read(descriptor, count)

            with patch(
                "vision_scoring.rights_trust.os.read",
                side_effect=truncate_before_read,
            ), self.assertRaisesRegex(ValueError, "truncated while reading"):
                load_rights_trust_store(path)

            path.write_bytes(raw)
            grown = False

            def grow_after_read(descriptor: int, count: int) -> bytes:
                nonlocal grown
                chunk = real_read(descriptor, count)
                if not grown:
                    grown = True
                    with path.open("ab") as output:
                        output.write(b"x")
                        output.flush()
                        os.fsync(output.fileno())
                return chunk

            with patch(
                "vision_scoring.rights_trust.os.read",
                side_effect=grow_after_read,
            ), self.assertRaisesRegex(ValueError, "grew while reading"):
                load_rights_trust_store(path)

            path.write_bytes(raw)
            mutated = False

            def mutate_after_read(descriptor: int, count: int) -> bytes:
                nonlocal mutated
                chunk = real_read(descriptor, count)
                if not mutated:
                    mutated = True
                    with path.open("r+b") as output:
                        output.write(b"[")
                        output.flush()
                        os.fsync(output.fileno())
                return chunk

            with patch(
                "vision_scoring.rights_trust.os.read",
                side_effect=mutate_after_read,
            ), self.assertRaisesRegex(ValueError, "changed while reading"):
                load_rights_trust_store(path)

    def test_json_loader_detects_path_replacement_during_read(self) -> None:
        store = _store(_decision())
        raw = store.canonical_json().encode("utf-8")
        real_open = os.open
        real_read = os.read
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "trust-store.json"
            displaced = root / "displaced.json"
            replacement = root / "replacement.json"
            path.write_bytes(raw)
            replacement.write_bytes(raw)
            replaced_before_open = False

            def replace_before_open(
                target: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                flags: int,
                mode: int = 0o777,
                *,
                dir_fd: int | None = None,
            ) -> int:
                nonlocal replaced_before_open
                if not replaced_before_open and Path(target) == path:
                    replaced_before_open = True
                    os.replace(path, displaced)
                    os.replace(replacement, path)
                return real_open(target, flags, mode, dir_fd=dir_fd)

            with patch(
                "vision_scoring.rights_trust.os.open",
                side_effect=replace_before_open,
            ), self.assertRaisesRegex(ValueError, "changed while opening"):
                load_rights_trust_store(path)

            displaced.unlink()
            replaced = False

            def replace_after_read(descriptor: int, count: int) -> bytes:
                nonlocal replaced
                chunk = real_read(descriptor, count)
                if not replaced:
                    replaced = True
                    path.replace(displaced)
                    path.write_bytes(raw)
                return chunk

            with patch(
                "vision_scoring.rights_trust.os.read",
                side_effect=replace_after_read,
            ), self.assertRaisesRegex(ValueError, "changed while reading"):
                load_rights_trust_store(path)


if __name__ == "__main__":
    unittest.main()
