"""Build deterministic quarantine manifests from untrusted recovery leads.

Recovery intake is deliberately weaker than media preflight.  It content-pins
and parses one bounded *inventory document*, observes path metadata beneath
explicit operator-approved roots, and orders candidates for human review.  It
never opens, hashes, probes, decodes, copies, or accepts referenced media.
"""

from __future__ import annotations

import argparse
import base64
import csv
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum
import errno
import hashlib
import io
import json
import math
import os
import re
import secrets
import selectors
import signal
import stat as stat_module
import subprocess
import sys
import time
import unicodedata
from typing import Any, Mapping, Protocol, Sequence, TextIO


SCHEMA_VERSION = "1.0"
MANIFEST_DOMAIN = "multicourt-vision-scoring:recovery-candidate-manifest:v1"
LOCATOR_DOMAIN = "multicourt-vision-scoring:recovery-locator:v1"
RANKING_POLICY_ID = "metadata-review-priority-v1"
SEALED_ASSURANCE_LEVEL = "SEALED_BOUNDED_PRODUCTION_OBSERVER"
TEST_ASSURANCE_LEVEL = "TEST_INJECTED_OBSERVER_NO_PRODUCTION_CLAIMS"
SEALED_ASSURANCE_CLAIMS = (
    "IN_SCOPE_PRESENT_PINNED_MEDIA_BYTES_NOT_OPENED_OR_HASHED",
    "OFFLINE_ROOTS_VERIFIED_ABSENT",
    "OUT_OF_SCOPE_LOCATOR_IDENTITY_UNVERIFIED",
    "DIRECTORY_COMPONENT_SYMLINKS_NOT_FOLLOWED",
    "FILESYSTEM_OBSERVATION_WALL_CLOCK_BOUNDED",
    "PRESENT_ROOT_DEVICE_INODE_PINS_VERIFIED",
)

MAX_INPUT_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_INPUT_RECORDS = 50_000
MAX_REJECTED_RECORDS = 5_000
MAX_CSV_FIELD_BYTES = 64 * 1024
MAX_PATH_CHARS = 4_096
MAX_FILENAME_CHARS = 512
MAX_EXTENSION_CHARS = 16
MAX_CODEC_CHARS = 64
MAX_REPORTED_ERROR_CHARS = 4_096
MAX_CANDIDATE_ISSUES = 16
MAX_CANDIDATE_CANONICAL_BYTES = 8 * 1024
MAX_MANIFEST_CANONICAL_BYTES = 64 * 1024 * 1024
MAX_MEDIA_SIZE_BYTES = 1 << 40
MAX_DURATION_SECONDS = Decimal("31536000")
DEFAULT_OBSERVATION_TIMEOUT_SECONDS = 120.0
MAX_OBSERVATION_TIMEOUT_SECONDS = 600.0
MAX_OBSERVER_REQUEST_BYTES = 32 * 1024 * 1024
MAX_OBSERVER_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_OBSERVER_STDERR_BYTES = 64 * 1024
MAX_INPUT_WORKER_RESPONSE_BYTES = 24 * 1024 * 1024
MAX_INPUT_WORKER_STDERR_BYTES = 64 * 1024
MAX_JSON_DEPTH = 64
MAX_JSON_NODES = 2_000_000
MAX_JSON_CONTAINER_ITEMS = 50_000
MAX_TOTAL_LOCATOR_UTF8_BYTES = 12 * 1024 * 1024
MAX_RETAINED_CANDIDATE_BYTES = 56 * 1024 * 1024
MAX_REJECTED_CANONICAL_BYTES = 4 * 1024 * 1024
MAX_ESTIMATED_PEAK_BYTES = 256 * 1024 * 1024
MAX_PATH_COMPONENTS = 256

_READ_CHUNK_BYTES = 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_UNSIGNED_INTEGER_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$")
_CODEC_RE = re.compile(r"^[A-Za-z0-9._+\-]{1,64}$")
_DARWIN_SF_DATALESS = 0x40000000

_PROBE_CSV_HEADER = (
    "path",
    "filename",
    "parent",
    "extension",
    "size_bytes",
    "duration",
    "width",
    "height",
    "video_codec",
    "error",
)

_POSITIVE_NAME_LEADS = (
    "3rd coast",
    "avp",
    "beach volleyball",
    "big money",
    "final",
    "fivb",
    "fuds",
    "match",
    "ozark",
    "qualifier",
    "semifinal",
    "semi final",
    "shaka",
    "tournament",
    "volleyball",
    "vs",
)
_NEGATIVE_NAME_LEADS = (
    "clip",
    "clips",
    "compilation",
    "export",
    "highlight",
    "highlights",
    "instagram",
    "promo",
    "proxy",
    "reel",
    "reels",
    "render",
    "short",
    "shorts",
    "slo mo",
    "slow motion",
    "slowmo",
    "social",
    "tiktok",
    "vertical",
)


class RecoveryIntakeError(ValueError):
    """A fail-closed intake error with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _RecordRejected(ValueError):
    def __init__(self, code: str, field: str) -> None:
        super().__init__(f"{code}:{field}")
        self.code = code
        self.field = field


class RootAvailability(str, Enum):
    PRESENT_DIRECTORY = "PRESENT_DIRECTORY"
    OFFLINE_DECLARED_AND_ABSENT = "OFFLINE_DECLARED_AND_ABSENT"


class CandidateAvailability(str, Enum):
    RESIDENT_REGULAR_FILE = "RESIDENT_REGULAR_FILE"
    REFERENCED_OFFLINE = "REFERENCED_OFFLINE"
    OFFLINE_PLACEHOLDER = "OFFLINE_PLACEHOLDER"
    ABSENT_AT_AVAILABLE_ROOT = "ABSENT_AT_AVAILABLE_ROOT"
    OUT_OF_SCOPE_UNOBSERVED = "OUT_OF_SCOPE_UNOBSERVED"
    UNSUPPORTED_LOCAL_ENTRY = "UNSUPPORTED_LOCAL_ENTRY"
    FILESYSTEM_OBSERVATION_FAILED = "FILESYSTEM_OBSERVATION_FAILED"


@dataclass(frozen=True, slots=True)
class PresentRootPin:
    """Caller-pinned identity for one currently resident allowed root."""

    path: str
    device: int
    inode: int

    def __post_init__(self) -> None:
        if type(self.path) is not str or not self.path:
            raise ValueError("root pin path must be a non-empty string")
        if type(self.device) is not int or self.device < 0:
            raise ValueError("root pin device must be a non-negative integer")
        if type(self.inode) is not int or self.inode < 0:
            raise ValueError("root pin inode must be a non-negative integer")

    def to_policy_dict(self) -> dict[str, Any]:
        return {
            "expected_device": self.device,
            "expected_inode": self.inode,
            "mode": "PRESENT_PINNED",
            "path": self.path,
        }


@dataclass(frozen=True, slots=True)
class FileMetadata:
    device: int
    inode: int
    mode: int
    link_count: int
    size_bytes: int
    modified_ns: int
    changed_ns: int
    flags: int = 0

    @classmethod
    def from_stat(cls, value: os.stat_result) -> FileMetadata:
        return cls(
            device=value.st_dev,
            inode=value.st_ino,
            mode=value.st_mode,
            link_count=value.st_nlink,
            size_bytes=value.st_size,
            modified_ns=value.st_mtime_ns,
            changed_ns=value.st_ctime_ns,
            flags=getattr(value, "st_flags", 0),
        )

    def __post_init__(self) -> None:
        for field_name in (
            "device",
            "inode",
            "mode",
            "link_count",
            "size_bytes",
            "modified_ns",
            "changed_ns",
            "flags",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")

    def to_dict(self) -> dict[str, int]:
        return {
            "changed_ns": self.changed_ns,
            "device": self.device,
            "flags": self.flags,
            "inode": self.inode,
            "link_count": self.link_count,
            "mode": self.mode,
            "modified_ns": self.modified_ns,
            "size_bytes": self.size_bytes,
        }


@dataclass(frozen=True, slots=True)
class _PinnedDocument:
    data: bytes
    sha256: str
    metadata: FileMetadata


@dataclass(frozen=True, slots=True)
class _EmitPolicy:
    input_path: str
    offline_roots: tuple[str, ...]
    candidate_paths: tuple[str, ...]
    present_root_identities: frozenset[tuple[int, int]]
    assurance_level: str


@dataclass(frozen=True, slots=True)
class RootObservation:
    path: str
    status: RootAvailability
    metadata: FileMetadata | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.status, RootAvailability):
            raise ValueError("status must be a RootAvailability")
        if self.status is RootAvailability.PRESENT_DIRECTORY:
            if self.metadata is None or not stat_module.S_ISDIR(self.metadata.mode):
                raise ValueError("present root requires directory metadata")
        elif self.metadata is not None:
            raise ValueError("offline root cannot carry filesystem metadata")

    def to_dict(self) -> dict[str, Any]:
        return {
            "filesystem_metadata": (
                self.metadata.to_dict() if self.metadata is not None else None
            ),
            "path": self.path,
            "status": self.status.value,
        }


@dataclass(frozen=True, slots=True)
class PathObservation:
    path: str
    root: str
    status: CandidateAvailability
    metadata: FileMetadata | None = None
    reason_code: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.status, CandidateAvailability):
            raise ValueError("status must be a CandidateAvailability")
        if self.status is CandidateAvailability.RESIDENT_REGULAR_FILE:
            if self.metadata is None or not stat_module.S_ISREG(self.metadata.mode):
                raise ValueError("resident source requires regular-file metadata")
            if self.reason_code is not None:
                raise ValueError("resident source cannot carry an error reason")
        elif self.metadata is not None:
            raise ValueError("non-resident observation cannot carry filesystem metadata")
        _validate_reason_code(self.reason_code)


@dataclass(frozen=True, slots=True)
class ObservationBatch:
    roots: tuple[RootObservation, ...]
    paths: tuple[PathObservation, ...]


class FilesystemObserver(Protocol):
    """Injectable boundary for metadata-only filesystem observations."""

    def observe(
        self,
        *,
        paths_by_root: Mapping[str, tuple[str, ...]],
        present_root_pins: Mapping[str, PresentRootPin],
        offline_roots: frozenset[str],
        deadline_seconds: float,
    ) -> ObservationBatch:
        """Observe roots and final entries without opening final media files."""


class DescriptorFilesystemObserver:
    """Observe candidates through no-follow, descriptor-relative directory walks."""

    def observe(
        self,
        *,
        paths_by_root: Mapping[str, tuple[str, ...]],
        present_root_pins: Mapping[str, PresentRootPin],
        offline_roots: frozenset[str],
        deadline_seconds: float,
    ) -> ObservationBatch:
        if not _positive_finite(deadline_seconds):
            raise RecoveryIntakeError(
                "INVALID_OBSERVATION_DEADLINE",
                "filesystem observation deadline must be positive and finite",
            )
        if deadline_seconds > MAX_OBSERVATION_TIMEOUT_SECONDS:
            raise RecoveryIntakeError(
                "INVALID_OBSERVATION_DEADLINE",
                "filesystem observation deadline exceeds the hard ceiling",
            )
        if set(paths_by_root) != set(present_root_pins) | set(offline_roots):
            raise RecoveryIntakeError(
                "INVALID_ROOT_POLICY",
                "observer roots must exactly match pinned-present and explicit-offline roots",
            )
        if set(present_root_pins) & set(offline_roots):
            raise RecoveryIntakeError(
                "INVALID_ROOT_POLICY", "a root cannot be both present and offline"
            )
        total_paths = sum(len(paths) for paths in paths_by_root.values())
        if total_paths > MAX_INPUT_RECORDS:
            raise RecoveryIntakeError(
                "TOO_MANY_OBSERVATIONS",
                "filesystem observation count exceeds the hard ceiling",
            )

        deadline = time.monotonic() + deadline_seconds
        root_results: list[RootObservation] = []
        path_results: list[PathObservation] = []
        for root in sorted(paths_by_root):
            _check_deadline(deadline)
            root_fd = _try_open_absolute_directory(root, deadline)
            if root in offline_roots:
                if root_fd is not None:
                    os.close(root_fd)
                    raise RecoveryIntakeError(
                        "DECLARED_OFFLINE_ROOT_PRESENT",
                        f"declared offline root is present: {root}",
                    )
                root_results.append(
                    RootObservation(
                        path=root,
                        status=RootAvailability.OFFLINE_DECLARED_AND_ABSENT,
                    )
                )
                path_results.extend(
                    PathObservation(
                        path=path,
                        root=root,
                        status=CandidateAvailability.REFERENCED_OFFLINE,
                        reason_code="DECLARED_OFFLINE_ROOT_ABSENT",
                    )
                    for path in paths_by_root[root]
                )
                continue

            if root_fd is None:
                raise RecoveryIntakeError(
                    "ALLOWED_ROOT_UNAVAILABLE",
                    f"allowed root is unavailable and was not declared offline: {root}",
                )
            try:
                root_stat = os.fstat(root_fd)
                root_pin = present_root_pins.get(root)
                if root_pin is None or (
                    root_stat.st_dev != root_pin.device
                    or root_stat.st_ino != root_pin.inode
                ):
                    raise RecoveryIntakeError(
                        "ROOT_IDENTITY_MISMATCH",
                        f"present root did not match its pinned device/inode: {root}",
                    )
                root_results.append(
                    RootObservation(
                        path=root,
                        status=RootAvailability.PRESENT_DIRECTORY,
                        metadata=FileMetadata.from_stat(root_stat),
                    )
                )
                for path in paths_by_root[root]:
                    _check_deadline(deadline)
                    path_results.append(
                        _observe_relative_path(
                            root_fd,
                            root=root,
                            path=path,
                            deadline=deadline,
                        )
                    )
            finally:
                os.close(root_fd)

        return ObservationBatch(
            roots=tuple(root_results),
            paths=tuple(path_results),
        )


class BoundedFilesystemObserver:
    """Run descriptor observation in a killable subprocess with bounded IPC."""

    def observe(
        self,
        *,
        paths_by_root: Mapping[str, tuple[str, ...]],
        present_root_pins: Mapping[str, PresentRootPin],
        offline_roots: frozenset[str],
        deadline_seconds: float,
    ) -> ObservationBatch:
        if not _positive_finite(deadline_seconds) or (
            deadline_seconds > MAX_OBSERVATION_TIMEOUT_SECONDS
        ):
            raise RecoveryIntakeError(
                "INVALID_OBSERVATION_DEADLINE",
                "filesystem observation deadline must be positive, finite, and bounded",
            )
        request = _observer_request_payload(
            paths_by_root=paths_by_root,
            present_root_pins=present_root_pins,
            offline_roots=offline_roots,
            deadline_seconds=deadline_seconds,
        )
        encoded_request = canonical_json_bytes(request)
        if len(encoded_request) > MAX_OBSERVER_REQUEST_BYTES:
            raise RecoveryIntakeError(
                "OBSERVER_REQUEST_TOO_LARGE",
                "canonical filesystem-observer request exceeded its hard ceiling",
            )
        command = [sys.executable, os.path.abspath(__file__), "--_observe-worker"]
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
            )
        except OSError as exc:
            raise RecoveryIntakeError(
                "OBSERVER_WORKER_START_FAILED",
                "filesystem observer worker could not start",
            ) from exc
        stdout, stderr, returncode = _stream_worker_ipc(
            process,
            input_bytes=encoded_request,
            deadline_seconds=float(deadline_seconds),
            stdout_limit=MAX_OBSERVER_RESPONSE_BYTES,
            stderr_limit=MAX_OBSERVER_STDERR_BYTES,
            timeout_code="OBSERVATION_DEADLINE_EXCEEDED",
            stdout_limit_code="OBSERVER_RESPONSE_TOO_LARGE",
            stderr_limit_code="OBSERVER_STDERR_TOO_LARGE",
        )
        if returncode != 0:
            raise RecoveryIntakeError(
                "OBSERVER_WORKER_FAILED",
                "filesystem observer worker failed closed",
            )
        return _observation_batch_from_bytes(stdout)


@dataclass(frozen=True, slots=True)
class _ParsedCandidate:
    path: str
    input_record_number: int
    prior_probe: dict[str, Any] | None
    issues: tuple[dict[str, str], ...]


@dataclass(frozen=True, slots=True)
class _ParsedInput:
    candidates: tuple[_ParsedCandidate, ...]
    rejected_records: tuple[dict[str, Any], ...]
    record_count: int


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    """Return the canonical JSON encoding used for all intake fingerprints."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _observer_request_payload(
    *,
    paths_by_root: Mapping[str, tuple[str, ...]],
    present_root_pins: Mapping[str, PresentRootPin],
    offline_roots: frozenset[str],
    deadline_seconds: float,
) -> dict[str, Any]:
    return {
        "deadline_milliseconds": _deadline_milliseconds(deadline_seconds),
        "domain": "multicourt-vision-scoring:recovery-observer-request:v1",
        "offline_roots": sorted(offline_roots),
        "paths_by_root": {
            root: list(paths_by_root[root]) for root in sorted(paths_by_root)
        },
        "present_root_pins": {
            root: {
                "device": present_root_pins[root].device,
                "inode": present_root_pins[root].inode,
            }
            for root in sorted(present_root_pins)
        },
        "schema_version": SCHEMA_VERSION,
    }


