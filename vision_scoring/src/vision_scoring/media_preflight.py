"""Deterministic, fail-closed technical inventory for local media files.

This module hashes source bytes, inventories selected ffprobe container/stream
facts, and scans primary-video packet timestamp metadata. It does not decode
media or decide whether a source is suitable for training or live scoring.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat as stat_module
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Protocol, Sequence

SCHEMA_VERSION = "1.0"
ITEM_STATUS = "QUARANTINED"
_HASH_CHUNK_BYTES = 1024 * 1024
_MAX_METADATA_BYTES = 16 * 1024 * 1024
_MAX_IDENTITY_BYTES = 64 * 1024
_MAX_PROCESS_STDERR_BYTES = 64 * 1024
_MAX_PACKET_LINE_BYTES = 4096
_MAX_ERROR_CHARS = 4096
_MAX_REFERENCE_CHARS = 2048
_MAX_TIMESTAMP_DETAILS_PER_KIND = 50
_MAX_SOURCES_PER_REPORT = 256
_MAX_STREAMS_PER_SOURCE = 128
_MAX_PROGRAMS_PER_SOURCE = 128
_MAX_PROBE_SCALAR_CHARS = 4096
_MAX_SOURCE_PATH_CHARS = 4096
_MAX_ITEM_CANONICAL_JSON_BYTES = 512 * 1024
_MAX_REPORT_CANONICAL_JSON_BYTES = 16 * 1024 * 1024
_MAX_DURATION_DECIMAL_CHARS = 256
_MAX_DECIMAL_SIGNIFICANT_DIGITS = 77
_MAX_DECIMAL_EXPONENT_ABS = 256
_MAX_DECIMAL_ADJUSTED_ABS = 128
_MAX_INPUT_FRACTION_BITS = 256
_MAX_RESULT_FRACTION_BITS = 512
_MAX_EXACT_DECIMAL_SCALE = 256
_DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024 * 1024
_ABSOLUTE_MAX_SOURCE_BYTES = 1024 * 1024 * 1024 * 1024
_DEFAULT_HASH_TIMEOUT_SECONDS = 900.0
_MAX_HASH_TIMEOUT_SECONDS = 3600.0
_MAX_SNAPSHOT_WORKER_OUTPUT_BYTES = 4096
_DARWIN_SF_DATALESS = 0x40000000
_INTEGER_RE = re.compile(r"^[+-]?\d+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class UnverifiedRightsClaim(str, Enum):
    NO_CLAIM = "NO_CLAIM"
    CLAIMED_OWNED = "CLAIMED_OWNED"
    CLAIMED_LICENSED = "CLAIMED_LICENSED"
    CLAIMED_PUBLIC_DOMAIN = "CLAIMED_PUBLIC_DOMAIN"
    CLAIMED_RESTRICTED = "CLAIMED_RESTRICTED"
    CLAIMED_RESEARCH_ONLY = "CLAIMED_RESEARCH_ONLY"


class ProbeError(RuntimeError):
    """An ffprobe process or output failed closed."""


class OfflinePlaceholderError(ValueError):
    """A local path exists but its bytes are not resident and safe to inspect."""


class SourceTooLargeError(ValueError):
    """A source's initial logical length exceeds the configured ceiling."""


class SourceSnapshotError(ValueError):
    """A source could not be copied into a stable content-addressed snapshot."""


class ProbeBackend(Protocol):
    """Injectable boundary around ffprobe for deterministic unit fixtures."""

    def identity(self) -> Mapping[str, str]:
        """Return the exact probe implementation/build identity."""

    def read_metadata(self, source: Path) -> Mapping[str, Any]:
        """Return parsed ffprobe container/stream JSON."""

    def iter_packet_lines(self, source: Path, stream_index: int) -> Iterator[str]:
        """Yield compact ffprobe packet rows and raise on incomplete scans."""


@dataclass(frozen=True, slots=True)
class ExplicitSourceContext:
    """Caller-supplied context; references are recorded but never verified."""

    rights_claim: UnverifiedRightsClaim = UnverifiedRightsClaim.NO_CLAIM
    rights_ref: str | None = None
    provenance_ref: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.rights_claim, UnverifiedRightsClaim):
            raise ValueError("rights_claim must be an UnverifiedRightsClaim")
        _validate_reference(self.rights_ref, "rights_ref")
        _validate_reference(self.provenance_ref, "provenance_ref")
        if self.rights_claim is UnverifiedRightsClaim.NO_CLAIM and self.rights_ref is not None:
            raise ValueError("rights_ref cannot be supplied when rights_claim is NO_CLAIM")
        if self.rights_claim is not UnverifiedRightsClaim.NO_CLAIM and self.rights_ref is None:
            raise ValueError("an explicit rights claim requires --rights-ref")

    def rights_claim_dict(self) -> dict[str, Any]:
        explicit = self.rights_claim is not UnverifiedRightsClaim.NO_CLAIM
        return {
            "claim": self.rights_claim.value,
            "verification": "UNVERIFIED",
            "evidence_ref": self.rights_ref,
            "basis": "USER_SUPPLIED_CLI_UNVERIFIED" if explicit else "DEFAULT_NO_CLAIM",
        }

    def provenance_claim_dict(self) -> dict[str, Any]:
        return {
            "reference": self.provenance_ref,
            "verification": "UNVERIFIED",
            "basis": (
                "USER_SUPPLIED_CLI_UNVERIFIED"
                if self.provenance_ref is not None
                else "UNSPECIFIED"
            ),
        }


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True, slots=True)
class _BoundedCapture:
    stdout: bytes
    stderr: bytes
    returncode: int


@dataclass(frozen=True, slots=True)
class _StagedSource:
    path: Path
    sha256: str
    size_bytes: int
    identity: _FileIdentity

    def assert_unchanged(self) -> None:
        if _path_identity(self.path) != self.identity:
            raise SourceSnapshotError(
                "content-addressed probe snapshot changed during inspection"
            )


