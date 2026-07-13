"""Pinned, leased decoder-runtime bytes for deterministic decode coordinators.

This module does not discover or approve a decoder installed on the host.  A
trusted publisher must place one canonical manifest and its exact non-system
runtime closure in an immutable generation.  The protected loader checks an
independently supplied root pin, holds the generation lease, and stages only
the verified bytes in a private directory.

Arbitrary bytes can satisfy this structural contract.  Nothing here executes
them, recognizes a binary format, checks linkage, measures the current host,
reproduces version output, or validates the referenced recipe/license-review
evidence.  Accessors revalidate immediately before returning a private path,
but a path remains subject to TOCTOU after return; an eventual protected
executor must revalidate and immediately spawn.  This capability grants no
training, evaluation, deployment, or scoring authority.

A protected executor must keep this lease open until the complete decoder
child process group has been reaped.  It must not return or retain a staged
path or open extra descriptors that can outlive the lease.

Dependency ordinals are structural storage names, not a dynamic-loader install
layout.  Execution V1 must therefore require ``dependency_closure == ()`` and
a static/no-nonsystem-dependency runtime until a separate exact install-layout
contract exists.  In particular, a current Homebrew dynamic build is not
executable from this staged closure.
"""

from __future__ import annotations

import errno
import hashlib
import os
import re
import stat
import sys
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .contract_wire import (
    CanonicalWireError,
    canonical_json_bytes,
    exact_list,
    parse_canonical_json_object,
    require_exact_fields,
    require_sha256,
    require_stable_id,
)
from .immutable_store import ImmutableStoreError, generation_read_lease


DECODER_RUNTIME_SCHEMA_VERSION = "1.0"
DECODER_RUNTIME_DOMAIN = (
    "multicourt-vision-scoring:decoder-runtime-manifest:v1"
)
MAX_DECODER_RUNTIME_MANIFEST_BYTES = 64 * 1024
MAX_DECODER_RUNTIME_DEPENDENCIES = 256
MAX_DECODER_RUNTIME_FLAGS = 256
MAX_DECODER_RUNTIME_SYSTEM_INSTALL_NAMES = 128
MAX_DECODER_RUNTIME_OBJECT_BYTES = 512 * 1024 * 1024
MAX_DECODER_RUNTIME_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_DECODER_VERSION_OUTPUT_BYTES = 64 * 1024

_CONTENT_ADDRESS_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_INSTALL_NAME_RE = re.compile(r"^[A-Za-z0-9@_+./:-]{1,255}$")
_STAGED_READ_CHUNK_BYTES = 1024 * 1024


