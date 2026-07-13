from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest
from unittest.mock import PropertyMock, patch

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training extras.
    torch = None  # type: ignore[assignment]


if torch is not None:
    import vision_scoring.clip_loader as clip_loader
    import vision_scoring.protected_process as protected_process
    from vision_scoring.annotations import (
        AutorotationPolicy,
        DecodedColorRange,
        DecodedColorSpace,
        DecodedFrameHashBasis,
        DecodedFrameIdentity,
        DecodedPixelFormat,
        FrameDecodeContract,
        FrameDuplicateKind,
        FrameReference,
        PixelCoordinateSpace,
        TimestampBasis,
    )
    from vision_scoring.ball_label_pack import load_ball_label_pack
    from vision_scoring.clip_loader import ClipLoaderError
    from vision_scoring.contract_wire import MAX_SIGNED_64
    from vision_scoring.decoder_runtime import (
        DecoderRuntimeDependencyV1,
        DecoderRuntimeManifestV1,
        PinnedSystemRuntimeMeasurementV1,
        normalized_decoder_version_output_sha256,
    )
    from vision_scoring.immutable_store import (
        GenerationDescriptor,
        bootstrap_generation_lock,
    )
    from vision_scoring.label_bundle import (
        LabelBundleSplit,
        build_causal_ball_label_bundle_v1,
    )

    if __package__:
        from .test_annotation_trust import _attestations
        from .test_ball_label_pack import _contract_payloads
        from .test_ball_target_materialization import _ball
    else:
        from test_annotation_trust import _attestations  # type: ignore[no-redef]
        from test_ball_label_pack import _contract_payloads  # type: ignore[no-redef]
        from test_ball_target_materialization import _ball  # type: ignore[no-redef]


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@unittest.skipIf(torch is None, "clip loader requires the training dependency")
class ClipLoaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.label_store = self._empty_store("label-store")
        self.artifact_store = self._empty_store("artifact-store")
        self.runtime_store = self._empty_store("runtime-store")
        self.frames = (
            bytes(index % 256 for index in range(16 * 16 * 3)),
            bytes((index * 7 + 13) % 256 for index in range(16 * 16 * 3)),
        )
        self.source = b"synthetic-complete-video-source-v1\n"
        self.metadata = b"synthetic-capture-metadata-v1\n"
        self.ffmpeg = b"synthetic-static-ffmpeg-v1\n"
        self.ffprobe = b"synthetic-static-ffprobe-v1\n"
        self.ffmpeg_version = b"ffmpeg fixture 7.2-static\n"
        self.ffprobe_version = b"ffprobe fixture 7.2-static\r\n"
        self.pts = (101, 137)
        self.time_base = (1, 1000)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _empty_store(self, name: str) -> Path:
        root = self.root / name
        (root / "locks").mkdir(parents=True)
        (root / "generations").mkdir()
        return root

    def _publish(
        self,
        store_root: Path,
        payloads: dict[str, bytes],
    ) -> GenerationDescriptor:
        descriptor = GenerationDescriptor.build(tuple(sorted(payloads)))
        generation = store_root / "generations" / descriptor.generation_id
        if generation.is_dir():
            return descriptor
        bootstrap_generation_lock(store_root, descriptor.generation_id)
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for digest, payload in payloads.items():
            self.assertEqual(_sha(payload), digest)
            (objects / digest).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
        return descriptor

    def _fixture(
        self,
        *,
        split: "LabelBundleSplit | None" = None,
        width: int = 16,
        height: int = 16,
        dependency: bool = False,
        duplicate_kind: bool = False,
        selected_video_stream_index: int = 2,
        system_install_names: tuple[str, ...] = ("/usr/lib/libSystem.B.dylib",),
    ) -> dict[str, object]:
        selected_split = split or LabelBundleSplit.TRAIN
        dependency_payload = b"synthetic-nonsystem-runtime-dependency-v1\n"
        dependencies = (
            (
                DecoderRuntimeDependencyV1(
                    install_name="@rpath/libfixture.dylib",
                    object_sha256=_sha(dependency_payload),
                ),
            )
            if dependency
            else ()
        )
        manifest = DecoderRuntimeManifestV1(
            runtime_id="decoder-runtime-static-fixture-v1",
            platform="darwin",
            architecture="arm64",
            abi="macos-15-arm64",
            ffmpeg_object_sha256=_sha(self.ffmpeg),
            ffprobe_object_sha256=_sha(self.ffprobe),
            ffmpeg_version_output_sha256=(
                normalized_decoder_version_output_sha256(self.ffmpeg_version)
            ),
            ffprobe_version_output_sha256=(
                normalized_decoder_version_output_sha256(self.ffprobe_version)
            ),
            configure_flags=("--disable-network", "--enable-static"),
            build_flags=("AR=llvm-ar", "CC=clang"),
            decoder_recipe_sha256=_sha(b"decoder-recipe-static-fixture-v1"),
            dependency_closure=dependencies,
            system_runtime_measurement=PinnedSystemRuntimeMeasurementV1(
                runtime_id="macos-runtime-fixture-v1",
                measurement_sha256=_sha(b"macos-runtime-measurement-fixture-v1"),
                allowed_install_names=system_install_names,
            ),
            license_review_ref="sha256:" + _sha(b"license-review-fixture-v1"),
        )
        manifest_raw = manifest.to_json_bytes()
        runtime_payloads = {
            manifest.fingerprint(): manifest_raw,
            _sha(self.ffmpeg): self.ffmpeg,
            _sha(self.ffprobe): self.ffprobe,
        }
        if dependency:
            runtime_payloads[_sha(dependency_payload)] = dependency_payload
        runtime_descriptor = self._publish(self.runtime_store, runtime_payloads)

        source_sha256 = _sha(self.source)
        decode_contract = FrameDecodeContract(
            decoder_artifact_sha256=manifest.fingerprint(),
            decoder_build_id=manifest.runtime_id,
            autorotation_policy=(AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM),
            color_space=DecodedColorSpace.BT709,
            color_range=DecodedColorRange.LIMITED,
            output_pixel_format=DecodedPixelFormat.RGB24,
            output_width=width,
            output_height=height,
        )
        ontology_sha256 = _sha(b"ball-ontology-loader-fixture-v1")
        annotations = []
        for frame_index, (source_pts, frame) in enumerate(
            zip(self.pts, self.frames, strict=True)
        ):
            timestamp_ns = (
                source_pts * self.time_base[0] * 1_000_000_000
            ) // self.time_base[1]
            base = _ball(frame_index, width=width, height=height)
            identity = DecodedFrameIdentity(
                source_sha256=source_sha256,
                selected_video_stream_index=selected_video_stream_index,
                frame_index=frame_index,
                timestamp_ns=timestamp_ns,
                timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
                pixel_coordinate_space=(
                    PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
                ),
                decode_contract=decode_contract,
                decoded_frame_sha256=_sha(frame),
                decoded_frame_hash_basis=(
                    DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
                ),
            )
            annotations.append(
                replace(
                    base,
                    ontology_sha256=ontology_sha256,
                    frame=FrameReference(
                        identity=identity,
                        duplicate_kind=(
                            FrameDuplicateKind.PIXEL_EQUIVALENT
                            if duplicate_kind and frame_index == 1
                            else FrameDuplicateKind.NONE
                        ),
                        duplicate_of_frame_index=(
                            0 if duplicate_kind and frame_index == 1 else None
                        ),
                    ),
                )
            )
        annotation_tuple = tuple(annotations)
        attestations = tuple(
            attestation
            for annotation in annotation_tuple
            for attestation in _attestations(annotation)
        )
        statement = build_causal_ball_label_bundle_v1(
            bundle_id="bundle-clip-loader-fixture-v1",
            source_asset_sha256=source_sha256,
            finalized_trace_sha256=_sha(b"finalized-trace-loader-fixture-v1"),
            capture_policy_sha256=_sha(b"capture-policy-loader-fixture-v1"),
            capture_policy_generation=3,
            split=selected_split,
            ontology_sha256=ontology_sha256,
            ontology_version="ball-ontology-loader-v1",
            match_ball_instance_id="match-ball",
            annotations=annotation_tuple,
            attestations=attestations,
            annotation_trust_store_sha256=_sha(
                b"annotation-trust-store-loader-fixture-v1"
            ),
            annotation_verification_policy_sha256=_sha(
                b"annotation-verification-policy-loader-fixture-v1"
            ),
        )
        pack_root, label_payloads = _contract_payloads(
            statement,
            annotation_tuple,
            attestations,
        )
        label_descriptor = self._publish(self.label_store, label_payloads)
        artifact_payloads = {
            source_sha256: self.source,
            _sha(self.metadata): self.metadata,
        }
        artifact_descriptor = self._publish(
            self.artifact_store,
            artifact_payloads,
        )
        kwargs = {
            "label_store_root": self.label_store,
            "label_pack_generation_id": label_descriptor.generation_id,
            "label_pack_sha256": pack_root.fingerprint(),
            "artifact_store_root": self.artifact_store,
            "artifact_generation_id": artifact_descriptor.generation_id,
            "artifact_sha256s": artifact_descriptor.object_sha256s,
            "source_byte_length": len(self.source),
            "runtime_store_root": self.runtime_store,
            "runtime_generation_id": runtime_descriptor.generation_id,
            "runtime_manifest_sha256": manifest.fingerprint(),
            "expected_runtime_manifest_sha256": manifest.fingerprint(),
            "expected_platform": manifest.platform,
            "expected_architecture": manifest.architecture,
            "expected_abi": manifest.abi,
            "expected_system_runtime_id": (
                manifest.system_runtime_measurement.runtime_id
            ),
            "expected_system_runtime_measurement_sha256": (
                manifest.system_runtime_measurement.measurement_sha256
            ),
        }
        return {
            "kwargs": kwargs,
            "manifest": manifest,
            "statement": statement,
            "label_descriptor": label_descriptor,
            "artifact_descriptor": artifact_descriptor,
            "runtime_descriptor": runtime_descriptor,
            "pack_root": pack_root,
        }

    def _probe_bytes(
        self,
        *,
        time_base: str | None = None,
        width: int = 16,
        height: int = 16,
        selected_video_stream_index: int = 2,
    ) -> bytes:
        selected_time_base = time_base or f"{self.time_base[0]}/{self.time_base[1]}"
        payload = {
            "frames": [
                {
                    "color_range": "tv",
                    "color_space": "bt709",
                    "height": height,
                    "pix_fmt": "yuv420p",
                    "pts": pts,
                    "stream_index": selected_video_stream_index,
                    "width": width,
                }
                for pts in self.pts
            ],
            "programs": [],
            "stream_groups": [],
            "streams": [
                {
                    "codec_type": "video",
                    "color_range": "tv",
                    "color_space": "bt709",
                    "height": height,
                    "index": selected_video_stream_index,
                    "pix_fmt": "yuv420p",
                    "start_pts": self.pts[0],
                    "time_base": selected_time_base,
                    "width": width,
                }
            ],
        }
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def _framehash_bytes(
        self,
        *,
        time_base: str | None = None,
        durations: tuple[int, ...] = (36, 36),
        hashes: tuple[str, ...] | None = None,
        pts: tuple[int, ...] | None = None,
        width: int = 16,
        height: int = 16,
    ) -> bytes:
        selected_time_base = time_base or f"{self.time_base[0]}/{self.time_base[1]}"
        selected_hashes = hashes or tuple(_sha(frame) for frame in self.frames)
        selected_pts = pts or self.pts
        lines = [
            "#format: frame checksums",
            "#version: 2",
            "#hash: SHA256",
            "#software: Lavf62.12.100",
            f"#tb 0: {selected_time_base}",
            "#media_type 0: video",
            "#codec_id 0: rawvideo",
            f"#dimensions 0: {width}x{height}",
            "#sar 0: 1/1",
            clip_loader._FRAMEHASH_COLUMNS,
        ]
        for source_pts, duration, digest in zip(
            selected_pts,
            durations,
            selected_hashes,
            strict=True,
        ):
            lines.append(
                f"0, {source_pts}, {source_pts}, {duration}, {width * height * 3}, {digest}"
            )
        return ("\n".join(lines) + "\n").encode("ascii")

    def _execution_side_effect(
        self,
        *,
        probe_bytes: bytes | None = None,
        decode_stdout: bytes | None = None,
        decode_auxiliary: bytes | None = None,
        decode_returncode: int = 0,
        decode_stderr: bytes = b"",
        ffprobe_version: bytes | None = None,
        ffmpeg_version: bytes | None = None,
        calls: list[tuple[tuple[str, ...], dict[str, object]]] | None = None,
    ) -> object:
        def execute(
            argv: tuple[str, ...],
            **process_kwargs: object,
        ) -> object:
            if calls is not None:
                calls.append((argv, process_kwargs))
            tool = Path(argv[0]).name
            if argv[-1] == "-version":
                if tool == "ffprobe":
                    value = (
                        self.ffprobe_version
                        if ffprobe_version is None
                        else ffprobe_version
                    )
                else:
                    value = (
                        self.ffmpeg_version
                        if ffmpeg_version is None
                        else ffmpeg_version
                    )
                return protected_process.ProtectedProcessResult(0, value, b"", b"")
            if tool == "ffprobe":
                return protected_process.ProtectedProcessResult(
                    0,
                    self._probe_bytes() if probe_bytes is None else probe_bytes,
                    b"",
                    b"",
                )
            return protected_process.ProtectedProcessResult(
                decode_returncode,
                b"".join(self.frames) if decode_stdout is None else decode_stdout,
                decode_stderr,
                (
                    self._framehash_bytes()
                    if decode_auxiliary is None
                    else decode_auxiliary
                ),
            )

        return execute

    def _plan(self, fixture: dict[str, object]) -> object:
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        evidence = load_ball_label_pack(
            label_store_root=kwargs["label_store_root"],
            generation_id=kwargs["label_pack_generation_id"],
            pack_sha256=kwargs["label_pack_sha256"],
        )
        return clip_loader._build_clip_plan(evidence)

    def assert_clip_error(self, code: str, operation: object) -> ClipLoaderError:
        self.assertTrue(callable(operation))
        with self.assertRaises(ClipLoaderError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_exact_train_clip_load_rebinds_every_surface_and_command(self) -> None:
        fixture = self._fixture()
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
        with patch.object(
            protected_process,
            "run_protected_process",
            side_effect=self._execution_side_effect(calls=calls),
        ):
            loaded = clip_loader.load_causal_ball_clip_input_v1(**kwargs)

        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0][0][1:], ("-hide_banner", "-version"))
        self.assertEqual(Path(calls[0][0][0]).name, "ffprobe")
        self.assertEqual(calls[1][0][1:], ("-hide_banner", "-version"))
        self.assertEqual(Path(calls[1][0][0]).name, "ffmpeg")
        self._assert_exact_probe_call(*calls[2])
        self._assert_exact_decode_call(*calls[3])

        receipt = loaded.receipt
        self.assertEqual(receipt.frame_count, 2)
        self.assertEqual(receipt.output_width, 16)
        self.assertEqual(receipt.output_height, 16)
        self.assertEqual(
            tuple(row.source_pts for row in receipt.frame_bindings),
            self.pts,
        )
        self.assertEqual(
            tuple(row.timestamp_ns for row in receipt.frame_bindings),
            (101_000_000, 137_000_000),
        )
        self.assertEqual(tuple(loaded.model_input.frames.shape), (1, 2, 3, 16, 16))
        self.assertTrue(bool(loaded.model_input.valid_frame_mask.all()))
        loaded.validate_tensor_binding()
        for value in (receipt, loaded):
            self.assertFalse(value.admissible_for_training)
            self.assertFalse(value.admissible_for_evaluation)
            self.assertFalse(value.admissible_for_test)
            self.assertFalse(value.admissible_for_deployment)
            self.assertFalse(value.admissible_for_live_scoring)

    def _assert_exact_probe_call(
        self,
        argv: tuple[str, ...],
        process_kwargs: dict[str, object],
    ) -> None:
        input_fd = argv[6]
        expected = (
            argv[0],
            "-v",
            "error",
            "-protocol_whitelist",
            "fd",
            "-fd",
            input_fd,
            "-select_streams",
            "2",
            "-show_frames",
            "-show_entries",
            "stream=index,codec_type,time_base,width,height,pix_fmt,color_space,color_range,start_pts:stream_side_data=rotation:frame=stream_index,pts,width,height,pix_fmt,color_space,color_range",
            "-of",
            "json",
            "fd:",
        )
        self.assertEqual(argv, expected)
        self.assertEqual(process_kwargs["pass_fds"], (int(input_fd),))
        self.assertIs(type(process_kwargs["deadline"]), float)
        self.assertGreater(process_kwargs["deadline"], time.monotonic())
        self.assertEqual(
            process_kwargs["stdout_limit"],
            clip_loader.MAX_PROBE_STDOUT_BYTES,
        )
        self.assertEqual(
            process_kwargs["stderr_limit"],
            clip_loader.MAX_PROCESS_STDERR_BYTES,
        )
        self.assertEqual(process_kwargs["auxiliary_read_fd"], -1)
        self.assertEqual(process_kwargs["auxiliary_write_fd"], -1)
        self.assertEqual(process_kwargs["auxiliary_limit"], 0)

    def _assert_exact_decode_call(
        self,
        argv: tuple[str, ...],
        process_kwargs: dict[str, object],
    ) -> None:
        fd_positions = [index for index, value in enumerate(argv) if value == "-fd"]
        self.assertEqual(len(fd_positions), 2)
        input_fd = argv[fd_positions[0] + 1]
        hash_fd = argv[fd_positions[1] + 1]
        expected = (
            argv[0],
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-bitexact",
            "-filter_threads",
            "1",
            "-filter_complex_threads",
            "1",
            "-copyts",
            "-threads",
            "1",
            "-hwaccel",
            "none",
            "-noautorotate",
            "-protocol_whitelist",
            "fd",
            "-fd",
            input_fd,
            "-i",
            "fd:",
            "-filter_complex",
            "[0:2]scale=w=iw:h=ih:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bitexact:sws_dither=none,format=pix_fmts=rgb24,split=outputs=2[raw][hash]",
            "-map",
            "[raw]",
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "rawvideo",
            "-threads:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-fps_mode",
            "passthrough",
            "-enc_time_base",
            "-1",
            "-f",
            "rawvideo",
            "-protocol_whitelist",
            "pipe",
            "pipe:1",
            "-map",
            "[hash]",
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "rawvideo",
            "-threads:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-fps_mode",
            "passthrough",
            "-enc_time_base",
            "-1",
            "-f",
            "framehash",
            "-hash",
            "sha256",
            "-format_version",
            "2",
            "-protocol_whitelist",
            "fd",
            "-fd",
            hash_fd,
            "fd:",
        )
        self.assertEqual(argv, expected)
        self.assertEqual(
            process_kwargs["pass_fds"],
            (int(input_fd), int(hash_fd)),
        )
        self.assertIs(type(process_kwargs["deadline"]), float)
        self.assertGreater(process_kwargs["deadline"], time.monotonic())
        self.assertEqual(process_kwargs["stdout_limit"], len(b"".join(self.frames)))
        self.assertEqual(
            process_kwargs["stderr_limit"],
            clip_loader.MAX_PROCESS_STDERR_BYTES,
        )
        self.assertIs(type(process_kwargs["auxiliary_read_fd"]), int)
        self.assertEqual(process_kwargs["auxiliary_write_fd"], int(hash_fd))
        self.assertEqual(
            process_kwargs["auxiliary_limit"],
            clip_loader.MAX_FRAMEHASH_BYTES,
        )

    def test_dev_clip_loads_with_same_non_authorizing_contract(self) -> None:
        fixture = self._fixture(split=LabelBundleSplit.DEV)
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        with patch.object(
            protected_process,
            "run_protected_process",
            side_effect=self._execution_side_effect(),
        ):
            loaded = clip_loader.load_causal_ball_clip_input_v1(**kwargs)
        self.assertIs(loaded.receipt.split, LabelBundleSplit.DEV)
        self.assertFalse(loaded.admissible_for_evaluation)
        self.assertFalse(loaded.receipt.admissible_for_evaluation)

    def test_version_mismatch_fails_before_media_staging(self) -> None:
        fixture = self._fixture()
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        with (
            patch.object(
                protected_process,
                "run_protected_process",
                side_effect=self._execution_side_effect(
                    ffprobe_version=b"ffprobe wrong pinned version\n"
                ),
            ),
            patch.object(clip_loader, "stage_verified_artifact_media_v1") as media,
        ):
            self.assert_clip_error(
                "CLIP_LOAD_RUNTIME_BINDING",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
            )
        media.assert_not_called()

    def test_private_core_rejects_duck_capabilities(self) -> None:
        class Duck:
            admissible_for_training = False
            admissible_for_evaluation = False
            admissible_for_test = False
            admissible_for_deployment = False
            admissible_for_live_scoring = False

        self.assert_clip_error(
            "CLIP_LOAD_INPUT",
            lambda: clip_loader._load_private_core(
                evidence=Duck(),
                plan=Duck(),
                runtime=Duck(),
                runtime_manifest=Duck(),
                media=Duck(),
                source_byte_length=1,
            ),
        )

    def test_duplicate_and_source_runtime_alias_fail_before_execution(self) -> None:
        duplicate_fixture = self._fixture(duplicate_kind=True)
        duplicate_kwargs = duplicate_fixture["kwargs"]
        assert type(duplicate_kwargs) is dict
        with (
            patch.object(clip_loader, "load_verified_decoder_runtime") as runtime,
            patch.object(protected_process, "run_protected_process") as process,
        ):
            self.assert_clip_error(
                "CLIP_LOAD_PACK_BINDING",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**duplicate_kwargs),
            )
        runtime.assert_not_called()
        process.assert_not_called()

        generation_alias_fixture = self._fixture()
        generation_alias_kwargs = generation_alias_fixture["kwargs"]
        generation_alias_statement = generation_alias_fixture["statement"]
        assert type(generation_alias_kwargs) is dict
        with (
            patch.object(
                clip_loader._VerifiedDecoderRuntimeLease,
                "generation_id",
                new_callable=PropertyMock,
                return_value=generation_alias_statement.source_asset_sha256,
            ),
            patch.object(clip_loader, "_remeasure_runtime_versions") as version,
            patch.object(clip_loader, "stage_verified_artifact_media_v1") as media,
        ):
            self.assert_clip_error(
                "CLIP_LOAD_RUNTIME_BINDING",
                lambda: clip_loader.load_causal_ball_clip_input_v1(
                    **generation_alias_kwargs
                ),
            )
        version.assert_not_called()
        media.assert_not_called()

        self.source = self.ffmpeg
        alias_fixture = self._fixture()
        alias_kwargs = alias_fixture["kwargs"]
        assert type(alias_kwargs) is dict
        with (
            patch.object(clip_loader, "_remeasure_runtime_versions") as version,
            patch.object(clip_loader, "stage_verified_artifact_media_v1") as media,
            patch.object(protected_process, "run_protected_process") as process,
        ):
            self.assert_clip_error(
                "CLIP_LOAD_RUNTIME_BINDING",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**alias_kwargs),
            )
        version.assert_not_called()
        media.assert_not_called()
        process.assert_not_called()

    def test_decode_raw_exit_stderr_and_process_start_failures_are_typed(self) -> None:
        fixture = self._fixture()
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        raw = b"".join(self.frames)
        for mutated in (raw[:-1], raw + b"x"):
            with patch.object(
                protected_process,
                "run_protected_process",
                side_effect=self._execution_side_effect(decode_stdout=mutated),
            ):
                self.assert_clip_error(
                    "CLIP_LOAD_FRAME_COUNT",
                    lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
                )
        for returncode in (1, -signal.SIGKILL):
            with patch.object(
                protected_process,
                "run_protected_process",
                side_effect=self._execution_side_effect(decode_returncode=returncode),
            ):
                self.assert_clip_error(
                    "CLIP_LOAD_DECODE_FAILED",
                    lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
                )
        with patch.object(
            protected_process,
            "run_protected_process",
            side_effect=self._execution_side_effect(decode_stderr=b"unexpected\n"),
        ):
            self.assert_clip_error(
                "CLIP_LOAD_DECODE_PROTOCOL",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
            )

    def test_protected_process_errors_translate_to_clip_codes(self) -> None:
        cases = (
            (
                protected_process.PROTECTED_PROCESS_START,
                "DECODE_TIMEOUT",
                "CLIP_LOAD_PROCESS_START",
            ),
            (
                protected_process.PROTECTED_PROCESS_CLEANUP,
                "DECODE_TIMEOUT",
                "CLIP_LOAD_CLEANUP",
            ),
            (
                protected_process.PROTECTED_PROCESS_OUTPUT_LIMIT,
                "DECODE_TIMEOUT",
                "CLIP_LOAD_OUTPUT_LIMIT",
            ),
            (
                protected_process.PROTECTED_PROCESS_TIMEOUT,
                "PROBE_TIMEOUT",
                "CLIP_LOAD_PROBE_TIMEOUT",
            ),
            (
                protected_process.PROTECTED_PROCESS_TIMEOUT,
                "DECODE_TIMEOUT",
                "CLIP_LOAD_DECODE_TIMEOUT",
            ),
        )
        for source_code, timeout_code, expected_code in cases:
            with (
                self.subTest(source_code=source_code, timeout_code=timeout_code),
                patch.object(
                    protected_process,
                    "run_protected_process",
                    side_effect=protected_process.ProtectedProcessError(
                        source_code,
                        "synthetic protected process failure",
                    ),
                ),
            ):
                self.assert_clip_error(
                    expected_code,
                    lambda: clip_loader._run_pinned_process(
                        ("/absolute/fixture-tool",),
                        pass_fds=(),
                        timeout_seconds=1.0,
                        timeout_code=timeout_code,
                        stdout_limit=8,
                    ),
                )
        self.assertFalse(hasattr(clip_loader, "_execute_process"))
        self.assertFalse(hasattr(clip_loader, "_ProcessResult"))

    def test_pinned_process_timeout_validation_consumes_auxiliary_fds(self) -> None:
        malformed = (
            (1, "DECODE_TIMEOUT"),
            (0.0, "DECODE_TIMEOUT"),
            (float("inf"), "DECODE_TIMEOUT"),
            (1.0, ""),
        )
        for timeout_seconds, timeout_code in malformed:
            with self.subTest(
                timeout_seconds=timeout_seconds,
                timeout_code=timeout_code,
            ):
                read_fd, write_fd = os.pipe()
                try:
                    self.assert_clip_error(
                        "CLIP_LOAD_PROCESS_START",
                        lambda: clip_loader._run_pinned_process(
                            ("/absolute/fixture-tool",),
                            pass_fds=(write_fd,),
                            timeout_seconds=timeout_seconds,
                            timeout_code=timeout_code,
                            stdout_limit=8,
                            auxiliary_read_fd=read_fd,
                            auxiliary_write_fd=write_fd,
                            auxiliary_limit=8,
                        ),
                    )
                    for descriptor in (read_fd, write_fd):
                        with self.assertRaises(OSError):
                            os.fstat(descriptor)
                finally:
                    for descriptor in (read_fd, write_fd):
                        try:
                            os.close(descriptor)
                        except OSError:
                            pass

    def test_pinned_process_clock_fault_cleanup_precedes_base_exception(self) -> None:
        for clock_error, expected in (
            (RuntimeError("synthetic clock failure"), ClipLoaderError),
            (KeyboardInterrupt(), KeyboardInterrupt),
        ):
            with self.subTest(error=type(clock_error).__name__):
                read_fd, write_fd = os.pipe()
                try:
                    with (
                        patch.object(
                            clip_loader.time,
                            "monotonic",
                            side_effect=clock_error,
                        ),
                        self.assertRaises(expected) as caught,
                    ):
                        clip_loader._run_pinned_process(
                            ("/absolute/fixture-tool",),
                            pass_fds=(write_fd,),
                            timeout_seconds=1.0,
                            timeout_code="DECODE_TIMEOUT",
                            stdout_limit=8,
                            auxiliary_read_fd=read_fd,
                            auxiliary_write_fd=write_fd,
                            auxiliary_limit=8,
                        )
                    if isinstance(caught.exception, ClipLoaderError):
                        self.assertEqual(
                            caught.exception.code,
                            "CLIP_LOAD_CLEANUP",
                        )
                    for descriptor in (read_fd, write_fd):
                        with self.assertRaises(OSError):
                            os.fstat(descriptor)
                finally:
                    for descriptor in (read_fd, write_fd):
                        try:
                            os.close(descriptor)
                        except OSError:
                            pass

    def test_probe_timestamp_mutation_matrix_and_output_bound(self) -> None:
        fixture = self._fixture()
        plan = self._plan(fixture)
        base = json.loads(self._probe_bytes())

        missing = json.loads(self._probe_bytes())
        missing["frames"][0].pop("pts")
        missing_raw = json.dumps(missing, separators=(",", ":")).encode()
        self.assert_clip_error(
            "CLIP_LOAD_PROBE_PROTOCOL",
            lambda: clip_loader._parse_probe_output(missing_raw, plan=plan),
        )

        timestamp_cases = []
        for second_pts in (self.pts[0], self.pts[0] - 1, -1, MAX_SIGNED_64 + 1):
            payload = json.loads(self._probe_bytes())
            payload["frames"][1]["pts"] = second_pts
            timestamp_cases.append(json.dumps(payload, separators=(",", ":")).encode())
        unreduced = json.loads(self._probe_bytes())
        unreduced["streams"][0]["time_base"] = "2/2000"
        timestamp_cases.append(json.dumps(unreduced, separators=(",", ":")).encode())
        for raw in timestamp_cases:
            self.assert_clip_error(
                "CLIP_LOAD_TIMESTAMP_BINDING",
                lambda raw=raw: clip_loader._parse_probe_output(raw, plan=plan),
            )

        missing_frame = dict(base)
        missing_frame["frames"] = base["frames"][:-1]
        missing_frame_raw = json.dumps(
            missing_frame,
            separators=(",", ":"),
        ).encode()
        self.assert_clip_error(
            "CLIP_LOAD_FRAME_COUNT",
            lambda: clip_loader._parse_probe_output(missing_frame_raw, plan=plan),
        )
        self.assert_clip_error(
            "CLIP_LOAD_PROBE_PROTOCOL",
            lambda: clip_loader._parse_probe_output(
                b"{" + b" " * clip_loader.MAX_PROBE_STDOUT_BYTES + b"}",
                plan=plan,
            ),
        )

    def test_distinct_pts_may_bind_equal_floored_nanoseconds(self) -> None:
        self.pts = (1, 2)
        self.time_base = (1, 3_000_000_000)
        fixture = self._fixture()
        kwargs = fixture["kwargs"]
        assert type(kwargs) is dict
        with patch.object(
            protected_process,
            "run_protected_process",
            side_effect=self._execution_side_effect(),
        ):
            loaded = clip_loader.load_causal_ball_clip_input_v1(**kwargs)
        self.assertEqual(
            tuple(row.source_pts for row in loaded.receipt.frame_bindings),
            (1, 2),
        )
        self.assertEqual(
            tuple(row.timestamp_ns for row in loaded.receipt.frame_bindings),
            (0, 0),
        )

    def test_framehash_exact_rational_order_and_row_count(self) -> None:
        fixture = self._fixture()
        plan = self._plan(fixture)
        probe = clip_loader._parse_probe_output(self._probe_bytes(), plan=plan)
        hashes = tuple(_sha(frame) for frame in self.frames)
        for raw, expected_code in (
            (
                self._framehash_bytes(time_base="2/2000"),
                "CLIP_LOAD_TIMESTAMP_BINDING",
            ),
            (
                self._framehash_bytes(pts=tuple(reversed(self.pts))),
                "CLIP_LOAD_TIMESTAMP_BINDING",
            ),
            (
                self._framehash_bytes() + f"0, 200, 200, 1, 768, {'0' * 64}\n".encode(),
                "CLIP_LOAD_DECODE_PROTOCOL",
            ),
        ):
            self.assert_clip_error(
                expected_code,
                lambda raw=raw: clip_loader._parse_framehash_output(
                    raw,
                    probe=probe,
                    frame_sha256s=hashes,
                    frame_bytes=16 * 16 * 3,
                ),
            )

    def test_rebuilt_frame_hash_and_identity_mismatches_are_distinct(self) -> None:
        fixture = self._fixture()
        plan = self._plan(fixture)
        probe = clip_loader._parse_probe_output(self._probe_bytes(), plan=plan)
        hashes = tuple(_sha(frame) for frame in self.frames)
        self.assert_clip_error(
            "CLIP_LOAD_FRAME_HASH",
            lambda: clip_loader._rebuild_frame_bindings(
                plan=plan,
                probe=probe,
                frame_sha256s=("0" * 64, hashes[1]),
            ),
        )
        with patch.object(
            DecodedFrameIdentity,
            "fingerprint",
            return_value="f" * 64,
        ):
            self.assert_clip_error(
                "CLIP_LOAD_FRAME_IDENTITY",
                lambda: clip_loader._rebuild_frame_bindings(
                    plan=plan,
                    probe=probe,
                    frame_sha256s=hashes,
                ),
            )

    def test_media_size_mismatch_is_media_binding(self) -> None:
        fixture = self._fixture()
        kwargs = dict(fixture["kwargs"])
        kwargs["source_byte_length"] = len(self.source) + 1
        with patch.object(
            protected_process,
            "run_protected_process",
            side_effect=self._execution_side_effect(),
        ):
            self.assert_clip_error(
                "CLIP_LOAD_MEDIA_BINDING",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
            )

    def test_clip_plan_dimension_frame_and_aggregate_boundaries(self) -> None:
        maximum_dimensions = self._fixture(width=3840, height=2160)
        maximum_plan = self._plan(maximum_dimensions)
        self.assertEqual((maximum_plan.width, maximum_plan.height), (3840, 2160))

        for width, height in ((3844, 2160), (18, 16)):
            fixture = self._fixture(width=width, height=height)
            self.assert_clip_error(
                "CLIP_LOAD_BOUNDS",
                lambda fixture=fixture: self._plan(fixture),
            )

        self.pts = tuple(range(1, 33))
        self.frames = tuple(bytes([index]) * (64 * 64 * 3) for index in range(32))
        frame_boundary = self._fixture(width=64, height=64)
        self.assertEqual(self._plan(frame_boundary).frame_count, 32)

        self.pts = tuple(range(1, 34))
        self.frames = tuple(bytes([index]) * (64 * 64 * 3) for index in range(33))
        too_many = self._fixture(width=64, height=64)
        self.assert_clip_error(
            "CLIP_LOAD_BOUNDS",
            lambda: self._plan(too_many),
        )

        self.pts = (1, 2, 3)
        self.frames = (
            b"a" * 3,
            b"b" * 3,
            b"c" * 3,
        )
        too_many_pixels = self._fixture(width=3840, height=2160)
        self.assert_clip_error(
            "CLIP_LOAD_BOUNDS",
            lambda: self._plan(too_many_pixels),
        )

    def test_test_and_bounds_fail_before_runtime_media_or_process(self) -> None:
        for fixture, expected_code in (
            (self._fixture(split=LabelBundleSplit.TEST), "CLIP_LOAD_TEST_FORBIDDEN"),
            (self._fixture(width=12), "CLIP_LOAD_BOUNDS"),
        ):
            kwargs = fixture["kwargs"]
            assert type(kwargs) is dict
            with (
                patch.object(clip_loader, "load_verified_decoder_runtime") as runtime,
                patch.object(clip_loader, "stage_verified_artifact_media_v1") as media,
                patch.object(protected_process, "run_protected_process") as process,
            ):
                self.assert_clip_error(
                    expected_code,
                    lambda kwargs=kwargs: clip_loader.load_causal_ball_clip_input_v1(
                        **kwargs
                    ),
                )
            runtime.assert_not_called()
            media.assert_not_called()
            process.assert_not_called()

    def test_namespaces_fail_before_runtime_store_access(self) -> None:
        fixture = self._fixture()
        kwargs = dict(fixture["kwargs"])
        kwargs["runtime_store_root"] = kwargs["artifact_store_root"]
        with patch.object(clip_loader, "load_verified_decoder_runtime") as runtime:
            self.assert_clip_error(
                "CLIP_LOAD_INPUT",
                lambda: clip_loader.load_causal_ball_clip_input_v1(**kwargs),
            )
        runtime.assert_not_called()

    def test_linkage_preflight_rejects_dependency_and_system_allowlist(self) -> None:
        fixtures = (
            self._fixture(dependency=True),
            self._fixture(
                system_install_names=(
                    "/usr/lib/libSystem.B.dylib",
                    "/usr/lib/libz.1.dylib",
                )
            ),
        )
        for fixture in fixtures:
            kwargs = fixture["kwargs"]
            assert type(kwargs) is dict
            with (
                patch.object(clip_loader, "_remeasure_runtime_versions") as version,
                patch.object(clip_loader, "stage_verified_artifact_media_v1") as media,
                patch.object(protected_process, "run_protected_process") as process,
            ):
                self.assert_clip_error(
                    "CLIP_LOAD_RUNTIME_LINKAGE",
                    lambda kwargs=kwargs: clip_loader.load_causal_ball_clip_input_v1(
                        **kwargs
                    ),
                )
            version.assert_not_called()
            media.assert_not_called()
            process.assert_not_called()

    def test_probe_and_framehash_protocols_bind_exact_pts_and_hashes(self) -> None:
        fixture = self._fixture()
        plan = self._plan(fixture)
        probe = clip_loader._parse_probe_output(self._probe_bytes(), plan=plan)
        self.assertEqual(probe.source_pts, self.pts)

        clip_loader._parse_framehash_output(
            self._framehash_bytes(durations=(-1, 0)),
            probe=probe,
            frame_sha256s=tuple(_sha(frame) for frame in self.frames),
            frame_bytes=16 * 16 * 3,
        )
        self.assert_clip_error(
            "CLIP_LOAD_TIMESTAMP_BINDING",
            lambda: clip_loader._parse_probe_output(
                self._probe_bytes(time_base="2/2000"),
                plan=plan,
            ),
        )
        duplicate_key = self._probe_bytes().replace(
            b'"programs":[]',
            b'"programs":[],"programs":[]',
        )
        self.assert_clip_error(
            "CLIP_LOAD_PROBE_PROTOCOL",
            lambda: clip_loader._parse_probe_output(duplicate_key, plan=plan),
        )
        self.assert_clip_error(
            "CLIP_LOAD_TIMESTAMP_BINDING",
            lambda: clip_loader._parse_framehash_output(
                self._framehash_bytes(time_base="1/90000"),
                probe=probe,
                frame_sha256s=tuple(_sha(frame) for frame in self.frames),
                frame_bytes=16 * 16 * 3,
            ),
        )
        bad_hashes = ("0" * 64, _sha(self.frames[1]))
        self.assert_clip_error(
            "CLIP_LOAD_FRAME_HASH",
            lambda: clip_loader._parse_framehash_output(
                self._framehash_bytes(hashes=bad_hashes),
                probe=probe,
                frame_sha256s=tuple(_sha(frame) for frame in self.frames),
                frame_bytes=16 * 16 * 3,
            ),
        )

        stream_one_fixture = self._fixture(selected_video_stream_index=1)
        stream_one_plan = self._plan(stream_one_fixture)
        boolean_stream_index = json.loads(
            self._probe_bytes(selected_video_stream_index=1)
        )
        boolean_stream_index["frames"][0]["stream_index"] = True
        self.assert_clip_error(
            "CLIP_LOAD_PROBE_PROTOCOL",
            lambda: clip_loader._parse_probe_output(
                json.dumps(boolean_stream_index, separators=(",", ":")).encode(),
                plan=stream_one_plan,
            ),
        )

    def test_decode_transfers_pipe_ownership_before_runner_failure(self) -> None:
        fixture = self._fixture()
        plan = self._plan(fixture)
        probe = clip_loader._parse_probe_output(self._probe_bytes(), plan=plan)
        media_path = self.root / "reader-source.bin"
        media_path.write_bytes(self.source)
        foreign_path = self.root / "foreign-after-runner.bin"
        foreign_path.write_bytes(b"foreign descriptors must survive caller cleanup")
        foreign_fds: list[int] = []

        class Runtime:
            @staticmethod
            def _executable_path(tool: str) -> Path:
                return Path("/nonexistent") / tool

        class Media:
            @contextmanager
            def _open_immediate_child_reader(self):
                descriptor = os.open(media_path, os.O_RDONLY)
                try:
                    yield descriptor
                finally:
                    os.close(descriptor)

        def consume_then_fail(
            argv: tuple[str, ...],
            **process_kwargs: object,
        ) -> object:
            del argv
            read_fd = process_kwargs["auxiliary_read_fd"]
            write_fd = process_kwargs["auxiliary_write_fd"]
            self.assertIs(type(read_fd), int)
            self.assertIs(type(write_fd), int)
            assert type(read_fd) is int and type(write_fd) is int
            os.close(read_fd)
            os.close(write_fd)
            first = os.open(foreign_path, os.O_RDONLY)
            second = os.open(foreign_path, os.O_RDONLY)
            self.assertEqual({first, second}, {read_fd, write_fd})
            foreign_fds.extend((first, second))
            raise ClipLoaderError("DECODE_FAILED", "synthetic runner failure")

        try:
            with patch.object(
                protected_process,
                "run_protected_process",
                side_effect=consume_then_fail,
            ):
                self.assert_clip_error(
                    "CLIP_LOAD_DECODE_FAILED",
                    lambda: clip_loader._decode_clip(
                        Runtime(),
                        Media(),
                        plan,
                        probe,
                    ),
                )
            self.assertEqual(len(foreign_fds), 2)
            for descriptor in foreign_fds:
                os.fstat(descriptor)
        finally:
            for descriptor in foreign_fds:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