class SubprocessProbeBackend:
    """Run ffprobe without a shell and stream packet rows from stdout."""

    def __init__(
        self,
        ffprobe_binary: str = "ffprobe",
        *,
        metadata_timeout_seconds: float = 60.0,
        packet_timeout_seconds: float = 300.0,
    ) -> None:
        if not isinstance(ffprobe_binary, str) or not ffprobe_binary.strip():
            raise ValueError("ffprobe_binary cannot be empty")
        if not _is_positive_finite_number(metadata_timeout_seconds) or not (
            _is_positive_finite_number(packet_timeout_seconds)
        ):
            raise ValueError("probe timeouts must be positive")
        self.ffprobe_binary = ffprobe_binary
        self.metadata_timeout_seconds = metadata_timeout_seconds
        self.packet_timeout_seconds = packet_timeout_seconds

    def identity(self) -> Mapping[str, str]:
        command = [self.ffprobe_binary, "-version"]
        completed = _run_bounded_capture(
            command,
            timeout_seconds=self.metadata_timeout_seconds,
            stdout_limit=_MAX_IDENTITY_BYTES,
            stderr_limit=_MAX_PROCESS_STDERR_BYTES,
            stage="identity inspection",
        )
        if completed.returncode != 0:
            raise ProbeError(
                "ffprobe identity inspection failed: "
                + _safe_process_error(completed.stderr)
            )
        try:
            decoded = completed.stdout.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ProbeError("ffprobe identity output was not valid UTF-8") from exc
        normalized_lines = [line.rstrip() for line in decoded.replace("\r\n", "\n").split("\n")]
        normalized_output = "\n".join(normalized_lines).strip() + "\n"
        version_line = next((line for line in normalized_lines if line.strip()), "")
        if not version_line:
            raise ProbeError("ffprobe identity output did not contain a version line")
        return {
            "backend": "ffprobe",
            "version_line": version_line[:_MAX_REFERENCE_CHARS],
            "version_output_sha256": hashlib.sha256(
                normalized_output.encode("utf-8")
            ).hexdigest(),
        }

    def read_metadata(self, source: Path) -> Mapping[str, Any]:
        command = [
            self.ffprobe_binary,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-show_programs",
            "-of",
            "json",
            str(source),
        ]
        completed = _run_bounded_capture(
            command,
            timeout_seconds=self.metadata_timeout_seconds,
            stdout_limit=_MAX_METADATA_BYTES,
            stderr_limit=_MAX_PROCESS_STDERR_BYTES,
            stage="metadata inspection",
        )
        if completed.returncode != 0:
            raise ProbeError(
                "ffprobe metadata inspection failed: "
                + _safe_process_error(completed.stderr)
            )
        try:
            decoded = completed.stdout.decode("utf-8", errors="strict")
            metadata = json.loads(decoded)
        except (UnicodeDecodeError, ValueError) as exc:
            raise ProbeError("ffprobe metadata output was not valid UTF-8 JSON") from exc
        if not isinstance(metadata, Mapping):
            raise ProbeError("ffprobe metadata root was not a JSON object")
        return metadata

    def iter_packet_lines(self, source: Path, stream_index: int) -> Iterator[str]:
        command = [
            self.ffprobe_binary,
            "-v",
            "error",
            "-select_streams",
            str(stream_index),
            "-show_packets",
            "-show_entries",
            "packet=pts,dts",
            "-of",
            "compact=p=0:nk=0:item_sep=|",
            str(source),
        ]
        yield from self._stream_stdout_lines(command)

    def _stream_stdout_lines(self, command: Sequence[str]) -> Iterator[str]:
        try:
            process = _spawn_process_group(command)
        except FileNotFoundError as exc:
            raise ProbeError(
                f"ffprobe executable was not found: {self.ffprobe_binary}"
            ) from exc
        except OSError as exc:
            raise ProbeError(
                f"ffprobe packet scan could not start: {_safe_error(exc)}"
            ) from exc

        if process.stdout is None or process.stderr is None:
            _stop_process_group(process)
            raise ProbeError("ffprobe packet scan did not expose stdout and stderr")

        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        deadline = time.monotonic() + self.packet_timeout_seconds
        pending = bytearray()
        captured_stderr = bytearray()
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProbeError("ffprobe packet scan timed out")
                events = selector.select(timeout=min(1.0, remaining))
                if not events:
                    continue
                for key, _ in events:
                    chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == "stderr":
                        captured_stderr.extend(chunk)
                        if len(captured_stderr) > _MAX_PROCESS_STDERR_BYTES:
                            raise ProbeError(
                                "ffprobe packet scan stderr exceeded the 64 KiB safety limit"
                            )
                        continue
                    pending.extend(chunk)
                    yield from _pop_packet_lines(pending)
                    if len(pending) > _MAX_PACKET_LINE_BYTES:
                        raise ProbeError(
                            "ffprobe packet row exceeded the 4096-byte safety limit"
                        )

            if pending:
                yield _decode_packet_line(bytes(pending))

            return_code = _wait_until_deadline(
                process,
                deadline,
                process_name="ffprobe",
                stage="packet scan",
            )
            if return_code != 0:
                raise ProbeError(
                    "ffprobe packet scan failed: "
                    + _safe_process_error(bytes(captured_stderr))
                )
        finally:
            selector.close()
            process.stdout.close()
            process.stderr.close()
            _stop_process_group(process)


def _run_bounded_capture(
    command: Sequence[str],
    *,
    timeout_seconds: float,
    stdout_limit: int,
    stderr_limit: int,
    stage: str,
    process_name: str = "ffprobe",
) -> _BoundedCapture:
    """Capture a small process result while bounding time and both pipes."""

    try:
        process = _spawn_process_group(command)
    except FileNotFoundError as exc:
        raise ProbeError(f"{process_name} executable was not found: {command[0]}") from exc
    except OSError as exc:
        raise ProbeError(f"{process_name} {stage} could not start: {_safe_error(exc)}") from exc

    if process.stdout is None or process.stderr is None:
        _stop_process_group(process)
        raise ProbeError(f"{process_name} {stage} did not expose stdout and stderr")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    captured_stdout = bytearray()
    captured_stderr = bytearray()
    deadline = time.monotonic() + timeout_seconds
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError(f"{process_name} {stage} timed out")
            events = selector.select(timeout=min(1.0, remaining))
            if not events:
                continue
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target = captured_stdout if key.data == "stdout" else captured_stderr
                target.extend(chunk)
                limit = stdout_limit if key.data == "stdout" else stderr_limit
                if len(target) > limit:
                    raise ProbeError(
                        f"{process_name} {stage} {key.data} exceeded the "
                        f"{limit}-byte safety limit"
                    )
        returncode = _wait_until_deadline(
            process,
            deadline,
            process_name=process_name,
            stage=stage,
        )
        return _BoundedCapture(
            stdout=bytes(captured_stdout),
            stderr=bytes(captured_stderr),
            returncode=returncode,
        )
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        _stop_process_group(process)


def _spawn_process_group(command: Sequence[str]) -> subprocess.Popen[bytes]:
    if os.name != "posix":
        raise ProbeError("bounded probing requires POSIX process-group semantics")
    return subprocess.Popen(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )


def _wait_until_deadline(
    process: subprocess.Popen[bytes],
    deadline: float,
    *,
    process_name: str,
    stage: str,
) -> int:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProbeError(f"{process_name} {stage} timed out")
    try:
        return process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"{process_name} {stage} timed out") from exc


def _stop_process_group(process: subprocess.Popen[bytes]) -> None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError:
        pass
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(process_group_id, 0)
    except (ProcessLookupError, PermissionError):
        group_exists = False
    else:
        group_exists = True
    if group_exists:
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if process.poll() is None:
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass


def _pop_packet_lines(pending: bytearray) -> Iterator[str]:
    while True:
        newline = pending.find(b"\n")
        if newline < 0:
            return
        raw_line = bytes(pending[:newline])
        del pending[: newline + 1]
        if not raw_line:
            continue
        yield _decode_packet_line(raw_line)


def _decode_packet_line(raw_line: bytes) -> str:
    if len(raw_line) > _MAX_PACKET_LINE_BYTES:
        raise ProbeError("ffprobe packet row exceeded the 4096-byte safety limit")
    try:
        return raw_line.rstrip(b"\r").decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ProbeError("ffprobe packet output was not valid UTF-8") from exc


