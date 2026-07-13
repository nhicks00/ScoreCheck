#!/usr/bin/env python3
"""Run the exact development-only decoder loader against the HEVC10 golden.

This harness converts the checked development build receipt and cache-only
FFmpeg executables into a real, private immutable runtime generation.  It also
constructs exact artifact and DEV label-pack generations for the repository's
synthetic HEVC10 decoder golden, invokes the public protected clip loader, and
requires the checked non-authorizing clip receipt byte-for-byte.

The complete three-store enclave exists only in a private temporary cache
directory and is removed after the loader returns.  Nothing in this module
grants training, evaluation, deployment, live-scoring, production, legal,
patent, security, support, or general runtime-execution authority.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from typing import Any, Mapping

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.annotation_trust import (
    AnnotationAttestation,
    AnnotationAttestationRole,
    annotation_attestation_signing_message,
)
from vision_scoring.annotations import (
    AnnotationType,
    AutorotationPolicy,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    DecodedColorRange,
    DecodedColorSpace,
    DecodedFrameHashBasis,
    DecodedFrameIdentity,
    DecodedPixelFormat,
    FrameDecodeContract,
    FrameDuplicateKind,
    FrameReference,
    PixelCoordinateSpace,
    PixelRegion,
    ReviewState,
    SearchRegionObservabilityAttestation,
    SearchRegionScope,
    SearchRegionVisibility,
    TimestampBasis,
)
from vision_scoring.ball_label_pack import BallLabelPackRootV1
from vision_scoring.contract_wire import canonical_json_bytes
from vision_scoring.decoder_runtime import (
    DecoderRuntimeManifestV1,
    PinnedSystemRuntimeMeasurementV1,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
    generation_write_lock,
)
from vision_scoring.label_bundle import (
    CausalBallLabelBundleAttestationV1,
    CausalBallLabelBundleTrustSnapshotV1,
    CurrentCausalBallLabelBundleV1,
    LabelBundleCuratorKeyRole,
    LabelBundleSplit,
    TrustedLabelBundleCuratorKeyV1,
    build_causal_ball_label_bundle_v1,
    causal_ball_label_bundle_signing_message,
)


VISION_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = VISION_ROOT.parent
FIXTURE_ROOT = VISION_ROOT / "tests" / "fixtures"
BUILDER_PATH = VISION_ROOT / "scripts" / "build_decoder_runtime_v1.py"
DECODER_COMMAND_MODULE_PATH = (
    VISION_ROOT / "src" / "vision_scoring" / "decoder_commands.py"
)

DEVELOPMENT_BUILD_RECEIPT_PATH = (
    FIXTURE_ROOT / "decoder_runtime_v1.development-receipt.json"
)
DEVELOPMENT_RUNTIME_MANIFEST_PATH = (
    FIXTURE_ROOT / "decoder_runtime_v1.development-manifest.json"
)
DEVELOPMENT_DECLARATIONS_PATH = (
    FIXTURE_ROOT / "decoder_loader_hevc10_v1.development-declarations.json"
)
DEVELOPMENT_CLIP_RECEIPT_PATH = (
    FIXTURE_ROOT / "decoder_loader_hevc10_v1.development-clip-receipt.json"
)
HEVC10_EXPECTED_PATH = (
    FIXTURE_ROOT / "deterministic_decoder_hevc10_v1.expected.json"
)
HEVC10_MEDIA_PATH = FIXTURE_ROOT / "deterministic_decoder_hevc10_v1.mp4"

DEFAULT_BINARY_CACHE_ROOT = (
    Path.home() / ".cache" / "codex" / "scorecheck-ffmpeg-runtime-v1"
)
DEFAULT_HARNESS_CACHE_ROOT = (
    Path.home() / ".cache" / "codex" / "scorecheck-decoder-loader-development-v1"
)

DEVELOPMENT_BUILD_RECEIPT_SHA256 = (
    "5d30df230ba63141416d0cd867deaae19dd620f577709f3314effd189429db55"
)
BUILDER_SOURCE_SHA256 = (
    "16002a0bb56eb4d6987716330ce043638b2d179e391e22d808abe200b4b15c5d"
)
DECODER_COMMAND_MODULE_SHA256 = (
    "d5d9d7af27983f0d2e2ea3d49ab1dd798512762358038b4e7c578902206c22d1"
)
FFMPEG_OBJECT_SHA256 = (
    "780aa8f1fe15a86c97d16181fb8867f13424adc95106f2b5dbf8eee0cac54a1e"
)
FFPROBE_OBJECT_SHA256 = (
    "edbb6ea959a7df036e8d1d7122c21b172f439e63633c19b9908246b2e69d3013"
)
FFMPEG_VERSION_OUTPUT_SHA256 = (
    "22983830b6b7044ce877f0cb8a89fefcfde4c70165d619139b131db4913c066d"
)
FFPROBE_VERSION_OUTPUT_SHA256 = (
    "e3d1b6d8f5efd21ad70466b5cba7bbf4a95f9ac6e7d78e1adb4b9cafcb96f1e9"
)
DECODER_RECIPE_SHA256 = (
    "512307ed1855b9cac3366d921fef89aa4de966a4c4a22b06807e4d71613b2522"
)
SYSTEM_RUNTIME_MEASUREMENT_SHA256 = (
    "4b138abd8d80b3ef221e59ded8d0cdbc76a233a36ee833eda4f3d33ce41d65bf"
)
DEVELOPMENT_RUNTIME_ID = (
    "scorecheck-ffmpeg-8.1.2-macos-arm64-development-v1"
)
DEVELOPMENT_SYSTEM_RUNTIME_ID = (
    "macos-26.5.1-25F80-arm64-system-runtime-development-v1"
)
DEVELOPMENT_RUNTIME_MANIFEST_SHA256 = (
    "6552aae9c33537c574be4c350256722d30a7941ba1855fc6501e6e265b84382e"
)
DEVELOPMENT_RUNTIME_MANIFEST_FILE_SHA256 = (
    "887f3ba3d23124f80b20125a7ab76821c3fcd4eb998344ee54f386ccb1efe934"
)
DEVELOPMENT_RUNTIME_GENERATION_ID = (
    "8494f6ffa8cf7e6b0cc3f6395e1761cd6e8bb8dbd6feedbf29fcb41381806048"
)

HEVC10_MEDIA_SHA256 = (
    "380fc82506dc596f572e5535c99713ee676f7c37e5682506e994d93df1cd3aa0"
)
HEVC10_EXPECTED_SHA256 = (
    "d7faaa382018313c5c49f3e02d53915b389f53dc6a026fecdaef02929ea31fa7"
)
HEVC10_MEDIA_SIZE_BYTES = 2_218
HEVC10_ARTIFACT_GENERATION_ID = (
    "78cad5fd9208c4772a2d27451db3a6a76d654e6c9cd7f222c9abbfbf9d44339d"
)
HEVC10_INPUT_TENSOR_SHA256 = (
    "2f5bc141998f6f481b01bce98ed669c868270a9560663958e8eb40977dc4c5dd"
)
DEVELOPMENT_DECLARATIONS_SHA256 = (
    "e5481eec818bf6d7989e245b8e65b6eafd9ea28c44a6ffc634b5cde963ff2794"
)
DEVELOPMENT_LABEL_PACK_SHA256 = (
    "39e31b652d325a0c8d15549bb2f915414fcf02206201fee595816f527398ad55"
)
DEVELOPMENT_LABEL_PACK_GENERATION_ID = (
    "a442867746e17bad4e0da49095e7b164e20430c650f3167b9722883447dc2381"
)
DEVELOPMENT_CLIP_RECEIPT_SHA256 = (
    "e5cde1dfc7469ba1217372448319bc22803c55e72f9a9902965e17f2acadc151"
)
DEVELOPMENT_CLIP_RECEIPT_FILE_SHA256 = (
    "a00c7a5605649ca6b2527c850b47b224fdea90f0e7e944c755965a4e70c5f83d"
)

ANNOTATION_KEY_DERIVATION_LABEL = (
    "multicourt-vision-scoring:"
    "untrusted-development-fixture-annotation-review-key:v1"
)
CURATOR_KEY_DERIVATION_LABEL = (
    "multicourt-vision-scoring:"
    "untrusted-development-fixture-label-curator-key:v1"
)
ANNOTATION_PUBLIC_KEY_BASE64 = "JTo1uotdfMN5guofdyffrxLpE7Le8QuWRsXyh/8MRJA="
CURATOR_PUBLIC_KEY_BASE64 = "tjzj6TJ/Jyqnf20azsoOJd6LHbXZLKo5pDuOI+idL38="
ANNOTATION_PRINCIPAL_ID = "untrusted-development-fixture-reviewer-v1"
ANNOTATION_KEY_ID = "untrusted-development-fixture-review-key-v1"
ANNOTATION_TRUST_DOMAIN_ID = (
    "untrusted-development-fixture-annotation-domain-v1"
)
CURATOR_ID = "untrusted-development-fixture-curator-v1"
CURATOR_KEY_ID = "untrusted-development-fixture-curator-key-v1"
CURATOR_TRUST_DOMAIN_ID = "untrusted-development-fixture-label-domain-v1"
ANNOTATION_SIGNED_ON = "2026-07-12"
CURATOR_SIGNED_AT_NS = 1_783_814_400_000_000_000
CURATOR_VALID_FROM_NS = 1_767_225_600_000_000_000
CURATOR_VALID_UNTIL_NS = 1_798_761_600_000_000_000

MAX_CHECKED_FIXTURE_BYTES = 2 * 1024 * 1024
MAX_CHECKED_BINARY_BYTES = 64 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_DARWIN_SF_DATALESS = 0x40000000

_AUTHORITY_FIELDS = (
    "admission_approved",
    "deployment_approved",
    "evaluation_approved",
    "license_approved",
    "patent_approved",
    "production_approved",
    "runtime_execution_approved",
    "security_approved",
    "support_approved",
    "training_approved",
)
_ADMISSION_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class DevelopmentLoaderHarnessError(RuntimeError):
    """Fail-closed development harness error with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise DevelopmentLoaderHarnessError(code, message)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _pretty_json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    ).encode("ascii")


