"""Fail-closed verification of one immutable dataset-artifact generation.

The caller supplies a protected immutable-store root and the exact sorted tuple
of content digests required by the dataset manifest.  The verifier derives the
generation ID from that tuple, holds one shared generation lease for the whole
batch, requires the canonical generation descriptor to declare exactly that
tuple, and stages every digest-verified object before recording its size.

Verification runs in a killable ``multiprocessing`` spawn worker.  Production
file-count, per-object, total-byte, and wall-clock limits are fixed here and are
not configurable by a dataset manifest or public caller.
"""

from __future__ import annotations

import hashlib
import json
import math
import multiprocessing
import os
import re
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

from .immutable_store import (
    ImmutableStoreError,
    generation_id_for,
    generation_read_lease,
)


SCHEMA_VERSION = "1.0"
_ARTIFACT_SET_DOMAIN = "multicourt-vision-scoring:dataset-artifact-set:v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ERROR_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")

MAX_ARTIFACT_FILES = 20_000
MAX_ARTIFACT_BYTES = 1 << 40  # 1 TiB logical bytes per artifact.
MAX_ARTIFACT_SET_BYTES = 4 << 40  # 4 TiB logical bytes in one proof set.

# Four TiB can take many hours on local spinning media. The cap remains finite
# and the parent terminates the worker at this absolute deadline even if a
# filesystem call does not return to the worker's own deadline checks.
_VERIFICATION_TIMEOUT_SECONDS = 12 * 60 * 60.0
_TERMINATE_GRACE_SECONDS = 1.0