def _observer_request_size(
    *,
    paths_by_root: Mapping[str, tuple[str, ...]],
    present_root_pins: Mapping[str, PresentRootPin],
    offline_roots: frozenset[str],
    deadline_seconds: float,
) -> int:
    size = len(
        canonical_json_bytes(
            _observer_request_payload(
                paths_by_root=paths_by_root,
                present_root_pins=present_root_pins,
                offline_roots=offline_roots,
                deadline_seconds=deadline_seconds,
            )
        )
    )
    if size > MAX_OBSERVER_REQUEST_BYTES:
        raise RecoveryIntakeError(
            "OBSERVER_REQUEST_TOO_LARGE",
            "canonical filesystem-observer request exceeded its hard ceiling",
        )
    return size


def build_manifest(
    *,
    input_path: str | os.PathLike[str],
    input_kind: str,
    expected_input_sha256: str,
    present_root_pins: Sequence[PresentRootPin] = (),
    offline_roots: Sequence[str | os.PathLike[str]] = (),
    observation_timeout_seconds: float = DEFAULT_OBSERVATION_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Build a production manifest through the sealed bounded observer path."""

    return _build_manifest(
        input_path=input_path,
        input_kind=input_kind,
        expected_input_sha256=expected_input_sha256,
        present_root_pins=present_root_pins,
        offline_roots=offline_roots,
        observation_timeout_seconds=observation_timeout_seconds,
        filesystem_observer=None,
    )


def _build_manifest_for_test(
    *,
    input_path: str | os.PathLike[str],
    input_kind: str,
    expected_input_sha256: str,
    present_root_pins: Sequence[PresentRootPin] = (),
    offline_roots: Sequence[str | os.PathLike[str]] = (),
    filesystem_observer: FilesystemObserver,
    observation_timeout_seconds: float = DEFAULT_OBSERVATION_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Private test seam; its manifests carry no production observer claims."""

    if filesystem_observer is None:
        raise RecoveryIntakeError(
            "TEST_OBSERVER_REQUIRED",
            "the private test seam requires an explicit injected observer",
        )
    return _build_manifest(
        input_path=input_path,
        input_kind=input_kind,
        expected_input_sha256=expected_input_sha256,
        present_root_pins=present_root_pins,
        offline_roots=offline_roots,
        observation_timeout_seconds=observation_timeout_seconds,
        filesystem_observer=filesystem_observer,
    )


def _build_manifest(
    *,
    input_path: str | os.PathLike[str],
    input_kind: str,
    expected_input_sha256: str,
    present_root_pins: Sequence[PresentRootPin],
    offline_roots: Sequence[str | os.PathLike[str]],
    filesystem_observer: FilesystemObserver | None,
    observation_timeout_seconds: float,
) -> dict[str, Any]:
    """Shared implementation with an explicit non-public assurance selector."""

    if input_kind not in {"PRIOR_PROBE_CSV", "PATH_LIST_JSON"}:
        raise RecoveryIntakeError(
            "UNSUPPORTED_INPUT_KIND",
            "input_kind must be PRIOR_PROBE_CSV or PATH_LIST_JSON",
        )
    _require_sha256(expected_input_sha256, "expected_input_sha256")
    normalized_input_path = _normalize_absolute_path(
        os.fspath(input_path),
        field="input_path",
        require_normal_form=False,
    )
    normalized_pins, normalized_offline, normalized_allowed = _normalize_root_policy(
        present_root_pins, offline_roots
    )
    if not _positive_finite(observation_timeout_seconds) or (
        observation_timeout_seconds > MAX_OBSERVATION_TIMEOUT_SECONDS
    ):
        raise RecoveryIntakeError(
            "INVALID_OBSERVATION_DEADLINE",
            "observation timeout must be positive, finite, and at most 600 seconds",
        )

    pinned_document = _read_pinned_document(
        normalized_input_path,
        expected_sha256=expected_input_sha256,
        deadline_seconds=float(observation_timeout_seconds),
    )
    document_bytes = pinned_document.data
    actual_input_sha256 = pinned_document.sha256
    input_metadata = pinned_document.metadata
    document_size_bytes = len(document_bytes)
    if input_kind == "PRIOR_PROBE_CSV":
        parsed = _parse_probe_csv(document_bytes)
    else:
        parsed = _parse_path_list_json(document_bytes)
    del document_bytes
    del pinned_document

    _require_unique_candidates(parsed.candidates)
    if any(
        _paths_lexically_alias(candidate.path, normalized_input_path)
        for candidate in parsed.candidates
    ):
        raise RecoveryIntakeError(
            "CANDIDATE_EQUALS_INPUT_DOCUMENT",
            "a candidate locator cannot equal the pinned input document",
        )
    locator_utf8_bytes = sum(
        len(candidate.path.encode("utf-8")) for candidate in parsed.candidates
    )
    if locator_utf8_bytes > MAX_TOTAL_LOCATOR_UTF8_BYTES:
        raise RecoveryIntakeError(
            "LOCATOR_BUDGET_EXCEEDED",
            "retained candidate locator bytes exceeded the cumulative hard ceiling",
        )
    paths_by_root: dict[str, list[str]] = {
        root: [] for root in normalized_allowed
    }
    matched_roots: dict[str, str | None] = {}
    for candidate in parsed.candidates:
        root = _matching_root(candidate.path, normalized_allowed)
        matched_roots[candidate.path] = root
        if root is not None:
            paths_by_root[root].append(candidate.path)
    frozen_paths_by_root = {
        root: tuple(sorted(paths)) for root, paths in paths_by_root.items()
    }

    production_assurance = filesystem_observer is None
    effective_observer = (
        BoundedFilesystemObserver()
        if filesystem_observer is None
        else filesystem_observer
    )
    observed = effective_observer.observe(
        paths_by_root=frozen_paths_by_root,
        present_root_pins=normalized_pins,
        offline_roots=frozenset(normalized_offline),
        deadline_seconds=float(observation_timeout_seconds),
    )
    root_observations, path_observations = _validate_observation_batch(
        observed,
        paths_by_root=frozen_paths_by_root,
        present_root_pins=normalized_pins,
        offline_roots=frozenset(normalized_offline),
    )

    candidate_items: list[dict[str, Any]] = []
    candidate_canonical_bytes = 0
    for parsed_candidate in parsed.candidates:
        root = matched_roots[parsed_candidate.path]
        if root is None:
            observation = PathObservation(
                path=parsed_candidate.path,
                root="",
                status=CandidateAvailability.OUT_OF_SCOPE_UNOBSERVED,
                reason_code="PATH_OUTSIDE_ALLOWED_ROOTS",
            )
        else:
            observation = path_observations[parsed_candidate.path]
        if observation.metadata is not None and (
            observation.metadata.device == input_metadata.device
            and observation.metadata.inode == input_metadata.inode
        ):
            raise RecoveryIntakeError(
                "CANDIDATE_ALIASES_INPUT_DOCUMENT",
                "a candidate device/inode aliases the pinned input document",
            )
        root_device = None
        if root is not None and root_observations[root].metadata is not None:
            root_device = root_observations[root].metadata.device
        item = _candidate_item(
            parsed_candidate,
            observation=observation,
            matched_root=root,
            offline_roots=frozenset(normalized_offline),
            root_device=root_device,
            production_assurance=production_assurance,
        )
        item_bytes = len(canonical_json_bytes(item))
        if item_bytes > MAX_CANDIDATE_CANONICAL_BYTES:
            raise RecoveryIntakeError(
                "CANDIDATE_REPORT_TOO_LARGE",
                "one candidate exceeded the canonical item-size ceiling",
            )
        candidate_canonical_bytes += item_bytes
        if candidate_canonical_bytes > MAX_RETAINED_CANDIDATE_BYTES:
            raise RecoveryIntakeError(
                "CANDIDATE_BUDGET_EXCEEDED",
                "retained candidate JSON exceeded the cumulative hard ceiling",
            )
        candidate_items.append(item)

    candidate_items.sort(key=_candidate_sort_key)
    rejected_canonical_bytes = sum(
        len(canonical_json_bytes(record)) for record in parsed.rejected_records
    )
    if rejected_canonical_bytes > MAX_REJECTED_CANONICAL_BYTES:
        raise RecoveryIntakeError(
            "REJECTED_RECORD_BUDGET_EXCEEDED",
            "rejected-record JSON exceeded the cumulative hard ceiling",
        )
    observer_request_bytes = _observer_request_size(
        paths_by_root=frozen_paths_by_root,
        present_root_pins=normalized_pins,
        offline_roots=frozenset(normalized_offline),
        deadline_seconds=float(observation_timeout_seconds),
    )
    estimated_peak_bytes = (
        document_size_bytes * 7
        + locator_utf8_bytes * 2
        + candidate_canonical_bytes
        + rejected_canonical_bytes
        + observer_request_bytes
    )
    if estimated_peak_bytes > MAX_ESTIMATED_PEAK_BYTES:
        raise RecoveryIntakeError(
            "CUMULATIVE_RESOURCE_BUDGET_EXCEEDED",
            "estimated retained/transport peak exceeded the cumulative hard ceiling",
        )
    summary = _build_summary(candidate_items, parsed.rejected_records)
    root_policy = [
        normalized_pins[root].to_policy_dict() for root in sorted(normalized_pins)
    ] + [
        {"mode": "OFFLINE_REQUIRED_ABSENT", "path": root}
        for root in normalized_offline
    ]
    root_proofs = [
        _root_proof_dict(
            root_observations[root],
            pin=normalized_pins.get(root),
            production_assurance=production_assurance,
        )
        for root in normalized_allowed
    ]
    assurance = (
        {
            "claims": list(SEALED_ASSURANCE_CLAIMS),
            "level": SEALED_ASSURANCE_LEVEL,
        }
        if production_assurance
        else {"claims": [], "level": TEST_ASSURANCE_LEVEL}
    )
    payload: dict[str, Any] = {
        "domain": MANIFEST_DOMAIN,
        "input": {
            "document_path": normalized_input_path,
            "document_sha256": actual_input_sha256,
            "document_size_bytes": document_size_bytes,
            "expected_sha256_verified": True,
            "filesystem_identity": input_metadata.to_dict(),
            "kind": input_kind,
            "record_count": parsed.record_count,
        },
        "manifest_status": "QUARANTINED",
        "policy": {
            "assurance": assurance,
            "allowed_roots": list(normalized_allowed),
            "observation_timeout_seconds": float(observation_timeout_seconds),
            "offline_roots": list(normalized_offline),
            "ranking_policy": {
                "id": RANKING_POLICY_ID,
                "meaning": "HUMAN_METADATA_REVIEW_ORDER_ONLY",
            },
            "root_policy": root_policy,
            "root_proofs": root_proofs,
        },
        "resource_accounting": {
            "candidate_canonical_bytes": candidate_canonical_bytes,
            "candidate_count": len(candidate_items),
            "estimated_peak_bytes": estimated_peak_bytes,
            "input_document_bytes": document_size_bytes,
            "locator_utf8_bytes": locator_utf8_bytes,
            "observer_request_bytes": observer_request_bytes,
            "policy_id": "recovery-intake-resource-bounds-v1",
            "rejected_canonical_bytes": rejected_canonical_bytes,
        },
        "scope": {
            "does_not_establish": [
                "media byte identity or SHA-256",
                "current ffprobe readability or decode integrity",
                "beach-volleyball semantic content",
                "fixed-camera, full-match, or capture-tier suitability",
                "duplicate or derivative identity",
                "out-of-scope locator physical identity or namespace alias freedom",
                "rights, provenance, annotation, or training readiness",
            ],
            "establishes": (
                [
                    "exact input-document byte length, SHA-256, and filesystem identity",
                    "bounded parsing of untrusted historical metadata or explicit paths",
                    "metadata-only path availability beneath pinned allowed roots",
                    "deterministic human-review ordering under a fixed heuristic policy",
                ]
                if production_assurance
                else [
                    "test-only schema exercise with no production filesystem assurance"
                ]
            ),
        },
        "schema_version": SCHEMA_VERSION,
        "summary": summary,
        "candidates": candidate_items,
        "rejected_records": list(parsed.rejected_records),
    }
    manifest = dict(payload)
    manifest["manifest_sha256"] = hashlib.sha256(
        canonical_json_bytes(payload)
    ).hexdigest()
    if len(canonical_json_bytes(manifest)) > MAX_MANIFEST_CANONICAL_BYTES:
        raise RecoveryIntakeError(
            "MANIFEST_TOO_LARGE",
            "canonical recovery manifest exceeded the 64 MiB hard ceiling",
        )
    return manifest


def _parse_probe_csv(document: bytes) -> _ParsedInput:
    text = _decode_document(document)
    previous_limit = csv.field_size_limit()
    csv.field_size_limit(MAX_CSV_FIELD_BYTES)
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise RecoveryIntakeError("EMPTY_INPUT", "probe CSV is empty") from exc
        except csv.Error as exc:
            raise RecoveryIntakeError("MALFORMED_CSV", "probe CSV header is malformed") from exc
        if tuple(header) != _PROBE_CSV_HEADER:
            raise RecoveryIntakeError(
                "INVALID_CSV_HEADER",
                "probe CSV header must exactly match the supported ten-column schema",
            )

        candidates: list[_ParsedCandidate] = []
        rejected: list[dict[str, Any]] = []
        record_count = 0
        try:
            for row in reader:
                record_count += 1
                if record_count > MAX_INPUT_RECORDS:
                    raise RecoveryIntakeError(
                        "TOO_MANY_RECORDS",
                        "probe CSV exceeds the 50,000-record hard ceiling",
                    )
                raw_path = row[0] if row else None
                try:
                    candidates.append(_parse_probe_row(row, record_count))
                except _RecordRejected as exc:
                    rejected.append(
                        _rejected_record(
                            record_count,
                            code=exc.code,
                            field=exc.field,
                            raw_locator=raw_path,
                        )
                    )
                    if len(rejected) > MAX_REJECTED_RECORDS:
                        raise RecoveryIntakeError(
                            "TOO_MANY_REJECTED_RECORDS",
                            "probe CSV contains too many malformed records",
                        )
        except csv.Error as exc:
            raise RecoveryIntakeError("MALFORMED_CSV", "probe CSV is malformed") from exc
    finally:
        csv.field_size_limit(previous_limit)

    if record_count == 0:
        raise RecoveryIntakeError("EMPTY_INPUT", "probe CSV has no data records")
    if not candidates:
        raise RecoveryIntakeError("NO_VALID_CANDIDATES", "input has no valid candidates")
    return _ParsedInput(tuple(candidates), tuple(rejected), record_count)


def _parse_probe_row(row: Sequence[str], record_number: int) -> _ParsedCandidate:
    if len(row) != len(_PROBE_CSV_HEADER):
        raise _RecordRejected("INVALID_COLUMN_COUNT", "row")
    values = dict(zip(_PROBE_CSV_HEADER, row, strict=True))
    for field_name, value in values.items():
        try:
            encoded_length = len(value.encode("utf-8", errors="strict"))
        except UnicodeEncodeError as exc:
            raise _RecordRejected("INVALID_UNICODE", field_name) from exc
        if encoded_length > MAX_CSV_FIELD_BYTES:
            raise _RecordRejected("CSV_FIELD_TOO_LARGE", field_name)
    path = _normalize_candidate_path(values["path"])
    _validate_bounded_text(
        values["filename"], "filename", MAX_FILENAME_CHARS, allow_empty=True
    )
    _validate_bounded_text(
        values["parent"], "parent", MAX_PATH_CHARS, allow_empty=True
    )
    _validate_bounded_text(
        values["extension"], "extension", MAX_EXTENSION_CHARS, allow_empty=True
    )
    reported_size = _optional_integer(
        values["size_bytes"], "size_bytes", maximum=MAX_MEDIA_SIZE_BYTES
    )
    duration = _optional_duration(values["duration"])
    width = _optional_integer(values["width"], "width", maximum=65_535)
    height = _optional_integer(values["height"], "height", maximum=65_535)
    if (width is None) != (height is None):
        raise _RecordRejected("PARTIAL_DIMENSIONS", "width,height")
    codec = values["video_codec"]
    if codec:
        if len(codec) > MAX_CODEC_CHARS or _CODEC_RE.fullmatch(codec) is None:
            raise _RecordRejected("INVALID_CODEC", "video_codec")
        codec = codec.lower()
    else:
        codec = None
    error = values["error"]
    try:
        error_bytes = len(error.encode("utf-8", errors="strict"))
    except UnicodeEncodeError as exc:
        raise _RecordRejected("INVALID_UNICODE", "error") from exc
    if error_bytes > MAX_REPORTED_ERROR_CHARS or "\x00" in error:
        raise _RecordRejected("INVALID_REPORTED_ERROR", "error")
    outcome = _reported_probe_outcome(error)

    issues: list[dict[str, str]] = []
    expected_filename = os.path.basename(path)
    expected_parent = os.path.dirname(path)
    expected_extension = os.path.splitext(expected_filename)[1].lower()
    if values["filename"] != expected_filename:
        issues.append(_issue("REPORTED_FILENAME_MISMATCH", "input_metadata"))
    if values["parent"] != expected_parent:
        issues.append(_issue("REPORTED_PARENT_MISMATCH", "input_metadata"))
    if values["extension"].lower() != expected_extension:
        issues.append(_issue("REPORTED_EXTENSION_MISMATCH", "input_metadata"))

    prior_probe = {
        "input_record_number": record_number,
        "reported_duration_seconds": duration,
        "reported_height": height,
        "reported_probe_outcome": outcome,
        "reported_size_bytes": reported_size,
        "reported_video_codec": codec,
        "reported_width": width,
        "trust": "UNVERIFIED_HISTORICAL_METADATA",
    }
    return _ParsedCandidate(
        path=path,
        input_record_number=record_number,
        prior_probe=prior_probe,
        issues=tuple(issues),
    )


def _parse_path_list_json(document: bytes) -> _ParsedInput:
    text = _decode_document(document)
    try:
        value = _strict_json_loads(
            text,
            label="path-list",
            max_total_string_bytes=MAX_INPUT_DOCUMENT_BYTES,
        )
    except RecoveryIntakeError as exc:
        raise RecoveryIntakeError(
            "MALFORMED_PATH_LIST_JSON",
            f"path-list input failed strict bounded JSON validation: {exc.code}",
        ) from exc
    if type(value) is not dict or set(value) != {"schema_version", "paths"}:
        raise RecoveryIntakeError(
            "INVALID_PATH_LIST_SCHEMA",
            "path-list JSON must contain exactly schema_version and paths",
        )
    if value.get("schema_version") != SCHEMA_VERSION:
        raise RecoveryIntakeError(
            "INVALID_PATH_LIST_SCHEMA_VERSION",
            "path-list schema_version must be exactly 1.0",
        )
    paths = value.get("paths")
    if type(paths) is not list or not paths:
        raise RecoveryIntakeError(
            "INVALID_PATH_LIST",
            "paths must be a non-empty JSON array",
        )
    if len(paths) > MAX_INPUT_RECORDS:
        raise RecoveryIntakeError(
            "TOO_MANY_RECORDS",
            "path-list exceeds the 50,000-record hard ceiling",
        )

    candidates: list[_ParsedCandidate] = []
    rejected: list[dict[str, Any]] = []
    for position, raw_path in enumerate(paths, start=1):
        try:
            path = _normalize_candidate_path(raw_path)
            candidates.append(
                _ParsedCandidate(
                    path=path,
                    input_record_number=position,
                    prior_probe=None,
                    issues=(),
                )
            )
        except _RecordRejected as exc:
            rejected.append(
                _rejected_record(
                    position,
                    code=exc.code,
                    field=exc.field,
                    raw_locator=raw_path,
                )
            )
            if len(rejected) > MAX_REJECTED_RECORDS:
                raise RecoveryIntakeError(
                    "TOO_MANY_REJECTED_RECORDS",
                    "path-list contains too many malformed records",
                )
    if not candidates:
        raise RecoveryIntakeError("NO_VALID_CANDIDATES", "input has no valid candidates")
    return _ParsedInput(tuple(candidates), tuple(rejected), len(paths))


def _candidate_item(
    parsed: _ParsedCandidate,
    *,
    observation: PathObservation,
    matched_root: str | None,
    offline_roots: frozenset[str],
    root_device: int | None,
    production_assurance: bool,
) -> dict[str, Any]:
    issues = list(parsed.issues)
    if observation.reason_code is not None and observation.status not in {
        CandidateAvailability.REFERENCED_OFFLINE,
        CandidateAvailability.OUT_OF_SCOPE_UNOBSERVED,
        CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT,
    }:
        issues.append(_issue(observation.reason_code, "filesystem_observation"))
    if (
        observation.metadata is not None
        and parsed.prior_probe is not None
        and parsed.prior_probe["reported_size_bytes"] is not None
        and parsed.prior_probe["reported_size_bytes"] != observation.metadata.size_bytes
    ):
        issues.append(_issue("REPORTED_SIZE_MISMATCH", "filesystem_observation"))
    if observation.metadata is not None and observation.metadata.link_count != 1:
        issues.append(_issue("CANDIDATE_MULTIPLE_HARD_LINKS", "filesystem_observation"))
    if (
        observation.metadata is not None
        and root_device is not None
        and observation.metadata.device != root_device
    ):
        issues.append(_issue("CANDIDATE_CROSSES_ROOT_DEVICE", "filesystem_observation"))
    issues = sorted(issues, key=lambda item: (item["stage"], item["code"]))
    if len(issues) > MAX_CANDIDATE_ISSUES:
        raise RecoveryIntakeError(
            "TOO_MANY_CANDIDATE_ISSUES",
            "candidate issue count exceeded the hard ceiling",
        )

    priority = _metadata_priority(parsed.path, parsed.prior_probe, issues)
    locator_payload = {
        "domain": LOCATOR_DOMAIN,
        "normalized_absolute_path": parsed.path,
    }
    filesystem_observation = None
    if observation.metadata is not None:
        filesystem_observation = {
            "basis": (
                "SEALED_DESCRIPTOR_RELATIVE_METADATA_ONLY_NO_MEDIA_BYTES_READ"
                if production_assurance and matched_root is not None
                else "TEST_INJECTED_OBSERVATION_UNTRUSTED"
            ),
            "stat": observation.metadata.to_dict(),
        }
    unsafe_identity = any(
        issue["code"]
        in {"CANDIDATE_MULTIPLE_HARD_LINKS", "CANDIDATE_CROSSES_ROOT_DEVICE"}
        for issue in issues
    )
    eligible = (
        observation.status is CandidateAvailability.RESIDENT_REGULAR_FILE
        and not unsafe_identity
    )
    return {
        "availability": {
            "matched_allowed_root": matched_root,
            "matched_offline_root": (
                matched_root if matched_root in offline_roots else None
            ),
            "reason_code": observation.reason_code,
            "status": observation.status.value,
        },
        "disposition": {
            "rights": "UNKNOWN",
            "status": "QUARANTINED",
            "suitability": "NOT_EVALUATED",
        },
        "filesystem_observation": filesystem_observation,
        "identity_basis": "NORMALIZED_LOCATOR_NOT_MEDIA_CONTENT",
        "issues": issues,
        "locator_id": hashlib.sha256(canonical_json_bytes(locator_payload)).hexdigest(),
        "media_content_identity": {
            "reason": (
                (
                    "OUT_OF_SCOPE_LOCATOR_IDENTITY_UNVERIFIED"
                    if matched_root is None
                    else (
                        "SEALED_OFFLINE_ROOT_VERIFIED_ABSENT"
                        if matched_root in offline_roots
                        else "SEALED_IN_SCOPE_MEDIA_BYTES_NOT_OPENED_OR_HASHED"
                    )
                )
                if production_assurance
                else "TEST_SEAM_DOES_NOT_ATTEST_OBSERVER_BEHAVIOR"
            ),
            "status": "NOT_COMPUTED",
        },
        "media_preflight_handoff": {
            "eligible_now": eligible,
            "reason": (
                "ELIGIBLE_FOR_LATER_BYTE_LEVEL_PREFLIGHT"
                if eligible
                else (
                    "UNSAFE_FILESYSTEM_IDENTITY"
                    if unsafe_identity
                    else "SOURCE_NOT_A_RESIDENT_REGULAR_FILE"
                )
            ),
        },
        "metadata_review_priority": priority,
        "prior_probe": parsed.prior_probe,
        "source_locator": {
            "input_basis": (
                "PROBE_CSV_PATH_FIELD"
                if parsed.prior_probe is not None
                else "PATH_LIST_JSON_ENTRY"
            ),
            "input_record_number": parsed.input_record_number,
            "normalized_absolute_path": parsed.path,
        },
    }


def _metadata_priority(
    path: str,
    prior_probe: Mapping[str, Any] | None,
    issues: Sequence[Mapping[str, str]],
) -> dict[str, Any]:
    lexical = _lexical_name(path)
    positive = any(_contains_phrase(lexical, lead) for lead in _POSITIVE_NAME_LEADS)
    negative = any(_contains_phrase(lexical, lead) for lead in _NEGATIVE_NAME_LEADS)
    signals: list[str] = []

    if prior_probe is None:
        outcome = None
        duration: Decimal | None = None
        width = None
        height = None
    else:
        outcome = prior_probe["reported_probe_outcome"]
        duration_raw = prior_probe["reported_duration_seconds"]
        duration = Decimal(duration_raw) if duration_raw is not None else None
        width = prior_probe["reported_width"]
        height = prior_probe["reported_height"]

    if outcome == "NO_ERROR_REPORTED":
        signals.append("NO_HISTORICAL_PROBE_ERROR_REPORTED")
    elif outcome is not None:
        signals.append("HISTORICAL_PROBE_ERROR_REPORTED")

    if duration is not None and duration >= Decimal(3600):
        signals.append("DURATION_AT_LEAST_60_MINUTES")
        duration_bucket = 3
    elif duration is not None and duration >= Decimal(1800):
        signals.append("DURATION_AT_LEAST_30_MINUTES")
        duration_bucket = 2
    elif duration is not None and duration >= Decimal(600):
        signals.append("DURATION_AT_LEAST_10_MINUTES")
        duration_bucket = 1
    else:
        signals.append("DURATION_SHORT_OR_UNKNOWN")
        duration_bucket = 0

    landscape = (
        type(width) is int
        and type(height) is int
        and width > 0
        and height > 0
        and width >= height
    )
    if landscape and width >= 3840 and height >= 2160:
        signals.append("LANDSCAPE_4K_OR_LARGER_REPORTED")
        resolution_bucket = 2
    elif landscape and width >= 1920 and height >= 1080:
        signals.append("LANDSCAPE_1080P_OR_LARGER_REPORTED")
        resolution_bucket = 1
    else:
        signals.append("LOWER_OR_UNKNOWN_RESOLUTION")
        resolution_bucket = 0
    if positive:
        signals.append("VOLLEYBALL_OR_EVENT_NAME_LEAD")
    if negative:
        signals.append("EDITED_OR_SHORTFORM_NAME_LEAD")

    hold_issue = any(
        issue["code"].startswith("REPORTED_")
        or issue["code"].startswith("CANDIDATE_")
        for issue in issues
    )
    if outcome not in {None, "NO_ERROR_REPORTED"} or hold_issue:
        band = "HOLD"
    elif (
        outcome == "NO_ERROR_REPORTED"
        and positive
        and not negative
        and duration_bucket >= 1
        and resolution_bucket >= 1
    ):
        band = "HIGH"
    elif (
        outcome == "NO_ERROR_REPORTED"
        and not negative
        and landscape
        and (positive or duration_bucket >= 1)
    ):
        band = "MEDIUM"
    else:
        band = "LOW"

    return {
        "band": band,
        "interpretation": "HUMAN_METADATA_REVIEW_ORDER_ONLY",
        "policy_id": RANKING_POLICY_ID,
        "signals": signals,
    }


def _candidate_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
    availability_order = {
        CandidateAvailability.RESIDENT_REGULAR_FILE.value: 0,
        CandidateAvailability.REFERENCED_OFFLINE.value: 1,
        CandidateAvailability.OFFLINE_PLACEHOLDER.value: 2,
        CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT.value: 3,
        CandidateAvailability.OUT_OF_SCOPE_UNOBSERVED.value: 4,
        CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY.value: 5,
        CandidateAvailability.FILESYSTEM_OBSERVATION_FAILED.value: 6,
    }
    band_order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "HOLD": 3}
    prior = item["prior_probe"]
    duration = Decimal(prior["reported_duration_seconds"]) if (
        prior is not None and prior["reported_duration_seconds"] is not None
    ) else Decimal(-1)
    pixels = (
        prior["reported_width"] * prior["reported_height"]
        if prior is not None
        and type(prior["reported_width"]) is int
        and type(prior["reported_height"]) is int
        else -1
    )
    return (
        availability_order[item["availability"]["status"]],
        band_order[item["metadata_review_priority"]["band"]],
        -duration,
        -pixels,
        item["source_locator"]["normalized_absolute_path"],
    )


