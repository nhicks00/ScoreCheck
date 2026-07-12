"""Unlinked read-only media from one exact shared artifact generation.

The caller supplies the complete sorted artifact digest tuple already bound by
the dataset boundary, not a special media-only generation and not a readiness
report as ambient authority.  This module independently checks that the tuple
commits the generation ID, that the leased descriptor is exactly the tuple,
and that the selected source is a member before staging only that source.

The staged path is unlinked and its private directory removed before yield.
Duplicated Unix descriptors share one open-file-description offset, so the
private reader context permits one coordinator owner, seeks deterministically,
and tracks descriptor identity across concurrent teardown.  This is structural
evidence only and grants no admission or scoring authority.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import os
import stat
import sys
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .artifact_store import MAX_ARTIFACT_FILES
from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from .contract_wire import require_exact_int, require_sha256
from .immutable_store import (
    ImmutableStoreError,
    generation_id_for,
    generation_read_lease,
)


_READ_CHUNK_BYTES = 1024 * 1024
_DARWIN_SF_DATALESS = 0x40000000


class StagedMediaError(ValueError):
    """Fail-closed artifact-media staging failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise StagedMediaError(code, message)


def _required_os_flag(name: str) -> int:
    value = getattr(os, name, None)
    if type(value) is not int or value == 0:
        _fail("MEDIA_PLATFORM", f"required {name} protection is unavailable")
    return value


def _close_private_descriptor(descriptor: int) -> bool:
    try:
        os.close(descriptor)
        return True
    except OSError as exc:
        # close failure is ownership-ambiguous; never retry a descriptor number
        # that another thread may already have reused, even for the same inode.
        return exc.errno == errno.EBADF


def _fstat_private_descriptor(descriptor: int) -> os.stat_result | None:
    for _ in range(2):
        try:
            return os.fstat(descriptor)
        except OSError:
            pass
    return None


def _is_dataless(value: os.stat_result) -> bool:
    if sys.platform != "darwin":
        return False
    mask = (
        getattr(stat, "SF_DATALESS", 0)
        | getattr(stat, "UF_DATALESS", 0)
        | _DARWIN_SF_DATALESS
    )
    return bool(mask and getattr(value, "st_flags", 0) & mask)


