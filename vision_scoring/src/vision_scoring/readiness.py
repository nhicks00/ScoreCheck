"""Validate capture, data-rights, and split readiness before model training."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from datetime import date
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class Severity(str, Enum):
    BLOCKER = "BLOCKER"
    WARNING = "WARNING"


class CaptureMode(str, Enum):
    HD_1080P30 = "1080P30"
    UHD_4K60 = "4K60"
    DUAL_4K60 = "DUAL_4K60"


class RightsStatus(str, Enum):
    OWNED = "OWNED"
    LICENSED = "LICENSED"
    PUBLIC_DOMAIN = "PUBLIC_DOMAIN"
    UNKNOWN = "UNKNOWN"
    RESTRICTED = "RESTRICTED"
    RESEARCH_ONLY = "RESEARCH_ONLY"


class DatasetSplit(str, Enum):
    TRAIN = "TRAIN"
    DEV = "DEV"
    TEST = "TEST"


@dataclass(frozen=True, slots=True)
class ReadinessIssue:
    code: str
    severity: Severity
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class ReadinessReport:
    schema_version: str
    issues: tuple[ReadinessIssue, ...]

    @property
    def blockers(self) -> tuple[ReadinessIssue, ...]:
        return tuple(issue for issue in self.issues if issue.severity is Severity.BLOCKER)

    @property
    def warnings(self) -> tuple[ReadinessIssue, ...]:
        return tuple(issue for issue in self.issues if issue.severity is Severity.WARNING)

    @property
    def ready(self) -> bool:
        return not self.blockers

    def to_dict(self) -> dict[str, Any]:
        def issue_dict(issue: ReadinessIssue) -> dict[str, str]:
            return {
                "code": issue.code,
                "severity": issue.severity.value,
                "path": issue.path,
                "message": issue.message,
            }

        return {
            "schema_version": self.schema_version,
            "ready": self.ready,
            "blockers": [issue_dict(issue) for issue in self.blockers],
            "warnings": [issue_dict(issue) for issue in self.warnings],
        }


class ManifestValidator:
    """Fail-closed validation for the pre-training readiness manifest."""

    _TOP_LEVEL_FIELDS = frozenset(
        {"schema_version", "capture_profiles", "data_sources", "policies"}
    )
    _CAPTURE_FIELDS = frozenset(
        {
            "profile_id",
            "mode",
            "width",
            "height",
            "fps",
            "camera_count",
            "bitrate_mbps",
            "shutter_reciprocal",
            "far_ball_processed_pixels_p10",
            "human_resolvable_visible_ball_ratio",
            "visible_serve_frames_meeting_pixel_gate_ratio",
            "sampled_visible_ball_frames",
            "timestamp_regressions",
            "critical_unexplained_drop_events",
            "service_zones_fully_visible",
            "fixed_mount",
            "calibration_profile_sha256",
            "exposure_sync_p95_ms",
        }
    )
    _SOURCE_FIELDS = frozenset(
        {
            "source_id",
            "match_id",
            "venue_id",
            "capture_profile_id",
            "camera_id",
            "recording_date",
            "ball_design_id",
            "lighting_condition",
            "split_group_id",
            "split",
            "rights_status",
            "rights_ref",
            "media_sha256",
            "labels_sha256",
        }
    )
    _POLICY_FIELDS = frozenset({"require_unseen_test_venue"})

    def validate(self, manifest: Mapping[str, Any]) -> ReadinessReport:
        issues: list[ReadinessIssue] = []
        self._reject_unknown_fields(manifest, self._TOP_LEVEL_FIELDS, "manifest", issues)
        schema_version = manifest.get("schema_version")
        if schema_version != "1.0":
            self._block(issues, "SCHEMA_VERSION", "schema_version", "expected schema_version 1.0")
            schema_version = str(schema_version or "unknown")

        capture_profiles = manifest.get("capture_profiles")
        if not isinstance(capture_profiles, list) or not capture_profiles:
            self._block(
                issues,
                "CAPTURE_PROFILES",
                "capture_profiles",
                "at least one capture profile is required",
            )
        else:
            self._validate_capture_profiles(capture_profiles, issues)
        capture_profile_ids = {
            profile.get("profile_id")
            for profile in capture_profiles or []
            if isinstance(profile, Mapping) and isinstance(profile.get("profile_id"), str)
        }

        data_sources = manifest.get("data_sources")
        if not isinstance(data_sources, list) or not data_sources:
            self._block(issues, "DATA_SOURCES", "data_sources", "at least one data source is required")
        else:
            self._validate_data_sources(
                data_sources,
                manifest.get("policies", {}),
                capture_profile_ids,
                issues,
            )

        return ReadinessReport(schema_version=schema_version, issues=tuple(issues))

    def _validate_capture_profiles(
        self,
        profiles: Sequence[Mapping[str, Any]],
        issues: list[ReadinessIssue],
    ) -> None:
        seen_ids: set[str] = set()
        for index, profile in enumerate(profiles):
            path = f"capture_profiles[{index}]"
            if not isinstance(profile, Mapping):
                self._block(issues, "CAPTURE_SHAPE", path, "capture profile must be an object")
                continue
            self._reject_unknown_fields(profile, self._CAPTURE_FIELDS, path, issues)
            profile_id = profile.get("profile_id")
            if not isinstance(profile_id, str) or not profile_id:
                self._block(issues, "CAPTURE_ID", f"{path}.profile_id", "profile_id is required")
            elif profile_id in seen_ids:
                self._block(issues, "CAPTURE_ID_DUPLICATE", f"{path}.profile_id", "profile_id must be unique")
            else:
                seen_ids.add(profile_id)

            try:
                mode = CaptureMode(profile.get("mode"))
            except (TypeError, ValueError):
                self._block(issues, "CAPTURE_MODE", f"{path}.mode", "unsupported capture mode")
                continue

            gates = {
                CaptureMode.HD_1080P30: {
                    "width": 1920,
                    "height": 1080,
                    "fps": 29.0,
                    "ball_pixels": 6.0,
                    "shutter": 500.0,
                    "camera_count": 1,
                },
                CaptureMode.UHD_4K60: {
                    "width": 3840,
                    "height": 2160,
                    "fps": 59.0,
                    "ball_pixels": 10.0,
                    "shutter": 1000.0,
                    "camera_count": 1,
                },
                CaptureMode.DUAL_4K60: {
                    "width": 3840,
                    "height": 2160,
                    "fps": 59.0,
                    "ball_pixels": 10.0,
                    "shutter": 1000.0,
                    "camera_count": 2,
                },
            }[mode]

            if mode is CaptureMode.HD_1080P30:
                self._warn(
                    issues,
                    "COMPATIBILITY_CAPTURE",
                    path,
                    "1080p30 is a conditional compatibility profile, not the preferred production baseline",
                )

            for field_name in ("width", "height", "camera_count", "sampled_visible_ball_frames"):
                value = profile.get(field_name)
                if not isinstance(value, int) or isinstance(value, bool):
                    self._block(issues, "CAPTURE_NUMBER", f"{path}.{field_name}", "must be an integer")
            for field_name in (
                "fps",
                "bitrate_mbps",
                "shutter_reciprocal",
                "far_ball_processed_pixels_p10",
                "human_resolvable_visible_ball_ratio",
                "visible_serve_frames_meeting_pixel_gate_ratio",
            ):
                value = profile.get(field_name)
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    self._block(issues, "CAPTURE_NUMBER", f"{path}.{field_name}", "must be numeric")

            self._minimum(profile, "width", gates["width"], path, issues)
            self._minimum(profile, "height", gates["height"], path, issues)
            self._minimum(profile, "fps", gates["fps"], path, issues)
            self._minimum(profile, "camera_count", gates["camera_count"], path, issues)
            self._minimum(profile, "shutter_reciprocal", gates["shutter"], path, issues)
            self._minimum(profile, "far_ball_processed_pixels_p10", gates["ball_pixels"], path, issues)
            self._minimum(profile, "human_resolvable_visible_ball_ratio", 0.995, path, issues)
            self._minimum(profile, "visible_serve_frames_meeting_pixel_gate_ratio", 0.99, path, issues)
            self._maximum(profile, "human_resolvable_visible_ball_ratio", 1.0, path, issues)
            self._maximum(
                profile,
                "visible_serve_frames_meeting_pixel_gate_ratio",
                1.0,
                path,
                issues,
            )
            self._minimum(profile, "sampled_visible_ball_frames", 1000, path, issues)
            self._minimum(profile, "bitrate_mbps", 0.001, path, issues)

            self._must_equal(profile, "timestamp_regressions", 0, path, issues)
            self._must_equal(profile, "critical_unexplained_drop_events", 0, path, issues)
            self._must_equal(profile, "service_zones_fully_visible", True, path, issues)
            self._must_equal(profile, "fixed_mount", True, path, issues)

            checksum = profile.get("calibration_profile_sha256")
            if not isinstance(checksum, str) or not _SHA256_RE.fullmatch(checksum):
                self._block(
                    issues,
                    "CALIBRATION_CHECKSUM",
                    f"{path}.calibration_profile_sha256",
                    "calibration profile requires a lowercase SHA-256",
                )

            if mode is CaptureMode.DUAL_4K60:
                sync_p95 = profile.get("exposure_sync_p95_ms")
                if (
                    not isinstance(sync_p95, (int, float))
                    or isinstance(sync_p95, bool)
                    or not math.isfinite(sync_p95)
                    or sync_p95 < 0
                    or sync_p95 > 1.0
                ):
                    self._block(
                        issues,
                        "EXPOSURE_SYNC",
                        f"{path}.exposure_sync_p95_ms",
                        "dual-view exposure synchronization P95 must be measured at <=1 ms",
                    )

    def _validate_data_sources(
        self,
        sources: Sequence[Mapping[str, Any]],
        policies: Any,
        capture_profile_ids: set[str],
        issues: list[ReadinessIssue],
    ) -> None:
        seen_ids: set[str] = set()
        seen_media: set[str] = set()
        match_split: dict[str, DatasetSplit] = {}
        group_split: dict[str, DatasetSplit] = {}
        venue_splits: dict[str, set[DatasetSplit]] = {}
        present_splits: set[DatasetSplit] = set()

        for index, source in enumerate(sources):
            path = f"data_sources[{index}]"
            if not isinstance(source, Mapping):
                self._block(issues, "SOURCE_SHAPE", path, "data source must be an object")
                continue
            self._reject_unknown_fields(source, self._SOURCE_FIELDS, path, issues)

            source_id = source.get("source_id")
            if not isinstance(source_id, str) or not source_id:
                self._block(issues, "SOURCE_ID", f"{path}.source_id", "source_id is required")
            elif source_id in seen_ids:
                self._block(issues, "SOURCE_ID_DUPLICATE", f"{path}.source_id", "source_id must be unique")
            else:
                seen_ids.add(source_id)

            try:
                rights = RightsStatus(source.get("rights_status"))
            except (TypeError, ValueError):
                rights = RightsStatus.UNKNOWN
            if rights not in {RightsStatus.OWNED, RightsStatus.LICENSED, RightsStatus.PUBLIC_DOMAIN}:
                self._block(
                    issues,
                    "SOURCE_RIGHTS",
                    f"{path}.rights_status",
                    "commercial training requires owned, licensed, or public-domain rights",
                )
            if not isinstance(source.get("rights_ref"), str) or not source.get("rights_ref"):
                self._block(issues, "RIGHTS_REFERENCE", f"{path}.rights_ref", "rights evidence is required")

            profile_id = source.get("capture_profile_id")
            if not isinstance(profile_id, str) or profile_id not in capture_profile_ids:
                self._block(
                    issues,
                    "CAPTURE_PROFILE_REFERENCE",
                    f"{path}.capture_profile_id",
                    "data source must reference a declared capture profile",
                )
            for field_name in (
                "camera_id",
                "recording_date",
                "ball_design_id",
                "lighting_condition",
                "split_group_id",
            ):
                if not isinstance(source.get(field_name), str) or not source.get(field_name):
                    self._block(
                        issues,
                        "SOURCE_METADATA",
                        f"{path}.{field_name}",
                        f"{field_name} is required for domain-disjoint evaluation",
                    )
            recording_date = source.get("recording_date")
            if isinstance(recording_date, str):
                try:
                    date.fromisoformat(recording_date)
                except ValueError:
                    self._block(
                        issues,
                        "SOURCE_DATE",
                        f"{path}.recording_date",
                        "recording_date must be an ISO-8601 calendar date",
                    )

            for checksum_field in ("media_sha256", "labels_sha256"):
                checksum = source.get(checksum_field)
                if not isinstance(checksum, str) or not _SHA256_RE.fullmatch(checksum):
                    self._block(
                        issues,
                        "SOURCE_CHECKSUM",
                        f"{path}.{checksum_field}",
                        "a lowercase SHA-256 is required",
                    )
            media_checksum = source.get("media_sha256")
            if isinstance(media_checksum, str) and _SHA256_RE.fullmatch(media_checksum):
                if media_checksum in seen_media:
                    self._block(
                        issues,
                        "DUPLICATE_MEDIA",
                        f"{path}.media_sha256",
                        "the same media cannot appear as multiple independent sources",
                    )
                seen_media.add(media_checksum)

            try:
                split = DatasetSplit(source.get("split"))
                present_splits.add(split)
            except (TypeError, ValueError):
                self._block(issues, "SOURCE_SPLIT", f"{path}.split", "split must be TRAIN, DEV, or TEST")
                continue

            match_id = source.get("match_id")
            venue_id = source.get("venue_id")
            if not isinstance(match_id, str) or not match_id:
                self._block(issues, "MATCH_ID", f"{path}.match_id", "match_id is required")
            elif match_id in match_split and match_split[match_id] is not split:
                self._block(
                    issues,
                    "MATCH_LEAKAGE",
                    f"{path}.match_id",
                    "a match cannot cross dataset splits",
                )
            else:
                match_split[match_id] = split
            split_group_id = source.get("split_group_id")
            if isinstance(split_group_id, str) and split_group_id:
                if split_group_id in group_split and group_split[split_group_id] is not split:
                    self._block(
                        issues,
                        "GROUP_LEAKAGE",
                        f"{path}.split_group_id",
                        "a venue/camera/day split group cannot cross dataset splits",
                    )
                else:
                    group_split[split_group_id] = split
            if not isinstance(venue_id, str) or not venue_id:
                self._block(issues, "VENUE_ID", f"{path}.venue_id", "venue_id is required")
            else:
                venue_splits.setdefault(venue_id, set()).add(split)

        for required_split in (DatasetSplit.TRAIN, DatasetSplit.DEV, DatasetSplit.TEST):
            if required_split not in present_splits:
                self._block(
                    issues,
                    "MISSING_SPLIT",
                    "data_sources",
                    f"at least one {required_split.value} source is required",
                )

        require_unseen_test_venue = isinstance(policies, Mapping) and policies.get(
            "require_unseen_test_venue", True
        )
        if isinstance(policies, Mapping):
            self._reject_unknown_fields(policies, self._POLICY_FIELDS, "policies", issues)
        if not isinstance(policies, Mapping) or not isinstance(require_unseen_test_venue, bool):
            self._block(
                issues,
                "POLICY_SHAPE",
                "policies.require_unseen_test_venue",
                "require_unseen_test_venue must be a boolean",
            )
            require_unseen_test_venue = True
        if require_unseen_test_venue:
            test_venues = {venue for venue, splits in venue_splits.items() if DatasetSplit.TEST in splits}
            train_dev_venues = {
                venue
                for venue, splits in venue_splits.items()
                if DatasetSplit.TRAIN in splits or DatasetSplit.DEV in splits
            }
            overlap = sorted(test_venues & train_dev_venues)
            if overlap:
                self._block(
                    issues,
                    "VENUE_LEAKAGE",
                    "data_sources",
                    f"TEST venues must be unseen; overlapping venues: {', '.join(overlap)}",
                )

    @staticmethod
    def _block(issues: list[ReadinessIssue], code: str, path: str, message: str) -> None:
        issues.append(ReadinessIssue(code=code, severity=Severity.BLOCKER, path=path, message=message))

    @staticmethod
    def _warn(issues: list[ReadinessIssue], code: str, path: str, message: str) -> None:
        issues.append(ReadinessIssue(code=code, severity=Severity.WARNING, path=path, message=message))

    @classmethod
    def _reject_unknown_fields(
        cls,
        data: Mapping[str, Any],
        allowed: frozenset[str],
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        unknown = sorted(str(key) for key in data if key not in allowed)
        if unknown:
            cls._block(
                issues,
                "UNKNOWN_FIELD",
                path,
                f"unsupported fields: {', '.join(unknown)}",
            )

    @classmethod
    def _minimum(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        minimum: float,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < minimum
        ):
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must be >= {minimum}; this is an engineering gate",
            )

    @classmethod
    def _maximum(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        maximum: float,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value > maximum
        ):
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must be <= {maximum}; this is an engineering gate",
            )

    @classmethod
    def _must_equal(
        cls,
        data: Mapping[str, Any],
        field_name: str,
        expected: Any,
        path: str,
        issues: list[ReadinessIssue],
    ) -> None:
        value = data.get(field_name)
        if type(value) is not type(expected) or value != expected:
            cls._block(
                issues,
                "CAPTURE_GATE",
                f"{path}.{field_name}",
                f"must equal {expected!r}",
            )


def load_manifest(path: Path) -> Mapping[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, Mapping):
        raise ValueError("manifest root must be a JSON object")
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="path to readiness manifest JSON")
    args = parser.parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        report = ManifestValidator().validate(manifest)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 2
    print(json.dumps(report.to_dict(), indent=2))
    return 0 if report.ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