def _build_summary(
    candidates: Sequence[Mapping[str, Any]],
    rejected: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    availability_counts = {status.value: 0 for status in CandidateAvailability}
    priority_counts = {band: 0 for band in ("HIGH", "MEDIUM", "LOW", "HOLD")}
    handoff_count = 0
    for candidate in candidates:
        availability_counts[candidate["availability"]["status"]] += 1
        priority_counts[candidate["metadata_review_priority"]["band"]] += 1
        if candidate["media_preflight_handoff"]["eligible_now"]:
            handoff_count += 1
    return {
        "availability_counts": availability_counts,
        "candidate_count": len(candidates),
        "media_preflight_eligible_count": handoff_count,
        "metadata_review_priority_counts": priority_counts,
        "rejected_record_count": len(rejected),
    }


def _validate_observation_batch(
    batch: ObservationBatch,
    *,
    paths_by_root: Mapping[str, tuple[str, ...]],
    present_root_pins: Mapping[str, PresentRootPin],
    offline_roots: frozenset[str],
) -> tuple[dict[str, RootObservation], dict[str, PathObservation]]:
    if type(batch) is not ObservationBatch:
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESULT", "filesystem observer returned an invalid result"
        )
    root_map: dict[str, RootObservation] = {}
    for observed in batch.roots:
        if type(observed) is not RootObservation or observed.path in root_map:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESULT", "filesystem observer returned duplicate roots"
            )
        root_map[observed.path] = observed
    if set(root_map) != set(paths_by_root):
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESULT", "filesystem observer root set was incomplete"
        )
    for root, observed in root_map.items():
        expected = (
            RootAvailability.OFFLINE_DECLARED_AND_ABSENT
            if root in offline_roots
            else RootAvailability.PRESENT_DIRECTORY
        )
        if observed.status is not expected:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESULT", "filesystem observer root status conflicted with policy"
            )
        pin = present_root_pins.get(root)
        if pin is not None and (
            observed.metadata is None
            or observed.metadata.device != pin.device
            or observed.metadata.inode != pin.inode
        ):
            raise RecoveryIntakeError(
                "ROOT_IDENTITY_MISMATCH",
                "filesystem observer root identity conflicted with its caller pin",
            )

    expected_paths = {
        path for paths in paths_by_root.values() for path in paths
    }
    path_map: dict[str, PathObservation] = {}
    for observed in batch.paths:
        if type(observed) is not PathObservation or observed.path in path_map:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESULT", "filesystem observer returned duplicate paths"
            )
        if observed.root not in paths_by_root or observed.path not in paths_by_root[observed.root]:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESULT", "filesystem observer returned an out-of-scope path"
            )
        if observed.root in offline_roots and (
            observed.status is not CandidateAvailability.REFERENCED_OFFLINE
        ):
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESULT", "offline root returned a non-offline candidate"
            )
        path_map[observed.path] = observed
    if set(path_map) != expected_paths:
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESULT", "filesystem observer path set was incomplete"
        )
    return root_map, path_map


