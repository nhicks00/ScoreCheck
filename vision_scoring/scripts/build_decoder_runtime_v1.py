#!/usr/bin/env python3
"""Build and audit the development-only ScoreCheck decoder candidate.

This command deliberately does not publish a runtime generation.  It builds
the same signed FFmpeg source twice in clean cache directories, compares the
bytes, audits the narrow Mach-O/runtime surface, and runs checked-in decoder
goldens.  Its only repository output is a canonical development receipt whose
authority fields are all false.

The host-generation assumption is intentionally narrow: arm64 macOS, a 26.0
deployment target, and the exact Xcode 26.6 / macOS 26.5 SDK measured below.
That is development evidence, not production, support, security, patent, or
license approval.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Mapping, Sequence
import urllib.request

import vision_scoring.decoder_commands as decoder_commands_module
from vision_scoring.decoder_commands import (
    DECODER_COMMAND_SCHEMA_VERSION,
    decoder_decode_argv_v1,
    decoder_probe_argv_v1,
)


BUILDER_PATH = Path(__file__).resolve()
BUILDER_SOURCE_SHA256 = hashlib.sha256(BUILDER_PATH.read_bytes()).hexdigest()
VISION_ROOT = BUILDER_PATH.parents[1]
REPOSITORY_ROOT = VISION_ROOT.parent
FIXTURE_ROOT = VISION_ROOT / "tests" / "fixtures"
DECODER_COMMAND_MODULE_PATH = (
    VISION_ROOT / "src" / "vision_scoring" / "decoder_commands.py"
)
DECODER_COMMAND_MODULE_REPOSITORY_PATH = (
    "src/vision_scoring/decoder_commands.py"
)
if (
    not DECODER_COMMAND_MODULE_PATH.is_file()
    or DECODER_COMMAND_MODULE_PATH.is_symlink()
):
    raise RuntimeError("decoder command module is absent, non-regular, or a symlink")
DECODER_COMMAND_MODULE_SOURCE_SHA256 = hashlib.sha256(
    DECODER_COMMAND_MODULE_PATH.read_bytes()
).hexdigest()
if (
    decoder_commands_module.__file__ is None
    or Path(decoder_commands_module.__file__).resolve()
    != DECODER_COMMAND_MODULE_PATH
):
    raise RuntimeError("imported decoder command module is not the repository source")
if DECODER_COMMAND_SCHEMA_VERSION != "1.0":
    raise RuntimeError("decoder command schema version is not pinned to 1.0")
DEFAULT_CACHE_ROOT = Path.home() / ".cache/codex/scorecheck-ffmpeg-runtime-v1"
DEFAULT_RECEIPT_PATH = FIXTURE_ROOT / "decoder_runtime_v1.development-receipt.json"

SOURCE_VERSION = "8.1.2"
SOURCE_DATE_EPOCH = "1781675220"
SOURCE_URL = f"https://ffmpeg.org/releases/ffmpeg-{SOURCE_VERSION}.tar.xz"
SIGNATURE_URL = f"{SOURCE_URL}.asc"
SIGNING_KEY_URL = "https://ffmpeg.org/ffmpeg-devel.asc"
SOURCE_SHA256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
SIGNATURE_SHA256 = "0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8"
SIGNING_KEY_SHA256 = "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5"
SIGNING_KEY_FINGERPRINT = "FCF986EA15E6E293A5644F10B4322F04D67658D8"
SIGNATURE_EPOCH = 1_781_664_539
SIGNATURE_UTC_DATE = "2026-06-17"

H264_GOLDEN_FIXTURE_SHA256 = (
    "3dcf5b3701577c1e49b450e4325dceaae20b2c16fc524cb2f0b925136e9860c1"
)
H264_GOLDEN_CONTRACT_SHA256 = (
    "1183c51a30a2398d06134669232c3283b253548367a38c184e51bf5e637eed11"
)
HEVC10_GOLDEN_FIXTURE_SHA256 = (
    "380fc82506dc596f572e5535c99713ee676f7c37e5682506e994d93df1cd3aa0"
)
HEVC10_GOLDEN_CONTRACT_SHA256 = (
    "d7faaa382018313c5c49f3e02d53915b389f53dc6a026fecdaef02929ea31fa7"
)

DEPLOYMENT_TARGET = "26.0"
SDK_VERSION = "26.5"
SDK_ROOT = Path(
    "/Applications/Xcode.app/Contents/Developer/Platforms/"
    "MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk"
)
TOOLCHAIN_ROOT = Path(
    "/Applications/Xcode.app/Contents/Developer/Toolchains/"
    "XcodeDefault.xctoolchain/usr/bin"
)
SDK_SETTINGS_SHA256 = "f8d005f09381389167f9e0aeaa169bc9e7dff162ef22ca2fd8e98df7ff1acafe"
SDK_LIBSYSTEM_TBD_SHA256 = (
    "20cfce043f11a083e2eb6111efe3579919a8082fa4cc912a7bd839af2010ec57"
)
CLANG_SHA256 = "7def90dd8829726686213a747fc5bff1583df933dae5edc55d755479e0bfe00a"
GPG_PATH = Path("/opt/homebrew/Cellar/gnupg/2.4.9/bin/gpg")
GPG_SHA256 = "415dbe9fbbba5e9dd275105b9fe6fcecc208a4e41eb41a8623c3e07684b6671e"

EXPECTED_XCODE_VERSION = "Xcode 26.6\nBuild version 17F113\n"
EXPECTED_CLANG_PREFIX = (
    "Apple clang version 21.0.0 (clang-2100.1.1.101)\n"
    "Target: arm64-apple-darwin25.5.0\n"
)
EXPECTED_MAKE_PREFIX = "GNU Make 3.81\n"
EXPECTED_GPG_PREFIX = "gpg (GnuPG) 2.4.9\nlibgcrypt 1.12.1\n"
EXPECTED_HOST = {
    "architecture": "arm64",
    "darwin_release": "25.5.0",
    "macos_build": "25F80",
    "macos_version": "26.5.1",
}

AUTHORITY_FIELDS = (
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

EXPECTED_CONFIGURE_COMPONENTS: dict[str, tuple[str, ...]] = {
    "External libraries": (),
    "External libraries providing hardware acceleration": (),
    "Libraries": ("avcodec", "avfilter", "avformat", "avutil", "swscale"),
    "Programs": ("ffmpeg", "ffprobe"),
    "Enabled decoders": ("h264", "hevc"),
    "Enabled encoders": ("rawvideo",),
    "Enabled hwaccels": (),
    "Enabled parsers": (),
    "Enabled demuxers": ("mov",),
    "Enabled muxers": ("framehash", "rawvideo"),
    "Enabled protocols": ("fd", "pipe"),
    "Enabled filters": (
        "aformat",
        "anull",
        "atrim",
        "crop",
        "format",
        "hflip",
        "null",
        "rotate",
        "scale",
        "split",
        "transpose",
        "trim",
        "vflip",
    ),
    "Enabled bsfs": (),
    "Enabled indevs": (),
    "Enabled outdevs": (),
}

EXPECTED_RUNTIME_CAPABILITIES: dict[str, Any] = {
    "bitstream_filters": [],
    "decoders": ["h264", "hevc"],
    "demuxers": ["3g2", "3gp", "m4a", "mj2", "mov", "mp4"],
    "devices": [],
    "encoders": ["rawvideo"],
    "filters": [
        "abuffer",
        "abuffersink",
        "aformat",
        "anull",
        "atrim",
        "buffer",
        "buffersink",
        "crop",
        "format",
        "hflip",
        "null",
        "rotate",
        "scale",
        "split",
        "transpose",
        "trim",
        "vflip",
    ],
    "hardware_accelerators": [],
    "muxers": ["framehash", "rawvideo"],
    "protocols": {
        "input": ["fd", "pipe"],
        "output": ["fd", "pipe"],
    },
}

EXPECTED_DIRECT_DYLIBS = ("/usr/lib/libSystem.B.dylib",)
EXPECTED_DYLD_PATH = "/usr/lib/dyld"
FIXED_AUDIT_ENV = {
    "HOME": "/nonexistent",
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "TMPDIR": "/nonexistent",
    "TZ": "UTC",
}
FIXED_CANDIDATE_ENV = {
    "AV_LOG_FORCE_NOCOLOR": "1",
    "HOME": "/nonexistent",
    "LANG": "C",
    "LC_ALL": "C",
    "NO_COLOR": "1",
    "PATH": "/nonexistent",
    "TMPDIR": "/nonexistent",
    "TZ": "UTC",
}
EXPECTED_MACHO_LOAD_COMMANDS = (
    "LC_BUILD_VERSION",
    "LC_CODE_SIGNATURE",
    "LC_DATA_IN_CODE",
    "LC_DYLD_CHAINED_FIXUPS",
    "LC_DYLD_EXPORTS_TRIE",
    "LC_DYSYMTAB",
    "LC_FUNCTION_STARTS",
    "LC_LOAD_DYLIB",
    "LC_LOAD_DYLINKER",
    "LC_MAIN",
    "LC_SEGMENT_64",
    "LC_SEGMENT_64",
    "LC_SEGMENT_64",
    "LC_SEGMENT_64",
    "LC_SEGMENT_64",
    "LC_SOURCE_VERSION",
    "LC_SYMTAB",
    "LC_UUID",
)
RECEIPT_ASSUMPTIONS = (
    "arm64 macOS deployment target 26.0 for this measured host generation only",
    "development evidence grants no production, support, security, patent, license, training, evaluation, deployment, or runtime-execution authority",
    "Apple system runtime remains ambient and is measured rather than bundled",
)
FORBIDDEN_LOAD_COMMANDS = {
    "LC_DYLD_ENVIRONMENT",
    "LC_LAZY_LOAD_DYLIB",
    "LC_LOAD_UPWARD_DYLIB",
    "LC_LOAD_WEAK_DYLIB",
    "LC_REEXPORT_DYLIB",
    "LC_RPATH",
}
FORBIDDEN_IMPORT_RE = re.compile(
    r"^_(?:"
    r"dlopen|dlclose|dlsym|dlerror|"
    r"socket|socketpair|connect|bind|listen|accept|accept4|shutdown|"
    r"send|sendto|sendmsg|recv|recvfrom|recvmsg|"
    r"setsockopt|getsockopt|getaddrinfo|freeaddrinfo|getnameinfo|"
    r"inet_aton|inet_ntoa|inet_ntop|inet_pton|"
    r"fork|vfork|system|popen|wordexp|"
    r"exec.*|posix_spawn.*"
    r")$"
)

FRAMEHASH_ROW_RE = re.compile(
    r"^\s*(?P<stream>[0-9]+),\s*(?P<dts>-?[0-9]+),\s*"
    r"(?P<pts>-?[0-9]+),\s*(?P<duration>-?[0-9]+),\s*"
    r"(?P<size>[0-9]+),\s*(?P<sha256>[0-9a-f]{64})$"
)


class BuildFailure(RuntimeError):
    """Fail-closed development build or audit failure."""


def canonical_json_bytes(value: object, *, pretty: bool = False) -> bytes:
    """Return deterministic ASCII JSON bytes."""

    if pretty:
        text = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            indent=2,
            sort_keys=True,
        )
    else:
        text = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    return (text + "\n").encode("ascii")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_version_output_sha256(raw: bytes) -> str:
    """Mirror the runtime-manifest version-output normalization."""

    text = raw.decode("utf-8", errors="strict")
    if not text or "\x00" in text:
        raise BuildFailure("version output is empty or contains NUL")
    lines = [
        line.rstrip(" \t")
        for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    ]
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise BuildFailure("normalized version output is empty")
    return sha256_bytes(("\n".join(lines) + "\n").encode("utf-8"))


def configure_arguments(
    source_root: Path,
    sdk_root: Path = SDK_ROOT,
    toolchain_root: Path = TOOLCHAIN_ROOT,
) -> tuple[str, ...]:
    """Return the exact configure policy for this host generation."""

    source = str(source_root)
    sdk = str(sdk_root)
    tools = str(toolchain_root)
    cflags = " ".join(
        (
            f"-ffile-prefix-map={source}=/usr/src/ffmpeg-{SOURCE_VERSION}",
            f"-fdebug-prefix-map={source}=/usr/src/ffmpeg-{SOURCE_VERSION}",
            "-ffile-prefix-map=.=/.build/ffmpeg",
            "-fdebug-prefix-map=.=/.build/ffmpeg",
            "-fstack-protector-strong",
            "-D_FORTIFY_SOURCE=2",
        )
    )
    return (
        "--prefix=/scorecheck/decoder-runtime-v1",
        "--arch=arm64",
        "--cpu=generic",
        "--target-os=darwin",
        f"--sysroot={sdk}",
        f"--cc={tools}/clang",
        f"--cxx={tools}/clang++",
        # FFmpeg probes these frameworks unconditionally through ObjC.  This
        # candidate has no ObjC component; a rejecting compiler prevents an
        # otherwise implicit CoreFoundation/CoreVideo/CoreMedia runtime load.
        "--objcc=/usr/bin/false",
        f"--ar={tools}/ar",
        f"--ranlib={tools}/ranlib",
        f"--strip={tools}/strip",
        f"--nm={tools}/nm",
        "--pkg-config=/usr/bin/false",
        "--disable-shared",
        "--enable-static",
        "--enable-pic",
        "--disable-autodetect",
        "--disable-everything",
        "--disable-doc",
        "--disable-debug",
        "--disable-avdevice",
        "--disable-swresample",
        "--disable-ffplay",
        "--disable-network",
        "--disable-iamf",
        "--disable-error-resilience",
        "--disable-swscale-alpha",
        "--disable-runtime-cpudetect",
        "--disable-arm-crc",
        "--disable-dotprod",
        "--disable-i8mm",
        "--disable-sve",
        "--disable-sve2",
        "--disable-sme",
        "--disable-sme-i16i64",
        "--disable-sme2",
        "--disable-avfoundation",
        "--disable-audiotoolbox",
        "--disable-videotoolbox",
        "--disable-coreimage",
        "--disable-metal",
        "--disable-securetransport",
        "--disable-iconv",
        "--disable-zlib",
        "--disable-bzlib",
        "--disable-lzma",
        "--disable-sdl2",
        "--disable-xlib",
        "--disable-vulkan",
        "--disable-gpl",
        "--disable-version3",
        "--disable-nonfree",
        "--enable-pthreads",
        "--enable-ffmpeg",
        "--enable-ffprobe",
        "--enable-demuxer=mov",
        "--enable-decoder=h264,hevc",
        "--enable-encoder=rawvideo",
        "--enable-muxer=rawvideo,framehash",
        "--enable-filter=scale,format,split",
        "--enable-protocol=fd,pipe",
        "--extra-version=scorecheck-v1",
        f"--extra-cflags={cflags}",
        "--extra-ldexeflags=-Wl,-reproducible",
    )


def redact_configure_arguments(
    arguments: Sequence[str],
    *,
    source_root: Path,
    sdk_root: Path = SDK_ROOT,
    toolchain_root: Path = TOOLCHAIN_ROOT,
) -> list[str]:
    """Remove host-local paths without changing argument order or meaning."""

    replacements = sorted(
        (
            (str(source_root), "$SOURCE"),
            (str(sdk_root), "$SDKROOT"),
            (str(toolchain_root), "$TOOLCHAIN"),
        ),
        key=lambda pair: len(pair[0]),
        reverse=True,
    )
    output: list[str] = []
    for argument in arguments:
        redacted = argument
        for original, replacement in replacements:
            redacted = redacted.replace(original, replacement)
        output.append(redacted)
    return output


def parse_configure_components(text: str) -> dict[str, tuple[str, ...]]:
    """Parse component sections from FFmpeg's configure summary."""

    labels = set(EXPECTED_CONFIGURE_COMPONENTS)
    result: dict[str, tuple[str, ...]] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        stripped = lines[index].rstrip()
        label = stripped[:-1] if stripped.endswith(":") else ""
        if label not in labels:
            index += 1
            continue
        index += 1
        values: list[str] = []
        while index < len(lines) and lines[index].strip():
            values.extend(lines[index].split())
            index += 1
        result[label] = tuple(sorted(values))
        index += 1
    return result