def _strict_json_object(raw: bytes, *, label: str) -> dict[str, Any]:
    # Every call site receives an exact SHA-pinned fixture before this parser;
    # the parser is not a general untrusted-JSON surface.
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{label} contains a duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"{label} contains non-finite JSON: {value}")

    try:
        value = json.loads(
            raw.decode("ascii", errors="strict"),
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_JSON",
            f"{label} is not strict ASCII JSON",
        ) from exc
    if type(value) is not dict:
        _fail("DEVELOPMENT_LOADER_JSON", f"{label} root must be an object")
    return value


def _snapshot(value: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _is_dataless(value: os.stat_result) -> bool:
    if sys.platform != "darwin":
        return False
    mask = (
        getattr(stat, "SF_DATALESS", 0)
        | getattr(stat, "UF_DATALESS", 0)
        | _DARWIN_SF_DATALESS
    )
    return bool(mask and getattr(value, "st_flags", 0) & mask)


def _read_safe_regular_bytes(
    path: Path,
    *,
    label: str,
    maximum_bytes: int,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
    require_executable: bool = False,
) -> bytes:
    """Read one exact non-aliased regular file while detecting replacement."""

    if not isinstance(path, Path):
        raise ValueError("path must be a pathlib.Path")
    try:
        before_path = path.lstat()
    except OSError as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_FILE", f"{label} is unavailable"
        ) from exc
    if (
        stat.S_ISLNK(before_path.st_mode)
        or not stat.S_ISREG(before_path.st_mode)
        or before_path.st_nlink != 1
        or before_path.st_size < 1
        or before_path.st_size > maximum_bytes
        or _is_dataless(before_path)
        or (require_executable and before_path.st_mode & 0o111 == 0)
    ):
        _fail("DEVELOPMENT_LOADER_FILE", f"{label} has an unsafe file shape")
    if expected_size is not None and before_path.st_size != expected_size:
        _fail("DEVELOPMENT_LOADER_FILE", f"{label} size differs from its pin")

    flags = os.O_RDONLY
    for name in ("O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"):
        selected = getattr(os, name, None)
        if type(selected) is not int or selected == 0:
            _fail("DEVELOPMENT_LOADER_PLATFORM", f"required {name} is unavailable")
        flags |= selected
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_FILE", f"{label} could not be opened safely"
        ) from exc
    try:
        before_fd = os.fstat(descriptor)
        if _snapshot(before_fd) != _snapshot(before_path):
            _fail("DEVELOPMENT_LOADER_FILE", f"{label} changed before binding")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, _READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                _fail("DEVELOPMENT_LOADER_FILE", f"{label} exceeds its byte bound")
            chunks.append(chunk)
        after_fd = os.fstat(descriptor)
        try:
            after_path = path.lstat()
        except OSError as exc:
            raise DevelopmentLoaderHarnessError(
                "DEVELOPMENT_LOADER_FILE", f"{label} changed while being read"
            ) from exc
        if (
            _snapshot(before_fd) != _snapshot(after_fd)
            or _snapshot(after_fd) != _snapshot(after_path)
            or total != before_fd.st_size
        ):
            _fail("DEVELOPMENT_LOADER_FILE", f"{label} changed while being read")
    finally:
        os.close(descriptor)
    raw = b"".join(chunks)
    if expected_sha256 is not None and _sha256(raw) != expected_sha256:
        _fail("DEVELOPMENT_LOADER_PIN", f"{label} differs from its SHA-256 pin")
    return raw