def _root_proof_dict(
    observation: RootObservation,
    *,
    pin: PresentRootPin | None,
    production_assurance: bool,
) -> dict[str, Any]:
    observed = observation.metadata.to_dict() if observation.metadata is not None else None
    expected = (
        {"device": pin.device, "inode": pin.inode} if pin is not None else None
    )
    return {
        "expected_identity": expected,
        "observed_filesystem_metadata": observed,
        "path": observation.path,
        "status": observation.status.value,
        "verification": (
            "SEALED_PRODUCTION_MATCHED_OR_OFFLINE_ABSENT"
            if production_assurance
            else "TEST_INJECTED_UNTRUSTED"
        ),
    }


def _observation_batch_to_dict(batch: ObservationBatch) -> dict[str, Any]:
    return {
        "domain": "multicourt-vision-scoring:recovery-observer-response:v1",
        "ok": True,
        "paths": [
            {
                "filesystem_metadata": (
                    observed.metadata.to_dict()
                    if observed.metadata is not None
                    else None
                ),
                "path": observed.path,
                "reason_code": observed.reason_code,
                "root": observed.root,
                "status": observed.status.value,
            }
            for observed in batch.paths
        ],
        "roots": [observed.to_dict() for observed in batch.roots],
        "schema_version": SCHEMA_VERSION,
    }


