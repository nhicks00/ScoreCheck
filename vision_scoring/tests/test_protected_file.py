from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import patch

import vision_scoring.protected_file as protected_file
from vision_scoring.protected_file import (
    PROTECTED_FILE_CHANGED,
    PROTECTED_FILE_CLOSE,
    PROTECTED_FILE_ERROR_CODES,
    PROTECTED_FILE_INPUT,
    PROTECTED_FILE_OPEN,
    PROTECTED_FILE_PLATFORM_UNSAFE,
    PROTECTED_FILE_READ,
    PROTECTED_FILE_SHAPE,
    PROTECTED_FILE_SIZE,
    PROTECTED_FILE_UNAVAILABLE,
    ProtectedFileError,
    read_protected_file_bytes,
)


class ProtectedFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.path = self.root / "payload.bin"
        self.path.write_bytes(b"protected payload")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def assert_protected_error(
        self,
        code: str,
        operation: object,
    ) -> ProtectedFileError:
        with self.assertRaises(ProtectedFileError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        self.assertIn(caught.exception.code, PROTECTED_FILE_ERROR_CODES)
        self.assertLessEqual(len(str(caught.exception)), 160)
        return caught.exception

    def read(self, path: Path | None = None, *, max_bytes: int = 1024) -> bytes:
        return read_protected_file_bytes(
            self.path if path is None else path,
            max_bytes=max_bytes,
            label="test-payload",
        )

    def test_returns_exact_raw_bytes_with_exact_size_read_and_growth_probe(self) -> None:
        payload = b"abc\x00def\xffghi"
        self.path.write_bytes(payload)
        calls: list[int] = []
        original_read = protected_file._read_chunk

        def record_read(descriptor: int, count: int) -> bytes:
            calls.append(count)
            return original_read(descriptor, count)

        with (
            patch.object(protected_file, "_READ_CHUNK_BYTES", 3),
            patch.object(protected_file, "_read_chunk", record_read),
        ):
            result = self.read(max_bytes=len(payload))

        self.assertIs(type(result), bytes)
        self.assertEqual(result, payload)
        self.assertEqual(calls, [3, 3, 3, 2, 1])

    def test_open_is_read_only_and_uses_every_required_protection(self) -> None:
        original_open = protected_file.os.open
        observed_flags: list[int] = []

        def record_open(path: Path, flags: int) -> int:
            observed_flags.append(flags)
            return original_open(path, flags)

        with patch.object(protected_file.os, "open", record_open):
            self.assertEqual(self.read(), b"protected payload")

        self.assertEqual(len(observed_flags), 1)
        flags = observed_flags[0]
        self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
        for name in ("O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"):
            with self.subTest(name=name):
                required = getattr(os, name)
                self.assertEqual(flags & required, required)

    def test_inputs_must_have_exact_types_positive_bound_and_short_label(self) -> None:
        concrete_path_type = type(Path())

        class DerivedPath(concrete_path_type):  # type: ignore[misc, valid-type]
            pass

        class DerivedInt(int):
            pass

        class DerivedStr(str):
            pass

        invalid_calls = (
            lambda: read_protected_file_bytes(  # type: ignore[arg-type]
                str(self.path), max_bytes=1024, label="payload"
            ),
            lambda: read_protected_file_bytes(
                DerivedPath(self.path), max_bytes=1024, label="payload"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=True, label="payload"  # type: ignore[arg-type]
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=DerivedInt(1024), label="payload"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=0, label="payload"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=-1, label="payload"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=1024, label=""
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=1024, label="x" * 65
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=1024, label="bad\nlabel"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=1024, label="nonascii-\N{SNOWMAN}"
            ),
            lambda: read_protected_file_bytes(
                self.path, max_bytes=1024, label=DerivedStr("payload")
            ),
        )
        for operation in invalid_calls:
            with self.subTest(operation=operation):
                self.assert_protected_error(PROTECTED_FILE_INPUT, operation)

        self.assertEqual(
            read_protected_file_bytes(
                self.path,
                max_bytes=10**100,
                label="payload",
            ),
            b"protected payload",
        )

    def test_missing_empty_and_oversize_files_fail_with_stable_codes(self) -> None:
        missing = self.root / "missing.bin"
        self.assert_protected_error(
            PROTECTED_FILE_UNAVAILABLE,
            lambda: self.read(missing),
        )

        self.path.write_bytes(b"")
        self.assert_protected_error(PROTECTED_FILE_SIZE, self.read)

        self.path.write_bytes(b"12345")
        self.assert_protected_error(
            PROTECTED_FILE_SIZE,
            lambda: self.read(max_bytes=4),
        )

    def test_directory_symlink_hardlink_and_fifo_are_rejected(self) -> None:
        self.assert_protected_error(PROTECTED_FILE_SHAPE, lambda: self.read(self.root))

        if hasattr(os, "symlink"):
            link = self.root / "payload-link.bin"
            link.symlink_to(self.path)
            self.assert_protected_error(
                PROTECTED_FILE_SHAPE,
                lambda: self.read(link),
            )

        if hasattr(os, "link"):
            alias = self.root / "payload-alias.bin"
            os.link(self.path, alias)
            self.assert_protected_error(PROTECTED_FILE_SHAPE, self.read)
            alias.unlink()

        if hasattr(os, "mkfifo"):
            fifo = self.root / "payload.fifo"
            os.mkfifo(fifo)
            started = time.monotonic()
            self.assert_protected_error(
                PROTECTED_FILE_SHAPE,
                lambda: self.read(fifo),
            )
            self.assertLess(time.monotonic() - started, 1.0)

    def test_missing_required_open_flags_fail_before_filesystem_access(self) -> None:
        for name in ("O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"):
            with self.subTest(name=name):
                with (
                    patch.object(protected_file.os, name, None),
                    patch.object(protected_file.os, "lstat") as lstat_mock,
                ):
                    self.assert_protected_error(
                        PROTECTED_FILE_PLATFORM_UNSAFE,
                        self.read,
                    )
                lstat_mock.assert_not_called()

    def test_darwin_dataless_file_is_rejected_before_open(self) -> None:
        metadata = self.path.lstat()
        dataless = SimpleNamespace(
            st_dev=metadata.st_dev,
            st_ino=metadata.st_ino,
            st_mode=metadata.st_mode,
            st_nlink=metadata.st_nlink,
            st_size=metadata.st_size,
            st_mtime_ns=metadata.st_mtime_ns,
            st_ctime_ns=metadata.st_ctime_ns,
            st_flags=protected_file._DARWIN_SF_DATALESS,
        )
        with (
            patch.object(protected_file.sys, "platform", "darwin"),
            patch.object(protected_file.os, "lstat", return_value=dataless),
            patch.object(protected_file.os, "open") as open_mock,
        ):
            self.assert_protected_error(PROTECTED_FILE_SHAPE, self.read)
        open_mock.assert_not_called()

    def test_replacement_between_lstat_and_open_is_detected(self) -> None:
        replacement = self.root / "replacement.bin"
        replacement.write_bytes(self.path.read_bytes())
        displaced = self.root / "displaced.bin"
        original_open = protected_file.os.open
        replaced = False

        def replace_before_open(path: Path, flags: int) -> int:
            nonlocal replaced
            if not replaced:
                os.replace(self.path, displaced)
                os.replace(replacement, self.path)
                replaced = True
            return original_open(path, flags)

        with patch.object(protected_file.os, "open", replace_before_open):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO support required")
    def test_fifo_replacement_before_open_cannot_block(self) -> None:
        fifo = self.root / "replacement.fifo"
        os.mkfifo(fifo)
        displaced = self.root / "displaced.bin"
        original_open = protected_file.os.open
        replaced = False

        def replace_with_fifo(path: Path, flags: int) -> int:
            nonlocal replaced
            if not replaced:
                os.replace(self.path, displaced)
                os.replace(fifo, self.path)
                replaced = True
            return original_open(path, flags)

        started = time.monotonic()
        with patch.object(protected_file.os, "open", replace_with_fifo):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_path_replacement_during_read_is_detected(self) -> None:
        replacement = self.root / "replacement.bin"
        replacement.write_bytes(self.path.read_bytes())
        original_read = protected_file._read_chunk
        replaced = False

        def replace_after_read(descriptor: int, count: int) -> bytes:
            nonlocal replaced
            chunk = original_read(descriptor, count)
            if chunk and not replaced:
                os.replace(replacement, self.path)
                replaced = True
            return chunk

        with patch.object(protected_file, "_read_chunk", replace_after_read):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)

    def test_replacement_immediately_before_final_lstat_is_detected(self) -> None:
        replacement = self.root / "replacement.bin"
        replacement.write_bytes(self.path.read_bytes())
        original_lstat = protected_file.os.lstat
        calls = 0

        def replace_on_final_lstat(path: Path) -> os.stat_result:
            nonlocal calls
            calls += 1
            if calls == 2:
                os.replace(replacement, self.path)
            return original_lstat(path)

        with patch.object(protected_file.os, "lstat", replace_on_final_lstat):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)
        self.assertEqual(calls, 2)

    def test_same_inode_content_mutation_preserving_size_is_detected(self) -> None:
        payload = b"A" * 128
        self.path.write_bytes(payload)
        initial = self.path.stat()
        original_read = protected_file._read_chunk
        mutated = False

        def mutate_after_read(descriptor: int, count: int) -> bytes:
            nonlocal mutated
            chunk = original_read(descriptor, count)
            if chunk and not mutated:
                self.path.write_bytes(b"B" * len(payload))
                os.utime(
                    self.path,
                    ns=(initial.st_atime_ns, initial.st_mtime_ns + 1_000_000_000),
                )
                mutated = True
            return chunk

        with patch.object(protected_file, "_read_chunk", mutate_after_read):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)
        self.assertEqual(self.path.stat().st_ino, initial.st_ino)
        self.assertEqual(self.path.stat().st_size, initial.st_size)

    def test_truncation_growth_and_link_count_changes_are_detected(self) -> None:
        original_read = protected_file._read_chunk

        truncated = False

        def truncate_before_read(descriptor: int, count: int) -> bytes:
            nonlocal truncated
            if not truncated:
                os.truncate(self.path, 1)
                truncated = True
            return original_read(descriptor, count)

        with patch.object(protected_file, "_read_chunk", truncate_before_read):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)

        self.path.write_bytes(b"growth target")
        grown = False

        def grow_after_read(descriptor: int, count: int) -> bytes:
            nonlocal grown
            chunk = original_read(descriptor, count)
            if chunk and not grown:
                with self.path.open("ab") as stream:
                    stream.write(b"+")
                grown = True
            return chunk

        with patch.object(protected_file, "_read_chunk", grow_after_read):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)

        self.path.write_bytes(b"link target")
        alias = self.root / "late-alias.bin"
        linked = False

        def link_after_read(descriptor: int, count: int) -> bytes:
            nonlocal linked
            chunk = original_read(descriptor, count)
            if chunk and not linked:
                os.link(self.path, alias)
                linked = True
            return chunk

        with patch.object(protected_file, "_read_chunk", link_after_read):
            self.assert_protected_error(PROTECTED_FILE_CHANGED, self.read)

    def test_descriptor_is_closed_after_success_and_read_failure(self) -> None:
        original_open = protected_file.os.open
        original_close = protected_file.os.close
        opened: list[int] = []
        closed: list[int] = []

        def record_open(path: Path, flags: int) -> int:
            descriptor = original_open(path, flags)
            opened.append(descriptor)
            return descriptor

        def record_close(descriptor: int) -> None:
            closed.append(descriptor)
            original_close(descriptor)

        with (
            patch.object(protected_file.os, "open", record_open),
            patch.object(protected_file.os, "close", record_close),
        ):
            self.assertEqual(self.read(), b"protected payload")

        self.assertEqual(closed, opened)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

        opened.clear()
        closed.clear()
        with (
            patch.object(protected_file.os, "open", record_open),
            patch.object(protected_file.os, "close", record_close),
            patch.object(protected_file, "_read_chunk", side_effect=OSError("read")),
        ):
            self.assert_protected_error(PROTECTED_FILE_READ, self.read)

        self.assertEqual(closed, opened)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    def test_close_failure_is_reported_but_does_not_mask_a_primary_error(self) -> None:
        original_close = protected_file.os.close

        def close_then_fail(descriptor: int) -> None:
            original_close(descriptor)
            raise OSError("synthetic close failure")

        with patch.object(protected_file.os, "close", close_then_fail):
            self.assert_protected_error(PROTECTED_FILE_CLOSE, self.read)

        with (
            patch.object(protected_file, "_read_chunk", side_effect=OSError("read")),
            patch.object(protected_file.os, "close", close_then_fail),
        ):
            self.assert_protected_error(PROTECTED_FILE_READ, self.read)

    def test_repeated_interrupts_fail_boundedly_without_hanging(self) -> None:
        started = time.monotonic()
        with patch.object(
            protected_file,
            "_read_chunk",
            side_effect=InterruptedError("interrupted"),
        ) as read_mock:
            self.assert_protected_error(PROTECTED_FILE_READ, self.read)
        self.assertEqual(
            read_mock.call_count,
            protected_file._MAX_CONSECUTIVE_INTERRUPTS + 1,
        )
        self.assertLess(time.monotonic() - started, 1.0)

    def test_fstat_failure_after_open_closes_descriptor(self) -> None:
        original_close = protected_file.os.close
        closed: list[int] = []

        def record_close(descriptor: int) -> None:
            closed.append(descriptor)
            original_close(descriptor)

        with (
            patch.object(protected_file.os, "fstat", side_effect=OSError("fstat")),
            patch.object(protected_file.os, "close", record_close),
        ):
            self.assert_protected_error(PROTECTED_FILE_OPEN, self.read)
        self.assertEqual(len(closed), 1)


if __name__ == "__main__":
    unittest.main()