def _load_builder_module() -> Any:
    # Repository source is an explicit development trust boundary, not a
    # sandbox.  Hash both executable Python preimages before importing either.
    _read_safe_regular_bytes(
        BUILDER_PATH,
        label="development decoder builder source",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=BUILDER_SOURCE_SHA256,
    )
    _read_safe_regular_bytes(
        DECODER_COMMAND_MODULE_PATH,
        label="decoder command module source",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=DECODER_COMMAND_MODULE_SHA256,
    )
    spec = importlib.util.spec_from_file_location(
        "scorecheck_development_decoder_builder_v1", BUILDER_PATH
    )
    if spec is None or spec.loader is None:
        _fail("DEVELOPMENT_LOADER_BUILDER", "builder module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if getattr(module, "BUILDER_SOURCE_SHA256", None) != BUILDER_SOURCE_SHA256:
        _fail("DEVELOPMENT_LOADER_BUILDER", "builder source pin changed")
    return module


def decoder_runtime_manifest_from_development_receipt_v1(
    receipt_raw: bytes,
) -> DecoderRuntimeManifestV1:
    """Derive the sole checked development runtime manifest from exact bytes."""

    if type(receipt_raw) is not bytes:
        raise ValueError("receipt_raw must be exact bytes")
    if _sha256(receipt_raw) != DEVELOPMENT_BUILD_RECEIPT_SHA256:
        _fail("DEVELOPMENT_LOADER_PIN", "development build receipt pin changed")
    receipt = _strict_json_object(receipt_raw, label="development build receipt")
    builder = _load_builder_module()
    if receipt_raw != builder.canonical_json_bytes(receipt, pretty=True):
        _fail("DEVELOPMENT_LOADER_RECEIPT", "build receipt is not canonical")
    try:
        builder.validate_development_receipt(receipt)
    except (OSError, ValueError) as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_RECEIPT",
            "development build receipt failed complete validation",
        ) from exc

    audit = receipt["audit_implementation"]
    if (
        audit["builder_source_sha256"] != BUILDER_SOURCE_SHA256
        or audit["decoder_command_module_source_sha256"]
        != DECODER_COMMAND_MODULE_SHA256
        or audit["decoder_command_module_schema_version"] != "1.0"
    ):
        _fail("DEVELOPMENT_LOADER_RECEIPT", "audit implementation pin changed")
    authority = receipt["authority"]
    if set(authority) != set(_AUTHORITY_FIELDS) or any(
        authority[field] is not False for field in _AUTHORITY_FIELDS
    ):
        _fail("DEVELOPMENT_LOADER_AUTHORITY", "build authority must remain false")
    if receipt["license_boundary"] != {
        "configure_report": "LGPL version 2.1 or later",
        "external_libraries": [],
        "legal_review_complete": False,
        "patent_review_complete": False,
    }:
        _fail("DEVELOPMENT_LOADER_AUTHORITY", "license boundary changed")

    build = receipt["build"]
    if (
        build["ffmpeg"]["object_sha256"] != FFMPEG_OBJECT_SHA256
        or build["ffprobe"]["object_sha256"] != FFPROBE_OBJECT_SHA256
        or build["ffmpeg"]["version_output_sha256"]
        != FFMPEG_VERSION_OUTPUT_SHA256
        or build["ffprobe"]["version_output_sha256"]
        != FFPROBE_VERSION_OUTPUT_SHA256
        or build["recipe_sha256"] != DECODER_RECIPE_SHA256
        or build["recipe"]["build_command"] != ["make", "-j1", "V=1"]
    ):
        _fail("DEVELOPMENT_LOADER_RECEIPT", "runtime build pins changed")
    if receipt["system_runtime"]["measurement_sha256"] != (
        SYSTEM_RUNTIME_MEASUREMENT_SHA256
    ):
        _fail("DEVELOPMENT_LOADER_RECEIPT", "system-runtime pin changed")

    manifest = DecoderRuntimeManifestV1(
        runtime_id=DEVELOPMENT_RUNTIME_ID,
        platform="macos",
        architecture="arm64",
        abi="macos-26.0-arm64",
        ffmpeg_object_sha256=FFMPEG_OBJECT_SHA256,
        ffprobe_object_sha256=FFPROBE_OBJECT_SHA256,
        ffmpeg_version_output_sha256=FFMPEG_VERSION_OUTPUT_SHA256,
        ffprobe_version_output_sha256=FFPROBE_VERSION_OUTPUT_SHA256,
        configure_flags=tuple(build["recipe"]["configure_arguments"]),
        build_flags=tuple(build["recipe"]["build_command"][1:]),
        decoder_recipe_sha256=DECODER_RECIPE_SHA256,
        dependency_closure=(),
        system_runtime_measurement=PinnedSystemRuntimeMeasurementV1(
            runtime_id=DEVELOPMENT_SYSTEM_RUNTIME_ID,
            measurement_sha256=SYSTEM_RUNTIME_MEASUREMENT_SHA256,
            allowed_install_names=("/usr/lib/libSystem.B.dylib",),
        ),
        license_review_ref=f"sha256:{DEVELOPMENT_BUILD_RECEIPT_SHA256}",
    )
    if manifest.fingerprint() != DEVELOPMENT_RUNTIME_MANIFEST_SHA256:
        _fail("DEVELOPMENT_LOADER_MANIFEST", "derived runtime manifest pin changed")
    descriptor = GenerationDescriptor.build(
        tuple(sorted((manifest.fingerprint(), *manifest.object_sha256s())))
    )
    if descriptor.generation_id != DEVELOPMENT_RUNTIME_GENERATION_ID:
        _fail("DEVELOPMENT_LOADER_MANIFEST", "runtime generation pin changed")
    return manifest


