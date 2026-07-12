"""Leased, immutable generations for content-addressed dataset objects.

The store layout is intentionally small and explicit::

    <root>/
      locks/<generation-id>.lock
      generations/<generation-id>/
        descriptor.json
        objects/<lowercase-sha256>

``locks`` is outside every generation so a trusted publisher can take the
exclusive lock before creating, atomically publishing, or retiring a
generation.  Readers hold the matching shared ``flock`` for their complete
verification/consumption context.

Publisher protocol
------------------

The trusted publisher bootstraps non-symlink ``locks`` and ``generations``
directories, calls ``bootstrap_generation_lock()`` once, and never replaces or
deletes that lock file.  It computes and verifies every object digest, builds a
canonical descriptor, takes ``generation_write_lock()``, constructs the
generation in a private sibling directory, durably flushes as required by its
deployment, and publishes once into a previously absent generation path using
an atomic no-replace operation.  Published generation contents are never
modified.  Retirement also requires the exclusive lock.

This is a *cooperative* protocol, not a filesystem capability system.  A
process with write access to the store can ignore ``flock``.  Such a writer is
a trusted-boundary compromise.  Object consumption nevertheless binds safe
file descriptors, detects mutation/replacement during verification, verifies
the complete SHA-256, and stages the verified bytes in an anonymous temporary
file before exposing them.  It does not claim atomicity against arbitrary
root-level writers.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator


SCHEMA_VERSION = "1.0"
DESCRIPTOR_FILENAME = "descriptor.json"
MAX_GENERATION_OBJECTS = 20_000
MAX_GENERATION_DESCRIPTOR_BYTES = 2 * 1024 * 1024
MAX_OBJECT_BYTES = 1 << 40  # 1 TiB logical bytes per object.

_DESCRIPTOR_DOMAIN = "multicourt-vision-scoring:immutable-generation-descriptor:v1"
_GENERATION_ID_DOMAIN = "multicourt-vision-scoring:immutable-generation-id:v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_READ_CHUNK_BYTES = 1024 * 1024
_DARWIN_SF_DATALESS = 0x40000000


class ImmutableStoreError(ValueError):
    """A fail-closed immutable-store error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _canonical_json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a raw lowercase SHA-256")
    return value


def _validate_object_digests(object_sha256s: tuple[str, ...]) -> None:
    if type(object_sha256s) is not tuple:
        raise ValueError("object_sha256s must be an immutable tuple")
    if len(object_sha256s) > MAX_GENERATION_OBJECTS:
        raise ValueError(
            f"object_sha256s cannot contain more than {MAX_GENERATION_OBJECTS} values"
        )
    for digest in object_sha256s:
        _require_sha256(digest, "object_sha256s entry")
    if object_sha256s != tuple(sorted(object_sha256s)) or len(
        set(object_sha256s)
    ) != len(object_sha256s):
        raise ValueError("object_sha256s must be sorted and contain no duplicates")


def generation_id_for(object_sha256s: tuple[str, ...]) -> str:
    """Return the domain-separated ID committing one exact ordered object set."""

    _validate_object_digests(object_sha256s)
    payload = {
        "domain": _GENERATION_ID_DOMAIN,
        "object_sha256s": list(object_sha256s),
        "schema_version": SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json_bytes(payload)).hexdigest()


@dataclass(frozen=True, slots=True)
class GenerationDescriptor:
    """Canonical declaration of one immutable content-addressed generation."""

    generation_id: str
    object_sha256s: tuple[str, ...]
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        _require_sha256(self.generation_id, "generation_id")
        if type(self.schema_version) is not str or self.schema_version != SCHEMA_VERSION:
            raise ValueError(f"schema_version must be exactly {SCHEMA_VERSION!r}")
        _validate_object_digests(self.object_sha256s)
        expected = generation_id_for(self.object_sha256s)
        if self.generation_id != expected:
            raise ValueError("generation_id does not commit object_sha256s")

    @classmethod
    def build(cls, object_sha256s: tuple[str, ...]) -> GenerationDescriptor:
        """Build a descriptor from an already sorted, unique immutable tuple."""

        return cls(
            generation_id=generation_id_for(object_sha256s),
            object_sha256s=object_sha256s,
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "domain": _DESCRIPTOR_DOMAIN,
            "generation_id": self.generation_id,
            "object_sha256s": list(self.object_sha256s),
            "schema_version": self.schema_version,
        }

    def canonical_bytes(self) -> bytes:
        return _canonical_json_bytes(self.to_canonical_dict())

    def canonical_json(self) -> str:
        return self.canonical_bytes().decode("utf-8")


