"""Immutable, deterministic dataset-split and asset-lineage contracts.

This module records assignments; it never chooses them. Every relationship
that can couple observations is kept in one split so derived clips, alternate
transcodes, synchronized views, and repeated views of a match cannot leak into
evaluation.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Any


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_STABLE_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SCHEMA_VERSION = "1.0"

# These bounds keep manifest validation predictably linear in both memory and
# CPU while remaining comfortably above the expected size of a curated corpus.
# ASCII identifiers make the character and UTF-8 byte bounds identical and
# avoid Unicode normalization, control-character, and display-confusable aliases.
MAX_SPLIT_IDENTIFIER_LENGTH = 128
MAX_SPLIT_RECORDS = 10_000


class DatasetSplit(str, Enum):
    """The only supported dataset partitions."""

    TRAIN = "TRAIN"
    DEV = "DEV"
    TEST = "TEST"


class SplitContractError(ValueError):
    """A manifest-level invariant failure with a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SourceSplitRecord:
    """One immutable asset assignment and all of its leakage identities."""

    asset_sha256: str
    root_asset_sha256: str
    parent_asset_sha256: str | None
    match_id: str
    venue_id: str
    camera_setup_id: str
    recording_date: str
    synchronized_capture_group_id: str
    split_group_id: str
    split: DatasetSplit

    def __post_init__(self) -> None:
        for field_name in ("asset_sha256", "root_asset_sha256"):
            value = getattr(self, field_name)
            if type(value) is not str or not _SHA256_RE.fullmatch(value):
                raise ValueError(f"{field_name} must be a lowercase SHA-256")
        if self.parent_asset_sha256 is not None and (
            type(self.parent_asset_sha256) is not str
            or not _SHA256_RE.fullmatch(self.parent_asset_sha256)
        ):
            raise ValueError("parent_asset_sha256 must be null or a lowercase SHA-256")

        for field_name in (
            "match_id",
            "venue_id",
            "camera_setup_id",
            "synchronized_capture_group_id",
            "split_group_id",
        ):
            value = getattr(self, field_name)
            if (
                type(value) is not str
                or len(value) > MAX_SPLIT_IDENTIFIER_LENGTH
                or not _STABLE_IDENTIFIER_RE.fullmatch(value)
            ):
                raise ValueError(
                    f"{field_name} must be a 1-{MAX_SPLIT_IDENTIFIER_LENGTH} character "
                    "ASCII identifier using only letters, digits, '.', '_', ':', and '-'"
                )

        if type(self.recording_date) is not str or not _ISO_DATE_RE.fullmatch(
            self.recording_date
        ):
            raise ValueError("recording_date must be an ISO-8601 calendar date (YYYY-MM-DD)")
        try:
            parsed_date = date.fromisoformat(self.recording_date)
        except ValueError as exc:
            raise ValueError(
                "recording_date must be an ISO-8601 calendar date (YYYY-MM-DD)"
            ) from exc
        if parsed_date.isoformat() != self.recording_date:
            raise ValueError("recording_date must be an ISO-8601 calendar date (YYYY-MM-DD)")

        if type(self.split) is not DatasetSplit:
            raise ValueError("split must be a DatasetSplit enum value")

        if self.parent_asset_sha256 is None and self.asset_sha256 != self.root_asset_sha256:
            raise ValueError("a root asset must have asset_sha256 equal to root_asset_sha256")
        if self.parent_asset_sha256 is not None and self.asset_sha256 == self.root_asset_sha256:
            raise ValueError("a root asset must have parent_asset_sha256 null")
        if self.parent_asset_sha256 == self.asset_sha256:
            raise ValueError("an asset cannot name itself as parent_asset_sha256")

    def to_dict(self) -> dict[str, Any]:
        """Return the JSON-safe representation used by the manifest."""

        return {
            "asset_sha256": self.asset_sha256,
            "camera_setup_id": self.camera_setup_id,
            "match_id": self.match_id,
            "parent_asset_sha256": self.parent_asset_sha256,
            "recording_date": self.recording_date,
            "root_asset_sha256": self.root_asset_sha256,
            "split": self.split.value,
            "split_group_id": self.split_group_id,
            "synchronized_capture_group_id": self.synchronized_capture_group_id,
            "venue_id": self.venue_id,
        }