def _load_checked_manifest() -> DecoderRuntimeManifestV1:
    receipt_raw = _read_safe_regular_bytes(
        DEVELOPMENT_BUILD_RECEIPT_PATH,
        label="development build receipt",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=DEVELOPMENT_BUILD_RECEIPT_SHA256,
    )
    manifest = decoder_runtime_manifest_from_development_receipt_v1(receipt_raw)
    checked = _read_safe_regular_bytes(
        DEVELOPMENT_RUNTIME_MANIFEST_PATH,
        label="development runtime manifest",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=DEVELOPMENT_RUNTIME_MANIFEST_FILE_SHA256,
    )
    manifest_raw = manifest.to_json_bytes()
    if checked != manifest_raw + b"\n":
        _fail("DEVELOPMENT_LOADER_MANIFEST", "checked runtime manifest drifted")
    if DecoderRuntimeManifestV1.from_json_bytes(manifest_raw) != manifest:
        _fail("DEVELOPMENT_LOADER_MANIFEST", "runtime manifest did not round trip")
    return manifest


def _development_private_key(label: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(hashlib.sha256(label.encode()).digest())


def _load_declarations() -> dict[str, Any]:
    raw = _read_safe_regular_bytes(
        DEVELOPMENT_DECLARATIONS_PATH,
        label="development label declarations",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=DEVELOPMENT_DECLARATIONS_SHA256,
    )
    value = _strict_json_object(raw, label="development label declarations")
    if raw != _pretty_json_bytes(value):
        _fail("DEVELOPMENT_LOADER_DECLARATION", "declarations are not canonical")
    required = {
        "annotation_trust_store",
        "annotation_verification_policy",
        "authority",
        "capture_policy",
        "curator_trust",
        "label_ontology",
        "negative_review_evidence",
        "purpose",
        "rights_boundary",
        "schema_version",
    }
    if set(value) != required:
        _fail("DEVELOPMENT_LOADER_DECLARATION", "declaration fields are not exact")
    if (
        value["schema_version"] != "1.0"
        or value["purpose"] != "DEVELOPMENT_FIXTURE_ONLY"
        or value["rights_boundary"]
        != {
            "external_media_present": False,
            "rights_admission": False,
            "scope": "REPOSITORY_GENERATED_SYNTHETIC_FIXTURE_ONLY",
        }
    ):
        _fail("DEVELOPMENT_LOADER_DECLARATION", "declaration boundary changed")
    authority = value["authority"]
    if type(authority) is not dict or set(authority) != set(_AUTHORITY_FIELDS):
        _fail("DEVELOPMENT_LOADER_AUTHORITY", "declaration authority is not exact")
    if any(authority[field] is not False for field in _AUTHORITY_FIELDS):
        _fail("DEVELOPMENT_LOADER_AUTHORITY", "declaration authority must be false")
    annotation_key = _development_private_key(ANNOTATION_KEY_DERIVATION_LABEL)
    curator_key = _development_private_key(CURATOR_KEY_DERIVATION_LABEL)
    if (
        base64.b64encode(annotation_key.public_key().public_bytes_raw()).decode()
        != ANNOTATION_PUBLIC_KEY_BASE64
        or base64.b64encode(curator_key.public_key().public_bytes_raw()).decode()
        != CURATOR_PUBLIC_KEY_BASE64
        or value["annotation_trust_store"]["public_key_base64"]
        != ANNOTATION_PUBLIC_KEY_BASE64
        or value["curator_trust"]["public_key_base64"]
        != CURATOR_PUBLIC_KEY_BASE64
    ):
        _fail("DEVELOPMENT_LOADER_DECLARATION", "development key pin changed")
    return value


def _declaration_sha256(value: object, *, label: str) -> str:
    if type(value) is not dict:
        _fail("DEVELOPMENT_LOADER_DECLARATION", f"{label} must be an object")
    return _sha256(canonical_json_bytes(value, label=label))


def _build_development_label_pack(
    *,
    manifest: DecoderRuntimeManifestV1,
    source_raw: bytes,
    expected_raw: bytes,
    declarations: dict[str, Any],
) -> dict[str, Any]:
    """Build deterministic, signed, non-authorizing DEV negative labels."""

    if _sha256(source_raw) != HEVC10_MEDIA_SHA256 or len(source_raw) != (
        HEVC10_MEDIA_SIZE_BYTES
    ):
        _fail("DEVELOPMENT_LOADER_GOLDEN", "HEVC10 source pin changed")
    if _sha256(expected_raw) != HEVC10_EXPECTED_SHA256:
        _fail("DEVELOPMENT_LOADER_GOLDEN", "HEVC10 expected pin changed")
    expected = _strict_json_object(expected_raw, label="HEVC10 expected contract")
    fixture = expected.get("fixture")
    selected = expected.get("selected_video")
    rows = expected.get("presentation_frames")
    if (
        fixture
        != {
            "filename": "deterministic_decoder_hevc10_v1.mp4",
            "sha256": HEVC10_MEDIA_SHA256,
            "size_bytes": HEVC10_MEDIA_SIZE_BYTES,
        }
        or type(selected) is not dict
        or type(rows) is not list
        or len(rows) != 5
        or selected.get("stream_index") != 0
        or selected.get("width") != 64
        or selected.get("height") != 64
        or selected.get("time_base_numerator") != 1
        or selected.get("time_base_denominator") != 1000
        or selected.get("color_space") != "bt709"
        or selected.get("color_range") != "tv"
    ):
        _fail("DEVELOPMENT_LOADER_GOLDEN", "HEVC10 contract shape changed")

    decode_contract = FrameDecodeContract(
        decoder_artifact_sha256=manifest.fingerprint(),
        decoder_build_id=manifest.runtime_id,
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=64,
        output_height=64,
    )
    ontology_sha256 = _declaration_sha256(
        declarations["label_ontology"], label="development label ontology"
    )
    review_sha256 = _declaration_sha256(
        declarations["negative_review_evidence"],
        label="development negative review evidence",
    )
    capture_policy_sha256 = _declaration_sha256(
        declarations["capture_policy"], label="development capture policy"
    )
    annotation_trust_sha256 = _declaration_sha256(
        declarations["annotation_trust_store"],
        label="development annotation trust store",
    )
    annotation_policy_sha256 = _declaration_sha256(
        declarations["annotation_verification_policy"],
        label="development annotation policy",
    )
    review_ref = f"sha256:{review_sha256}"
    capture_ref = f"sha256:{HEVC10_EXPECTED_SHA256}"

    annotations: list[BallFrameAnnotationV2] = []
    for expected_index, row in enumerate(rows):
        if type(row) is not dict or row.get("frame_index") != expected_index:
            _fail("DEVELOPMENT_LOADER_GOLDEN", "HEVC10 frame order changed")
        pts = row.get("pts")
        decoded_sha256 = row.get("rgb24_sha256")
        if type(pts) is not int or pts < 0 or type(decoded_sha256) is not str:
            _fail("DEVELOPMENT_LOADER_GOLDEN", "HEVC10 frame row is invalid")
        identity = DecodedFrameIdentity(
            source_sha256=HEVC10_MEDIA_SHA256,
            selected_video_stream_index=0,
            frame_index=expected_index,
            timestamp_ns=pts * 1_000_000,
            timestamp_basis=TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS,
            pixel_coordinate_space=(
                PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
            ),
            decode_contract=decode_contract,
            decoded_frame_sha256=decoded_sha256,
            decoded_frame_hash_basis=(
                DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            ),
        )
        frame = FrameReference(
            identity=identity,
            duplicate_kind=FrameDuplicateKind.NONE,
            duplicate_of_frame_index=None,
        )
        search = SearchRegionObservabilityAttestation(
            source_sha256=HEVC10_MEDIA_SHA256,
            selected_video_stream_index=0,
            frame_index=expected_index,
            decoded_frame_sha256=decoded_sha256,
            frame_identity_sha256=identity.fingerprint(),
            target_role=BallRole.MATCH_BALL,
            region_scope=SearchRegionScope.FULL_DECODED_FRAME,
            searched_region=PixelRegion(0, 0, 63, 63),
            region_visibility=SearchRegionVisibility.FULLY_OBSERVABLE,
            capture_integrity_attestation_refs=(capture_ref,),
            reviewer_ids=(ANNOTATION_PRINCIPAL_ID,),
            review_evidence_refs=(review_ref,),
        )
        annotations.append(
            BallFrameAnnotationV2(
                annotation_id=f"development-match-ball-absent-{expected_index}",
                ontology_sha256=ontology_sha256,
                ball_instance_id="development-match-ball",
                frame=frame,
                visibility=BallVisibility.NOT_PRESENT,
                appearance=BallAppearance.NOT_OBSERVABLE,
                role=BallRole.MATCH_BALL,
                play_state=BallPlayState.NOT_APPLICABLE,
                search_region_observability_attestation=search,
                review_state=ReviewState.REVIEWED,
                reviewer_ids=(ANNOTATION_PRINCIPAL_ID,),
                review_evidence_refs=(review_ref,),
            )
        )
    annotation_tuple = tuple(annotations)

    annotation_key = _development_private_key(ANNOTATION_KEY_DERIVATION_LABEL)
    annotation_attestations: list[AnnotationAttestation] = []
    for annotation in annotation_tuple:
        role = AnnotationAttestationRole.REVIEWER
        signature = annotation_key.sign(
            annotation_attestation_signing_message(
                annotation,
                role=role,
                principal_id=ANNOTATION_PRINCIPAL_ID,
                key_id=ANNOTATION_KEY_ID,
                trust_domain_id=ANNOTATION_TRUST_DOMAIN_ID,
                signed_on=ANNOTATION_SIGNED_ON,
            )
        )
        annotation_attestations.append(
            AnnotationAttestation(
                annotation_type=AnnotationType.BALL_FRAME_OBSERVATION,
                annotation_sha256=annotation.fingerprint(),
                role=role,
                principal_id=ANNOTATION_PRINCIPAL_ID,
                key_id=ANNOTATION_KEY_ID,
                trust_domain_id=ANNOTATION_TRUST_DOMAIN_ID,
                signed_on=ANNOTATION_SIGNED_ON,
                signature_base64=base64.b64encode(signature).decode("ascii"),
            )
        )
    annotation_attestation_tuple = tuple(annotation_attestations)

    statement = build_causal_ball_label_bundle_v1(
        bundle_id="development-hevc10-loader-negative-v1",
        source_asset_sha256=HEVC10_MEDIA_SHA256,
        finalized_trace_sha256=HEVC10_EXPECTED_SHA256,
        capture_policy_sha256=capture_policy_sha256,
        capture_policy_generation=1,
        split=LabelBundleSplit.DEV,
        ontology_sha256=ontology_sha256,
        ontology_version="development-synthetic-no-match-ball-v1",
        match_ball_instance_id="development-match-ball",
        annotations=annotation_tuple,
        attestations=annotation_attestation_tuple,
        annotation_trust_store_sha256=annotation_trust_sha256,
        annotation_verification_policy_sha256=annotation_policy_sha256,
    )

    curator_key = _development_private_key(CURATOR_KEY_DERIVATION_LABEL)
    curator_role = LabelBundleCuratorKeyRole.COMPLETE_BALL_ENUMERATION_CURATOR
    curator_signature = curator_key.sign(
        causal_ball_label_bundle_signing_message(
            statement,
            key_id=CURATOR_KEY_ID,
            key_role=curator_role,
            curator_id=CURATOR_ID,
            trust_domain_id=CURATOR_TRUST_DOMAIN_ID,
            signed_at_ns=CURATOR_SIGNED_AT_NS,
        )
    )
    curator_attestation = CausalBallLabelBundleAttestationV1(
        statement_sha256=statement.fingerprint(),
        key_id=CURATOR_KEY_ID,
        key_role=curator_role,
        curator_id=CURATOR_ID,
        trust_domain_id=CURATOR_TRUST_DOMAIN_ID,
        signed_at_ns=CURATOR_SIGNED_AT_NS,
        signature_base64=base64.b64encode(curator_signature).decode("ascii"),
    )
    curator_snapshot = CausalBallLabelBundleTrustSnapshotV1(
        snapshot_generation=1,
        trust_domain_id=CURATOR_TRUST_DOMAIN_ID,
        curator_id=CURATOR_ID,
        keys=(
            TrustedLabelBundleCuratorKeyV1(
                key_id=CURATOR_KEY_ID,
                key_role=curator_role,
                curator_id=CURATOR_ID,
                public_key_base64=CURATOR_PUBLIC_KEY_BASE64,
                valid_from_ns=CURATOR_VALID_FROM_NS,
                valid_until_ns=CURATOR_VALID_UNTIL_NS,
                revoked_at_ns=None,
            ),
        ),
        current_key_id=CURATOR_KEY_ID,
        current_bundle=CurrentCausalBallLabelBundleV1(
            bundle_id=statement.bundle_id,
            statement_sha256=statement.fingerprint(),
            attestation_sha256=curator_attestation.fingerprint(),
        ),
        revoked_statement_sha256s=(),
    )

    statement_raw = statement.to_json_bytes()
    curator_raw = curator_attestation.to_json_bytes()
    snapshot_raw = curator_snapshot.to_json_bytes()
    root = BallLabelPackRootV1(
        label_bundle_statement_ref=f"sha256:{_sha256(statement_raw)}",
        curator_attestation_ref=f"sha256:{_sha256(curator_raw)}",
        curator_trust_snapshot_ref=f"sha256:{_sha256(snapshot_raw)}",
    )
    payloads = {
        _sha256(statement_raw): statement_raw,
        _sha256(curator_raw): curator_raw,
        _sha256(snapshot_raw): snapshot_raw,
    }
    for annotation in annotation_tuple:
        raw = annotation.to_json_bytes()
        payloads[_sha256(raw)] = raw
    for attestation in annotation_attestation_tuple:
        raw = attestation.to_json_bytes()
        payloads[_sha256(raw)] = raw
    root_raw = root.to_json_bytes()
    payloads[_sha256(root_raw)] = root_raw
    if len(payloads) != 14 or root.fingerprint() not in payloads:
        _fail("DEVELOPMENT_LOADER_LABEL", "label-pack closure is not exact")
    descriptor = GenerationDescriptor.build(tuple(sorted(payloads)))
    if (
        root.fingerprint() != DEVELOPMENT_LABEL_PACK_SHA256
        or descriptor.generation_id != DEVELOPMENT_LABEL_PACK_GENERATION_ID
    ):
        _fail("DEVELOPMENT_LOADER_LABEL", "label-pack pin changed")
    return {
        "annotation_attestations": annotation_attestation_tuple,
        "annotations": annotation_tuple,
        "curator_attestation": curator_attestation,
        "curator_snapshot": curator_snapshot,
        "payloads": payloads,
        "root": root,
        "statement": statement,
    }


def _require_owned_directory(path: Path, *, label: str) -> None:
    try:
        link_value = path.lstat()
        value = path.stat()
    except OSError as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_DIRECTORY", f"{label} is unavailable"
        ) from exc
    if (
        stat.S_ISLNK(link_value.st_mode)
        or not stat.S_ISDIR(link_value.st_mode)
        or not stat.S_ISDIR(value.st_mode)
        or value.st_uid != os.getuid()
        or _is_dataless(value)
    ):
        _fail("DEVELOPMENT_LOADER_DIRECTORY", f"{label} is unsafe")


