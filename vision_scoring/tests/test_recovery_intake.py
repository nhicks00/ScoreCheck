from __future__ import annotations

from copy import deepcopy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from vision_scoring import recovery_intake
from vision_scoring.recovery_intake import (
    BoundedFilesystemObserver,
    CandidateAvailability,
    DescriptorFilesystemObserver,
    FileMetadata,
    ObservationBatch,
    PathObservation,
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


def directory_metadata() -> FileMetadata:
    return FileMetadata(
        device=1,
        inode=2,
        mode=stat.S_IFDIR | 0o700,
        link_count=2,
        size_bytes=0,
        modified_ns=3,
        changed_ns=4,
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
                roots.append(
                    RootObservation(
                        path=root,
                        status=RootAvailability.PRESENT_DIRECTORY,
                        metadata=directory_metadata(),
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
        return build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            allowed_roots=allowed_roots,
            offline_roots=offline_roots,
            filesystem_observer=observer or FakeObserver(),
        )

    def test_manifest_is_deterministic_and_digest_commits_payload(self) -> None:
        observer = FakeObserver()
        data = self.path_list_bytes(["/approved/Beach Volleyball Match.mp4"])
        document, digest = self.write_document("paths.json", data)
        arguments = dict(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            allowed_roots=["/approved"],
            filesystem_observer=observer,
        )
        first = build_manifest(**arguments)
        second = build_manifest(**arguments)

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

    def test_input_digest_is_checked_before_observer_runs(self) -> None:
        document, _ = self.write_document(
            "paths.json", self.path_list_bytes(["/approved/a.mp4"])
        )
        observer = FakeObserver()
        with self.assertRaisesRegex(RecoveryIntakeError, "expected SHA-256") as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256="0" * 64,
                allowed_roots=["/approved"],
                filesystem_observer=observer,
            )
        self.assertEqual(caught.exception.code, "INPUT_DIGEST_MISMATCH")
        self.assertEqual(observer.calls, [])

    def test_strict_csv_builds_offline_high_priority_candidate(self) -> None:
        path = "/offline/Beach Volleyball Match Final.mp4"
        document, digest = self.write_document(
            "probe.csv", self.probe_csv_bytes([self.probe_row(path)])
        )
        manifest = build_manifest(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            allowed_roots=["/offline"],
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
            build_manifest(
                input_path=document,
                input_kind="PRIOR_PROBE_CSV",
                expected_input_sha256=digest,
                allowed_roots=["/approved"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "INVALID_CSV_HEADER")

    def test_invalid_relative_csv_path_is_rejected_without_losing_valid_record(self) -> None:
        rows = [
            self.probe_row(".mp4", filename=".mp4", parent=".", extension=""),
            self.probe_row("/approved/a.mp4"),
        ]
        document, digest = self.write_document("probe.csv", self.probe_csv_bytes(rows))
        manifest = build_manifest(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            allowed_roots=["/approved"],
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
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                allowed_roots=["/approved"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "DUPLICATE_NORMALIZED_LOCATOR")

    def test_json_duplicate_keys_and_surrogate_locator_fail_closed(self) -> None:
        duplicate = b'{"schema_version":"1.0","paths":[],"paths":[]}'
        document, digest = self.write_document("duplicate.json", duplicate)
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                allowed_roots=["/approved"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "MALFORMED_PATH_LIST_JSON")

        surrogate = (
            b'{"paths":["/approved/\\ud800.mp4","/approved/ok.mp4"],'
            b'"schema_version":"1.0"}'
        )
        document, digest = self.write_document("surrogate.json", surrogate)
        manifest = build_manifest(
            input_path=document,
            input_kind="PATH_LIST_JSON",
            expected_input_sha256=digest,
            allowed_roots=["/approved"],
            filesystem_observer=FakeObserver(),
        )
        self.assertEqual(manifest["summary"]["candidate_count"], 1)
        self.assertEqual(manifest["rejected_records"][0]["code"], "PATH_INVALID_UNICODE")

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
        manifest = build_manifest(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            allowed_roots=["/approved"],
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
        manifest = build_manifest(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            allowed_roots=["/resident", "/offline"],
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
        csv_manifest = build_manifest(
            input_path=document,
            input_kind="PRIOR_PROBE_CSV",
            expected_input_sha256=digest,
            allowed_roots=["/offline"],
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
            batch = DescriptorFilesystemObserver().observe(
                paths_by_root={str(root): (str(media),)},
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

        batch = DescriptorFilesystemObserver().observe(
            paths_by_root={str(root): (str(candidate),)},
            offline_roots=frozenset(),
            deadline_seconds=5.0,
        )
        self.assertEqual(
            batch.paths[0].status,
            CandidateAvailability.UNSUPPORTED_LOCAL_ENTRY,
        )
        self.assertEqual(batch.paths[0].reason_code, "UNSAFE_PATH_COMPONENT")

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
            allowed_roots=[str(offline_root)],
            offline_roots=[str(offline_root)],
            observation_timeout_seconds=5.0,
        )
        self.assertEqual(
            manifest["candidates"][0]["availability"]["status"],
            "REFERENCED_OFFLINE",
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
            allowed_roots=[str(resident_root)],
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

    def test_bounded_worker_timeout_is_killable(self) -> None:
        class TimedOutProcess:
            pid = 12345
            returncode = -9

            def __init__(self):
                self.calls = 0

            def communicate(self, input=None, timeout=None):
                del input, timeout
                self.calls += 1
                if self.calls == 1:
                    raise recovery_intake.subprocess.TimeoutExpired(["worker"], 0.1)
                return b"", b""

            def poll(self):
                return self.returncode if self.calls > 1 else None

            def wait(self):
                return self.returncode

        process = TimedOutProcess()
        with (
            patch.object(recovery_intake.subprocess, "Popen", return_value=process),
            patch.object(recovery_intake, "_kill_process_group") as kill,
        ):
            with self.assertRaises(RecoveryIntakeError) as caught:
                BoundedFilesystemObserver().observe(
                    paths_by_root={"/approved": ("/approved/a.mp4",)},
                    offline_roots=frozenset(),
                    deadline_seconds=0.1,
                )
        self.assertEqual(caught.exception.code, "OBSERVATION_DEADLINE_EXCEEDED")
        kill.assert_called_once_with(process)

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
                allowed_roots=["/approved"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "UNSAFE_INPUT_DOCUMENT")

        oversized, digest = self.write_document("oversized.json", b"12345")
        with patch.object(recovery_intake, "MAX_INPUT_DOCUMENT_BYTES", 4):
            with self.assertRaises(RecoveryIntakeError) as caught:
                build_manifest(
                    input_path=oversized,
                    input_kind="PATH_LIST_JSON",
                    expected_input_sha256=digest,
                    allowed_roots=["/approved"],
                    filesystem_observer=FakeObserver(),
                )
        self.assertEqual(caught.exception.code, "INPUT_DOCUMENT_TOO_LARGE")

    def test_atomic_output_is_owner_only_and_never_overwrites(self) -> None:
        output = self.temp / "manifest.json"
        manifest = {"schema_version": "1.0", "value": "fixture"}
        emit_manifest(manifest, output=output)
        self.assertEqual(output.read_bytes(), canonical_json_bytes(manifest) + b"\n")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        with self.assertRaises(RecoveryIntakeError) as caught:
            emit_manifest({"different": True}, output=output)
        self.assertEqual(caught.exception.code, "OUTPUT_ALREADY_EXISTS")
        self.assertEqual(output.read_bytes(), canonical_json_bytes(manifest) + b"\n")

    def test_stdout_emission_is_canonical(self) -> None:
        stream = io.StringIO()
        manifest = {"z": 1, "a": [2, 3]}
        emit_manifest(manifest, output="-", stdout=stream)
        self.assertEqual(stream.getvalue().encode(), canonical_json_bytes(manifest) + b"\n")

    def test_allowed_root_policy_rejects_missing_and_overlapping_roots(self) -> None:
        data = self.path_list_bytes(["/approved/a.mp4"])
        document, digest = self.write_document("paths.json", data)
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                allowed_roots=[],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "MISSING_ALLOWED_ROOT")
        with self.assertRaises(RecoveryIntakeError) as caught:
            build_manifest(
                input_path=document,
                input_kind="PATH_LIST_JSON",
                expected_input_sha256=digest,
                allowed_roots=["/approved", "/approved/nested"],
                filesystem_observer=FakeObserver(),
            )
        self.assertEqual(caught.exception.code, "OVERLAPPING_ALLOWED_ROOTS")


if __name__ == "__main__":
    unittest.main()
