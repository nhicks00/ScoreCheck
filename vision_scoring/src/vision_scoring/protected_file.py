"""Strict bounded reads of protected local files.

The reader pins and verifies the final path component while the bytes are being
consumed.  It intentionally assumes that every ancestor directory is trusted
and cannot be replaced by an attacker.  Callers with untrusted ancestor paths
need a capability-style interface that securely walks and pins each directory
(for example, a trusted ``dir_fd`` boundary); this helper does not claim to
provide that stronger guarantee.
"""

from __future__ import annotations

import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


PROTECTED_FILE_INPUT = "PROTECTED_FILE_INPUT"
PROTECTED_FILE_PLATFORM_UNSAFE = "PROTECTED_FILE_PLATFORM_UNSAFE"
PROTECTED_FILE_UNAVAILABLE = "PROTECTED_FILE_UNAVAILABLE"
PROTECTED_FILE_SHAPE = "PROTECTED_FILE_SHAPE"
PROTECTED_FILE_SIZE = "PROTECTED_FILE_SIZE"
PROTECTED_FILE_OPEN = "PROTECTED_FILE_OPEN"
PROTECTED_FILE_CHANGED = "PROTECTED_FILE_CHANGED"
PROTECTED_FILE_READ = "PROTECTED_FILE_READ"
PROTECTED_FILE_CLOSE = "PROTECTED_FILE_CLOSE"

PROTECTED_FILE_ERROR_CODES = frozenset(
    {
        PROTECTED_FILE_INPUT,
        PROTECTED_FILE_PLATFORM_UNSAFE,
        PROTECTED_FILE_UNAVAILABLE,
        PROTECTED_FILE_SHAPE,
        PROTECTED_FILE_SIZE,
        PROTECTED_FILE_OPEN,
        PROTECTED_FILE_CHANGED,
        PROTECTED_FILE_READ,
        PROTECTED_FILE_CLOSE,
    }
)

_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _./:+-]{0,63}$")
_READ_CHUNK_BYTES = 1024 * 1024
_MAX_CONSECUTIVE_INTERRUPTS = 32
_DARWIN_SF_DATALESS = 0x40000000