def _canonical_path(path: Path) -> Path:
    return Path(os.path.realpath(os.path.abspath(os.fspath(path.expanduser()))))


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_cache_boundaries(
    *,
    binary_cache_root: Path,
    harness_cache_root: Path,
) -> None:
    """Keep every cache-only byte outside the repository/worktree."""

    if not isinstance(binary_cache_root, Path) or not isinstance(
        harness_cache_root, Path
    ):
        raise ValueError("cache roots must be pathlib.Path values")
    repository = _canonical_path(REPOSITORY_ROOT)
    binary = _canonical_path(binary_cache_root)
    harness = _canonical_path(harness_cache_root)
    if _is_within(binary, repository) or _is_within(harness, repository):
        _fail(
            "DEVELOPMENT_LOADER_CACHE_BOUNDARY",
            "cache-only bytes must remain outside the repository/worktree",
        )
    if (
        binary == harness
        or _is_within(binary, harness)
        or _is_within(harness, binary)
    ):
        _fail(
            "DEVELOPMENT_LOADER_CACHE_BOUNDARY",
            "binary and harness caches must be separate namespaces",
        )


def _new_store(root: Path) -> None:
    root.mkdir(mode=0o700)
    (root / "locks").mkdir(mode=0o700)
    (root / "generations").mkdir(mode=0o700)
    _require_owned_directory(root, label="private development store")


