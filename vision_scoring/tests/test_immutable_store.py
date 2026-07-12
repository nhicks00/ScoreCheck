from __future__ import annotations

from dataclasses import FrozenInstanceError
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import vision_scoring.immutable_store as immutable_store
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    ImmutableStoreError,
    bootstrap_generation_lock,
    generation_id_for,
    generation_read_lease,
    generation_write_lock,
    load_generation_descriptor,
)


class ImmutableStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "store"
        (self.root / "locks").mkdir(parents=True)
        (self.root / "generations").mkdir()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _publish(
        self,
        payloads: tuple[bytes, ...],
        *,
        path_generation_id: str | None = None,
        descriptor: GenerationDescriptor | None = None,
    ) -> tuple[GenerationDescriptor, Path]:
        digests = tuple(sorted(hashlib.sha256(value).hexdigest() for value in payloads))
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

    def assert_store_error(self, code: str, operation: object) -> ImmutableStoreError:
        with self.assertRaises(ImmutableStoreError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_generation_id_is_canonical_domain_separated_and_immutable(self) -> None:
        first = hashlib.sha256(b"first").hexdigest()
        second = hashlib.sha256(b"second").hexdigest()
        object_sha256s = tuple(sorted((first, second)))
        payload = {
            "domain": "multicourt-vision-scoring:immutable-generation-id:v1",
            "object_sha256s": list(object_sha256s),
            "schema_version": "1.0",
        }
        expected = hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()

        descriptor = GenerationDescriptor.build(object_sha256s)

        self.assertEqual(generation_id_for(object_sha256s), expected)
        self.assertEqual(descriptor.generation_id, expected)
        self.assertEqual(
            json.loads(descriptor.canonical_json()),
            descriptor.to_canonical_dict(),
        )
        with self.assertRaises(FrozenInstanceError):
            descriptor.generation_id = "a" * 64  # type: ignore[misc]

    def test_digest_set_must_be_sorted_unique_lowercase_and_bounded(self) -> None:
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            GenerationDescriptor.build([])  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "sorted.*no duplicates"):
            GenerationDescriptor.build(("b" * 64, "a" * 64))
        with self.assertRaisesRegex(ValueError, "sorted.*no duplicates"):
            GenerationDescriptor.build(("a" * 64, "a" * 64))
        with self.assertRaisesRegex(ValueError, "raw lowercase"):
            GenerationDescriptor.build(("A" * 64,))
        with patch.object(immutable_store, "MAX_GENERATION_OBJECTS", 1):
            with self.assertRaisesRegex(ValueError, "more than 1"):
                GenerationDescriptor.build(("a" * 64, "b" * 64))

    def test_strict_descriptor_loader_accepts_only_exact_canonical_json(self) -> None:
        descriptor = GenerationDescriptor.build((hashlib.sha256(b"x").hexdigest(),))
        path = self.root / "canonical.json"
        path.write_bytes(descriptor.canonical_bytes())
        self.assertEqual(load_generation_descriptor(path), descriptor)

        path.write_bytes(descriptor.canonical_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "strict canonical"):
            load_generation_descriptor(path)

        noncanonical = json.dumps(
            descriptor.to_canonical_dict(),
            ensure_ascii=False,
            sort_keys=False,
        ).encode("utf-8")
        path.write_bytes(noncanonical)
        with self.assertRaisesRegex(ValueError, "strict canonical"):
            load_generation_descriptor(path)

    def test_descriptor_loader_rejects_duplicate_keys_invalid_utf8_and_shape(self) -> None:
        descriptor = GenerationDescriptor.build(())
        path = self.root / "descriptor.json"
        duplicated = descriptor.canonical_bytes().replace(
            b'{"domain":',
            b'{"domain":"duplicate","domain":',
            1,
        )
        path.write_bytes(duplicated)
        with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
            load_generation_descriptor(path)

        path.write_bytes(b"\xff")
        with self.assertRaisesRegex(ValueError, "valid UTF-8 JSON"):
            load_generation_descriptor(path)

        path.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "root must be"):
            load_generation_descriptor(path)

        path.write_bytes(b"x" * (immutable_store.MAX_GENERATION_DESCRIPTOR_BYTES + 1))
        self.assert_store_error(
            "DESCRIPTOR_SHAPE", lambda: load_generation_descriptor(path)
        )

    def test_descriptor_loader_detects_descriptor_path_replacement(self) -> None:
        descriptor = GenerationDescriptor.build(())
        path = self.root / "descriptor.json"
        path.write_bytes(descriptor.canonical_bytes())
        original_read = immutable_store._read_chunk
        replaced = False

        def replace_after_read(file_descriptor: int, count: int) -> bytes:
            nonlocal replaced
            chunk = original_read(file_descriptor, count)
            if not replaced:
                replacement = self.root / "replacement.json"
                replacement.write_bytes(descriptor.canonical_bytes())
                os.replace(replacement, path)
                replaced = True
            return chunk

        with patch.object(immutable_store, "_read_chunk", replace_after_read):
            self.assert_store_error(
                "DESCRIPTOR_CHANGED", lambda: load_generation_descriptor(path)
            )

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_descriptor_loader_rejects_symlink(self) -> None:
        descriptor = GenerationDescriptor.build(())
        target = self.root / "target.json"
        target.write_bytes(descriptor.canonical_bytes())
        link = self.root / "link.json"
        link.symlink_to(target)
        self.assert_store_error(
            "DESCRIPTOR_SHAPE", lambda: load_generation_descriptor(link)
        )

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO support required")
    def test_descriptor_loader_rejects_fifo_without_blocking(self) -> None:
        path = self.root / "descriptor.fifo"
        os.mkfifo(path)
        self.assert_store_error(
            "DESCRIPTOR_SHAPE", lambda: load_generation_descriptor(path)
        )

    def test_generation_path_must_match_descriptor_generation(self) -> None:
        first = GenerationDescriptor.build((hashlib.sha256(b"first").hexdigest(),))
        second = GenerationDescriptor.build((hashlib.sha256(b"second").hexdigest(),))
        _, generation = self._publish(
            (b"first",),
            path_generation_id=second.generation_id,
            descriptor=first,
        )
        self.assertTrue(generation.exists())
        self.assert_store_error(
            "GENERATION_MISMATCH",
            lambda: generation_read_lease(self.root, second.generation_id).__enter__(),
        )

    def test_path_attacks_are_rejected_before_filesystem_lookup(self) -> None:
        for invalid in (
            "../" + "a" * 64,
            "sha256:" + "a" * 64,
            "A" * 64,
            "a" * 63,
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "raw lowercase SHA-256"):
                    generation_read_lease(self.root, invalid)

        descriptor, _ = self._publish((b"declared",))
        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            for invalid in ("../" + "a" * 64, "A" * 64):
                with self.subTest(object_digest=invalid):
                    with self.assertRaisesRegex(ValueError, "raw lowercase SHA-256"):
                        with lease.open_verified_object(invalid):
                            pass

    def test_verified_object_is_streamed_to_safe_staging_before_exposure(self) -> None:
        payload = (b"large-streaming-payload\n" * 200_000) + b"end"
        descriptor, generation = self._publish((payload,))
        digest = hashlib.sha256(payload).hexdigest()
        source = generation / "objects" / digest

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            self.assertEqual(lease.descriptor, descriptor)
            with lease.open_verified_object(digest) as verified:
                source.write_bytes(b"untrusted post-verification mutation")
                chunks: list[bytes] = []
                while chunk := verified.read(37_019):
                    chunks.append(chunk)
                self.assertEqual(b"".join(chunks), payload)

        with self.assertRaisesRegex(RuntimeError, "not active"):
            _ = lease.descriptor

    def test_undeclared_and_hash_mismatched_objects_fail_closed(self) -> None:
        descriptor, generation = self._publish((b"declared",))
        undeclared = hashlib.sha256(b"undeclared").hexdigest()
        (generation / "objects" / undeclared).write_bytes(b"undeclared")
        declared = descriptor.object_sha256s[0]
        (generation / "objects" / declared).write_bytes(b"wrong")

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            self.assert_store_error(
                "OBJECT_UNDECLARED",
                lambda: lease.open_verified_object(undeclared).__enter__(),
            )
            self.assert_store_error(
                "OBJECT_HASH",
                lambda: lease.open_verified_object(declared).__enter__(),
            )

    def test_in_place_mutation_during_staging_is_detected(self) -> None:
        payload = b"a" * (2 * 1024 * 1024)
        descriptor, generation = self._publish((payload,))
        digest = hashlib.sha256(payload).hexdigest()
        source = generation / "objects" / digest
        original_read = immutable_store._read_chunk
        mutated = False

        def mutate_after_first_chunk(file_descriptor: int, count: int) -> bytes:
            nonlocal mutated
            chunk = original_read(file_descriptor, count)
            if chunk and not mutated:
                with source.open("r+b") as stream:
                    stream.seek(0)
                    stream.write(b"z" * len(payload))
                    stream.flush()
                    os.fsync(stream.fileno())
                mutated = True
            return chunk

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            with patch.object(immutable_store, "_read_chunk", mutate_after_first_chunk):
                self.assert_store_error(
                    "OBJECT_CHANGED",
                    lambda: lease.open_verified_object(digest).__enter__(),
                )

    def test_direct_object_path_replacement_during_staging_is_detected(self) -> None:
        payload = b"a" * (2 * 1024 * 1024)
        descriptor, generation = self._publish((payload,))
        digest = hashlib.sha256(payload).hexdigest()
        source = generation / "objects" / digest
        original_read = immutable_store._read_chunk
        replaced = False

        def replace_after_first_chunk(file_descriptor: int, count: int) -> bytes:
            nonlocal replaced
            chunk = original_read(file_descriptor, count)
            if chunk and not replaced:
                replacement = generation / "objects" / "replacement"
                replacement.write_bytes(payload)
                os.replace(replacement, source)
                replaced = True
            return chunk

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            with patch.object(immutable_store, "_read_chunk", replace_after_first_chunk):
                self.assert_store_error(
                    "OBJECT_REPLACED",
                    lambda: lease.open_verified_object(digest).__enter__(),
                )

    def test_shared_reader_lease_excludes_cooperative_writer(self) -> None:
        descriptor, generation = self._publish((b"locked",))

        with generation_read_lease(self.root, descriptor.generation_id):
            self.assert_store_error(
                "GENERATION_BUSY",
                lambda: generation_write_lock(
                    self.root,
                    descriptor.generation_id,
                    blocking=False,
                ).__enter__(),
            )

        with generation_write_lock(
            self.root,
            descriptor.generation_id,
            blocking=False,
        ):
            self.assertTrue(generation.exists())
        self.assertTrue(
            (self.root / "locks" / f"{descriptor.generation_id}.lock").is_file()
        )
        self.assertFalse(
            (generation / f"{descriptor.generation_id}.lock").exists()
        )

    def test_reader_cannot_create_lock_and_accepts_read_only_bootstrapped_lock(self) -> None:
        payload = b"publisher lock boundary"
        descriptor, _ = self._publish((payload,))
        lock_path = self.root / "locks" / f"{descriptor.generation_id}.lock"
        lock_path.unlink()

        self.assert_store_error(
            "LOCK_MISSING",
            lambda: generation_read_lease(
                self.root, descriptor.generation_id
            ).__enter__(),
        )
        self.assertFalse(lock_path.exists())

        bootstrap_generation_lock(self.root, descriptor.generation_id)
        lock_path.chmod(0o444)
        try:
            with generation_read_lease(self.root, descriptor.generation_id) as lease:
                with lease.open_verified_object(descriptor.object_sha256s[0]) as stream:
                    self.assertEqual(stream.read(), payload)
        finally:
            lock_path.chmod(0o644)

    def test_lock_bootstrap_is_exclusive_and_writer_never_creates_missing_lock(self) -> None:
        generation_id = GenerationDescriptor.build(()).generation_id
        lock_path = self.root / "locks" / f"{generation_id}.lock"
        self.assert_store_error(
            "LOCK_MISSING",
            lambda: generation_write_lock(
                self.root, generation_id, blocking=False
            ).__enter__(),
        )
        self.assertFalse(lock_path.exists())
        bootstrap_generation_lock(self.root, generation_id)
        self.assert_store_error(
            "LOCK_EXISTS",
            lambda: bootstrap_generation_lock(self.root, generation_id),
        )

    def test_object_consumer_can_only_tighten_maximum_size(self) -> None:
        payload = b"bounded object"
        descriptor, _ = self._publish((payload,))
        digest = descriptor.object_sha256s[0]
        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            for invalid in (0, -1, True, immutable_store.MAX_OBJECT_BYTES + 1):
                with self.subTest(invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "max_bytes"):
                        with lease.open_verified_object(digest, max_bytes=invalid):
                            pass
            self.assert_store_error(
                "OBJECT_SIZE",
                lambda: lease.open_verified_object(
                    digest, max_bytes=len(payload) - 1
                ).__enter__(),
            )
            with lease.open_verified_object(digest, max_bytes=len(payload)) as stream:
                self.assertEqual(stream.read(), payload)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_object_symlink_is_rejected(self) -> None:
        payload = b"symlink payload"
        descriptor, generation = self._publish((payload,))
        digest = descriptor.object_sha256s[0]
        source = generation / "objects" / digest
        target = generation / "objects" / "target"
        source.rename(target)
        source.symlink_to(target)

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            self.assert_store_error(
                "OBJECT_OPEN",
                lambda: lease.open_verified_object(digest).__enter__(),
            )

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO support required")
    def test_object_fifo_is_rejected_without_blocking(self) -> None:
        payload = b"fifo payload"
        descriptor, generation = self._publish((payload,))
        digest = descriptor.object_sha256s[0]
        source = generation / "objects" / digest
        source.unlink()
        os.mkfifo(source)

        with generation_read_lease(self.root, descriptor.generation_id) as lease:
            self.assert_store_error(
                "OBJECT_SHAPE",
                lambda: lease.open_verified_object(digest).__enter__(),
            )


if __name__ == "__main__":
    unittest.main()