def _observation_batch_from_bytes(raw: bytes) -> ObservationBatch:
    try:
        value = _strict_json_loads(
            raw.decode("utf-8", errors="strict"),
            label="observer-response",
            max_total_string_bytes=MAX_OBSERVER_RESPONSE_BYTES,
        )
    except (UnicodeDecodeError, RecoveryIntakeError) as exc:
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESPONSE",
            "filesystem observer worker returned malformed canonical JSON",
        ) from exc
    if type(value) is not dict or not {"domain", "ok", "schema_version"}.issubset(value):
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESPONSE",
            "filesystem observer worker returned an unsupported schema",
        )
    if (
        value["domain"]
        != "multicourt-vision-scoring:recovery-observer-response:v1"
        or value["schema_version"] != SCHEMA_VERSION
        or type(value["ok"]) is not bool
    ):
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESPONSE",
            "filesystem observer response identity or collections were invalid",
        )
    if not value["ok"]:
        if set(value) != {"domain", "error_code", "ok", "schema_version"}:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESPONSE", "filesystem observer error schema was invalid"
            )
        error_code = value["error_code"]
        try:
            _validate_reason_code(error_code)
        except ValueError as exc:
            raise RecoveryIntakeError(
                "INVALID_OBSERVER_RESPONSE", "filesystem observer error code was invalid"
            ) from exc
        raise RecoveryIntakeError(error_code, "bounded filesystem observer rejected the roots")
    if set(value) != {"domain", "ok", "paths", "roots", "schema_version"} or (
        type(value["roots"]) is not list or type(value["paths"]) is not list
    ):
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESPONSE", "filesystem observer success schema was invalid"
        )
    try:
        roots = tuple(_root_observation_from_dict(item) for item in value["roots"])
        paths = tuple(_path_observation_from_dict(item) for item in value["paths"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RecoveryIntakeError(
            "INVALID_OBSERVER_RESPONSE",
            "filesystem observer response entries were invalid",
        ) from exc
    return ObservationBatch(roots=roots, paths=paths)


def _root_observation_from_dict(value: Any) -> RootObservation:
    if type(value) is not dict or set(value) != {
        "filesystem_metadata",
        "path",
        "status",
    }:
        raise ValueError("invalid root observation")
    return RootObservation(
        path=value["path"],
        status=RootAvailability(value["status"]),
        metadata=_file_metadata_from_dict(value["filesystem_metadata"]),
    )


def _path_observation_from_dict(value: Any) -> PathObservation:
    if type(value) is not dict or set(value) != {
        "filesystem_metadata",
        "path",
        "reason_code",
        "root",
        "status",
    }:
        raise ValueError("invalid path observation")
    return PathObservation(
        path=value["path"],
        root=value["root"],
        status=CandidateAvailability(value["status"]),
        metadata=_file_metadata_from_dict(value["filesystem_metadata"]),
        reason_code=value["reason_code"],
    )


def _file_metadata_from_dict(value: Any) -> FileMetadata | None:
    if value is None:
        return None
    expected = {
        "changed_ns",
        "device",
        "flags",
        "inode",
        "link_count",
        "mode",
        "modified_ns",
        "size_bytes",
    }
    if type(value) is not dict or set(value) != expected:
        raise ValueError("invalid filesystem metadata")
    return FileMetadata(
        device=value["device"],
        inode=value["inode"],
        mode=value["mode"],
        link_count=value["link_count"],
        size_bytes=value["size_bytes"],
        modified_ns=value["modified_ns"],
        changed_ns=value["changed_ns"],
        flags=value["flags"],
    )


def _normalize_root_policy(
    present_root_pins: Sequence[PresentRootPin],
    offline_roots: Sequence[str | os.PathLike[str]],
) -> tuple[dict[str, PresentRootPin], tuple[str, ...], tuple[str, ...]]:
    if not present_root_pins and not offline_roots:
        raise RecoveryIntakeError(
            "MISSING_ALLOWED_ROOT", "at least one allowed root is required"
        )
    if len(present_root_pins) > 64 or len(offline_roots) > 64:
        raise RecoveryIntakeError("TOO_MANY_ROOTS", "at most 64 roots are supported")
    normalized_pins: dict[str, PresentRootPin] = {}
    for raw_pin in present_root_pins:
        if type(raw_pin) is not PresentRootPin:
            raise RecoveryIntakeError(
                "INVALID_ROOT_PIN", "present roots require exact PresentRootPin values"
            )
        path = _normalize_absolute_path(
            raw_pin.path, field="present_root_pin.path", require_normal_form=False
        )
        if path in normalized_pins:
            raise RecoveryIntakeError("DUPLICATE_ROOT", "roots must be unique")
        normalized_pins[path] = PresentRootPin(
            path=path,
            device=raw_pin.device,
            inode=raw_pin.inode,
        )
    offline = tuple(
        sorted(
            _normalize_absolute_path(
                os.fspath(root), field="offline_root", require_normal_form=False
            )
            for root in offline_roots
        )
    )
    if len(set(offline)) != len(offline):
        raise RecoveryIntakeError("DUPLICATE_ROOT", "roots must be unique")
    pin_keys = {
        _comparison_path_components(root) for root in normalized_pins
    }
    offline_keys = {_comparison_path_components(root) for root in offline}
    if len(pin_keys) != len(normalized_pins) or len(offline_keys) != len(offline):
        raise RecoveryIntakeError(
            "DUPLICATE_ROOT", "casefolded and Unicode-normalized root aliases are forbidden"
        )
    if pin_keys & offline_keys:
        raise RecoveryIntakeError(
            "ROOT_MODE_CONFLICT", "a root cannot be both pinned-present and offline"
        )
    allowed = tuple(sorted(set(normalized_pins) | set(offline)))
    for index, first in enumerate(allowed):
        for second in allowed[index + 1 :]:
            if _path_canonically_aliases_within(
                second, first
            ) or _path_canonically_aliases_within(first, second):
                raise RecoveryIntakeError(
                    "OVERLAPPING_ALLOWED_ROOTS", "allowed roots cannot overlap"
                )
    return normalized_pins, offline, allowed


def _parse_present_root_pin_cli(value: str) -> PresentRootPin:
    if type(value) is not str:
        raise RecoveryIntakeError("INVALID_ROOT_PIN", "root pin must be text")
    parts = value.rsplit("::", 2)
    if len(parts) != 3:
        raise RecoveryIntakeError(
            "INVALID_ROOT_PIN",
            "root pin must use PATH::DEVICE::INODE encoding",
        )
    path, raw_device, raw_inode = parts
    if (
        _UNSIGNED_INTEGER_RE.fullmatch(raw_device) is None
        or _UNSIGNED_INTEGER_RE.fullmatch(raw_inode) is None
    ):
        raise RecoveryIntakeError(
            "INVALID_ROOT_PIN", "root pin device and inode must be unsigned integers"
        )
    device = int(raw_device)
    inode = int(raw_inode)
    if device.bit_length() > 256 or inode.bit_length() > 256:
        raise RecoveryIntakeError(
            "INVALID_ROOT_PIN", "root pin device or inode exceeded its integer bound"
        )
    normalized = _normalize_absolute_path(
        path, field="present_root_pin.path", require_normal_form=False
    )
    return PresentRootPin(path=normalized, device=device, inode=inode)


def _matching_root(path: str, roots: Sequence[str]) -> str | None:
    matches = [root for root in roots if _path_is_within(path, root)]
    if len(matches) > 1:
        raise RecoveryIntakeError(
            "AMBIGUOUS_ALLOWED_ROOT", "candidate matched more than one allowed root"
        )
    return matches[0] if matches else None


def _path_is_within(path: str, root: str) -> bool:
    path_components = _path_components(path)
    root_components = _path_components(root)
    return (
        len(path_components) >= len(root_components)
        and path_components[: len(root_components)] == root_components
    )


def _path_canonically_aliases_within(path: str, root: str) -> bool:
    path_components = _comparison_path_components(path)
    root_components = _comparison_path_components(root)
    return (
        len(path_components) >= len(root_components)
        and path_components[: len(root_components)] == root_components
    )


def _paths_lexically_alias(first: str, second: str) -> bool:
    return _comparison_path_components(first) == _comparison_path_components(second)


def _path_components(path: str) -> tuple[str, ...]:
    return tuple(path.split("/")[1:])


def _comparison_path_components(path: str) -> tuple[str, ...]:
    return tuple(
        unicodedata.normalize(
            "NFD",
            unicodedata.normalize("NFC", component).casefold(),
        )
        for component in path.split("/")[1:]
    )


def _relative_components_under_root(path: str, root: str) -> tuple[str, ...] | None:
    raw_path_components = _path_components(path)
    root_components = _path_components(root)
    if (
        len(raw_path_components) < len(root_components)
        or raw_path_components[: len(root_components)] != root_components
    ):
        return None
    return raw_path_components[len(root_components) :]


def _normalize_candidate_path(value: Any) -> str:
    if type(value) is not str:
        raise _RecordRejected("INVALID_LOCATOR_TYPE", "path")
    try:
        return _normalize_absolute_path(
            value,
            field="path",
            require_normal_form=True,
        )
    except RecoveryIntakeError as exc:
        raise _RecordRejected(exc.code, "path") from exc


def _normalize_absolute_path(
    value: str,
    *,
    field: str,
    require_normal_form: bool,
) -> str:
    if type(value) is not str or not value:
        raise RecoveryIntakeError("INVALID_ABSOLUTE_PATH", f"{field} must be non-empty")
    try:
        encoded_length = len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError as exc:
        raise RecoveryIntakeError(
            "PATH_INVALID_UNICODE", f"{field} contains an invalid Unicode scalar"
        ) from exc
    if len(value) > MAX_PATH_CHARS or encoded_length > MAX_CSV_FIELD_BYTES:
        raise RecoveryIntakeError("PATH_TOO_LONG", f"{field} exceeds the path limit")
    if _contains_control(value):
        raise RecoveryIntakeError("PATH_CONTAINS_CONTROL", f"{field} contains control characters")
    if not value.startswith("/") or value.startswith("//") or not os.path.isabs(value):
        raise RecoveryIntakeError("PATH_NOT_ABSOLUTE", f"{field} must be an absolute path")
    components = value.split("/")[1:]
    if len(components) > MAX_PATH_COMPONENTS:
        raise RecoveryIntakeError(
            "PATH_COMPONENT_LIMIT_EXCEEDED",
            f"{field} exceeds the {MAX_PATH_COMPONENTS}-component ceiling",
        )
    if any(component in {".", ".."} for component in components):
        raise RecoveryIntakeError("PATH_HAS_DOT_SEGMENT", f"{field} contains a dot segment")
    normalized = os.path.normpath(value)
    if normalized == "/":
        raise RecoveryIntakeError("ROOT_PATH_FORBIDDEN", f"{field} cannot be filesystem root")
    if require_normal_form and normalized != value:
        raise RecoveryIntakeError("PATH_NOT_NORMALIZED", f"{field} is not lexically normalized")
    return normalized


def _require_unique_candidates(candidates: Sequence[_ParsedCandidate]) -> None:
    paths = [_comparison_path_components(candidate.path) for candidate in candidates]
    if len(set(paths)) != len(paths):
        raise RecoveryIntakeError(
            "DUPLICATE_NORMALIZED_LOCATOR",
            "the same normalized candidate locator appears more than once",
        )


def _read_pinned_document(
    path: str,
    *,
    expected_sha256: str,
    deadline_seconds: float,
) -> _PinnedDocument:
    request = {
        "deadline_milliseconds": _deadline_milliseconds(deadline_seconds),
        "domain": "multicourt-vision-scoring:recovery-input-request:v1",
        "expected_sha256": expected_sha256,
        "path": path,
        "schema_version": SCHEMA_VERSION,
    }
    encoded_request = canonical_json_bytes(request)
    if len(encoded_request) > 16 * 1024:
        raise RecoveryIntakeError(
            "INPUT_WORKER_REQUEST_TOO_LARGE", "input-reader request exceeded its ceiling"
        )
    command = [sys.executable, os.path.abspath(__file__), "--_input-worker"]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
        )
    except OSError as exc:
        raise RecoveryIntakeError(
            "INPUT_WORKER_START_FAILED", "bounded input-reader worker could not start"
        ) from exc
    stdout, stderr, returncode = _stream_worker_ipc(
        process,
        input_bytes=encoded_request,
        deadline_seconds=deadline_seconds,
        stdout_limit=MAX_INPUT_WORKER_RESPONSE_BYTES,
        stderr_limit=MAX_INPUT_WORKER_STDERR_BYTES,
        timeout_code="INPUT_READ_DEADLINE_EXCEEDED",
        stdout_limit_code="INPUT_WORKER_RESPONSE_TOO_LARGE",
        stderr_limit_code="INPUT_WORKER_STDERR_TOO_LARGE",
    )
    del stderr
    if returncode != 0:
        raise RecoveryIntakeError(
            "INPUT_WORKER_FAILED", "bounded input-reader worker failed closed"
        )
    try:
        response = _strict_json_loads(
            stdout.decode("utf-8", errors="strict"),
            label="input-worker-response",
            max_total_string_bytes=MAX_INPUT_WORKER_RESPONSE_BYTES,
        )
    except (UnicodeDecodeError, RecoveryIntakeError) as exc:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader worker returned invalid JSON"
        ) from exc
    common = {"domain", "ok", "schema_version"}
    if type(response) is not dict or not common.issubset(response):
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader response schema was invalid"
        )
    if (
        response["domain"] != "multicourt-vision-scoring:recovery-input-response:v1"
        or response["schema_version"] != SCHEMA_VERSION
        or type(response["ok"]) is not bool
    ):
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader response identity was invalid"
        )
    if not response["ok"]:
        if set(response) != common | {"error_code"}:
            raise RecoveryIntakeError(
                "INVALID_INPUT_WORKER_RESPONSE", "input-reader error schema was invalid"
            )
        error_code = response["error_code"]
        try:
            _validate_reason_code(error_code)
        except ValueError as exc:
            raise RecoveryIntakeError(
                "INVALID_INPUT_WORKER_RESPONSE", "input-reader error code was invalid"
            ) from exc
        raise RecoveryIntakeError(error_code, "bounded input-reader rejected the document")
    expected_fields = common | {
        "data_base64",
        "filesystem_metadata",
        "sha256",
    }
    if set(response) != expected_fields:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader success schema was invalid"
        )
    data_base64 = response["data_base64"]
    if type(data_base64) is not str:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader payload was not base64 text"
        )
    try:
        data = base64.b64decode(data_base64.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as exc:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader payload was invalid base64"
        ) from exc
    if len(data) > MAX_INPUT_DOCUMENT_BYTES:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader payload exceeded its hard ceiling"
        )
    sha256 = response["sha256"]
    _require_sha256(sha256, "input-worker sha256")
    if sha256 != expected_sha256 or hashlib.sha256(data).hexdigest() != sha256:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader payload digest did not verify"
        )
    try:
        metadata = _file_metadata_from_dict(response["filesystem_metadata"])
    except ValueError as exc:
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader metadata was invalid"
        ) from exc
    if (
        metadata is None
        or not stat_module.S_ISREG(metadata.mode)
        or metadata.size_bytes != len(data)
        or metadata.link_count != 1
    ):
        raise RecoveryIntakeError(
            "INVALID_INPUT_WORKER_RESPONSE", "input-reader filesystem identity was unsafe"
        )
    return _PinnedDocument(data=data, sha256=sha256, metadata=metadata)