def _write_new_file(path: Path, raw: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    for name in ("O_NOFOLLOW", "O_CLOEXEC"):
        selected = getattr(os, name, None)
        if type(selected) is not int or selected == 0:
            _fail("DEVELOPMENT_LOADER_PLATFORM", f"required {name} is unavailable")
        flags |= selected
    descriptor = os.open(path, flags, 0o600)
    try:
        view = memoryview(raw)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                _fail("DEVELOPMENT_LOADER_PUBLISH", "object write was incomplete")
            view = view[written:]
        os.fsync(descriptor)
        value = os.fstat(descriptor)
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or value.st_size != len(raw)
        ):
            _fail("DEVELOPMENT_LOADER_PUBLISH", "published object shape is unsafe")
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"):
        selected = getattr(os, name, None)
        if type(selected) is not int or selected == 0:
            _fail("DEVELOPMENT_LOADER_PLATFORM", f"required {name} is unavailable")
        flags |= selected
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _materialize_private_generation(
    store_root: Path,
    payloads: dict[str, bytes],
) -> GenerationDescriptor:
    """Materialize one generation before the private enclave is consumed."""

    if not payloads or any(type(raw) is not bytes for raw in payloads.values()):
        raise ValueError("payloads must be a non-empty exact byte mapping")
    for digest, raw in payloads.items():
        if _sha256(raw) != digest:
            _fail("DEVELOPMENT_LOADER_PUBLISH", "payload digest is inconsistent")
    descriptor = GenerationDescriptor.build(tuple(sorted(payloads)))
    bootstrap_generation_lock(store_root, descriptor.generation_id)
    with generation_write_lock(store_root, descriptor.generation_id):
        generation = store_root / "generations" / descriptor.generation_id
        objects = generation / "objects"
        generation.mkdir(mode=0o700)
        objects.mkdir(mode=0o700)
        for digest in descriptor.object_sha256s:
            _write_new_file(objects / digest, payloads[digest])
        _fsync_directory(objects)
        _write_new_file(generation / "descriptor.json", descriptor.canonical_bytes())
        _fsync_directory(generation)
        _fsync_directory(store_root / "generations")
    return descriptor


