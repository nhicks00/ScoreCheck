"""Bounded structural verification for readiness label-pack generations.

This module deliberately produces evidence, not training admission.  The
public batch entry point accepts only immutable-store coordinates and verifies
the complete batch in one killable spawn worker.  Callers cannot inject
preconstructed pack evidence or proof values.
"""

from __future__ import annotations

import multiprocessing
import os
import re
import selectors
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, Mapping

from .artifact_store import MAX_ARTIFACT_FILES
from .ball_label_pack import (
    MAX_BALL_LABEL_PACK_CONTRACT_BYTES,
    MAX_BALL_LABEL_PACK_OBJECTS,
    BallLabelPackError,
    load_ball_label_pack,
)
from .contract_wire import (
    CanonicalWireError,
    canonical_json_bytes,
    parse_canonical_json_object,
)
from .dataset_split import DatasetSplit
from .immutable_store import ImmutableStoreError, generation_read_lease
from .label_bundle import LabelBundleSplit


MAX_READINESS_LABEL_PACKS = 512
MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS = 1_000_000
MAX_READINESS_LABEL_PACK_CONTRACT_BYTES = 4 * 1024 * 1024 * 1024
# Fixed worker verification/result budget, started after spawn bootstrap returns.
READINESS_LABEL_PACK_TIMEOUT_SECONDS = 3600.0

_MAX_WORKER_MESSAGE_CHARS = 1024
_MAX_WORKER_RESULT_BYTES = 2 * 1024 * 1024
_WORKER_FRAME_HEADER_BYTES = 8
_WORKER_READ_CHUNK_BYTES = 64 * 1024
_TERMINATE_GRACE_SECONDS = 1.0
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_ERROR_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class ReadinessLabelPackError(ValueError):
    """Fail-closed batch error with a stable readiness issue code."""

    def __init__(self, code: str, message: str) -> None:
        if type(code) is not str or _ERROR_CODE_RE.fullmatch(code) is None:
            code = "LABEL_PACK_WORKER_FAILURE"
        if type(message) is not str or not message:
            message = "label-pack verification failed closed"
        self.code = code
        super().__init__(message[:_MAX_WORKER_MESSAGE_CHARS])


def _fail(code: str, message: str) -> None:
    raise ReadinessLabelPackError(code, message)


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