def _snapshot(value: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def _require_unlinked_readonly_media_fd(
    descriptor: int,
    *,
    source_byte_length: int,
) -> os.stat_result:
    try:
        value = os.fstat(descriptor)
        access_flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        if (access_flags & getattr(os, "O_ACCMODE", 0o3)) != os.O_RDONLY:
            _fail("MEDIA_FD", "staged media descriptor must be read-only")
        if (
            not stat.S_ISREG(value.st_mode)
            or stat.S_ISLNK(value.st_mode)
            or value.st_nlink != 0
            or value.st_size != source_byte_length
            or _is_dataless(value)
        ):
            _fail(
                "MEDIA_FD",
                "staged media must be an unlinked resident regular file",
            )
        if os.lseek(descriptor, 0, os.SEEK_SET) != 0:
            _fail("MEDIA_FD", "staged media descriptor is not seekable")
        return value
    except StagedMediaError:
        raise
    except OSError as exc:
        raise StagedMediaError(
            "MEDIA_FD", "staged media descriptor validation failed"
        ) from exc


def _close_if_owned(descriptor: int, owner: tuple[int, int]) -> bool:
    """Close only the descriptor still naming the bound inode.

    False means it was already closed/reused or the close itself failed.  A
    reused foreign descriptor is deliberately left untouched.
    """

    if descriptor < 0:
        return True
    try:
        current = os.fstat(descriptor)
    except OSError:
        return False
    if _identity(current) != owner:
        return False
    try:
        os.close(descriptor)
        return True
    except OSError:
        return False


class _StagedVerifiedArtifactMediaV1:
    """Private unlinked descriptor capability; never serialize or persist it."""

    __slots__ = (
        "_active",
        "_active_reader_fd",
        "_active_reader_identity",
        "_artifact_generation_id",
        "_artifact_sha256s",
        "_bound_snapshot",
        "_descriptor",
        "_primary_identity",
        "_source_byte_length",
        "_source_sha256",
        "_state_lock",
    )

    def __init__(
        self,
        *,
        descriptor: int,
        artifact_generation_id: str,
        artifact_sha256s: tuple[str, ...],
        source_sha256: str,
        source_byte_length: int,
    ) -> None:
        value = _require_unlinked_readonly_media_fd(
            descriptor,
            source_byte_length=source_byte_length,
        )
        self._descriptor = descriptor
        self._artifact_generation_id = artifact_generation_id
        self._artifact_sha256s = artifact_sha256s
        self._source_sha256 = source_sha256
        self._source_byte_length = source_byte_length
        self._bound_snapshot = _snapshot(value)
        self._primary_identity = _identity(value)
        self._active_reader_fd = -1
        self._active_reader_identity: tuple[int, int] | None = None
        self._state_lock = threading.RLock()
        self._active = True

    def __repr__(self) -> str:
        return (
            "_StagedVerifiedArtifactMediaV1("
            f"source_sha256={self._source_sha256!r}, "
            f"source_byte_length={self._source_byte_length!r}, "
            f"active={self._active!r})"
        )

    @property
    def artifact_generation_id(self) -> str:
        return self._artifact_generation_id

    @property
    def artifact_sha256s(self) -> tuple[str, ...]:
        return self._artifact_sha256s

    @property
    def source_sha256(self) -> str:
        return self._source_sha256

    @property
    def source_byte_length(self) -> int:
        return self._source_byte_length

    @property
    def path_unlinked(self) -> bool:
        with self._state_lock:
            if not self._active:
                raise RuntimeError("staged media capability is not active")
            return os.fstat(self._descriptor).st_nlink == 0

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_test(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    @property
    def admissible_for_live_scoring(self) -> bool:
        return False

    @contextmanager
    def _open_immediate_child_reader(self) -> Iterator[int]:
        """Yield one tracked fd for exactly one immediate pinned child.

        ``dup`` shares the primary offset.  The trusted coordinator owns the
        descriptor in this context, may pass it only to that child with an
        explicit ``pass_fds``-style mechanism, and must keep the context open
        until the complete child process group is reaped.  Teardown can run
        concurrently because state is protected only for short state changes.
        """

        duplicate = -1
        duplicate_identity: tuple[int, int] | None = None
        with self._state_lock:
            if not self._active:
                raise RuntimeError("staged media capability is not active")
            if self._active_reader_fd >= 0:
                raise RuntimeError("staged media already has an active reader owner")
            current = _require_unlinked_readonly_media_fd(
                self._descriptor,
                source_byte_length=self._source_byte_length,
            )
            if _snapshot(current) != self._bound_snapshot:
                _fail("MEDIA_FD", "staged media descriptor changed after binding")
            command = getattr(fcntl, "F_DUPFD_CLOEXEC", None)
            if type(command) is not int:
                _fail("MEDIA_PLATFORM", "F_DUPFD_CLOEXEC is unavailable")
            try:
                duplicate = fcntl.fcntl(self._descriptor, command, 0)
                os.set_inheritable(duplicate, False)
                duplicate_value = _require_unlinked_readonly_media_fd(
                    duplicate,
                    source_byte_length=self._source_byte_length,
                )
                if _snapshot(duplicate_value) != self._bound_snapshot:
                    _fail(
                        "MEDIA_FD",
                        "duplicated media descriptor changed after binding",
                    )
                duplicate_identity = _identity(duplicate_value)
                self._active_reader_fd = duplicate
                self._active_reader_identity = duplicate_identity
            except BaseException:
                if duplicate >= 0:
                    # The descriptor has not crossed the yield boundary, so it
                    # is still unambiguously local even if validation fstat
                    # failed.  Close once: retrying an ambiguous close could
                    # target a descriptor number reused by another thread.
                    try:
                        os.close(duplicate)
                    except OSError:
                        pass
                raise

        try:
            yield duplicate
        finally:
            with self._state_lock:
                if duplicate_identity is not None:
                    _close_if_owned(duplicate, duplicate_identity)
                if (
                    self._active_reader_fd == duplicate
                    and self._active_reader_identity == duplicate_identity
                ):
                    self._active_reader_fd = -1
                    self._active_reader_identity = None
                if self._active and self._descriptor >= 0:
                    try:
                        os.lseek(self._descriptor, 0, os.SEEK_SET)
                    except OSError:
                        pass

    def _deactivate_and_close(self) -> None:
        failures: list[str] = []
        with self._state_lock:
            if not self._active:
                return
            self._active = False
            if (
                self._active_reader_fd >= 0
                and self._active_reader_identity is not None
            ):
                reader_fd = self._active_reader_fd
                reader_identity = self._active_reader_identity
                try:
                    reader_value = os.fstat(reader_fd)
                except OSError:
                    reader_value = None
                if reader_value is not None and _identity(reader_value) == reader_identity:
                    if not _close_if_owned(reader_fd, reader_identity):
                        failures.append("active reader descriptor close failed")
                self._active_reader_fd = -1
                self._active_reader_identity = None

            try:
                primary_value = os.fstat(self._descriptor)
            except OSError:
                primary_value = None
            if primary_value is None or _identity(primary_value) != self._primary_identity:
                failures.append("primary media descriptor identity changed")
            elif not _close_if_owned(self._descriptor, self._primary_identity):
                failures.append("primary media descriptor close failed")
            self._descriptor = -1
        if failures:
            raise StagedMediaError(
                "MEDIA_CLEANUP", "staged media descriptor cleanup was incomplete"
            )


def _validate_inputs(
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_sha256: str,
    source_byte_length: int,
) -> None:
    try:
        if not isinstance(artifact_store_root, Path):
            raise ValueError("artifact_store_root must be a pathlib.Path")
        require_sha256(artifact_generation_id, "artifact_generation_id")
        require_sha256(source_sha256, "source_sha256")
        if type(artifact_sha256s) is not tuple or not 1 <= len(
            artifact_sha256s
        ) <= MAX_ARTIFACT_FILES:
            raise ValueError("artifact_sha256s must be a bounded immutable tuple")
        for digest in artifact_sha256s:
            require_sha256(digest, "artifact_sha256s entry")
        if artifact_sha256s != tuple(sorted(artifact_sha256s)) or len(
            set(artifact_sha256s)
        ) != len(artifact_sha256s):
            raise ValueError("artifact_sha256s must be unique and canonically sorted")
        if generation_id_for(artifact_sha256s) != artifact_generation_id:
            raise ValueError("artifact_generation_id does not commit artifact_sha256s")
        if source_sha256 not in artifact_sha256s:
            raise ValueError("source_sha256 must be a member of artifact_sha256s")
        require_exact_int(
            source_byte_length,
            "source_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
    except ValueError as exc:
        raise StagedMediaError(
            "MEDIA_INPUT", "artifact media coordinates are invalid"
        ) from exc


def _safe_rmdir_bound(
    path: Path,
    identity: tuple[int, int],
) -> bool:
    try:
        value = path.lstat()
        if not stat.S_ISDIR(value.st_mode) or _identity(value) != identity:
            return False
        os.rmdir(path)
        return True
    except OSError:
        return False


def _open_private_staging_directory(
) -> tuple[Path, int, tuple[int, int]]:
    path: Path | None = None
    descriptor = -1
    path_identity: tuple[int, int] | None = None
    transferred = False
    try:
        path = Path(tempfile.mkdtemp(prefix="vision-scoring-media-"))
        path_identity = _identity(path.lstat())
        os.chmod(path, 0o700)
        path_value = path.lstat()
        if (
            not stat.S_ISDIR(path_value.st_mode)
            or stat.S_IMODE(path_value.st_mode) != 0o700
            or _is_dataless(path_value)
        ):
            _fail("MEDIA_STAGING", "private media staging directory is unsafe")
        if _identity(path_value) != path_identity:
            _fail("MEDIA_STAGING", "private media staging directory changed")
        descriptor = os.open(
            path,
            os.O_RDONLY
            | _required_os_flag("O_DIRECTORY")
            | _required_os_flag("O_NOFOLLOW")
            | _required_os_flag("O_CLOEXEC"),
        )
        descriptor_value = os.fstat(descriptor)
        if (
            _snapshot(descriptor_value) != _snapshot(path_value)
            or not stat.S_ISDIR(descriptor_value.st_mode)
            or _is_dataless(descriptor_value)
        ):
            _fail("MEDIA_STAGING", "private media staging directory changed")
        transferred = True
        return path, descriptor, path_identity
    except StagedMediaError:
        raise
    except OSError as exc:
        raise StagedMediaError(
            "MEDIA_STAGING", "private media staging could not be created"
        ) from exc
    finally:
        if not transferred:
            if path is not None:
                if path_identity is not None:
                    _safe_rmdir_bound(path, path_identity)
                else:
                    try:
                        os.rmdir(path)
                    except OSError:
                        pass
            if descriptor >= 0:
                _close_private_descriptor(descriptor)


def _cleanup_private_staging_directory(
    path: Path,
    descriptor: int,
    path_identity: tuple[int, int],
) -> tuple[str, ...]:
    failures: list[str] = []
    descriptor_bound = False
    descriptor_value = _fstat_private_descriptor(descriptor)
    if descriptor_value is None:
        failures.append("private media directory descriptor is unavailable")
    else:
        descriptor_bound = _identity(descriptor_value) == path_identity
    if descriptor_bound:
        try:
            value = os.stat(
                "source-media",
                dir_fd=descriptor,
                follow_symlinks=False,
            )
            if stat.S_ISREG(value.st_mode):
                os.unlink("source-media", dir_fd=descriptor)
            else:
                failures.append("private media child shape changed")
        except FileNotFoundError:
            pass
        except OSError:
            failures.append("private media child could not be removed")
    if not _safe_rmdir_bound(path, path_identity):
        failures.append("private media directory path was not removed")
    if not _close_if_owned(descriptor, path_identity):
        failures.append("private media directory descriptor close failed")
    return tuple(failures)


def _copy_reopen_verify_unlink(
    source: Any,
    *,
    directory_fd: int,
    source_sha256: str,
    source_byte_length: int,
) -> int:
    name = "source-media"
    writer = -1
    reader = -1
    created = False
    try:
        writer = os.open(
            name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | _required_os_flag("O_NOFOLLOW")
            | _required_os_flag("O_CLOEXEC"),
            0o600,
            dir_fd=directory_fd,
        )
        created = True
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = source.read(_READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > source_byte_length or total > MAX_FINALIZED_SOURCE_BYTES:
                _fail("MEDIA_SIZE", "verified source size differs from its contract")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(writer, view)
                if written <= 0:
                    _fail("MEDIA_STAGING", "media staging write was incomplete")
                view = view[written:]
        if total != source_byte_length:
            _fail("MEDIA_SIZE", "verified source size differs from its contract")
        if digest.hexdigest() != source_sha256:
            _fail("MEDIA_OBJECT", "verified source digest differs from its contract")
        os.fchmod(writer, 0o400)
        os.fsync(writer)
        written_stat = os.fstat(writer)
        path_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            _snapshot(written_stat) != _snapshot(path_stat)
            or not stat.S_ISREG(written_stat.st_mode)
            or written_stat.st_nlink != 1
            or _is_dataless(written_stat)
            or written_stat.st_size != source_byte_length
            or stat.S_IMODE(written_stat.st_mode) != 0o400
        ):
            _fail("MEDIA_STAGING", "staged media shape is unsafe")
        os.close(writer)
        writer = -1

        reader = os.open(
            name,
            os.O_RDONLY
            | _required_os_flag("O_NOFOLLOW")
            | _required_os_flag("O_CLOEXEC"),
            dir_fd=directory_fd,
        )
        before = os.fstat(reader)
        path_before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            _snapshot(before) != _snapshot(path_before)
            or before.st_nlink != 1
            or _is_dataless(before)
        ):
            _fail("MEDIA_STAGING", "staged media changed before read-only binding")
        rebound_digest = hashlib.sha256()
        rebound_total = 0
        while True:
            chunk = os.read(reader, _READ_CHUNK_BYTES)
            if not chunk:
                break
            rebound_total += len(chunk)
            if rebound_total > source_byte_length:
                _fail("MEDIA_STAGING", "staged media changed while binding")
            rebound_digest.update(chunk)
        after = os.fstat(reader)
        path_after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            _snapshot(before) != _snapshot(after)
            or _snapshot(after) != _snapshot(path_after)
            or rebound_total != source_byte_length
            or rebound_digest.hexdigest() != source_sha256
        ):
            _fail("MEDIA_STAGING", "staged media changed while binding")
        if (fcntl.fcntl(reader, fcntl.F_GETFL) & getattr(os, "O_ACCMODE", 0o3)) != os.O_RDONLY:
            _fail("MEDIA_FD", "staged media did not reopen read-only")
        if os.lseek(reader, 0, os.SEEK_SET) != 0:
            _fail("MEDIA_FD", "staged media is not seekable")

        os.unlink(name, dir_fd=directory_fd)
        created = False
        unlinked = os.fstat(reader)
        if (
            _identity(unlinked) != _identity(after)
            or unlinked.st_size != source_byte_length
            or unlinked.st_nlink != 0
            or _is_dataless(unlinked)
        ):
            _fail("MEDIA_FD", "staged media did not become an unlinked capability")
        os.lseek(reader, 0, os.SEEK_SET)
        result = reader
        reader = -1
        return result
    except StagedMediaError:
        raise
    except OSError as exc:
        raise StagedMediaError(
            "MEDIA_STAGING", "media staging or read-only binding failed"
        ) from exc
    finally:
        if writer >= 0:
            _close_private_descriptor(writer)
        if reader >= 0:
            _close_private_descriptor(reader)
        if created:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass


@contextmanager
def stage_verified_artifact_media_v1(
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_sha256: str,
    source_byte_length: int,
) -> Iterator[_StagedVerifiedArtifactMediaV1]:
    """Stage one source from the exact leased shared artifact generation."""

    _validate_inputs(
        artifact_store_root,
        artifact_generation_id,
        artifact_sha256s,
        source_sha256,
        source_byte_length,
    )
    staging_path: Path | None = None
    directory_fd = -1
    directory_identity: tuple[int, int] | None = None
    media_fd = -1
    capability: _StagedVerifiedArtifactMediaV1 | None = None
    body_error: BaseException | None = None
    try:
        try:
            with generation_read_lease(
                artifact_store_root,
                artifact_generation_id,
            ) as lease:
                if lease.descriptor.object_sha256s != artifact_sha256s:
                    _fail(
                        "MEDIA_CLOSURE",
                        "artifact generation differs from the exact caller tuple",
                    )
                staging_path, directory_fd, directory_identity = (
                    _open_private_staging_directory()
                )
                try:
                    with lease.open_verified_object(
                        source_sha256,
                        max_bytes=MAX_FINALIZED_SOURCE_BYTES,
                    ) as source:
                        media_fd = _copy_reopen_verify_unlink(
                            source,
                            directory_fd=directory_fd,
                            source_sha256=source_sha256,
                            source_byte_length=source_byte_length,
                        )
                except ImmutableStoreError as exc:
                    raise StagedMediaError(
                        "MEDIA_OBJECT", "immutable source verification failed"
                    ) from exc

                cleanup_failures = _cleanup_private_staging_directory(
                    staging_path,
                    directory_fd,
                    directory_identity,
                )
                staging_path = None
                directory_fd = -1
                directory_identity = None
                if cleanup_failures:
                    _fail(
                        "MEDIA_CLEANUP",
                        "private media path did not remove before yield",
                    )
                capability = _StagedVerifiedArtifactMediaV1(
                    descriptor=media_fd,
                    artifact_generation_id=artifact_generation_id,
                    artifact_sha256s=artifact_sha256s,
                    source_sha256=source_sha256,
                    source_byte_length=source_byte_length,
                )
                media_fd = -1
                try:
                    yield capability
                except BaseException as exc:
                    body_error = exc
                    raise
                finally:
                    try:
                        capability._deactivate_and_close()
                    except StagedMediaError:
                        if body_error is None:
                            raise
                    finally:
                        capability = None
        except StagedMediaError:
            raise
        except ImmutableStoreError as exc:
            raise StagedMediaError(
                "MEDIA_CLOSURE", "immutable artifact generation verification failed"
            ) from exc
        except ValueError as exc:
            raise StagedMediaError(
                "MEDIA_CLOSURE", "immutable artifact generation metadata is invalid"
            ) from exc
    finally:
        if capability is not None:
            active_error = sys.exc_info()[0] is not None
            try:
                capability._deactivate_and_close()
            except StagedMediaError:
                if body_error is None and not active_error:
                    raise
        if media_fd >= 0:
            active_error = sys.exc_info()[0] is not None
            if (
                not _close_private_descriptor(media_fd)
                and body_error is None
                and not active_error
            ):
                _fail("MEDIA_CLEANUP", "staged media descriptor close failed")
        if (
            staging_path is not None
            and directory_fd >= 0
            and directory_identity is not None
        ):
            failures = _cleanup_private_staging_directory(
                staging_path,
                directory_fd,
                directory_identity,
            )
            if failures and body_error is None and sys.exc_info()[0] is None:
                raise StagedMediaError(
                    "MEDIA_CLEANUP", "private media staging cleanup failed"
                )


__all__ = [
    "MAX_FINALIZED_SOURCE_BYTES",
    "StagedMediaError",
    "stage_verified_artifact_media_v1",
]