class MediaPreflight:
    """Build a conservative inventory for local media sources."""

    def __init__(
        self,
        probe_backend: ProbeBackend,
        *,
        max_source_bytes: int = _DEFAULT_MAX_SOURCE_BYTES,
        hash_timeout_seconds: float = _DEFAULT_HASH_TIMEOUT_SECONDS,
    ) -> None:
        if type(max_source_bytes) is not int or max_source_bytes <= 0:
            raise ValueError("max_source_bytes must be a positive integer")
        if max_source_bytes > _ABSOLUTE_MAX_SOURCE_BYTES:
            raise ValueError("max_source_bytes cannot exceed the 1 TiB hard ceiling")
        if not _is_positive_finite_number(hash_timeout_seconds):
            raise ValueError("hash_timeout_seconds must be positive and finite")
        if hash_timeout_seconds > _MAX_HASH_TIMEOUT_SECONDS:
            raise ValueError("hash_timeout_seconds cannot exceed 3600 seconds")
        self.probe_backend = probe_backend
        self.max_source_bytes = max_source_bytes
        self.hash_timeout_seconds = float(hash_timeout_seconds)

    def inspect_sources(
        self,
        sources: Sequence[Path],
        *,
        explicit_context: ExplicitSourceContext | None = None,
    ) -> dict[str, Any]:
        context = explicit_context or ExplicitSourceContext()
        normalized_sources = _normalize_sources(sources)
        if len(normalized_sources) > 1 and (
            context.rights_claim is not UnverifiedRightsClaim.NO_CLAIM
            or context.rights_ref is not None
            or context.provenance_ref is not None
        ):
            raise ValueError(
                "explicit rights/provenance context is allowed only for one source per invocation"
            )

        identity_error: ProbeError | ValueError | None = None
        probe_identity: dict[str, str] | None = None
        try:
            probe_identity = _normalize_probe_identity(self.probe_backend.identity())
        except (ProbeError, ValueError, OSError, RuntimeError) as exc:
            identity_error = exc
        items: list[dict[str, Any]] = []
        retained_item_bytes = 0
        report_item_budget = _report_item_budget()
        for source in normalized_sources:
            item = self._inspect_source(
                source,
                context,
                probe_identity_error=identity_error,
            )
            _enforce_item_size(item)
            item_size = len(canonical_json_bytes(item))
            if (
                retained_item_bytes + item_size > report_item_budget
                and item["probe"] is not None
            ):
                _collapse_probe_for_size(
                    item,
                    "REPORT_ITEM_BUDGET_EXCEEDED",
                    "normalized report item budget was exhausted; probe facts were discarded",
                )
                item_size = len(canonical_json_bytes(item))
            retained_item_bytes += item_size
            items.append(item)
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "technical_preflight_complete": all(
                item["technical_preflight_complete"] for item in items
            ),
            "probe_backend_identity": probe_identity,
            "source_staging_policy": {
                "binding": "PRIVATE_CONTENT_ADDRESSED_LOCAL_SNAPSHOT",
                "max_initial_logical_bytes": self.max_source_bytes,
                "deadline_seconds": self.hash_timeout_seconds,
                "snapshot_parent": "/tmp",
                "reject_symlinks": True,
            },
            "scope": {
                "successful_item_establishes": [
                    "source byte length and SHA-256",
                    "ffprobe input bound to the hashed private snapshot",
                    "probe backend version/build identity",
                    "selected ffprobe container and stream metadata",
                    "ffprobe program membership and explicit primary stream selection",
                    "primary-video PTS/DTS facts in ffprobe demux output order",
                    "primary A/V stream duration delta when both durations are available",
                ],
                "not_evaluated": [
                    "decode integrity",
                    "dropped or missing captured frames",
                    "visual or semantic content duplication",
                    "presentation-timeline or capture-timestamp integrity",
                    "rights validity or provenance authenticity",
                    "ball visibility or processed ball size",
                    "calibration quality",
                    "capture or training readiness",
                ],
                "status_policy": "Every item remains QUARANTINED after technical preflight.",
            },
            "items": items,
        }
        return _finalize_bounded_report(payload)

    def _inspect_source(
        self,
        source: Path,
        context: ExplicitSourceContext,
        *,
        probe_identity_error: ProbeError | ValueError | None,
    ) -> dict[str, Any]:
        item: dict[str, Any] = {
            "source_path": str(source),
            "status": ITEM_STATUS,
            "rights_claim": context.rights_claim_dict(),
            "provenance_claim": context.provenance_claim_dict(),
            "technical_preflight_complete": False,
            "file": None,
            "probe": None,
            "errors": [],
        }
        try:
            with _stage_source_snapshot(
                source,
                max_source_bytes=self.max_source_bytes,
                timeout_seconds=self.hash_timeout_seconds,
            ) as staged:
                item["file"] = {
                    "size_bytes": staged.size_bytes,
                    "sha256": staged.sha256,
                    "probe_binding": "PRIVATE_CONTENT_ADDRESSED_LOCAL_SNAPSHOT",
                }
                if probe_identity_error is not None:
                    item["errors"].append(
                        _error_dict(
                            "PROBE_IDENTITY_FAILED",
                            "probe_identity",
                            probe_identity_error,
                        )
                    )
                    return item
                try:
                    metadata = self.probe_backend.read_metadata(staged.path)
                    normalized_probe, primary_video_index = _normalize_probe_metadata(
                        metadata
                    )
                    packet_scan = _scan_packet_timestamps(
                        self.probe_backend.iter_packet_lines(
                            staged.path, primary_video_index
                        ),
                        primary_video_index,
                    )
                    if packet_scan["packet_count"] == 0:
                        raise ProbeError(
                            "primary video stream exposed no demuxed packets"
                        )
                    normalized_probe["primary_video_packet_timestamps"] = packet_scan
                    staged.assert_unchanged()
                except (OSError, ProbeError, ValueError, RuntimeError) as exc:
                    redacted = ProbeError(
                        _safe_error(exc).replace(
                            str(staged.path), "<content-addressed-snapshot>"
                        ).replace(str(staged.path.parent), "<snapshot-dir>")
                    )
                    item["errors"].append(
                        _error_dict("FFPROBE_FAILED", "probe", redacted)
                    )
                    return item

                item["probe"] = normalized_probe
                item["technical_preflight_complete"] = True
                return item
        except OfflinePlaceholderError as exc:
            item["errors"].append(
                _error_dict("SOURCE_OFFLINE_PLACEHOLDER", "hash", exc)
            )
            return item
        except SourceTooLargeError as exc:
            item["errors"].append(
                _error_dict("SOURCE_TOO_LARGE", "hash", exc)
            )
            return item
        except (OSError, ProbeError, SourceSnapshotError, ValueError) as exc:
            item["errors"].append(
                _error_dict("SOURCE_SNAPSHOT_FAILED", "hash", exc)
            )
            return item


def _normalize_sources(sources: Sequence[Path]) -> tuple[Path, ...]:
    if not sources:
        raise ValueError("at least one source path is required")
    if len(sources) > _MAX_SOURCES_PER_REPORT:
        raise ValueError(
            f"at most {_MAX_SOURCES_PER_REPORT} sources are allowed per report; use batches"
        )
    normalized = tuple(
        sorted(
            (
                Path(os.path.abspath(os.path.expanduser(os.fspath(source))))
                for source in sources
            ),
            key=str,
        )
    )
    if any(len(str(source)) > _MAX_SOURCE_PATH_CHARS for source in normalized):
        raise ValueError(
            f"resolved source paths cannot exceed {_MAX_SOURCE_PATH_CHARS} characters"
        )
    if len(set(normalized)) != len(normalized):
        raise ValueError("the same normalized source path cannot be supplied more than once")
    return normalized


def _normalize_probe_identity(identity: Mapping[str, str]) -> dict[str, str]:
    if not isinstance(identity, Mapping):
        raise ValueError("probe backend identity was not an object")
    expected = {"backend", "version_line", "version_output_sha256"}
    if set(identity) != expected:
        raise ValueError("probe backend identity fields were incomplete or unsupported")
    backend = identity.get("backend")
    version_line = identity.get("version_line")
    output_sha256 = identity.get("version_output_sha256")
    if not isinstance(backend, str) or not backend.strip():
        raise ValueError("probe backend identity name was empty")
    if not isinstance(version_line, str) or not version_line.strip():
        raise ValueError("probe backend version line was empty")
    if not isinstance(output_sha256, str) or not _SHA256_RE.fullmatch(output_sha256):
        raise ValueError("probe backend identity requires a lowercase SHA-256")
    for field_name, value in (("backend", backend), ("version_line", version_line)):
        _validate_reference(value, field_name)
    return {
        "backend": backend,
        "version_line": version_line,
        "version_output_sha256": output_sha256,
    }


