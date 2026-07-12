from __future__ import annotations

from dataclasses import FrozenInstanceError
import hashlib
import inspect
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import vision_scoring.artifact_store as artifact_store
import vision_scoring.immutable_store as immutable_store
from vision_scoring.artifact_store import (
    ArtifactVerificationError,
    DatasetArtifactProof,
    DatasetArtifactSetProof,
    canonical_artifact_set_fingerprint,
    verify_dataset_artifacts,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
    generation_id_for,
)


class ArtifactStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "artifact-store"
        (self.root / "locks").mkdir(parents=True)
        (self.root / "generations").mkdir()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _publish(
        self,
        payloads: tuple[bytes, ...],
        *,
        descriptor: GenerationDescriptor | None = None,
        path_generation_id: str | None = None,
    ) -> tuple[GenerationDescriptor, Path]:
        digests = tuple(
            sorted(hashlib.sha256(payload).hexdigest() for payload in payloads)
        )
        selected = descriptor or GenerationDescriptor.build(digests)
        generation_id = path_generation_id or selected.generation_id
        bootstrap_generation_lock(self.root, generation_id)
        generation = self.root / "generations" / generation_id
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for payload in payloads:
            digest = hashlib.sha256(payload).hexdigest()
            (objects / digest).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(selected.canonical_bytes())
        return selected, generation

    def _limits(
        self,
        *,
        max_files: int = 20,
        max_file_bytes: int = 16 * 1024 * 1024,
        max_total_bytes: int = 32 * 1024 * 1024,
        timeout_seconds: float = 10.0,
    ) -> artifact_store._VerificationLimits:
        return artifact_store._VerificationLimits(
            max_files=max_files,
            max_file_bytes=max_file_bytes,
            max_total_bytes=max_total_bytes,
            timeout_seconds=timeout_seconds,
        )

    def _verify_sync(
        self,
        digests: tuple[str, ...],
        *,
        generation_id: str | None = None,
        limits: artifact_store._VerificationLimits | None = None,
        deadline: float | None = None,
        root: Path | None = None,
    ) -> DatasetArtifactSetProof:
        return artifact_store._verify_immutable_generation_sync(
            root or self.root,
            digests,
            generation_id=generation_id or generation_id_for(digests),
            deadline=(time.monotonic() + 10.0 if deadline is None else deadline),
            limits=limits or self._limits(),
        )

    def assert_error_code(
        self,
        expected_code: str,
        operation: object,
    ) -> ArtifactVerificationError:
        with self.assertRaises(ArtifactVerificationError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, expected_code)
        return caught.exception

    def test_spawn_worker_verifies_exact_generation_and_returns_immutable_proof(
        self,
    ) -> None:
        payloads = (b"first dataset artifact\n", b"second dataset artifact\n")
        descriptor, generation = self._publish(payloads)

        before_children = {child.pid for child in multiprocessing.active_children()}
        proof = verify_dataset_artifacts(
            descriptor.object_sha256s,
            artifact_store_root=self.root,
        )
        leaked_children = {
            child.pid
            for child in multiprocessing.active_children()
            if child.pid not in before_children
        }

        self.assertEqual(proof.generation_id, descriptor.generation_id)
        self.assertEqual(
            proof.artifacts,
            tuple(
                DatasetArtifactProof(
                    digest,
                    (generation / "objects" / digest).stat().st_size,
                )
                for digest in descriptor.object_sha256s
            ),
        )
        self.assertEqual(
            proof.total_size_bytes,
            sum(len(payload) for payload in payloads),
        )
        self.assertEqual(
            proof.canonical_set_fingerprint,
            canonical_artifact_set_fingerprint(proof.artifacts),
        )
        self.assertEqual(proof.to_canonical_dict()["generation_id"], proof.generation_id)
        self.assertFalse(leaked_children)
        with self.assertRaises(FrozenInstanceError):
            proof.generation_id = "a" * 64  # type: ignore[misc]
        with self.assertRaises(FrozenInstanceError):
            proof.artifacts[0].size_bytes = 0  # type: ignore[misc]

    def test_empty_set_requires_its_published_generation_and_lock(self) -> None:
        descriptor, _ = self._publish(())
        proof = verify_dataset_artifacts((), artifact_store_root=self.root)
        self.assertEqual(proof.generation_id, descriptor.generation_id)
        self.assertEqual(proof.artifacts, ())
        self.assertEqual(proof.total_size_bytes, 0)

        missing_root = Path(self.temporary_directory.name) / "missing"
        self.assert_error_code(
            "ARTIFACT_STORE_SHAPE",
            lambda: verify_dataset_artifacts(
                (), artifact_store_root=missing_root
            ),
        )

    def test_writable_flat_digest_directory_cannot_produce_a_proof(self) -> None:
        flat = Path(self.temporary_directory.name) / "legacy-flat-root"
        flat.mkdir()
        digest = hashlib.sha256(b"legacy").hexdigest()
        (flat / digest).write_bytes(b"legacy")

        self.assert_error_code(
            "ARTIFACT_STORE_SHAPE",
            lambda: self._verify_sync((digest,), root=flat),
        )

    def test_fingerprint_format_remains_domain_separated_and_size_sensitive(
        self,
    ) -> None:
        digest = "a" * 64
        one = (DatasetArtifactProof(digest, 1),)
        two = (DatasetArtifactProof(digest, 2),)
        canonical_payload = {
            "artifacts": [{"sha256": digest, "size_bytes": 1}],
            "domain": "multicourt-vision-scoring:dataset-artifact-set:v1",
            "schema_version": "1.0",
        }
        expected = hashlib.sha256(
            json.dumps(
                canonical_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(canonical_artifact_set_fingerprint(one), expected)
        self.assertNotEqual(
            canonical_artifact_set_fingerprint(one),
            canonical_artifact_set_fingerprint(two),
        )

    def test_public_api_has_only_fixed_limits_and_protected_store_root(self) -> None:
        parameters = inspect.signature(verify_dataset_artifacts).parameters
        self.assertEqual(
            tuple(parameters),
            ("artifact_sha256s", "artifact_store_root"),
        )
        self.assertEqual(
            parameters["artifact_store_root"].kind,
            inspect.Parameter.KEYWORD_ONLY,
        )
        self.assertEqual(artifact_store.MAX_ARTIFACT_FILES, 20_000)
        self.assertEqual(artifact_store.MAX_ARTIFACT_BYTES, 1 << 40)
        self.assertEqual(artifact_store.MAX_ARTIFACT_SET_BYTES, 4 << 40)

    def test_rejects_non_tuple_non_path_and_invalid_digest_inputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            verify_dataset_artifacts(  # type: ignore[arg-type]
                [], artifact_store_root=self.root
            )
        with self.assertRaisesRegex(ValueError, "pathlib.Path"):
            verify_dataset_artifacts(  # type: ignore[arg-type]
                (), artifact_store_root=str(self.root)
            )
        for invalid in (
            "sha256:" + "a" * 64,
            "A" * 64,
            "a" * 63,
            "../" + "a" * 64,
            "g" * 64,
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
                    verify_dataset_artifacts(
                        (invalid,), artifact_store_root=self.root
                    )

    def test_rejects_unsorted_duplicate_or_excessive_digest_tuples(self) -> None:
        for digests in (("b" * 64, "a" * 64), ("a" * 64, "a" * 64)):
            with self.subTest(digests=digests):
                with self.assertRaisesRegex(ValueError, "sorted.*no duplicates"):
                    verify_dataset_artifacts(
                        digests, artifact_store_root=self.root
                    )
        excessive = tuple(f"{index:064x}" for index in range(20_001))
        self.assert_error_code(
            "ARTIFACT_COUNT",
            lambda: verify_dataset_artifacts(
                excessive, artifact_store_root=self.root
            ),
        )

    def test_missing_lock_and_missing_generation_fail_with_stable_codes(self) -> None:
        digest = hashlib.sha256(b"missing").hexdigest()
        generation_id = generation_id_for((digest,))
        self.assert_error_code(
            "ARTIFACT_GENERATION_LOCK_MISSING",
            lambda: self._verify_sync((digest,)),
        )

        bootstrap_generation_lock(self.root, generation_id)
        self.assert_error_code(
            "ARTIFACT_STORE_SHAPE",
            lambda: self._verify_sync((digest,)),
        )

    def test_generation_path_descriptor_mismatch_fails_closed(self) -> None:
        requested = hashlib.sha256(b"requested").hexdigest()
        requested_generation_id = generation_id_for((requested,))
        other_descriptor = GenerationDescriptor.build(
            (hashlib.sha256(b"other").hexdigest(),)
        )
        self._publish(
            (b"other",),
            descriptor=other_descriptor,
            path_generation_id=requested_generation_id,
        )

        self.assert_error_code(
            "ARTIFACT_GENERATION_MISMATCH",
            lambda: self._verify_sync((requested,)),
        )

    def test_descriptor_must_declare_exact_requested_membership(self) -> None:
        requested = hashlib.sha256(b"requested exact member").hexdigest()
        extra = hashlib.sha256(b"undeclared extra member").hexdigest()
        digests = (requested,)
        generation_id = generation_id_for(digests)
        bootstrap_generation_lock(self.root, generation_id)
        generation = self.root / "generations" / generation_id
        objects = generation / "objects"
        objects.mkdir(parents=True)
        (objects / requested).write_bytes(b"requested exact member")
        mismatched_members = tuple(sorted((requested, extra)))
        malformed = {
            "domain": (
                "multicourt-vision-scoring:immutable-generation-descriptor:v1"
            ),
            "generation_id": generation_id,
            "object_sha256s": list(mismatched_members),
            "schema_version": "1.0",
        }
        (generation / "descriptor.json").write_text(
            json.dumps(
                malformed,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ),
            encoding="utf-8",
        )

        self.assert_error_code(
            "ARTIFACT_GENERATION_DESCRIPTOR",
            lambda: self._verify_sync(digests),
        )

    def test_missing_and_hash_mismatched_objects_map_to_stable_codes(self) -> None:
        descriptor, generation = self._publish((b"declared",))
        digest = descriptor.object_sha256s[0]
        source = generation / "objects" / digest
        source.unlink()
        self.assert_error_code(
            "ARTIFACT_OBJECT_OPEN",
            lambda: self._verify_sync((digest,)),
        )

        source.write_bytes(b"wrong bytes")
        self.assert_error_code(
            "ARTIFACT_HASH",
            lambda: self._verify_sync((digest,)),
        )

    def test_one_generation_lease_is_held_across_the_complete_batch(self) -> None:
        descriptor, _ = self._publish((b"first lease", b"second lease"))
        real_factory = artifact_store.generation_read_lease
        entries = 0
        exits = 0

        class TrackingLease:
            def __init__(self, *args: object, **kwargs: object) -> None:
                self.inner = real_factory(*args, **kwargs)  # type: ignore[arg-type]

            def __enter__(self) -> object:
                nonlocal entries
                entries += 1
                return self.inner.__enter__()

            def __exit__(self, *args: object) -> None:
                nonlocal exits
                exits += 1
                self.inner.__exit__(*args)

        with patch.object(artifact_store, "generation_read_lease", TrackingLease):
            proof = self._verify_sync(descriptor.object_sha256s)

        self.assertEqual(len(proof.artifacts), 2)
        self.assertEqual(entries, 1)
        self.assertEqual(exits, 1)

    def test_in_place_mutation_during_staging_maps_to_artifact_changed(self) -> None:
        payload = b"a" * (2 * 1024 * 1024)
        descriptor, generation = self._publish((payload,))
        digest = descriptor.object_sha256s[0]
        source = generation / "objects" / digest
        source_inode = source.stat().st_ino
        original_read = immutable_store._read_chunk
        mutated = False

        def mutate_after_object_chunk(file_descriptor: int, count: int) -> bytes:
            nonlocal mutated
            chunk = original_read(file_descriptor, count)
            if (
                chunk
                and not mutated
                and os.fstat(file_descriptor).st_ino == source_inode
            ):
                with source.open("r+b") as stream:
                    stream.seek(0)
                    stream.write(b"z" * len(payload))
                    stream.flush()
                    os.fsync(stream.fileno())
                mutated = True
            return chunk

        with patch.object(
            immutable_store,
            "_read_chunk",
            mutate_after_object_chunk,
        ):
            self.assert_error_code(
                "ARTIFACT_CHANGED",
                lambda: self._verify_sync((digest,)),
            )

    def test_path_replacement_during_staging_maps_to_artifact_changed(self) -> None:
        payload = b"r" * (2 * 1024 * 1024)
        descriptor, generation = self._publish((payload,))
        digest = descriptor.object_sha256s[0]
        source = generation / "objects" / digest
        source_inode = source.stat().st_ino
        original_read = immutable_store._read_chunk
        replaced = False

        def replace_after_object_chunk(file_descriptor: int, count: int) -> bytes:
            nonlocal replaced
            chunk = original_read(file_descriptor, count)
            if (
                chunk
                and not replaced
                and os.fstat(file_descriptor).st_ino == source_inode
            ):
                replacement = generation / "objects" / "replacement"
                replacement.write_bytes(payload)
                os.replace(replacement, source)
                replaced = True
            return chunk

        with patch.object(
            immutable_store,
            "_read_chunk",
            replace_after_object_chunk,
        ):
            self.assert_error_code(
                "ARTIFACT_CHANGED",
                lambda: self._verify_sync((digest,)),
            )

    def test_per_artifact_and_total_size_limits_use_staged_sizes(self) -> None:
        descriptor, _ = self._publish((b"four",))
        self.assert_error_code(
            "ARTIFACT_SIZE",
            lambda: self._verify_sync(
                descriptor.object_sha256s,
                limits=self._limits(max_file_bytes=3, max_total_bytes=10),
            ),
        )

        descriptor, _ = self._publish((b"one", b"two"))
        self.assert_error_code(
            "ARTIFACT_TOTAL_SIZE",
            lambda: self._verify_sync(
                descriptor.object_sha256s,
                limits=self._limits(max_file_bytes=3, max_total_bytes=5),
            ),
        )

    def test_sync_and_spawn_deadlines_fail_closed_and_reap_worker(self) -> None:
        descriptor, _ = self._publish((b"deadline cleanup",))
        self.assert_error_code(
            "ARTIFACT_TIMEOUT",
            lambda: self._verify_sync(
                descriptor.object_sha256s,
                deadline=time.monotonic() - 0.001,
            ),
        )

        limits = self._limits(timeout_seconds=1e-9)
        before_pids = {child.pid for child in multiprocessing.active_children()}
        started = time.monotonic()
        self.assert_error_code(
            "ARTIFACT_TIMEOUT",
            lambda: artifact_store._verify_dataset_artifacts_with_limits(
                descriptor.object_sha256s,
                artifact_store_root=self.root,
                limits=limits,
            ),
        )
        self.assertLess(time.monotonic() - started, 3.0)
        leaked = {
            child.pid
            for child in multiprocessing.active_children()
            if child.pid not in before_pids
        }
        self.assertFalse(leaked)

    def test_set_proof_rejects_generation_total_or_fingerprint_inconsistency(
        self,
    ) -> None:
        artifacts = (DatasetArtifactProof("a" * 64, 1),)
        generation_id = generation_id_for(("a" * 64,))
        fingerprint = canonical_artifact_set_fingerprint(artifacts)
        with self.assertRaisesRegex(ValueError, "generation_id does not commit"):
            DatasetArtifactSetProof("b" * 64, artifacts, 1, fingerprint)
        with self.assertRaisesRegex(ValueError, "exact artifact total"):
            DatasetArtifactSetProof(generation_id, artifacts, 2, fingerprint)
        with self.assertRaisesRegex(ValueError, "does not match"):
            DatasetArtifactSetProof(generation_id, artifacts, 1, "b" * 64)


if __name__ == "__main__":
    unittest.main()
