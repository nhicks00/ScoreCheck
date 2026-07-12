from __future__ import annotations

from dataclasses import replace
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import vision_scoring.decoder_runtime as decoder_runtime
from vision_scoring.decoder_runtime import (
    DECODER_RUNTIME_DOMAIN,
    MAX_DECODER_RUNTIME_MANIFEST_BYTES,
    DecoderRuntimeDependencyV1,
    DecoderRuntimeError,
    DecoderRuntimeManifestV1,
    PinnedSystemRuntimeMeasurementV1,
    load_verified_decoder_runtime,
    normalized_decoder_version_output_sha256,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    ImmutableStoreError,
    bootstrap_generation_lock,
    generation_write_lock,
)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class DecoderRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store_root = Path(self.temporary_directory.name) / "runtime-store"
        (self.store_root / "locks").mkdir(parents=True)
        (self.store_root / "generations").mkdir()
        self.ffmpeg = b"synthetic-ffmpeg-executable\n"
        self.ffprobe = b"synthetic-ffprobe-executable\n"
        self.library = b"synthetic-avcodec-library\n"
        self.manifest = DecoderRuntimeManifestV1(
            runtime_id="decoder-runtime-fixture-v1",
            platform="darwin",
            architecture="arm64",
            abi="macos-15-arm64",
            ffmpeg_object_sha256=_sha(self.ffmpeg),
            ffprobe_object_sha256=_sha(self.ffprobe),
            ffmpeg_version_output_sha256=normalized_decoder_version_output_sha256(
                b"ffmpeg fixture 1\r\n"
            ),
            ffprobe_version_output_sha256=normalized_decoder_version_output_sha256(
                b"ffprobe fixture 1\n"
            ),
            configure_flags=("--disable-network", "--enable-static"),
            build_flags=("AR=llvm-ar", "CC=clang"),
            decoder_recipe_sha256=_sha(b"decoder recipe v1"),
            dependency_closure=(
                DecoderRuntimeDependencyV1(
                    install_name="@rpath/libavcodec.fixture.dylib",
                    object_sha256=_sha(self.library),
                ),
            ),
            system_runtime_measurement=PinnedSystemRuntimeMeasurementV1(
                runtime_id="macos-runtime-fixture-v1",
                measurement_sha256=_sha(b"macos system runtime measurement"),
                allowed_install_names=("/usr/lib/libSystem.B.dylib",),
            ),
            license_review_ref="sha256:" + _sha(b"license review"),
        )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _publish(
        self,
        manifest: DecoderRuntimeManifestV1 | None = None,
        *,
        descriptor_digests: tuple[str, ...] | None = None,
        object_overrides: dict[str, bytes] | None = None,
    ) -> tuple[GenerationDescriptor, DecoderRuntimeManifestV1, Path]:
        selected = manifest or self.manifest
        manifest_raw = selected.to_json_bytes()
        objects = {
            selected.fingerprint(): manifest_raw,
            selected.ffmpeg_object_sha256: self.ffmpeg,
            selected.ffprobe_object_sha256: self.ffprobe,
        }
        if object_overrides:
            objects.update(object_overrides)
        for dependency in selected.dependency_closure:
            if dependency.object_sha256 == _sha(self.library):
                objects[dependency.object_sha256] = self.library
            elif dependency.object_sha256 not in objects:
                raise ValueError("test dependency payload must be supplied")
        digests = descriptor_digests or tuple(sorted(objects))
        descriptor = GenerationDescriptor.build(digests)
        bootstrap_generation_lock(self.store_root, descriptor.generation_id)
        generation = self.store_root / "generations" / descriptor.generation_id
        object_directory = generation / "objects"
        object_directory.mkdir(parents=True)
        for digest in digests:
            if digest in objects:
                (object_directory / digest).write_bytes(objects[digest])
        (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
        return descriptor, selected, generation

    def _load(self, descriptor: GenerationDescriptor, manifest: DecoderRuntimeManifestV1):
        return load_verified_decoder_runtime(
            runtime_store_root=self.store_root,
            generation_id=descriptor.generation_id,
            manifest_sha256=manifest.fingerprint(),
            expected_manifest_sha256=manifest.fingerprint(),
            expected_platform=manifest.platform,
            expected_architecture=manifest.architecture,
            expected_abi=manifest.abi,
            expected_system_runtime_id=(
                manifest.system_runtime_measurement.runtime_id
            ),
            expected_system_runtime_measurement_sha256=(
                manifest.system_runtime_measurement.measurement_sha256
            ),
        )

    def assert_runtime_error(self, code: str, operation: object) -> DecoderRuntimeError:
        self.assertTrue(callable(operation))
        with self.assertRaises(DecoderRuntimeError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_manifest_is_strict_canonical_and_version_normalization_is_stable(self) -> None:
        raw = self.manifest.to_json_bytes()
        self.assertEqual(DecoderRuntimeManifestV1.from_json_bytes(raw), self.manifest)
        self.assertEqual(_sha(raw), self.manifest.fingerprint())
        self.assertEqual(
            normalized_decoder_version_output_sha256(b"\r\nffmpeg 1 \t\r\n\r\n"),
            normalized_decoder_version_output_sha256(b"ffmpeg 1\n"),
        )
        payload = json.loads(raw)
        self.assertEqual(payload["domain"], DECODER_RUNTIME_DOMAIN)
        self.assertNotIn("admissible_for_training", payload)
        self.assertNotIn("authority", payload)

        self.assert_runtime_error(
            "WIRE",
            lambda: DecoderRuntimeManifestV1.from_json_bytes(raw + b"\n"),
        )
        duplicated = raw.replace(
            b'{"abi":', b'{"abi":"duplicate","abi":', 1
        )
        self.assert_runtime_error(
            "WIRE", lambda: DecoderRuntimeManifestV1.from_json_bytes(duplicated)
        )
        self.assert_runtime_error(
            "WIRE",
            lambda: DecoderRuntimeManifestV1.from_json_bytes(
                b"x" * (MAX_DECODER_RUNTIME_MANIFEST_BYTES + 1)
            ),
        )
        wrong_schema = json.loads(raw)
        wrong_schema["schema_version"] = "2.0"
        wrong_schema_raw = json.dumps(
            wrong_schema,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        self.assert_runtime_error(
            "WIRE",
            lambda: DecoderRuntimeManifestV1.from_json_bytes(wrong_schema_raw),
        )

    def test_manifest_rejects_schema_order_alias_and_duplicate_install_names(self) -> None:
        with self.assertRaisesRegex(ValueError, "schema_version"):
            replace(self.manifest, schema_version="2.0")
        ordered_flags = replace(
            self.manifest,
            configure_flags=(
                "--enable-static",
                "--disable-network",
                "--enable-static",
            ),
        )
        self.assertEqual(
            DecoderRuntimeManifestV1.from_json_bytes(
                ordered_flags.to_json_bytes()
            ).configure_flags,
            ordered_flags.configure_flags,
        )
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            replace(self.manifest, configure_flags=["--enable-static"])  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "distinct digests"):
            replace(
                self.manifest,
                ffprobe_object_sha256=self.manifest.ffmpeg_object_sha256,
            )
        with self.assertRaisesRegex(ValueError, "evidence roles must be distinct"):
            replace(
                self.manifest,
                ffprobe_version_output_sha256=(
                    self.manifest.ffmpeg_version_output_sha256
                ),
            )
        second = DecoderRuntimeDependencyV1(
            install_name=self.manifest.dependency_closure[0].install_name,
            object_sha256=_sha(b"second library"),
        )
        with self.assertRaisesRegex(ValueError, "uniquely ordered"):
            replace(
                self.manifest,
                dependency_closure=(self.manifest.dependency_closure[0], second),
            )
        with self.assertRaisesRegex(ValueError, "exact DecoderRuntimeDependency"):
            replace(self.manifest, dependency_closure=(object(),))

    def test_exact_runtime_closure_stages_private_modes_and_grants_no_admission(self) -> None:
        descriptor, manifest, _ = self._publish()
        staged_directory: Path | None = None
        with self._load(descriptor, manifest) as runtime:
            ffmpeg_path = runtime._executable_path("ffmpeg")
            ffprobe_path = runtime._executable_path("ffprobe")
            dependency_path = runtime._dependency_path(0)
            staged_directory = ffmpeg_path.parent
            self.assertEqual(ffmpeg_path.read_bytes(), self.ffmpeg)
            self.assertEqual(ffprobe_path.read_bytes(), self.ffprobe)
            self.assertEqual(dependency_path.read_bytes(), self.library)
            self.assertEqual(stat.S_IMODE(ffmpeg_path.stat().st_mode), 0o500)
            self.assertEqual(stat.S_IMODE(ffprobe_path.stat().st_mode), 0o500)
            self.assertEqual(stat.S_IMODE(dependency_path.stat().st_mode), 0o400)
            self.assertEqual(stat.S_IMODE(staged_directory.stat().st_mode), 0o500)
            self.assertEqual(runtime.runtime_id, manifest.runtime_id)
            self.assertEqual(
                runtime.decoder_recipe_sha256,
                manifest.decoder_recipe_sha256,
            )
            self.assertEqual(runtime._runtime_manifest(), manifest)
            self.assertFalse(runtime.admissible_for_training)
            self.assertFalse(runtime.admissible_for_evaluation)
            self.assertFalse(runtime.admissible_for_test)
            self.assertFalse(runtime.admissible_for_deployment)
            self.assertFalse(runtime.admissible_for_live_scoring)
            self.assertNotIn(str(self.store_root), repr(runtime))
            self.assertNotIn(str(staged_directory), repr(runtime))
            with self.assertRaises(AttributeError):
                _ = runtime.__dict__
            with self.assertRaises(ImmutableStoreError) as busy:
                with generation_write_lock(
                    self.store_root,
                    descriptor.generation_id,
                    blocking=False,
                ):
                    pass
            self.assertEqual(busy.exception.code, "GENERATION_BUSY")
        self.assertIsNotNone(staged_directory)
        self.assertFalse(staged_directory.exists())  # type: ignore[union-attr]
        with self.assertRaisesRegex(RuntimeError, "not active"):
            runtime._executable_path("ffmpeg")

    def test_wrong_root_pin_and_platform_fail_before_or_during_loading(self) -> None:
        descriptor, manifest, _ = self._publish()
        kwargs = {
            "runtime_store_root": self.store_root,
            "generation_id": descriptor.generation_id,
            "manifest_sha256": manifest.fingerprint(),
            "expected_manifest_sha256": "0" * 64,
            "expected_platform": manifest.platform,
            "expected_architecture": manifest.architecture,
            "expected_abi": manifest.abi,
            "expected_system_runtime_id": manifest.system_runtime_measurement.runtime_id,
            "expected_system_runtime_measurement_sha256": manifest.system_runtime_measurement.measurement_sha256,
        }
        self.assert_runtime_error(
            "PIN", lambda: load_verified_decoder_runtime(**kwargs).__enter__()
        )
        kwargs["expected_manifest_sha256"] = manifest.fingerprint()
        kwargs["expected_platform"] = "linux"
        self.assert_runtime_error(
            "PLATFORM", lambda: load_verified_decoder_runtime(**kwargs).__enter__()
        )

    def test_missing_extra_and_tampered_runtime_objects_fail_closed(self) -> None:
        manifest_sha = self.manifest.fingerprint()
        missing = tuple(
            sorted(
                (
                    manifest_sha,
                    self.manifest.ffmpeg_object_sha256,
                    self.manifest.ffprobe_object_sha256,
                )
            )
        )
        descriptor, manifest, _ = self._publish(descriptor_digests=missing)
        self.assert_runtime_error(
            "CLOSURE", lambda: self._load(descriptor, manifest).__enter__()
        )

        extra_payload = b"undeclared extra object"
        extra_digest = _sha(extra_payload)
        full = tuple(
            sorted(
                (
                    manifest_sha,
                    *self.manifest.object_sha256s(),
                    extra_digest,
                )
            )
        )
        descriptor, manifest, _ = self._publish(
            descriptor_digests=full,
            object_overrides={extra_digest: extra_payload},
        )
        self.assert_runtime_error(
            "CLOSURE", lambda: self._load(descriptor, manifest).__enter__()
        )

        descriptor, manifest, generation = self._publish()
        target = generation / "objects" / manifest.ffmpeg_object_sha256
        target.write_bytes(b"tampered")
        self.assert_runtime_error(
            "OBJECT", lambda: self._load(descriptor, manifest).__enter__()
        )

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_runtime_object_symlink_and_hardlink_aliases_are_rejected(self) -> None:
        descriptor, manifest, generation = self._publish()
        target = generation / "objects" / manifest.ffmpeg_object_sha256
        saved = generation / "saved-ffmpeg"
        target.rename(saved)
        target.symlink_to(saved)
        self.assert_runtime_error(
            "OBJECT", lambda: self._load(descriptor, manifest).__enter__()
        )
        target.unlink()
        saved.rename(target)
        os.link(target, generation / "ffmpeg-alias")
        self.assert_runtime_error(
            "OBJECT", lambda: self._load(descriptor, manifest).__enter__()
        )

    def test_body_exception_still_cleans_staging_and_closes_lease(self) -> None:
        descriptor, manifest, _ = self._publish()
        staged_directory: Path | None = None
        with self.assertRaisesRegex(RuntimeError, "coordinator failed"):
            with self._load(descriptor, manifest) as runtime:
                staged_directory = runtime._executable_path("ffmpeg").parent
                raise RuntimeError("coordinator failed")
        self.assertIsNotNone(staged_directory)
        self.assertFalse(staged_directory.exists())  # type: ignore[union-attr]
        with generation_write_lock(
            self.store_root, descriptor.generation_id, blocking=False
        ):
            pass

    def test_private_directory_setup_failure_does_not_leak_mkdtemp_path(self) -> None:
        descriptor, manifest, _ = self._publish()
        original_mkdtemp = tempfile.mkdtemp
        created: list[Path] = []

        def record_mkdtemp(*args: object, **kwargs: object) -> str:
            result = original_mkdtemp(*args, **kwargs)  # type: ignore[arg-type]
            created.append(Path(result))
            return result

        with (
            patch.object(decoder_runtime.tempfile, "mkdtemp", record_mkdtemp),
            patch.object(decoder_runtime.os, "chmod", side_effect=OSError("denied")),
        ):
            self.assert_runtime_error(
                "EXECUTABLE", lambda: self._load(descriptor, manifest).__enter__()
            )
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

        before_fds = len(os.listdir("/dev/fd"))
        created.clear()
        original_fstat = os.fstat
        failed = False

        def fail_fstat_once(descriptor: int) -> os.stat_result:
            nonlocal failed
            if not failed:
                failed = True
                raise OSError("one-shot fstat failure")
            return original_fstat(descriptor)

        with (
            patch.object(decoder_runtime.tempfile, "mkdtemp", record_mkdtemp),
            patch.object(decoder_runtime.os, "fstat", side_effect=fail_fstat_once),
        ):
            self.assert_runtime_error(
                "EXECUTABLE",
                lambda: decoder_runtime._private_directory("runtime-fault-"),
            )
        self.assertEqual(len(os.listdir("/dev/fd")), before_fds)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_partial_stage_failures_scrub_every_expected_child_name(self) -> None:
        descriptor, manifest, _ = self._publish()
        original_mkdtemp = tempfile.mkdtemp
        original_fsync = os.fsync
        original_unlink = os.unlink

        for failed_fsync_call, attempted_name in enumerate(
            ("ffmpeg", "ffprobe", "dependency-0000"),
            start=1,
        ):
            with self.subTest(attempted_name=attempted_name):
                created: list[Path] = []
                fsync_calls = 0
                local_unlink_failed = False
                before_fds = len(os.listdir("/dev/fd"))

                def record_mkdtemp(*args: object, **kwargs: object) -> str:
                    result = original_mkdtemp(*args, **kwargs)  # type: ignore[arg-type]
                    created.append(Path(result))
                    return result

                def fail_selected_fsync(file_descriptor: int) -> None:
                    nonlocal fsync_calls
                    fsync_calls += 1
                    if fsync_calls == failed_fsync_call:
                        raise OSError("injected runtime staging fsync failure")
                    original_fsync(file_descriptor)

                def fail_first_local_unlink(
                    path: object,
                    *args: object,
                    **kwargs: object,
                ) -> None:
                    nonlocal local_unlink_failed
                    if (
                        path == attempted_name
                        and kwargs.get("dir_fd") is not None
                        and not local_unlink_failed
                    ):
                        local_unlink_failed = True
                        raise OSError("injected one-shot local unlink failure")
                    original_unlink(path, *args, **kwargs)  # type: ignore[arg-type]

                with (
                    patch.object(decoder_runtime.tempfile, "mkdtemp", record_mkdtemp),
                    patch.object(decoder_runtime.os, "fsync", fail_selected_fsync),
                    patch.object(decoder_runtime.os, "unlink", fail_first_local_unlink),
                ):
                    self.assert_runtime_error(
                        "EXECUTABLE" if failed_fsync_call < 3 else "OBJECT",
                        lambda: self._load(descriptor, manifest).__enter__(),
                    )
                self.assertTrue(local_unlink_failed)
                self.assertEqual(len(created), 1)
                self.assertFalse(created[0].exists())
                self.assertEqual(len(os.listdir("/dev/fd")), before_fds)

    def test_private_close_never_retries_a_reused_foreign_descriptor(self) -> None:
        original_close = os.close
        owned_path = Path(self.temporary_directory.name) / "owned-close-source"
        owned_path.write_bytes(b"owned")
        descriptor = os.open(owned_path, os.O_RDONLY)
        first = True

        def close_then_reuse(selected: int) -> None:
            nonlocal first
            if first and selected == descriptor:
                first = False
                original_close(selected)
                # Reopen the same inode to prove dev+ino cannot establish
                # open-file-description ownership after an ambiguous close.
                foreign = os.open(owned_path, os.O_RDONLY)
                if foreign != selected:
                    os.dup2(foreign, selected)
                    original_close(foreign)
                raise OSError("close result is ownership-ambiguous")
            original_close(selected)

        with patch.object(decoder_runtime.os, "close", close_then_reuse):
            self.assertFalse(decoder_runtime._close_private_descriptor(descriptor))
        self.assertEqual(os.read(descriptor, 5), b"owned")
        original_close(descriptor)

    def test_total_closure_limit_is_enforced_before_an_object_can_overrun_it(self) -> None:
        descriptor, manifest, _ = self._publish()
        fixed_limit = len(manifest.to_json_bytes()) + len(self.ffmpeg) + 1
        with patch.object(
            decoder_runtime,
            "MAX_DECODER_RUNTIME_TOTAL_BYTES",
            fixed_limit,
        ):
            self.assert_runtime_error(
                "OBJECT", lambda: self._load(descriptor, manifest).__enter__()
            )

    def test_empty_dependency_object_is_structurally_rejected(self) -> None:
        empty_digest = _sha(b"")
        manifest = replace(
            self.manifest,
            dependency_closure=(
                DecoderRuntimeDependencyV1(
                    install_name="@rpath/libempty.fixture.dylib",
                    object_sha256=empty_digest,
                ),
            ),
        )
        descriptor, manifest, _ = self._publish(
            manifest,
            object_overrides={empty_digest: b""},
        )
        self.assert_runtime_error(
            "OBJECT", lambda: self._load(descriptor, manifest).__enter__()
        )

    def test_accessor_rejects_content_mode_hardlink_and_dataless_mutation(self) -> None:
        descriptor, manifest, _ = self._publish()
        with self.assertRaises(DecoderRuntimeError) as mutated:
            with self._load(descriptor, manifest) as runtime:
                path = runtime._executable_path("ffmpeg")
                os.chmod(path, 0o700)
                path.write_bytes(b"mutated-runtime")
                runtime._executable_path("ffmpeg")
        self.assertEqual(mutated.exception.code, "OBJECT")

        hardlink_manifest = replace(
            self.manifest,
            runtime_id="decoder-runtime-hardlink-fixture-v1",
        )
        descriptor, manifest, _ = self._publish(hardlink_manifest)
        with self.assertRaises(DecoderRuntimeError) as hardlinked:
            with self._load(descriptor, manifest) as runtime:
                path = runtime._executable_path("ffmpeg")
                alias = Path(self.temporary_directory.name) / "runtime-alias"
                os.link(path, alias)
                runtime._executable_path("ffmpeg")
        self.assertEqual(hardlinked.exception.code, "OBJECT")

        dataless_manifest = replace(
            self.manifest,
            runtime_id="decoder-runtime-dataless-fixture-v1",
        )
        descriptor, manifest, _ = self._publish(dataless_manifest)
        with self.assertRaises(DecoderRuntimeError) as dataless:
            with self._load(descriptor, manifest) as runtime:
                with patch.object(
                    decoder_runtime,
                    "_is_dataless",
                    side_effect=lambda value: stat.S_ISREG(value.st_mode),
                ):
                    runtime._executable_path("ffmpeg")
        self.assertEqual(dataless.exception.code, "OBJECT")

    def test_accessor_rejects_replaced_child_or_directory_snapshot(self) -> None:
        descriptor, manifest, _ = self._publish()
        with self.assertRaises(DecoderRuntimeError) as replaced:
            with self._load(descriptor, manifest) as runtime:
                path = runtime._executable_path("ffmpeg")
                os.chmod(path.parent, 0o700)
                replacement = path.parent / "replacement"
                replacement.write_bytes(self.ffmpeg)
                os.chmod(replacement, 0o500)
                os.replace(replacement, path)
                runtime._executable_path("ffmpeg")
        self.assertIn(replaced.exception.code, {"EXECUTABLE", "OBJECT"})

    def test_directory_rename_scrubs_bound_children_without_path_traversal(self) -> None:
        descriptor, manifest, _ = self._publish()
        renamed: Path | None = None
        with self.assertRaises(DecoderRuntimeError) as cleanup:
            with self._load(descriptor, manifest) as runtime:
                original = runtime._executable_path("ffmpeg").parent
                renamed = original.with_name(original.name + "-renamed")
                original.rename(renamed)
        self.assertEqual(cleanup.exception.code, "CLEANUP")
        self.assertIsNotNone(renamed)
        self.assertEqual(list(renamed.iterdir()), [])  # type: ignore[union-attr]
        renamed.rmdir()  # type: ignore[union-attr]

    def test_teardown_never_closes_a_reused_directory_descriptor(self) -> None:
        descriptor, manifest, _ = self._publish()
        foreign_path = Path(self.temporary_directory.name) / "foreign-directory-fd"
        foreign_path.write_bytes(b"foreign")
        outer = self._load(descriptor, manifest)
        runtime = outer.__enter__()
        runtime_path = runtime._executable_path("ffmpeg").parent
        directory_fd = runtime._directory_fd
        os.close(directory_fd)
        foreign_fd = os.open(foreign_path, os.O_RDONLY)
        if foreign_fd != directory_fd:
            os.dup2(foreign_fd, directory_fd)
            os.close(foreign_fd)

        with self.assertRaises(DecoderRuntimeError) as cleanup:
            outer.__exit__(None, None, None)
        self.assertEqual(cleanup.exception.code, "CLEANUP")
        self.assertEqual(os.read(directory_fd, 7), b"foreign")
        os.close(directory_fd)

        # Direct access to the private fd violates the capability contract, so
        # fail-closed teardown cannot safely scrub the now-unreachable children.
        os.chmod(runtime_path, 0o700)
        for child in runtime_path.iterdir():
            child.unlink()
        runtime_path.rmdir()

    def test_replaced_original_path_is_never_traversed_or_deleted(self) -> None:
        descriptor, manifest, _ = self._publish()
        renamed: Path | None = None
        original: Path | None = None
        foreign = Path(self.temporary_directory.name) / "foreign-runtime-dir"
        foreign.mkdir()
        marker = foreign / "keep"
        marker.write_bytes(b"foreign")
        with self.assertRaises(DecoderRuntimeError) as cleanup:
            with self._load(descriptor, manifest) as runtime:
                original = runtime._executable_path("ffmpeg").parent
                renamed = original.with_name(original.name + "-bound")
                original.rename(renamed)
                original.symlink_to(foreign, target_is_directory=True)
        self.assertEqual(cleanup.exception.code, "CLEANUP")
        self.assertEqual(marker.read_bytes(), b"foreign")
        self.assertEqual(list(renamed.iterdir()), [])  # type: ignore[union-attr]
        original.unlink()  # type: ignore[union-attr]
        renamed.rmdir()  # type: ignore[union-attr]

        foreign_manifest = replace(
            self.manifest,
            runtime_id="decoder-runtime-foreign-path-fixture-v1",
        )
        descriptor, manifest, _ = self._publish(foreign_manifest)
        foreign_path_marker: Path | None = None
        renamed = None
        original = None
        with self.assertRaises(DecoderRuntimeError) as directory_cleanup:
            with self._load(descriptor, manifest) as runtime:
                original = runtime._executable_path("ffmpeg").parent
                renamed = original.with_name(original.name + "-foreign-bound")
                original.rename(renamed)
                original.mkdir()
                foreign_path_marker = original / "keep"
                foreign_path_marker.write_bytes(b"foreign-directory")
        self.assertEqual(directory_cleanup.exception.code, "CLEANUP")
        self.assertEqual(foreign_path_marker.read_bytes(), b"foreign-directory")  # type: ignore[union-attr]
        self.assertEqual(list(renamed.iterdir()), [])  # type: ignore[union-attr]
        foreign_path_marker.unlink()  # type: ignore[union-attr]
        original.rmdir()  # type: ignore[union-attr]
        renamed.rmdir()  # type: ignore[union-attr]

    def test_loader_inputs_are_exact_and_paths_do_not_fall_back_to_ambient(self) -> None:
        descriptor, manifest, _ = self._publish()
        kwargs = {
            "runtime_store_root": str(self.store_root),
            "generation_id": descriptor.generation_id,
            "manifest_sha256": manifest.fingerprint(),
            "expected_manifest_sha256": manifest.fingerprint(),
            "expected_platform": manifest.platform,
            "expected_architecture": manifest.architecture,
            "expected_abi": manifest.abi,
            "expected_system_runtime_id": manifest.system_runtime_measurement.runtime_id,
            "expected_system_runtime_measurement_sha256": manifest.system_runtime_measurement.measurement_sha256,
        }
        self.assert_runtime_error(
            "RUNTIME_INPUT", lambda: load_verified_decoder_runtime(**kwargs).__enter__()
        )
        self.assertNotIn("PATH", self.manifest.to_dict())


if __name__ == "__main__":
    unittest.main()