@dataclass(frozen=True, slots=True)
class _FileSnapshot:
    device: int
    inode: int
    mode: int
    link_count: int
    size: int
    modified_ns: int
    changed_ns: int


def _snapshot(value: os.stat_result) -> _FileSnapshot:
    return _FileSnapshot(
        device=value.st_dev,
        inode=value.st_ino,
        mode=value.st_mode,
        link_count=value.st_nlink,
        size=value.st_size,
        modified_ns=value.st_mtime_ns,
        changed_ns=value.st_ctime_ns,
    )


def _is_dataless(value: os.stat_result) -> bool:
    if sys.platform != "darwin":
        return False
    mask = (
        getattr(stat, "SF_DATALESS", 0)
        | getattr(stat, "UF_DATALESS", 0)
        | _DARWIN_SF_DATALESS
    )
    return bool(mask and getattr(value, "st_flags", 0) & mask)


def _required_flag(name: str) -> int:
    value = getattr(os, name, None)
    if type(value) is not int or value == 0:
        raise ImmutableStoreError(
            "PLATFORM_UNSAFE",
            f"platform does not provide required {name} protection",
        )
    return value


def _directory_flags() -> int:
    return (
        os.O_RDONLY
        | _required_flag("O_DIRECTORY")
        | _required_flag("O_NOFOLLOW")
        | _required_flag("O_NONBLOCK")
        | _required_flag("O_CLOEXEC")
    )


def _file_flags(
    *,
    writable: bool = False,
    create: bool = False,
    exclusive: bool = False,
) -> int:
    flags = os.O_RDWR if writable else os.O_RDONLY
    flags |= (
        _required_flag("O_NOFOLLOW")
        | _required_flag("O_NONBLOCK")
        | _required_flag("O_CLOEXEC")
    )
    if create:
        flags |= os.O_CREAT
    if exclusive:
        flags |= os.O_EXCL
    return flags


def _require_safe_regular(
    value: os.stat_result,
    *,
    code: str,
    label: str,
    max_bytes: int | None = None,
) -> None:
    if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise ImmutableStoreError(code, f"{label} must be a non-symlink regular file")
    if value.st_nlink != 1:
        raise ImmutableStoreError(code, f"{label} must not have hard-link aliases")
    if _is_dataless(value):
        raise ImmutableStoreError(code, f"{label} must be resident")
    if value.st_size < 0 or (max_bytes is not None and value.st_size > max_bytes):
        raise ImmutableStoreError(code, f"{label} exceeds the fixed size limit")


def _read_chunk(descriptor: int, count: int) -> bytes:
    """Single indirection makes concurrent-mutation tests deterministic."""

    return os.read(descriptor, count)