@dataclass(frozen=True, slots=True)
class SourceLabelPackProof:
    """Compact structural proof for one source's exact label pack.

    The proof has no admission property.  It is safe to serialize only as a
    record of what the bounded verifier reconstructed from immutable storage.
    """

    source_id: str
    asset_sha256: str
    labels_sha256: str
    label_pack_generation_id: str
    split: DatasetSplit
    label_bundle_statement_sha256: str
    curator_attestation_sha256: str
    curator_trust_snapshot_sha256: str
    annotation_attestation_set_sha256: str
    contract_object_count: int
    total_contract_bytes: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False

    def __post_init__(self) -> None:
        if type(self.source_id) is not str or _STABLE_ID_RE.fullmatch(
            self.source_id
        ) is None:
            raise ValueError("label-pack proof requires an ASCII-stable source_id")
        for field_name in (
            "asset_sha256",
            "labels_sha256",
            "label_pack_generation_id",
            "label_bundle_statement_sha256",
            "curator_attestation_sha256",
            "curator_trust_snapshot_sha256",
            "annotation_attestation_set_sha256",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        if type(self.split) is not DatasetSplit:
            raise ValueError("label-pack proof split must be a DatasetSplit")
        if (
            type(self.contract_object_count) is not int
            or not 1
            <= self.contract_object_count
            <= MAX_BALL_LABEL_PACK_OBJECTS
        ):
            raise ValueError("label-pack proof contract_object_count is invalid")
        if (
            type(self.total_contract_bytes) is not int
            or not 1
            <= self.total_contract_bytes
            <= MAX_BALL_LABEL_PACK_CONTRACT_BYTES
        ):
            raise ValueError("label-pack proof total_contract_bytes is invalid")
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            if type(getattr(self, field_name)) is not bool or getattr(
                self, field_name
            ) is not False:
                raise ValueError(
                    "label-pack structural proof admission flags must be exactly false"
                )

    def to_dict(self) -> dict[str, Any]:
        return {
            "admissible_for_deployment": self.admissible_for_deployment,
            "admissible_for_evaluation": self.admissible_for_evaluation,
            "admissible_for_live_scoring": self.admissible_for_live_scoring,
            "admissible_for_test": self.admissible_for_test,
            "admissible_for_training": self.admissible_for_training,
            "annotation_attestation_set_sha256": (
                self.annotation_attestation_set_sha256
            ),
            "asset_sha256": self.asset_sha256,
            "contract_object_count": self.contract_object_count,
            "curator_attestation_sha256": self.curator_attestation_sha256,
            "curator_trust_snapshot_sha256": (
                self.curator_trust_snapshot_sha256
            ),
            "label_bundle_statement_sha256": (
                self.label_bundle_statement_sha256
            ),
            "label_pack_generation_id": self.label_pack_generation_id,
            "labels_sha256": self.labels_sha256,
            "source_id": self.source_id,
            "split": self.split.value,
            "total_contract_bytes": self.total_contract_bytes,
        }

    @classmethod
    def from_worker_dict(cls, value: object) -> "SourceLabelPackProof":
        fields = {
            "source_id",
            "asset_sha256",
            "labels_sha256",
            "label_pack_generation_id",
            "split",
            "label_bundle_statement_sha256",
            "curator_attestation_sha256",
            "curator_trust_snapshot_sha256",
            "annotation_attestation_set_sha256",
            "contract_object_count",
            "total_contract_bytes",
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        }
        if type(value) is not dict or set(value) != fields:
            raise ValueError("label-pack worker proof has an invalid exact schema")
        try:
            if type(value["split"]) is not str:
                raise ValueError("label-pack worker split must be a string")
            split = DatasetSplit(value["split"])
            return cls(
                source_id=value["source_id"],
                asset_sha256=value["asset_sha256"],
                labels_sha256=value["labels_sha256"],
                label_pack_generation_id=value["label_pack_generation_id"],
                split=split,
                label_bundle_statement_sha256=(
                    value["label_bundle_statement_sha256"]
                ),
                curator_attestation_sha256=value["curator_attestation_sha256"],
                curator_trust_snapshot_sha256=(
                    value["curator_trust_snapshot_sha256"]
                ),
                annotation_attestation_set_sha256=(
                    value["annotation_attestation_set_sha256"]
                ),
                contract_object_count=value["contract_object_count"],
                total_contract_bytes=value["total_contract_bytes"],
                admissible_for_training=value["admissible_for_training"],
                admissible_for_evaluation=value["admissible_for_evaluation"],
                admissible_for_test=value["admissible_for_test"],
                admissible_for_deployment=value["admissible_for_deployment"],
                admissible_for_live_scoring=(
                    value["admissible_for_live_scoring"]
                ),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("label-pack worker proof fields are invalid") from exc


@dataclass(frozen=True, slots=True)
class _SourceLabelPackRequest:
    source_id: str
    asset_sha256: str
    labels_sha256: str
    label_pack_generation_id: str
    split: DatasetSplit

    def __post_init__(self) -> None:
        if type(self.source_id) is not str or _STABLE_ID_RE.fullmatch(
            self.source_id
        ) is None:
            raise ValueError("label-pack request requires an ASCII-stable source_id")
        for field_name in (
            "asset_sha256",
            "labels_sha256",
            "label_pack_generation_id",
        ):
            _require_sha256(getattr(self, field_name), field_name)
        if type(self.split) is not DatasetSplit:
            raise ValueError("label-pack request split must be a DatasetSplit")

    def to_worker_tuple(self) -> tuple[str, str, str, str, str]:
        return (
            self.source_id,
            self.asset_sha256,
            self.labels_sha256,
            self.label_pack_generation_id,
            self.split.value,
        )


def _validate_requests(
    requests: tuple[_SourceLabelPackRequest, ...],
) -> None:
    if type(requests) is not tuple or any(
        type(item) is not _SourceLabelPackRequest for item in requests
    ):
        raise ValueError("label-pack requests must be an immutable request tuple")
    if not 1 <= len(requests) <= MAX_READINESS_LABEL_PACKS:
        raise ValueError(
            "label-pack requests must contain 1 through "
            f"{MAX_READINESS_LABEL_PACKS} entries"
        )
    source_ids = [item.source_id for item in requests]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("label-pack request source IDs must be unique")


def _validate_artifact_digests(digests: tuple[str, ...]) -> None:
    if (
        type(digests) is not tuple
        or any(
            type(item) is not str or _SHA256_RE.fullmatch(item) is None
            for item in digests
        )
        or digests != tuple(sorted(set(digests)))
        or len(digests) > MAX_ARTIFACT_FILES
    ):
        raise ValueError(
            "media/capture artifact digests must be a sorted unique SHA-256 tuple"
        )


def source_label_pack_proof_set_sha256(
    proofs: tuple[SourceLabelPackProof, ...],
    *,
    report_schema_version: str,
) -> str:
    """Commit a bounded proof set without importing readiness (no cycle)."""

    import hashlib

    if type(proofs) is not tuple or any(
        type(item) is not SourceLabelPackProof for item in proofs
    ):
        raise ValueError("source label-pack proofs must be an immutable tuple")
    if len(proofs) > MAX_READINESS_LABEL_PACKS:
        raise ValueError("source label-pack proof set exceeds the fixed bound")
    source_ids = [item.source_id for item in proofs]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("source label-pack proof IDs must be unique")
    payload = {
        "domain": "multicourt-vision-scoring:source-label-pack-proof-set:v1",
        "proofs": [
            item.to_dict() for item in sorted(proofs, key=lambda item: item.source_id)
        ],
        "schema_version": report_schema_version,
    }
    return hashlib.sha256(
        canonical_json_bytes(
            payload,
            label="source label-pack proof set",
            maximum_bytes=2 * 1024 * 1024,
        )
    ).hexdigest()


def _write_worker_result_frame(sender: Connection, result: dict[str, Any]) -> None:
    """Write one bounded canonical JSON frame without pickle."""

    raw = canonical_json_bytes(
        result,
        label="label-pack worker result",
        maximum_bytes=_MAX_WORKER_RESULT_BYTES,
    )
    frame = len(raw).to_bytes(_WORKER_FRAME_HEADER_BYTES, "big") + raw
    descriptor = sender.fileno()
    offset = 0
    while offset < len(frame):
        try:
            written = os.write(descriptor, frame[offset:])
        except InterruptedError:
            continue
        if type(written) is not int or written <= 0:
            raise OSError("label-pack worker frame could not be written")
        offset += written


def _read_worker_result_frame(
    receiver: Connection,
    *,
    deadline: float,
) -> dict[str, Any]:
    """Drain one framed worker result from a nonblocking FD by a deadline."""

    if type(deadline) is not float or deadline <= 0.0:
        raise ValueError("worker frame deadline must be a positive float")
    try:
        descriptor = receiver.fileno()
        if type(descriptor) is not int or descriptor < 0:
            raise OSError("invalid pipe descriptor")
        os.set_blocking(descriptor, False)
    except Exception as exc:
        raise ReadinessLabelPackError(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack result descriptor is unavailable",
        ) from exc

    selector = selectors.DefaultSelector()
    frame = bytearray()
    expected_payload_bytes: int | None = None
    try:
        try:
            selector.register(descriptor, selectors.EVENT_READ)
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack result descriptor could not be monitored",
            ) from exc
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _fail(
                    "LABEL_PACK_WORKER_TIMEOUT",
                    "label-pack verification exceeded the absolute deadline",
                )
            try:
                events = selector.select(timeout=remaining)
            except Exception as exc:
                raise ReadinessLabelPackError(
                    "LABEL_PACK_WORKER_PROTOCOL",
                    "label-pack result descriptor monitoring failed",
                ) from exc
            if not events:
                _fail(
                    "LABEL_PACK_WORKER_TIMEOUT",
                    "label-pack verification exceeded the absolute deadline",
                )
            if expected_payload_bytes is None:
                read_size = _WORKER_READ_CHUNK_BYTES
            else:
                frame_bytes = (
                    _WORKER_FRAME_HEADER_BYTES + expected_payload_bytes
                )
                unread = frame_bytes - len(frame)
                read_size = min(
                    _WORKER_READ_CHUNK_BYTES,
                    unread if unread > 0 else 1,
                )
            try:
                chunk = os.read(descriptor, read_size)
            except BlockingIOError:
                continue
            except OSError as exc:
                raise ReadinessLabelPackError(
                    "LABEL_PACK_WORKER_PROTOCOL",
                    "label-pack result frame could not be read",
                ) from exc
            if not chunk:
                if expected_payload_bytes is None:
                    _fail(
                        "LABEL_PACK_WORKER_PROTOCOL",
                        "label-pack worker result has a truncated header",
                    )
                expected_frame_bytes = (
                    _WORKER_FRAME_HEADER_BYTES + expected_payload_bytes
                )
                if len(frame) != expected_frame_bytes:
                    _fail(
                        "LABEL_PACK_WORKER_PROTOCOL",
                        "label-pack worker result has a truncated payload",
                    )
                raw = bytes(frame[_WORKER_FRAME_HEADER_BYTES:])
                try:
                    return parse_canonical_json_object(
                        raw,
                        label="label-pack worker result",
                        maximum_bytes=_MAX_WORKER_RESULT_BYTES,
                        maximum_depth=5,
                        maximum_nodes=20_000,
                        maximum_containers=1_024,
                    )
                except (CanonicalWireError, ValueError) as exc:
                    raise ReadinessLabelPackError(
                        "LABEL_PACK_WORKER_PROTOCOL",
                        "label-pack worker result is not strict canonical JSON",
                    ) from exc
            frame.extend(chunk)
            if (
                expected_payload_bytes is None
                and len(frame) >= _WORKER_FRAME_HEADER_BYTES
            ):
                expected_payload_bytes = int.from_bytes(
                    frame[:_WORKER_FRAME_HEADER_BYTES],
                    "big",
                )
                if not 1 <= expected_payload_bytes <= _MAX_WORKER_RESULT_BYTES:
                    _fail(
                        "LABEL_PACK_WORKER_PROTOCOL",
                        "label-pack worker result length is outside the fixed bound",
                    )
            if expected_payload_bytes is not None and len(frame) > (
                _WORKER_FRAME_HEADER_BYTES + expected_payload_bytes
            ):
                _fail(
                    "LABEL_PACK_WORKER_PROTOCOL",
                    "label-pack worker result contains trailing frame bytes",
                )
    finally:
        try:
            selector.close()
        except Exception:
            pass


def verify_source_label_pack_batch(
    *,
    label_store_root: Path,
    requests: tuple[_SourceLabelPackRequest, ...],
    media_capture_artifact_sha256s: tuple[str, ...],
) -> tuple[SourceLabelPackProof, ...]:
    """Verify the complete bounded request batch in one killable spawn worker."""

    if not isinstance(label_store_root, Path):
        raise ValueError("label_store_root must be a pathlib.Path")
    _validate_requests(requests)
    _validate_artifact_digests(media_capture_artifact_sha256s)
    absolute_root = Path(os.path.abspath(os.fspath(label_store_root)))
    worker_requests = tuple(item.to_worker_tuple() for item in requests)
    receiver: Connection | None = None
    sender: Connection | None = None
    worker: Any = None
    started = False
    result: object | None = None
    try:
        try:
            context = multiprocessing.get_context("spawn")
            receiver, sender = context.Pipe(duplex=False)
            worker = context.Process(
                target=_label_pack_batch_worker,
                args=(
                    sender,
                    os.fspath(absolute_root),
                    worker_requests,
                    media_capture_artifact_sha256s,
                    READINESS_LABEL_PACK_TIMEOUT_SECONDS,
                ),
            )
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_START",
                "label-pack worker IPC could not be initialized",
            ) from exc
        # Mark the attempt before invoking multiprocessing so even a partial
        # start failure reaches terminate/kill cleanup.
        started = True
        try:
            worker.start()
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_START",
                "label-pack worker could not be started",
            ) from exc
        # Spawn bootstrap is a separately fail-closed setup step. The fixed
        # verification/result deadline begins immediately after start returns.
        deadline = time.monotonic() + READINESS_LABEL_PACK_TIMEOUT_SECONDS
        try:
            sender.close()
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack parent sender could not be closed",
            ) from exc
        result = _read_worker_result_frame(receiver, deadline=deadline)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail(
                "LABEL_PACK_WORKER_TIMEOUT",
                "label-pack verification exceeded the absolute deadline",
            )
        try:
            worker.join(timeout=remaining)
            alive = worker.is_alive()
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack worker lifecycle check failed",
            ) from exc
        if alive or time.monotonic() >= deadline:
            _fail(
                "LABEL_PACK_WORKER_TIMEOUT",
                "label-pack worker did not exit before the absolute deadline",
            )
        try:
            exitcode = worker.exitcode
        except Exception as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack worker exit status is unavailable",
            ) from exc
        if exitcode != 0:
            _fail(
                "LABEL_PACK_WORKER_EXIT",
                "label-pack worker exited unsuccessfully",
            )
    finally:
        # Cleanup is deliberately best-effort and ordered so a broken close or
        # lifecycle probe cannot prevent termination/kill of a started child.
        if sender is not None:
            try:
                sender.close()
            except Exception:
                pass
        if started and worker is not None:
            try:
                alive = worker.is_alive()
            except Exception:
                alive = True
            if alive:
                try:
                    worker.terminate()
                except Exception:
                    pass
                try:
                    worker.join(timeout=_TERMINATE_GRACE_SECONDS)
                except Exception:
                    pass
                try:
                    alive = worker.is_alive()
                except Exception:
                    alive = True
                if alive:
                    try:
                        worker.kill()
                    except Exception:
                        pass
                    try:
                        worker.join(timeout=_TERMINATE_GRACE_SECONDS)
                    except Exception:
                        pass
            try:
                worker.close()
            except Exception:
                pass
        if receiver is not None:
            try:
                receiver.close()
            except Exception:
                pass

    if result is None:
        _fail(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker returned no result",
        )
    return _validate_worker_result(result, requests=requests)