class ArtifactVerificationError(ValueError):
    """A closed artifact-store failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require_sha256(value: object, field_name: str) -> None:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


@dataclass(frozen=True, slots=True)
class DatasetArtifactProof:
    """The verified content digest and exact staged size of one artifact."""

    sha256: str
    size_bytes: int

    def __post_init__(self) -> None:
        _require_sha256(self.sha256, "sha256")
        if (
            type(self.size_bytes) is not int
            or self.size_bytes < 0
            or self.size_bytes > MAX_ARTIFACT_BYTES
        ):
            raise ValueError(
                f"size_bytes must be an integer from 0 through {MAX_ARTIFACT_BYTES}"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {"sha256": self.sha256, "size_bytes": self.size_bytes}


def canonical_artifact_set_fingerprint(
    artifacts: tuple[DatasetArtifactProof, ...],
) -> str:
    """Return the established canonical hash of an ordered proof set.

    The fingerprint format is deliberately unchanged: the generation ID is a
    deterministic commitment to the same ordered digest tuple, while this hash
    continues to commit the verified digest/size pairs.
    """

    if type(artifacts) is not tuple:
        raise ValueError("artifacts must be an immutable tuple")
    digests: list[str] = []
    total_size = 0
    for artifact in artifacts:
        if type(artifact) is not DatasetArtifactProof:
            raise ValueError("artifacts must contain DatasetArtifactProof values")
        digests.append(artifact.sha256)
        if artifact.size_bytes > MAX_ARTIFACT_SET_BYTES - total_size:
            raise ValueError(
                f"artifact proof set exceeds {MAX_ARTIFACT_SET_BYTES} bytes"
            )
        total_size += artifact.size_bytes
    if tuple(digests) != tuple(sorted(digests)) or len(set(digests)) != len(
        digests
    ):
        raise ValueError("artifact proofs must be sorted and contain no duplicates")
    payload = {
        "artifacts": [artifact.to_canonical_dict() for artifact in artifacts],
        "domain": _ARTIFACT_SET_DOMAIN,
        "schema_version": SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class DatasetArtifactSetProof:
    """Immutable verification result for one exact leased generation."""

    generation_id: str
    artifacts: tuple[DatasetArtifactProof, ...]
    total_size_bytes: int
    canonical_set_fingerprint: str

    def __post_init__(self) -> None:
        _require_sha256(self.generation_id, "generation_id")
        if type(self.artifacts) is not tuple:
            raise ValueError("artifacts must be an immutable tuple")
        expected_total = 0
        digests: list[str] = []
        for artifact in self.artifacts:
            if type(artifact) is not DatasetArtifactProof:
                raise ValueError(
                    "artifacts must contain DatasetArtifactProof values"
                )
            digests.append(artifact.sha256)
            if artifact.size_bytes > MAX_ARTIFACT_SET_BYTES - expected_total:
                raise ValueError(
                    f"artifact proof set exceeds {MAX_ARTIFACT_SET_BYTES} bytes"
                )
            expected_total += artifact.size_bytes
        immutable_digests = tuple(digests)
        if immutable_digests != tuple(sorted(digests)) or len(set(digests)) != len(
            digests
        ):
            raise ValueError(
                "artifact proofs must be sorted and contain no duplicates"
            )
        if self.generation_id != generation_id_for(immutable_digests):
            raise ValueError(
                "generation_id does not commit the exact artifact proof digest tuple"
            )
        if (
            type(self.total_size_bytes) is not int
            or self.total_size_bytes != expected_total
        ):
            raise ValueError("total_size_bytes must equal the exact artifact total")
        _require_sha256(
            self.canonical_set_fingerprint,
            "canonical_set_fingerprint",
        )
        expected_fingerprint = canonical_artifact_set_fingerprint(self.artifacts)
        if self.canonical_set_fingerprint != expected_fingerprint:
            raise ValueError(
                "canonical_set_fingerprint does not match the artifact proofs"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        """Serialize the complete proof, including its immutable generation."""

        return {
            "artifacts": [artifact.to_canonical_dict() for artifact in self.artifacts],
            "canonical_set_fingerprint": self.canonical_set_fingerprint,
            "generation_id": self.generation_id,
            "total_size_bytes": self.total_size_bytes,
        }


@dataclass(frozen=True, slots=True)
class _VerificationLimits:
    """Private limits object used to make boundary cases inexpensive to test."""

    max_files: int
    max_file_bytes: int
    max_total_bytes: int
    timeout_seconds: float

    def __post_init__(self) -> None:
        if type(self.max_files) is not int or self.max_files < 0:
            raise ValueError("max_files must be a non-negative integer")
        if type(self.max_file_bytes) is not int or self.max_file_bytes < 1:
            raise ValueError("max_file_bytes must be a positive integer")
        if type(self.max_total_bytes) is not int or self.max_total_bytes < 0:
            raise ValueError("max_total_bytes must be a non-negative integer")
        if (
            type(self.timeout_seconds) not in {int, float}
            or self.timeout_seconds <= 0.0
            or not math.isfinite(float(self.timeout_seconds))
        ):
            raise ValueError("timeout_seconds must be positive and finite")


_PRODUCTION_LIMITS = _VerificationLimits(
    max_files=MAX_ARTIFACT_FILES,
    max_file_bytes=MAX_ARTIFACT_BYTES,
    max_total_bytes=MAX_ARTIFACT_SET_BYTES,
    timeout_seconds=_VERIFICATION_TIMEOUT_SECONDS,
)


def _validate_digest_tuple(
    artifact_sha256s: tuple[str, ...],
    *,
    limits: _VerificationLimits,
) -> None:
    if type(artifact_sha256s) is not tuple:
        raise ValueError("artifact_sha256s must be an immutable tuple")
    if len(artifact_sha256s) > limits.max_files:
        raise ArtifactVerificationError(
            "ARTIFACT_COUNT",
            f"artifact count exceeds {limits.max_files}",
        )
    for digest in artifact_sha256s:
        _require_sha256(digest, "artifact_sha256s entry")
    if artifact_sha256s != tuple(sorted(artifact_sha256s)) or len(
        set(artifact_sha256s)
    ) != len(artifact_sha256s):
        raise ValueError(
            "artifact_sha256s must be sorted and contain no duplicates"
        )


def verify_dataset_artifacts(
    artifact_sha256s: tuple[str, ...],
    *,
    artifact_store_root: Path,
) -> DatasetArtifactSetProof:
    """Verify the exact digest generation under a protected store root."""

    _validate_digest_tuple(artifact_sha256s, limits=_PRODUCTION_LIMITS)
    if not isinstance(artifact_store_root, Path):
        raise ValueError("artifact_store_root must be a pathlib.Path")
    absolute_root = Path(os.path.abspath(os.fspath(artifact_store_root)))
    return _verify_dataset_artifacts_with_limits(
        artifact_sha256s,
        artifact_store_root=absolute_root,
        limits=_PRODUCTION_LIMITS,
    )


def _verify_dataset_artifacts_with_limits(
    artifact_sha256s: tuple[str, ...],
    *,
    artifact_store_root: Path,
    limits: _VerificationLimits,
) -> DatasetArtifactSetProof:
    """Private process harness; limit injection exists only for tests."""

    _validate_digest_tuple(artifact_sha256s, limits=limits)
    if not isinstance(artifact_store_root, Path):
        raise ValueError("artifact_store_root must be a pathlib.Path")
    absolute_root = Path(os.path.abspath(os.fspath(artifact_store_root)))
    generation_id = generation_id_for(artifact_sha256s)
    deadline = time.monotonic() + limits.timeout_seconds
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    # Sizes are returned out-of-band so the status message remains below a pipe
    # buffer even at the 20,000-object production maximum.
    shared_sizes = context.RawArray("Q", max(1, len(artifact_sha256s)))
    worker = context.Process(
        target=_artifact_verification_worker,
        args=(
            str(absolute_root),
            artifact_sha256s,
            generation_id,
            limits,
            deadline,
            shared_sizes,
            sender,
        ),
        daemon=True,
    )
    started = False
    result: object | None = None
    try:
        worker.start()
        started = True
        sender.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            raise ArtifactVerificationError(
                "ARTIFACT_TIMEOUT",
                "artifact verification exceeded the absolute deadline",
            )
        worker.join(timeout=remaining)
        if worker.is_alive() or time.monotonic() >= deadline:
            raise ArtifactVerificationError(
                "ARTIFACT_TIMEOUT",
                "artifact verification exceeded the absolute deadline",
            )
        if worker.exitcode != 0:
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker exited unsuccessfully",
            )
        if not receiver.poll(0.0):
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker exited without a result",
            )
        try:
            result = receiver.recv()
        except EOFError as error:
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker exited without a result",
            ) from error
        _check_deadline(deadline)
    finally:
        receiver.close()
        sender.close()
        if started and worker.is_alive():
            worker.terminate()
            worker.join(timeout=_TERMINATE_GRACE_SECONDS)
            if worker.is_alive():
                worker.kill()
                worker.join(timeout=_TERMINATE_GRACE_SECONDS)
        if started and not worker.is_alive():
            worker.close()

    if type(result) is not dict or type(result.get("ok")) is not bool:
        raise ArtifactVerificationError(
            "ARTIFACT_WORKER",
            "artifact verification worker returned an invalid result",
        )
    if result["ok"] is not True:
        if set(result) != {"ok", "code", "message"}:
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker returned an invalid error",
            )
        code = result["code"]
        message = result["message"]
        if (
            type(code) is not str
            or _ERROR_CODE_RE.fullmatch(code) is None
            or type(message) is not str
            or not message
            or len(message) > 512
        ):
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker returned an invalid error",
            )
        raise ArtifactVerificationError(code, message)
    if set(result) != {
        "ok",
        "generation_id",
        "total_size_bytes",
        "canonical_set_fingerprint",
    }:
        raise ArtifactVerificationError(
            "ARTIFACT_WORKER",
            "artifact verification worker returned an invalid success result",
        )
    result_generation_id = result["generation_id"]
    total_size_bytes = result["total_size_bytes"]
    fingerprint = result["canonical_set_fingerprint"]
    if (
        type(result_generation_id) is not str
        or result_generation_id != generation_id
        or type(total_size_bytes) is not int
        or total_size_bytes < 0
        or total_size_bytes > limits.max_total_bytes
        or type(fingerprint) is not str
        or _SHA256_RE.fullmatch(fingerprint) is None
    ):
        raise ArtifactVerificationError(
            "ARTIFACT_WORKER",
            "artifact verification worker returned invalid proof metadata",
        )
    artifacts: list[DatasetArtifactProof] = []
    computed_total = 0
    for index, digest in enumerate(artifact_sha256s):
        if index % 1024 == 0:
            _check_deadline(deadline)
        size_bytes = int(shared_sizes[index])
        if size_bytes > limits.max_file_bytes:
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker returned an invalid artifact size",
            )
        if size_bytes > limits.max_total_bytes - computed_total:
            raise ArtifactVerificationError(
                "ARTIFACT_WORKER",
                "artifact verification worker returned an overflowing total",
            )
        computed_total += size_bytes
        artifacts.append(DatasetArtifactProof(digest, size_bytes))
    if computed_total != total_size_bytes:
        raise ArtifactVerificationError(
            "ARTIFACT_WORKER",
            "artifact verification worker returned an inconsistent total",
        )
    immutable_artifacts = tuple(artifacts)
    expected_fingerprint = canonical_artifact_set_fingerprint(immutable_artifacts)
    if fingerprint != expected_fingerprint:
        raise ArtifactVerificationError(
            "ARTIFACT_WORKER",
            "artifact verification worker returned an inconsistent fingerprint",
        )
    _check_deadline(deadline)
    return DatasetArtifactSetProof(
        generation_id=generation_id,
        artifacts=immutable_artifacts,
        total_size_bytes=total_size_bytes,
        canonical_set_fingerprint=fingerprint,
    )


def _artifact_verification_worker(
    artifact_store_root: str,
    artifact_sha256s: tuple[str, ...],
    generation_id: str,
    limits: _VerificationLimits,
    deadline: float,
    shared_sizes: Any,
    sender: Connection,
) -> None:
    try:
        proof = _verify_immutable_generation_sync(
            Path(artifact_store_root),
            artifact_sha256s,
            generation_id=generation_id,
            deadline=deadline,
            limits=limits,
        )
        for index, artifact in enumerate(proof.artifacts):
            shared_sizes[index] = artifact.size_bytes
    except ArtifactVerificationError as error:
        result = {"ok": False, "code": error.code, "message": str(error)}
    except BaseException:
        result = {
            "ok": False,
            "code": "ARTIFACT_WORKER",
            "message": "artifact verification worker failed closed",
        }
    else:
        result = {
            "ok": True,
            "generation_id": proof.generation_id,
            "total_size_bytes": proof.total_size_bytes,
            "canonical_set_fingerprint": proof.canonical_set_fingerprint,
        }
    try:
        sender.send(result)
    finally:
        sender.close()


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ArtifactVerificationError(
            "ARTIFACT_TIMEOUT",
            "artifact verification exceeded the absolute deadline",
        )


_IMMUTABLE_ERROR_CODE_MAP = {
    "PLATFORM_UNSAFE": "ARTIFACT_PLATFORM_UNSAFE",
    "STORE_SHAPE": "ARTIFACT_STORE_SHAPE",
    "LOCK_MISSING": "ARTIFACT_GENERATION_LOCK_MISSING",
    "LOCK_SHAPE": "ARTIFACT_GENERATION_LOCK_SHAPE",
    "LOCK_CHANGED": "ARTIFACT_GENERATION_LOCK_CHANGED",
    "GENERATION_BUSY": "ARTIFACT_GENERATION_BUSY",
    "DESCRIPTOR_OPEN": "ARTIFACT_GENERATION_DESCRIPTOR",
    "DESCRIPTOR_MISSING": "ARTIFACT_GENERATION_DESCRIPTOR",
    "DESCRIPTOR_SHAPE": "ARTIFACT_GENERATION_DESCRIPTOR",
    "DESCRIPTOR_CHANGED": "ARTIFACT_GENERATION_DESCRIPTOR_CHANGED",
    "GENERATION_MISMATCH": "ARTIFACT_GENERATION_MISMATCH",
    "OBJECT_UNDECLARED": "ARTIFACT_GENERATION_DESCRIPTOR",
    "OBJECT_OPEN": "ARTIFACT_OBJECT_OPEN",
    "OBJECT_SHAPE": "ARTIFACT_SHAPE",
    "OBJECT_SIZE": "ARTIFACT_SIZE",
    "OBJECT_CHANGED": "ARTIFACT_CHANGED",
    "OBJECT_REPLACED": "ARTIFACT_CHANGED",
    "OBJECT_HASH": "ARTIFACT_HASH",
    "STAGING_WRITE": "ARTIFACT_STAGING_WRITE",
}


def _translate_immutable_error(error: ImmutableStoreError) -> ArtifactVerificationError:
    code = _IMMUTABLE_ERROR_CODE_MAP.get(error.code, "ARTIFACT_STORE")
    return ArtifactVerificationError(code, f"immutable artifact store: {error}")


def _verify_immutable_generation_sync(
    artifact_store_root: Path,
    artifact_sha256s: tuple[str, ...],
    *,
    generation_id: str,
    deadline: float,
    limits: _VerificationLimits,
) -> DatasetArtifactSetProof:
    """Verify one exact generation while holding one shared read lease.

    This private entry point exists for deterministic boundary tests.  Unlike
    the retired implementation, it cannot consume a writable flat digest
    directory: the canonical descriptor, external pre-created lock, and leased
    generation layout are mandatory.
    """

    _validate_digest_tuple(artifact_sha256s, limits=limits)
    expected_generation_id = generation_id_for(artifact_sha256s)
    if generation_id != expected_generation_id:
        raise ArtifactVerificationError(
            "ARTIFACT_GENERATION_MISMATCH",
            "generation_id does not commit the requested artifact tuple",
        )
    _check_deadline(deadline)
    proofs: list[DatasetArtifactProof] = []
    total_size_bytes = 0
    try:
        with generation_read_lease(
            artifact_store_root,
            generation_id,
        ) as lease:
            _check_deadline(deadline)
            if lease.descriptor.object_sha256s != artifact_sha256s:
                raise ArtifactVerificationError(
                    "ARTIFACT_GENERATION_DESCRIPTOR",
                    "generation descriptor does not exactly match requested artifacts",
                )
            for expected_sha256 in artifact_sha256s:
                _check_deadline(deadline)
                with lease.open_verified_object(
                    expected_sha256,
                    max_bytes=limits.max_file_bytes,
                ) as staged:
                    _check_deadline(deadline)
                    staged_size = os.fstat(staged.fileno()).st_size
                    if staged_size < 0 or staged_size > limits.max_file_bytes:
                        raise ArtifactVerificationError(
                            "ARTIFACT_SIZE",
                            f"artifact exceeds {limits.max_file_bytes} bytes: "
                            f"{expected_sha256}",
                        )
                    if staged_size > limits.max_total_bytes - total_size_bytes:
                        raise ArtifactVerificationError(
                            "ARTIFACT_TOTAL_SIZE",
                            f"artifact set exceeds {limits.max_total_bytes} bytes",
                        )
                    _check_deadline(deadline)
                total_size_bytes += staged_size
                proofs.append(
                    DatasetArtifactProof(
                        sha256=expected_sha256,
                        size_bytes=staged_size,
                    )
                )
            _check_deadline(deadline)
    except ArtifactVerificationError:
        raise
    except ImmutableStoreError as error:
        raise _translate_immutable_error(error) from error
    except ValueError as error:
        # Descriptor decoding deliberately uses ValueError for malformed
        # canonical JSON. Inputs have already been validated above.
        raise ArtifactVerificationError(
            "ARTIFACT_GENERATION_DESCRIPTOR",
            "immutable artifact generation descriptor is invalid",
        ) from error

    immutable_proofs = tuple(proofs)
    return DatasetArtifactSetProof(
        generation_id=generation_id,
        artifacts=immutable_proofs,
        total_size_bytes=total_size_bytes,
        canonical_set_fingerprint=canonical_artifact_set_fingerprint(
            immutable_proofs
        ),
    )
