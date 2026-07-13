from __future__ import annotations

import errno
import fcntl
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import vision_scoring.immutable_store as immutable_store
import vision_scoring.staged_media as staged_media
from vision_scoring.capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
    generation_id_for,
)
from vision_scoring.staged_media import (
    StagedMediaError,
    stage_verified_artifact_media_v1,
)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class StagedMediaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store_root = Path(self.temporary_directory.name) / "artifact-store"
        (self.store_root / "locks").mkdir(parents=True)
        (self.store_root / "generations").mkdir()
        self.payload = (b"synthetic-media-packet\n" * 2000) + b"end"
        self.metadata = b"capture metadata fixture"
        self.rights = b"rights evidence fixture"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _publish(
        self,
        payloads: tuple[bytes, ...],
        *,
        path_generation_id: str | None = None,
        descriptor: GenerationDescriptor | None = None,
    ) -> tuple[GenerationDescriptor, Path]:
        digests = tuple(sorted(_sha(payload) for payload in payloads))
        selected = descriptor or GenerationDescriptor.build(digests)
        generation_id = path_generation_id or selected.generation_id
        bootstrap_generation_lock(self.store_root, generation_id)
        generation = self.store_root / "generations" / generation_id
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for payload in payloads:
            digest = _sha(payload)
            if digest in selected.object_sha256s:
                (objects / digest).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(selected.canonical_bytes())
        return selected, generation

    def _stage(
        self,
        descriptor: GenerationDescriptor,
        *,
        artifact_sha256s: tuple[str, ...] | None = None,
        source_sha256: str | None = None,
        source_byte_length: int | None = None,
        artifact_generation_id: str | None = None,
    ):
        return stage_verified_artifact_media_v1(
            self.store_root,
            artifact_generation_id or descriptor.generation_id,
            artifact_sha256s or descriptor.object_sha256s,
            source_sha256 or _sha(self.payload),
            len(self.payload) if source_byte_length is None else source_byte_length,
        )

    def assert_media_error(self, code: str, operation: object) -> StagedMediaError:
        self.assertTrue(callable(operation))
        with self.assertRaises(StagedMediaError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_shared_artifact_generation_yields_unlinked_readonly_child_fd(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata, self.rights))
        self.assertGreater(len(descriptor.object_sha256s), 1)
        primary = -1
        with self._stage(descriptor) as media:
            primary = media._descriptor
            self.assertTrue(media.path_unlinked)
            self.assertEqual(os.fstat(primary).st_nlink, 0)
            self.assertEqual(media.artifact_generation_id, descriptor.generation_id)
            self.assertEqual(media.artifact_sha256s, descriptor.object_sha256s)
            self.assertEqual(media.source_sha256, _sha(self.payload))
            self.assertFalse(media.admissible_for_training)
            self.assertFalse(media.admissible_for_evaluation)
            self.assertFalse(media.admissible_for_test)
            self.assertFalse(media.admissible_for_deployment)
            self.assertFalse(media.admissible_for_live_scoring)
            self.assertNotIn(str(self.store_root), repr(media))
            with self.assertRaises(AttributeError):
                _ = media.__dict__

            with media._open_immediate_child_reader() as child_fd:
                access = fcntl.fcntl(child_fd, fcntl.F_GETFL)
                self.assertEqual(
                    access & getattr(os, "O_ACCMODE", 0o3), os.O_RDONLY
                )
                self.assertFalse(os.get_inheritable(child_fd))
                self.assertEqual(os.read(child_fd, 113), self.payload[:113])
                with self.assertRaisesRegex(RuntimeError, "active reader"):
                    with media._open_immediate_child_reader():
                        pass
                with self.assertRaises(OSError) as write_error:
                    os.write(child_fd, b"not allowed")
                self.assertEqual(write_error.exception.errno, errno.EBADF)

            with media._open_immediate_child_reader() as second_child:
                self.assertEqual(os.read(second_child, 113), self.payload[:113])
        with self.assertRaises(OSError):
            os.fstat(primary)
        with self.assertRaisesRegex(RuntimeError, "not active"):
            with media._open_immediate_child_reader():
                pass
        self.assertFalse(
            hasattr(staged_media, "stage_verified_singleton_media_v1")
        )

    def test_exact_tuple_generation_and_member_bindings_fail_before_membership_io(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata, self.rights))
        source = _sha(self.payload)
        missing = tuple(item for item in descriptor.object_sha256s if item != source)
        self.assert_media_error(
            "MEDIA_INPUT",
            lambda: stage_verified_artifact_media_v1(
                self.store_root,
                descriptor.generation_id,
                missing,
                source,
                len(self.payload),
            ).__enter__(),
        )
        extra = tuple(sorted((*descriptor.object_sha256s, "f" * 64)))
        self.assert_media_error(
            "MEDIA_INPUT",
            lambda: stage_verified_artifact_media_v1(
                self.store_root,
                descriptor.generation_id,
                extra,
                source,
                len(self.payload),
            ).__enter__(),
        )
        self.assert_media_error(
            "MEDIA_INPUT",
            lambda: self._stage(
                descriptor,
                artifact_generation_id="0" * 64,
            ).__enter__(),
        )
        nonmember = "e" * 64
        self.assert_media_error(
            "MEDIA_INPUT",
            lambda: stage_verified_artifact_media_v1(
                self.store_root,
                descriptor.generation_id,
                descriptor.object_sha256s,
                nonmember,
                len(self.payload),
            ).__enter__(),
        )
        self.assert_media_error(
            "MEDIA_INPUT",
            lambda: stage_verified_artifact_media_v1(
                self.store_root,
                descriptor.generation_id,
                tuple(reversed(descriptor.object_sha256s)),
                source,
                len(self.payload),
            ).__enter__(),
        )

    def test_leased_descriptor_must_equal_complete_caller_tuple(self) -> None:
        caller_tuple = tuple(sorted((_sha(self.payload), _sha(self.metadata))))
        caller_generation = generation_id_for(caller_tuple)
        wrong_descriptor = GenerationDescriptor.build(
            tuple(sorted((_sha(self.payload), _sha(self.rights))))
        )
        self._publish(
            (self.payload, self.rights),
            path_generation_id=caller_generation,
            descriptor=wrong_descriptor,
        )
        self.assert_media_error(
            "MEDIA_CLOSURE",
            lambda: stage_verified_artifact_media_v1(
                self.store_root,
                caller_generation,
                caller_tuple,
                _sha(self.payload),
                len(self.payload),
            ).__enter__(),
        )

    def test_size_tamper_symlink_hardlink_mutation_and_dataless_fail_closed(self) -> None:
        descriptor, generation = self._publish((self.payload, self.metadata))
        self.assert_media_error(
            "MEDIA_SIZE",
            lambda: self._stage(
                descriptor,
                source_byte_length=len(self.payload) - 1,
            ).__enter__(),
        )
        source_path = generation / "objects" / _sha(self.payload)
        source_path.write_bytes(b"tampered")
        self.assert_media_error(
            "MEDIA_OBJECT", lambda: self._stage(descriptor).__enter__()
        )

        # Restore the immutable fixture, then test path aliases in-place.
        source_path.write_bytes(self.payload)
        saved = generation / "saved-source"
        source_path.rename(saved)
        source_path.symlink_to(saved)
        self.assert_media_error(
            "MEDIA_OBJECT", lambda: self._stage(descriptor).__enter__()
        )
        source_path.unlink()
        saved.rename(source_path)
        alias = generation / "source-alias"
        os.link(source_path, alias)
        self.assert_media_error(
            "MEDIA_OBJECT", lambda: self._stage(descriptor).__enter__()
        )
        alias.unlink()

        payload = b"a" * (2 * 1024 * 1024)
        mutation_descriptor, mutation_generation = self._publish(
            (payload, b"mutation metadata")
        )
        mutation_source = mutation_generation / "objects" / _sha(payload)
        original_read = immutable_store._read_chunk
        mutated = False

        def mutate_after_read(file_descriptor: int, count: int) -> bytes:
            nonlocal mutated
            chunk = original_read(file_descriptor, count)
            if not mutated:
                with mutation_source.open("r+b") as source_file:
                    source_file.write(b"b")
                    source_file.flush()
                mutated = True
            return chunk

        with patch.object(immutable_store, "_read_chunk", mutate_after_read):
            self.assert_media_error(
                "MEDIA_OBJECT",
                lambda: stage_verified_artifact_media_v1(
                    self.store_root,
                    mutation_descriptor.generation_id,
                    mutation_descriptor.object_sha256s,
                    _sha(payload),
                    len(payload),
                ).__enter__(),
            )

        dataless_descriptor, _ = self._publish(
            (b"dataless source", b"dataless metadata")
        )
        with patch.object(staged_media, "_is_dataless", return_value=True):
            self.assert_media_error(
                "MEDIA_STAGING",
                lambda: stage_verified_artifact_media_v1(
                    self.store_root,
                    dataless_descriptor.generation_id,
                    dataless_descriptor.object_sha256s,
                    _sha(b"dataless source"),
                    len(b"dataless source"),
                ).__enter__(),
            )

    def test_active_manually_entered_reader_is_closed_by_outer_teardown(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata))
        outer = self._stage(descriptor)
        media = outer.__enter__()
        reader_context = media._open_immediate_child_reader()
        child_fd = reader_context.__enter__()
        outer.__exit__(None, None, None)
        with self.assertRaises(OSError):
            os.fstat(child_fd)
        reader_context.__exit__(None, None, None)

    def test_failed_pre_yield_reader_validation_closes_local_duplicate(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata))
        captured_duplicate = -1
        original_fcntl = fcntl.fcntl
        original_fstat = os.fstat

        def capture_duplicate(file_descriptor: int, command: int, *args: object):
            nonlocal captured_duplicate
            result = original_fcntl(file_descriptor, command, *args)
            if command == getattr(fcntl, "F_DUPFD_CLOEXEC"):
                captured_duplicate = result
            return result

        def fail_duplicate_fstat(file_descriptor: int) -> os.stat_result:
            if file_descriptor == captured_duplicate:
                raise OSError("injected duplicate fstat failure")
            return original_fstat(file_descriptor)

        before_fds = len(os.listdir("/dev/fd"))
        with self._stage(descriptor) as media:
            with (
                patch.object(staged_media.fcntl, "fcntl", capture_duplicate),
                patch.object(staged_media.os, "fstat", fail_duplicate_fstat),
            ):
                self.assert_media_error(
                    "MEDIA_FD",
                    lambda: media._open_immediate_child_reader().__enter__(),
                )
            self.assertGreaterEqual(captured_duplicate, 0)
            with self.assertRaises(OSError):
                os.fstat(captured_duplicate)
        self.assertEqual(len(os.listdir("/dev/fd")), before_fds)

    def test_private_close_never_retries_a_reused_foreign_descriptor(self) -> None:
        original_close = os.close
        owned_path = Path(self.temporary_directory.name) / "owned-close-source"
        owned_path.write_bytes(b"owned")
        descriptor = os.open(owned_path, os.O_RDONLY)
        first = True

        def close_then_reuse(selected: int) -> None:
            nonlocal first
            if first and selected == descriptor:
                first = False
                original_close(selected)
                foreign = os.open(owned_path, os.O_RDONLY)
                if foreign != selected:
                    os.dup2(foreign, selected)
                    original_close(foreign)
                raise OSError("close result is ownership-ambiguous")
            original_close(selected)

        with patch.object(staged_media.os, "close", close_then_reuse):
            self.assertFalse(staged_media._close_private_descriptor(descriptor))
        self.assertEqual(os.read(descriptor, 5), b"owned")
        original_close(descriptor)

    def test_fchmod_reader_and_concurrent_teardown_close_owned_descriptors(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata))
        outer = self._stage(descriptor)
        media = outer.__enter__()
        reader_context = media._open_immediate_child_reader()
        child_fd = reader_context.__enter__()
        primary = media._descriptor
        os.fchmod(child_fd, 0o600)
        failures: list[BaseException] = []

        def teardown() -> None:
            try:
                outer.__exit__(None, None, None)
            except BaseException as exc:  # pragma: no cover - assertion below
                failures.append(exc)

        thread = threading.Thread(target=teardown)
        thread.start()
        thread.join(timeout=2.0)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        with self.assertRaises(OSError):
            os.fstat(child_fd)
        with self.assertRaises(OSError):
            os.fstat(primary)
        reader_context.__exit__(None, None, None)

    def test_closed_reused_foreign_reader_fd_is_never_closed(self) -> None:
        descriptor, _ = self._publish((self.payload, self.metadata))
        outer = self._stage(descriptor)
        media = outer.__enter__()
        reader_context = media._open_immediate_child_reader()
        child_fd = reader_context.__enter__()
        os.close(child_fd)
        foreign_path = Path(self.temporary_directory.name) / "foreign-fd"
        foreign_path.write_bytes(b"foreign")
        opened = os.open(foreign_path, os.O_RDONLY)
        if opened != child_fd:
            os.dup2(opened, child_fd)
            os.close(opened)
        outer.__exit__(None, None, None)
        self.assertEqual(os.read(child_fd, 7), b"foreign")
        reader_context.__exit__(None, None, None)
        self.assertEqual(os.lseek(child_fd, 0, os.SEEK_SET), 0)
        os.close(child_fd)

    def test_private_directory_one_shot_fstat_failure_leaks_no_fd_or_path(self) -> None:
        before_fds = len(os.listdir("/dev/fd"))
        created: list[Path] = []
        original_mkdtemp = tempfile.mkdtemp
        original_fstat = os.fstat
        failed = False

        def record_mkdtemp(*args: object, **kwargs: object) -> str:
            result = original_mkdtemp(*args, **kwargs)  # type: ignore[arg-type]
            created.append(Path(result))
            return result

        def fail_once(descriptor: int) -> os.stat_result:
            nonlocal failed
            if not failed:
                failed = True
                raise OSError("one-shot fstat fault")
            return original_fstat(descriptor)

        with (
            patch.object(staged_media.tempfile, "mkdtemp", record_mkdtemp),
            patch.object(staged_media.os, "fstat", side_effect=fail_once),
        ):
            self.assert_media_error(
                "MEDIA_STAGING",
                lambda: staged_media._open_private_staging_directory(),
            )
        self.assertEqual(len(os.listdir("/dev/fd")), before_fds)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

        created.clear()
        with (
            patch.object(staged_media.tempfile, "mkdtemp", record_mkdtemp),
            patch.object(Path, "lstat", side_effect=OSError("lstat fault")),
        ):
            self.assert_media_error(
                "MEDIA_STAGING",
                lambda: staged_media._open_private_staging_directory(),
            )
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_directory_cleanup_never_closes_a_reused_foreign_descriptor(self) -> None:
        path, directory_fd, identity = staged_media._open_private_staging_directory()
        foreign_path = Path(self.temporary_directory.name) / "foreign-directory-fd"
        foreign_path.write_bytes(b"foreign")
        os.close(directory_fd)
        foreign_fd = os.open(foreign_path, os.O_RDONLY)
        if foreign_fd != directory_fd:
            os.dup2(foreign_fd, directory_fd)
            os.close(foreign_fd)

        failures = staged_media._cleanup_private_staging_directory(
            path,
            directory_fd,
            identity,
        )
        self.assertTrue(failures)
        self.assertFalse(path.exists())
        self.assertEqual(os.read(directory_fd, 7), b"foreign")
        os.close(directory_fd)

    def test_input_types_and_fixed_source_bound_are_exact(self) -> None:
        digest = "0" * 64
        other = "1" * 64
        artifacts = tuple(sorted((digest, other)))
        generation = generation_id_for(artifacts)
        for root, values, length in (
            (str(self.store_root), artifacts, 1),
            (self.store_root, list(artifacts), 1),
            (self.store_root, (other, digest), 1),
            (self.store_root, artifacts, True),
            (self.store_root, artifacts, 0),
            (self.store_root, artifacts, MAX_FINALIZED_SOURCE_BYTES + 1),
        ):
            with self.subTest(root=root, values=values, length=length):
                self.assert_media_error(
                    "MEDIA_INPUT",
                    lambda root=root, values=values, length=length: (
                        stage_verified_artifact_media_v1(
                            root,  # type: ignore[arg-type]
                            generation,
                            values,  # type: ignore[arg-type]
                            digest,
                            length,
                        ).__enter__()
                    ),
                )


if __name__ == "__main__":
    unittest.main()