def parse_runtime_table(kind: str, text: str) -> list[str]:
    """Extract exact component names from one FFmpeg runtime table."""

    names: list[str] = []
    if kind in {"decoders", "encoders"}:
        heading = "Decoders:" if kind == "decoders" else "Encoders:"
        separator = "------"
        pattern = re.compile(r"^\s*[VAS.][A-Z.]{5}\s+(\S+)\s+")
    elif kind in {"demuxers", "muxers", "devices"}:
        heading = "Devices:" if kind == "devices" else "Formats:"
        separator = "---"
        if kind == "devices":
            pattern = re.compile(r"^\s*[D. ][E. ]\s+(\S+)\s+")
        else:
            pattern = re.compile(r"^\s*[D. ][E. ][d. ]\s+(\S+)\s+")
    elif kind == "filters":
        heading = "Filters:"
        separator = "------"
        pattern = re.compile(r"^\s*[T.][S.]\s+(\S+)\s+")
    else:
        raise ValueError(f"unsupported table kind {kind!r}")
    lines = text.splitlines()
    if not lines or lines[0] != heading:
        raise BuildFailure(f"{kind} table heading is not exact")
    separator_indexes = [
        index for index, line in enumerate(lines) if line.strip() == separator
    ]
    if len(separator_indexes) != 1:
        raise BuildFailure(f"{kind} table separator is not exact")
    for line in lines[separator_indexes[0] + 1 :]:
        if not line:
            raise BuildFailure(f"{kind} table contains an unexpected blank line")
        match = pattern.match(line)
        if match is None:
            raise BuildFailure(f"{kind} table contains an unparsed row {line!r}")
        captured = match.group(1)
        names.extend(captured.split(","))
    return sorted(names)


def parse_protocols(text: str) -> dict[str, list[str]]:
    result = {"input": [], "output": []}
    lines = text.splitlines()
    if not lines or lines[0] != "Supported file protocols:":
        raise BuildFailure("protocol table heading is not exact")
    section: str | None = None
    seen_sections: list[str] = []
    for line in lines[1:]:
        if line == "Input:":
            section = "input"
            seen_sections.append(section)
        elif line == "Output:":
            section = "output"
            seen_sections.append(section)
        elif section is not None and re.fullmatch(r"  [A-Za-z0-9_]+", line):
            result[section].append(line.strip())
        else:
            raise BuildFailure(f"protocol table contains an unparsed row {line!r}")
    if seen_sections != ["input", "output"]:
        raise BuildFailure("protocol table sections are not exact")
    for values in result.values():
        if len(values) != len(set(values)):
            raise BuildFailure("protocol table contains a duplicate name")
        values.sort()
    return result


def parse_simple_runtime_list(text: str, heading: str) -> list[str]:
    lines = text.splitlines()
    if not lines or lines[0] != heading:
        raise BuildFailure(f"runtime output lacks exact {heading!r} heading")
    body = lines[1:]
    if body == [""]:
        body = []
    values: list[str] = []
    for line in body:
        if re.fullmatch(r"  [A-Za-z0-9_]+", line) is None:
            raise BuildFailure(f"runtime list contains an unparsed row {line!r}")
        values.append(line.strip())
    if len(values) != len(set(values)):
        raise BuildFailure("runtime list contains a duplicate name")
    return sorted(values)


_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_UUID_RE = re.compile(r"[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}")


def _exact_object(
    value: object, keys: Sequence[str], label: str
) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an object")
    if any(type(key) is not str for key in value):
        raise ValueError(f"{label} keys must be strings")
    expected = set(keys)
    observed = set(value)
    if observed != expected:
        raise ValueError(
            f"{label} fields are not exact; "
            f"missing={sorted(expected - observed)!r}, "
            f"extra={sorted(observed - expected)!r}"
        )
    return value


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_uuid(value: object, label: str) -> str:
    if type(value) is not str or _UUID_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be an uppercase UUID")
    return value


def _public_recipe(source_root: Path) -> dict[str, Any]:
    actual_configure = configure_arguments(source_root)
    return {
        "build_command": ["make", "-j1", "V=1"],
        "configure_arguments": redact_configure_arguments(
            actual_configure, source_root=source_root
        ),
        "environment": {
            "HOME": "$BUILD_HOME",
            "LANG": "C",
            "LC_ALL": "C",
            "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "SDKROOT": "$SDKROOT",
            "SOURCE_DATE_EPOCH": SOURCE_DATE_EPOCH,
            "TMPDIR": "$BUILD_TMPDIR",
            "TZ": "UTC",
            "ZERO_AR_DATE": "1",
        },
        "source_sha256": SOURCE_SHA256,
    }