def _read_pinned_document_direct(
    path: str,
    *,
    expected_sha256: str,
    deadline_seconds: float,
) -> _PinnedDocument:
    deadline = time.monotonic() + deadline_seconds
    parent_fd, name = _open_absolute_parent(path, deadline=deadline)
    file_fd: int | None = None
    try:
        try:
            path_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError as exc:
            raise RecoveryIntakeError(
                "INPUT_OPEN_FAILED", "input document could not be inspected"
            ) from exc
        if not stat_module.S_ISREG(path_stat.st_mode) or stat_module.S_ISLNK(path_stat.st_mode):
            raise RecoveryIntakeError(
                "UNSAFE_INPUT_DOCUMENT", "input document must be a non-symlink regular file"
            )
        if _is_dataless(path_stat):
            raise RecoveryIntakeError(
                "INPUT_DOCUMENT_OFFLINE", "input document bytes are not resident"
            )
        if path_stat.st_nlink != 1:
            raise RecoveryIntakeError(
                "INPUT_DOCUMENT_MULTIPLE_LINKS",
                "input document must have exactly one filesystem link",
            )
        if path_stat.st_size < 0 or path_stat.st_size > MAX_INPUT_DOCUMENT_BYTES:
            raise RecoveryIntakeError(
                "INPUT_DOCUMENT_TOO_LARGE", "input document exceeds the 16 MiB hard ceiling"
            )
        initial = FileMetadata.from_stat(path_stat)
        flags = os.O_RDONLY | _required_flag("O_NOFOLLOW") | _required_flag("O_CLOEXEC")
        try:
            file_fd = os.open(name, flags, dir_fd=parent_fd)
        except OSError as exc:
            raise RecoveryIntakeError(
                "INPUT_OPEN_FAILED", "input document could not be opened safely"
            ) from exc
        bound = FileMetadata.from_stat(os.fstat(file_fd))
        if bound != initial or not stat_module.S_ISREG(bound.mode):
            raise RecoveryIntakeError(
                "INPUT_CHANGED", "input document changed before descriptor binding"
            )

        chunks: list[bytes] = []
        digest = hashlib.sha256()
        remaining = initial.size_bytes
        while remaining:
            _check_deadline(deadline)
            chunk = os.read(file_fd, min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                raise RecoveryIntakeError(
                    "INPUT_CHANGED", "input document reached EOF before its fixed size"
                )
            chunks.append(chunk)
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(file_fd, 1):
            raise RecoveryIntakeError("INPUT_CHANGED", "input document grew while read")
        final_bound = FileMetadata.from_stat(os.fstat(file_fd))
        final_path = FileMetadata.from_stat(
            os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        )
        if final_bound != initial or final_path != initial:
            raise RecoveryIntakeError("INPUT_CHANGED", "input document changed while read")
        actual = digest.hexdigest()
        if actual != expected_sha256:
            raise RecoveryIntakeError(
                "INPUT_DIGEST_MISMATCH", "input document does not match its expected SHA-256"
            )
        return _PinnedDocument(
            data=b"".join(chunks),
            sha256=actual,
            metadata=initial,
        )
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(parent_fd)


def _observe_relative_path(
    root_fd: int,
    *,
    root: str,
    path: str,
    deadline: float,
) -> PathObservation:
    components = _relative_components_under_root(path, root)
    if not components or any(component in {"", ".", ".."} for component in components):
        return PathObservation(
            path=path,
            root=root,
            status=CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY,
            reason_code="UNSAFE_RELATIVE_PATH",
        )
    current_fd = os.dup(root_fd)
    try:
        directory_flags = (
            os.O_RDONLY
            | _required_flag("O_DIRECTORY")
            | _required_flag("O_NOFOLLOW")
            | _required_flag("O_CLOEXEC")
        )
        for component in components[:-1]:
            _check_deadline(deadline)
            try:
                next_fd = os.open(component, directory_flags, dir_fd=current_fd)
            except FileNotFoundError:
                return PathObservation(
                    path=path,
                    root=root,
                    status=CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT,
                    reason_code="PATH_COMPONENT_ABSENT",
                )
            except OSError as exc:
                status, code = _classify_path_walk_error(exc)
                return PathObservation(path=path, root=root, status=status, reason_code=code)
            os.close(current_fd)
            current_fd = next_fd

        final_name = components[-1]
        _check_deadline(deadline)
        try:
            first = os.stat(final_name, dir_fd=current_fd, follow_symlinks=False)
        except FileNotFoundError:
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT,
                reason_code="FINAL_ENTRY_ABSENT",
            )
        except OSError as exc:
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.FILESYSTEM_OBSERVATION_FAILED,
                reason_code=f"FILESYSTEM_ERRNO_{exc.errno or 0}",
            )
        first_metadata = FileMetadata.from_stat(first)
        if stat_module.S_ISLNK(first.st_mode):
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY,
                reason_code="FINAL_ENTRY_SYMLINK",
            )
        if not stat_module.S_ISREG(first.st_mode):
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY,
                reason_code="FINAL_ENTRY_NOT_REGULAR",
            )
        if _is_dataless(first):
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.OFFLINE_PLACEHOLDER,
                reason_code="FINAL_ENTRY_DATALESS",
            )
        _check_deadline(deadline)
        try:
            second = FileMetadata.from_stat(
                os.stat(final_name, dir_fd=current_fd, follow_symlinks=False)
            )
        except OSError as exc:
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.FILESYSTEM_OBSERVATION_FAILED,
                reason_code=f"FILESYSTEM_ERRNO_{exc.errno or 0}",
            )
        if second != first_metadata:
            return PathObservation(
                path=path,
                root=root,
                status=CandidateAvailability.FILESYSTEM_OBSERVATION_FAILED,
                reason_code="PATH_CHANGED_DURING_OBSERVATION",
            )
        return PathObservation(
            path=path,
            root=root,
            status=CandidateAvailability.RESIDENT_REGULAR_FILE,
            metadata=first_metadata,
        )
    finally:
        os.close(current_fd)


def _classify_path_walk_error(
    error: OSError,
) -> tuple[CandidateAvailability, str]:
    if error.errno in {errno.ELOOP, errno.ENOTDIR}:
        return CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY, "UNSAFE_PATH_COMPONENT"
    return (
        CandidateAvailability.FILESYSTEM_OBSERVATION_FAILED,
        f"FILESYSTEM_ERRNO_{error.errno or 0}",
    )


def _try_open_absolute_directory_with_ancestry(
    path: str,
    deadline: float | None,
) -> tuple[int | None, tuple[tuple[int, int], ...]]:
    components = tuple(component for component in path.split("/")[1:] if component)
    if len(components) > MAX_PATH_COMPONENTS:
        raise RecoveryIntakeError(
            "PATH_COMPONENT_LIMIT_EXCEEDED",
            f"directory path exceeds the {MAX_PATH_COMPONENTS}-component ceiling",
        )
    flags = (
        os.O_RDONLY
        | _required_flag("O_DIRECTORY")
        | _required_flag("O_NOFOLLOW")
        | _required_flag("O_CLOEXEC")
    )
    current_fd = os.open("/", flags)
    root_stat = os.fstat(current_fd)
    ancestry: list[tuple[int, int]] = [(root_stat.st_dev, root_stat.st_ino)]
    try:
        for component in components:
            if deadline is not None:
                _check_deadline(deadline)
            try:
                next_fd = os.open(component, flags, dir_fd=current_fd)
            except FileNotFoundError:
                os.close(current_fd)
                return None, tuple(ancestry)
            except OSError as exc:
                raise RecoveryIntakeError(
                    "UNSAFE_ROOT",
                    "root directory could not be bound without following links: "
                    f"errno {exc.errno or 0}",
                ) from exc
            os.close(current_fd)
            current_fd = next_fd
            component_stat = os.fstat(current_fd)
            ancestry.append((component_stat.st_dev, component_stat.st_ino))
        return current_fd, tuple(ancestry)
    except Exception:
        try:
            os.close(current_fd)
        except OSError:
            pass
        raise


def _try_open_absolute_directory(path: str, deadline: float | None) -> int | None:
    directory_fd, _ = _try_open_absolute_directory_with_ancestry(path, deadline)
    return directory_fd


def _open_absolute_parent_with_ancestry(
    path: str,
    deadline: float | None,
) -> tuple[int, str, tuple[tuple[int, int], ...]]:
    parent = os.path.dirname(path)
    name = os.path.basename(path)
    if not name:
        raise RecoveryIntakeError("INVALID_ABSOLUTE_PATH", "file path has no basename")
    parent_fd, ancestry = _try_open_absolute_directory_with_ancestry(parent, deadline)
    if parent_fd is None:
        raise RecoveryIntakeError("PARENT_UNAVAILABLE", "parent directory is unavailable")
    return parent_fd, name, ancestry


def _open_absolute_parent(path: str, deadline: float | None) -> tuple[int, str]:
    parent_fd, name, _ = _open_absolute_parent_with_ancestry(path, deadline)
    return parent_fd, name


def _required_flag(name: str) -> int:
    value = getattr(os, name, None)
    if type(value) is not int or value == 0:
        raise RecoveryIntakeError(
            "PLATFORM_UNSAFE", f"platform does not provide required {name} protection"
        )
    return value


def _is_dataless(value: os.stat_result) -> bool:
    if sys.platform != "darwin":
        return False
    mask = (
        getattr(stat_module, "SF_DATALESS", 0)
        | getattr(stat_module, "UF_DATALESS", 0)
        | _DARWIN_SF_DATALESS
    )
    return bool(mask and getattr(value, "st_flags", 0) & mask)


def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise RecoveryIntakeError(
            "OBSERVATION_DEADLINE_EXCEEDED",
            "filesystem observation exceeded its global deadline",
        )


def _decode_document(document: bytes) -> str:
    try:
        return document.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise RecoveryIntakeError(
            "INVALID_INPUT_ENCODING", "input document must be strict UTF-8"
        ) from exc


def _reject_duplicate_json_keys(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_float(raw: str) -> None:
    raise ValueError(f"JSON floating-point value is forbidden: {raw[:32]}")


def _reject_json_constant(raw: str) -> None:
    raise ValueError(f"JSON non-finite constant is forbidden: {raw[:32]}")


def _parse_bounded_json_integer(raw: str) -> int:
    if len(raw) > 78 or re.fullmatch(r"-?(?:0|[1-9][0-9]*)", raw) is None:
        raise ValueError("JSON integer exceeded its lexical bound")
    value = int(raw)
    if abs(value).bit_length() > 256:
        raise ValueError("JSON integer exceeded its 256-bit bound")
    return value


def _strict_json_loads(
    text: str,
    *,
    label: str,
    max_total_string_bytes: int,
) -> Any:
    """Parse unique-key integer-only JSON and enforce iterative graph bounds."""

    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_json_constant,
            parse_float=_reject_json_float,
            parse_int=_parse_bounded_json_integer,
        )
    except RecursionError as exc:
        raise RecoveryIntakeError(
            "JSON_DEPTH_EXCEEDED", f"{label} JSON exceeded parser recursion bounds"
        ) from exc
    except (MemoryError, ValueError, json.JSONDecodeError) as exc:
        raise RecoveryIntakeError(
            "MALFORMED_STRICT_JSON", f"{label} JSON was malformed or unsupported"
        ) from exc

    stack: list[tuple[Any, int]] = [(value, 0)]
    node_count = 0
    total_string_bytes = 0
    while stack:
        node, depth = stack.pop()
        node_count += 1
        if node_count > MAX_JSON_NODES:
            raise RecoveryIntakeError(
                "JSON_NODE_LIMIT_EXCEEDED", f"{label} JSON exceeded the node ceiling"
            )
        if depth > MAX_JSON_DEPTH:
            raise RecoveryIntakeError(
                "JSON_DEPTH_EXCEEDED", f"{label} JSON exceeded the depth ceiling"
            )
        if type(node) is dict:
            if len(node) > MAX_JSON_CONTAINER_ITEMS:
                raise RecoveryIntakeError(
                    "JSON_CONTAINER_LIMIT_EXCEEDED",
                    f"{label} JSON object exceeded the item ceiling",
                )
            for key, child in node.items():
                if type(key) is not str:
                    raise RecoveryIntakeError(
                        "JSON_KEY_INVALID", f"{label} JSON key was not a string"
                    )
                try:
                    total_string_bytes += len(key.encode("utf-8", errors="strict"))
                except UnicodeEncodeError as exc:
                    raise RecoveryIntakeError(
                        "JSON_INVALID_UNICODE",
                        f"{label} JSON key contained an invalid Unicode scalar",
                    ) from exc
                stack.append((child, depth + 1))
        elif type(node) is list:
            if len(node) > MAX_JSON_CONTAINER_ITEMS:
                raise RecoveryIntakeError(
                    "JSON_CONTAINER_LIMIT_EXCEEDED",
                    f"{label} JSON array exceeded the item ceiling",
                )
            stack.extend((child, depth + 1) for child in node)
        elif type(node) is str:
            try:
                total_string_bytes += len(node.encode("utf-8", errors="strict"))
            except UnicodeEncodeError as exc:
                raise RecoveryIntakeError(
                    "JSON_INVALID_UNICODE",
                    f"{label} JSON string contained an invalid Unicode scalar",
                ) from exc
        elif node is None or type(node) in {bool, int}:
            pass
        else:
            raise RecoveryIntakeError(
                "JSON_VALUE_TYPE_FORBIDDEN",
                f"{label} JSON contained an unsupported value type",
            )
        if total_string_bytes > max_total_string_bytes:
            raise RecoveryIntakeError(
                "JSON_STRING_BUDGET_EXCEEDED",
                f"{label} JSON exceeded the cumulative string-byte ceiling",
            )
    return value