def _validate_worker_result(
    result: object,
    *,
    requests: tuple[_SourceLabelPackRequest, ...],
) -> tuple[SourceLabelPackProof, ...]:
    """Reject forged, oversized, or coordinate-inconsistent worker IPC."""

    _validate_requests(requests)
    if type(result) is not dict or type(result.get("ok")) is not bool:
        _fail("LABEL_PACK_WORKER_PROTOCOL", "label-pack worker result is invalid")
    if result["ok"] is False:
        if set(result) != {"ok", "code", "message"}:
            _fail(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack worker error result has an invalid schema",
            )
        code = result["code"]
        message = result["message"]
        if (
            type(code) is not str
            or _ERROR_CODE_RE.fullmatch(code) is None
            or type(message) is not str
            or not message
            or len(message) > _MAX_WORKER_MESSAGE_CHARS
        ):
            _fail(
                "LABEL_PACK_WORKER_PROTOCOL",
                "label-pack worker error fields are invalid",
            )
        raise ReadinessLabelPackError(code, message)
    if set(result) != {
        "ok",
        "proofs",
        "contract_object_count",
        "total_contract_bytes",
    }:
        _fail(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker success result has an invalid schema",
        )
    raw_proofs = result["proofs"]
    if type(raw_proofs) is not list or len(raw_proofs) != len(requests):
        _fail(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker returned the wrong proof cardinality",
        )
    try:
        proofs = tuple(SourceLabelPackProof.from_worker_dict(item) for item in raw_proofs)
    except ValueError as exc:
        raise ReadinessLabelPackError(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker returned an invalid proof",
        ) from exc
    expected = tuple(item.to_worker_tuple() for item in requests)
    actual = tuple(
        (
            item.source_id,
            item.asset_sha256,
            item.labels_sha256,
            item.label_pack_generation_id,
            item.split.value,
        )
        for item in proofs
    )
    if actual != expected:
        _fail(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker proofs do not match the exact request sequence",
        )
    count = sum(item.contract_object_count for item in proofs)
    size = sum(item.total_contract_bytes for item in proofs)
    if (
        count > MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS
        or size > MAX_READINESS_LABEL_PACK_CONTRACT_BYTES
        or type(result["contract_object_count"]) is not int
        or type(result["total_contract_bytes"]) is not int
        or result["contract_object_count"] != count
        or result["total_contract_bytes"] != size
    ):
        _fail(
            "LABEL_PACK_WORKER_PROTOCOL",
            "label-pack worker aggregate commitments are invalid",
        )
    return proofs