def validate_development_receipt(receipt: object) -> dict[str, Any]:
    """Validate the complete V1 evidence schema and false-authority boundary."""

    root = _exact_object(
        receipt,
        (
            "assumptions",
            "audit_implementation",
            "authority",
            "build",
            "capabilities",
            "checks",
            "goldens",
            "host_generation",
            "license_boundary",
            "purpose",
            "schema_version",
            "source",
            "system_runtime",
            "target",
        ),
        "development receipt",
    )
    if root["schema_version"] != "1.0":
        raise ValueError("development receipt schema_version must be '1.0'")
    if root["purpose"] != "DEVELOPMENT_EVIDENCE_ONLY":
        raise ValueError("development receipt purpose is not fail-closed")
    if root["assumptions"] != list(RECEIPT_ASSUMPTIONS):
        raise ValueError("development receipt assumptions are not exact")

    audit = _exact_object(
        root["audit_implementation"],
        (
            "builder_filename",
            "builder_source_sha256",
            "decoder_command_module_path",
            "decoder_command_module_schema_version",
            "decoder_command_module_source_sha256",
            "download_proxy_policy",
            "external_tool_environment",
            "gpg_agent_policy",
        ),
        "audit_implementation",
    )
    if audit["builder_filename"] != BUILDER_PATH.name:
        raise ValueError("audit builder filename changed")
    builder_digest = _require_sha256(
        audit["builder_source_sha256"], "audit builder source"
    )
    if builder_digest != BUILDER_SOURCE_SHA256:
        raise ValueError("receipt is not bound to this audit implementation")
    if sha256_path(BUILDER_PATH) != BUILDER_SOURCE_SHA256:
        raise ValueError("audit implementation changed after process start")
    if (
        audit["decoder_command_module_path"]
        != DECODER_COMMAND_MODULE_REPOSITORY_PATH
        or audit["decoder_command_module_schema_version"]
        != DECODER_COMMAND_SCHEMA_VERSION
    ):
        raise ValueError("decoder command module identity changed")
    command_module_digest = _require_sha256(
        audit["decoder_command_module_source_sha256"],
        "decoder command module source",
    )
    if command_module_digest != DECODER_COMMAND_MODULE_SOURCE_SHA256:
        raise ValueError("receipt is not bound to this decoder command module")
    if (
        DECODER_COMMAND_MODULE_PATH.is_symlink()
        or sha256_path(DECODER_COMMAND_MODULE_PATH)
        != DECODER_COMMAND_MODULE_SOURCE_SHA256
    ):
        raise ValueError("decoder command module changed after process start")
    if audit["download_proxy_policy"] != "ENVIRONMENT_PROXIES_DISABLED":
        raise ValueError("download proxy policy changed")
    if audit["external_tool_environment"] != FIXED_AUDIT_ENV:
        raise ValueError("external audit-tool environment changed")
    if audit["gpg_agent_policy"] != "NO_AUTOSTART":
        raise ValueError("GnuPG agent policy changed")

    authority = _exact_object(root["authority"], AUTHORITY_FIELDS, "authority")
    for field in AUTHORITY_FIELDS:
        if authority[field] is not False:
            raise ValueError(f"development receipt {field} must be false")

    build = _exact_object(
        root["build"],
        (
            "byte_identical_across_two_clean_builds",
            "candidate_execution",
            "clean_build_object_sha256s",
            "ffmpeg",
            "ffprobe",
            "recipe",
            "recipe_sha256",
            "source_tree_unchanged",
            "source_tree_sha256",
        ),
        "build",
    )
    if build["byte_identical_across_two_clean_builds"] is not True:
        raise ValueError("double-build equality must be true")
    candidate = _exact_object(
        build["candidate_execution"],
        (
            "close_fds",
            "controlled_cwd",
            "environment",
            "shell",
            "start_new_session",
            "stdin",
        ),
        "candidate_execution",
    )
    if candidate != {
        "close_fds": True,
        "controlled_cwd": "$CANDIDATE_DIRECTORY",
        "environment": FIXED_CANDIDATE_ENV,
        "shell": False,
        "start_new_session": True,
        "stdin": "DEVNULL",
    }:
        raise ValueError("candidate execution boundary changed")

    clean_builds = _exact_object(
        build["clean_build_object_sha256s"], ("a", "b"), "clean builds"
    )
    for label in ("a", "b"):
        clean = _exact_object(
            clean_builds[label], ("ffmpeg", "ffprobe"), f"clean build {label}"
        )
        _require_sha256(clean["ffmpeg"], f"clean build {label} ffmpeg")
        _require_sha256(clean["ffprobe"], f"clean build {label} ffprobe")
    if clean_builds["a"] != clean_builds["b"]:
        raise ValueError("clean build object digests differ")

    binary_objects: dict[str, dict[str, Any]] = {}
    for name in ("ffmpeg", "ffprobe"):
        binary = _exact_object(
            build[name],
            ("macho", "object_sha256", "size_bytes", "version_output_sha256"),
            f"build {name}",
        )
        binary_objects[name] = binary
        _require_sha256(binary["object_sha256"], f"{name} object")
        _require_sha256(binary["version_output_sha256"], f"{name} version output")
        if (
            type(binary["size_bytes"]) is not int
            or binary["size_bytes"] <= 0
            or binary["size_bytes"] > 64 * 1024 * 1024
        ):
            raise ValueError(f"{name} size is outside the development bound")
        macho = _exact_object(
            binary["macho"],
            (
                "architecture",
                "code_directory_sha256",
                "cpu_subtype",
                "cpu_type",
                "direct_dylibs",
                "dyld_path",
                "forbidden_imports",
                "import_count",
                "imports_sha256",
                "load_commands",
                "minos",
                "sdk",
                "signature",
                "uuid",
            ),
            f"{name} Mach-O",
        )
        if (
            macho["architecture"] != "arm64"
            or macho["cpu_type"] != "ARM64"
            or macho["cpu_subtype"] != "ALL"
            or macho["direct_dylibs"] != list(EXPECTED_DIRECT_DYLIBS)
            or macho["dyld_path"] != EXPECTED_DYLD_PATH
            or macho["forbidden_imports"] != []
            or macho["load_commands"] != list(EXPECTED_MACHO_LOAD_COMMANDS)
            or macho["minos"] != DEPLOYMENT_TARGET
            or macho["sdk"] != SDK_VERSION
            or macho["signature"] != "adhoc-linker-signed-valid"
        ):
            raise ValueError(f"{name} Mach-O policy fields changed")
        if (
            type(macho["import_count"]) is not int
            or not 1 <= macho["import_count"] <= 10_000
        ):
            raise ValueError(f"{name} import count is invalid")
        _require_sha256(macho["code_directory_sha256"], f"{name} code directory")
        _require_sha256(macho["imports_sha256"], f"{name} imports")
        _require_uuid(macho["uuid"], f"{name} Mach-O")

    for name in ("ffmpeg", "ffprobe"):
        if clean_builds["a"][name] != binary_objects[name]["object_sha256"]:
            raise ValueError(f"clean-build and primary {name} digests differ")

    expected_recipe = _public_recipe(Path("/receipt/source"))
    if build["recipe"] != expected_recipe:
        raise ValueError("public build recipe changed")
    recipe_digest = _require_sha256(build["recipe_sha256"], "build recipe")
    if recipe_digest != sha256_bytes(canonical_json_bytes(expected_recipe)):
        raise ValueError("build recipe digest is inconsistent")
    if build["source_tree_unchanged"] is not True:
        raise ValueError("source tree unchanged check must be true")
    _require_sha256(build["source_tree_sha256"], "source tree")

    if root["capabilities"] != EXPECTED_RUNTIME_CAPABILITIES:
        raise ValueError("receipt capability closure changed")
    checks = _exact_object(
        root["checks"],
        (
            "exact_capability_closure_passed",
            "h264_golden_passed",
            "hevc10_golden_passed",
            "loader_equivalent_ambient_free_execution_passed",
            "macho_audit_passed",
            "reproducible_bytes_passed",
            "source_signature_passed",
            "two_goldens_present",
        ),
        "checks",
    )
    if any(value is not True for value in checks.values()):
        raise ValueError("every development check must be true")

    goldens = _exact_object(root["goldens"], ("h264", "hevc10"), "goldens")
    expected_goldens = {
        "h264": (
            "h264",
            H264_GOLDEN_CONTRACT_SHA256,
            H264_GOLDEN_FIXTURE_SHA256,
        ),
        "hevc10": (
            "hevc",
            HEVC10_GOLDEN_CONTRACT_SHA256,
            HEVC10_GOLDEN_FIXTURE_SHA256,
        ),
    }
    for name, (codec, contract_digest, fixture_digest) in expected_goldens.items():
        golden = _exact_object(
            goldens[name],
            (
                "available",
                "codec",
                "expected_contract_sha256",
                "fixture_sha256",
                "loader_equivalent_probe_passed",
                "passed",
            ),
            f"{name} golden",
        )
        expected_golden = {
            "available": True,
            "codec": codec,
            "expected_contract_sha256": contract_digest,
            "fixture_sha256": fixture_digest,
            "loader_equivalent_probe_passed": True,
            "passed": True,
        }
        if golden != expected_golden:
            raise ValueError(f"{name} golden identity or result changed")

    expected_host = {
        "architecture": "arm64",
        "clang_sha256": CLANG_SHA256,
        "clang_version": "Apple clang 21.0.0 (clang-2100.1.1.101)",
        "darwin_release": EXPECTED_HOST["darwin_release"],
        "gpg_sha256": GPG_SHA256,
        "gpg_version": "2.4.9",
        "ld_version": "1267",
        "macos_build": EXPECTED_HOST["macos_build"],
        "macos_version": EXPECTED_HOST["macos_version"],
        "make_version": "GNU Make 3.81",
        "sdk_libsystem_tbd_sha256": SDK_LIBSYSTEM_TBD_SHA256,
        "sdk_settings_sha256": SDK_SETTINGS_SHA256,
        "sdk_version": SDK_VERSION,
        "xcode_build": "17F113",
        "xcode_version": "26.6",
    }
    if root["host_generation"] != expected_host:
        raise ValueError("host generation evidence changed")
    if root["license_boundary"] != {
        "configure_report": "LGPL version 2.1 or later",
        "external_libraries": [],
        "legal_review_complete": False,
        "patent_review_complete": False,
    }:
        raise ValueError("license boundary changed")

    source = _exact_object(
        root["source"],
        (
            "archive_sha256",
            "detached_signature_sha256",
            "release_key_sha256",
            "signature",
            "version",
        ),
        "source",
    )
    if (
        source["archive_sha256"] != SOURCE_SHA256
        or source["detached_signature_sha256"] != SIGNATURE_SHA256
        or source["release_key_sha256"] != SIGNING_KEY_SHA256
        or source["version"] != SOURCE_VERSION
    ):
        raise ValueError("source identity changed")
    source_signature = _exact_object(
        source["signature"],
        ("fingerprint", "signature_epoch", "signature_utc_date", "verified"),
        "source signature",
    )
    if source_signature != {
        "fingerprint": SIGNING_KEY_FINGERPRINT,
        "signature_epoch": SIGNATURE_EPOCH,
        "signature_utc_date": SIGNATURE_UTC_DATE,
        "verified": True,
    }:
        raise ValueError("source signature evidence changed")

    system_runtime = _exact_object(
        root["system_runtime"],
        ("measurement", "measurement_sha256"),
        "system runtime",
    )
    measurement = _exact_object(
        system_runtime["measurement"],
        (
            "architecture",
            "darwin_release",
            "dyld_arm64e_uuid",
            "libsystem_arm64e_uuid",
            "libsystem_reexports",
            "macos_build",
            "macos_version",
        ),
        "system runtime measurement",
    )
    if (
        measurement["architecture"] != "arm64"
        or measurement["darwin_release"] != EXPECTED_HOST["darwin_release"]
        or measurement["macos_build"] != EXPECTED_HOST["macos_build"]
        or measurement["macos_version"] != EXPECTED_HOST["macos_version"]
    ):
        raise ValueError("system runtime host identity changed")
    _require_uuid(measurement["dyld_arm64e_uuid"], "dyld arm64e")
    _require_uuid(measurement["libsystem_arm64e_uuid"], "libSystem arm64e")
    reexports = measurement["libsystem_reexports"]
    if type(reexports) is not list or not 1 <= len(reexports) <= 256:
        raise ValueError("libSystem re-export list is outside its bound")
    install_names: list[str] = []
    for index, item in enumerate(reexports):
        reexport = _exact_object(
            item, ("install_name", "uuid"), f"libSystem re-export {index}"
        )
        install_name = reexport["install_name"]
        if (
            type(install_name) is not str
            or not install_name.startswith("/usr/lib/system/")
            or not install_name.endswith(".dylib")
        ):
            raise ValueError("libSystem re-export install name is invalid")
        install_names.append(install_name)
        _require_uuid(reexport["uuid"], f"libSystem re-export {index}")
    if install_names != sorted(set(install_names)):
        raise ValueError("libSystem re-export install names are not sorted and unique")
    system_digest = _require_sha256(
        system_runtime["measurement_sha256"], "system runtime measurement"
    )
    if system_digest != sha256_bytes(canonical_json_bytes(measurement)):
        raise ValueError("system runtime measurement digest is inconsistent")

    if root["target"] != {
        "architecture": "arm64",
        "deployment_target": DEPLOYMENT_TARGET,
        "platform": "macos",
        "sdk": SDK_VERSION,
    }:
        raise ValueError("target identity changed")

    forbidden_fragments = (
        "/Users/",
        ".cache/codex",
        ".scorecheck-worktrees",
        "MultiCourtScore",
    )

    def visit(value: object) -> None:
        if type(value) is dict:
            for key, item in value.items():
                if type(key) is not str:
                    raise ValueError("receipt object keys must be strings")
                visit(key)
                visit(item)
        elif type(value) is list:
            for item in value:
                visit(item)
        elif type(value) is str:
            if any(fragment in value for fragment in forbidden_fragments):
                raise ValueError(f"receipt contains host-local path text: {value!r}")
            value.encode("ascii", errors="strict")
        elif type(value) not in (bool, int):
            raise ValueError(
                f"receipt contains unsupported JSON scalar {type(value).__name__}"
            )

    visit(root)
    return root


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _terminate_process_group(process: subprocess.Popen[bytes]) -> bool:
    """Boundedly TERM/KILL and reap a process plus every same-group descendant."""

    process_group_id = process.pid
    for selected_signal, grace_seconds in (
        (signal.SIGTERM, 1.0),
        (signal.SIGKILL, 1.0),
    ):
        if not _process_group_exists(process_group_id):
            break
        try:
            os.killpg(process_group_id, selected_signal)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + grace_seconds
        while _process_group_exists(process_group_id) and time.monotonic() < deadline:
            try:
                process.wait(timeout=0.02)
            except subprocess.TimeoutExpired:
                pass
            time.sleep(0.01)
    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        return False
    return not _process_group_exists(process_group_id)