def _load_cache_binaries(receipt: dict[str, Any]) -> dict[str, bytes]:
    _require_owned_directory(DEFAULT_BINARY_CACHE_ROOT, label="decoder build cache")
    output: dict[str, bytes] = {}
    for build_label in ("a", "b"):
        build_root = DEFAULT_BINARY_CACHE_ROOT / f"build-{build_label}"
        _require_owned_directory(build_root, label=f"decoder build {build_label}")
        for name, expected_sha in (
            ("ffmpeg", FFMPEG_OBJECT_SHA256),
            ("ffprobe", FFPROBE_OBJECT_SHA256),
        ):
            entry = receipt["build"][name]
            if (
                receipt["build"]["clean_build_object_sha256s"][build_label][name]
                != expected_sha
                or entry["object_sha256"] != expected_sha
            ):
                _fail("DEVELOPMENT_LOADER_BINARY", "receipt binary pin changed")
            raw = _read_safe_regular_bytes(
                build_root / name,
                label=f"development {build_label} {name}",
                maximum_bytes=MAX_CHECKED_BINARY_BYTES,
                expected_sha256=expected_sha,
                expected_size=entry["size_bytes"],
                require_executable=True,
            )
            if build_label == "a":
                output[name] = raw
            elif raw != output[name]:
                _fail("DEVELOPMENT_LOADER_BINARY", "clean builds differ bytewise")
    return output


def _remeasure_live_system_runtime(receipt: dict[str, Any]) -> None:
    builder = _load_builder_module()
    try:
        host = builder._host_environment()
        observed = builder._system_runtime_measurement(host)
    except (OSError, RuntimeError, ValueError) as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_SYSTEM_RUNTIME",
            "current system runtime could not be remeasured",
        ) from exc
    if host != receipt["host_generation"] or observed != receipt["system_runtime"]:
        _fail(
            "DEVELOPMENT_LOADER_SYSTEM_RUNTIME",
            "current host/system runtime differs from the checked build receipt",
        )


def _ensure_harness_cache_root(path: Path) -> None:
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise DevelopmentLoaderHarnessError(
            "DEVELOPMENT_LOADER_DIRECTORY", "harness cache could not be created"
        ) from exc
    _require_owned_directory(path, label="development harness cache")
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        _fail("DEVELOPMENT_LOADER_DIRECTORY", "harness cache must have mode 0700")


def _require_false_admissions(value: object, *, label: str) -> None:
    if any(getattr(value, field, None) is not False for field in _ADMISSION_FIELDS):
        _fail("DEVELOPMENT_LOADER_AUTHORITY", f"{label} admission changed")