class ProtectedFileError(ValueError):
    """A fail-closed protected-file error with a stable finite code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class _FileSnapshot:
    device: int
    inode: int
    mode: int
    link_count: int
    size: int
    modified_ns: int
    changed_ns: int
    flags: int | None


def _snapshot(value: os.stat_result) -> _FileSnapshot:
    return _FileSnapshot(
        device=value.st_dev,
        inode=value.st_ino,
        mode=value.st_mode,
        link_count=value.st_nlink,
        size=value.st_size,
        modified_ns=value.st_mtime_ns,
        changed_ns=value.st_ctime_ns,
        flags=getattr(value, "st_flags", None),
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
        raise ProtectedFileError(
            PROTECTED_FILE_PLATFORM_UNSAFE,
            f"platform lacks required {name} file protection",
        )
    return value


def _read_flags() -> int:
    return (
        os.O_RDONLY
        | _required_flag("O_NOFOLLOW")
        | _required_flag("O_NONBLOCK")
        | _required_flag("O_CLOEXEC")
    )


def _validate_inputs(path: Path, max_bytes: int, label: str) -> None:
    if type(path) is not type(Path()):
        raise ProtectedFileError(
            PROTECTED_FILE_INPUT,
            "path must be an exact pathlib.Path",
        )
    if type(max_bytes) is not int or max_bytes <= 0:
        raise ProtectedFileError(
            PROTECTED_FILE_INPUT,
            "max_bytes must be an exact positive int",
        )
    if type(label) is not str or _LABEL_RE.fullmatch(label) is None:
        raise ProtectedFileError(
            PROTECTED_FILE_INPUT,
            "label must be a nonempty short ASCII label",
        )


def _require_initial_file(
    value: os.stat_result,
    *,
    max_bytes: int,
    label: str,
) -> None:
    if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise ProtectedFileError(
            PROTECTED_FILE_SHAPE,
            f"{label} must be a non-symlink regular file",
        )
    if value.st_nlink != 1:
        raise ProtectedFileError(
            PROTECTED_FILE_SHAPE,
            f"{label} must have exactly one filesystem link",
        )
    if _is_dataless(value):
        raise ProtectedFileError(
            PROTECTED_FILE_SHAPE,
            f"{label} must be resident",
        )
    if value.st_size < 1 or value.st_size > max_bytes:
        raise ProtectedFileError(
            PROTECTED_FILE_SIZE,
            f"{label} must be nonempty and within the byte limit",
        )


def _require_unchanged_file(
    value: os.stat_result,
    *,
    max_bytes: int,
    label: str,
) -> None:
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or value.st_nlink != 1
        or _is_dataless(value)
        or value.st_size < 1
        or value.st_size > max_bytes
    ):
        raise ProtectedFileError(
            PROTECTED_FILE_CHANGED,
            f"{label} changed to an unsafe file state",
        )


def _read_chunk(descriptor: int, count: int) -> bytes:
    """Single read indirection for deterministic concurrent-mutation tests."""

    return os.read(descriptor, count)


def _read_once(descriptor: int, count: int, *, label: str) -> bytes:
    interruptions = 0
    while True:
        try:
            chunk = _read_chunk(descriptor, count)
        except InterruptedError as exc:
            interruptions += 1
            if interruptions > _MAX_CONSECUTIVE_INTERRUPTS:
                raise ProtectedFileError(
                    PROTECTED_FILE_READ,
                    f"{label} read was interrupted too many times",
                ) from exc
            continue
        except OSError as exc:
            raise ProtectedFileError(
                PROTECTED_FILE_READ,
                f"{label} could not be read",
            ) from exc
        if type(chunk) is not bytes or len(chunk) > count:
            raise ProtectedFileError(
                PROTECTED_FILE_READ,
                f"{label} returned an invalid read result",
            )
        return chunk


def _read_exact_size(descriptor: int, size: int, *, label: str) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = _read_once(
            descriptor,
            min(_READ_CHUNK_BYTES, remaining),
            label=label,
        )
        if not chunk:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} was truncated while being read",
            )
        chunks.append(chunk)
        remaining -= len(chunk)

    if _read_once(descriptor, 1, label=label):
        raise ProtectedFileError(
            PROTECTED_FILE_CHANGED,
            f"{label} grew while being read",
        )
    return b"".join(chunks)


def read_protected_file_bytes(
    path: Path,
    *,
    max_bytes: int,
    label: str,
) -> bytes:
    """Return the exact bytes of one bounded, resident, regular local file.

    ``path`` must be an exact platform ``pathlib.Path`` (not a string or custom
    subclass), ``max_bytes`` must be an exact positive integer, and ``label``
    must be a stable short ASCII label.  The final path component is checked
    with ``lstat``, opened read-only with no-follow/nonblocking/close-on-exec
    protections, and compared with the descriptor before and after the exact
    read and growth probe.  A final ``lstat`` rejects path replacement.

    Ancestor directories are assumed trusted and non-replaceable.  This helper
    does not securely walk or pin an untrusted directory chain.
    """

    _validate_inputs(path, max_bytes, label)
    flags = _read_flags()

    try:
        initial_stat = os.lstat(path)
    except (OSError, ValueError) as exc:
        raise ProtectedFileError(
            PROTECTED_FILE_UNAVAILABLE,
            f"{label} is unavailable",
        ) from exc
    _require_initial_file(initial_stat, max_bytes=max_bytes, label=label)
    initial = _snapshot(initial_stat)

    try:
        descriptor = os.open(path, flags)
    except (OSError, ValueError) as exc:
        raise ProtectedFileError(
            PROTECTED_FILE_OPEN,
            f"{label} could not be opened safely",
        ) from exc

    primary_error: BaseException | None = None
    try:
        try:
            opened_stat = os.fstat(descriptor)
        except OSError as exc:
            raise ProtectedFileError(
                PROTECTED_FILE_OPEN,
                f"{label} descriptor could not be inspected",
            ) from exc
        _require_unchanged_file(opened_stat, max_bytes=max_bytes, label=label)
        opened = _snapshot(opened_stat)
        if opened != initial:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} changed before it was opened",
            )

        raw = _read_exact_size(descriptor, opened.size, label=label)

        try:
            final_descriptor_stat = os.fstat(descriptor)
        except OSError as exc:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} descriptor changed while being read",
            ) from exc
        _require_unchanged_file(
            final_descriptor_stat,
            max_bytes=max_bytes,
            label=label,
        )
        final_descriptor = _snapshot(final_descriptor_stat)
        if final_descriptor != opened:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} changed while being read",
            )

        try:
            final_path_stat = os.lstat(path)
        except (OSError, ValueError) as exc:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} path changed while being read",
            ) from exc
        _require_unchanged_file(
            final_path_stat,
            max_bytes=max_bytes,
            label=label,
        )
        final_path = _snapshot(final_path_stat)
        if final_path != final_descriptor or final_path != initial:
            raise ProtectedFileError(
                PROTECTED_FILE_CHANGED,
                f"{label} path changed while being read",
            )
        return raw
    except BaseException as exc:
        primary_error = exc
        raise
    finally:
        try:
            os.close(descriptor)
        except OSError as exc:
            if primary_error is None:
                raise ProtectedFileError(
                    PROTECTED_FILE_CLOSE,
                    f"{label} descriptor could not be closed safely",
                ) from exc