def _optional_integer(raw: str, field: str, *, maximum: int) -> int | None:
    if raw == "":
        return None
    if _UNSIGNED_INTEGER_RE.fullmatch(raw) is None:
        raise _RecordRejected("INVALID_UNSIGNED_INTEGER", field)
    value = int(raw)
    if value > maximum:
        raise _RecordRejected("INTEGER_OUT_OF_RANGE", field)
    return value


def _optional_duration(raw: str) -> str | None:
    if raw == "":
        return None
    if len(raw) > 64 or _DECIMAL_RE.fullmatch(raw) is None:
        raise _RecordRejected("INVALID_DURATION", "duration")
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise _RecordRejected("INVALID_DURATION", "duration") from exc
    if not value.is_finite() or value < 0 or value > MAX_DURATION_SECONDS:
        raise _RecordRejected("DURATION_OUT_OF_RANGE", "duration")
    return raw


def _reported_probe_outcome(error: str) -> str:
    normalized = " ".join(error.split())
    if not normalized:
        return "NO_ERROR_REPORTED"
    if normalized == "ffprobe_timeout":
        return "FFPROBE_TIMEOUT_REPORTED"
    if normalized.startswith("stat:"):
        return "STAT_ERROR_REPORTED"
    return "PROBE_ERROR_REPORTED"


def _validate_bounded_text(
    value: str,
    field: str,
    maximum: int,
    *,
    allow_empty: bool,
) -> None:
    if type(value) is not str or (not value and not allow_empty):
        raise _RecordRejected("INVALID_TEXT", field)
    try:
        encoded_length = len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError as exc:
        raise _RecordRejected("INVALID_UNICODE", field) from exc
    if encoded_length > maximum:
        raise _RecordRejected("TEXT_TOO_LONG", field)
    if _contains_control(value):
        raise _RecordRejected("TEXT_CONTAINS_CONTROL", field)


def _contains_control(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _rejected_record(
    record_number: int,
    *,
    code: str,
    field: str,
    raw_locator: Any,
) -> dict[str, Any]:
    locator_fingerprint = None
    if type(raw_locator) is str:
        locator_fingerprint = hashlib.sha256(
            raw_locator.encode("utf-8", errors="backslashreplace")
        ).hexdigest()
    return {
        "code": code,
        "field": field,
        "input_record_number": record_number,
        "locator_text_sha256": locator_fingerprint,
    }


def _issue(code: str, stage: str) -> dict[str, str]:
    _validate_reason_code(code)
    _validate_reason_code(stage.upper())
    return {"code": code, "stage": stage}


def _validate_reason_code(value: str | None) -> None:
    if value is None:
        return
    if type(value) is not str or not re.fullmatch(r"[A-Z0-9_]{1,128}", value):
        raise ValueError("reason codes must be bounded uppercase ASCII identifiers")


def _lexical_name(path: str) -> str:
    folded = path.casefold()
    return " ".join(
        "".join(character if character.isalnum() else " " for character in folded).split()
    )


def _contains_phrase(text: str, phrase: str) -> bool:
    return f" {phrase} " in f" {text} "


def _require_sha256(value: str, field: str) -> None:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise RecoveryIntakeError(
            "INVALID_SHA256", f"{field} must be a raw lowercase SHA-256"
        )


def _positive_finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def _deadline_milliseconds(value: float) -> int:
    if not _positive_finite(value) or value > MAX_OBSERVATION_TIMEOUT_SECONDS:
        raise RecoveryIntakeError(
            "INVALID_OBSERVATION_DEADLINE", "deadline must be positive and at most 600 seconds"
        )
    milliseconds = int(math.ceil(float(value) * 1000.0))
    if milliseconds <= 0 or milliseconds > int(MAX_OBSERVATION_TIMEOUT_SECONDS * 1000):
        raise RecoveryIntakeError(
            "INVALID_OBSERVATION_DEADLINE", "deadline milliseconds exceeded the hard ceiling"
        )
    return milliseconds


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        process.kill()


def _stream_worker_ipc(
    process: subprocess.Popen[bytes],
    *,
    input_bytes: bytes,
    deadline_seconds: float,
    stdout_limit: int,
    stderr_limit: int,
    timeout_code: str,
    stdout_limit_code: str,
    stderr_limit_code: str,
) -> tuple[bytes, bytes, int]:
    """Exchange bounded bytes with a worker without communicate buffering."""

    if process.stdin is None or process.stdout is None or process.stderr is None:
        _kill_process_group(process)
        raise RecoveryIntakeError(
            "WORKER_PIPE_SETUP_FAILED", "worker did not expose all required pipes"
        )
    if (
        type(stdout_limit) is not int
        or type(stderr_limit) is not int
        or stdout_limit <= 0
        or stderr_limit <= 0
    ):
        _kill_process_group(process)
        raise RecoveryIntakeError("INVALID_IPC_LIMIT", "worker IPC limits must be positive")

    selector = selectors.DefaultSelector()
    stdout = bytearray()
    stderr = bytearray()
    input_offset = 0
    deadline = time.monotonic() + deadline_seconds
    streams = (process.stdin, process.stdout, process.stderr)
    try:
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        if input_bytes:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()

        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RecoveryIntakeError(timeout_code, "worker exceeded its wall-clock deadline")
            events = selector.select(timeout=min(0.25, remaining))
            if not events:
                continue
            for key, _ in events:
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        written = os.write(
                            stream.fileno(),
                            input_bytes[input_offset : input_offset + 64 * 1024],
                        )
                    except (BlockingIOError, InterruptedError):
                        continue
                    except BrokenPipeError:
                        written = 0
                    if written <= 0 or input_offset + written == len(input_bytes):
                        input_offset += max(0, written)
                        selector.unregister(stream)
                        stream.close()
                    else:
                        input_offset += written
                    continue

                try:
                    chunk = os.read(stream.fileno(), 64 * 1024)
                except (BlockingIOError, InterruptedError):
                    continue
                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                    continue
                destination = stdout if key.data == "stdout" else stderr
                limit = stdout_limit if key.data == "stdout" else stderr_limit
                if len(destination) + len(chunk) > limit:
                    code = stdout_limit_code if key.data == "stdout" else stderr_limit_code
                    raise RecoveryIntakeError(code, "worker output exceeded its byte ceiling")
                destination.extend(chunk)

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RecoveryIntakeError(timeout_code, "worker exceeded its wall-clock deadline")
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise RecoveryIntakeError(
                timeout_code, "worker did not exit before its wall-clock deadline"
            ) from exc
        return bytes(stdout), bytes(stderr), returncode
    except RecoveryIntakeError:
        _kill_process_group(process)
        raise
    except (OSError, ValueError) as exc:
        _kill_process_group(process)
        raise RecoveryIntakeError(
            "WORKER_IPC_FAILED", "bounded worker IPC failed closed"
        ) from exc
    finally:
        selector.close()
        for stream in streams:
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        if process.poll() is None:
            _kill_process_group(process)
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass


def _observer_worker_main() -> int:
    raw = sys.stdin.buffer.read(MAX_OBSERVER_REQUEST_BYTES + 1)
    if len(raw) > MAX_OBSERVER_REQUEST_BYTES:
        return 2
    try:
        value = _strict_json_loads(
            raw.decode("utf-8", errors="strict"),
            label="observer-request",
            max_total_string_bytes=MAX_OBSERVER_REQUEST_BYTES,
        )
        if type(value) is not dict or set(value) != {
            "deadline_milliseconds",
            "domain",
            "offline_roots",
            "paths_by_root",
            "present_root_pins",
            "schema_version",
        }:
            return 2
        if (
            value["domain"]
            != "multicourt-vision-scoring:recovery-observer-request:v1"
            or value["schema_version"] != SCHEMA_VERSION
            or type(value["paths_by_root"]) is not dict
            or type(value["offline_roots"]) is not list
            or type(value["present_root_pins"]) is not dict
        ):
            return 2
        deadline_milliseconds = value["deadline_milliseconds"]
        if (
            type(deadline_milliseconds) is not int
            or deadline_milliseconds <= 0
            or deadline_milliseconds > int(MAX_OBSERVATION_TIMEOUT_SECONDS * 1000)
        ):
            return 2
        deadline_seconds = deadline_milliseconds / 1000.0
        pins: list[PresentRootPin] = []
        for root, raw_pin in value["present_root_pins"].items():
            if type(raw_pin) is not dict or set(raw_pin) != {"device", "inode"}:
                return 2
            pins.append(
                PresentRootPin(
                    path=root,
                    device=raw_pin["device"],
                    inode=raw_pin["inode"],
                )
            )
        roots = tuple(value["paths_by_root"].keys())
        normalized_pins, normalized_offline, normalized_roots = _normalize_root_policy(
            pins, value["offline_roots"]
        )
        if tuple(roots) != normalized_roots:
            return 2
        total = 0
        paths_by_root: dict[str, tuple[str, ...]] = {}
        seen: set[str] = set()
        for root in normalized_roots:
            raw_paths = value["paths_by_root"][root]
            if type(raw_paths) is not list:
                return 2
            normalized_paths: list[str] = []
            for raw_path in raw_paths:
                path = _normalize_candidate_path(raw_path)
                if not _path_is_within(path, root) or path in seen:
                    return 2
                seen.add(path)
                normalized_paths.append(path)
                total += 1
                if total > MAX_INPUT_RECORDS:
                    return 2
            if normalized_paths != sorted(normalized_paths):
                return 2
            paths_by_root[root] = tuple(normalized_paths)
        try:
            batch = DescriptorFilesystemObserver().observe(
                paths_by_root=paths_by_root,
                present_root_pins=normalized_pins,
                offline_roots=frozenset(normalized_offline),
                deadline_seconds=float(deadline_seconds),
            )
        except RecoveryIntakeError as exc:
            response = {
                "domain": "multicourt-vision-scoring:recovery-observer-response:v1",
                "error_code": exc.code,
                "ok": False,
                "schema_version": SCHEMA_VERSION,
            }
        else:
            response = _observation_batch_to_dict(batch)
        encoded = canonical_json_bytes(response)
        if len(encoded) > MAX_OBSERVER_RESPONSE_BYTES:
            return 2
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
        return 0
    except (ValueError, OSError, UnicodeError):
        return 2


def _input_worker_main() -> int:
    raw = sys.stdin.buffer.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        return 2
    try:
        value = _strict_json_loads(
            raw.decode("utf-8", errors="strict"),
            label="input-reader-request",
            max_total_string_bytes=16 * 1024,
        )
        if type(value) is not dict or set(value) != {
            "deadline_milliseconds",
            "domain",
            "expected_sha256",
            "path",
            "schema_version",
        }:
            return 2
        if (
            value["domain"] != "multicourt-vision-scoring:recovery-input-request:v1"
            or value["schema_version"] != SCHEMA_VERSION
        ):
            return 2
        deadline_milliseconds = value["deadline_milliseconds"]
        if (
            type(deadline_milliseconds) is not int
            or deadline_milliseconds <= 0
            or deadline_milliseconds > int(MAX_OBSERVATION_TIMEOUT_SECONDS * 1000)
        ):
            return 2
        path = _normalize_absolute_path(
            value["path"], field="input_path", require_normal_form=True
        )
        _require_sha256(value["expected_sha256"], "expected_sha256")
        try:
            document = _read_pinned_document_direct(
                path,
                expected_sha256=value["expected_sha256"],
                deadline_seconds=deadline_milliseconds / 1000.0,
            )
        except RecoveryIntakeError as exc:
            response = {
                "domain": "multicourt-vision-scoring:recovery-input-response:v1",
                "error_code": exc.code,
                "ok": False,
                "schema_version": SCHEMA_VERSION,
            }
        else:
            response = {
                "data_base64": base64.b64encode(document.data).decode("ascii"),
                "domain": "multicourt-vision-scoring:recovery-input-response:v1",
                "filesystem_metadata": document.metadata.to_dict(),
                "ok": True,
                "schema_version": SCHEMA_VERSION,
                "sha256": document.sha256,
            }
        encoded = canonical_json_bytes(response)
        if len(encoded) > MAX_INPUT_WORKER_RESPONSE_BYTES:
            return 2
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
        return 0
    except (RecoveryIntakeError, ValueError, OSError, UnicodeError):
        return 2


def _write_all(file_descriptor: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = os.write(file_descriptor, remaining)
        if written <= 0:
            raise RecoveryIntakeError("OUTPUT_WRITE_FAILED", "output stopped accepting bytes")
        remaining = remaining[written:]


def _publish_no_replace(
    path: str,
    data: bytes,
    *,
    forbidden_ancestor_identities: frozenset[tuple[int, int]],
) -> None:
    parent_fd, name, ancestry = _open_absolute_parent_with_ancestry(
        path,
        deadline=None,
    )
    if any(identity in forbidden_ancestor_identities for identity in ancestry):
        os.close(parent_fd)
        raise RecoveryIntakeError(
            "OUTPUT_ANCESTOR_MATCHES_ALLOWED_ROOT",
            "output parent ancestry physically intersects a pinned present media root",
        )
    parent_stat = os.fstat(parent_fd)
    if (
        not stat_module.S_ISDIR(parent_stat.st_mode)
        or parent_stat.st_uid != os.geteuid()
        or parent_stat.st_mode & 0o022
    ):
        os.close(parent_fd)
        raise RecoveryIntakeError(
            "UNSAFE_OUTPUT_PARENT",
            "output parent must be owner-controlled and not group/world writable",
        )
    temporary_name = f".recovery-intake-{secrets.token_hex(16)}.tmp"
    temporary_fd: int | None = None
    temporary_exists = False
    published = False
    try:
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | _required_flag("O_NOFOLLOW")
            | _required_flag("O_CLOEXEC")
        )
        temporary_fd = os.open(temporary_name, flags, 0o600, dir_fd=parent_fd)
        temporary_exists = True
        os.fchmod(temporary_fd, 0o600)
        _write_all(temporary_fd, data)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        try:
            os.link(
                temporary_name,
                name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileExistsError as exc:
            raise RecoveryIntakeError(
                "OUTPUT_ALREADY_EXISTS", "output path already exists; overwrite is forbidden"
            ) from exc
        except OSError as exc:
            raise RecoveryIntakeError(
                "OUTPUT_PUBLISH_FAILED", "output could not be atomically published"
            ) from exc
        published = True
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
            temporary_exists = False
        except OSError as exc:
            raise RecoveryIntakeError(
                "OUTPUT_PUBLISHED_CLEANUP_FAILED",
                "output was published but temporary-name cleanup failed",
            ) from exc
        try:
            os.fsync(parent_fd)
        except OSError as exc:
            raise RecoveryIntakeError(
                "OUTPUT_PUBLISHED_DURABILITY_FAILED",
                "output was published but directory durability confirmation failed",
            ) from exc
    finally:
        active_error = sys.exc_info()[0] is not None
        cleanup_error: RecoveryIntakeError | None = None
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except OSError:
                if published and not active_error:
                    cleanup_error = RecoveryIntakeError(
                        "OUTPUT_PUBLISHED_CLEANUP_FAILED",
                        "output was published but final cleanup failed",
                    )
        try:
            os.close(parent_fd)
        except OSError as exc:
            if published and not active_error and cleanup_error is None:
                cleanup_error = RecoveryIntakeError(
                    "OUTPUT_PUBLISHED_CLOSE_FAILED",
                    "output was published but parent descriptor close failed",
                )
                cleanup_error.__cause__ = exc
        if cleanup_error is not None:
            raise cleanup_error


def _validate_manifest_for_emit(
    manifest: Mapping[str, Any],
) -> _EmitPolicy:
    if type(manifest) is not dict:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest must be an exact dictionary"
        )
    expected_top_level = {
        "candidates",
        "domain",
        "input",
        "manifest_sha256",
        "manifest_status",
        "policy",
        "rejected_records",
        "resource_accounting",
        "schema_version",
        "scope",
        "summary",
    }
    if set(manifest) != expected_top_level:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest top-level schema was not exact"
        )
    if (
        type(manifest.get("candidates")) is not list
        or len(manifest["candidates"]) > MAX_INPUT_RECORDS
        or type(manifest.get("rejected_records")) is not list
        or len(manifest["rejected_records"]) > MAX_REJECTED_RECORDS
    ):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest collection bounds were invalid"
        )
    digest = manifest.get("manifest_sha256")
    _require_sha256(digest, "manifest_sha256")
    payload = dict(manifest)
    payload.pop("manifest_sha256")
    try:
        canonical_payload = canonical_json_bytes(payload)
    except (MemoryError, RecursionError, TypeError, ValueError, UnicodeEncodeError) as exc:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest could not be canonically encoded"
        ) from exc
    if len(canonical_payload) > MAX_MANIFEST_CANONICAL_BYTES:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest payload exceeded its byte ceiling"
        )
    expected = hashlib.sha256(canonical_payload).hexdigest()
    del canonical_payload
    if digest != expected:
        raise RecoveryIntakeError(
            "MANIFEST_DIGEST_MISMATCH", "manifest self-digest did not verify"
        )
    if (
        manifest.get("domain") != MANIFEST_DOMAIN
        or manifest.get("schema_version") != SCHEMA_VERSION
        or type(manifest.get("input")) is not dict
        or type(manifest.get("policy")) is not dict
        or type(manifest.get("candidates")) is not list
    ):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest identity or collections were invalid"
        )
    input_path = _normalize_absolute_path(
        manifest["input"].get("document_path"),
        field="manifest.input.document_path",
        require_normal_form=True,
    )
    raw_roots = manifest["policy"].get("allowed_roots")
    if type(raw_roots) is not list or not raw_roots:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest allowed roots were invalid"
        )
    roots = tuple(
        _normalize_absolute_path(
            root,
            field="manifest.policy.allowed_roots",
            require_normal_form=True,
        )
        for root in raw_roots
    )
    root_keys = {_comparison_path_components(root) for root in roots}
    if len(root_keys) != len(roots):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest allowed roots were duplicated"
        )
    raw_offline_roots = manifest["policy"].get("offline_roots")
    if type(raw_offline_roots) is not list:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest offline roots were invalid"
        )
    offline_roots = tuple(
        _normalize_absolute_path(
            root,
            field="manifest.policy.offline_roots",
            require_normal_form=True,
        )
        for root in raw_offline_roots
    )
    if any(
        not any(_paths_lexically_alias(root, allowed) for allowed in roots)
        for root in offline_roots
    ):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest offline root was not allowed"
        )
    offline_root_keys = {
        _comparison_path_components(root) for root in offline_roots
    }
    if len(offline_root_keys) != len(offline_roots):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest offline roots were duplicated"
        )

    assurance = manifest["policy"].get("assurance")
    if type(assurance) is not dict or set(assurance) != {"claims", "level"} or (
        type(assurance["claims"]) is not list or type(assurance["level"]) is not str
    ):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest assurance schema was invalid"
        )
    assurance_level = assurance["level"]
    if assurance_level == SEALED_ASSURANCE_LEVEL:
        expected_claims = list(SEALED_ASSURANCE_CLAIMS)
    elif assurance_level == TEST_ASSURANCE_LEVEL:
        expected_claims = []
    else:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest assurance level was invalid"
        )
    if assurance["claims"] != expected_claims:
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest assurance claims were invalid"
        )
    raw_proofs = manifest["policy"].get("root_proofs")
    if type(raw_proofs) is not list or len(raw_proofs) != len(roots):
        raise RecoveryIntakeError(
            "INVALID_MANIFEST_FOR_EMIT", "manifest root proofs were invalid"
        )
    proof_paths: set[tuple[str, ...]] = set()
    present_root_identities: set[tuple[int, int]] = set()
    for proof in raw_proofs:
        if type(proof) is not dict or set(proof) != {
            "expected_identity",
            "observed_filesystem_metadata",
            "path",
            "status",
            "verification",
        }:
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "manifest root proof schema was invalid"
            )
        proof_path = _normalize_absolute_path(
            proof["path"], field="manifest.root_proof.path", require_normal_form=True
        )
        proof_key = _comparison_path_components(proof_path)
        if proof_key in proof_paths or proof_key not in root_keys:
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "manifest root proof path was invalid"
            )
        proof_paths.add(proof_key)
        proof_is_offline = proof_key in offline_root_keys
        if proof_is_offline and (
            proof["status"] != RootAvailability.OFFLINE_DECLARED_AND_ABSENT.value
        ):
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT",
                "offline-root proof did not carry offline status",
            )
        if not proof_is_offline and (
            proof["status"] != RootAvailability.PRESENT_DIRECTORY.value
        ):
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT",
                "present-root proof did not carry present status",
            )
        if proof["status"] == RootAvailability.PRESENT_DIRECTORY.value:
            expected_identity = proof["expected_identity"]
            observed_metadata = proof["observed_filesystem_metadata"]
            if (
                type(expected_identity) is not dict
                or set(expected_identity) != {"device", "inode"}
                or type(observed_metadata) is not dict
                or type(expected_identity["device"]) is not int
                or type(expected_identity["inode"]) is not int
                or observed_metadata.get("device") != expected_identity["device"]
                or observed_metadata.get("inode") != expected_identity["inode"]
            ):
                raise RecoveryIntakeError(
                    "INVALID_MANIFEST_FOR_EMIT", "present-root proof identity was invalid"
                )
            present_root_identities.add(
                (expected_identity["device"], expected_identity["inode"])
            )
        elif proof["status"] == RootAvailability.OFFLINE_DECLARED_AND_ABSENT.value:
            if (
                proof["expected_identity"] is not None
                or proof["observed_filesystem_metadata"] is not None
            ):
                raise RecoveryIntakeError(
                    "INVALID_MANIFEST_FOR_EMIT", "offline-root proof carried an identity"
                )
        else:
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "manifest root proof status was invalid"
            )
        if assurance_level == SEALED_ASSURANCE_LEVEL and (
            proof["verification"] != "SEALED_PRODUCTION_MATCHED_OR_OFFLINE_ABSENT"
        ):
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "sealed manifest root proof was not sealed"
            )
        if assurance_level == TEST_ASSURANCE_LEVEL and (
            proof["verification"] != "TEST_INJECTED_UNTRUSTED"
        ):
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "test manifest root proof was not test-only"
            )

    candidate_paths: list[str] = []
    candidate_keys: set[tuple[str, ...]] = set()
    for candidate in manifest["candidates"]:
        if type(candidate) is not dict or type(candidate.get("source_locator")) is not dict:
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "manifest candidate schema was invalid"
            )
        path = _normalize_absolute_path(
            candidate["source_locator"].get("normalized_absolute_path"),
            field="manifest.candidate.path",
            require_normal_form=True,
        )
        path_key = _comparison_path_components(path)
        if path_key in candidate_keys:
            raise RecoveryIntakeError(
                "INVALID_MANIFEST_FOR_EMIT", "manifest candidate paths were duplicated"
            )
        candidate_keys.add(path_key)
        candidate_paths.append(path)
    return _EmitPolicy(
        input_path=input_path,
        offline_roots=offline_roots,
        candidate_paths=tuple(candidate_paths),
        present_root_identities=frozenset(present_root_identities),
        assurance_level=assurance_level,
    )


