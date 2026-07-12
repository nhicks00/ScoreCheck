from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


VISION_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = VISION_ROOT / "scripts" / "build_decoder_runtime_v1.py"
RECEIPT_PATH = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "decoder_runtime_v1.development-receipt.json"
)

SPEC = importlib.util.spec_from_file_location("build_decoder_runtime_v1", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError("could not load decoder runtime builder")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class DecoderRuntimeBuildLogicTests(unittest.TestCase):
    """Exercise only pure pins/parsers/receipt logic; never discover tools."""

    def test_source_and_host_generation_pins_are_exact(self) -> None:
        self.assertEqual(builder.SOURCE_VERSION, "8.1.2")
        self.assertEqual(
            builder.SOURCE_SHA256,
            "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
        )
        self.assertEqual(
            builder.SIGNING_KEY_FINGERPRINT,
            "FCF986EA15E6E293A5644F10B4322F04D67658D8",
        )
        self.assertEqual(builder.DEPLOYMENT_TARGET, "26.0")
        self.assertEqual(builder.SDK_VERSION, "26.5")
        self.assertEqual(builder.EXPECTED_HOST["architecture"], "arm64")

    def test_configure_policy_is_narrow_and_redacts_ambient_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            sdk = root / "sdk"
            toolchain = root / "toolchain"
            arguments = builder.configure_arguments(source, sdk, toolchain)
            redacted = builder.redact_configure_arguments(
                arguments,
                source_root=source,
                sdk_root=sdk,
                toolchain_root=toolchain,
            )

        self.assertEqual(len(arguments), len(redacted))
        self.assertIn("--objcc=/usr/bin/false", redacted)
        self.assertIn("--pkg-config=/usr/bin/false", redacted)
        self.assertIn("--disable-network", redacted)
        self.assertIn("--disable-autodetect", redacted)
        self.assertIn("--disable-everything", redacted)
        self.assertIn("--disable-error-resilience", redacted)
        self.assertIn("--disable-runtime-cpudetect", redacted)
        self.assertIn("--disable-videotoolbox", redacted)
        self.assertIn("--enable-decoder=h264,hevc", redacted)
        self.assertIn("--enable-encoder=rawvideo", redacted)
        self.assertIn("--enable-demuxer=mov", redacted)
        self.assertIn("--enable-muxer=rawvideo,framehash", redacted)
        self.assertIn("--enable-protocol=fd,pipe", redacted)
        self.assertFalse(any(temporary in argument for argument in redacted))
        self.assertTrue(any("$SOURCE" in argument for argument in redacted))
        self.assertTrue(any("$SDKROOT" in argument for argument in redacted))
        self.assertTrue(any("$TOOLCHAIN" in argument for argument in redacted))

    def test_runtime_table_parsers_ignore_legends_and_expand_aliases(self) -> None:
        decoders = """Decoders:
 V..... = Video
 .F.... = Frame-level multithreading
 ------
 VFS..D h264                 H.264
 VFS..D hevc                 HEVC
"""
        formats = """Formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ---
 D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
"""
        filters = """Filters:
  T.. = Timeline support
  .S. = Slice threading
  ------
 .. format            V->V       Convert formats.
 TS hflip             V->V       Flip.
"""
        self.assertEqual(
            builder.parse_runtime_table("decoders", decoders),
            ["h264", "hevc"],
        )
        self.assertEqual(
            builder.parse_runtime_table("demuxers", formats),
            ["3g2", "3gp", "m4a", "mj2", "mov", "mp4"],
        )
        self.assertEqual(
            builder.parse_runtime_table("filters", filters),
            ["format", "hflip"],
        )
        self.assertEqual(
            builder.parse_protocols(
                "Supported file protocols:\nInput:\n  pipe\n  fd\nOutput:\n  fd\n  pipe\n"
            ),
            {"input": ["fd", "pipe"], "output": ["fd", "pipe"]},
        )

        with self.assertRaisesRegex(builder.BuildFailure, "unparsed row"):
            builder.parse_runtime_table(
                "decoders", decoders + " X..... hidden               unparsed\n"
            )
        with self.assertRaisesRegex(builder.BuildFailure, "unparsed row"):
            builder.parse_protocols(
                "Supported file protocols:\nInput:\n  fd\n  hidden-name\n"
                "Output:\n  fd\n"
            )

    def test_loader_probe_argv_and_candidate_environment_are_exact(self) -> None:
        argv = builder.decoder_probe_argv_v1(
            Path("/candidate/ffprobe"),
            input_fd=17,
            selected_video_stream_index=2,
        )
        self.assertEqual(
            argv,
            (
                "/candidate/ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "fd",
                "-fd",
                "17",
                "-select_streams",
                "2",
                "-show_frames",
                "-show_entries",
                "stream=index,codec_type,time_base,width,height,pix_fmt,color_space,color_range,start_pts:stream_side_data=rotation:frame=stream_index,pts,width,height,pix_fmt,color_space,color_range",
                "-of",
                "json",
                "fd:",
            ),
        )
        self.assertEqual(
            builder.FIXED_CANDIDATE_ENV,
            {
                "AV_LOG_FORCE_NOCOLOR": "1",
                "HOME": "/nonexistent",
                "LANG": "C",
                "LC_ALL": "C",
                "NO_COLOR": "1",
                "PATH": "/nonexistent",
                "TMPDIR": "/nonexistent",
                "TZ": "UTC",
            },
        )
        self.assertFalse(
            any(key.startswith("DYLD_") for key in builder.FIXED_CANDIDATE_ENV)
        )
        self.assertNotIn("FFREPORT", builder.FIXED_CANDIDATE_ENV)
        self.assertEqual(builder.DECODER_COMMAND_SCHEMA_VERSION, "1.0")
        self.assertEqual(
            builder.DECODER_COMMAND_MODULE_REPOSITORY_PATH,
            "src/vision_scoring/decoder_commands.py",
        )
        self.assertEqual(
            builder.DECODER_COMMAND_MODULE_SOURCE_SHA256,
            builder.sha256_path(builder.DECODER_COMMAND_MODULE_PATH),
        )

    def test_external_audit_tools_receive_only_the_fixed_environment(self) -> None:
        self.assertEqual(
            builder.FIXED_AUDIT_ENV,
            {
                "HOME": "/nonexistent",
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": "/nonexistent",
                "TZ": "UTC",
            },
        )
        self.assertFalse(
            any(
                key.startswith(("DYLD_", "HTTP_", "HTTPS_", "ALL_PROXY"))
                for key in builder.FIXED_AUDIT_ENV
            )
        )
        process = mock.Mock()
        process.pid = 2_147_483_647
        process.returncode = 0
        process.communicate.return_value = (b"", b"")
        with mock.patch.object(
            builder.subprocess, "Popen", return_value=process
        ) as popen, mock.patch.object(
            builder, "_process_group_exists", return_value=False
        ):
            completed = builder._run_capture(["/absolute/audit-tool"])
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(popen.call_args.kwargs["env"], builder.FIXED_AUDIT_ENV)
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_external_tool_timeout_triggers_bounded_group_cleanup(self) -> None:
        process = mock.Mock()
        process.pid = 2_147_483_647
        process.communicate.side_effect = subprocess.TimeoutExpired(
            ["/absolute/audit-tool"], 1
        )
        with mock.patch.object(
            builder.subprocess, "Popen", return_value=process
        ), mock.patch.object(
            builder, "_terminate_process_group", return_value=True
        ) as cleanup:
            with self.assertRaises(subprocess.TimeoutExpired):
                builder._run_capture(["/absolute/audit-tool"], timeout=1)
        cleanup.assert_called_once_with(process)

    def test_framehash_parser_rejects_every_extra_line_or_row(self) -> None:
        digest = "1" * 64
        payload = (
            "#format: frame checksums\n"
            "#version: 2\n"
            "#hash: SHA256\n"
            "#software: Lavf62.12.102\n"
            "#tb 0: 1/1000\n"
            "#media_type 0: video\n"
            "#codec_id 0: rawvideo\n"
            "#dimensions 0: 16x12\n"
            "#sar 0: 1/1\n"
            "#stream#, dts,        pts, duration,     size, hash\n"
            f"0, 101, 101, 36, 576, {digest}\n"
        ).encode("ascii")
        time_base, dimensions, rows = builder._parse_framehash(
            payload, expected_row_count=1
        )
        self.assertEqual(time_base, (1, 1000))
        self.assertEqual(dimensions, (16, 12))
        self.assertEqual(len(rows), 1)

        with self.assertRaisesRegex(builder.BuildFailure, "line count"):
            builder._parse_framehash(
                payload + f"0, 102, 102, 1, 576, {digest}\n".encode("ascii"),
                expected_row_count=1,
            )
        with self.assertRaisesRegex(builder.BuildFailure, "line count"):
            builder._parse_framehash(
                payload.replace(b"0, 101", b"unexpected\n0, 101"),
                expected_row_count=1,
            )

    def test_configure_summary_parser_requires_the_exact_closure(self) -> None:
        lines: list[str] = []
        for label, values in builder.EXPECTED_CONFIGURE_COMPONENTS.items():
            lines.append(f"{label}:")
            if values:
                lines.append(" ".join(reversed(values)))
            lines.append("")
        parsed = builder.parse_configure_components("\n".join(lines))
        self.assertEqual(parsed, builder.EXPECTED_CONFIGURE_COMPONENTS)

    def test_canonical_json_and_version_normalization_are_stable(self) -> None:
        self.assertEqual(
            builder.canonical_json_bytes({"b": 1, "a": False}),
            b'{"a":false,"b":1}\n',
        )
        left = builder.normalized_version_output_sha256(b"\nversion 1  \r\nline\t\r\n")
        right = builder.normalized_version_output_sha256(b"version 1\nline\n")
        self.assertEqual(left, right)

    def test_receipt_validator_rejects_authority_and_local_path_leaks(self) -> None:
        base = json.loads(RECEIPT_PATH.read_bytes())
        self.assertIs(builder.validate_development_receipt(base), base)

        approved = copy.deepcopy(base)
        approved["authority"]["production_approved"] = True
        with self.assertRaisesRegex(ValueError, "production_approved must be false"):
            builder.validate_development_receipt(approved)

        leaked = copy.deepcopy(base)
        leaked["evidence"] = "/Users/example/.cache/codex/build-a"
        with self.assertRaisesRegex(ValueError, "fields are not exact"):
            builder.validate_development_receipt(leaked)

    def test_receipt_validator_requires_the_complete_exact_schema(self) -> None:
        base = json.loads(RECEIPT_PATH.read_bytes())

        missing = copy.deepcopy(base)
        del missing["checks"]
        with self.assertRaisesRegex(ValueError, "fields are not exact"):
            builder.validate_development_receipt(missing)

        extra = copy.deepcopy(base)
        extra["checks"]["new_check"] = True
        with self.assertRaisesRegex(ValueError, "fields are not exact"):
            builder.validate_development_receipt(extra)

        wrong_builder = copy.deepcopy(base)
        wrong_builder["audit_implementation"]["builder_source_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "not bound"):
            builder.validate_development_receipt(wrong_builder)

        wrong_commands = copy.deepcopy(base)
        wrong_commands["audit_implementation"][
            "decoder_command_module_source_sha256"
        ] = "4" * 64
        with self.assertRaisesRegex(ValueError, "not bound"):
            builder.validate_development_receipt(wrong_commands)

        mismatched_builds = copy.deepcopy(base)
        mismatched_builds["build"]["clean_build_object_sha256s"]["b"][
            "ffmpeg"
        ] = "1" * 64
        with self.assertRaisesRegex(ValueError, "digests differ"):
            builder.validate_development_receipt(mismatched_builds)

        bad_recipe_digest = copy.deepcopy(base)
        bad_recipe_digest["build"]["recipe_sha256"] = "2" * 64
        with self.assertRaisesRegex(ValueError, "digest is inconsistent"):
            builder.validate_development_receipt(bad_recipe_digest)

        bad_system_digest = copy.deepcopy(base)
        bad_system_digest["system_runtime"]["measurement_sha256"] = "3" * 64
        with self.assertRaisesRegex(ValueError, "digest is inconsistent"):
            builder.validate_development_receipt(bad_system_digest)

    def test_checked_development_receipt_is_canonical_and_non_authorizing(self) -> None:
        raw = RECEIPT_PATH.read_bytes()
        receipt = json.loads(raw)
        builder.validate_development_receipt(receipt)
        self.assertEqual(raw, builder.canonical_json_bytes(receipt, pretty=True))
        self.assertNotIn(b"/Users/", raw)
        self.assertNotIn(b".cache/codex", raw)
        self.assertEqual(
            receipt["source"]["archive_sha256"],
            builder.SOURCE_SHA256,
        )
        self.assertEqual(
            receipt["source"]["signature"]["fingerprint"],
            builder.SIGNING_KEY_FINGERPRINT,
        )
        self.assertEqual(
            receipt["capabilities"],
            builder.EXPECTED_RUNTIME_CAPABILITIES,
        )
        self.assertEqual(
            receipt["audit_implementation"]["builder_source_sha256"],
            builder.BUILDER_SOURCE_SHA256,
        )
        self.assertEqual(
            receipt["audit_implementation"]["external_tool_environment"],
            builder.FIXED_AUDIT_ENV,
        )
        self.assertEqual(
            receipt["audit_implementation"][
                "decoder_command_module_source_sha256"
            ],
            builder.DECODER_COMMAND_MODULE_SOURCE_SHA256,
        )
        self.assertEqual(
            receipt["build"]["clean_build_object_sha256s"]["a"],
            receipt["build"]["clean_build_object_sha256s"]["b"],
        )
        self.assertEqual(
            receipt["build"]["recipe_sha256"],
            builder.sha256_bytes(
                builder.canonical_json_bytes(receipt["build"]["recipe"])
            ),
        )
        self.assertTrue(receipt["build"]["byte_identical_across_two_clean_builds"])
        self.assertEqual(
            receipt["build"]["ffmpeg"]["macho"]["direct_dylibs"],
            ["/usr/lib/libSystem.B.dylib"],
        )
        self.assertEqual(
            receipt["build"]["ffprobe"]["macho"]["direct_dylibs"],
            ["/usr/lib/libSystem.B.dylib"],
        )
        self.assertTrue(receipt["goldens"]["h264"]["passed"])
        self.assertTrue(receipt["goldens"]["hevc10"]["passed"])
        self.assertEqual(
            receipt["goldens"]["h264"]["expected_contract_sha256"],
            builder.H264_GOLDEN_CONTRACT_SHA256,
        )
        self.assertEqual(
            receipt["goldens"]["hevc10"]["expected_contract_sha256"],
            builder.HEVC10_GOLDEN_CONTRACT_SHA256,
        )
        self.assertTrue(receipt["checks"]["two_goldens_present"])
        self.assertTrue(all(value is False for value in receipt["authority"].values()))


if __name__ == "__main__":
    unittest.main()