def _read_bounded_regular_descriptor(
    descriptor: int,
    *,
    label: str,
    max_bytes: int,
    changed_code: str,
    shape_code: str,
) -> tuple[bytes, _FileSnapshot]:
    before_stat = os.fstat(descriptor)
    _require_safe_regular(
        before_stat,
        code=shape_code,
        label=label,
        max_bytes=max_bytes,
    )
    before = _snapshot(before_stat)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = _read_chunk(descriptor, min(_READ_CHUNK_BYTES, max_bytes + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ImmutableStoreError(shape_code, f"{label} exceeds the fixed size limit")
        chunks.append(chunk)
    after_stat = os.fstat(descriptor)
    after = _snapshot(after_stat)
    if before != after or total != before.size:
        raise ImmutableStoreError(changed_code, f"{label} changed while being read")
    _require_safe_regular(
        after_stat,
        code=shape_code,
        label=label,
        max_bytes=max_bytes,
    )
    return b"".join(chunks), after


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is forbidden: {value}")


def _decode_descriptor(raw: bytes) -> GenerationDescriptor:
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"descriptor contains duplicate JSON object key: {key}")
            result[key] = value
        return result

    try:
        text = raw.decode("utf-8", errors="strict")
        decoded = json.loads(
            text,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("descriptor must be valid UTF-8 JSON") from error
    if type(decoded) is not dict:
        raise ValueError("descriptor root must be a JSON object")
    required_keys = {
        "domain",
        "generation_id",
        "object_sha256s",
        "schema_version",
    }
    if set(decoded) != required_keys:
        raise ValueError("descriptor must contain exactly the canonical schema keys")
    if decoded["domain"] != _DESCRIPTOR_DOMAIN:
        raise ValueError("descriptor domain is invalid")
    values = decoded["object_sha256s"]
    if type(values) is not list:
        raise ValueError("object_sha256s must be a JSON array")
    descriptor = GenerationDescriptor(
        generation_id=decoded["generation_id"],
        object_sha256s=tuple(values),
        schema_version=decoded["schema_version"],
    )
    if raw != descriptor.canonical_bytes():
        raise ValueError("descriptor JSON is not in strict canonical form")
    return descriptor


def load_generation_descriptor(descriptor_path: Path) -> GenerationDescriptor:
    """Load one strict canonical descriptor from the exact safely opened file."""

    if not isinstance(descriptor_path, Path):
        raise ValueError("descriptor_path must be a pathlib.Path")
    try:
        before_path = descriptor_path.lstat()
    except OSError as error:
        raise ImmutableStoreError("DESCRIPTOR_MISSING", "descriptor is unavailable") from error
    _require_safe_regular(
        before_path,
        code="DESCRIPTOR_SHAPE",
        label="descriptor",
        max_bytes=MAX_GENERATION_DESCRIPTOR_BYTES,
    )
    try:
        descriptor_fd = os.open(descriptor_path, _file_flags())
    except OSError as error:
        raise ImmutableStoreError(
            "DESCRIPTOR_OPEN", "descriptor could not be opened safely"
        ) from error
    try:
        before_fd = os.fstat(descriptor_fd)
        if _snapshot(before_path) != _snapshot(before_fd):
            raise ImmutableStoreError(
                "DESCRIPTOR_CHANGED", "descriptor changed before binding"
            )
        raw, after_fd = _read_bounded_regular_descriptor(
            descriptor_fd,
            label="descriptor",
            max_bytes=MAX_GENERATION_DESCRIPTOR_BYTES,
            changed_code="DESCRIPTOR_CHANGED",
            shape_code="DESCRIPTOR_SHAPE",
        )
        try:
            after_path = descriptor_path.lstat()
        except OSError as error:
            raise ImmutableStoreError(
                "DESCRIPTOR_CHANGED", "descriptor path changed while being read"
            ) from error
        if _snapshot(after_path) != after_fd:
            raise ImmutableStoreError(
                "DESCRIPTOR_CHANGED", "descriptor path changed while being read"
            )
    finally:
        os.close(descriptor_fd)
    return _decode_descriptor(raw)


def _open_directory(name_or_path: str | Path, *, dir_fd: int | None = None) -> int:
    try:
        descriptor = os.open(name_or_path, _directory_flags(), dir_fd=dir_fd)
    except OSError as error:
        raise ImmutableStoreError("STORE_SHAPE", "store directory is unavailable or unsafe") from error
    value = os.fstat(descriptor)
    if not stat.S_ISDIR(value.st_mode) or _is_dataless(value):
        os.close(descriptor)
        raise ImmutableStoreError("STORE_SHAPE", "store path must be a resident directory")
    return descriptor


def _open_lock(root_fd: int, generation_id: str, operation: int, *, blocking: bool) -> int:
    locks_fd = _open_directory("locks", dir_fd=root_fd)
    try:
        lock_name = f"{generation_id}.lock"
        try:
            lock_fd = os.open(
                lock_name,
                _file_flags(writable=operation == fcntl.LOCK_EX),
                dir_fd=locks_fd,
            )
        except FileNotFoundError as error:
            raise ImmutableStoreError(
                "LOCK_MISSING",
                "trusted publisher has not bootstrapped the generation lock",
            ) from error
        except OSError as error:
            raise ImmutableStoreError("LOCK_SHAPE", "generation lock is unsafe") from error
        try:
            before = os.fstat(lock_fd)
            _require_safe_regular(before, code="LOCK_SHAPE", label="generation lock", max_bytes=0)
            requested = operation | (0 if blocking else fcntl.LOCK_NB)
            try:
                fcntl.flock(lock_fd, requested)
            except BlockingIOError as error:
                raise ImmutableStoreError("GENERATION_BUSY", "generation lock is held") from error
            try:
                after_path = os.stat(lock_name, dir_fd=locks_fd, follow_symlinks=False)
            except OSError as error:
                raise ImmutableStoreError("LOCK_CHANGED", "generation lock path changed") from error
            if _snapshot(before) != _snapshot(os.fstat(lock_fd)) or _snapshot(before) != _snapshot(after_path):
                raise ImmutableStoreError("LOCK_CHANGED", "generation lock changed while acquiring it")
        except BaseException:
            os.close(lock_fd)
            raise
        return lock_fd
    finally:
        os.close(locks_fd)


def bootstrap_generation_lock(store_root: Path, generation_id: str) -> None:
    """Create one publisher-owned lock file exactly once with ``O_EXCL``.

    This operation belongs to the trusted publisher/bootstrap boundary.
    Readers and the ordinary exclusive-lock helper never create lock files.
    """

    if not isinstance(store_root, Path):
        raise ValueError("store_root must be a pathlib.Path")
    _require_sha256(generation_id, "generation_id")
    root_fd = _open_directory(store_root)
    locks_fd = -1
    lock_fd = -1
    try:
        locks_fd = _open_directory("locks", dir_fd=root_fd)
        lock_name = f"{generation_id}.lock"
        try:
            lock_fd = os.open(
                lock_name,
                _file_flags(writable=True, create=True, exclusive=True),
                0o644,
                dir_fd=locks_fd,
            )
        except FileExistsError as error:
            raise ImmutableStoreError(
                "LOCK_EXISTS", "generation lock has already been bootstrapped"
            ) from error
        except OSError as error:
            raise ImmutableStoreError(
                "LOCK_SHAPE", "generation lock could not be bootstrapped safely"
            ) from error
        value = os.fstat(lock_fd)
        _require_safe_regular(
            value,
            code="LOCK_SHAPE",
            label="generation lock",
            max_bytes=0,
        )
        path_value = os.stat(lock_name, dir_fd=locks_fd, follow_symlinks=False)
        if _snapshot(value) != _snapshot(path_value):
            raise ImmutableStoreError(
                "LOCK_CHANGED", "generation lock changed while bootstrapping"
            )
    finally:
        if lock_fd >= 0:
            os.close(lock_fd)
        if locks_fd >= 0:
            os.close(locks_fd)
        os.close(root_fd)


def _load_descriptor_at(generation_fd: int) -> GenerationDescriptor:
    try:
        descriptor_fd = os.open(DESCRIPTOR_FILENAME, _file_flags(), dir_fd=generation_fd)
    except OSError as error:
        raise ImmutableStoreError("DESCRIPTOR_OPEN", "generation descriptor is unsafe") from error
    try:
        raw, after_fd = _read_bounded_regular_descriptor(
            descriptor_fd,
            label="generation descriptor",
            max_bytes=MAX_GENERATION_DESCRIPTOR_BYTES,
            changed_code="DESCRIPTOR_CHANGED",
            shape_code="DESCRIPTOR_SHAPE",
        )
        try:
            after_path = os.stat(
                DESCRIPTOR_FILENAME,
                dir_fd=generation_fd,
                follow_symlinks=False,
            )
        except OSError as error:
            raise ImmutableStoreError(
                "DESCRIPTOR_CHANGED", "generation descriptor path changed"
            ) from error
        if _snapshot(after_path) != after_fd:
            raise ImmutableStoreError(
                "DESCRIPTOR_CHANGED", "generation descriptor path changed"
            )
    finally:
        os.close(descriptor_fd)
    return _decode_descriptor(raw)


class GenerationReadLease:
    """A shared generation lease with staged, digest-verified object reads."""

    __slots__ = (
        "_store_root",
        "_generation_id",
        "_blocking",
        "_root_fd",
        "_generation_fd",
        "_objects_fd",
        "_lock_fd",
        "_descriptor",
        "_declared_object_sha256s",
        "_active",
        "_used",
    )

    def __init__(self, store_root: Path, generation_id: str, *, blocking: bool = True) -> None:
        if not isinstance(store_root, Path):
            raise ValueError("store_root must be a pathlib.Path")
        _require_sha256(generation_id, "generation_id")
        if type(blocking) is not bool:
            raise ValueError("blocking must be a bool")
        self._store_root = store_root
        self._generation_id = generation_id
        self._blocking = blocking
        self._root_fd = -1
        self._generation_fd = -1
        self._objects_fd = -1
        self._lock_fd = -1
        self._descriptor: GenerationDescriptor | None = None
        self._declared_object_sha256s: frozenset[str] = frozenset()
        self._active = False
        self._used = False

    def __enter__(self) -> GenerationReadLease:
        if self._used:
            raise RuntimeError("generation lease objects are single-use")
        self._used = True
        try:
            self._root_fd = _open_directory(self._store_root)
            self._lock_fd = _open_lock(
                self._root_fd,
                self._generation_id,
                fcntl.LOCK_SH,
                blocking=self._blocking,
            )
            generations_fd = _open_directory("generations", dir_fd=self._root_fd)
            try:
                self._generation_fd = _open_directory(
                    self._generation_id,
                    dir_fd=generations_fd,
                )
            finally:
                os.close(generations_fd)
            descriptor = _load_descriptor_at(self._generation_fd)
            if descriptor.generation_id != self._generation_id:
                raise ImmutableStoreError(
                    "GENERATION_MISMATCH",
                    "descriptor generation_id does not match its generation path",
                )
            self._objects_fd = _open_directory("objects", dir_fd=self._generation_fd)
            self._descriptor = descriptor
            self._declared_object_sha256s = frozenset(descriptor.object_sha256s)
            self._active = True
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    @property
    def descriptor(self) -> GenerationDescriptor:
        if not self._active or self._descriptor is None:
            raise RuntimeError("generation lease is not active")
        return self._descriptor

    @contextmanager
    def open_verified_object(
        self,
        object_sha256: str,
        *,
        max_bytes: int = MAX_OBJECT_BYTES,
    ) -> Iterator[BinaryIO]:
        """Stage and expose one complete verified object without buffering it in RAM."""

        _require_sha256(object_sha256, "object_sha256")
        if type(max_bytes) is not int or max_bytes < 1 or max_bytes > MAX_OBJECT_BYTES:
            raise ValueError(
                f"max_bytes must be an integer from 1 through {MAX_OBJECT_BYTES}"
            )
        self.descriptor  # Validate that the parent shared lease is still active.
        if object_sha256 not in self._declared_object_sha256s:
            raise ImmutableStoreError(
                "OBJECT_UNDECLARED", "object digest is not declared by this generation"
            )
        try:
            source_fd = os.open(object_sha256, _file_flags(), dir_fd=self._objects_fd)
        except OSError as error:
            raise ImmutableStoreError("OBJECT_OPEN", "object is missing or unsafe") from error
        staged: BinaryIO | None = None
        try:
            before_stat = os.fstat(source_fd)
            if before_stat.st_size > max_bytes:
                raise ImmutableStoreError(
                    "OBJECT_SIZE",
                    "generation object exceeds the caller's fixed size limit",
                )
            _require_safe_regular(
                before_stat,
                code="OBJECT_SHAPE",
                label="generation object",
                max_bytes=MAX_OBJECT_BYTES,
            )
            before = _snapshot(before_stat)
            staged = tempfile.TemporaryFile(mode="w+b", prefix="vision-scoring-object-")
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = _read_chunk(source_fd, _READ_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ImmutableStoreError("OBJECT_SIZE", "object exceeds the fixed size limit")
                digest.update(chunk)
                if staged.write(chunk) != len(chunk):
                    raise ImmutableStoreError(
                        "STAGING_WRITE", "verified object staging was incomplete"
                    )
            after_stat = os.fstat(source_fd)
            after = _snapshot(after_stat)
            try:
                path_after = os.stat(
                    object_sha256,
                    dir_fd=self._objects_fd,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise ImmutableStoreError(
                    "OBJECT_REPLACED", "object path changed while being staged"
                ) from error
            if _snapshot(path_after) != after:
                raise ImmutableStoreError(
                    "OBJECT_REPLACED", "object path changed while being staged"
                )
            if before != after or total != before.size:
                raise ImmutableStoreError("OBJECT_CHANGED", "object changed while being staged")
            _require_safe_regular(
                after_stat,
                code="OBJECT_SHAPE",
                label="generation object",
                max_bytes=MAX_OBJECT_BYTES,
            )
            _require_safe_regular(
                path_after,
                code="OBJECT_SHAPE",
                label="generation object path",
                max_bytes=MAX_OBJECT_BYTES,
            )
            if after_stat.st_size > max_bytes or path_after.st_size > max_bytes:
                raise ImmutableStoreError(
                    "OBJECT_SIZE",
                    "generation object exceeds the caller's fixed size limit",
                )
            if digest.hexdigest() != object_sha256:
                raise ImmutableStoreError(
                    "OBJECT_HASH", "object content does not match its declared digest"
                )
            staged.flush()
            staged.seek(0)
            yield staged
        finally:
            os.close(source_fd)
            if staged is not None:
                staged.close()

    def close(self) -> None:
        self._active = False
        self._descriptor = None
        self._declared_object_sha256s = frozenset()
        for attribute in ("_objects_fd", "_generation_fd"):
            descriptor = getattr(self, attribute)
            if descriptor >= 0:
                os.close(descriptor)
                setattr(self, attribute, -1)
        if self._lock_fd >= 0:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = -1
        if self._root_fd >= 0:
            os.close(self._root_fd)
            self._root_fd = -1


def generation_read_lease(
    store_root: Path,
    generation_id: str,
    *,
    blocking: bool = True,
) -> GenerationReadLease:
    """Return a single-use shared lease context for a published generation."""

    return GenerationReadLease(store_root, generation_id, blocking=blocking)


@contextmanager
def generation_write_lock(
    store_root: Path,
    generation_id: str,
    *,
    blocking: bool = True,
) -> Iterator[None]:
    """Hold the trusted publisher's exclusive cooperative generation lock."""

    if not isinstance(store_root, Path):
        raise ValueError("store_root must be a pathlib.Path")
    _require_sha256(generation_id, "generation_id")
    if type(blocking) is not bool:
        raise ValueError("blocking must be a bool")
    root_fd = _open_directory(store_root)
    lock_fd = -1
    try:
        lock_fd = _open_lock(
            root_fd,
            generation_id,
            fcntl.LOCK_EX,
            blocking=blocking,
        )
        yield None
    finally:
        if lock_fd >= 0:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)
        os.close(root_fd)