def _request_from_worker_tuple(value: object) -> _SourceLabelPackRequest:
    if type(value) is not tuple or len(value) != 5:
        raise ValueError("label-pack worker request tuple is invalid")
    if type(value[4]) is not str:
        raise ValueError("label-pack worker split must be a string")
    return _SourceLabelPackRequest(
        source_id=value[0],
        asset_sha256=value[1],
        labels_sha256=value[2],
        label_pack_generation_id=value[3],
        split=DatasetSplit(value[4]),
    )


def _label_pack_batch_worker(
    sender: Connection,
    label_store_root: str,
    worker_requests: tuple[tuple[str, str, str, str, str], ...],
    media_capture_artifact_sha256s: tuple[str, ...],
    timeout_seconds: float,
) -> None:
    try:
        if type(timeout_seconds) is not float or timeout_seconds <= 0.0:
            raise ValueError("worker timeout must be a positive float")
        deadline = time.monotonic() + timeout_seconds
        requests = tuple(_request_from_worker_tuple(item) for item in worker_requests)
        proofs = _verify_source_label_pack_batch_sync(
            label_store_root=Path(label_store_root),
            requests=requests,
            media_capture_artifact_sha256s=media_capture_artifact_sha256s,
            deadline=deadline,
        )
        result: dict[str, Any] = {
            "ok": True,
            "proofs": [item.to_dict() for item in proofs],
            "contract_object_count": sum(
                item.contract_object_count for item in proofs
            ),
            "total_contract_bytes": sum(item.total_contract_bytes for item in proofs),
        }
    except ReadinessLabelPackError as exc:
        result = {
            "ok": False,
            "code": exc.code,
            "message": str(exc)[:_MAX_WORKER_MESSAGE_CHARS],
        }
    except (OSError, TypeError, ValueError):
        result = {
            "ok": False,
            "code": "LABEL_PACK_WORKER_FAILURE",
            "message": "label-pack worker failed closed",
        }
    try:
        _write_worker_result_frame(sender, result)
    finally:
        sender.close()