@dataclass(frozen=True, slots=True)
class SplitManifest:
    """A validated, immutable set of explicit asset assignments."""

    records: tuple[SourceSplitRecord, ...]
    require_unseen_test_venue: bool = True

    def __post_init__(self) -> None:
        if type(self.records) is not tuple:
            raise ValueError("records must be an immutable tuple")
        if len(self.records) > MAX_SPLIT_RECORDS:
            raise SplitContractError(
                "SPLIT_RECORD_LIMIT_EXCEEDED",
                f"records cannot exceed {MAX_SPLIT_RECORDS} entries; "
                f"received {len(self.records)}",
            )
        if any(type(record) is not SourceSplitRecord for record in self.records):
            raise ValueError("records must contain only SourceSplitRecord values")
        if type(self.require_unseen_test_venue) is not bool:
            raise ValueError("require_unseen_test_venue must be a boolean")

        present_splits = {record.split for record in self.records}
        missing_splits = tuple(split for split in DatasetSplit if split not in present_splits)
        if missing_splits:
            names = ", ".join(split.value for split in missing_splits)
            raise SplitContractError(
                "SPLIT_MISSING_PARTITION",
                f"all dataset splits are required; missing: {names}",
            )

        records_by_asset: dict[str, SourceSplitRecord] = {}
        for record in self.records:
            if record.asset_sha256 in records_by_asset:
                raise SplitContractError(
                    "SPLIT_DUPLICATE_ASSET",
                    "duplicate asset_sha256 cannot be represented as independent records: "
                    f"{record.asset_sha256}",
                )
            records_by_asset[record.asset_sha256] = record

        self._validate_lineage(records_by_asset)
        self._reject_cross_split(
            "match_id",
            "match",
            "SPLIT_MATCH_LEAKAGE",
        )
        self._reject_cross_split(
            "synchronized_capture_group_id",
            "synchronized capture group",
            "SPLIT_SYNC_LEAKAGE",
        )
        self._reject_cross_split(
            "split_group_id",
            "declared split group",
            "SPLIT_GROUP_LEAKAGE",
        )
        self._reject_venue_camera_day_leakage()

        if self.require_unseen_test_venue:
            test_venues = {
                record.venue_id
                for record in self.records
                if record.split is DatasetSplit.TEST
            }
            development_venues = {
                record.venue_id
                for record in self.records
                if record.split in {DatasetSplit.TRAIN, DatasetSplit.DEV}
            }
            overlap = sorted(test_venues & development_venues)
            if overlap:
                raise SplitContractError(
                    "SPLIT_TEST_VENUE_LEAKAGE",
                    "TEST venues must be unseen in TRAIN and DEV: " + ", ".join(overlap),
                )

    def _validate_lineage(
        self,
        records_by_asset: dict[str, SourceSplitRecord],
    ) -> None:
        for record in self.records:
            if record.parent_asset_sha256 is None:
                continue
            root = records_by_asset.get(record.root_asset_sha256)
            if root is None:
                raise SplitContractError(
                    "SPLIT_LINEAGE_ORPHAN",
                    f"asset {record.asset_sha256!r} references a missing root asset "
                    f"{record.root_asset_sha256!r}",
                )
            parent = records_by_asset.get(record.parent_asset_sha256)
            if parent is None:
                raise SplitContractError(
                    "SPLIT_LINEAGE_ORPHAN",
                    f"asset {record.asset_sha256!r} references a missing parent asset "
                    f"{record.parent_asset_sha256!r}",
                )
            if parent.root_asset_sha256 != record.root_asset_sha256:
                raise SplitContractError(
                    "SPLIT_LINEAGE_ROOT_MISMATCH",
                    f"asset {record.asset_sha256!r} and parent "
                    f"{parent.asset_sha256!r} declare different roots",
                )
            if parent.split is not record.split:
                raise SplitContractError(
                    "SPLIT_LINEAGE_EDGE_LEAKAGE",
                    f"lineage edge {parent.asset_sha256!r} -> {record.asset_sha256!r} "
                    f"crosses {parent.split.value} and {record.split.value}",
                )

        resolved_roots: dict[str, str] = {}
        for starting_asset_sha256 in sorted(records_by_asset):
            if starting_asset_sha256 in resolved_roots:
                continue

            path: list[str] = []
            path_positions: dict[str, int] = {}
            current_asset_sha256 = starting_asset_sha256
            while current_asset_sha256 not in resolved_roots:
                cycle_start = path_positions.get(current_asset_sha256)
                if cycle_start is not None:
                    cycle = path[cycle_start:] + [current_asset_sha256]
                    raise SplitContractError(
                        "SPLIT_LINEAGE_CYCLE",
                        "asset lineage contains a cycle: "
                        + self._summarize_cycle(cycle),
                    )

                path_positions[current_asset_sha256] = len(path)
                path.append(current_asset_sha256)
                parent_sha256 = records_by_asset[
                    current_asset_sha256
                ].parent_asset_sha256
                if parent_sha256 is None:
                    resolved_root_sha256 = current_asset_sha256
                    break
                current_asset_sha256 = parent_sha256
            else:
                resolved_root_sha256 = resolved_roots[current_asset_sha256]

            for asset_sha256 in path:
                declared_root_sha256 = records_by_asset[asset_sha256].root_asset_sha256
                if declared_root_sha256 != resolved_root_sha256:
                    raise SplitContractError(
                        "SPLIT_LINEAGE_ROOT_MISMATCH",
                        f"asset {asset_sha256!r} declares root "
                        f"{declared_root_sha256!r} but its parent chain resolves to "
                        f"{resolved_root_sha256!r}",
                    )
            for asset_sha256 in reversed(path):
                resolved_roots[asset_sha256] = resolved_root_sha256

        self._reject_cross_split(
            "root_asset_sha256",
            "asset lineage family",
            "SPLIT_LINEAGE_FAMILY_LEAKAGE",
        )

    @staticmethod
    def _summarize_cycle(cycle: list[str]) -> str:
        """Return a deterministic, size-bounded description of a closed cycle."""

        cycle_nodes = cycle[:-1]
        if len(cycle_nodes) <= 8:
            return " -> ".join(cycle)
        displayed = (*cycle_nodes[:4], "...", *cycle_nodes[-4:], cycle_nodes[0])
        return f"length={len(cycle_nodes)}; " + " -> ".join(displayed)

    def _reject_cross_split(self, field_name: str, label: str, code: str) -> None:
        assigned: dict[str, DatasetSplit] = {}
        for record in self.records:
            identity = getattr(record, field_name)
            prior = assigned.setdefault(identity, record.split)
            if prior is not record.split:
                raise SplitContractError(
                    code,
                    f"cross-split {label} leakage for {identity!r}: "
                    f"{prior.value} and {record.split.value}",
                )

    def _reject_venue_camera_day_leakage(self) -> None:
        assigned: dict[tuple[str, str, str], DatasetSplit] = {}
        for record in self.records:
            identity = (
                record.venue_id,
                record.camera_setup_id,
                record.recording_date,
            )
            prior = assigned.setdefault(identity, record.split)
            if prior is not record.split:
                joined = "/".join(identity)
                raise SplitContractError(
                    "SPLIT_VENUE_CAMERA_DAY_LEAKAGE",
                    "cross-split venue-camera-day leakage for "
                    f"{joined!r}: {prior.value} and {record.split.value}",
                )

    def to_dict(self) -> dict[str, Any]:
        """Return a canonicalizable representation with deterministic ordering."""

        ordered_records = sorted(self.records, key=lambda record: record.asset_sha256)
        return {
            "policies": {
                "require_unseen_test_venue": self.require_unseen_test_venue,
            },
            "records": [record.to_dict() for record in ordered_records],
            "schema_version": _SCHEMA_VERSION,
        }

    def canonical_json(self) -> str:
        """Return the stable UTF-8 JSON text used for content addressing."""

        return json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def fingerprint(self) -> str:
        """Return a stable SHA-256 of the canonical manifest JSON."""

        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()