def emit_manifest(
    manifest: Mapping[str, Any],
    *,
    output: str | os.PathLike[str] | None,
    stdout: TextIO | None = None,
) -> None:
    """Emit canonical JSON to stdout or an owner-only no-replace file."""

    emit_policy = _validate_manifest_for_emit(manifest)
    encoded = canonical_json_bytes(manifest) + b"\n"
    if output is None or os.fspath(output) == "-":
        stream = stdout or sys.stdout
        stream.write(encoded.decode("utf-8"))
        stream.flush()
        return
    if emit_policy.assurance_level != SEALED_ASSURANCE_LEVEL:
        raise RecoveryIntakeError(
            "FILE_OUTPUT_REQUIRES_SEALED_MANIFEST",
            "file output requires a sealed bounded production-observer manifest",
        )
    normalized_output = _normalize_absolute_path(
        os.fspath(output), field="output", require_normal_form=False
    )
    if _paths_lexically_alias(normalized_output, emit_policy.input_path) or any(
        _paths_lexically_alias(normalized_output, candidate_path)
        for candidate_path in emit_policy.candidate_paths
    ):
        raise RecoveryIntakeError(
            "OUTPUT_ALIASES_INPUT_OR_CANDIDATE",
            "output path cannot equal the input document or a candidate locator",
        )
    if any(
        _path_canonically_aliases_within(normalized_output, root)
        for root in emit_policy.offline_roots
    ):
        raise RecoveryIntakeError(
            "OUTPUT_INSIDE_ALLOWED_ROOT",
            "file output must be outside every unresolvable offline media root",
        )
    _publish_no_replace(
        normalized_output,
        encoded,
        forbidden_ancestor_identities=emit_policy.present_root_identities,
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser(
        "build", help="build a deterministic metadata-only quarantine manifest"
    )
    input_group = build_parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--probe-csv", help="strict prior-probe CSV input")
    input_group.add_argument("--path-list-json", help="strict explicit path-list JSON input")
    build_parser.add_argument("--expected-input-sha256", required=True)
    build_parser.add_argument(
        "--present-root-pin",
        action="append",
        default=[],
        metavar="PATH::DEVICE::INODE",
        help="resident allowed root plus exact st_dev/st_ino pin; repeat as needed",
    )
    build_parser.add_argument("--offline-root", action="append", default=[])
    build_parser.add_argument(
        "--observation-timeout-seconds",
        type=float,
        default=DEFAULT_OBSERVATION_TIMEOUT_SECONDS,
    )
    build_parser.add_argument(
        "--output",
        default="-",
        help="absolute no-replace output path, or '-' for stdout",
    )
    args = parser.parse_args(argv)

    if args.command != "build":
        parser.error("unsupported command")
    input_path = args.probe_csv or args.path_list_json
    input_kind = "PRIOR_PROBE_CSV" if args.probe_csv else "PATH_LIST_JSON"
    try:
        root_pins = tuple(
            _parse_present_root_pin_cli(value) for value in args.present_root_pin
        )
        manifest = build_manifest(
            input_path=input_path,
            input_kind=input_kind,
            expected_input_sha256=args.expected_input_sha256,
            present_root_pins=root_pins,
            offline_roots=args.offline_root,
            observation_timeout_seconds=args.observation_timeout_seconds,
        )
        emit_manifest(manifest, output=args.output, stdout=stdout)
    except RecoveryIntakeError as exc:
        parser.error(f"{exc.code}: {exc}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--_observe-worker":
        raise SystemExit(_observer_worker_main())
    if len(sys.argv) == 2 and sys.argv[1] == "--_input-worker":
        raise SystemExit(_input_worker_main())
    raise SystemExit(main())