def _verify_source_label_pack_batch_sync(
    *,
    label_store_root: Path,
    requests: tuple[_SourceLabelPackRequest, ...],
    media_capture_artifact_sha256s: tuple[str, ...],
    deadline: float | None = None,
) -> tuple[SourceLabelPackProof, ...]:
    """Private deterministic core used by the spawn worker and focused tests."""

    if not isinstance(label_store_root, Path):
        raise ValueError("label_store_root must be a pathlib.Path")
    _validate_requests(requests)
    _validate_artifact_digests(media_capture_artifact_sha256s)
    if deadline is not None and (
        type(deadline) is not float or not deadline > 0.0
    ):
        raise ValueError("deadline must be a positive monotonic float or null")
    artifacts = frozenset(media_capture_artifact_sha256s)
    proofs: list[SourceLabelPackProof] = []
    aggregate_count = 0
    aggregate_bytes = 0
    seen_contract_is_curator_snapshot: dict[str, bool] = {}
    for request in requests:
        if deadline is not None and time.monotonic() >= deadline:
            _fail(
                "LABEL_PACK_WORKER_TIMEOUT",
                "label-pack verification exceeded the absolute deadline",
            )
        # Descriptor cardinality can be bounded before expensive contract
        # staging.  Contract byte sizes are intentionally absent from the
        # immutable descriptor, so reserve one complete per-pack byte budget
        # before starting the next load.  This ensures verified work never
        # crosses the advertised 4 GiB aggregate even for a maximal pack.
        if aggregate_bytes > (
            MAX_READINESS_LABEL_PACK_CONTRACT_BYTES
            - MAX_BALL_LABEL_PACK_CONTRACT_BYTES
        ):
            _fail(
                "LABEL_PACK_AGGREGATE_BYTES",
                "label-pack batch lacks the fixed safety reserve for another pack",
            )
        try:
            with generation_read_lease(
                label_store_root,
                request.label_pack_generation_id,
            ) as preflight_lease:
                declared_object_count = len(
                    preflight_lease.descriptor.object_sha256s
                )
        except ImmutableStoreError as exc:
            raise ReadinessLabelPackError(
                "LABEL_PACK_PREFLIGHT_STORE",
                "label-pack generation descriptor preflight failed closed",
            ) from exc
        if (
            aggregate_count + declared_object_count
            > MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS
        ):
            _fail(
                "LABEL_PACK_AGGREGATE_OBJECTS",
                "label-pack batch exceeds the aggregate contract-object bound",
            )
        if deadline is not None and time.monotonic() >= deadline:
            _fail(
                "LABEL_PACK_WORKER_TIMEOUT",
                "label-pack verification exceeded the absolute deadline",
            )
        try:
            evidence = load_ball_label_pack(
                label_store_root=label_store_root,
                generation_id=request.label_pack_generation_id,
                pack_sha256=request.labels_sha256,
            )
        except BallLabelPackError as exc:
            raise ReadinessLabelPackError(exc.code, str(exc)) from exc
        if (
            evidence.generation_id != request.label_pack_generation_id
            or evidence.pack_sha256 != request.labels_sha256
        ):
            _fail(
                "LABEL_PACK_COORDINATE_MISMATCH",
                "loaded pack differs from the requested root or generation",
            )
        if evidence.statement.source_asset_sha256 != request.asset_sha256:
            _fail(
                "LABEL_PACK_SOURCE_MISMATCH",
                "label bundle statement binds a different source asset",
            )
        expected_split = LabelBundleSplit(request.split.value)
        if evidence.statement.split is not expected_split:
            _fail(
                "LABEL_PACK_SPLIT_MISMATCH",
                "label bundle statement binds a different split",
            )
        if any(
            (
                evidence.admissible_for_training,
                evidence.admissible_for_evaluation,
                evidence.admissible_for_test,
                evidence.admissible_for_deployment,
                evidence.admissible_for_live_scoring,
            )
        ):
            _fail(
                "LABEL_PACK_ADMISSION_STATE",
                "structural label-pack evidence must grant no admission",
            )
        if artifacts.intersection(evidence.contract_object_sha256s):
            _fail(
                "LABEL_PACK_ARTIFACT_OVERLAP",
                "media/capture artifacts overlap the label contract closure",
            )
        current_snapshot_sha256 = (
            evidence.curator_trust_snapshot.fingerprint()
        )
        for digest in evidence.contract_object_sha256s:
            current_is_snapshot = digest == current_snapshot_sha256
            if digest in seen_contract_is_curator_snapshot and not (
                seen_contract_is_curator_snapshot[digest]
                and current_is_snapshot
            ):
                _fail(
                    "LABEL_PACK_CROSS_GENERATION_ALIAS",
                    "label-pack generations share a contract digest outside "
                    "the exact curator trust snapshot role",
                )
        next_count = aggregate_count + len(evidence.contract_object_sha256s)
        next_bytes = aggregate_bytes + evidence.total_contract_bytes
        if next_count > MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS:
            _fail(
                "LABEL_PACK_AGGREGATE_OBJECTS",
                "label-pack batch exceeds the aggregate contract-object bound",
            )
        if next_bytes > MAX_READINESS_LABEL_PACK_CONTRACT_BYTES:
            _fail(
                "LABEL_PACK_AGGREGATE_BYTES",
                "label-pack batch exceeds the aggregate verified-byte bound",
            )
        aggregate_count = next_count
        aggregate_bytes = next_bytes
        for digest in evidence.contract_object_sha256s:
            seen_contract_is_curator_snapshot[digest] = (
                digest == current_snapshot_sha256
            )
        proofs.append(
            SourceLabelPackProof(
                source_id=request.source_id,
                asset_sha256=request.asset_sha256,
                labels_sha256=request.labels_sha256,
                label_pack_generation_id=request.label_pack_generation_id,
                split=request.split,
                label_bundle_statement_sha256=evidence.statement.fingerprint(),
                curator_attestation_sha256=(
                    evidence.curator_attestation.fingerprint()
                ),
                curator_trust_snapshot_sha256=(
                    evidence.curator_trust_snapshot.fingerprint()
                ),
                annotation_attestation_set_sha256=(
                    evidence.statement.annotation_attestation_set_sha256
                ),
                contract_object_count=len(evidence.contract_object_sha256s),
                total_contract_bytes=evidence.total_contract_bytes,
            )
        )
        if deadline is not None and time.monotonic() >= deadline:
            _fail(
                "LABEL_PACK_WORKER_TIMEOUT",
                "label-pack verification exceeded the absolute deadline",
            )
    return tuple(proofs)


__all__ = [
    "MAX_READINESS_LABEL_PACKS",
    "MAX_READINESS_LABEL_PACK_CONTRACT_BYTES",
    "MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS",
    "READINESS_LABEL_PACK_TIMEOUT_SECONDS",
    "ReadinessLabelPackError",
    "SourceLabelPackProof",
    "verify_source_label_pack_batch",
]
