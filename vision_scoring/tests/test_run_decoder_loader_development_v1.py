from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import unittest
from unittest.mock import patch

from vision_scoring.annotation_trust import (
    AnnotationAttestationRole,
    annotation_attestation_signing_message,
)
from vision_scoring.annotations import BallVisibility, FrameDuplicateKind
from vision_scoring.ball_label_pack import load_ball_label_pack
from vision_scoring.decoder_runtime import DecoderRuntimeManifestV1
from vision_scoring.immutable_store import generation_read_lease
from vision_scoring.label_bundle import (
    LabelBundleSplit,
    causal_ball_label_bundle_signing_message,
)


VISION_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = VISION_ROOT / "scripts" / "run_decoder_loader_development_v1.py"
SPEC = importlib.util.spec_from_file_location(
    "run_decoder_loader_development_v1", SCRIPT_PATH
)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError("could not load decoder-loader development harness")
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


class DecoderLoaderDevelopmentHarnessTests(unittest.TestCase):
    def _fixture_inputs(self) -> tuple[object, bytes, bytes, dict[str, object]]:
        manifest = harness._load_checked_manifest()
        source = harness._read_safe_regular_bytes(
            harness.HEVC10_MEDIA_PATH,
            label="test HEVC10 source",
            maximum_bytes=harness.MAX_CHECKED_FIXTURE_BYTES,
            expected_sha256=harness.HEVC10_MEDIA_SHA256,
        )
        expected = harness._read_safe_regular_bytes(
            harness.HEVC10_EXPECTED_PATH,
            label="test HEVC10 expected",
            maximum_bytes=harness.MAX_CHECKED_FIXTURE_BYTES,
            expected_sha256=harness.HEVC10_EXPECTED_SHA256,
        )
        declarations = harness._load_declarations()
        return manifest, source, expected, declarations

    def test_final_receipt_derives_the_exact_non_authorizing_runtime(self) -> None:
        raw = harness.DEVELOPMENT_BUILD_RECEIPT_PATH.read_bytes()
        manifest = harness.decoder_runtime_manifest_from_development_receipt_v1(raw)

        self.assertIs(type(manifest), DecoderRuntimeManifestV1)
        self.assertEqual(
            manifest.fingerprint(), harness.DEVELOPMENT_RUNTIME_MANIFEST_SHA256
        )
        self.assertEqual(manifest.runtime_id, harness.DEVELOPMENT_RUNTIME_ID)
        self.assertEqual(manifest.platform, "macos")
        self.assertEqual(manifest.architecture, "arm64")
        self.assertEqual(manifest.abi, "macos-26.0-arm64")
        self.assertEqual(manifest.build_flags, ("-j1", "V=1"))
        self.assertEqual(manifest.dependency_closure, ())
        self.assertEqual(
            manifest.system_runtime_measurement.allowed_install_names,
            ("/usr/lib/libSystem.B.dylib",),
        )
        self.assertEqual(
            manifest.license_review_ref,
            f"sha256:{harness.DEVELOPMENT_BUILD_RECEIPT_SHA256}",
        )
        checked = harness.DEVELOPMENT_RUNTIME_MANIFEST_PATH.read_bytes()
        self.assertEqual(checked, manifest.to_json_bytes() + b"\n")

    def test_receipt_mutation_cannot_be_reframed_as_development_evidence(self) -> None:
        receipt = json.loads(harness.DEVELOPMENT_BUILD_RECEIPT_PATH.read_bytes())
        receipt["authority"]["training_approved"] = True
        raw = harness._pretty_json_bytes(receipt)
        with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
            harness.decoder_runtime_manifest_from_development_receipt_v1(raw)
        self.assertEqual(caught.exception.code, "DEVELOPMENT_LOADER_PIN")

        with patch.object(
            harness,
            "DEVELOPMENT_BUILD_RECEIPT_SHA256",
            hashlib.sha256(raw).hexdigest(),
        ):
            with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
                harness.decoder_runtime_manifest_from_development_receipt_v1(raw)
        self.assertEqual(caught.exception.code, "DEVELOPMENT_LOADER_RECEIPT")

    def test_unpinned_receipt_is_rejected_before_json_parsing(self) -> None:
        with patch.object(harness.json, "loads") as loads:
            with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
                harness.decoder_runtime_manifest_from_development_receipt_v1(b"{}")
        self.assertEqual(caught.exception.code, "DEVELOPMENT_LOADER_PIN")
        loads.assert_not_called()

    def test_builder_source_is_safe_hashed_before_import_execution(self) -> None:
        with (
            patch.object(harness, "BUILDER_SOURCE_SHA256", "0" * 64),
            patch.object(harness.importlib.util, "spec_from_file_location") as spec,
        ):
            with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
                harness._load_builder_module()
        self.assertEqual(caught.exception.code, "DEVELOPMENT_LOADER_PIN")
        spec.assert_not_called()

    def test_declarations_are_canonical_public_fixture_keys_without_authority(self) -> None:
        declarations = harness._load_declarations()
        self.assertEqual(
            declarations["purpose"], "DEVELOPMENT_FIXTURE_ONLY"
        )
        self.assertFalse(any(declarations["authority"].values()))
        self.assertFalse(
            declarations["annotation_trust_store"]["admission_authority"]
        )
        self.assertFalse(declarations["curator_trust"]["admission_authority"])
        self.assertEqual(
            declarations["annotation_trust_store"]["key_derivation_label"],
            harness.ANNOTATION_KEY_DERIVATION_LABEL,
        )
        self.assertEqual(
            declarations["curator_trust"]["key_derivation_label"],
            harness.CURATOR_KEY_DERIVATION_LABEL,
        )

    def test_deterministic_dev_negative_pack_has_real_fixture_signatures(self) -> None:
        manifest, source, expected, declarations = self._fixture_inputs()
        pack = harness._build_development_label_pack(
            manifest=manifest,
            source_raw=source,
            expected_raw=expected,
            declarations=declarations,
        )
        self.assertEqual(
            pack["root"].fingerprint(), harness.DEVELOPMENT_LABEL_PACK_SHA256
        )
        self.assertEqual(pack["statement"].split, LabelBundleSplit.DEV)
        self.assertEqual(pack["statement"].frame_count, 5)
        self.assertEqual(len(pack["payloads"]), 14)
        self.assertTrue(
            all(
                item.visibility is BallVisibility.NOT_PRESENT
                and item.frame.duplicate_kind is FrameDuplicateKind.NONE
                for item in pack["annotations"]
            )
        )

        review_public_key = harness._development_private_key(
            harness.ANNOTATION_KEY_DERIVATION_LABEL
        ).public_key()
        for annotation, attestation in zip(
            pack["annotations"], pack["annotation_attestations"], strict=True
        ):
            review_public_key.verify(
                attestation.signature,
                annotation_attestation_signing_message(
                    annotation,
                    role=AnnotationAttestationRole.REVIEWER,
                    principal_id=harness.ANNOTATION_PRINCIPAL_ID,
                    key_id=harness.ANNOTATION_KEY_ID,
                    trust_domain_id=harness.ANNOTATION_TRUST_DOMAIN_ID,
                    signed_on=harness.ANNOTATION_SIGNED_ON,
                ),
            )

        curator_public_key = harness._development_private_key(
            harness.CURATOR_KEY_DERIVATION_LABEL
        ).public_key()
        curator_public_key.verify(
            pack["curator_attestation"].signature,
            causal_ball_label_bundle_signing_message(
                pack["statement"],
                key_id=harness.CURATOR_KEY_ID,
                key_role=pack["curator_attestation"].key_role,
                curator_id=harness.CURATOR_ID,
                trust_domain_id=harness.CURATOR_TRUST_DOMAIN_ID,
                signed_at_ns=harness.CURATOR_SIGNED_AT_NS,
            ),
        )

    def test_private_generation_round_trips_through_real_lease(self) -> None:
        payload = b"private development generation payload\n"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / "store"
            harness._new_store(store)
            descriptor = harness._materialize_private_generation(
                store, {digest: payload}
            )
            with generation_read_lease(store, descriptor.generation_id) as lease:
                self.assertEqual(lease.descriptor, descriptor)
                with lease.open_verified_object(digest) as source:
                    self.assertEqual(source.read(), payload)

    def test_private_label_generation_loads_with_every_admission_false(self) -> None:
        manifest, source, expected, declarations = self._fixture_inputs()
        pack = harness._build_development_label_pack(
            manifest=manifest,
            source_raw=source,
            expected_raw=expected,
            declarations=declarations,
        )
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / "label-store"
            harness._new_store(store)
            descriptor = harness._materialize_private_generation(
                store, pack["payloads"]
            )
            self.assertEqual(
                descriptor.generation_id,
                harness.DEVELOPMENT_LABEL_PACK_GENERATION_ID,
            )
            evidence = load_ball_label_pack(
                label_store_root=store,
                generation_id=descriptor.generation_id,
                pack_sha256=pack["root"].fingerprint(),
            )
        self.assertIs(evidence.split, LabelBundleSplit.DEV)
        for field in harness._ADMISSION_FIELDS:
            self.assertIs(getattr(evidence, field), False)

    def test_safe_reader_rejects_symlink_and_hard_link_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "original"
            original.write_bytes(b"checked bytes")
            symlink = root / "symlink"
            symlink.symlink_to(original)
            with self.assertRaises(harness.DevelopmentLoaderHarnessError):
                harness._read_safe_regular_bytes(
                    symlink,
                    label="symlink fixture",
                    maximum_bytes=1024,
                )

            hard_link = root / "hard-link"
            os.link(original, hard_link)
            with self.assertRaises(harness.DevelopmentLoaderHarnessError):
                harness._read_safe_regular_bytes(
                    original,
                    label="hard-link fixture",
                    maximum_bytes=1024,
                )

    def test_cache_roots_cannot_resolve_inside_or_alias_the_worktree(self) -> None:
        inside_binary = harness.REPOSITORY_ROOT / ".cache" / "binary"
        inside_harness = harness.REPOSITORY_ROOT / ".cache" / "harness"
        with (
            patch.object(harness, "DEFAULT_BINARY_CACHE_ROOT", inside_binary),
            patch.object(harness, "DEFAULT_HARNESS_CACHE_ROOT", inside_harness),
        ):
            with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
                harness._run_development_loader_v1(
                    verify_checked_receipt=False
                )
        self.assertEqual(
            caught.exception.code, "DEVELOPMENT_LOADER_CACHE_BOUNDARY"
        )
        self.assertFalse(inside_binary.exists())
        self.assertFalse(inside_harness.exists())

        outside = Path(tempfile.gettempdir()) / "scorecheck-cache-boundary"
        with self.assertRaises(harness.DevelopmentLoaderHarnessError) as caught:
            harness._validate_cache_boundaries(
                binary_cache_root=outside,
                harness_cache_root=outside / "nested",
            )
        self.assertEqual(
            caught.exception.code, "DEVELOPMENT_LOADER_CACHE_BOUNDARY"
        )

    def test_checked_clip_receipt_is_canonical_and_false(self) -> None:
        try:
            from vision_scoring.clip_input_contract import (
                CausalBallClipInputReceiptV1,
            )
        except ModuleNotFoundError:
            self.skipTest("checked clip receipt requires the training dependency")
        raw = harness.DEVELOPMENT_CLIP_RECEIPT_PATH.read_bytes()
        self.assertEqual(
            hashlib.sha256(raw).hexdigest(),
            harness.DEVELOPMENT_CLIP_RECEIPT_FILE_SHA256,
        )
        receipt = CausalBallClipInputReceiptV1.from_json_bytes(
            raw.removesuffix(b"\n")
        )
        self.assertEqual(
            receipt.fingerprint(), harness.DEVELOPMENT_CLIP_RECEIPT_SHA256
        )
        self.assertEqual(receipt.split, LabelBundleSplit.DEV)
        self.assertEqual(receipt.input_tensor_sha256, harness.HEVC10_INPUT_TENSOR_SHA256)
        for field in harness._ADMISSION_FIELDS:
            self.assertIs(getattr(receipt, field), False)

    def test_real_cache_backed_loader_matches_checked_receipt(self) -> None:
        try:
            import torch  # noqa: F401
        except ModuleNotFoundError:
            self.skipTest("real loader requires the training dependency")
        required = tuple(
            harness.DEFAULT_BINARY_CACHE_ROOT / f"build-{build}" / tool
            for build in ("a", "b")
            for tool in ("ffmpeg", "ffprobe")
        )
        if not any(path.exists() for path in required):
            self.skipTest("exact development decoder cache is absent")
        self.assertTrue(all(path.is_file() for path in required))
        if (
            sys.platform != "darwin"
            or platform.machine() != "arm64"
            or platform.mac_ver()[0] != "26.5.1"
        ):
            self.skipTest("host is not the checked development generation")

        loaded = harness.run_development_loader_v1()
        self.assertEqual(tuple(loaded.model_input.frames.shape), (1, 5, 3, 64, 64))
        self.assertEqual(
            loaded.receipt.fingerprint(), harness.DEVELOPMENT_CLIP_RECEIPT_SHA256
        )
        self.assertEqual(
            loaded.receipt.input_tensor_sha256,
            harness.HEVC10_INPUT_TENSOR_SHA256,
        )
        loaded.validate_tensor_binding()
        for field in harness._ADMISSION_FIELDS:
            self.assertIs(getattr(loaded, field), False)
            self.assertIs(getattr(loaded.receipt, field), False)
        self.assertEqual(
            list(harness.DEFAULT_HARNESS_CACHE_ROOT.glob("private-run-*")), []
        )


if __name__ == "__main__":
    unittest.main()
