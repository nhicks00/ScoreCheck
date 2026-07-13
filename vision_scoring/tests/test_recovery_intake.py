from __future__ import annotations

from copy import deepcopy
import csv
import hashlib
import inspect
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from vision_scoring import recovery_intake
from vision_scoring.recovery_intake import (
    CandidateAvailability,
    DescriptorFilesystemObserver,
    FileMetadata,
    ObservationBatch,
    PathObservation,
    PresentRootPin,
    RecoveryIntakeError,
    RootAvailability,
    RootObservation,
    build_manifest,
    canonical_json_bytes,
    emit_manifest,
)


CSV_HEADER = (
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


def regular_metadata(*, size_bytes: int = 123) -> FileMetadata:
    return FileMetadata(
        device=1,
        inode=5,
        mode=stat.S_IFREG | 0o600,
        link_count=1,
        size_bytes=size_bytes,
        modified_ns=6,
        changed_ns=7,
    )


class FakeObserver:
    def __init__(
        self,
        observations: dict[str, PathObservation] | None = None,
    ) -> None:
        self.observations = observations or {}
        self.calls: list[dict[str, tuple[str, ...]]] = []

    def observe(
        self,
        *,
        paths_by_root,
        present_root_pins,
        offline_roots,
        deadline_seconds,
    ) -> ObservationBatch:
        del deadline_seconds
        self.calls.append(dict(paths_by_root))
        roots: list[RootObservation] = []
        paths: list[PathObservation] = []
        for root in sorted(paths_by_root):
            if root in offline_roots:
                roots.append(
                    RootObservation(
                        path=root,
                        status=RootAvailability.OFFLINE_DECLARED_AND_ABSENT,
                    )
                )
                paths.extend(
                    PathObservation(
                        path=path,
                        root=root,
                        status=CandidateAvailability.REFERENCED_OFFLINE,
                        reason_code="DECLARED_OFFLINE_ROOT_ABSENT",
                    )
                    for path in paths_by_root[root]
                )
            else:
                pin = present_root_pins[root]
                roots.append(
                    RootObservation(
                        path=root,
                        status=RootAvailability.PRESENT_DIRECTORY,
                        metadata=FileMetadata(
                            device=pin.device,
                            inode=pin.inode,
                            mode=stat.S_IFDIR | 0o700,
                            link_count=2,
                            size_bytes=0,
                            modified_ns=3,
                            changed_ns=4,
                        ),
                    )
                )
                for path in paths_by_root[root]:
                    paths.append(
                        self.observations.get(
                            path,
                            PathObservation(
                                path=path,
                                root=root,
                                status=CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT,
                                reason_code="FINAL_ENTRY_ABSENT",
                            ),
                        )
                    )
        return ObservationBatch(roots=tuple(roots), paths=tuple(paths))


class RecoveryIntakeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        # macOS exposes /var as a symlink to /private/var.  Production intake
        # correctly rejects intermediate symlinks, so fixtures use the bound
        # canonical directory rather than weakening that boundary.
        self.temp = Path(os.path.realpath(self.temporary_directory.name))

    def write_document(self, name: str, data: bytes) -> tuple[Path, str]:
        path = self.temp / name
        path.write_bytes(data)
        return path, hashlib.sha256(data).hexdigest()

    def path_list_bytes(self, paths: list[str]) -> bytes:
        return json.dumps(
            {"schema_version": "1.0", "paths": paths},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    def probe_csv_bytes(self, rows: list[tuple[str, ...]]) -> bytes:
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(CSV_HEADER)
        writer.writerows(rows)
        return output.getvalue().encode("utf-8")

    def probe_row(
        self,
        path: str,
        *,
        size: str = "123",
        duration: str = "1800.000",
        width: str = "3840",
        height: str = "2160",
        codec: str = "hevc",
        error: str = "",
        filename: str | None = None,
        parent: str | None = None,
        extension: str | None = None,
    ) -> tuple[str, ...]:
        actual_filename = os.path.basename(path) if filename is None else filename
        actual_parent = os.path.dirname(path) if parent is None else parent
        actual_extension = (
            os.path.splitext(actual_filename)[1].lower()
            if extension is None
            else extension
        )
        return (
            path,
            actual_filename,
            actual_parent,
            actual_extension,
            size,
            duration,
            width,
            height,
            codec,
            error,
        )

    def build_paths(
        self,
        paths: list[str],
        *,
        allowed_roots=("/approved",),
        offline_roots=(),
        observer=None,
    ):
        document, digest = self.write_document(
            f"paths-{len(list(self.temp.iterdir()))}.json",
            self.path_list_bytes(paths),
        )
        pins = tuple(
            PresentRootPin(path=root, device=1, inode=2)
            for root in allowed_roots
            if root not in offline_roots
        )
        return recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            present_root_pins=pins,
            offline_roots=offline_roots,
            filesystem_observer=observer or FakeObserver(),
        )

    def build_sealed_offline_manifest(self, candidate_name: str = "fixture.mp4"):
        fixture_number = len(list(self.temp.iterdir()))
        offline_root = self.temp / f"offline-media-{fixture_number}"
        candidate = offline_root / candidate_name
        document, digest = self.write_document(
            f"sealed-paths-{fixture_number}.json",
            self.path_list_bytes([str(candidate)]),
        )
        return build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            offline_roots=[str(offline_root)],
            observation_timeout_seconds=5.0,
        )

    def build_sealed_present_manifest(self, root_name: str):
        present_root = self.temp / root_name
        present_root.mkdir()
        candidate = present_root / "fixture.mp4"
        candidate.write_bytes(b"media fixture")
        document, digest = self.write_document(
            "sealed-present-paths.json",
            self.path_list_bytes([str(candidate)]),
        )
        root_stat = present_root.stat()
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            present_root_pins=[
                PresentRootPin(
                    str(present_root),
                    root_stat.st_dev,
                    root_stat.st_ino,
                )
            ],
            observation_timeout_seconds=5.0,
        )
        return manifest, present_root

    def test_manifest_is_deterministic_and_digest_commits_payload(self) -> None:
        observer = FakeObserver()
        data = self.path_list_bytes(["/approved/Beach Volleyball Match.mp4"])
        document, digest = self.write_document("paths.json", data)
        arguments = dict(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            present_root_pins=[PresentRootPin("/approved", 1, 2)],
            filesystem_observer=observer,
        )
        first = recovery_intake._build_manifest_for_test(**arguments)
        second = recovery_intake._build_manifest_for_test(**arguments)

        self.assertEqual(first, second)
        payload = deepcopy(first)
        manifest_digest = payload.pop("manifest_sha256")
        self.assertEqual(
            manifest_digest,
            hashlib.sha256(canonical_json_bytes(payload)).hexdigest(),
        )
        candidate = first["candidates"][0]
        self.assertEqual(candidate["disposition"]["status"], "QUARANTINED")
        self.assertEqual(candidate["disposition"]["rights"], "UNKNOWN")
        self.assertEqual(candidate["media_content_identity"]["status"], "NOT_COMPUTED")
        self.assertNotIn("sha256", candidate["media_content_identity"])
        self.assertNotIn("generated_at", first)
        self.assertEqual(
            first["policy"]["assurance"]["level"],
            "TEST_INJECTED_OBSERVER_NO_PRODUCTION_CLAIMS",
        )
        self.assertEqual(first["policy"]["assurance"]["claims"], [])
        self.assertEqual(first["input"]["filesystem_identity"]["link_count"], 1)
        encoded = canonical_json_bytes(first)
        self.assertNotIn(b"FINAL_MEDIA_BYTES_NOT_OPENED_OR_HASHED", encoded)
        self.assertNotIn(b"SEALED_DESCRIPTOR_RELATIVE", encoded)

    def test_production_builder_and_main_have_no_observer_injection_surface(self) -> None:
        self.assertNotIn("filesystem_observer", inspect.signature(build_manifest).parameters)
        self.assertNotIn("filesystem_observer", inspect.signature(recovery_intake.main).parameters)

    def test_resource_policy_retains_known_inventory_capacity(self) -> None:
        self.assertGreaterEqual(recovery_intake.MAX_INPUT_DOCUMENT_BYTES, 8_900_000)
        self.assertGreaterEqual(recovery_intake.MAX_INPUT_RECORDS, 25_000)
        self.assertGreaterEqual(recovery_intake.MAX_TOTAL_LOCATOR_UTF8_BYTES, 6_000_000)
        manifest = self.build_paths(["/approved/a.mp4"])
        accounting = manifest["resource_accounting"]
        self.assertEqual(accounting["policy_id"], "recovery-intake-resource-bounds-v1")
        self.assertLessEqual(
            accounting["estimated_peak_bytes"],
            recovery_intake.MAX_ESTIMATED_PEAK_BYTES,
        )

    def test_cumulative_locator_budget_fails_before_observation(self) -> None:
        observer = FakeObserver()
        data = self.path_list_bytes(["/approved/long-candidate-name.mp4"])
        document, digest = self.write_document("budget.json", data)
        with patch.object(recovery_intake, "MAX_TOTAL_LOCATOR_UTF8_BYTES", 4):
            with self.assertRaises(RecoveryIntakeError) as caught:
                recovery_intake._build_manifest_for_test(
                    input_path=document,
                    input_kind="PATH_LIST_JSON",
                    expected_input_sha256=digest,
                    present_root_pins=[PresentRootPin("/approved", 1, 2)],
                    filesystem_observer=observer,
                )
        self.assertEqual(caught.exception.code, "LOCATOR_BUDGET_EXCEEDED")
        self.assertEqual(observer.calls, [])

    def test_input_digest_is_checked_before_observer_runs(self) -> None:
        document, _ = self.write_document(
            "paths.json", self.path_list_bytes(["/approved/a.mp4"])
        )
        observer = FakeObserver()
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256="0" * 64,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "INPUT_DIGEST_MISMATCH")
        self.assertEqual(observer.calls, [])

    def test_input_document_requires_single_link(self) -> None:
        document, digest = self.write_document(
            "single-link.json", self.path_list_bytes(["/offline/a.mp4"])
        )
        os.link(document, self.temp / "input-alias.json")
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                offline_roots=["/offline"],
            )
        self.assertEqual(caught.exception.code, "INPUT_DOCUMENT_MULTIPLE_LINKS")

    def test_candidate_cannot_lexically_equal_input_document(self) -> None:
        document = self.temp / "self-reference.json"
        data = self.path_list_bytes([str(document)])
        document.write_bytes(data)
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=hashlib.sha256(data).hexdigest(),
                offline_roots=["/offline"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "CANDIDATE_EQUALS_INPUT_DOCUMENT")

    def test_casefolded_out_of_scope_candidate_cannot_alias_input_document(self) -> None:
        document = self.temp / "Inventory.JSON"
        candidate = self.temp / "inventory.json"
        data = self.path_list_bytes([str(candidate)])
        document.write_bytes(data)
        self.assertEqual(document.stat().st_nlink, 1)

        observer = FakeObserver()
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=hashlib.sha256(data).hexdigest(),
                offline_roots=[str(self.temp / "unrelated-offline-root")],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "CANDIDATE_EQUALS_INPUT_DOCUMENT")
        self.assertEqual(observer.calls, [])

    def test_unicode_normalized_candidate_cannot_alias_input_document(self) -> None:
        document = self.temp / "Invéntory.JSON"
        candidate = self.temp / "inve\u0301ntory.json"
        data = self.path_list_bytes([str(candidate)])
        document.write_bytes(data)
        self.assertEqual(document.stat().st_nlink, 1)

        observer = FakeObserver()
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=hashlib.sha256(data).hexdigest(),
                offline_roots=[str(self.temp / "unrelated-offline-root")],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "CANDIDATE_EQUALS_INPUT_DOCUMENT")
        self.assertEqual(observer.calls, [])

    def test_candidate_device_inode_alias_of_input_fails_closed(self) -> None:
        document, digest = self.write_document(
            "alias-source.json", self.path_list_bytes(["/approved/a.mp4"])
        )
        identity = document.stat()
        candidate = "/approved/a.mp4"
        observer = FakeObserver(
            {
                candidate: PathObservation(
                    path=candidate,
                    root="/approved",
                    status=CandidateAvailability.RESIDENT_REGULAR_FILE,
                    metadata=FileMetadata(
                        device=identity.st_dev,
                        inode=identity.st_ino,
                        mode=stat.S_IFREG | 0o600,
                        link_count=1,
                        size_bytes=identity.st_size,
                        modified_ns=identity.st_mtime_ns,
                        changed_ns=identity.st_ctime_ns,
                    ),
                )
            }
        )
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "CANDIDATE_ALIASES_INPUT_DOCUMENT")

    def test_strict_csv_builds_offline_high_priority_candidate(self) -> None:
        path = "/offline/Beach Volleyball Match Final.mp4"
        document, digest = self.write_document(
            "probe.csv", self.probe_csv_bytes([self.probe_row(path)])
        )
        manifest = recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            offline_roots=["/offline"],
            filesystem_observer=FakeObserver(),
        )
        candidate = manifest["candidates"][0]
        self.assertEqual(candidate["availability"]["status"], "REFERENCED_OFFLINE")
        self.assertEqual(candidate["metadata_review_priority"]["band"], "HIGH")
        self.assertFalse(candidate["media_preflight_handoff"]["eligible_now"])
        self.assertIsNone(candidate["filesystem_observation"])

    def test_csv_header_must_match_exactly(self) -> None:
        bad = self.probe_csv_bytes([self.probe_row("/approved/a.mp4")]).replace(
            b"path,filename", b"filename,path", 1
        )
        document, digest = self.write_document("bad.csv", bad)
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PRIOR_PROBE_CSV",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "INVALID_CSV_HEADER")

    def test_invalid_relative_csv_path_is_rejected_without_losing_valid_record(self) -> None:
        rows = [
            self.probe_row(".mp4", filename=".mp4", parent=".", extension=""),
            self.probe_row("/approved/a.mp4"),
        ]
        document, digest = self.write_document("probe.csv", self.probe_csv_bytes(rows))
        manifest = recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            present_root_pins=[PresentRootPin("/approved", 1, 2)],
            filesystem_observer=FakeObserver(),
        )
        self.assertEqual(manifest["summary"]["candidate_count"], 1)
        self.assertEqual(manifest["summary"]["rejected_record_count"], 1)
        rejected = manifest["rejected_records"][0]
        self.assertEqual(rejected["code"], "PATH_NOT_ABSOLUTE")
        self.assertRegex(rejected["locator_text_sha256"], r"^[0-9a-f]{64}$")

    def test_duplicate_normalized_locator_fails_whole_build(self) -> None:
        document, digest = self.write_document(
            "paths.json",
            self.path_list_bytes(["/approved/a.mp4", "/approved/a.mp4"]),
        )
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "DUPLICATE_NORMALIZED_LOCATOR")

    def test_casefolded_and_unicode_normalized_locators_are_duplicates(self) -> None:
        observer = FakeObserver()
        document, digest = self.write_document(
            "alias-duplicates.json",
            self.path_list_bytes(
                ["/approved/Évent.mp4", "/APPROVED/e\u0301VENT.MP4"]
            ),
        )
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "DUPLICATE_NORMALIZED_LOCATOR")
        self.assertEqual(observer.calls, [])

    def test_json_duplicate_keys_and_surrogate_locator_fail_closed(self) -> None:
        duplicate = b'{"schema_version":"1.0","paths":[],"paths":[]}'
        document, digest = self.write_document("duplicate.json", duplicate)
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "MALFORMED_PATH_LIST_JSON")

    def test_json_rejects_floats_constants_depth_and_node_exhaustion(self) -> None:
        fixtures = {
            "float.json": b'{"paths":[1.5],"schema_version":"1.0"}',
            "constant.json": b'{"paths":[NaN],"schema_version":"1.0"}',
            "deep.json": (
                b'{"paths":'
                + b"[" * (recovery_intake.MAX_JSON_DEPTH + 4)
                + b'"/approved/a.mp4"'
                + b"]" * (recovery_intake.MAX_JSON_DEPTH + 4)
                + b',"schema_version":"1.0"}'
            ),
        }
        for name, data in fixtures.items():
            with self.subTest(name=name):
                document, digest = self.write_document(name, data)
                with self.assertRaises(RecoveryIntakeError) as caught:
                    recovery_intake._build_manifest_for_test(
                        input_path=document,
                        input_kind="PATH_LIST_JSON",
                        expected_input_sha256=digest,
                        present_root_pins=[PresentRootPin("/approved", 1, 2)],
                        filesystem_observer=FakeObserver(),
                    )
                self.assertEqual(caught.exception.code, "MALFORMED_PATH_LIST_JSON")

        document, digest = self.write_document(
            "nodes.json", self.path_list_bytes(["/approved/a.mp4"])
        )
        del digest
        with patch.object(recovery_intake, "MAX_JSON_NODES", 2):
            with self.assertRaises(RecoveryIntakeError) as caught:
                recovery_intake._parse_path_list_json(document.read_bytes())
        self.assertEqual(caught.exception.code, "MALFORMED_PATH_LIST_JSON")

        surrogate = (
            b'{"paths":["/approved/\\ud800.mp4","/approved/ok.mp4"],'
            b'"schema_version":"1.0"}'
        )
        document, digest = self.write_document("surrogate.json", surrogate)
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[PresentRootPin("/approved", 1, 2)],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "MALFORMED_PATH_LIST_JSON")

    def test_utf8_byte_field_limit_and_invalid_numeric_are_record_rejections(self) -> None:
        byte_heavy_name = "é" * 40_000
        rows = [
            self.probe_row(
                "/approved/large-name.mp4",
                filename=byte_heavy_name,
            ),
            self.probe_row("/approved/nan.mp4", duration="NaN"),
            self.probe_row("/approved/valid.mp4"),
        ]
        document, digest = self.write_document("probe.csv", self.probe_csv_bytes(rows))
        manifest = recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            present_root_pins=[PresentRootPin("/approved", 1, 2)],
            filesystem_observer=FakeObserver(),
        )
        self.assertEqual(manifest["summary"]["candidate_count"], 1)
        self.assertEqual(
            [record["code"] for record in manifest["rejected_records"]],
            ["CSV_FIELD_TOO_LARGE", "INVALID_DURATION"],
        )

    def test_out_of_scope_paths_are_never_sent_to_observer(self) -> None:
        observer = FakeObserver()
        manifest = self.build_paths(
            ["/approved/a.mp4", "/etc/passwd"],
            observer=observer,
        )
        self.assertEqual(observer.calls[0], {"/approved": ("/approved/a.mp4",)})
        by_path = {
            item["source_locator"]["normalized_absolute_path"]: item
            for item in manifest["candidates"]
        }
        self.assertEqual(
            by_path["/etc/passwd"]["availability"]["status"],
            "OUT_OF_SCOPE_UNOBSERVED",
        )

    def test_casefolded_unicode_offline_root_alias_remains_out_of_scope(self) -> None:
        root = "/Offline/Évent"
        candidate = "/offline/e\u0301vent/Match.mp4"
        manifest = self.build_paths(
            [candidate],
            allowed_roots=(root,),
            offline_roots=(root,),
        )
        item = manifest["candidates"][0]
        self.assertEqual(item["availability"]["status"], "OUT_OF_SCOPE_UNOBSERVED")
        self.assertIsNone(item["availability"]["matched_allowed_root"])
        self.assertIsNone(item["availability"]["matched_offline_root"])

    def test_root_membership_and_relative_traversal_are_exact_not_casefolded(self) -> None:
        candidate = "/tmp/A/file.mp4"
        configured_root = "/tmp/a"
        self.assertFalse(recovery_intake._path_is_within(candidate, configured_root))
        self.assertIsNone(
            recovery_intake._matching_root(candidate, (configured_root,))
        )
        self.assertIsNone(
            recovery_intake._relative_components_under_root(
                candidate,
                configured_root,
            )
        )
        self.assertTrue(
            recovery_intake._path_canonically_aliases_within(
                candidate,
                configured_root,
            )
        )

    def test_resident_candidates_sort_first_and_size_mismatch_is_hold(self) -> None:
        resident_path = "/resident/Beach Volleyball Match.mp4"
        offline_path = "/offline/Beach Volleyball Match.mp4"
        observation = PathObservation(
            path=resident_path,
            root="/resident",
            status=CandidateAvailability.RESIDENT_REGULAR_FILE,
            metadata=regular_metadata(size_bytes=999),
        )
        observer = FakeObserver({resident_path: observation})
        rows = [self.probe_row(offline_path), self.probe_row(resident_path, size="123")]
        document, digest = self.write_document("probe.csv", self.probe_csv_bytes(rows))
        manifest = recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            present_root_pins=[PresentRootPin("/resident", 1, 2)],
            offline_roots=["/offline"],
            filesystem_observer=observer,
        )
        first = manifest["candidates"][0]
        self.assertEqual(
            first["source_locator"]["normalized_absolute_path"], resident_path
        )
        self.assertTrue(first["media_preflight_handoff"]["eligible_now"])
        self.assertEqual(first["metadata_review_priority"]["band"], "HOLD")
        self.assertIn("REPORTED_SIZE_MISMATCH", [issue["code"] for issue in first["issues"]])
        self.assertNotIn("sha256", first["filesystem_observation"]["stat"])

    def test_multilink_and_cross_device_candidates_are_hold_and_ineligible(self) -> None:
        multi = "/approved/multi.mp4"
        nested_mount = "/approved/nested.mp4"
        observer = FakeObserver(
            {
                multi: PathObservation(
                    path=multi,
                    root="/approved",
                    status=CandidateAvailability.RESIDENT_REGULAR_FILE,
                    metadata=FileMetadata(
                        device=1,
                        inode=10,
                        mode=stat.S_IFREG | 0o600,
                        link_count=2,
                        size_bytes=100,
                        modified_ns=1,
                        changed_ns=1,
                    ),
                ),
                nested_mount: PathObservation(
                    path=nested_mount,
                    root="/approved",
                    status=CandidateAvailability.RESIDENT_REGULAR_FILE,
                    metadata=FileMetadata(
                        device=99,
                        inode=11,
                        mode=stat.S_IFREG | 0o600,
                        link_count=1,
                        size_bytes=100,
                        modified_ns=1,
                        changed_ns=1,
                    ),
                ),
            }
        )
        manifest = self.build_paths([multi, nested_mount], observer=observer)
        for item in manifest["candidates"]:
            self.assertEqual(item["metadata_review_priority"]["band"], "HOLD")
            self.assertFalse(item["media_preflight_handoff"]["eligible_now"])
            self.assertEqual(
                item["media_preflight_handoff"]["reason"],
                "UNSAFE_FILESYSTEM_IDENTITY",
            )
        issue_codes = {
            issue["code"] for item in manifest["candidates"] for issue in item["issues"]
        }
        self.assertIn("CANDIDATE_MULTIPLE_HARD_LINKS", issue_codes)
        self.assertIn("CANDIDATE_CROSSES_ROOT_DEVICE", issue_codes)

    def test_locator_id_is_stable_across_input_document_types(self) -> None:
        path = "/offline/Beach Volleyball Match.mp4"
        path_manifest = self.build_paths(
            [path],
            allowed_roots=("/offline",),
            offline_roots=("/offline",),
            observer=FakeObserver(),
        )
        document, digest = self.write_document(
            "probe.csv", self.probe_csv_bytes([self.probe_row(path)])
        )
        csv_manifest = recovery_intake._build_manifest_for_test(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            offline_roots=["/offline"],
            filesystem_observer=FakeObserver(),
        )
        self.assertEqual(
            path_manifest["candidates"][0]["locator_id"],
            csv_manifest["candidates"][0]["locator_id"],
        )

    def test_descriptor_observer_does_not_open_final_media_file(self) -> None:
        root = self.temp / "root"
        root.mkdir()
        media = root / "media.mp4"
        media.write_bytes(b"bytes that intake must not read")
        real_open = recovery_intake.os.open

        def guarded_open(path, *args, **kwargs):
            if path == media.name and kwargs.get("dir_fd") is not None:
                raise AssertionError("observer attempted to open final media bytes")
            return real_open(path, *args, **kwargs)

        with patch.object(recovery_intake.os, "open", side_effect=guarded_open):
            root_stat = root.stat()
            batch = DescriptorFilesystemObserver().observe(
                paths_by_root={str(root): (str(media),)},
                present_root_pins={
                    str(root): PresentRootPin(str(root), root_stat.st_dev, root_stat.st_ino)
                },
                offline_roots=frozenset(),
                deadline_seconds=5.0,
            )
        self.assertEqual(batch.paths[0].status, CandidateAvailability.RESIDENT_REGULAR_FILE)
        self.assertEqual(batch.paths[0].metadata.size_bytes, media.stat().st_size)

    def test_descriptor_observer_rejects_intermediate_symlink_escape(self) -> None:
        root = self.temp / "root"
        outside = self.temp / "outside"
        root.mkdir()
        outside.mkdir()
        (outside / "media.mp4").write_bytes(b"outside")
        (root / "escape").symlink_to(outside, target_is_directory=True)
        candidate = root / "escape" / "media.mp4"

        root_stat = root.stat()
        batch = DescriptorFilesystemObserver().observe(
            paths_by_root={str(root): (str(candidate),)},
            present_root_pins={
                str(root): PresentRootPin(str(root), root_stat.st_dev, root_stat.st_ino)
            },
            offline_roots=frozenset(),
            deadline_seconds=5.0,
        )
        self.assertEqual(
            batch.paths[0].status,
            CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY,
        )
        self.assertEqual(batch.paths[0].reason_code, "UNSAFE_PATH_COMPONENT")

    def test_case_sensitive_sibling_is_not_resolved_beneath_allowed_root(self) -> None:
        allowed_root = self.temp / "CaseSensitiveRoot"
        sibling_root = self.temp / "casesensitiveroot"
        allowed_root.mkdir()
        if sibling_root.exists():
            self.skipTest("fixture filesystem is case-insensitive")
        sibling_root.mkdir()
        candidate = sibling_root / "match.mp4"
        candidate.write_bytes(b"outside the configured root")
        document, digest = self.write_document(
            "case-sensitive-paths.json",
            self.path_list_bytes([str(candidate)]),
        )
        root_stat = allowed_root.stat()
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            present_root_pins=[
                PresentRootPin(
                    str(allowed_root),
                    root_stat.st_dev,
                    root_stat.st_ino,
                )
            ],
            observation_timeout_seconds=5.0,
        )
        item = manifest["candidates"][0]
        self.assertEqual(item["availability"]["status"], "OUT_OF_SCOPE_UNOBSERVED")
        self.assertIsNone(item["availability"]["matched_allowed_root"])
        self.assertIsNone(item["filesystem_observation"])

    def test_default_bounded_worker_classifies_absent_offline_root(self) -> None:
        offline_root = self.temp / "not-mounted"
        candidate = offline_root / "match.mp4"
        document, digest = self.write_document(
            "paths.json", self.path_list_bytes([str(candidate)])
        )
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            offline_roots=[str(offline_root)],
            observation_timeout_seconds=5.0,
        )
        self.assertEqual(
            manifest["candidates"][0]["availability"]["status"],
            "REFERENCED_OFFLINE",
        )

    def test_production_out_of_scope_identity_is_explicitly_unverified(self) -> None:
        offline_root = self.temp / "not-mounted-out-of-scope"
        document, digest = self.write_document(
            "out-of-scope-paths.json",
            self.path_list_bytes(["/outside/Unverified.mp4"]),
        )
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            offline_roots=[str(offline_root)],
            observation_timeout_seconds=5.0,
        )
        item = manifest["candidates"][0]
        self.assertEqual(item["availability"]["status"], "OUT_OF_SCOPE_UNOBSERVED")
        self.assertEqual(
            item["media_content_identity"]["reason"],
            "OUT_OF_SCOPE_LOCATOR_IDENTITY_UNVERIFIED",
        )
        self.assertIn(
            "OUT_OF_SCOPE_LOCATOR_IDENTITY_UNVERIFIED",
            manifest["policy"]["assurance"]["claims"],
        )
        self.assertIn(
            "out-of-scope locator physical identity or namespace alias freedom",
            manifest["scope"]["does_not_establish"],
        )
        self.assertNotIn(
            "FINAL_MEDIA_BYTES_NOT_OPENED_OR_HASHED",
            manifest["policy"]["assurance"]["claims"],
        )

    def test_default_bounded_worker_returns_metadata_not_media_identity(self) -> None:
        resident_root = self.temp / "resident"
        resident_root.mkdir()
        candidate = resident_root / "match.mp4"
        candidate.write_bytes(b"media fixture")
        document, digest = self.write_document(
            "resident-paths.json", self.path_list_bytes([str(candidate)])
        )
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            present_root_pins=[
                PresentRootPin(
                    str(resident_root),
                    resident_root.stat().st_dev,
                    resident_root.stat().st_ino,
                )
            ],
            observation_timeout_seconds=5.0,
        )
        item = manifest["candidates"][0]
        self.assertEqual(item["availability"]["status"], "RESIDENT_REGULAR_FILE")
        self.assertEqual(
            item["filesystem_observation"]["stat"]["size_bytes"],
            len(b"media fixture"),
        )
        self.assertEqual(item["media_content_identity"]["status"], "NOT_COMPUTED")
        self.assertNotIn("sha256", item["filesystem_observation"]["stat"])
        self.assertEqual(
            manifest["policy"]["assurance"]["level"],
            "SEALED_BOUNDED_PRODUCTION_OBSERVER",
        )
        self.assertIn(
            "IN_SCOPE_PRESENT_PINNED_MEDIA_BYTES_NOT_OPENED_OR_HASHED",
            manifest["policy"]["assurance"]["claims"],
        )
        self.assertIn(
            "OUT_OF_SCOPE_LOCATOR_IDENTITY_UNVERIFIED",
            manifest["policy"]["assurance"]["claims"],
        )
        self.assertNotIn(
            "FINAL_MEDIA_BYTES_NOT_OPENED_OR_HASHED",
            manifest["policy"]["assurance"]["claims"],
        )
        proof = manifest["policy"]["root_proofs"][0]
        self.assertEqual(proof["expected_identity"]["device"], resident_root.stat().st_dev)
        self.assertEqual(
            proof["verification"], "SEALED_PRODUCTION_MATCHED_OR_OFFLINE_ABSENT"
        )

    def test_present_root_pin_mismatch_rejects_wrong_mount(self) -> None:
        resident_root = self.temp / "wrong-mount"
        resident_root.mkdir()
        candidate = resident_root / "match.mp4"
        candidate.write_bytes(b"fixture")
        document, digest = self.write_document(
            "wrong-mount-paths.json", self.path_list_bytes([str(candidate)])
        )
        root_stat = resident_root.stat()
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[
                    PresentRootPin(
                        str(resident_root), root_stat.st_dev, root_stat.st_ino + 1
                    )
                ],
                observation_timeout_seconds=5.0,
            )
        self.assertEqual(caught.exception.code, "ROOT_IDENTITY_MISMATCH")

    def test_root_pin_cli_encoding_is_strict_and_round_trips(self) -> None:
        pin = recovery_intake._parse_present_root_pin_cli("/approved/root::12::34")
        self.assertEqual(pin, PresentRootPin("/approved/root", 12, 34))
        for malformed in ("/approved/root", "/approved/root::x::34", "/::1::2"):
            with self.subTest(value=malformed):
                with self.assertRaises(RecoveryIntakeError):
                    recovery_intake._parse_present_root_pin_cli(malformed)

    def test_bounded_worker_timeout_is_killable(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._stream_worker_ipc(
                process,
                input_bytes=b"fixture",
                deadline_seconds=0.05,
                stdout_limit=1024,
                stderr_limit=1024,
                timeout_code="OBSERVATION_DEADLINE_EXCEEDED",
                stdout_limit_code="STDOUT_LIMIT",
                stderr_limit_code="STDERR_LIMIT",
            )
        self.assertEqual(caught.exception.code, "OBSERVATION_DEADLINE_EXCEEDED")

    def test_worker_ipc_kills_immediately_at_stdout_and_stderr_limits(self) -> None:
        commands = (
            (
                "stdout",
                "import os; os.write(1, b'x' * 4096)",
                "STDOUT_LIMIT",
            ),
            (
                "stderr",
                "import os; os.write(2, b'x' * 4096)",
                "STDERR_LIMIT",
            ),
        )
        for label, script, expected_code in commands:
            with self.subTest(stream=label):
                process = subprocess.Popen(
                    [sys.executable, "-c", script],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                with self.assertRaises(RecoveryIntakeError) as caught:
                    recovery_intake._stream_worker_ipc(
                        process,
                        input_bytes=b"",
                        deadline_seconds=2.0,
                        stdout_limit=128,
                        stderr_limit=128,
                        timeout_code="TIMEOUT",
                        stdout_limit_code="STDOUT_LIMIT",
                        stderr_limit_code="STDERR_LIMIT",
                    )
                self.assertEqual(caught.exception.code, expected_code)

    def test_observer_result_cannot_add_unrequested_path(self) -> None:
        class MaliciousObserver(FakeObserver):
            def observe(self, **kwargs):
                batch = super().observe(**kwargs)
                return ObservationBatch(
                    roots=batch.roots,
                    paths=batch.paths
                    + (
                        PathObservation(
                            path="/approved/injected.mp4",
                            root="/approved",
                            status=CandidateAvailability.ABSENT_AT_AVAILABLE_ROOT,
                            reason_code="FINAL_ENTRY_ABSENT",
                        ),
                    ),
                )

        with self.assertRaises(RecoveryIntakeError) as caught:
            self.build_paths(["/approved/a.mp4"], observer=MaliciousObserver())
        self.assertEqual(caught.exception.code, "INVALID_OBSERVER_RESULT")

    def test_input_document_symlink_and_size_limit_fail_closed(self) -> None:
        data = self.path_list_bytes(["/approved/a.mp4"])
        target, digest = self.write_document("target.json", data)
        link = self.temp / "link.json"
        link.symlink_to(target)
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=link,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                offline_roots=["/approved"],
            )
        self.assertEqual(caught.exception.code, "UNSAFE_INPUT_DOCUMENT")

        oversized_data = b"x" * (recovery_intake.MAX_INPUT_DOCUMENT_BYTES + 1)
        oversized, digest = self.write_document("oversized.json", oversized_data)
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=oversized,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                offline_roots=["/approved"],
            )
        self.assertEqual(caught.exception.code, "INPUT_DOCUMENT_TOO_LARGE")

    def test_atomic_output_is_owner_only_and_never_overwrites(self) -> None:
        output = self.temp / "manifest.json"
        manifest = self.build_sealed_offline_manifest()
        emit_manifest(manifest, output=output)
        self.assertEqual(output.read_bytes(), canonical_json_bytes(manifest) + b"\n")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=output)
        self.assertEqual(caught.exception.code, "OUTPUT_ALREADY_EXISTS")
        self.assertEqual(output.read_bytes(), canonical_json_bytes(manifest) + b"\n")

    def test_stdout_emission_is_canonical(self) -> None:
        stream = io.StringIO()
        manifest = self.build_paths(
            ["/offline/fixture.mp4"],
            allowed_roots=("/offline",),
            offline_roots=("/offline",),
        )
        emit_manifest(manifest, output="-", stdout=stream)
        self.assertEqual(stream.getvalue().encode(), canonical_json_bytes(manifest) + b"\n")

    def test_file_emission_requires_sealed_production_manifest(self) -> None:
        manifest = self.build_paths(
            ["/offline/fixture.mp4"],
            allowed_roots=("/offline",),
            offline_roots=("/offline",),
        )
        output = self.temp / "test-seam-manifest.json"
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=output)
        self.assertEqual(caught.exception.code, "FILE_OUTPUT_REQUIRES_SEALED_MANIFEST")
        self.assertFalse(output.exists())

    def test_emit_rejects_casefolded_and_unicode_input_candidate_aliases(self) -> None:
        manifest = self.build_sealed_offline_manifest(candidate_name="ÉVENT.mp4")
        input_path = Path(manifest["input"]["document_path"])
        candidate_path = Path(
            manifest["candidates"][0]["source_locator"]["normalized_absolute_path"]
        )
        aliases = (
            input_path.with_name(input_path.name.upper()),
            candidate_path.with_name("e\u0301vent.MP4"),
        )
        for alias in aliases:
            with self.subTest(alias=alias):
                with self.assertRaises(RecoveryIntakeError) as caught:
                    emit_manifest(manifest, output=alias)
                self.assertEqual(
                    caught.exception.code,
                    "OUTPUT_ALIASES_INPUT_OR_CANDIDATE",
                )

    def test_emit_rejects_casefolded_unicode_alias_beneath_offline_root(self) -> None:
        offline_root = self.temp / "Offline-Évent"
        candidate = offline_root / "fixture.mp4"
        document, digest = self.write_document(
            "offline-alias-output-paths.json",
            self.path_list_bytes([str(candidate)]),
        )
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            offline_roots=[str(offline_root)],
            observation_timeout_seconds=5.0,
        )
        alias_output = self.temp / "offline-e\u0301vent" / "manifest.json"
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=alias_output)
        self.assertEqual(caught.exception.code, "OUTPUT_INSIDE_ALLOWED_ROOT")

    def test_emit_rejects_present_root_ancestry_but_allows_same_device_sibling(
        self,
    ) -> None:
        manifest, present_root = self.build_sealed_present_manifest("resident-media")
        inside_output = present_root / "manifest.json"
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=inside_output)
        self.assertEqual(
            caught.exception.code,
            "OUTPUT_ANCESTOR_MATCHES_ALLOWED_ROOT",
        )
        self.assertFalse(inside_output.exists())

        sibling = self.temp / "manifest-output"
        sibling.mkdir()
        self.assertEqual(present_root.stat().st_dev, sibling.stat().st_dev)
        sibling_output = sibling / "manifest.json"
        emit_manifest(manifest, output=sibling_output)
        self.assertEqual(
            sibling_output.read_bytes(),
            canonical_json_bytes(manifest) + b"\n",
        )

    def test_emit_rejects_case_alias_of_present_root_on_aliasing_filesystem(self) -> None:
        manifest, present_root = self.build_sealed_present_manifest("CaseAliasRoot")
        alias_root = present_root.with_name("casealiasroot")
        if not alias_root.exists() or not alias_root.samefile(present_root):
            self.skipTest("fixture filesystem does not resolve case aliases")
        output = alias_root / "manifest.json"
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=output)
        self.assertEqual(
            caught.exception.code,
            "OUTPUT_ANCESTOR_MATCHES_ALLOWED_ROOT",
        )
        self.assertFalse(output.exists())

    def test_emit_rejects_unicode_alias_of_present_root_on_aliasing_filesystem(
        self,
    ) -> None:
        manifest, present_root = self.build_sealed_present_manifest("MédiaRoot")
        alias_root = present_root.with_name("Me\u0301diaRoot")
        if not alias_root.exists() or not alias_root.samefile(present_root):
            self.skipTest("fixture filesystem does not resolve Unicode normalization aliases")
        output = alias_root / "manifest.json"
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=output)
        self.assertEqual(
            caught.exception.code,
            "OUTPUT_ANCESTOR_MATCHES_ALLOWED_ROOT",
        )
        self.assertFalse(output.exists())

    def test_emit_rejects_symlinked_parent_and_component_exhaustion(self) -> None:
        manifest = self.build_sealed_offline_manifest()
        real_parent = self.temp / "real-output-parent"
        real_parent.mkdir()
        alias_parent = self.temp / "symlink-output-parent"
        alias_parent.symlink_to(real_parent, target_is_directory=True)
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=alias_parent / "manifest.json")
        self.assertEqual(caught.exception.code, "UNSAFE_ROOT")
        self.assertFalse((real_parent / "manifest.json").exists())

        too_many_components = "/" + "/".join(
            ["a"] * (recovery_intake.MAX_PATH_COMPONENTS + 1)
        )
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=too_many_components)
        self.assertEqual(caught.exception.code, "PATH_COMPONENT_LIMIT_EXCEEDED")

    def test_emit_rejects_tampering_and_input_candidate_or_root_destinations(self) -> None:
        manifest = self.build_sealed_offline_manifest()
        tampered = deepcopy(manifest)
        tampered["summary"]["candidate_count"] = 99
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(tampered, output="-", stdout=io.StringIO())
        self.assertEqual(caught.exception.code, "MANIFEST_DIGEST_MISMATCH")

        forbidden = (
            (
                f"{manifest['policy']['offline_roots'][0]}/output.json",
                "OUTPUT_INSIDE_ALLOWED_ROOT",
            ),
            (manifest["input"]["document_path"], "OUTPUT_ALIASES_INPUT_OR_CANDIDATE"),
            (
                manifest["candidates"][0]["source_locator"]["normalized_absolute_path"],
                "OUTPUT_ALIASES_INPUT_OR_CANDIDATE",
            ),
        )
        for output, expected_code in forbidden:
            with self.subTest(output=output):
                with self.assertRaises(RecoveryIntakeError) as caught:
                    emit_manifest(manifest, output=output)
                self.assertEqual(caught.exception.code, expected_code)

    def test_emit_requires_owner_controlled_nonwritable_parent(self) -> None:
        unsafe_parent = self.temp / "unsafe-output"
        unsafe_parent.mkdir(mode=0o700)
        unsafe_parent.chmod(0o770)
        self.addCleanup(lambda: unsafe_parent.chmod(0o700))
        manifest = self.build_sealed_offline_manifest()
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest(manifest, output=unsafe_parent / "manifest.json")
        self.assertEqual(caught.exception.code, "UNSAFE_OUTPUT_PARENT")

    def test_post_publish_durability_failure_is_explicit(self) -> None:
        manifest = self.build_sealed_offline_manifest()
        output = self.temp / "durability-failure.json"
        real_fsync = recovery_intake.os.fsync
        calls = 0

        def fail_directory_fsync(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("fixture directory fsync failure")
            return real_fsync(fd)

        with patch.object(recovery_intake.os, "fsync", side_effect=fail_directory_fsync):
            with self.assertRaises(RecoveryIntakeError) as caught:
                emit_manifest(manifest, output=output)
        self.assertEqual(caught.exception.code, "OUTPUT_PUBLISHED_DURABILITY_FAILED")
        self.assertTrue(output.exists())

        cleanup_output = self.temp / "cleanup-failure.json"
        with patch.object(
            recovery_intake.os,
            "unlink",
            side_effect=OSError("fixture temporary unlink failure"),
        ):
            with self.assertRaises(RecoveryIntakeError) as caught:
                emit_manifest(manifest, output=cleanup_output)
        self.assertEqual(caught.exception.code, "OUTPUT_PUBLISHED_CLEANUP_FAILED")
        self.assertTrue(cleanup_output.exists())

    def test_allowed_root_policy_rejects_missing_and_overlapping_roots(self) -> None:
        data = self.path_list_bytes(["/approved/a.mp4"])
        document, digest = self.write_document("paths.json", data)
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[],
                offline_roots=[],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "MISSING_ALLOWED_ROOT")
        with self.assertRaises(RecoveryIntakeError) as caught:
            recovery_intake._build_manifest_for_test(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                present_root_pins=[
                    PresentRootPin("/approved", 1, 2),
                    PresentRootPin("/approved/nested", 1, 3),
                ],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "OVERLAPPING_ALLOWED_ROOTS")

    def test_allowed_root_policy_rejects_casefolded_and_unicode_aliases(self) -> None:
        fixtures = (
            (
                [
                    PresentRootPin("/media/Allowed", 1, 2),
                    PresentRootPin("/MEDIA/allowed", 1, 3),
                ],
                (),
                "DUPLICATE_ROOT",
            ),
            (
                [PresentRootPin("/media/Évent", 1, 2)],
                ("/media/e\u0301vent",),
                "ROOT_MODE_CONFLICT",
            ),
        )
        document, digest = self.write_document(
            "root-aliases.json",
            self.path_list_bytes(["/outside/candidate.mp4"]),
        )
        for pins, offline_roots, expected_code in fixtures:
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(RecoveryIntakeError) as caught:
                    recovery_intake._build_manifest_for_test(
                        input_path=document,
                        input_kind="PATH_LIST_JSON",
                        expected_input_sha256=digest,
                        present_root_pins=pins,
                        offline_roots=offline_roots,
                        filesystem_observer=FakeObserver(),
                    )
                self.assertEqual(caught.exception.code, expected_code)


if __name__ == "__main__":
    unittest.main()