@contextmanager
def _stage_source_snapshot(
    source: Path,
    *,
    max_source_bytes: int,
    timeout_seconds: float,
) -> Iterator[_StagedSource]:
    snapshot_parent = Path("/tmp")
    if os.name != "posix" or not snapshot_parent.is_dir():
        raise SourceSnapshotError(
            "content-addressed staging requires an available POSIX /tmp filesystem"
        )
    with tempfile.TemporaryDirectory(
        prefix="vision-scoring-media-",
        dir=snapshot_parent,
    ) as directory_name:
        directory = Path(directory_name)
        partial_path = directory / "source.partial"
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--_snapshot-worker",
            str(source),
            str(partial_path),
            str(max_source_bytes),
        ]
        completed = _run_bounded_capture(
            command,
            timeout_seconds=timeout_seconds,
            stdout_limit=_MAX_SNAPSHOT_WORKER_OUTPUT_BYTES,
            stderr_limit=_MAX_SNAPSHOT_WORKER_OUTPUT_BYTES,
            stage="hashing and staging",
            process_name="source snapshot worker",
        )
        worker_error = _safe_process_error(completed.stderr)
        worker_error = worker_error.replace(str(source), "<source>").replace(
            str(directory), "<snapshot-dir>"
        )
        if completed.returncode == 3:
            raise OfflinePlaceholderError(worker_error)
        if completed.returncode == 4:
            raise SourceTooLargeError(worker_error)
        if completed.returncode != 0:
            raise SourceSnapshotError(worker_error)
        try:
            result = json.loads(completed.stdout.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise SourceSnapshotError(
                "snapshot worker returned invalid UTF-8 JSON"
            ) from exc
        if not isinstance(result, Mapping) or set(result) != {"sha256", "size_bytes"}:
            raise SourceSnapshotError("snapshot worker returned an invalid result schema")
        source_sha256 = result.get("sha256")
        size_bytes = result.get("size_bytes")
        if not isinstance(source_sha256, str) or not _SHA256_RE.fullmatch(source_sha256):
            raise SourceSnapshotError("snapshot worker returned an invalid SHA-256")
        if type(size_bytes) is not int or size_bytes < 0 or size_bytes > max_source_bytes:
            raise SourceSnapshotError("snapshot worker returned an invalid logical byte count")
        partial_stat = partial_path.stat()
        if not stat_module.S_ISREG(partial_stat.st_mode) or partial_stat.st_size != size_bytes:
            raise SourceSnapshotError("staged snapshot size did not match the worker result")

        suffix = source.suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
            suffix = ".media"
        snapshot_path = directory / f"{source_sha256}{suffix}"
        os.replace(partial_path, snapshot_path)
        snapshot_path.chmod(0o400)
        identity = _path_identity(snapshot_path)
        staged = _StagedSource(
            path=snapshot_path,
            sha256=source_sha256,
            size_bytes=size_bytes,
            identity=identity,
        )
        staged.assert_unchanged()
        try:
            yield staged
        finally:
            staged.assert_unchanged()


def _copy_source_to_snapshot(
    source: Path,
    destination: Path,
    max_source_bytes: int,
) -> dict[str, Any]:
    source_lstat = os.lstat(source)
    if stat_module.S_ISLNK(source_lstat.st_mode):
        raise SourceSnapshotError("symbolic-link sources are not accepted")
    if not stat_module.S_ISREG(source_lstat.st_mode):
        raise SourceSnapshotError("source must be a regular file")
    if _stat_is_dataless(source_lstat):
        raise OfflinePlaceholderError(
            "source is an offline/dataless placeholder; download it locally first"
        )
    open_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    source_fd = os.open(source, open_flags)
    destination_fd: int | None = None
    try:
        initial_stat = os.fstat(source_fd)
        if not stat_module.S_ISREG(initial_stat.st_mode):
            raise SourceSnapshotError("source must be a regular file")
        if (source_lstat.st_dev, source_lstat.st_ino) != (
            initial_stat.st_dev,
            initial_stat.st_ino,
        ):
            raise SourceSnapshotError("source pathname changed before descriptor binding")
        if _stat_is_dataless(initial_stat):
            raise OfflinePlaceholderError(
                "source is an offline/dataless placeholder; download it locally first"
            )
        initial_size = initial_stat.st_size
        if initial_size < 0:
            raise SourceSnapshotError("source reported a negative logical byte count")
        if initial_size > max_source_bytes:
            raise SourceTooLargeError(
                f"source logical byte count exceeds configured maximum {max_source_bytes}"
            )

        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        digest = hashlib.sha256()
        remaining = initial_size
        while remaining:
            chunk = os.read(source_fd, min(_HASH_CHUNK_BYTES, remaining))
            if not chunk:
                raise SourceSnapshotError(
                    "source reached EOF before its fixed initial logical byte count"
                )
            digest.update(chunk)
            _write_all(destination_fd, chunk)
            remaining -= len(chunk)
        if os.read(source_fd, 1):
            raise SourceSnapshotError(
                "source grew beyond its fixed initial logical byte count"
            )

        final_stat = os.fstat(source_fd)
        if _identity_from_stat(final_stat) != _identity_from_stat(initial_stat):
            raise SourceSnapshotError("source changed while it was hashed and staged")
        final_path_stat = os.lstat(source)
        if (final_path_stat.st_dev, final_path_stat.st_ino) != (
            initial_stat.st_dev,
            initial_stat.st_ino,
        ):
            raise SourceSnapshotError("source pathname changed while it was staged")
        os.fsync(destination_fd)
        return {"sha256": digest.hexdigest(), "size_bytes": initial_size}
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)