class DecoderRuntimeError(ValueError):
    """Fail-closed decoder-runtime failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise DecoderRuntimeError(code, message)


def _require_content_address(value: object, field_name: str) -> str:
    if type(value) is not str or _CONTENT_ADDRESS_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an exact sha256 content address")
    return value


def _require_install_name(value: object, field_name: str) -> str:
    if type(value) is not str or _INSTALL_NAME_RE.fullmatch(value) is None:
        raise ValueError(
            f"{field_name} must be a bounded ASCII runtime install name"
        )
    if "//" in value or any(part in {".", ".."} for part in value.split("/")):
        raise ValueError(f"{field_name} must be lexically normalized")
    return value


def _require_flag(value: object, field_name: str) -> str:
    if type(value) is not str or not 1 <= len(value) <= 512:
        raise ValueError(f"{field_name} must be a bounded string")
    try:
        raw = value.encode("ascii", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{field_name} must contain only ASCII") from exc
    if value != value.strip() or any(byte < 0x20 or byte > 0x7E for byte in raw):
        raise ValueError(f"{field_name} must be normalized printable ASCII")
    return value


def _require_sorted_strings(
    value: object,
    field_name: str,
    *,
    maximum: int,
    validator: Any,
) -> tuple[str, ...]:
    if type(value) is not tuple or len(value) > maximum:
        raise ValueError(
            f"{field_name} must be an immutable tuple of at most {maximum} values"
        )
    for item in value:
        validator(item, f"{field_name} entry")
    if value != tuple(sorted(value)) or len(set(value)) != len(value):
        raise ValueError(f"{field_name} must be unique and canonically sorted")
    return value


def _require_ordered_flags(value: object, field_name: str) -> tuple[str, ...]:
    if type(value) is not tuple or len(value) > MAX_DECODER_RUNTIME_FLAGS:
        raise ValueError(
            f"{field_name} must be an immutable tuple of at most "
            f"{MAX_DECODER_RUNTIME_FLAGS} values"
        )
    for item in value:
        _require_flag(item, f"{field_name} entry")
    # Invocation order and even intentional duplicate flags can affect a build.
    # Canonical JSON commits the exact tuple without normalizing either away.
    return value


def normalized_decoder_version_output_sha256(raw: bytes) -> str:
    """Hash one bounded, deterministic normalization of tool version output.

    CRLF and CR become LF, trailing horizontal whitespace is removed per line,
    leading/trailing blank lines are removed, and the non-empty result receives
    exactly one final LF.  The publisher records this measurement; loading does
    not execute the staged binary.
    """

    if type(raw) is not bytes or not 1 <= len(raw) <= MAX_DECODER_VERSION_OUTPUT_BYTES:
        raise ValueError(
            "version output must be bounded, non-empty exact bytes"
        )
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError("version output must be valid UTF-8") from exc
    if "\x00" in text:
        raise ValueError("version output must not contain NUL")
    lines = [line.rstrip(" \t") for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise ValueError("normalized version output must not be empty")
    normalized = ("\n".join(lines) + "\n").encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()


@dataclass(frozen=True, slots=True)
class DecoderRuntimeDependencyV1:
    """One canonically ordered non-system dependency object."""

    install_name: str
    object_sha256: str

    def __post_init__(self) -> None:
        _require_install_name(self.install_name, "install_name")
        require_sha256(self.object_sha256, "object_sha256")

    def to_dict(self) -> dict[str, str]:
        return {
            "install_name": self.install_name,
            "object_sha256": self.object_sha256,
        }


@dataclass(frozen=True, slots=True)
class PinnedSystemRuntimeMeasurementV1:
    """Publisher-declared expected pin for an ambient system-runtime surface."""

    runtime_id: str
    measurement_sha256: str
    allowed_install_names: tuple[str, ...]

    def __post_init__(self) -> None:
        require_stable_id(self.runtime_id, "system runtime_id")
        require_sha256(self.measurement_sha256, "system measurement_sha256")
        _require_sorted_strings(
            self.allowed_install_names,
            "allowed_install_names",
            maximum=MAX_DECODER_RUNTIME_SYSTEM_INSTALL_NAMES,
            validator=_require_install_name,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed_install_names": list(self.allowed_install_names),
            "measurement_sha256": self.measurement_sha256,
            "runtime_id": self.runtime_id,
        }


@dataclass(frozen=True, slots=True)
class DecoderRuntimeManifestV1:
    """Canonical root for one exact decoder runtime and recipe."""

    runtime_id: str
    platform: str
    architecture: str
    abi: str
    ffmpeg_object_sha256: str
    ffprobe_object_sha256: str
    ffmpeg_version_output_sha256: str
    ffprobe_version_output_sha256: str
    configure_flags: tuple[str, ...]
    build_flags: tuple[str, ...]
    decoder_recipe_sha256: str
    dependency_closure: tuple[DecoderRuntimeDependencyV1, ...]
    system_runtime_measurement: PinnedSystemRuntimeMeasurementV1
    license_review_ref: str
    schema_version: str = DECODER_RUNTIME_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not str
            or self.schema_version != DECODER_RUNTIME_SCHEMA_VERSION
        ):
            raise ValueError(
                f"schema_version must be exactly {DECODER_RUNTIME_SCHEMA_VERSION!r}"
            )
        require_stable_id(self.runtime_id, "runtime_id")
        require_stable_id(self.platform, "platform")
        require_stable_id(self.architecture, "architecture")
        require_stable_id(self.abi, "abi")
        for field_name in (
            "ffmpeg_object_sha256",
            "ffprobe_object_sha256",
            "ffmpeg_version_output_sha256",
            "ffprobe_version_output_sha256",
            "decoder_recipe_sha256",
        ):
            require_sha256(getattr(self, field_name), field_name)
        _require_ordered_flags(self.configure_flags, "configure_flags")
        _require_ordered_flags(self.build_flags, "build_flags")
        if (
            type(self.dependency_closure) is not tuple
            or len(self.dependency_closure) > MAX_DECODER_RUNTIME_DEPENDENCIES
        ):
            raise ValueError(
                "dependency_closure must be a bounded immutable tuple"
            )
        for dependency in self.dependency_closure:
            if type(dependency) is not DecoderRuntimeDependencyV1:
                raise ValueError(
                    "dependency_closure must contain exact DecoderRuntimeDependencyV1 values"
                )
        install_names = tuple(item.install_name for item in self.dependency_closure)
        if install_names != tuple(sorted(install_names)) or len(
            set(install_names)
        ) != len(install_names):
            raise ValueError(
                "dependency_closure must be uniquely ordered by install_name"
            )
        if type(self.system_runtime_measurement) is not PinnedSystemRuntimeMeasurementV1:
            raise ValueError(
                "system_runtime_measurement must be an exact PinnedSystemRuntimeMeasurementV1"
            )
        if set(install_names).intersection(
            self.system_runtime_measurement.allowed_install_names
        ):
            raise ValueError(
                "stored and system-runtime dependency names must not overlap"
            )
        _require_content_address(self.license_review_ref, "license_review_ref")

        object_digests = self.object_sha256s()
        if len(set(object_digests)) != len(object_digests):
            raise ValueError("runtime object roles must have globally distinct digests")
        external_digests = (
            self.ffmpeg_version_output_sha256,
            self.ffprobe_version_output_sha256,
            self.decoder_recipe_sha256,
            self.system_runtime_measurement.measurement_sha256,
            self.license_review_ref.removeprefix("sha256:"),
        )
        if len(set(external_digests)) != len(external_digests):
            raise ValueError(
                "version, recipe, system, and license evidence roles must be distinct"
            )
        if set(external_digests).intersection(object_digests):
            raise ValueError(
                "runtime objects must not alias measurements, recipes, or license review"
            )
        canonical_json_bytes(
            self.to_dict(),
            label="decoder runtime manifest",
            maximum_bytes=MAX_DECODER_RUNTIME_MANIFEST_BYTES,
        )

    def object_sha256s(self) -> tuple[str, ...]:
        """Return executable and non-system dependency digests, excluding root."""

        return (
            self.ffmpeg_object_sha256,
            self.ffprobe_object_sha256,
            *(item.object_sha256 for item in self.dependency_closure),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "abi": self.abi,
            "architecture": self.architecture,
            "build_flags": list(self.build_flags),
            "configure_flags": list(self.configure_flags),
            "decoder_recipe_sha256": self.decoder_recipe_sha256,
            "dependency_closure": [
                dependency.to_dict() for dependency in self.dependency_closure
            ],
            "domain": DECODER_RUNTIME_DOMAIN,
            "ffmpeg_object_sha256": self.ffmpeg_object_sha256,
            "ffmpeg_version_output_sha256": self.ffmpeg_version_output_sha256,
            "ffprobe_object_sha256": self.ffprobe_object_sha256,
            "ffprobe_version_output_sha256": self.ffprobe_version_output_sha256,
            "license_review_ref": self.license_review_ref,
            "platform": self.platform,
            "runtime_id": self.runtime_id,
            "schema_version": self.schema_version,
            "system_runtime_measurement": self.system_runtime_measurement.to_dict(),
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="decoder runtime manifest",
            maximum_bytes=MAX_DECODER_RUNTIME_MANIFEST_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "DecoderRuntimeManifestV1":
        try:
            payload = parse_canonical_json_object(
                raw,
                label="decoder runtime manifest",
                maximum_bytes=MAX_DECODER_RUNTIME_MANIFEST_BYTES,
                maximum_depth=5,
                maximum_nodes=2_500,
                maximum_containers=600,
            )
            payload = require_exact_fields(
                payload,
                {
                    "abi",
                    "architecture",
                    "build_flags",
                    "configure_flags",
                    "decoder_recipe_sha256",
                    "dependency_closure",
                    "domain",
                    "ffmpeg_object_sha256",
                    "ffmpeg_version_output_sha256",
                    "ffprobe_object_sha256",
                    "ffprobe_version_output_sha256",
                    "license_review_ref",
                    "platform",
                    "runtime_id",
                    "schema_version",
                    "system_runtime_measurement",
                },
                label="decoder runtime manifest",
            )
            if payload.pop("domain") != DECODER_RUNTIME_DOMAIN:
                raise ValueError("decoder runtime manifest domain is invalid")

            dependency_payloads = exact_list(
                payload,
                "dependency_closure",
                label="decoder runtime manifest",
            )
            dependencies: list[DecoderRuntimeDependencyV1] = []
            for value in dependency_payloads:
                fields = require_exact_fields(
                    value,
                    {"install_name", "object_sha256"},
                    label="decoder runtime dependency",
                )
                dependencies.append(DecoderRuntimeDependencyV1(**fields))

            system_fields = require_exact_fields(
                payload["system_runtime_measurement"],
                {"allowed_install_names", "measurement_sha256", "runtime_id"},
                label="system runtime measurement",
            )
            allowed_names = system_fields["allowed_install_names"]
            if type(allowed_names) is not list:
                raise ValueError("allowed_install_names must be a JSON array")
            system_runtime = PinnedSystemRuntimeMeasurementV1(
                runtime_id=system_fields["runtime_id"],
                measurement_sha256=system_fields["measurement_sha256"],
                allowed_install_names=tuple(allowed_names),
            )
            payload["dependency_closure"] = tuple(dependencies)
            payload["system_runtime_measurement"] = system_runtime
            for field_name in ("configure_flags", "build_flags"):
                value = payload[field_name]
                if type(value) is not list:
                    raise ValueError(f"{field_name} must be a JSON array")
                payload[field_name] = tuple(value)
            manifest = cls(**payload)
        except DecoderRuntimeError:
            raise
        except (CanonicalWireError, KeyError, TypeError, ValueError) as exc:
            raise DecoderRuntimeError(
                "WIRE", "decoder runtime manifest bytes are invalid"
            ) from exc
        if raw != manifest.to_json_bytes():
            _fail("WIRE", "decoder runtime manifest did not reconstruct exactly")
        return manifest


def _required_os_flag(name: str) -> int:
    value = getattr(os, name, None)
    if type(value) is not int or value == 0:
        _fail("PLATFORM", f"required {name} protection is unavailable")
    return value


def _close_private_descriptor(descriptor: int) -> bool:
    try:
        os.close(descriptor)
        return True
    except OSError as exc:
        # A non-EBADF close failure is ownership-ambiguous: the kernel may
        # already have released this number and another thread may have reused
        # it, even for the same inode.  Never retry an ambiguous close.
        return exc.errno == errno.EBADF


def _fstat_private_descriptor(descriptor: int) -> os.stat_result | None:
    for _ in range(2):
        try:
            return os.fstat(descriptor)
        except OSError:
            pass
    return None


_DARWIN_SF_DATALESS = 0x40000000


@dataclass(frozen=True, slots=True)
class _RuntimeSnapshot:
    device: int
    inode: int
    mode: int
    link_count: int
    size: int
    modified_ns: int
    changed_ns: int


def _runtime_snapshot(value: os.stat_result) -> _RuntimeSnapshot:
    return _RuntimeSnapshot(
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


def _same_identity(value: os.stat_result, snapshot: _RuntimeSnapshot) -> bool:
    return value.st_dev == snapshot.device and value.st_ino == snapshot.inode


def _close_bound_directory_descriptor(
    descriptor: int,
    owner: _RuntimeSnapshot,
) -> bool:
    """Close only a descriptor still naming the originally bound directory."""

    try:
        current = os.fstat(descriptor)
    except OSError as exc:
        return exc.errno == errno.EBADF
    if not _same_identity(current, owner):
        return False
    return _close_private_descriptor(descriptor)


def _safe_rmdir_bound(path: Path, snapshot: _RuntimeSnapshot) -> bool:
    """Remove only the original empty directory, never a replacement path."""

    try:
        value = path.lstat()
        if not stat.S_ISDIR(value.st_mode) or not _same_identity(value, snapshot):
            return False
        os.rmdir(path)
        return True
    except OSError:
        return False


@dataclass(frozen=True, slots=True)
class _RuntimeObjectBinding:
    name: str
    object_sha256: str
    expected_mode: int
    snapshot: _RuntimeSnapshot


@dataclass(frozen=True, slots=True)
class _RuntimeDirectoryBinding:
    path: Path
    snapshot: _RuntimeSnapshot


def _private_directory(
    prefix: str,
) -> tuple[Path, int, _RuntimeDirectoryBinding]:
    path: Path | None = None
    directory_fd = -1
    path_snapshot: _RuntimeSnapshot | None = None
    cleanup_snapshot: _RuntimeSnapshot | None = None
    transferred = False
    try:
        path = Path(tempfile.mkdtemp(prefix=prefix))
        cleanup_snapshot = _runtime_snapshot(path.lstat())
        os.chmod(path, 0o700)
        path_value = path.lstat()
        if (
            not stat.S_ISDIR(path_value.st_mode)
            or stat.S_IMODE(path_value.st_mode) != 0o700
            or _is_dataless(path_value)
        ):
            _fail("EXECUTABLE", "private runtime staging directory is unsafe")
        path_snapshot = _runtime_snapshot(path_value)
        directory_fd = os.open(
            path,
            os.O_RDONLY
            | _required_os_flag("O_DIRECTORY")
            | _required_os_flag("O_NOFOLLOW")
            | _required_os_flag("O_CLOEXEC"),
        )
        value = os.fstat(directory_fd)
        if (
            _runtime_snapshot(value) != path_snapshot
            or not stat.S_ISDIR(value.st_mode)
            or _is_dataless(value)
        ):
            _fail("EXECUTABLE", "private runtime staging directory changed")
        transferred = True
        return (
            path,
            directory_fd,
            _RuntimeDirectoryBinding(path=path, snapshot=path_snapshot),
        )
    except DecoderRuntimeError:
        raise
    except OSError as exc:
        raise DecoderRuntimeError(
            "EXECUTABLE", "private runtime staging could not be created"
        ) from exc
    finally:
        if not transferred:
            # Scrubbing is independent of descriptor close/fstat behavior.
            if path is not None:
                if cleanup_snapshot is not None:
                    _safe_rmdir_bound(path, cleanup_snapshot)
                else:
                    try:
                        os.rmdir(path)
                    except OSError:
                        pass
            if directory_fd >= 0:
                _close_private_descriptor(directory_fd)


def _stage_runtime_object(
    lease: Any,
    *,
    object_sha256: str,
    name: str,
    directory_fd: int,
    executable: bool,
    aggregate_bytes_remaining: int,
) -> tuple[int, _RuntimeObjectBinding]:
    if type(aggregate_bytes_remaining) is not int or aggregate_bytes_remaining < 1:
        _fail("OBJECT", "runtime closure exceeds its total-byte limit")
    object_limit = min(
        MAX_DECODER_RUNTIME_OBJECT_BYTES,
        aggregate_bytes_remaining,
    )
    mode = 0o500 if executable else 0o400
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | _required_os_flag("O_NOFOLLOW")
        | _required_os_flag("O_CLOEXEC")
    )
    destination_fd = -1
    created = False
    succeeded = False
    total = 0
    digest = hashlib.sha256()
    binding: _RuntimeObjectBinding | None = None
    try:
        with lease.open_verified_object(
            object_sha256,
            max_bytes=object_limit,
        ) as source:
            destination_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
            created = True
            while True:
                chunk = source.read(_STAGED_READ_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > object_limit:
                    _fail("OBJECT", "runtime closure exceeds its fixed byte limits")
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_fd, view)
                    if written <= 0:
                        _fail("OBJECT", "runtime object staging was incomplete")
                    view = view[written:]
            if digest.hexdigest() != object_sha256:
                _fail("OBJECT", "staged runtime object hash changed")
            if total == 0:
                code = "EXECUTABLE" if executable else "OBJECT"
                _fail(code, "runtime objects must not be empty")
            os.fchmod(destination_fd, mode)
            os.fsync(destination_fd)
            before = os.fstat(destination_fd)
            path_value = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or _is_dataless(before)
                or before.st_dev != path_value.st_dev
                or before.st_ino != path_value.st_ino
                or _runtime_snapshot(before) != _runtime_snapshot(path_value)
                or before.st_size != total
                or stat.S_IMODE(before.st_mode) != mode
            ):
                _fail("OBJECT", "staged runtime object shape is unsafe")
            binding = _RuntimeObjectBinding(
                name=name,
                object_sha256=object_sha256,
                expected_mode=mode,
                snapshot=_runtime_snapshot(before),
            )
            succeeded = True
    except DecoderRuntimeError:
        raise
    except ImmutableStoreError as exc:
        raise DecoderRuntimeError(
            "OBJECT", "immutable runtime object verification failed"
        ) from exc
    except OSError as exc:
        code = "EXECUTABLE" if executable else "OBJECT"
        raise DecoderRuntimeError(code, "runtime object staging failed") from exc
    finally:
        if created and not succeeded:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        if destination_fd >= 0:
            active_error = sys.exc_info()[0] is not None
            if not _close_private_descriptor(destination_fd) and not active_error:
                if succeeded:
                    try:
                        os.unlink(name, dir_fd=directory_fd)
                    except OSError:
                        pass
                _fail("OBJECT", "staged runtime descriptor close failed")
    if binding is None:
        raise AssertionError("successful runtime staging requires a binding")
    return total, binding


def _hash_descriptor(descriptor: int, *, maximum_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, _STAGED_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > maximum_bytes:
            _fail("OBJECT", "staged runtime object exceeds its bound")
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest(), total


def _validate_runtime_object_binding(
    directory_fd: int,
    binding: _RuntimeObjectBinding,
) -> None:
    object_fd = -1
    try:
        path_before = os.stat(
            binding.name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            _runtime_snapshot(path_before) != binding.snapshot
            or not stat.S_ISREG(path_before.st_mode)
            or path_before.st_nlink != 1
            or stat.S_IMODE(path_before.st_mode) != binding.expected_mode
            or _is_dataless(path_before)
        ):
            _fail("OBJECT", "staged runtime object changed after binding")
        object_fd = os.open(
            binding.name,
            os.O_RDONLY
            | _required_os_flag("O_NOFOLLOW")
            | _required_os_flag("O_CLOEXEC")
            | _required_os_flag("O_NONBLOCK"),
            dir_fd=directory_fd,
        )
        descriptor_before = os.fstat(object_fd)
        if _runtime_snapshot(descriptor_before) != binding.snapshot:
            _fail("OBJECT", "staged runtime object changed while reopening")
        digest, total = _hash_descriptor(
            object_fd,
            maximum_bytes=MAX_DECODER_RUNTIME_OBJECT_BYTES,
        )
        descriptor_after = os.fstat(object_fd)
        path_after = os.stat(
            binding.name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            _runtime_snapshot(descriptor_after) != binding.snapshot
            or _runtime_snapshot(path_after) != binding.snapshot
            or digest != binding.object_sha256
            or total != binding.snapshot.size
        ):
            _fail("OBJECT", "staged runtime object failed exact revalidation")
    except DecoderRuntimeError:
        raise
    except OSError as exc:
        raise DecoderRuntimeError(
            "OBJECT", "staged runtime object could not be revalidated"
        ) from exc
    finally:
        if object_fd >= 0:
            active_error = sys.exc_info()[0] is not None
            try:
                os.close(object_fd)
            except OSError as exc:
                if not active_error:
                    raise DecoderRuntimeError(
                        "OBJECT", "runtime revalidation descriptor close failed"
                    ) from exc


def _scrub_bound_runtime_directory(
    directory_binding: _RuntimeDirectoryBinding,
    directory_fd: int,
    expected_child_names: tuple[str, ...],
    child_bindings: tuple[_RuntimeObjectBinding, ...],
) -> tuple[str, ...]:
    """Best-effort FD-relative scrub that never traverses a replacement path."""

    failures: list[str] = []
    bindings_by_name = {binding.name: binding for binding in child_bindings}
    directory_is_bound = False
    try:
        value = _fstat_private_descriptor(directory_fd)
        if value is None:
            raise OSError("directory descriptor fstat failed")
        directory_is_bound = _same_identity(value, directory_binding.snapshot)
        if not directory_is_bound:
            failures.append("directory descriptor identity changed")
    except OSError:
        failures.append("directory descriptor is unavailable")

    if directory_is_bound:
        try:
            os.fchmod(directory_fd, 0o700)
        except OSError:
            failures.append("directory mode could not be restored")

        for name in expected_child_names:
            binding = bindings_by_name.get(name)
            child_fd = -1
            try:
                path_value = os.stat(
                    name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )
                if stat.S_ISDIR(path_value.st_mode):
                    failures.append(f"{name} changed into a directory")
                    continue
                if binding is not None:
                    if not _same_identity(path_value, binding.snapshot):
                        failures.append(f"{name} identity changed")
                    else:
                        try:
                            child_fd = os.open(
                                name,
                                os.O_RDONLY
                                | _required_os_flag("O_NOFOLLOW")
                                | _required_os_flag("O_CLOEXEC")
                                | _required_os_flag("O_NONBLOCK"),
                                dir_fd=directory_fd,
                            )
                            opened = os.fstat(child_fd)
                            if not _same_identity(opened, binding.snapshot):
                                failures.append(f"{name} reopen identity changed")
                            else:
                                try:
                                    digest, total = _hash_descriptor(
                                        child_fd,
                                        maximum_bytes=MAX_DECODER_RUNTIME_OBJECT_BYTES,
                                    )
                                    if (
                                        digest != binding.object_sha256
                                        or total != binding.snapshot.size
                                        or opened.st_nlink != 1
                                        or not stat.S_ISREG(opened.st_mode)
                                        or _is_dataless(opened)
                                    ):
                                        failures.append(f"{name} binding changed")
                                except (DecoderRuntimeError, OSError):
                                    failures.append(f"{name} verification failed")
                        except OSError:
                            failures.append(f"{name} could not be reopened")
                try:
                    current = os.stat(
                        name,
                        dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
                    if stat.S_ISDIR(current.st_mode):
                        failures.append(f"{name} changed into a directory before unlink")
                    else:
                        os.unlink(name, dir_fd=directory_fd)
                except OSError:
                    failures.append(f"{name} could not be unlinked")
                if child_fd >= 0:
                    try:
                        if os.fstat(child_fd).st_nlink != 0:
                            failures.append(f"{name} retains a hard-link alias")
                    except OSError:
                        failures.append(f"{name} post-unlink check failed")
            except FileNotFoundError:
                pass
            except OSError:
                failures.append(f"{name} could not be inspected")
            finally:
                if child_fd >= 0:
                    try:
                        os.close(child_fd)
                    except OSError:
                        failures.append(f"{name} descriptor close failed")

    if not _safe_rmdir_bound(directory_binding.path, directory_binding.snapshot):
        failures.append("original directory path was not removed")

    if not _close_bound_directory_descriptor(
        directory_fd,
        directory_binding.snapshot,
    ):
        failures.append("directory descriptor close failed")
    return tuple(failures)


class _VerifiedDecoderRuntimeLease:
    """Private, revalidating path capability for the protected coordinator."""

    __slots__ = (
        "_active",
        "_decoder_recipe_sha256",
        "_dependency_names",
        "_directory_binding",
        "_directory_fd",
        "_generation_id",
        "_manifest",
        "_manifest_sha256",
        "_object_bindings",
        "_runtime_id",
        "_state_lock",
    )

    def __init__(
        self,
        *,
        directory_binding: _RuntimeDirectoryBinding,
        directory_fd: int,
        generation_id: str,
        manifest_sha256: str,
        manifest: DecoderRuntimeManifestV1,
        object_bindings: tuple[_RuntimeObjectBinding, ...],
    ) -> None:
        self._active = True
        self._directory_binding = directory_binding
        self._directory_fd = directory_fd
        self._generation_id = generation_id
        self._manifest_sha256 = manifest_sha256
        self._manifest = manifest
        self._runtime_id = manifest.runtime_id
        self._decoder_recipe_sha256 = manifest.decoder_recipe_sha256
        self._dependency_names = tuple(
            item.install_name for item in manifest.dependency_closure
        )
        self._object_bindings = object_bindings
        self._state_lock = threading.RLock()

    def __repr__(self) -> str:
        return (
            "_VerifiedDecoderRuntimeLease("
            f"runtime_id={self._runtime_id!r}, active={self._active!r})"
        )

    @property
    def runtime_id(self) -> str:
        return self._runtime_id

    @property
    def generation_id(self) -> str:
        return self._generation_id

    @property
    def manifest_sha256(self) -> str:
        return self._manifest_sha256

    @property
    def decoder_recipe_sha256(self) -> str:
        return self._decoder_recipe_sha256

    def _runtime_manifest(self) -> DecoderRuntimeManifestV1:
        """Return the exact immutable manifest to the protected executor only."""

        with self._state_lock:
            if not self._active:
                raise RuntimeError("decoder runtime lease is not active")
            return self._manifest

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

    def _executable_path(self, tool: str) -> Path:
        """Revalidate then return a path for immediate protected execution.

        The returned path still has a TOCTOU interval.  The future executor
        must validate and immediately spawn without exposing it further, keep
        this lease open until the entire child process group is reaped, and
        never retain the path or an extra descriptor beyond that boundary.
        """

        if type(tool) is not str or tool not in {"ffmpeg", "ffprobe"}:
            raise ValueError("tool must be exactly 'ffmpeg' or 'ffprobe'")
        ordinal = 0 if tool == "ffmpeg" else 1
        with self._state_lock:
            if not self._active:
                raise RuntimeError("decoder runtime lease is not active")
            binding = self._object_bindings[ordinal]
        return self._validated_path(binding)

    def _dependency_path(self, ordinal: int) -> Path:
        with self._state_lock:
            if not self._active:
                raise RuntimeError("decoder runtime lease is not active")
            if (
                type(ordinal) is not int
                or not 0 <= ordinal < len(self._dependency_names)
            ):
                raise ValueError("dependency ordinal is invalid")
            binding = self._object_bindings[ordinal + 2]
        return self._validated_path(binding)

    def _validated_path(self, binding: _RuntimeObjectBinding) -> Path:
        with self._state_lock:
            if not self._active:
                raise RuntimeError("decoder runtime lease is not active")
            try:
                descriptor_value = os.fstat(self._directory_fd)
                path_value = self._directory_binding.path.lstat()
            except OSError as exc:
                raise DecoderRuntimeError(
                    "EXECUTABLE", "runtime staging directory is unavailable"
                ) from exc
            expected = self._directory_binding.snapshot
            if (
                _runtime_snapshot(descriptor_value) != expected
                or _runtime_snapshot(path_value) != expected
                or not stat.S_ISDIR(descriptor_value.st_mode)
                or stat.S_IMODE(descriptor_value.st_mode) != 0o500
                or _is_dataless(descriptor_value)
            ):
                _fail("EXECUTABLE", "runtime staging directory changed after binding")
            _validate_runtime_object_binding(self._directory_fd, binding)
            return self._directory_binding.path / binding.name

    def _deactivate_and_scrub(self) -> None:
        with self._state_lock:
            if not self._active:
                return
            self._active = False
            failures = _scrub_bound_runtime_directory(
                self._directory_binding,
                self._directory_fd,
                tuple(binding.name for binding in self._object_bindings),
                self._object_bindings,
            )
            self._directory_fd = -1
            self._object_bindings = ()
            self._dependency_names = ()
            if failures:
                raise DecoderRuntimeError(
                    "CLEANUP", "private runtime staging cleanup was incomplete"
                )


def _validate_loader_inputs(
    *,
    runtime_store_root: Path,
    generation_id: str,
    manifest_sha256: str,
    expected_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
) -> None:
    try:
        if not isinstance(runtime_store_root, Path):
            raise ValueError("runtime_store_root must be a pathlib.Path")
        for field_name in (
            "generation_id",
            "manifest_sha256",
            "expected_manifest_sha256",
            "expected_system_runtime_measurement_sha256",
        ):
            require_sha256(locals()[field_name], field_name)
        for field_name in (
            "expected_platform",
            "expected_architecture",
            "expected_abi",
            "expected_system_runtime_id",
        ):
            require_stable_id(locals()[field_name], field_name)
    except (KeyError, ValueError) as exc:
        raise DecoderRuntimeError(
            "RUNTIME_INPUT", "decoder runtime coordinates are invalid"
        ) from exc


@contextmanager
def load_verified_decoder_runtime(
    *,
    runtime_store_root: Path,
    generation_id: str,
    manifest_sha256: str,
    expected_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
) -> Iterator[_VerifiedDecoderRuntimeLease]:
    """Lease and privately stage one independently pinned exact runtime closure."""

    _validate_loader_inputs(
        runtime_store_root=runtime_store_root,
        generation_id=generation_id,
        manifest_sha256=manifest_sha256,
        expected_manifest_sha256=expected_manifest_sha256,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
        expected_abi=expected_abi,
        expected_system_runtime_id=expected_system_runtime_id,
        expected_system_runtime_measurement_sha256=(
            expected_system_runtime_measurement_sha256
        ),
    )
    if manifest_sha256 != expected_manifest_sha256:
        _fail("PIN", "runtime root does not equal the independent manifest pin")

    staging_path: Path | None = None
    directory_fd = -1
    directory_binding: _RuntimeDirectoryBinding | None = None
    expected_child_names: tuple[str, ...] = ()
    object_bindings: list[_RuntimeObjectBinding] = []
    capability: _VerifiedDecoderRuntimeLease | None = None
    body_error: BaseException | None = None
    try:
        try:
            with generation_read_lease(runtime_store_root, generation_id) as lease:
                descriptor_sha256s = lease.descriptor.object_sha256s
                if manifest_sha256 not in descriptor_sha256s:
                    _fail("CLOSURE", "runtime root is absent from its generation")
                try:
                    with lease.open_verified_object(
                        manifest_sha256,
                        max_bytes=MAX_DECODER_RUNTIME_MANIFEST_BYTES,
                    ) as source:
                        manifest_raw = source.read(
                            MAX_DECODER_RUNTIME_MANIFEST_BYTES + 1
                        )
                except ImmutableStoreError as exc:
                    raise DecoderRuntimeError(
                        "OBJECT", "runtime manifest object verification failed"
                    ) from exc
                manifest = DecoderRuntimeManifestV1.from_json_bytes(manifest_raw)
                if manifest.fingerprint() != manifest_sha256:
                    _fail("PIN", "runtime manifest fingerprint differs from its pin")
                if (
                    manifest.platform != expected_platform
                    or manifest.architecture != expected_architecture
                    or manifest.abi != expected_abi
                    or manifest.system_runtime_measurement.runtime_id
                    != expected_system_runtime_id
                    or manifest.system_runtime_measurement.measurement_sha256
                    != expected_system_runtime_measurement_sha256
                ):
                    _fail(
                        "PLATFORM",
                        "runtime platform, ABI, or system measurement is not the expected pin",
                    )

                exact_closure = tuple(
                    sorted((manifest_sha256, *manifest.object_sha256s()))
                )
                if len(set(exact_closure)) != len(exact_closure):
                    _fail("CLOSURE", "runtime closure contains aliased object roles")
                if descriptor_sha256s != exact_closure:
                    _fail(
                        "CLOSURE",
                        "runtime generation has missing or extra objects",
                    )
                if manifest_sha256 in manifest.object_sha256s():
                    _fail("CLOSURE", "runtime root aliases a child object")

                expected_child_names = (
                    "ffmpeg",
                    "ffprobe",
                    *(
                        f"dependency-{ordinal:04d}"
                        for ordinal in range(len(manifest.dependency_closure))
                    ),
                )

                staging_path, directory_fd, directory_binding = _private_directory(
                    "vision-scoring-decoder-runtime-"
                )
                total_bytes = len(manifest_raw)
                if total_bytes >= MAX_DECODER_RUNTIME_TOTAL_BYTES:
                    _fail("OBJECT", "runtime closure exceeds its total-byte limit")
                staged_bytes, binding = _stage_runtime_object(
                    lease,
                    object_sha256=manifest.ffmpeg_object_sha256,
                    name="ffmpeg",
                    directory_fd=directory_fd,
                    executable=True,
                    aggregate_bytes_remaining=(
                        MAX_DECODER_RUNTIME_TOTAL_BYTES - total_bytes
                    ),
                )
                total_bytes += staged_bytes
                object_bindings.append(binding)
                staged_bytes, binding = _stage_runtime_object(
                    lease,
                    object_sha256=manifest.ffprobe_object_sha256,
                    name="ffprobe",
                    directory_fd=directory_fd,
                    executable=True,
                    aggregate_bytes_remaining=(
                        MAX_DECODER_RUNTIME_TOTAL_BYTES - total_bytes
                    ),
                )
                total_bytes += staged_bytes
                object_bindings.append(binding)
                for ordinal, dependency in enumerate(manifest.dependency_closure):
                    name = f"dependency-{ordinal:04d}"
                    staged_bytes, binding = _stage_runtime_object(
                        lease,
                        object_sha256=dependency.object_sha256,
                        name=name,
                        directory_fd=directory_fd,
                        executable=False,
                        aggregate_bytes_remaining=(
                            MAX_DECODER_RUNTIME_TOTAL_BYTES - total_bytes
                        ),
                    )
                    total_bytes += staged_bytes
                    object_bindings.append(binding)

                os.fchmod(directory_fd, 0o500)
                os.fsync(directory_fd)
                descriptor_value = os.fstat(directory_fd)
                path_value = staging_path.lstat()
                if (
                    not stat.S_ISDIR(descriptor_value.st_mode)
                    or stat.S_IMODE(descriptor_value.st_mode) != 0o500
                    or _is_dataless(descriptor_value)
                    or _runtime_snapshot(descriptor_value)
                    != _runtime_snapshot(path_value)
                    or not _same_identity(
                        descriptor_value,
                        directory_binding.snapshot,
                    )
                ):
                    _fail("EXECUTABLE", "runtime directory final binding failed")
                final_directory_binding = _RuntimeDirectoryBinding(
                    path=staging_path,
                    snapshot=_runtime_snapshot(descriptor_value),
                )
                capability = _VerifiedDecoderRuntimeLease(
                    directory_binding=final_directory_binding,
                    directory_fd=directory_fd,
                    generation_id=generation_id,
                    manifest_sha256=manifest_sha256,
                    manifest=manifest,
                    object_bindings=tuple(object_bindings),
                )
                # Exact descriptor/path ownership transfers to the capability.
                directory_fd = -1
                staging_path = None
                directory_binding = None
                object_bindings = []
                try:
                    yield capability
                except BaseException as exc:
                    body_error = exc
                    raise
                finally:
                    try:
                        capability._deactivate_and_scrub()
                    except DecoderRuntimeError:
                        if body_error is None:
                            raise
                    finally:
                        capability = None
        except DecoderRuntimeError:
            raise
        except ImmutableStoreError as exc:
            raise DecoderRuntimeError(
                "CLOSURE", "immutable runtime generation verification failed"
            ) from exc
        except ValueError as exc:
            raise DecoderRuntimeError(
                "CLOSURE", "immutable runtime generation metadata is invalid"
            ) from exc
    finally:
        if (
            directory_fd >= 0
            and staging_path is not None
            and directory_binding is not None
        ):
            failures = _scrub_bound_runtime_directory(
                directory_binding,
                directory_fd,
                expected_child_names,
                tuple(object_bindings),
            )
            if failures and sys.exc_info()[0] is None:
                raise DecoderRuntimeError(
                    "CLEANUP", "private runtime staging cleanup was incomplete"
                )


__all__ = [
    "DECODER_RUNTIME_DOMAIN",
    "DECODER_RUNTIME_SCHEMA_VERSION",
    "MAX_DECODER_RUNTIME_DEPENDENCIES",
    "MAX_DECODER_RUNTIME_FLAGS",
    "MAX_DECODER_RUNTIME_MANIFEST_BYTES",
    "MAX_DECODER_RUNTIME_OBJECT_BYTES",
    "MAX_DECODER_RUNTIME_SYSTEM_INSTALL_NAMES",
    "MAX_DECODER_RUNTIME_TOTAL_BYTES",
    "MAX_DECODER_VERSION_OUTPUT_BYTES",
    "DecoderRuntimeDependencyV1",
    "DecoderRuntimeError",
    "DecoderRuntimeManifestV1",
    "PinnedSystemRuntimeMeasurementV1",
    "load_verified_decoder_runtime",
    "normalized_decoder_version_output_sha256",
]