def _run_development_loader_v1(
    *,
    verify_checked_receipt: bool,
    harness_cache_root: Path | None = None,
) -> Any:
    """Private implementation; returned model input remains non-authorizing."""

    selected_harness_cache_root = (
        DEFAULT_HARNESS_CACHE_ROOT
        if harness_cache_root is None
        else harness_cache_root
    )
    _validate_cache_boundaries(
        binary_cache_root=DEFAULT_BINARY_CACHE_ROOT,
        harness_cache_root=selected_harness_cache_root,
    )
    manifest = _load_checked_manifest()
    declarations = _load_declarations()
    expected_raw = _read_safe_regular_bytes(
        HEVC10_EXPECTED_PATH,
        label="HEVC10 expected contract",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=HEVC10_EXPECTED_SHA256,
    )
    source_raw = _read_safe_regular_bytes(
        HEVC10_MEDIA_PATH,
        label="HEVC10 source media",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=HEVC10_MEDIA_SHA256,
        expected_size=HEVC10_MEDIA_SIZE_BYTES,
    )
    label_pack = _build_development_label_pack(
        manifest=manifest,
        source_raw=source_raw,
        expected_raw=expected_raw,
        declarations=declarations,
    )
    build_receipt_raw = _read_safe_regular_bytes(
        DEVELOPMENT_BUILD_RECEIPT_PATH,
        label="development build receipt",
        maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
        expected_sha256=DEVELOPMENT_BUILD_RECEIPT_SHA256,
    )
    build_receipt = _strict_json_object(
        build_receipt_raw, label="development build receipt"
    )
    binaries = _load_cache_binaries(build_receipt)
    _remeasure_live_system_runtime(build_receipt)

    # Clip-loader imports are intentionally lazy so pure manifest/label tests
    # run in the base environment without the optional PyTorch dependency.
    from vision_scoring.clip_input_contract import (  # noqa: PLC0415
        CausalBallClipInputReceiptV1,
    )
    from vision_scoring.clip_loader import (  # noqa: PLC0415
        load_causal_ball_clip_input_v1,
    )

    _ensure_harness_cache_root(selected_harness_cache_root)
    loaded: Any = None
    with tempfile.TemporaryDirectory(
        prefix="private-run-", dir=selected_harness_cache_root
    ) as temporary:
        enclave = Path(temporary)
        if stat.S_IMODE(enclave.stat().st_mode) != 0o700:
            _fail("DEVELOPMENT_LOADER_DIRECTORY", "private enclave mode changed")
        label_store = enclave / "label-store"
        artifact_store = enclave / "artifact-store"
        runtime_store = enclave / "runtime-store"
        for store_root in (label_store, artifact_store, runtime_store):
            _new_store(store_root)

        manifest_raw = manifest.to_json_bytes()
        runtime_descriptor = _materialize_private_generation(
            runtime_store,
            {
                manifest.fingerprint(): manifest_raw,
                FFMPEG_OBJECT_SHA256: binaries["ffmpeg"],
                FFPROBE_OBJECT_SHA256: binaries["ffprobe"],
            },
        )
        if runtime_descriptor.generation_id != DEVELOPMENT_RUNTIME_GENERATION_ID:
            _fail("DEVELOPMENT_LOADER_MANIFEST", "runtime generation changed")
        artifact_descriptor = _materialize_private_generation(
            artifact_store,
            {HEVC10_MEDIA_SHA256: source_raw},
        )
        if artifact_descriptor.generation_id != HEVC10_ARTIFACT_GENERATION_ID:
            _fail("DEVELOPMENT_LOADER_GOLDEN", "artifact generation changed")
        label_descriptor = _materialize_private_generation(
            label_store,
            label_pack["payloads"],
        )

        loaded = load_causal_ball_clip_input_v1(
            label_store_root=label_store,
            label_pack_generation_id=label_descriptor.generation_id,
            label_pack_sha256=label_pack["root"].fingerprint(),
            artifact_store_root=artifact_store,
            artifact_generation_id=artifact_descriptor.generation_id,
            artifact_sha256s=artifact_descriptor.object_sha256s,
            source_byte_length=HEVC10_MEDIA_SIZE_BYTES,
            runtime_store_root=runtime_store,
            runtime_generation_id=runtime_descriptor.generation_id,
            runtime_manifest_sha256=manifest.fingerprint(),
            expected_runtime_manifest_sha256=manifest.fingerprint(),
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
        _require_false_admissions(loaded, label="loaded clip")
        _require_false_admissions(loaded.receipt, label="clip receipt")
        loaded.validate_tensor_binding()
        if (
            tuple(loaded.model_input.frames.shape) != (1, 5, 3, 64, 64)
            or loaded.receipt.input_tensor_sha256 != HEVC10_INPUT_TENSOR_SHA256
        ):
            _fail("DEVELOPMENT_LOADER_TENSOR", "loaded tensor pin changed")

        if verify_checked_receipt:
            checked_receipt_raw = _read_safe_regular_bytes(
                DEVELOPMENT_CLIP_RECEIPT_PATH,
                label="development clip receipt",
                maximum_bytes=MAX_CHECKED_FIXTURE_BYTES,
                expected_sha256=DEVELOPMENT_CLIP_RECEIPT_FILE_SHA256,
            )
            checked_receipt = CausalBallClipInputReceiptV1.from_json_bytes(
                checked_receipt_raw.removesuffix(b"\n")
            )
            if (
                checked_receipt_raw != loaded.receipt.to_json_bytes() + b"\n"
                or checked_receipt != loaded.receipt
            ):
                _fail("DEVELOPMENT_LOADER_CLIP_RECEIPT", "clip receipt drifted")
            if checked_receipt.fingerprint() != DEVELOPMENT_CLIP_RECEIPT_SHA256:
                _fail("DEVELOPMENT_LOADER_CLIP_RECEIPT", "receipt pin changed")
    if loaded is None:
        _fail("DEVELOPMENT_LOADER_CLEANUP", "loader returned no result")
    return loaded


def run_development_loader_v1() -> Any:
    """Run and verify the sole checked development loader integration."""

    return _run_development_loader_v1(verify_checked_receipt=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        loaded = run_development_loader_v1()
    except Exception as exc:  # Fail closed with a useful development diagnostic.
        print(f"decoder-loader development harness failed closed: {exc}", file=sys.stderr)
        return 1
    summary = {
        "admissible_for_deployment": False,
        "admissible_for_evaluation": False,
        "admissible_for_live_scoring": False,
        "admissible_for_test": False,
        "admissible_for_training": False,
        "clip_receipt_sha256": loaded.receipt.fingerprint(),
        "development_build_receipt_sha256": DEVELOPMENT_BUILD_RECEIPT_SHA256,
        "input_tensor_sha256": loaded.receipt.input_tensor_sha256,
        "runtime_generation_id": loaded.receipt.decoder_runtime_generation_id,
        "runtime_manifest_sha256": loaded.receipt.decoder_runtime_manifest_sha256,
        "shape": list(loaded.model_input.frames.shape),
    }
    print(json.dumps(summary, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