def _reject_surviving_process_group(
    process: subprocess.Popen[bytes], rendered: Sequence[str]
) -> None:
    if not _process_group_exists(process.pid):
        return
    cleaned = _terminate_process_group(process)
    suffix = "" if cleaned else " and bounded cleanup failed"
    raise BuildFailure(
        f"command left a surviving process-group descendant{suffix}: "
        f"{shlex.join(rendered)}"
    )


def _run_capture(
    command: Sequence[str | Path],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] = FIXED_AUDIT_ENV,
    timeout: int = 60,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[bytes]:
    rendered = [str(item) for item in command]
    process = subprocess.Popen(
        rendered,
        cwd=cwd,
        env=dict(env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=pass_fds,
        close_fds=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException as exc:
        if not _terminate_process_group(process):
            raise BuildFailure(
                f"bounded process-group cleanup failed: {shlex.join(rendered)}"
            ) from exc
        raise
    _reject_surviving_process_group(process, rendered)
    result = subprocess.CompletedProcess(
        rendered,
        process.returncode,
        stdout,
        stderr,
    )
    if result.returncode != 0:
        raise BuildFailure(
            f"command failed ({result.returncode}): {shlex.join(rendered)}\n"
            f"stdout:\n{result.stdout[-8192:].decode('utf-8', 'replace')}\n"
            f"stderr:\n{result.stderr[-8192:].decode('utf-8', 'replace')}"
        )
    return result


def _run_logged(
    command: Sequence[str | Path],
    *,
    cwd: Path,
    env: Mapping[str, str],
    stdout_path: Path,
    stderr_path: Path,
    timeout: int,
) -> None:
    rendered = [str(item) for item in command]
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(
            rendered,
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
            start_new_session=True,
        )
        try:
            process.wait(timeout=timeout)
        except BaseException as exc:
            if not _terminate_process_group(process):
                raise BuildFailure(
                    f"bounded process-group cleanup failed: {shlex.join(rendered)}"
                ) from exc
            raise
        _reject_surviving_process_group(process, rendered)
    if process.returncode != 0:
        raise BuildFailure(
            f"command failed ({process.returncode}): {shlex.join(rendered)}; "
            f"logs: {stdout_path.name}, {stderr_path.name}"
        )


def _require_sha(path: Path, expected: str, label: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise BuildFailure(f"{label} is absent, non-regular, or a symlink")
    observed = sha256_path(path)
    if observed != expected:
        raise BuildFailure(f"{label} sha256 {observed} != pinned {expected}")


def _download_pinned(url: str, path: Path, expected_sha256: str) -> None:
    if path.exists():
        _require_sha(path, expected_sha256, path.name)
        return
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.unlink(missing_ok=True)
    request = urllib.request.Request(
        url, headers={"User-Agent": "ScoreCheck/decoder-v1"}
    )
    # Do not let ambient HTTP(S)_PROXY variables interpose on the pinned
    # supply-chain fetch.  The content hash remains the primary identity pin.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=60) as response:
        final_url = response.geturl()
        if not final_url.startswith("https://"):
            raise BuildFailure(f"download redirected outside HTTPS: {final_url}")
        with temporary.open("wb") as destination:
            total = 0
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > 64 * 1024 * 1024:
                    raise BuildFailure("source download exceeded 64 MiB")
                destination.write(chunk)
    _require_sha(temporary, expected_sha256, temporary.name)
    os.replace(temporary, path)


def _verify_source_signature(
    archive: Path, signature: Path, signing_key: Path, cache_root: Path
) -> dict[str, Any]:
    _require_sha(GPG_PATH, GPG_SHA256, "GnuPG executable")
    gnupg_home = cache_root / "gnupg-verify"
    if gnupg_home.exists():
        shutil.rmtree(gnupg_home)
    gnupg_home.mkdir(mode=0o700)
    _run_capture(
        [
            GPG_PATH,
            "--batch",
            "--no-autostart",
            "--no-options",
            "--homedir",
            gnupg_home,
            "--import",
            signing_key,
        ]
    )
    fingerprints = _run_capture(
        [
            GPG_PATH,
            "--batch",
            "--no-autostart",
            "--no-options",
            "--homedir",
            gnupg_home,
            "--with-colons",
            "--fingerprint",
        ]
    ).stdout.decode("utf-8", errors="strict")
    primary = [
        line.split(":")[9]
        for line in fingerprints.splitlines()
        if line.startswith("fpr:")
    ]
    if not primary or primary[0] != SIGNING_KEY_FINGERPRINT:
        raise BuildFailure(f"release key fingerprint set is unexpected: {primary!r}")
    verified = _run_capture(
        [
            GPG_PATH,
            "--batch",
            "--no-autostart",
            "--no-options",
            "--homedir",
            gnupg_home,
            "--status-fd",
            "1",
            "--verify",
            signature,
            archive,
        ]
    ).stdout.decode("utf-8", errors="strict")
    valid_line = f"[GNUPG:] VALIDSIG {SIGNING_KEY_FINGERPRINT} "
    if valid_line not in verified or "[GNUPG:] GOODSIG " not in verified:
        raise BuildFailure("detached source signature did not validate exactly")
    match = re.search(r"\[GNUPG:\] VALIDSIG \S+ (\d{4}-\d{2}-\d{2}) (\d+)", verified)
    if match is None:
        raise BuildFailure("VALIDSIG timestamp is absent")
    if (
        match.group(1) != SIGNATURE_UTC_DATE
        or int(match.group(2)) != SIGNATURE_EPOCH
    ):
        raise BuildFailure("VALIDSIG timestamp changed from the pinned release")
    return {
        "fingerprint": SIGNING_KEY_FINGERPRINT,
        "signature_epoch": SIGNATURE_EPOCH,
        "signature_utc_date": SIGNATURE_UTC_DATE,
        "verified": True,
    }


def _host_environment() -> dict[str, Any]:
    if platform.machine() != EXPECTED_HOST["architecture"]:
        raise BuildFailure(f"host architecture {platform.machine()!r} is not arm64")
    if platform.release() != EXPECTED_HOST["darwin_release"]:
        raise BuildFailure(f"Darwin release {platform.release()!r} is not pinned")
    product = (
        _run_capture(["/usr/bin/sw_vers", "-productVersion"]).stdout.decode().strip()
    )
    build = _run_capture(["/usr/bin/sw_vers", "-buildVersion"]).stdout.decode().strip()
    if (
        product != EXPECTED_HOST["macos_version"]
        or build != EXPECTED_HOST["macos_build"]
    ):
        raise BuildFailure(f"macOS generation {(product, build)!r} is not pinned")
    xcode = _run_capture(["/usr/bin/xcodebuild", "-version"]).stdout.decode()
    if xcode != EXPECTED_XCODE_VERSION:
        raise BuildFailure(f"Xcode version is not pinned: {xcode!r}")
    _require_sha(TOOLCHAIN_ROOT / "clang", CLANG_SHA256, "Apple clang")
    clang = _run_capture([TOOLCHAIN_ROOT / "clang", "--version"]).stdout.decode()
    if not clang.startswith(EXPECTED_CLANG_PREFIX):
        raise BuildFailure("Apple clang version/target is not pinned")
    linker_raw = _run_capture([TOOLCHAIN_ROOT / "ld", "-version_details"]).stdout
    linker = json.loads(linker_raw)
    if linker.get("version") != "1267":
        raise BuildFailure(f"Apple linker version is not pinned: {linker!r}")
    make = _run_capture(["/usr/bin/make", "--version"]).stdout.decode()
    if not make.startswith(EXPECTED_MAKE_PREFIX):
        raise BuildFailure("GNU make version is not pinned")
    _require_sha(SDK_ROOT / "SDKSettings.json", SDK_SETTINGS_SHA256, "SDK settings")
    _require_sha(
        SDK_ROOT / "usr/lib/libSystem.B.tbd",
        SDK_LIBSYSTEM_TBD_SHA256,
        "SDK libSystem stub",
    )
    _require_sha(GPG_PATH, GPG_SHA256, "GnuPG executable")
    gpg = _run_capture([GPG_PATH, "--version"]).stdout.decode()
    if not gpg.startswith(EXPECTED_GPG_PREFIX):
        raise BuildFailure("GnuPG version is not pinned")
    return {
        "architecture": "arm64",
        "clang_sha256": CLANG_SHA256,
        "clang_version": "Apple clang 21.0.0 (clang-2100.1.1.101)",
        "darwin_release": EXPECTED_HOST["darwin_release"],
        "gpg_sha256": GPG_SHA256,
        "gpg_version": "2.4.9",
        "ld_version": "1267",
        "macos_build": EXPECTED_HOST["macos_build"],
        "macos_version": EXPECTED_HOST["macos_version"],
        "make_version": "GNU Make 3.81",
        "sdk_libsystem_tbd_sha256": SDK_LIBSYSTEM_TBD_SHA256,
        "sdk_settings_sha256": SDK_SETTINGS_SHA256,
        "sdk_version": SDK_VERSION,
        "xcode_build": "17F113",
        "xcode_version": "26.6",
    }


def _build_environment(cache_root: Path, label: str) -> dict[str, str]:
    home = cache_root / f"home-{label}"
    temporary = cache_root / f"tmp-{label}"
    home.mkdir()
    temporary.mkdir()
    return {
        "HOME": str(home),
        "LANG": "C",
        "LC_ALL": "C",
        "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SDKROOT": str(SDK_ROOT),
        "SOURCE_DATE_EPOCH": SOURCE_DATE_EPOCH,
        "TMPDIR": str(temporary),
        "TZ": "UTC",
        "ZERO_AR_DATE": "1",
    }


def _reject_symlink_components(path: Path, label: str) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise BuildFailure(f"{label} contains symlink component {current}")


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        if path.is_symlink():
            kind = b"L"
            payload = os.readlink(path).encode("utf-8")
        elif path.is_dir():
            kind = b"D"
            payload = b""
        elif path.is_file():
            kind = b"F"
            payload = bytes.fromhex(sha256_path(path))
        else:
            raise BuildFailure(f"source tree has unsupported object {relative!r}")
        digest.update(kind + len(relative).to_bytes(4, "big") + relative)
        digest.update(len(payload).to_bytes(8, "big") + payload)
    return digest.hexdigest()


def _extract_source(archive: Path, source_root: Path, cache_root: Path) -> str:
    if source_root.exists():
        shutil.rmtree(source_root)
    source_root.mkdir()
    _run_capture(
        [
            "/usr/bin/tar",
            "-xJf",
            archive,
            "-C",
            source_root,
            "--strip-components=1",
        ],
        timeout=120,
    )
    if (source_root / "VERSION").read_text(encoding="ascii").strip() != SOURCE_VERSION:
        raise BuildFailure("extracted FFmpeg VERSION is not pinned")
    return _tree_sha256(source_root)


def _assert_configure_summary(stdout: str) -> None:
    observed = parse_configure_components(stdout)
    if observed != EXPECTED_CONFIGURE_COMPONENTS:
        raise BuildFailure(
            "configure component closure changed:\n"
            + json.dumps(observed, indent=2, sort_keys=True)
        )
    if "License: LGPL version 2.1 or later" not in stdout:
        raise BuildFailure("configure did not report LGPL 2.1-or-later")
    required_lines = (
        "runtime cpu detection     no",
        "static                    yes",
        "shared                    no",
        "network support           no",
        "threading support         pthreads",
        "DOTPROD enabled           no",
        "I8MM enabled              no",
        "SVE enabled               no",
        "SVE2 enabled              no",
        "SME enabled               no",
        "SME-I16I64 enabled        no",
        "SME2 enabled              no",
    )
    missing = [line for line in required_lines if line not in stdout]
    if missing:
        raise BuildFailure(f"configure policy lines are absent: {missing!r}")


def _clean_build_directory(cache_root: Path, label: str) -> Path:
    for name in (f"build-{label}", f"home-{label}", f"tmp-{label}"):
        target = cache_root / name
        if target.exists():
            if target.is_symlink():
                raise BuildFailure(f"refusing cache symlink {target}")
            shutil.rmtree(target)
    build = cache_root / f"build-{label}"
    build.mkdir()
    return build


def _build_once(cache_root: Path, source_root: Path, label: str) -> dict[str, Path]:
    build = _clean_build_directory(cache_root, label)
    logs = cache_root / "logs"
    logs.mkdir(exist_ok=True)
    if logs.is_symlink() or not logs.is_dir():
        raise BuildFailure("build log directory must be a real directory")
    env = _build_environment(cache_root, label)
    arguments = configure_arguments(source_root)
    _run_logged(
        [source_root / "configure", *arguments],
        cwd=build,
        env=env,
        stdout_path=logs / f"configure-{label}.stdout.log",
        stderr_path=logs / f"configure-{label}.stderr.log",
        timeout=300,
    )
    _assert_configure_summary(
        (logs / f"configure-{label}.stdout.log").read_text(encoding="utf-8")
    )
    _run_logged(
        ["/usr/bin/make", "-j1", "V=1"],
        cwd=build,
        env=env,
        stdout_path=logs / f"make-{label}.stdout.log",
        stderr_path=logs / f"make-{label}.stderr.log",
        timeout=3600,
    )
    result: dict[str, Path] = {}
    for name in ("ffmpeg", "ffprobe"):
        binary = build / name
        if (
            not binary.is_file()
            or binary.is_symlink()
            or not os.access(binary, os.X_OK)
        ):
            raise BuildFailure(f"build {label} did not produce executable {name}")
        result[name] = binary
    return result


def _parse_buildconf(raw: bytes) -> tuple[str, ...]:
    lines = raw.decode("utf-8", errors="strict").splitlines()
    try:
        start = lines.index("  configuration:") + 1
    except ValueError as exc:
        raise BuildFailure("-buildconf output has no configuration header") from exc
    output: list[str] = []
    for line in lines[start:]:
        if not line.strip():
            break
        values = shlex.split(line.strip())
        if len(values) != 1:
            raise BuildFailure(f"ambiguous -buildconf line: {line!r}")
        output.append(values[0])
    return tuple(output)


def _command_text(command: Sequence[str | Path], *, timeout: int = 60) -> str:
    return _run_capture(command, timeout=timeout).stdout.decode(
        "utf-8", errors="strict"
    )


def _candidate_capture(
    executable: Path,
    arguments: Sequence[str],
    *,
    timeout: int = 60,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[bytes]:
    """Run a candidate with the loader-equivalent ambient-free boundary."""

    result = _run_capture(
        [executable, *arguments],
        cwd=executable.parent,
        env=FIXED_CANDIDATE_ENV,
        timeout=timeout,
        pass_fds=pass_fds,
    )
    if result.stderr != b"":
        raise BuildFailure(
            f"{executable.name} emitted unexpected stderr: "
            f"{result.stderr[-8192:].decode('utf-8', 'replace')}"
        )
    return result


def _macho_evidence(binary: Path) -> dict[str, Any]:
    file_output = _command_text(["/usr/bin/file", binary]).strip()
    if not file_output.endswith(": Mach-O 64-bit executable arm64"):
        raise BuildFailure(f"{binary.name} is not a thin arm64 Mach-O: {file_output!r}")
    if _command_text(["/usr/bin/lipo", "-archs", binary]).strip() != "arm64":
        raise BuildFailure(f"{binary.name} architecture set is not exactly arm64")

    header = _command_text(["/usr/bin/otool", "-hv", binary])
    if re.search(r"MH_MAGIC_64\s+ARM64\s+ALL\s+", header) is None:
        raise BuildFailure(f"{binary.name} CPU type/subtype is not ARM64/ALL")

    libraries = _command_text(["/usr/bin/otool", "-L", binary]).splitlines()[1:]
    direct = tuple(line.strip().split(" (", 1)[0] for line in libraries if line.strip())
    if direct != EXPECTED_DIRECT_DYLIBS:
        raise BuildFailure(f"{binary.name} direct dylibs changed: {direct!r}")

    load_commands_raw = _command_text(["/usr/bin/otool", "-l", binary])
    load_commands = sorted(
        re.findall(r"^\s*cmd (LC_[A-Z0-9_]+)$", load_commands_raw, flags=re.MULTILINE)
    )
    if tuple(load_commands) != EXPECTED_MACHO_LOAD_COMMANDS:
        raise BuildFailure(
            f"{binary.name} Mach-O load-command closure changed: {load_commands!r}"
        )
    forbidden_loads = sorted(set(load_commands) & FORBIDDEN_LOAD_COMMANDS)
    if forbidden_loads:
        raise BuildFailure(
            f"{binary.name} has forbidden load commands {forbidden_loads!r}"
        )
    dyld_paths = re.findall(
        r"cmd LC_LOAD_DYLINKER.*?\n\s*name (\S+) ",
        load_commands_raw,
        flags=re.DOTALL,
    )
    if dyld_paths != [EXPECTED_DYLD_PATH]:
        raise BuildFailure(f"{binary.name} dyld path changed: {dyld_paths!r}")

    build = _command_text(["/usr/bin/vtool", "-show-build", binary])
    for expected in (
        "platform MACOS",
        "minos 26.0",
        "sdk 26.5",
        "tool LD",
        "version 1267.0",
    ):
        if expected not in build:
            raise BuildFailure(f"{binary.name} build command lacks {expected!r}")

    uuid_output = _command_text(["/usr/bin/dyld_info", "-uuid", binary])
    uuids = re.findall(r"\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b", uuid_output)
    if len(uuids) != 1:
        raise BuildFailure(f"{binary.name} has an unexpected UUID set {uuids!r}")

    imports_output = _command_text(["/usr/bin/dyld_info", "-imports", binary])
    imports = sorted(
        match.group(1)
        for match in re.finditer(
            r"^\s+\S+\s+(\S+)\s+\(from libSystem\)$", imports_output, re.MULTILINE
        )
    )
    if not imports:
        raise BuildFailure(f"{binary.name} import table was not parsed")
    foreign_import_lines = [
        line
        for line in imports_output.splitlines()
        if " (from " in line and " (from libSystem)" not in line
    ]
    if foreign_import_lines:
        raise BuildFailure(f"{binary.name} has non-libSystem imports")
    forbidden_imports = [
        name for name in imports if FORBIDDEN_IMPORT_RE.fullmatch(name)
    ]
    if forbidden_imports:
        raise BuildFailure(
            f"{binary.name} imports forbidden APIs {forbidden_imports!r}"
        )

    _run_capture(["/usr/bin/codesign", "--verify", "--strict", "--verbose=4", binary])
    signature_result = _run_capture(
        ["/usr/bin/codesign", "-d", "--verbose=4", binary]
    )
    signature_text = (signature_result.stdout + signature_result.stderr).decode(
        "utf-8", errors="strict"
    )
    for expected in (
        "flags=0x20002(adhoc,linker-signed)",
        "Signature=adhoc",
        "TeamIdentifier=not set",
    ):
        if expected not in signature_text:
            raise BuildFailure(f"{binary.name} signature lacks {expected!r}")
    cdhash_match = re.search(
        r"CandidateCDHashFull sha256=([0-9a-f]{64})", signature_text
    )
    if cdhash_match is None:
        raise BuildFailure(f"{binary.name} full code-directory hash is absent")

    return {
        "architecture": "arm64",
        "code_directory_sha256": cdhash_match.group(1),
        "cpu_subtype": "ALL",
        "cpu_type": "ARM64",
        "direct_dylibs": list(direct),
        "dyld_path": EXPECTED_DYLD_PATH,
        "forbidden_imports": [],
        "import_count": len(imports),
        "imports_sha256": sha256_bytes(canonical_json_bytes(imports)),
        "load_commands": load_commands,
        "minos": DEPLOYMENT_TARGET,
        "sdk": SDK_VERSION,
        "signature": "adhoc-linker-signed-valid",
        "uuid": uuids[0],
    }


def _runtime_capabilities(ffmpeg: Path) -> dict[str, Any]:
    option_outputs = {
        name: _candidate_capture(ffmpeg, ["-hide_banner", f"-{name}"]).stdout.decode(
            "utf-8", errors="strict"
        )
        for name in ("decoders", "encoders", "demuxers", "muxers", "filters", "devices")
    }
    protocols = _candidate_capture(
        ffmpeg, ["-hide_banner", "-protocols"]
    ).stdout.decode("utf-8", errors="strict")
    bsfs = _candidate_capture(ffmpeg, ["-hide_banner", "-bsfs"]).stdout.decode(
        "utf-8", errors="strict"
    )
    hwaccels = _candidate_capture(ffmpeg, ["-hide_banner", "-hwaccels"]).stdout.decode(
        "utf-8", errors="strict"
    )
    observed = {
        "bitstream_filters": parse_simple_runtime_list(bsfs, "Bitstream filters:"),
        "decoders": parse_runtime_table("decoders", option_outputs["decoders"]),
        "demuxers": parse_runtime_table("demuxers", option_outputs["demuxers"]),
        "devices": parse_runtime_table("devices", option_outputs["devices"]),
        "encoders": parse_runtime_table("encoders", option_outputs["encoders"]),
        "filters": parse_runtime_table("filters", option_outputs["filters"]),
        "hardware_accelerators": parse_simple_runtime_list(
            hwaccels, "Hardware acceleration methods:"
        ),
        "muxers": parse_runtime_table("muxers", option_outputs["muxers"]),
        "protocols": parse_protocols(protocols),
    }
    if observed != EXPECTED_RUNTIME_CAPABILITIES:
        raise BuildFailure(
            "runtime capability closure changed:\n"
            + json.dumps(observed, indent=2, sort_keys=True)
        )
    return observed


def _parse_framehash(
    payload: bytes, *, expected_row_count: int
) -> tuple[tuple[int, int], tuple[int, int], list[dict[str, Any]]]:
    if not payload or len(payload) > 64 * 1024:
        raise BuildFailure("framehash output is outside its byte bound")
    text = payload.decode("ascii", errors="strict")
    if "\r" in text or "\x00" in text or not text.endswith("\n"):
        raise BuildFailure("framehash output is not canonical LF-delimited ASCII")
    lines = text[:-1].split("\n")
    if len(lines) != 10 + expected_row_count:
        raise BuildFailure("framehash line count is not exact")
    if tuple(lines[:3]) != (
        "#format: frame checksums",
        "#version: 2",
        "#hash: SHA256",
    ):
        raise BuildFailure("framehash fixed headers are not exact")
    if re.fullmatch(r"#software: Lavf[A-Za-z0-9_.+-]{1,64}", lines[3]) is None:
        raise BuildFailure("framehash software header is invalid")
    time_base = re.fullmatch(r"#tb 0: ([0-9]+)/([0-9]+)", lines[4])
    dimensions = re.fullmatch(r"#dimensions 0: ([0-9]+)x([0-9]+)", lines[7])
    if time_base is None or dimensions is None:
        raise BuildFailure("framehash time-base or dimensions header is invalid")
    if lines[5] != "#media_type 0: video" or lines[6] != "#codec_id 0: rawvideo":
        raise BuildFailure("framehash media type or codec is invalid")
    if lines[8] != "#sar 0: 1/1" or lines[9] != (
        "#stream#, dts,        pts, duration,     size, hash"
    ):
        raise BuildFailure("framehash terminal headers are invalid")
    rows: list[dict[str, Any]] = []
    for line in lines[10:]:
        match = FRAMEHASH_ROW_RE.fullmatch(line)
        if match is None:
            raise BuildFailure(f"malformed framehash row {line!r}")
        if match.group("stream") != "0":
            raise BuildFailure("framehash contains a nonzero output stream")
        rows.append(
            {
                "dts": int(match.group("dts")),
                "duration": int(match.group("duration")),
                "pts": int(match.group("pts")),
                "sha256": match.group("sha256"),
                "size": int(match.group("size")),
                "stream": int(match.group("stream")),
            }
        )
    return (
        (int(time_base.group(1)), int(time_base.group(2))),
        (int(dimensions.group(1)), int(dimensions.group(2))),
        rows,
    )


def _run_loader_probe_fd(
    ffprobe: Path, media: Path, stream_index: int
) -> dict[str, Any]:
    with media.open("rb") as source:
        command = decoder_probe_argv_v1(
            ffprobe,
            input_fd=source.fileno(),
            selected_video_stream_index=stream_index,
        )
        result = _candidate_capture(
            ffprobe,
            command[1:],
            timeout=30,
            pass_fds=(source.fileno(),),
        )
    value = json.loads(result.stdout)
    if type(value) is not dict:
        raise BuildFailure("ffprobe golden result is not an object")
    return value


def _run_rich_probe_fd(ffprobe: Path, media: Path, stream_index: int) -> dict[str, Any]:
    with media.open("rb") as source:
        result = _candidate_capture(
            ffprobe,
            [
                "-v",
                "error",
                "-protocol_whitelist",
                "fd",
                "-fd",
                str(source.fileno()),
                "-select_streams",
                str(stream_index),
                "-show_streams",
                "-show_frames",
                "-show_entries",
                (
                    "stream=index,codec_name,codec_tag_string,time_base,width,height,"
                    "pix_fmt,color_space,color_range,start_pts:"
                    "stream_side_data=rotation:"
                    "frame=stream_index,pts,pict_type,width,height,pix_fmt,color_space,color_range"
                ),
                "-of",
                "json",
                "fd:",
            ],
            timeout=30,
            pass_fds=(source.fileno(),),
        )
    value = json.loads(result.stdout)
    if type(value) is not dict:
        raise BuildFailure("rich ffprobe golden result is not an object")
    return value


def _run_packets_fd(
    ffprobe: Path, media: Path, stream_index: int
) -> list[dict[str, Any]]:
    with media.open("rb") as source:
        result = _run_capture(
            [
                ffprobe,
                "-v",
                "error",
                "-protocol_whitelist",
                "fd",
                "-fd",
                str(source.fileno()),
                "-select_streams",
                str(stream_index),
                "-show_packets",
                "-show_entries",
                "packet=pts,dts,size",
                "-of",
                "json",
                "fd:",
            ],
            cwd=ffprobe.parent,
            env=FIXED_CANDIDATE_ENV,
            timeout=30,
            pass_fds=(source.fileno(),),
        )
    if result.stderr != b"":
        raise BuildFailure("ffprobe packet introspection emitted stderr")
    document = json.loads(result.stdout)
    packets = document.get("packets")
    if type(packets) is not list:
        raise BuildFailure("ffprobe packet result is absent")
    return packets


def _decode_fd(ffmpeg: Path, media: Path, *, stream_index: int) -> tuple[bytes, bytes]:
    hash_read, hash_write = os.pipe()
    with media.open("rb") as source:
        command = decoder_decode_argv_v1(
            ffmpeg,
            input_fd=source.fileno(),
            framehash_output_fd=hash_write,
            selected_video_stream_index=stream_index,
        )
        try:
            process = subprocess.Popen(
                command,
                pass_fds=(source.fileno(), hash_write),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=True,
                start_new_session=True,
                cwd=str(ffmpeg.parent),
                env=dict(FIXED_CANDIDATE_ENV),
            )
        except BaseException:
            os.close(hash_read)
            os.close(hash_write)
            raise
        os.close(hash_write)
        chunks: list[bytes] = []

        def drain() -> None:
            while True:
                chunk = os.read(hash_read, 1 << 16)
                if not chunk:
                    return
                chunks.append(chunk)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            try:
                rgb, stderr = process.communicate(timeout=30)
            except subprocess.TimeoutExpired as exc:
                process.kill()
                process.communicate()
                raise BuildFailure("decoder golden timed out") from exc
        finally:
            reader.join(timeout=5)
            os.close(hash_read)
        if reader.is_alive():
            raise BuildFailure("framehash pipe did not reach EOF")
        if process.returncode != 0:
            raise BuildFailure(
                f"decoder golden failed ({process.returncode}): "
                f"{stderr.decode('utf-8', 'replace')}"
            )
        if stderr != b"":
            raise BuildFailure(
                "decoder golden emitted unexpected stderr: "
                + stderr.decode("utf-8", "replace")
            )
    return rgb, b"".join(chunks)


def _golden_case(ffmpeg: Path, ffprobe: Path, expected_path: Path) -> dict[str, Any]:
    expected_raw = expected_path.read_bytes()
    identity_pins = {
        "deterministic_decoder_v1.expected.json": (
            H264_GOLDEN_CONTRACT_SHA256,
            H264_GOLDEN_FIXTURE_SHA256,
        ),
        "deterministic_decoder_hevc10_v1.expected.json": (
            HEVC10_GOLDEN_CONTRACT_SHA256,
            HEVC10_GOLDEN_FIXTURE_SHA256,
        ),
    }
    try:
        expected_contract_sha256, expected_fixture_sha256 = identity_pins[
            expected_path.name
        ]
    except KeyError as exc:
        raise BuildFailure(f"unrecognized decoder golden {expected_path.name!r}") from exc
    if sha256_bytes(expected_raw) != expected_contract_sha256:
        raise BuildFailure(f"{expected_path.name} identity is not pinned")
    expected = json.loads(expected_raw)
    if canonical_json_bytes(expected, pretty=True) != expected_raw:
        raise BuildFailure(f"{expected_path.name} is not canonical JSON")
    fixture = expected["fixture"]
    if fixture.get("sha256") != expected_fixture_sha256:
        raise BuildFailure(f"{expected_path.name} fixture identity is not pinned")
    media = expected_path.parent / fixture["filename"]
    _require_sha(media, fixture["sha256"], fixture["filename"])
    if media.stat().st_size != fixture["size_bytes"]:
        raise BuildFailure(f"{media.name} size is not pinned")

    selected = expected["selected_video"]
    index = selected["stream_index"]
    loader_probe = _run_loader_probe_fd(ffprobe, media, index)
    probe = _run_rich_probe_fd(ffprobe, media, index)
    loader_streams = loader_probe.get("streams")
    loader_frames = loader_probe.get("frames")
    if (
        type(loader_streams) is not list
        or len(loader_streams) != 1
        or type(loader_frames) is not list
    ):
        raise BuildFailure(f"{media.name} exact loader probe shape changed")
    streams = probe.get("streams")
    frames = probe.get("frames")
    if type(streams) is not list or len(streams) != 1 or type(frames) is not list:
        raise BuildFailure(f"{media.name} selected probe shape changed")
    stream = streams[0]
    source_pixel_format = selected.get("source_pixel_format", "yuv420p")
    expected_codec = selected.get("codec_name", "h264")
    first_pts = expected["presentation_frames"][0]["pts"]
    stream_core: dict[str, Any] = {
        "codec_name": stream.get("codec_name"),
        "color_range": stream.get("color_range"),
        "color_space": stream.get("color_space"),
        "height": stream.get("height"),
        "pix_fmt": stream.get("pix_fmt"),
        "start_pts": stream.get("start_pts"),
        "stream_index": stream.get("index"),
        "time_base": stream.get("time_base"),
        "width": stream.get("width"),
    }
    expected_stream_core = {
        "codec_name": expected_codec,
        "color_range": selected["color_range"],
        "color_space": selected["color_space"],
        "height": selected["height"],
        "pix_fmt": source_pixel_format,
        "start_pts": first_pts,
        "stream_index": index,
        "time_base": f"{selected['time_base_numerator']}/{selected['time_base_denominator']}",
        "width": selected["width"],
    }
    if stream_core != expected_stream_core:
        raise BuildFailure(f"{media.name} stream probe changed: {stream_core!r}")

    loader_stream = loader_streams[0]
    loader_stream_core = {
        "codec_type": loader_stream.get("codec_type"),
        "color_range": loader_stream.get("color_range"),
        "color_space": loader_stream.get("color_space"),
        "height": loader_stream.get("height"),
        "pix_fmt": loader_stream.get("pix_fmt"),
        "start_pts": loader_stream.get("start_pts"),
        "stream_index": loader_stream.get("index"),
        "time_base": loader_stream.get("time_base"),
        "width": loader_stream.get("width"),
    }
    expected_loader_stream_core = {
        "codec_type": "video",
        "color_range": selected["color_range"],
        "color_space": selected["color_space"],
        "height": selected["height"],
        "pix_fmt": source_pixel_format,
        "start_pts": first_pts,
        "stream_index": index,
        "time_base": f"{selected['time_base_numerator']}/{selected['time_base_denominator']}",
        "width": selected["width"],
    }
    if loader_stream_core != expected_loader_stream_core:
        raise BuildFailure(f"{media.name} exact loader stream probe changed")
    if (
        "codec_tag" in selected
        and stream.get("codec_tag_string") != selected["codec_tag"]
    ):
        raise BuildFailure(f"{media.name} codec tag changed")
    if "rotation_degrees" in selected:
        rotations = [item.get("rotation") for item in stream.get("side_data_list", [])]
        if rotations != [selected["rotation_degrees"]]:
            raise BuildFailure(f"{media.name} display rotation changed: {rotations!r}")

    expected_frames = expected["presentation_frames"]
    frame_core = [
        {
            "color_range": frame.get("color_range"),
            "color_space": frame.get("color_space"),
            "height": frame.get("height"),
            "pict_type": frame.get("pict_type"),
            "pix_fmt": frame.get("pix_fmt"),
            "pts": frame.get("pts"),
            "stream_index": frame.get("stream_index"),
            "width": frame.get("width"),
        }
        for frame in frames
    ]
    expected_frame_core = [
        {
            "color_range": selected["color_range"],
            "color_space": selected["color_space"],
            "height": selected["height"],
            "pict_type": frame["pict_type"],
            "pix_fmt": source_pixel_format,
            "pts": frame["pts"],
            "stream_index": index,
            "width": selected["width"],
        }
        for frame in expected_frames
    ]
    if frame_core != expected_frame_core:
        raise BuildFailure(f"{media.name} presentation-frame probe changed")
    loader_frame_core = [
        {
            "color_range": frame.get("color_range"),
            "color_space": frame.get("color_space"),
            "height": frame.get("height"),
            "pix_fmt": frame.get("pix_fmt"),
            "pts": frame.get("pts"),
            "stream_index": frame.get("stream_index"),
            "width": frame.get("width"),
        }
        for frame in loader_frames
    ]
    expected_loader_frame_core = [
        {
            "color_range": selected["color_range"],
            "color_space": selected["color_space"],
            "height": selected["height"],
            "pix_fmt": source_pixel_format,
            "pts": frame["pts"],
            "stream_index": index,
            "width": selected["width"],
        }
        for frame in expected_frames
    ]
    if loader_frame_core != expected_loader_frame_core:
        raise BuildFailure(f"{media.name} exact loader frame probe changed")

    packets = _run_packets_fd(ffprobe, media, index)
    packet_keys = tuple(expected["demux_packets"][0])
    observed_packets = [
        {
            key: int(packet[key]) if key == "size" else packet.get(key)
            for key in packet_keys
        }
        for packet in packets
    ]
    if observed_packets != expected["demux_packets"]:
        raise BuildFailure(f"{media.name} demux packet order changed")

    rgb, framehash = _decode_fd(ffmpeg, media, stream_index=index)
    time_base, dimensions, rows = _parse_framehash(
        framehash, expected_row_count=len(expected_frames)
    )
    expected_time_base = (
        selected["time_base_numerator"],
        selected["time_base_denominator"],
    )
    if time_base != expected_time_base or dimensions != (
        selected["width"],
        selected["height"],
    ):
        raise BuildFailure(f"{media.name} decoded geometry/time base changed")
    if [row["pts"] for row in rows] != [frame["pts"] for frame in expected_frames]:
        raise BuildFailure(f"{media.name} decoded PTS changed")
    if [row["duration"] for row in rows] != [
        frame["framehash_duration"] for frame in expected_frames
    ]:
        raise BuildFailure(f"{media.name} decoded durations changed")
    if any(row["stream"] != 0 or row["dts"] != row["pts"] for row in rows):
        raise BuildFailure(f"{media.name} output-local timing changed")
    frame_size = selected["frame_size_bytes"]
    if any(row["size"] != frame_size for row in rows):
        raise BuildFailure(f"{media.name} RGB24 frame size changed")
    expected_hashes = [frame["rgb24_sha256"] for frame in expected_frames]
    if [row["sha256"] for row in rows] != expected_hashes:
        raise BuildFailure(f"{media.name} decoded framehash changed")
    if len(rgb) != len(expected_frames) * frame_size:
        raise BuildFailure(f"{media.name} RGB24 byte count changed")
    independent = [
        sha256_bytes(rgb[offset : offset + frame_size])
        for offset in range(0, len(rgb), frame_size)
    ]
    if independent != expected_hashes:
        raise BuildFailure(f"{media.name} independent RGB hashes changed")
    return {
        "available": True,
        "codec": expected_codec,
        "expected_contract_sha256": sha256_bytes(expected_raw),
        "fixture_sha256": fixture["sha256"],
        "loader_equivalent_probe_passed": True,
        "passed": True,
    }


def _uuid_for_install_name(path: str, *, architecture: str) -> str:
    output = _command_text(["/usr/bin/dyld_info", "-uuid", path])
    blocks = re.findall(
        r"\[([^]]+)\]:\s*\n\s*-uuid:\s*\n\s*([0-9A-F-]{36})",
        output,
    )
    matches = [uuid for arch, uuid in blocks if arch == architecture]
    if len(matches) != 1:
        raise BuildFailure(f"{path} lacks one {architecture} UUID: {blocks!r}")
    return matches[0]


def _system_runtime_measurement(host: dict[str, Any]) -> dict[str, Any]:
    linked = _command_text(
        ["/usr/bin/dyld_info", "-linked_dylibs", "/usr/lib/libSystem.B.dylib"]
    )
    reexports = sorted(
        re.findall(r"^\s*re-export\s+(\S+)$", linked, flags=re.MULTILINE)
    )
    if not reexports:
        raise BuildFailure("libSystem re-export closure was not parsed")
    reexport_uuids = [
        {
            "install_name": name,
            "uuid": _uuid_for_install_name(name, architecture="arm64e"),
        }
        for name in reexports
    ]
    measurement = {
        "architecture": "arm64",
        "darwin_release": host["darwin_release"],
        "dyld_arm64e_uuid": _uuid_for_install_name(
            "/usr/lib/dyld", architecture="arm64e"
        ),
        "libsystem_arm64e_uuid": _uuid_for_install_name(
            "/usr/lib/libSystem.B.dylib", architecture="arm64e"
        ),
        "libsystem_reexports": reexport_uuids,
        "macos_build": host["macos_build"],
        "macos_version": host["macos_version"],
    }
    return {
        "measurement": measurement,
        "measurement_sha256": sha256_bytes(canonical_json_bytes(measurement)),
    }


def _make_receipt(
    *,
    source_root: Path,
    source_tree_sha256: str,
    signature: dict[str, Any],
    host: dict[str, Any],
    ffmpeg: Path,
    ffprobe: Path,
    ffmpeg_macho: dict[str, Any],
    ffprobe_macho: dict[str, Any],
    capabilities: dict[str, Any],
    clean_build_hashes: dict[str, dict[str, str]],
    goldens: dict[str, Any],
    system_runtime: dict[str, Any],
    versions: dict[str, str],
) -> dict[str, Any]:
    recipe = _public_recipe(source_root)
    authority = {field: False for field in AUTHORITY_FIELDS}
    receipt: dict[str, Any] = {
        "assumptions": list(RECEIPT_ASSUMPTIONS),
        "audit_implementation": {
            "builder_filename": BUILDER_PATH.name,
            "builder_source_sha256": BUILDER_SOURCE_SHA256,
            "decoder_command_module_path": DECODER_COMMAND_MODULE_REPOSITORY_PATH,
            "decoder_command_module_schema_version": DECODER_COMMAND_SCHEMA_VERSION,
            "decoder_command_module_source_sha256": (
                DECODER_COMMAND_MODULE_SOURCE_SHA256
            ),
            "download_proxy_policy": "ENVIRONMENT_PROXIES_DISABLED",
            "external_tool_environment": FIXED_AUDIT_ENV,
            "gpg_agent_policy": "NO_AUTOSTART",
        },
        "authority": authority,
        "build": {
            "byte_identical_across_two_clean_builds": True,
            "candidate_execution": {
                "close_fds": True,
                "controlled_cwd": "$CANDIDATE_DIRECTORY",
                "environment": FIXED_CANDIDATE_ENV,
                "shell": False,
                "start_new_session": True,
                "stdin": "DEVNULL",
            },
            "clean_build_object_sha256s": clean_build_hashes,
            "ffmpeg": {
                "macho": ffmpeg_macho,
                "object_sha256": sha256_path(ffmpeg),
                "size_bytes": ffmpeg.stat().st_size,
                "version_output_sha256": versions["ffmpeg"],
            },
            "ffprobe": {
                "macho": ffprobe_macho,
                "object_sha256": sha256_path(ffprobe),
                "size_bytes": ffprobe.stat().st_size,
                "version_output_sha256": versions["ffprobe"],
            },
            "recipe": recipe,
            "recipe_sha256": sha256_bytes(canonical_json_bytes(recipe)),
            "source_tree_unchanged": True,
            "source_tree_sha256": source_tree_sha256,
        },
        "capabilities": capabilities,
        "checks": {
            "exact_capability_closure_passed": True,
            "loader_equivalent_ambient_free_execution_passed": True,
            "h264_golden_passed": goldens["h264"]["passed"],
            "hevc10_golden_passed": goldens["hevc10"]["passed"],
            "macho_audit_passed": True,
            "reproducible_bytes_passed": True,
            "source_signature_passed": True,
            "two_goldens_present": (
                goldens["h264"]["available"] and goldens["hevc10"]["available"]
            ),
        },
        "goldens": goldens,
        "host_generation": host,
        "license_boundary": {
            "configure_report": "LGPL version 2.1 or later",
            "external_libraries": [],
            "legal_review_complete": False,
            "patent_review_complete": False,
        },
        "purpose": "DEVELOPMENT_EVIDENCE_ONLY",
        "schema_version": "1.0",
        "source": {
            "archive_sha256": SOURCE_SHA256,
            "detached_signature_sha256": SIGNATURE_SHA256,
            "release_key_sha256": SIGNING_KEY_SHA256,
            "signature": signature,
            "version": SOURCE_VERSION,
        },
        "system_runtime": system_runtime,
        "target": {
            "architecture": "arm64",
            "deployment_target": DEPLOYMENT_TARGET,
            "platform": "macos",
            "sdk": SDK_VERSION,
        },
    }
    return validate_development_receipt(receipt)


def _verify_versions_and_buildconf(
    binaries: dict[str, Path], source_root: Path
) -> dict[str, str]:
    expected_arguments = configure_arguments(source_root)
    hashes: dict[str, str] = {}
    for name in ("ffmpeg", "ffprobe"):
        binary = binaries[name]
        version = _candidate_capture(binary, ["-hide_banner", "-version"]).stdout
        expected_prefix = f"{name} version {SOURCE_VERSION}-scorecheck-v1 "
        if not version.decode("utf-8", errors="strict").startswith(expected_prefix):
            raise BuildFailure(f"{name} version line is not pinned")
        buildconf = _candidate_capture(binary, ["-hide_banner", "-buildconf"]).stdout
        if _parse_buildconf(buildconf) != expected_arguments:
            raise BuildFailure(f"{name} -buildconf differs from the exact policy")
        hashes[name] = normalized_version_output_sha256(version)
    return hashes


def build_and_audit(cache_root: Path, receipt_path: Path) -> dict[str, Any]:
    cache_root = Path(os.path.abspath(cache_root.expanduser()))
    expected_cache = Path(os.path.abspath(DEFAULT_CACHE_ROOT.expanduser()))
    if cache_root != expected_cache:
        raise BuildFailure(
            f"cache root must be the authorized development cache {expected_cache}"
        )
    cache_root.mkdir(parents=True, exist_ok=True)
    _reject_symlink_components(cache_root, "authorized cache root")
    if not cache_root.is_dir():
        raise BuildFailure("authorized cache root must be a real directory")
    downloads = cache_root / "downloads"
    downloads.mkdir(exist_ok=True)
    if downloads.is_symlink() or not downloads.is_dir():
        raise BuildFailure("download cache must be a real directory")
    archive = downloads / f"ffmpeg-{SOURCE_VERSION}.tar.xz"
    detached = downloads / f"ffmpeg-{SOURCE_VERSION}.tar.xz.asc"
    key = downloads / "ffmpeg-devel.asc"
    _download_pinned(SOURCE_URL, archive, SOURCE_SHA256)
    _download_pinned(SIGNATURE_URL, detached, SIGNATURE_SHA256)
    _download_pinned(SIGNING_KEY_URL, key, SIGNING_KEY_SHA256)
    signature = _verify_source_signature(archive, detached, key, cache_root)
    host = _host_environment()

    source_root = cache_root / "source"
    source_tree_sha256 = _extract_source(archive, source_root, cache_root)
    build_a = _build_once(cache_root, source_root, "a")
    build_b = _build_once(cache_root, source_root, "b")
    if _tree_sha256(source_root) != source_tree_sha256:
        raise BuildFailure("signed source tree changed during out-of-tree builds")
    for name in ("ffmpeg", "ffprobe"):
        if build_a[name].read_bytes() != build_b[name].read_bytes():
            raise BuildFailure(f"two clean {name} builds are not byte-identical")
    clean_build_hashes = {
        label: {
            name: sha256_path(binaries[name])
            for name in ("ffmpeg", "ffprobe")
        }
        for label, binaries in (("a", build_a), ("b", build_b))
    }

    versions = _verify_versions_and_buildconf(build_a, source_root)
    ffmpeg_macho = _macho_evidence(build_a["ffmpeg"])
    ffprobe_macho = _macho_evidence(build_a["ffprobe"])
    capabilities = _runtime_capabilities(build_a["ffmpeg"])

    goldens = {
        "h264": _golden_case(
            build_a["ffmpeg"],
            build_a["ffprobe"],
            FIXTURE_ROOT / "deterministic_decoder_v1.expected.json",
        ),
        "hevc10": _golden_case(
            build_a["ffmpeg"],
            build_a["ffprobe"],
            FIXTURE_ROOT / "deterministic_decoder_hevc10_v1.expected.json",
        ),
    }
    system_runtime = _system_runtime_measurement(host)
    receipt = _make_receipt(
        source_root=source_root,
        source_tree_sha256=source_tree_sha256,
        signature=signature,
        host=host,
        ffmpeg=build_a["ffmpeg"],
        ffprobe=build_a["ffprobe"],
        ffmpeg_macho=ffmpeg_macho,
        ffprobe_macho=ffprobe_macho,
        capabilities=capabilities,
        clean_build_hashes=clean_build_hashes,
        goldens=goldens,
        system_runtime=system_runtime,
        versions=versions,
    )
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt_path.with_suffix(receipt_path.suffix + ".tmp")
    temporary.write_bytes(canonical_json_bytes(receipt, pretty=True))
    os.replace(temporary, receipt_path)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    parser.add_argument("--receipt", type=Path, default=DEFAULT_RECEIPT_PATH)
    arguments = parser.parse_args()
    try:
        receipt = build_and_audit(arguments.cache_root, arguments.receipt.resolve())
    except (BuildFailure, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"decoder-runtime-v1 build failed closed: {exc}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "authority": receipt["authority"],
                "ffmpeg_sha256": receipt["build"]["ffmpeg"]["object_sha256"],
                "ffprobe_sha256": receipt["build"]["ffprobe"]["object_sha256"],
                "purpose": receipt["purpose"],
                "receipt_sha256": sha256_path(arguments.receipt.resolve()),
                "two_goldens_present": receipt["checks"]["two_goldens_present"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