def _write_all(file_descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(file_descriptor, view)
        if written <= 0:
            raise SourceSnapshotError("snapshot destination stopped accepting bytes")
        view = view[written:]


def _snapshot_worker_main(argv: Sequence[str]) -> int:
    if len(argv) != 3:
        print("WORKER_ARGUMENT_ERROR:expected source, destination, and max bytes", file=sys.stderr)
        return 2
    source = Path(argv[0])
    destination = Path(argv[1])
    try:
        max_source_bytes = int(argv[2])
        if max_source_bytes <= 0:
            raise ValueError
    except ValueError:
        print("WORKER_ARGUMENT_ERROR:max bytes must be a positive integer", file=sys.stderr)
        return 2
    try:
        result = _copy_source_to_snapshot(source, destination, max_source_bytes)
    except OfflinePlaceholderError as exc:
        print(f"OFFLINE_PLACEHOLDER:{_safe_error(exc)}", file=sys.stderr)
        return 3
    except SourceTooLargeError as exc:
        print(f"SOURCE_TOO_LARGE:{_safe_error(exc)}", file=sys.stderr)
        return 4
    except (OSError, SourceSnapshotError, ValueError) as exc:
        print(f"SOURCE_SNAPSHOT_FAILED:{_safe_error(exc)}", file=sys.stderr)
        return 5
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


def _path_identity(source: Path) -> _FileIdentity:
    return _identity_from_stat(source.stat())


def _identity_from_stat(stat_result: os.stat_result) -> _FileIdentity:
    return _FileIdentity(
        device=stat_result.st_dev,
        inode=stat_result.st_ino,
        size=stat_result.st_size,
        modified_ns=stat_result.st_mtime_ns,
        changed_ns=stat_result.st_ctime_ns,
    )


def _stat_is_dataless(stat_result: os.stat_result, *, platform: str | None = None) -> bool:
    effective_platform = sys.platform if platform is None else platform
    if effective_platform != "darwin":
        return False
    mask = (
        getattr(stat_module, "SF_DATALESS", 0)
        | getattr(stat_module, "UF_DATALESS", 0)
        | _DARWIN_SF_DATALESS
    )
    # Some Python/macOS SDK combinations omit the public constant even though
    # st_flags carries the Darwin SF_DATALESS bit.
    return bool(mask and getattr(stat_result, "st_flags", 0) & mask)


_CONTAINER_FACT_FIELDS = (
    "format_name",
    "format_long_name",
    "start_time",
    "duration",
    "bit_rate",
    "probe_score",
    "nb_streams",
    "nb_programs",
)
_STREAM_FACT_FIELDS = (
    "index",
    "codec_type",
    "codec_name",
    "codec_long_name",
    "profile",
    "codec_tag_string",
    "width",
    "height",
    "coded_width",
    "coded_height",
    "pix_fmt",
    "field_order",
    "color_range",
    "color_space",
    "color_transfer",
    "color_primaries",
    "sample_aspect_ratio",
    "display_aspect_ratio",
    "r_frame_rate",
    "avg_frame_rate",
    "time_base",
    "start_pts",
    "start_time",
    "duration_ts",
    "duration",
    "bit_rate",
    "bits_per_raw_sample",
    "nb_frames",
    "sample_fmt",
    "sample_rate",
    "channels",
    "channel_layout",
)
_PROGRAM_FACT_FIELDS = (
    "program_id",
    "program_num",
    "nb_streams",
    "pmt_pid",
    "pcr_pid",
    "start_pts",
    "start_time",
    "end_pts",
    "end_time",
)


def _normalize_probe_metadata(metadata: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    streams_raw = metadata.get("streams")
    programs_raw = metadata.get("programs")
    format_raw = metadata.get("format")
    if not isinstance(streams_raw, list):
        raise ProbeError("ffprobe metadata did not contain a streams array")
    if len(streams_raw) > _MAX_STREAMS_PER_SOURCE:
        raise ProbeError(
            f"ffprobe returned more than {_MAX_STREAMS_PER_SOURCE} streams"
        )
    if not isinstance(programs_raw, list):
        raise ProbeError("ffprobe metadata did not contain a programs array")
    if len(programs_raw) > _MAX_PROGRAMS_PER_SOURCE:
        raise ProbeError(
            f"ffprobe returned more than {_MAX_PROGRAMS_PER_SOURCE} programs"
        )
    if not isinstance(format_raw, Mapping):
        raise ProbeError("ffprobe metadata did not contain a format object")

    seen_indices: set[int] = set()
    stream_pairs: list[tuple[Mapping[str, Any], dict[str, Any]]] = []
    for raw in streams_raw:
        if not isinstance(raw, Mapping):
            raise ProbeError("ffprobe stream entry was not an object")
        index = raw.get("index")
        if type(index) is not int or index < 0:
            raise ProbeError("ffprobe stream index was not a non-negative integer")
        if index in seen_indices:
            raise ProbeError("ffprobe returned duplicate stream indices")
        seen_indices.add(index)
        facts = {field: raw.get(field) for field in _STREAM_FACT_FIELDS}
        facts["disposition"] = _normalize_disposition(
            raw.get("disposition"), f"stream[{index}].disposition"
        )
        facts["rotation_degrees"] = _rotation_degrees(raw)
        _require_json_scalars(facts, f"stream[{index}]")
        stream_pairs.append((raw, facts))

    programs, program_membership = _normalize_programs(programs_raw, seen_indices)

    video_candidates = [
        pair
        for pair in stream_pairs
        if pair[0].get("codec_type") == "video"
        and pair[1]["disposition"]["attached_pic"] != 1
    ]
    if not video_candidates:
        raise ProbeError("ffprobe found no non-attached-picture video stream")
    primary_video_raw, _ = min(video_candidates, key=_primary_stream_sort_key)
    primary_video_index = primary_video_raw["index"]

    audio_candidates = [
        pair for pair in stream_pairs if pair[0].get("codec_type") == "audio"
    ]
    video_program_ids = tuple(program_membership.get(primary_video_index, ()))
    unavailable_reason: str | None = None
    if not programs:
        scoped_audio_candidates = audio_candidates
        audio_selection_basis = (
            "IMPLICIT_UNPROGRAMMED_CONTAINER_DEFAULT_DISPOSITION_THEN_LOWEST_STREAM_INDEX"
        )
        if not scoped_audio_candidates:
            unavailable_reason = "NO_PRIMARY_AUDIO_STREAM"
    elif len(video_program_ids) == 1:
        program_stream_indices = set(
            next(
                program["stream_indices"]
                for program in programs
                if program["program_id"] == video_program_ids[0]
            )
        )
        scoped_audio_candidates = [
            pair for pair in audio_candidates if pair[0]["index"] in program_stream_indices
        ]
        audio_selection_basis = (
            "UNIQUE_PRIMARY_VIDEO_PROGRAM_DEFAULT_DISPOSITION_THEN_LOWEST_STREAM_INDEX"
        )
        if not scoped_audio_candidates:
            unavailable_reason = "NO_AUDIO_STREAM_IN_PRIMARY_VIDEO_PROGRAM"
    elif not video_program_ids:
        scoped_audio_candidates = []
        audio_selection_basis = "UNAVAILABLE_PRIMARY_VIDEO_PROGRAM_MEMBERSHIP_MISSING"
        unavailable_reason = "PRIMARY_VIDEO_PROGRAM_MEMBERSHIP_MISSING"
    else:
        scoped_audio_candidates = []
        audio_selection_basis = "UNAVAILABLE_PRIMARY_VIDEO_PROGRAM_MEMBERSHIP_AMBIGUOUS"
        unavailable_reason = "PRIMARY_VIDEO_PROGRAM_MEMBERSHIP_AMBIGUOUS"

    primary_audio_raw = (
        min(scoped_audio_candidates, key=_primary_stream_sort_key)[0]
        if scoped_audio_candidates
        else None
    )

    stream_pairs.sort(key=lambda pair: pair[0]["index"])
    container = {field: format_raw.get(field) for field in _CONTAINER_FACT_FIELDS}
    _require_json_scalars(container, "format")
    duration_delta = _duration_delta(
        primary_video_raw,
        primary_audio_raw,
        unavailable_reason=unavailable_reason,
    )
    return (
        {
            "container": container,
            "streams": [facts for _, facts in stream_pairs],
            "programs": programs,
            "stream_selection": {
                "program_membership_basis": "FFPROBE_SHOW_PROGRAMS",
                "primary_video": {
                    "basis": (
                        "NON_ATTACHED_VIDEO_DEFAULT_DISPOSITION_THEN_LOWEST_STREAM_INDEX"
                    ),
                    "candidate_stream_indices": sorted(
                        pair[0]["index"] for pair in video_candidates
                    ),
                    "selected_stream_index": primary_video_index,
                    "program_ids": list(video_program_ids),
                },
                "primary_audio": {
                    "basis": audio_selection_basis,
                    "candidate_stream_indices": sorted(
                        pair[0]["index"] for pair in scoped_audio_candidates
                    ),
                    "selected_stream_index": (
                        primary_audio_raw["index"] if primary_audio_raw is not None else None
                    ),
                },
            },
            "primary_video_stream_index": primary_video_index,
            "primary_audio_stream_index": (
                primary_audio_raw["index"] if primary_audio_raw is not None else None
            ),
            "av_duration_delta": duration_delta,
            "primary_video_packet_timestamps": None,
        },
        primary_video_index,
    )


def _normalize_programs(
    programs_raw: Sequence[Any],
    known_stream_indices: set[int],
) -> tuple[list[dict[str, Any]], dict[int, tuple[int, ...]]]:
    programs: list[dict[str, Any]] = []
    seen_program_ids: set[int] = set()
    membership: dict[int, list[int]] = {}
    for position, raw in enumerate(programs_raw):
        if not isinstance(raw, Mapping):
            raise ProbeError("ffprobe program entry was not an object")
        program_id = raw.get("program_id")
        if type(program_id) is not int or program_id < 0:
            raise ProbeError("ffprobe program_id was not a non-negative integer")
        if program_id in seen_program_ids:
            raise ProbeError("ffprobe returned duplicate program ids")
        seen_program_ids.add(program_id)
        program_streams = raw.get("streams")
        if not isinstance(program_streams, list):
            raise ProbeError("ffprobe program did not contain a streams array")
        if len(program_streams) > _MAX_STREAMS_PER_SOURCE:
            raise ProbeError(
                f"ffprobe program[{position}] contained too many stream memberships"
            )
        member_indices: list[int] = []
        seen_members: set[int] = set()
        for stream in program_streams:
            if not isinstance(stream, Mapping) or type(stream.get("index")) is not int:
                raise ProbeError("ffprobe program stream membership lacked an integer index")
            stream_index = stream["index"]
            if stream_index not in known_stream_indices:
                raise ProbeError("ffprobe program referenced an unknown stream index")
            if stream_index in seen_members:
                raise ProbeError("ffprobe program repeated a stream membership")
            seen_members.add(stream_index)
            member_indices.append(stream_index)
            membership.setdefault(stream_index, []).append(program_id)

        facts = {field: raw.get(field) for field in _PROGRAM_FACT_FIELDS}
        _require_json_scalars(facts, f"program[{program_id}]")
        facts["stream_indices"] = sorted(member_indices)
        programs.append(facts)

    programs.sort(key=lambda program: program["program_id"])
    normalized_membership = {
        stream_index: tuple(sorted(program_ids))
        for stream_index, program_ids in membership.items()
    }
    return programs, normalized_membership


def _primary_stream_sort_key(
    pair: tuple[Mapping[str, Any], Mapping[str, Any]],
) -> tuple[int, int]:
    raw = pair[0]
    is_default = pair[1]["disposition"]["default"] == 1
    return (0 if is_default else 1, raw["index"])


def _normalize_disposition(disposition: Any, path: str) -> dict[str, int]:
    if not isinstance(disposition, Mapping):
        raise ProbeError(f"{path} was not an object")
    if len(disposition) > 64:
        raise ProbeError(f"{path} contained too many flags")
    for key, value in disposition.items():
        if not isinstance(key, str) or not key or len(key) > 128:
            raise ProbeError(f"{path} contained a malformed flag name")
        if type(value) is not int or value not in (0, 1):
            raise ProbeError(f"{path}.{key} must be integer 0 or 1")
    for required in ("default", "attached_pic"):
        if required not in disposition:
            raise ProbeError(f"{path} omitted required flag {required}")
    return {
        "default": disposition["default"],
        "attached_pic": disposition["attached_pic"],
    }


def _rotation_degrees(stream: Mapping[str, Any]) -> int | float | None:
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        for entry in side_data:
            if isinstance(entry, Mapping):
                rotation = entry.get("rotation")
                if isinstance(rotation, (int, float)) and not isinstance(rotation, bool):
                    return rotation
    tags = stream.get("tags")
    if isinstance(tags, Mapping):
        rotation = tags.get("rotate")
        if isinstance(rotation, str) and _INTEGER_RE.fullmatch(rotation):
            if len(rotation) > _MAX_PROBE_SCALAR_CHARS:
                raise ProbeError("stream rotation tag exceeded the ffprobe scalar limit")
            return int(rotation)
    return None


def _require_json_scalars(values: Mapping[str, Any], path: str) -> None:
    for key, value in values.items():
        if isinstance(value, Mapping):
            _require_json_scalars(value, f"{path}.{key}")
        elif value is not None:
            if not isinstance(value, (str, int, float, bool)):
                raise ProbeError(f"{path}.{key} was not a scalar ffprobe fact")
            if isinstance(value, str) and len(value) > _MAX_PROBE_SCALAR_CHARS:
                raise ProbeError(
                    f"{path}.{key} exceeded the {_MAX_PROBE_SCALAR_CHARS}-character "
                    "ffprobe scalar limit"
                )
            if isinstance(value, float) and not math.isfinite(value):
                raise ProbeError(f"{path}.{key} was not a finite ffprobe fact")


def _duration_delta(
    video_stream: Mapping[str, Any],
    audio_stream: Mapping[str, Any] | None,
    *,
    unavailable_reason: str | None = None,
) -> dict[str, Any]:
    video_duration = _stream_duration(video_stream)
    audio_duration = _stream_duration(audio_stream) if audio_stream is not None else None
    if unavailable_reason is not None:
        reason = unavailable_reason
    elif audio_stream is None:
        reason = "NO_PRIMARY_AUDIO_STREAM"
    elif video_duration is None:
        reason = "VIDEO_DURATION_UNAVAILABLE"
    elif audio_duration is None:
        reason = "AUDIO_DURATION_UNAVAILABLE"
    else:
        reason = None

    if reason is not None:
        return {
            "available": False,
            "calculation_basis": "exact arithmetic over ffprobe-reported stream durations",
            "reason": reason,
            "video_duration": _duration_dict(video_duration),
            "audio_duration": _duration_dict(audio_duration),
            "audio_minus_video_seconds": None,
            "absolute_delta_seconds": None,
        }

    assert video_duration is not None and audio_duration is not None
    delta = audio_duration[0] - video_duration[0]
    _require_fraction_bits(delta, _MAX_RESULT_FRACTION_BITS, "A/V duration delta")
    return {
        "available": True,
        "calculation_basis": "exact arithmetic over ffprobe-reported stream durations",
        "reason": None,
        "video_duration": _duration_dict(video_duration),
        "audio_duration": _duration_dict(audio_duration),
        "audio_minus_video_seconds": _fraction_dict(delta),
        "absolute_delta_seconds": _fraction_dict(abs(delta)),
    }


def _stream_duration(stream: Mapping[str, Any] | None) -> tuple[Fraction, str] | None:
    if stream is None:
        return None
    raw_duration = stream.get("duration")
    if isinstance(raw_duration, str) and raw_duration not in ("", "N/A"):
        return _bounded_decimal_fraction(raw_duration), "stream.duration"

    duration_ts = stream.get("duration_ts")
    time_base = stream.get("time_base")
    if type(duration_ts) is int and isinstance(time_base, str):
        _require_bounded_int(
            duration_ts,
            _MAX_INPUT_FRACTION_BITS,
            "stream.duration_ts",
        )
        time_base_fraction = _parse_fraction(time_base, "stream.time_base")
        duration = duration_ts * time_base_fraction
        if duration < 0:
            raise ProbeError("ffprobe duration_ts produced a negative stream duration")
        _require_fraction_bits(
            duration,
            _MAX_RESULT_FRACTION_BITS,
            "stream duration",
        )
        return duration, "stream.duration_ts*stream.time_base"
    return None


def _bounded_decimal_fraction(raw_duration: str) -> Fraction:
    if len(raw_duration) > _MAX_DURATION_DECIMAL_CHARS:
        raise ProbeError("ffprobe stream duration exceeded the decimal text limit")
    try:
        decimal_duration = Decimal(raw_duration)
    except InvalidOperation as exc:
        raise ProbeError("ffprobe stream duration was not a decimal number") from exc
    if not decimal_duration.is_finite() or decimal_duration < 0:
        raise ProbeError("ffprobe stream duration was not a finite non-negative number")
    decimal_tuple = decimal_duration.as_tuple()
    exponent = decimal_tuple.exponent
    if type(exponent) is not int or abs(exponent) > _MAX_DECIMAL_EXPONENT_ABS:
        raise ProbeError("ffprobe stream duration exponent exceeded the exact-arithmetic limit")
    if len(decimal_tuple.digits) > _MAX_DECIMAL_SIGNIFICANT_DIGITS:
        raise ProbeError(
            "ffprobe stream duration significant digits exceeded the exact-arithmetic limit"
        )
    adjusted = decimal_duration.adjusted() if decimal_duration else 0
    if abs(adjusted) > _MAX_DECIMAL_ADJUSTED_ABS:
        raise ProbeError("ffprobe stream duration magnitude exceeded the exact-arithmetic limit")
    duration = Fraction(decimal_duration)
    _require_fraction_bits(
        duration,
        _MAX_INPUT_FRACTION_BITS,
        "ffprobe stream duration",
    )
    return duration


def _duration_dict(duration: tuple[Fraction, str] | None) -> dict[str, Any] | None:
    if duration is None:
        return None
    value, source = duration
    result = _fraction_dict(value)
    result["source"] = source
    return result


def _parse_fraction(value: str, field_name: str) -> Fraction:
    if len(value) > _MAX_DURATION_DECIMAL_CHARS:
        raise ProbeError(f"ffprobe {field_name} exceeded the rational text limit")
    parts = value.split("/")
    if len(parts) != 2 or not all(_INTEGER_RE.fullmatch(part) for part in parts):
        raise ProbeError(f"ffprobe {field_name} was not an integer fraction")
    if any(
        len(part.lstrip("+-").lstrip("0") or "0")
        > _MAX_DECIMAL_SIGNIFICANT_DIGITS
        for part in parts
    ):
        raise ProbeError(f"ffprobe {field_name} component magnitude exceeded its limit")
    numerator, denominator = (int(part) for part in parts)
    if denominator == 0:
        raise ProbeError(f"ffprobe {field_name} had a zero denominator")
    result = Fraction(numerator, denominator)
    _require_fraction_bits(result, _MAX_INPUT_FRACTION_BITS, field_name)
    return result


def _fraction_dict(value: Fraction) -> dict[str, str | None]:
    _require_fraction_bits(value, _MAX_RESULT_FRACTION_BITS, "duration result")
    return {
        "exact_fraction": f"{value.numerator}/{value.denominator}",
        "exact_decimal": _terminating_decimal(value),
    }


def _terminating_decimal(value: Fraction) -> str | None:
    _require_fraction_bits(value, _MAX_RESULT_FRACTION_BITS, "terminating decimal input")
    denominator = value.denominator
    twos = 0
    fives = 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    if denominator != 1:
        return None

    scale = max(twos, fives)
    if scale > _MAX_EXACT_DECIMAL_SCALE:
        raise ProbeError("terminating decimal scale exceeded the exact-formatting limit")
    scaled_numerator = abs(value.numerator)
    scaled_numerator *= 2 ** (scale - twos)
    scaled_numerator *= 5 ** (scale - fives)
    if scale == 0:
        digits = str(scaled_numerator)
    else:
        padded = str(scaled_numerator).rjust(scale + 1, "0")
        digits = f"{padded[:-scale]}.{padded[-scale:]}"
    if value.numerator < 0 and scaled_numerator:
        return "-" + digits
    return digits


def _require_bounded_int(value: int, max_bits: int, field_name: str) -> None:
    if type(value) is not int or abs(value).bit_length() > max_bits:
        raise ProbeError(f"{field_name} exceeded the {max_bits}-bit integer limit")


def _require_fraction_bits(value: Fraction, max_bits: int, field_name: str) -> None:
    if (
        abs(value.numerator).bit_length() > max_bits
        or value.denominator.bit_length() > max_bits
    ):
        raise ProbeError(f"{field_name} exceeded the {max_bits}-bit rational limit")


def _scan_packet_timestamps(lines: Iterable[str], stream_index: int) -> dict[str, Any]:
    pts = _TimestampAccumulator()
    dts = _TimestampAccumulator()
    packet_count = 0
    iterator = iter(lines)
    try:
        for packet_index, line in enumerate(iterator):
            parsed = _parse_packet_line(line)
            pts.observe(packet_index, parsed.get("pts"))
            dts.observe(packet_index, parsed.get("dts"))
            packet_count += 1
    except ProbeError:
        raise
    except Exception as exc:
        raise ProbeError(f"packet stream failed before completion: {_safe_error(exc)}") from exc
    finally:
        close = getattr(iterator, "close", None)
        if callable(close):
            close()
    return {
        "complete": True,
        "basis": "demuxed packet metadata only; media was not decoded",
        "primary_video_stream_index": stream_index,
        "timestamp_unit": "raw stream time_base units",
        "comparison_rule": (
            "each present value is compared with the previous present value "
            "in ffprobe demux output order"
        ),
        "interpretation": {
            "pts": (
                "PTS may move backward in demux output order during normal codec/B-frame "
                "reordering; this is not evidence of capture-clock reversal"
            ),
            "dts": (
                "DTS monotonicity is a demux/decode-order fact only and is not proof of "
                "capture health, frame completeness, or capture timestamp integrity"
            ),
            "equal_values": (
                "equal timestamps do not establish duplicate packets, frames, or content"
            ),
        },
        "packet_index_origin": 0,
        "packet_count": packet_count,
        "pts": pts.to_dict(),
        "dts": dts.to_dict(),
    }


class _TimestampAccumulator:
    def __init__(self) -> None:
        self.present_count = 0
        self.missing_count = 0
        self.missing_range_count = 0
        self.duplicate_count = 0
        self.regression_count = 0
        self.missing_ranges: list[dict[str, int]] = []
        self.duplicates: list[dict[str, int]] = []
        self.regressions: list[dict[str, int]] = []
        self._previous_value: int | None = None
        self._previous_packet_index: int | None = None
        self._in_missing_range = False
        self._active_missing_range_is_stored = False

    def observe(self, packet_index: int, value: int | None) -> None:
        if value is None:
            self.missing_count += 1
            if self._in_missing_range and self._active_missing_range_is_stored:
                self.missing_ranges[-1]["end_packet_index"] = packet_index
            elif not self._in_missing_range:
                self.missing_range_count += 1
                self._active_missing_range_is_stored = (
                    len(self.missing_ranges) < _MAX_TIMESTAMP_DETAILS_PER_KIND
                )
                if self._active_missing_range_is_stored:
                    self.missing_ranges.append(
                        {
                            "start_packet_index": packet_index,
                            "end_packet_index": packet_index,
                        }
                    )
            self._in_missing_range = True
            return
        self._in_missing_range = False
        self._active_missing_range_is_stored = False
        self.present_count += 1
        if self._previous_value is not None and self._previous_packet_index is not None:
            if value == self._previous_value:
                self.duplicate_count += 1
                if len(self.duplicates) < _MAX_TIMESTAMP_DETAILS_PER_KIND:
                    self.duplicates.append(
                        {
                            "packet_index": packet_index,
                            "previous_present_packet_index": self._previous_packet_index,
                            "timestamp": value,
                        }
                    )
            elif value < self._previous_value:
                self.regression_count += 1
                if len(self.regressions) < _MAX_TIMESTAMP_DETAILS_PER_KIND:
                    self.regressions.append(
                        {
                            "packet_index": packet_index,
                            "previous_present_packet_index": self._previous_packet_index,
                            "previous_timestamp": self._previous_value,
                            "timestamp": value,
                        }
                    )
        self._previous_value = value
        self._previous_packet_index = packet_index

    def to_dict(self) -> dict[str, Any]:
        missing_details_truncated = self.missing_range_count > len(self.missing_ranges)
        equal_details_truncated = self.duplicate_count > len(self.duplicates)
        demux_regression_details_truncated = self.regression_count > len(self.regressions)
        return {
            "present_count": self.present_count,
            "missing_count": self.missing_count,
            "missing_range_count": self.missing_range_count,
            "missing_packet_ranges": self.missing_ranges,
            "missing_details_truncated": missing_details_truncated,
            "equal_previous_in_demux_order_count": self.duplicate_count,
            "equal_previous_in_demux_order": self.duplicates,
            "equal_previous_details_truncated": equal_details_truncated,
            "demux_order_regression_count": self.regression_count,
            "demux_order_regressions": self.regressions,
            "demux_order_regression_details_truncated": (
                demux_regression_details_truncated
            ),
            "details_truncated": (
                missing_details_truncated
                or equal_details_truncated
                or demux_regression_details_truncated
            ),
        }


def _parse_packet_line(line: str) -> dict[str, int | None]:
    if not isinstance(line, str) or not line:
        raise ProbeError("ffprobe emitted an empty packet row")
    fields: dict[str, str] = {}
    for component in line.split("|"):
        if "=" not in component:
            raise ProbeError("ffprobe packet row was not compact key=value data")
        key, value = component.split("=", 1)
        if key not in {"pts", "dts"}:
            raise ProbeError(f"ffprobe packet row contained unexpected field {key!r}")
        if key in fields:
            raise ProbeError(f"ffprobe packet row repeated field {key!r}")
        fields[key] = value
    return {
        "pts": _parse_timestamp(fields.get("pts"), "pts"),
        "dts": _parse_timestamp(fields.get("dts"), "dts"),
    }


def _parse_timestamp(value: str | None, field_name: str) -> int | None:
    if value is None or value in ("", "N/A"):
        return None
    if not _INTEGER_RE.fullmatch(value):
        raise ProbeError(f"ffprobe packet {field_name} was not an integer or N/A")
    return int(value)


def _validate_reference(value: str | None, field_name: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    if value != value.strip():
        raise ValueError(f"{field_name} cannot have leading or trailing whitespace")
    if len(value) > _MAX_REFERENCE_CHARS:
        raise ValueError(f"{field_name} exceeds {_MAX_REFERENCE_CHARS} characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f"{field_name} cannot contain control characters")


def _is_positive_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def _error_dict(code: str, stage: str, error: Exception) -> dict[str, str]:
    return {
        "code": code,
        "stage": stage,
        "message": _safe_error(error),
    }


def _safe_error(error: BaseException) -> str:
    message = " ".join(str(error).split())
    return (message or error.__class__.__name__)[:_MAX_ERROR_CHARS]


def _safe_process_error(raw: bytes) -> str:
    decoded = raw.decode("utf-8", errors="replace")
    cleaned = " ".join(decoded.split())
    return (cleaned or "ffprobe returned a non-zero exit status")[:_MAX_ERROR_CHARS]


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    """Return the canonical UTF-8 JSON representation used for report hashing."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _report_item_budget() -> int:
    reserve = min(128 * 1024, _MAX_REPORT_CANONICAL_JSON_BYTES // 4)
    return max(0, _MAX_REPORT_CANONICAL_JSON_BYTES - reserve)


def _enforce_item_size(item: dict[str, Any]) -> None:
    if len(canonical_json_bytes(item)) <= _MAX_ITEM_CANONICAL_JSON_BYTES:
        return
    _collapse_probe_for_size(
        item,
        "ITEM_REPORT_SIZE_EXCEEDED",
        "normalized item exceeded its canonical JSON size limit; probe facts were discarded",
    )
    if len(canonical_json_bytes(item)) > _MAX_ITEM_CANONICAL_JSON_BYTES:
        raise ValueError("minimal quarantined item exceeded its canonical JSON size limit")


def _collapse_probe_for_size(item: dict[str, Any], code: str, message: str) -> None:
    item["probe"] = None
    item["technical_preflight_complete"] = False
    if not any(error.get("code") == code for error in item["errors"]):
        item["errors"].append(
            {
                "code": code,
                "stage": "report_size",
                "message": message,
            }
        )


def _finalize_bounded_report(payload: dict[str, Any]) -> dict[str, Any]:
    report = _with_report_sha256(payload)
    if len(canonical_json_bytes(report)) <= _MAX_REPORT_CANONICAL_JSON_BYTES:
        return report

    for item in payload["items"]:
        if item["probe"] is not None:
            _collapse_probe_for_size(
                item,
                "TOTAL_REPORT_SIZE_EXCEEDED",
                "total canonical JSON size limit was exceeded; probe facts were discarded",
            )
    payload["technical_preflight_complete"] = False
    report = _with_report_sha256(payload)
    if len(canonical_json_bytes(report)) > _MAX_REPORT_CANONICAL_JSON_BYTES:
        raise ValueError("minimal quarantined report exceeded its canonical JSON size limit")
    return report


def _with_report_sha256(payload: Mapping[str, Any]) -> dict[str, Any]:
    report = dict(payload)
    report["report_sha256"] = hashlib.sha256(canonical_json_bytes(payload)).hexdigest()
    return report


def main(
    argv: Sequence[str] | None = None,
    *,
    probe_backend: ProbeBackend | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", type=Path, help="local media file(s) to inspect")
    parser.add_argument(
        "--ffprobe",
        default="ffprobe",
        help="ffprobe executable name or path (used without a shell)",
    )
    parser.add_argument(
        "--rights-claim",
        choices=[claim.value for claim in UnverifiedRightsClaim],
        default=UnverifiedRightsClaim.NO_CLAIM.value,
        help="explicit unverified rights claim for one source; defaults to NO_CLAIM",
    )
    parser.add_argument(
        "--rights-ref",
        help="opaque evidence reference required with an explicit rights claim",
    )
    parser.add_argument(
        "--provenance-ref",
        help="opaque provenance reference for a single source; not opened or verified",
    )
    parser.add_argument(
        "--max-source-bytes",
        type=int,
        default=_DEFAULT_MAX_SOURCE_BYTES,
        help="maximum accepted initial logical byte count per source",
    )
    parser.add_argument(
        "--hash-timeout-seconds",
        type=float,
        default=_DEFAULT_HASH_TIMEOUT_SECONDS,
        help="wall-clock deadline for hashing and local snapshot staging",
    )
    args = parser.parse_args(argv)

    try:
        context = ExplicitSourceContext(
            rights_claim=UnverifiedRightsClaim(args.rights_claim),
            rights_ref=args.rights_ref,
            provenance_ref=args.provenance_ref,
        )
        backend = probe_backend or SubprocessProbeBackend(args.ffprobe)
        report = MediaPreflight(
            backend,
            max_source_bytes=args.max_source_bytes,
            hash_timeout_seconds=args.hash_timeout_seconds,
        ).inspect_sources(
            args.sources,
            explicit_context=context,
        )
    except ValueError as exc:
        parser.error(str(exc))

    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    return 0 if report["technical_preflight_complete"] else 2


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--_snapshot-worker":
        raise SystemExit(_snapshot_worker_main(sys.argv[2:]))
    raise SystemExit(main())
